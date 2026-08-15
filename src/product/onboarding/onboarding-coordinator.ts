import {
  ONBOARDING_STEPS,
  OnboardingTransactionError,
  createOnboardingTransaction,
  finishOnboardingTransaction,
  markOnboardingEffect,
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

export interface OnboardingStepDefinition {
  run(context: OnboardingStepContext): Promise<OnboardingStepRunResult>;
  /**
   * The effect boundary this step may cross. It is recorded durably before
   * the executor runs: after a crash the transaction must say the effect may
   * already exist, never that it surely does not.
   */
  effect?: keyof OnboardingEffects;
}

export interface OnboardingTransactionStore {
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
  /** Injectable clock; the default is the only wall-clock read in this module. */
  now?: () => string;
  nextOperationId: (step: OnboardingStepName) => string;
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

async function loadOrCreate(
  options: RunOnboardingFlowOptions,
  now: () => string,
): Promise<OnboardingTransactionV1> {
  const active = await options.store.loadActive();
  if (active === null) {
    return createOnboardingTransaction({
      identity: options.identity,
      configPath: options.configPath,
      stateDirectory: options.stateDirectory,
      now: now(),
    });
  }
  if (
    active.flow_id !== options.identity.flow_id ||
    active.profile_id !== options.identity.profile_id
  ) {
    throw new OnboardingTransactionError(
      'invalid_transaction',
      'a different onboarding flow owns this profile; reissue supersession is not part of slice 1',
    );
  }
  return active;
}

export async function runOnboardingFlow(
  options: RunOnboardingFlowOptions,
): Promise<OnboardingPublicStatus> {
  const now = options.now ?? (() => new Date().toISOString());
  let transaction = await loadOrCreate(options, now);
  if (transaction.finished_at !== null) {
    return presentOnboardingStatus(
      transaction,
      transaction.last_reason_code ?? 'flow_finished',
    );
  }

  for (const stepName of ONBOARDING_STEPS) {
    const step = transaction.steps[stepName];
    if (step.state === 'succeeded') continue;

    const definition = options.steps[stepName];
    if (definition === undefined) {
      throw new OnboardingTransactionError(
        'invalid_transaction',
        `onboarding step ${stepName} has no executor`,
      );
    }

    // Persist the prepared intent (and the may-have-occurred effect
    // boundary) durably before the executor may touch the outside world.
    transaction = transitionOnboardingStep(transaction, stepName, {
      to: 'prepared',
      operationId:
        step.operation_id ?? options.nextOperationId(stepName),
      now: now(),
    });
    if (definition.effect !== undefined) {
      transaction = markOnboardingEffect(
        transaction,
        definition.effect,
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
        ...(outcome.receiptSha256 === undefined
          ? {}
          : { acceptedReceiptSha256: outcome.receiptSha256 }),
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

  const finished = finishOnboardingTransaction(
    transaction,
    'ready',
    'profile_ready',
    now(),
  );
  await options.store.saveActive(finished.transaction);
  await options.store.saveReceipt(finished.receipt);
  return presentOnboardingStatus(finished.transaction, 'profile_ready');
}
