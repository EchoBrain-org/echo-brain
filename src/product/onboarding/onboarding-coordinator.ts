import {
  ONBOARDING_STEPS,
  OnboardingTransactionError,
  createOnboardingTransaction,
  finishOnboardingTransaction,
  markOnboardingEffect,
  onboardingDocumentSha256,
  onboardingReceiptForFinishedTransaction,
  parseOnboardingTransaction,
  presentOnboardingStatus,
  transitionOnboardingStep,
  type OnboardingEffects,
  type OnboardingIdentity,
  type OnboardingPublicState,
  type OnboardingPublicStatus,
  type OnboardingReceiptV1,
  type OnboardingStepName,
  type OnboardingTransactionV1,
} from './onboarding-transaction.js';

/**
 * Domain step engine for one resumable onboarding flow (RFC-0001, Slice 1).
 *
 * The coordinator owns ordering, prepared-intent persistence, resumption, and
 * presentation. It talks only to injected ports: a transaction store and one
 * executor per step. Executors perform the real work (they may run existing
 * CLI steps) and must be idempotent for one operation identity, because an
 * interrupted prepared step is deliberately re-executed with the same
 * identity after a crash.
 */

export interface OnboardingStepContext {
  operationId: string;
  attempt: number;
}

export type OnboardingStepRunResult =
  | { result: 'succeeded'; reasonCode: string; receiptSha256?: string }
  | {
      result:
        | 'waiting_for_user'
        | 'waiting_for_administrator'
        | 'retryable'
        | 'denied'
        | 'preserved';
      reasonCode: string;
    };

export interface OnboardingResumeValidationResult {
  result: 'waiting_for_administrator' | 'retryable' | 'preserved';
  reasonCode: string;
}

export interface OnboardingPreflightResult {
  status:
    | 'waiting_for_user'
    | 'waiting_for_administrator'
    | 'retryable'
    | 'denied'
    | 'preserved';
  reasonCode: string;
  step: OnboardingStepName;
}

export interface OnboardingStepDefinition {
  run(context: OnboardingStepContext): Promise<OnboardingStepRunResult>;
  /**
   * Every effect boundary this step may cross. They are recorded durably before
   * the executor runs: after a crash the transaction must say the effect may
   * already exist, never that it surely does not.
   */
  effects?: readonly (keyof OnboardingEffects)[];
}

export interface OnboardingTransactionStore {
  acquireMutationLock(): Promise<() => Promise<void>>;
  loadActive(): Promise<OnboardingTransactionV1 | null>;
  saveActive(transaction: OnboardingTransactionV1): Promise<void>;
  saveReceipt(receipt: OnboardingReceiptV1): Promise<void>;
}

export interface RunOnboardingFlowOptions {
  store: OnboardingTransactionStore;
  steps: Record<OnboardingStepName, OnboardingStepDefinition>;
  identity: OnboardingIdentity;
  configPath: string;
  stateDirectory: string;
  inputSha256: string;
  /** Injectable clock; the default is the only wall-clock read in this module. */
  now?: () => string;
  nextOperationId: (step: OnboardingStepName) => string;
  /** Zero-effect checks run under the machine lock only before first publish. */
  beforeCreate?: () => Promise<OnboardingPreflightResult | null>;
  /** Revalidates the accepted profile/install binding before every resume edge. */
  validateResume: (
    transaction: OnboardingTransactionV1,
  ) => Promise<OnboardingResumeValidationResult | null>;
  /** Releases product work only after the immutable ready receipt exists. */
  afterReadyCommit: (input: {
    transaction: OnboardingTransactionV1;
    receipt: OnboardingReceiptV1;
    operationId: string;
  }) => Promise<void>;
  /**
   * Holds the profile runtime mutation fence across final binding validation,
   * receipt durability, and service activation. Normal service/reconfigure
   * commands use the same fence, so they cannot change the accepted target in
   * the last gap before product work is released.
   */
  withReadyCommit: <T>(commit: () => Promise<T>) => Promise<T>;
}

function withPublicState(
  transaction: OnboardingTransactionV1,
  state: OnboardingPublicState,
  reasonCode: string,
  now: string,
): OnboardingTransactionV1 {
  return parseOnboardingTransaction({
    ...transaction,
    last_public_state: state,
    last_reason_code: reasonCode,
    updated_at: now,
  });
}

function matchesInvocation(
  active: OnboardingTransactionV1,
  options: RunOnboardingFlowOptions,
): boolean {
  return (
    active.flow_id === options.identity.flow_id &&
    active.profile_id === options.identity.profile_id &&
    active.input_sha256 === options.inputSha256 &&
    active.config_path === options.configPath &&
    active.state_dir === options.stateDirectory
  );
}

function noEffectStatus(
  options: RunOnboardingFlowOptions,
  result: OnboardingPreflightResult,
): OnboardingPublicStatus {
  return {
    status: result.status,
    reason_code: result.reasonCode,
    flow_id: options.identity.flow_id,
    step: result.step,
    effects: {
      local_mutation: false,
      central_enrollment: false,
      provider_connection: false,
      service_activation: false,
      product_work: false,
    },
  };
}

function pauseStatus(
  transaction: OnboardingTransactionV1,
  pause: OnboardingResumeValidationResult,
): OnboardingPublicStatus {
  const unfinished = ONBOARDING_STEPS.find(
    (step) => transaction.steps[step].state !== 'succeeded',
  );
  return {
    status: pause.result,
    reason_code: pause.reasonCode,
    flow_id: transaction.flow_id,
    step: unfinished ?? 'activate',
    effects: { ...transaction.effects },
  };
}

function hasEffects(transaction: OnboardingTransactionV1): boolean {
  return Object.values(transaction.effects).some((value) => value);
}

async function newTransaction(
  options: RunOnboardingFlowOptions,
  now: () => string,
): Promise<OnboardingTransactionV1 | OnboardingPublicStatus> {
  const preflight = await options.beforeCreate?.();
  if (preflight !== undefined && preflight !== null) {
    return noEffectStatus(options, preflight);
  }
  return createOnboardingTransaction({
    identity: options.identity,
    inputSha256: options.inputSha256,
    configPath: options.configPath,
    stateDirectory: options.stateDirectory,
    now: now(),
  });
}

function isPublicStatus(
  value: OnboardingTransactionV1 | OnboardingPublicStatus,
): value is OnboardingPublicStatus {
  return !('schema_version' in value);
}

async function validateOrPause(
  options: RunOnboardingFlowOptions,
  transaction: OnboardingTransactionV1,
): Promise<OnboardingPublicStatus | null> {
  const pause = await options.validateResume(transaction);
  return pause === null ? null : pauseStatus(transaction, pause);
}

async function presentReadyAfterCommit(
  options: RunOnboardingFlowOptions,
  transaction: OnboardingTransactionV1,
  receipt: OnboardingReceiptV1,
): Promise<OnboardingPublicStatus> {
  const pause = await validateOrPause(options, transaction);
  if (pause !== null) return pause;
  const operationId = transaction.steps.activate.operation_id;
  if (operationId === null) {
    throw new OnboardingTransactionError(
      'invalid_transaction',
      'ready onboarding has no activation operation identity',
    );
  }
  try {
    await options.afterReadyCommit({ transaction, receipt, operationId });
  } catch {
    return {
      status: 'retryable',
      reason_code: 'activation_interrupted',
      flow_id: transaction.flow_id,
      step: 'activate',
      effects: { ...transaction.effects },
    };
  }
  return presentOnboardingStatus(transaction, 'profile_ready');
}

async function loadOrCreate(
  options: RunOnboardingFlowOptions,
  now: () => string,
): Promise<OnboardingTransactionV1 | OnboardingPublicStatus> {
  const active = await options.store.loadActive();
  if (active === null) return await newTransaction(options, now);

  // Receipt repair is independent of the current invocation. An upgrade or
  // corrected input cannot strand the exact receipt of an already committed
  // terminal transaction.
  if (active.finished_at !== null) {
    await options.store.saveReceipt(
      onboardingReceiptForFinishedTransaction(active),
    );
  }
  if (matchesInvocation(active, options)) return active;
  if (!hasEffects(active)) return await newTransaction(options, now);
  throw new OnboardingTransactionError(
    'invalid_transaction',
    'the active onboarding transaction does not match this exact flow and target',
  );
}

export async function runOnboardingFlow(
  options: RunOnboardingFlowOptions,
): Promise<OnboardingPublicStatus> {
  const release = await options.store.acquireMutationLock();
  try {
    return await runOnboardingFlowLocked(options);
  } finally {
    await release();
  }
}

function preparedIntentSha256(
  transaction: OnboardingTransactionV1,
  step: OnboardingStepName,
  operationId: string,
  effects: readonly (keyof OnboardingEffects)[],
): string {
  return onboardingDocumentSha256({
    schema_version: 1,
    kind: 'echo-onboarding-prepared-intent',
    flow_id: transaction.flow_id,
    profile_id: transaction.profile_id,
    input_sha256: transaction.input_sha256,
    config_path: transaction.config_path,
    state_dir: transaction.state_dir,
    step,
    operation_id: operationId,
    effects: [...effects].sort(),
  });
}

function acceptedStepReceiptSha256(
  transaction: OnboardingTransactionV1,
  step: OnboardingStepName,
  outcome: Extract<OnboardingStepRunResult, { result: 'succeeded' }>,
): string {
  const record = transaction.steps[step];
  return onboardingDocumentSha256({
    schema_version: 1,
    kind: 'echo-onboarding-step-receipt',
    flow_id: transaction.flow_id,
    step,
    operation_id: record.operation_id,
    prepared_request_sha256: record.prepared_request_sha256,
    result: outcome.result,
    reason_code: outcome.reasonCode,
  });
}

async function runOnboardingFlowLocked(
  options: RunOnboardingFlowOptions,
): Promise<OnboardingPublicStatus> {
  const now = options.now ?? (() => new Date().toISOString());
  const loaded = await loadOrCreate(options, now);
  if (isPublicStatus(loaded)) return loaded;
  let transaction = loaded;
  if (transaction.finished_at !== null) {
    const receipt = onboardingReceiptForFinishedTransaction(transaction);
    if (transaction.terminal_result === 'ready') {
      return await options.withReadyCommit(
        async () =>
          await presentReadyAfterCommit(options, transaction, receipt),
      );
    }
    return presentOnboardingStatus(
      transaction,
      transaction.last_reason_code ?? 'flow_finished',
    );
  }

  for (const stepName of ONBOARDING_STEPS) {
    const step = transaction.steps[stepName];
    if (step.state === 'succeeded') continue;
    const resumePause = await validateOrPause(options, transaction);
    if (resumePause !== null) return resumePause;

    const definition = options.steps[stepName];
    if (definition === undefined) {
      throw new OnboardingTransactionError(
        'invalid_transaction',
        `onboarding step ${stepName} has no executor`,
      );
    }

    // Re-prove every correction-prone trust and target fact immediately
    // before the first may-have-effect boundary. A crash in the durable
    // zero-effect prefix must not let an expired invitation or changed target
    // cross local, provider, or Authority effects on resume.
    if (!hasEffects(transaction) && (definition.effects?.length ?? 0) > 0) {
      const preflight = await options.beforeCreate?.();
      if (preflight !== undefined && preflight !== null) {
        return noEffectStatus(options, preflight);
      }
    }

    // Persist the prepared intent (and the may-have-occurred effect
    // boundary) durably before the executor may touch the outside world.
    const operationId =
      step.operation_id ?? options.nextOperationId(stepName);
    const effects = definition.effects ?? [];
    transaction = transitionOnboardingStep(transaction, stepName, {
      to: 'prepared',
      operationId,
      preparedRequestSha256:
        step.prepared_request_sha256 ??
        preparedIntentSha256(transaction, stepName, operationId, effects),
      now: now(),
    });
    for (const effect of effects) {
      transaction = markOnboardingEffect(
        transaction,
        effect,
        now(),
      );
    }
    await options.store.saveActive(transaction);

    const prepared = transaction.steps[stepName];
    let outcome: OnboardingStepRunResult;
    try {
      outcome = await definition.run({
        operationId: prepared.operation_id as string,
        attempt: prepared.attempt_count,
      });
    } catch {
      // Unknown outcome: the prepared intent stays durable and the same
      // operation identity is replayed on resume. Never mint a replacement.
      transaction = withPublicState(
        transaction,
        'retryable',
        `${stepName}_interrupted`,
        now(),
      );
      await options.store.saveActive(transaction);
      return presentOnboardingStatus(transaction, `${stepName}_interrupted`);
    }

    if (outcome.result === 'succeeded') {
      transaction = transitionOnboardingStep(transaction, stepName, {
        to: 'succeeded',
        now: now(),
        acceptedReceiptSha256:
          outcome.receiptSha256 ??
          acceptedStepReceiptSha256(transaction, stepName, outcome),
      });
      await options.store.saveActive(transaction);
      continue;
    }

    if (
      outcome.result === 'waiting_for_user' ||
      outcome.result === 'waiting_for_administrator'
    ) {
      transaction = transitionOnboardingStep(transaction, stepName, {
        to: outcome.result,
        now: now(),
      });
      transaction = withPublicState(
        transaction,
        outcome.result,
        outcome.reasonCode,
        now(),
      );
      await options.store.saveActive(transaction);
      return presentOnboardingStatus(transaction, outcome.reasonCode);
    }

    if (outcome.result === 'retryable') {
      transaction = withPublicState(
        transaction,
        'retryable',
        outcome.reasonCode,
        now(),
      );
      await options.store.saveActive(transaction);
      return presentOnboardingStatus(transaction, outcome.reasonCode);
    }

    const terminalState =
      outcome.result === 'denied' ? 'terminal_denied' : 'terminal_preserved';
    transaction = transitionOnboardingStep(transaction, stepName, {
      to: terminalState,
      now: now(),
    });
    const finished = finishOnboardingTransaction(
      transaction,
      outcome.result,
      outcome.reasonCode,
      now(),
    );
    await options.store.saveActive(finished.transaction);
    await options.store.saveReceipt(finished.receipt);
    return presentOnboardingStatus(finished.transaction, outcome.reasonCode);
  }

  return await options.withReadyCommit(async () => {
    const resumePause = await validateOrPause(options, transaction);
    if (resumePause !== null) return resumePause;

    const finished = finishOnboardingTransaction(
      transaction,
      'ready',
      'profile_ready',
      now(),
    );
    await options.store.saveActive(finished.transaction);
    await options.store.saveReceipt(finished.receipt);
    return await presentReadyAfterCommit(
      options,
      finished.transaction,
      finished.receipt,
    );
  });
}
