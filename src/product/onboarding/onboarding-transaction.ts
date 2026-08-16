import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';

/**
 * Durable resumable onboarding transaction (RFC-0001, Slice 1).
 *
 * The transaction is a secret-free snapshot of one onboarding flow. It records
 * prepared operation identities and accepted receipt digests; it is never
 * itself evidence that an external effect happened. Secret-bearing invitation
 * and credential material lives in separate private stores.
 */

export const ONBOARDING_STEPS = [
  'classify',
  'verify_trust',
  'confirm_human',
  'stage_local',
  'enroll',
  'service_install',
  'doctor',
  'readiness',
  'activate',
] as const;

export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

const STEP_STATES = [
  'not_started',
  'waiting_for_user',
  'waiting_for_administrator',
  'prepared',
  'reconciling',
  'succeeded',
  'terminal_denied',
  'terminal_abandoned',
  'terminal_preserved',
] as const;

export type OnboardingStepState = (typeof STEP_STATES)[number];

const PUBLIC_STATES = [
  'ready',
  'waiting_for_user',
  'waiting_for_administrator',
  'retryable',
  'denied',
  'preserved',
] as const;

export type OnboardingPublicState = (typeof PUBLIC_STATES)[number];

const ONBOARDING_RESULTS = ['ready', 'denied', 'abandoned', 'preserved'] as const;

export type OnboardingResult = (typeof ONBOARDING_RESULTS)[number];

export interface OnboardingStepRecord {
  state: OnboardingStepState;
  attempt_count: number;
  operation_id: string | null;
  prepared_request_sha256: string | null;
  accepted_receipt_sha256: string | null;
}

export interface OnboardingEffects {
  local_mutation: boolean;
  central_enrollment: boolean;
  provider_connection: boolean;
  service_activation: boolean;
  product_work: boolean;
}

export interface OnboardingTransactionV1 {
  schema_version: 1;
  kind: 'echo-onboarding-transaction';
  flow_id: string;
  profile_id: string;
  input_sha256: string;
  config_path: string;
  state_dir: string;
  steps: Record<OnboardingStepName, OnboardingStepRecord>;
  effects: OnboardingEffects;
  last_public_state: OnboardingPublicState | null;
  last_reason_code: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  terminal_result: OnboardingResult | null;
}

export type OnboardingTransactionErrorCode =
  | 'invalid_identity'
  | 'invalid_transaction'
  | 'illegal_transition'
  | 'busy';

export class OnboardingTransactionError extends Error {
  readonly code: OnboardingTransactionErrorCode;

  constructor(code: OnboardingTransactionErrorCode, message: string) {
    super(message);
    this.name = 'OnboardingTransactionError';
    this.code = code;
  }
}

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_REFERENCE_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code: OnboardingTransactionErrorCode, message: string): never {
  throw new OnboardingTransactionError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_transaction', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail('invalid_transaction', `${label} has unknown or missing fields`);
  }
}

function safeReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE_PATTERN.test(value)) {
    fail('invalid_transaction', `${label} must be a bounded safe reference`);
  }
  return value;
}

function optionalSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256_REFERENCE_PATTERN.test(value)) {
    fail('invalid_transaction', `${label} must be null or a sha256 reference`);
  }
  return value;
}

function sha256Reference(value: unknown, label: string): string {
  const parsed = optionalSha256(value, label);
  if (parsed === null) {
    fail('invalid_transaction', `${label} is required`);
  }
  return parsed;
}

function isoInstant(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !ISO_INSTANT_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail('invalid_transaction', `${label} must be a UTC ISO instant`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.startsWith('/') ||
    value.includes('\0')
  ) {
    fail('invalid_transaction', `${label} must be an absolute path`);
  }
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail('invalid_transaction', `${label} must be a boolean`);
  }
  return value;
}

function requiredIdentityField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE_PATTERN.test(value)) {
    fail('invalid_identity', `${label} must be a bounded safe reference`);
  }
  return value;
}

function digestReference(prefix: string, material: string): string {
  return `${prefix}-${createHash('sha256').update(material).digest('hex')}`;
}

/** One canonical digest implementation for all onboarding-owned documents. */
export function onboardingDocumentSha256(value: unknown): string {
  return canonicalSha256(value);
}

export interface OnboardingIdentityInput {
  authorityId: string;
  organizationId: string;
  membershipId: string;
  invitationCommandId: string;
  enrollmentGrantSha256: string;
}

export interface OnboardingIdentity {
  profile_id: string;
  flow_id: string;
}

/**
 * The stable profile identity depends only on the Authority, organization,
 * and membership, so a reissued invitation resumes the same member profile.
 * The flow identity additionally binds one invitation command and grant
 * digest, so each issued invitation names its own attempt. Neither embeds the
 * bearer grant bytes or any raw input value.
 */
export function deriveOnboardingIdentity(
  input: OnboardingIdentityInput,
): OnboardingIdentity {
  const authorityId = requiredIdentityField(input.authorityId, 'authority id');
  const organizationId = requiredIdentityField(
    input.organizationId,
    'organization id',
  );
  const membershipId = requiredIdentityField(
    input.membershipId,
    'membership id',
  );
  const invitationCommandId = requiredIdentityField(
    input.invitationCommandId,
    'invitation command id',
  );
  if (
    typeof input.enrollmentGrantSha256 !== 'string' ||
    !SHA256_REFERENCE_PATTERN.test(input.enrollmentGrantSha256)
  ) {
    fail('invalid_identity', 'enrollment grant digest must be a sha256 reference');
  }
  // Structured JSON is the complete preimage. Delimiter-joined strings admit
  // tuple collisions when a field contains the delimiter and must never own a
  // durable identity.
  const profileMaterial = JSON.stringify({
    kind: 'echo-onboarding-profile-identity-v1',
    authority_id: authorityId,
    organization_id: organizationId,
    membership_id: membershipId,
  });
  const flowMaterial = JSON.stringify({
    kind: 'echo-onboarding-flow-identity-v1',
    authority_id: authorityId,
    organization_id: organizationId,
    membership_id: membershipId,
    invitation_command_id: invitationCommandId,
    enrollment_grant_sha256: input.enrollmentGrantSha256,
  });
  return {
    profile_id: digestReference('prf', profileMaterial),
    flow_id: digestReference('flw', flowMaterial),
  };
}

export interface CreateOnboardingTransactionInput {
  identity: OnboardingIdentity;
  inputSha256: string;
  configPath: string;
  stateDirectory: string;
  now: string;
}

export function createOnboardingTransaction(
  input: CreateOnboardingTransactionInput,
): OnboardingTransactionV1 {
  const now = isoInstant(input.now, 'transaction creation time');
  const steps = {} as Record<OnboardingStepName, OnboardingStepRecord>;
  for (const step of ONBOARDING_STEPS) {
    steps[step] = {
      state: 'not_started',
      attempt_count: 0,
      operation_id: null,
      prepared_request_sha256: null,
      accepted_receipt_sha256: null,
    };
  }
  return parseOnboardingTransaction({
    schema_version: 1,
    kind: 'echo-onboarding-transaction',
    flow_id: input.identity.flow_id,
    profile_id: input.identity.profile_id,
    input_sha256: sha256Reference(input.inputSha256, 'onboarding input digest'),
    config_path: input.configPath,
    state_dir: input.stateDirectory,
    steps,
    effects: {
      local_mutation: false,
      central_enrollment: false,
      provider_connection: false,
      service_activation: false,
      product_work: false,
    },
    last_public_state: null,
    last_reason_code: null,
    started_at: now,
    updated_at: now,
    finished_at: null,
    terminal_result: null,
  });
}

function parseStepRecord(value: unknown, label: string): OnboardingStepRecord {
  const step = record(value, label);
  exactKeys(
    step,
    [
      'state',
      'attempt_count',
      'operation_id',
      'prepared_request_sha256',
      'accepted_receipt_sha256',
    ],
    label,
  );
  const state = step['state'];
  if (
    typeof state !== 'string' ||
    !STEP_STATES.includes(state as OnboardingStepState)
  ) {
    fail('invalid_transaction', `${label} has an unknown step state`);
  }
  const attempts = step['attempt_count'];
  if (
    typeof attempts !== 'number' ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0
  ) {
    fail(
      'invalid_transaction',
      `${label} attempt count must be a non-negative integer`,
    );
  }
  const operationId =
    step['operation_id'] === null
      ? null
      : safeReference(step['operation_id'], `${label} operation id`);
  const preparedRequestSha256 = optionalSha256(
    step['prepared_request_sha256'],
    `${label} prepared request digest`,
  );
  const acceptedReceiptSha256 = optionalSha256(
    step['accepted_receipt_sha256'],
    `${label} accepted receipt digest`,
  );
  if (state === 'not_started') {
    if (
      attempts !== 0 ||
      operationId !== null ||
      preparedRequestSha256 !== null ||
      acceptedReceiptSha256 !== null
    ) {
      fail('invalid_transaction', `${label} not_started state carries effect evidence`);
    }
  } else if (operationId === null) {
    if (
      state !== 'waiting_for_user' &&
      state !== 'waiting_for_administrator'
    ) {
      fail('invalid_transaction', `${label} state requires an operation identity`);
    }
    if (
      attempts !== 0 ||
      preparedRequestSha256 !== null ||
      acceptedReceiptSha256 !== null
    ) {
      fail('invalid_transaction', `${label} unprepared pause carries effect evidence`);
    }
  } else {
    if (attempts < 1 || preparedRequestSha256 === null) {
      fail(
        'invalid_transaction',
        `${label} prepared state requires an attempt and request digest`,
      );
    }
    if (state === 'succeeded' && acceptedReceiptSha256 === null) {
      fail('invalid_transaction', `${label} succeeded state requires a receipt digest`);
    }
    if (state !== 'succeeded' && acceptedReceiptSha256 !== null) {
      fail(
        'invalid_transaction',
        `${label} may retain an accepted receipt only after success`,
      );
    }
  }
  return {
    state: state as OnboardingStepState,
    attempt_count: attempts,
    operation_id: operationId,
    prepared_request_sha256: preparedRequestSha256,
    accepted_receipt_sha256: acceptedReceiptSha256,
  };
}

const FROZEN_STEP_STATES: readonly OnboardingStepState[] = [
  'succeeded',
  'terminal_denied',
  'terminal_abandoned',
  'terminal_preserved',
];

export interface OnboardingStepTransitionInput {
  to: OnboardingStepState;
  now: string;
  operationId?: string;
  preparedRequestSha256?: string;
  acceptedReceiptSha256?: string;
}

function assertLegalTransition(
  step: OnboardingStepName,
  from: OnboardingStepState,
  to: OnboardingStepState,
): void {
  if (FROZEN_STEP_STATES.includes(from)) {
    fail(
      'illegal_transition',
      `illegal onboarding step transition: ${step} is ${from} and frozen`,
    );
  }
  if (to === 'not_started') {
    fail(
      'illegal_transition',
      `illegal onboarding step transition: ${step} cannot return to not_started`,
    );
  }
  if (
    to === 'succeeded' &&
    from !== 'prepared' &&
    from !== 'reconciling'
  ) {
    fail(
      'illegal_transition',
      `illegal onboarding step transition: ${step} cannot succeed from ${from}`,
    );
  }
  if (to === 'reconciling' && from !== 'prepared' && from !== 'reconciling') {
    fail(
      'illegal_transition',
      `illegal onboarding step transition: ${step} cannot reconcile from ${from}`,
    );
  }
}

function assertMutableInstant(
  transaction: OnboardingTransactionV1,
  now: string,
): void {
  if (transaction.finished_at !== null) {
    fail(
      'illegal_transition',
      'onboarding transaction is finished and immutable',
    );
  }
  if (Date.parse(now) < Date.parse(transaction.updated_at)) {
    fail('illegal_transition', 'onboarding transaction time cannot move backward');
  }
}

/**
 * One legal step transition. The operation identity is minted exactly once on
 * the first preparation and is immutable until the step is terminal; a resume
 * replays the same identity instead of inventing a replacement effect.
 */
export function transitionOnboardingStep(
  transaction: OnboardingTransactionV1,
  stepName: OnboardingStepName,
  input: OnboardingStepTransitionInput,
): OnboardingTransactionV1 {
  const now = isoInstant(input.now, 'transaction update instant');
  assertMutableInstant(transaction, now);
  const current = transaction.steps[stepName];
  if (current === undefined) {
    fail('invalid_transaction', `unknown onboarding step: ${stepName}`);
  }
  assertLegalTransition(stepName, current.state, input.to);
  const next: OnboardingStepRecord = { ...current, state: input.to };
  if (input.to === 'prepared') {
    const effectiveOperationId = input.operationId ?? current.operation_id;
    if (effectiveOperationId === null) {
      fail(
        'invalid_transaction',
        `onboarding step ${stepName} requires a stable operation identity to prepare`,
      );
    }
    if (
      current.operation_id !== null &&
      effectiveOperationId !== current.operation_id
    ) {
      fail(
        'illegal_transition',
        `onboarding step ${stepName} operation identity is immutable until terminal`,
      );
    }
    next.operation_id = safeReference(
      effectiveOperationId,
      `onboarding step ${stepName} operation id`,
    );
    next.attempt_count = current.attempt_count + 1;
    const effectiveRequestSha256 =
      input.preparedRequestSha256 ?? current.prepared_request_sha256;
    if (effectiveRequestSha256 === null) {
      fail(
        'invalid_transaction',
        `onboarding step ${stepName} requires a prepared request digest`,
      );
    }
    if (
      current.prepared_request_sha256 !== null &&
      current.prepared_request_sha256 !== effectiveRequestSha256
    ) {
      fail(
        'illegal_transition',
        `onboarding step ${stepName} prepared request digest is immutable`,
      );
    }
    next.prepared_request_sha256 = optionalSha256(
      effectiveRequestSha256,
      `onboarding step ${stepName} prepared request digest`,
    );
  } else if (input.operationId !== undefined) {
    fail(
      'invalid_transaction',
      `onboarding step ${stepName} may take an operation identity only when preparing`,
    );
  }
  if (input.acceptedReceiptSha256 !== undefined) {
    if (input.to !== 'succeeded') {
      fail(
        'invalid_transaction',
        `onboarding step ${stepName} may record a receipt only when succeeding`,
      );
    }
    next.accepted_receipt_sha256 = optionalSha256(
      input.acceptedReceiptSha256,
      `onboarding step ${stepName} accepted receipt digest`,
    );
  } else if (input.to === 'succeeded') {
    fail(
      'invalid_transaction',
      `onboarding step ${stepName} requires an accepted receipt digest`,
    );
  }
  return parseOnboardingTransaction({
    ...transaction,
    steps: { ...transaction.steps, [stepName]: next },
    updated_at: now,
  });
}

export function markOnboardingEffect(
  transaction: OnboardingTransactionV1,
  effect: keyof OnboardingEffects,
  now: string,
): OnboardingTransactionV1 {
  if (!(effect in transaction.effects)) {
    fail('invalid_transaction', `unknown onboarding effect: ${String(effect)}`);
  }
  const instant = isoInstant(now, 'transaction update instant');
  assertMutableInstant(transaction, instant);
  return parseOnboardingTransaction({
    ...transaction,
    effects: { ...transaction.effects, [effect]: true },
    updated_at: instant,
  });
}

export interface OnboardingPublicStatus {
  status: OnboardingPublicState;
  reason_code: string;
  flow_id: string;
  step: OnboardingStepName;
  effects: OnboardingEffects;
}

function firstStepIn(
  transaction: OnboardingTransactionV1,
  states: readonly OnboardingStepState[],
): OnboardingStepName | undefined {
  return ONBOARDING_STEPS.find((step) =>
    states.includes(transaction.steps[step].state),
  );
}

/**
 * Projects the durable transaction into the public six-state contract. The
 * projection is ordered: preservation outranks denial, denial outranks an
 * administrator pause, an administrator pause outranks a user pause, and
 * `ready` requires every step to have succeeded. Anything else is a bounded
 * retry over the first unfinished step. It never emits follow-up commands.
 */
export function presentOnboardingStatus(
  transaction: OnboardingTransactionV1,
  reasonCode: string,
): OnboardingPublicStatus {
  const preserved = firstStepIn(transaction, [
    'terminal_preserved',
    'terminal_abandoned',
  ]);
  const denied = firstStepIn(transaction, ['terminal_denied']);
  const waitingAdministrator = firstStepIn(transaction, [
    'waiting_for_administrator',
  ]);
  const waitingUser = firstStepIn(transaction, ['waiting_for_user']);
  const unfinished = ONBOARDING_STEPS.find(
    (step) => transaction.steps[step].state !== 'succeeded',
  );
  let status: OnboardingPublicState;
  let step: OnboardingStepName;
  if (preserved !== undefined) {
    status = 'preserved';
    step = preserved;
  } else if (denied !== undefined) {
    status = 'denied';
    step = denied;
  } else if (waitingAdministrator !== undefined) {
    status = 'waiting_for_administrator';
    step = waitingAdministrator;
  } else if (waitingUser !== undefined) {
    status = 'waiting_for_user';
    step = waitingUser;
  } else if (
    unfinished === undefined &&
    transaction.finished_at !== null &&
    transaction.terminal_result === 'ready'
  ) {
    status = 'ready';
    step = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
  } else {
    status = 'retryable';
    step = unfinished ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
  }
  return {
    status,
    reason_code: reasonCode,
    flow_id: transaction.flow_id,
    step,
    effects: { ...transaction.effects },
  };
}

export interface OnboardingReceiptV1 {
  schema_version: 1;
  kind: 'echo-onboarding-receipt';
  flow_id: string;
  profile_id: string;
  input_sha256: string;
  transaction_sha256: string;
  result: OnboardingResult;
  reason_code: string;
  effects: OnboardingEffects;
  started_at: string;
  finished_at: string;
}

export function parseOnboardingReceipt(value: unknown): OnboardingReceiptV1 {
  const receipt = record(value, 'onboarding receipt');
  exactKeys(
    receipt,
    [
      'schema_version',
      'kind',
      'flow_id',
      'profile_id',
      'input_sha256',
      'transaction_sha256',
      'result',
      'reason_code',
      'effects',
      'started_at',
      'finished_at',
    ],
    'onboarding receipt',
  );
  if (receipt['schema_version'] !== 1) {
    fail('invalid_transaction', 'onboarding receipt schema is unsupported');
  }
  if (receipt['kind'] !== 'echo-onboarding-receipt') {
    fail('invalid_transaction', 'onboarding receipt kind is unsupported');
  }
  const result = receipt['result'];
  if (
    typeof result !== 'string' ||
    !ONBOARDING_RESULTS.includes(result as OnboardingResult)
  ) {
    fail('invalid_transaction', 'onboarding receipt result is unknown');
  }
  const reasonCode = receipt['reason_code'];
  const parsedReasonCode = safeReference(
    reasonCode,
    'onboarding receipt reason code',
  );
  const effects = record(receipt['effects'], 'onboarding receipt effects');
  exactKeys(
    effects,
    [
      'local_mutation',
      'central_enrollment',
      'provider_connection',
      'service_activation',
      'product_work',
    ],
    'onboarding receipt effects',
  );
  const startedAt = isoInstant(receipt['started_at'], 'receipt start instant');
  const finishedAt = isoInstant(receipt['finished_at'], 'receipt finish instant');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail('invalid_transaction', 'onboarding receipt finishes before it starts');
  }
  return {
    schema_version: 1,
    kind: 'echo-onboarding-receipt',
    flow_id: safeReference(receipt['flow_id'], 'onboarding receipt flow id'),
    profile_id: safeReference(
      receipt['profile_id'],
      'onboarding receipt profile id',
    ),
    input_sha256: sha256Reference(
      receipt['input_sha256'],
      'onboarding receipt input digest',
    ),
    transaction_sha256: sha256Reference(
      receipt['transaction_sha256'],
      'onboarding receipt transaction digest',
    ),
    result: result as OnboardingResult,
    reason_code: parsedReasonCode,
    effects: {
      local_mutation: booleanField(effects['local_mutation'], 'local mutation'),
      central_enrollment: booleanField(
        effects['central_enrollment'],
        'central enrollment',
      ),
      provider_connection: booleanField(
        effects['provider_connection'],
        'provider connection',
      ),
      service_activation: booleanField(
        effects['service_activation'],
        'service activation',
      ),
      product_work: booleanField(effects['product_work'], 'product work'),
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

/**
 * Closes a flow with one legal terminal result and returns the immutable
 * receipt evidence. `ready` is legal only when every step succeeded; a
 * finished transaction can never be finished again.
 */
export function finishOnboardingTransaction(
  transaction: OnboardingTransactionV1,
  result: OnboardingResult,
  reasonCode: string,
  now: string,
): { transaction: OnboardingTransactionV1; receipt: OnboardingReceiptV1 } {
  const finishedAt = isoInstant(now, 'transaction finish instant');
  if (transaction.finished_at !== null) {
    fail(
      'illegal_transition',
      'onboarding transaction is already finished and immutable',
    );
  }
  assertMutableInstant(transaction, finishedAt);
  if (
    result === 'ready' &&
    ONBOARDING_STEPS.some(
      (step) => transaction.steps[step].state !== 'succeeded',
    )
  ) {
    fail(
      'illegal_transition',
      'onboarding cannot report ready before every step succeeded',
    );
  }
  const parsedReasonCode = safeReference(reasonCode, 'onboarding finish reason code');
  const publicState: OnboardingPublicState =
    result === 'abandoned' ? 'preserved' : result;
  const finished = parseOnboardingTransaction({
    ...transaction,
    last_public_state: publicState,
    last_reason_code: parsedReasonCode,
    updated_at: finishedAt,
    finished_at: finishedAt,
    terminal_result: result,
  });
  return {
    transaction: finished,
    receipt: onboardingReceiptForFinishedTransaction(finished),
  };
}

/**
 * Deterministically reconstruct the only legal terminal receipt. This is the
 * recovery seam for a crash after the terminal journal was published but
 * before its write-once receipt was linked into place.
 */
export function onboardingReceiptForFinishedTransaction(
  transaction: OnboardingTransactionV1,
): OnboardingReceiptV1 {
  const validated = parseOnboardingTransaction(transaction);
  if (
    validated.finished_at === null ||
    validated.terminal_result === null ||
    validated.last_reason_code === null
  ) {
    fail('invalid_transaction', 'unfinished onboarding has no terminal receipt');
  }
  return parseOnboardingReceipt({
    schema_version: 1,
    kind: 'echo-onboarding-receipt',
    flow_id: validated.flow_id,
    profile_id: validated.profile_id,
    input_sha256: validated.input_sha256,
    transaction_sha256: onboardingDocumentSha256(validated),
    result: validated.terminal_result,
    reason_code: validated.last_reason_code,
    effects: { ...validated.effects },
    started_at: validated.started_at,
    finished_at: validated.finished_at,
  });
}

export function parseOnboardingTransaction(
  value: unknown,
): OnboardingTransactionV1 {
  const transaction = record(value, 'onboarding transaction');
  exactKeys(
    transaction,
    [
      'schema_version',
      'kind',
      'flow_id',
      'profile_id',
      'input_sha256',
      'config_path',
      'state_dir',
      'steps',
      'effects',
      'last_public_state',
      'last_reason_code',
      'started_at',
      'updated_at',
      'finished_at',
      'terminal_result',
    ],
    'onboarding transaction',
  );
  if (transaction['schema_version'] !== 1) {
    fail('invalid_transaction', 'onboarding transaction schema is unsupported');
  }
  if (transaction['kind'] !== 'echo-onboarding-transaction') {
    fail('invalid_transaction', 'onboarding transaction kind is unsupported');
  }
  const stepsRecord = record(transaction['steps'], 'onboarding steps');
  exactKeys(stepsRecord, ONBOARDING_STEPS, 'onboarding steps');
  const steps = {} as Record<OnboardingStepName, OnboardingStepRecord>;
  for (const step of ONBOARDING_STEPS) {
    steps[step] = parseStepRecord(stepsRecord[step], `onboarding step ${step}`);
  }
  let frontierSeen = false;
  for (const step of ONBOARDING_STEPS) {
    const state = steps[step].state;
    if (!frontierSeen && state === 'succeeded') continue;
    if (!frontierSeen) {
      frontierSeen = true;
      continue;
    }
    if (state !== 'not_started') {
      fail(
        'invalid_transaction',
        'onboarding steps must form one succeeded prefix and one active frontier',
      );
    }
  }
  const effectsRecord = record(transaction['effects'], 'onboarding effects');
  exactKeys(
    effectsRecord,
    [
      'local_mutation',
      'central_enrollment',
      'provider_connection',
      'service_activation',
      'product_work',
    ],
    'onboarding effects',
  );
  const lastPublicState = transaction['last_public_state'];
  if (
    lastPublicState !== null &&
    (typeof lastPublicState !== 'string' ||
      !PUBLIC_STATES.includes(lastPublicState as OnboardingPublicState))
  ) {
    fail('invalid_transaction', 'onboarding public state is unknown');
  }
  const lastReasonCode = transaction['last_reason_code'];
  const parsedReasonCode =
    lastReasonCode === null
      ? null
      : safeReference(lastReasonCode, 'onboarding reason code');
  const finishedAt = transaction['finished_at'];
  const terminalResult = transaction['terminal_result'];
  if (
    terminalResult !== null &&
    (typeof terminalResult !== 'string' ||
      !ONBOARDING_RESULTS.includes(terminalResult as OnboardingResult))
  ) {
    fail('invalid_transaction', 'onboarding terminal result is unknown');
  }
  const startedAt = isoInstant(
    transaction['started_at'],
    'transaction start instant',
  );
  const updatedAt = isoInstant(
    transaction['updated_at'],
    'transaction update instant',
  );
  const parsedFinishedAt =
    finishedAt === null
      ? null
      : isoInstant(finishedAt, 'transaction finish instant');
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    fail('invalid_transaction', 'onboarding transaction update precedes its start');
  }
  if (
    parsedFinishedAt !== null &&
    (parsedFinishedAt !== updatedAt || Date.parse(parsedFinishedAt) < Date.parse(startedAt))
  ) {
    fail(
      'invalid_transaction',
      'onboarding transaction finish must equal its final update',
    );
  }
  if ((parsedFinishedAt === null) !== (terminalResult === null)) {
    fail(
      'invalid_transaction',
      'onboarding terminal result and finish instant must be committed together',
    );
  }
  if (parsedFinishedAt === null) {
    if (
      lastPublicState === 'ready' ||
      lastPublicState === 'denied' ||
      lastPublicState === 'preserved'
    ) {
      fail('invalid_transaction', 'unfinished onboarding claims a terminal state');
    }
  } else {
    if (parsedReasonCode === null) {
      fail('invalid_transaction', 'finished onboarding requires a reason code');
    }
    const expectedPublicState: OnboardingPublicState =
      terminalResult === 'abandoned' ? 'preserved' : terminalResult as OnboardingPublicState;
    if (lastPublicState !== expectedPublicState) {
      fail('invalid_transaction', 'finished onboarding public state conflicts');
    }
    if (
      terminalResult === 'ready' &&
      ONBOARDING_STEPS.some((step) => steps[step].state !== 'succeeded')
    ) {
      fail('invalid_transaction', 'ready onboarding has unfinished steps');
    }
    const expectedTerminalState =
      terminalResult === 'denied'
        ? 'terminal_denied'
        : terminalResult === 'preserved'
          ? 'terminal_preserved'
          : terminalResult === 'abandoned'
            ? 'terminal_abandoned'
            : null;
    if (
      expectedTerminalState !== null &&
      !ONBOARDING_STEPS.some(
        (step) => steps[step].state === expectedTerminalState,
      )
    ) {
      fail(
        'invalid_transaction',
        `${terminalResult} onboarding has no matching terminal step`,
      );
    }
  }
  return {
    schema_version: 1,
    kind: 'echo-onboarding-transaction',
    flow_id: safeReference(transaction['flow_id'], 'onboarding flow id'),
    profile_id: safeReference(
      transaction['profile_id'],
      'onboarding profile id',
    ),
    input_sha256: sha256Reference(
      transaction['input_sha256'],
      'onboarding input digest',
    ),
    config_path: absolutePath(
      transaction['config_path'],
      'onboarding config path',
    ),
    state_dir: absolutePath(transaction['state_dir'], 'onboarding state dir'),
    steps,
    effects: {
      local_mutation: booleanField(
        effectsRecord['local_mutation'],
        'local mutation effect',
      ),
      central_enrollment: booleanField(
        effectsRecord['central_enrollment'],
        'central enrollment effect',
      ),
      provider_connection: booleanField(
        effectsRecord['provider_connection'],
        'provider connection effect',
      ),
      service_activation: booleanField(
        effectsRecord['service_activation'],
        'service activation effect',
      ),
      product_work: booleanField(
        effectsRecord['product_work'],
        'product work effect',
      ),
    },
    last_public_state: lastPublicState as OnboardingPublicState | null,
    last_reason_code: parsedReasonCode,
    started_at: startedAt,
    updated_at: updatedAt,
    finished_at: parsedFinishedAt,
    terminal_result: terminalResult as OnboardingResult | null,
  };
}
