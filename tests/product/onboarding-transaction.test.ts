import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEPS,
  OnboardingTransactionError,
  createOnboardingTransaction,
  deriveOnboardingIdentity,
  finishOnboardingTransaction,
  markOnboardingEffect,
  parseOnboardingTransaction,
  presentOnboardingStatus,
  transitionOnboardingStep,
} from '../../src/product/onboarding/onboarding-transaction.js';

const IDENTITY_INPUT = {
  authorityId: 'auth_11111111',
  organizationId: 'org_22222222',
  membershipId: 'mem_33333333',
  invitationCommandId: 'adm_44444444',
  enrollmentGrantSha256:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const NOW = '2026-08-15T12:00:00.000Z';
const INPUT_SHA256 = `sha256:${'b'.repeat(64)}`;
const REQUEST_SHA256 = `sha256:${'c'.repeat(64)}`;
const RECEIPT_SHA256 = `sha256:${'d'.repeat(64)}`;

function freshTransaction() {
  return createOnboardingTransaction({
    identity: deriveOnboardingIdentity(IDENTITY_INPUT),
    inputSha256: INPUT_SHA256,
    configPath: '/private/example/config.json',
    stateDirectory: '/private/example/state',
    now: NOW,
  });
}

function transactionAt(stepName: (typeof ONBOARDING_STEPS)[number]) {
  let transaction = freshTransaction();
  for (const step of ONBOARDING_STEPS) {
    if (step === stepName) break;
    transaction = transitionOnboardingStep(transaction, step, {
      to: 'prepared',
      operationId: `onb-prefix-${step}`,
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    transaction = transitionOnboardingStep(transaction, step, {
      to: 'succeeded',
      acceptedReceiptSha256: RECEIPT_SHA256,
      now: LATER,
    });
  }
  return transaction;
}

describe('deriveOnboardingIdentity', () => {
  it('derives a stable profile id from authority, organization, and membership only', () => {
    const first = deriveOnboardingIdentity(IDENTITY_INPUT);
    const reissued = deriveOnboardingIdentity({
      ...IDENTITY_INPUT,
      invitationCommandId: 'adm_55555555',
      enrollmentGrantSha256:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(reissued.profile_id).toBe(first.profile_id);
    expect(reissued.flow_id).not.toBe(first.flow_id);
  });

  it('derives different profile ids for different memberships', () => {
    const other = deriveOnboardingIdentity({
      ...IDENTITY_INPUT,
      membershipId: 'mem_99999999',
    });
    expect(other.profile_id).not.toBe(
      deriveOnboardingIdentity(IDENTITY_INPUT).profile_id,
    );
  });

  it('emits safe-reference identifiers that never embed the input values', () => {
    const identity = deriveOnboardingIdentity(IDENTITY_INPUT);
    for (const value of [identity.profile_id, identity.flow_id]) {
      expect(value).toMatch(/^[a-z0-9-]+$/u);
      expect(value).not.toContain(IDENTITY_INPUT.membershipId);
      expect(value).not.toContain('sha256:');
    }
  });

  it('rejects delimiter-bearing identity fields instead of admitting tuple collisions', () => {
    expect(() =>
      deriveOnboardingIdentity({
        ...IDENTITY_INPUT,
        authorityId: 'auth_a\norg_b',
      }),
    ).toThrow(/safe reference/u);
  });
});

describe('createOnboardingTransaction', () => {
  it('creates an exact-key transaction with every step not_started', () => {
    const transaction = freshTransaction();
    expect(transaction.kind).toBe('echo-onboarding-transaction');
    expect(transaction.schema_version).toBe(1);
    expect(Object.keys(transaction.steps)).toEqual([...ONBOARDING_STEPS]);
    for (const step of ONBOARDING_STEPS) {
      expect(transaction.steps[step]).toEqual({
        state: 'not_started',
        attempt_count: 0,
        operation_id: null,
        prepared_request_sha256: null,
        accepted_receipt_sha256: null,
      });
    }
    expect(transaction.effects).toEqual({
      local_mutation: false,
      central_enrollment: false,
      provider_connection: false,
      service_activation: false,
      product_work: false,
    });
    expect(transaction.finished_at).toBeNull();
  });

  it('round-trips through parseOnboardingTransaction unchanged', () => {
    const transaction = freshTransaction();
    expect(parseOnboardingTransaction(JSON.parse(JSON.stringify(transaction))))
      .toEqual(transaction);
  });
});

describe('parseOnboardingTransaction', () => {
  it('rejects unknown top-level fields', () => {
    const poisoned = { ...freshTransaction(), next_steps: [] };
    expect(() => parseOnboardingTransaction(poisoned)).toThrow(
      OnboardingTransactionError,
    );
  });

  it('rejects an unknown step state', () => {
    const transaction = JSON.parse(JSON.stringify(freshTransaction()));
    transaction.steps.enroll.state = 'running';
    expect(() => parseOnboardingTransaction(transaction)).toThrow(
      /step state/u,
    );
  });

  it('rejects a missing or extra step', () => {
    const missing = JSON.parse(JSON.stringify(freshTransaction()));
    delete missing.steps.doctor;
    expect(() => parseOnboardingTransaction(missing)).toThrow(
      OnboardingTransactionError,
    );
    const extra = JSON.parse(JSON.stringify(freshTransaction()));
    extra.steps.unexpected = { ...extra.steps.classify };
    expect(() => parseOnboardingTransaction(extra)).toThrow(
      OnboardingTransactionError,
    );
  });

  it('rejects a non-ISO timestamp', () => {
    const transaction = JSON.parse(JSON.stringify(freshTransaction()));
    transaction.updated_at = 'yesterday';
    expect(() => parseOnboardingTransaction(transaction)).toThrow(
      /timestamp|instant/iu,
    );
  });

  it('rejects an impossible timestamp and a clock rewind', () => {
    const impossible = JSON.parse(JSON.stringify(freshTransaction()));
    impossible.updated_at = '2026-02-30T12:00:00.000Z';
    expect(() => parseOnboardingTransaction(impossible)).toThrow(/instant/u);

    const rewound = JSON.parse(JSON.stringify(freshTransaction()));
    rewound.updated_at = '2026-08-15T11:59:59.000Z';
    expect(() => parseOnboardingTransaction(rewound)).toThrow(/precedes/u);
  });

  it('rejects succeeded state without its prepared intent and receipt evidence', () => {
    const poisoned = JSON.parse(JSON.stringify(freshTransaction()));
    poisoned.steps.classify.state = 'succeeded';
    expect(() => parseOnboardingTransaction(poisoned)).toThrow(
      /operation identity|receipt digest/u,
    );
  });

  it('rejects multiple frontiers and a succeeded step after an unfinished step', () => {
    const twoFrontiers = JSON.parse(
      JSON.stringify(transactionAt('doctor')),
    );
    twoFrontiers.steps.doctor = {
      state: 'prepared',
      attempt_count: 1,
      operation_id: 'onb-doctor',
      prepared_request_sha256: REQUEST_SHA256,
      accepted_receipt_sha256: null,
    };
    twoFrontiers.steps.readiness = {
      state: 'prepared',
      attempt_count: 1,
      operation_id: 'onb-readiness',
      prepared_request_sha256: REQUEST_SHA256,
      accepted_receipt_sha256: null,
    };
    expect(() => parseOnboardingTransaction(twoFrontiers)).toThrow(
      OnboardingTransactionError,
    );

    const outOfOrder = JSON.parse(JSON.stringify(transactionAt('doctor')));
    outOfOrder.steps.readiness = {
      state: 'succeeded',
      attempt_count: 1,
      operation_id: 'onb-readiness',
      prepared_request_sha256: REQUEST_SHA256,
      accepted_receipt_sha256: RECEIPT_SHA256,
    };
    expect(() => parseOnboardingTransaction(outOfOrder)).toThrow(
      OnboardingTransactionError,
    );
  });

  it('rejects terminal result, public-state, and timestamp half-commits', () => {
    let denied = transactionAt('verify_trust');
    denied = transitionOnboardingStep(denied, 'verify_trust', {
      to: 'prepared',
      operationId: 'onb-denied',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    denied = transitionOnboardingStep(denied, 'verify_trust', {
      to: 'terminal_denied',
      now: LATER,
    });
    const terminal = finishOnboardingTransaction(
      denied,
      'denied',
      'pin_mismatch',
      LATER,
    ).transaction;
    const mismatchedResult = JSON.parse(JSON.stringify(terminal));
    mismatchedResult.terminal_result = 'preserved';
    mismatchedResult.last_public_state = 'preserved';
    expect(() => parseOnboardingTransaction(mismatchedResult)).toThrow(
      OnboardingTransactionError,
    );

    const mismatchedPublic = JSON.parse(JSON.stringify(terminal));
    mismatchedPublic.last_public_state = 'retryable';
    expect(() => parseOnboardingTransaction(mismatchedPublic)).toThrow(
      OnboardingTransactionError,
    );

    const halfCommitted = JSON.parse(JSON.stringify(freshTransaction()));
    halfCommitted.finished_at = LATER;
    expect(() => parseOnboardingTransaction(halfCommitted)).toThrow(
      OnboardingTransactionError,
    );
  });
});

const LATER = '2026-08-15T12:05:00.000Z';

describe('transitionOnboardingStep', () => {
  it('prepares a not_started step with a new operation identity', () => {
    const prepared = transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
      to: 'prepared',
      operationId: 'onb-op-1',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    expect(prepared.steps.enroll).toEqual({
      state: 'prepared',
      attempt_count: 1,
      operation_id: 'onb-op-1',
      prepared_request_sha256: REQUEST_SHA256,
      accepted_receipt_sha256: null,
    });
    expect(prepared.updated_at).toBe(LATER);
  });

  it('refuses to prepare without an operation identity', () => {
    expect(() =>
      transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
        to: 'prepared',
        now: LATER,
      }),
    ).toThrow(/operation identity/u);
  });

  it('keeps the operation identity immutable until the step is terminal', () => {
    const prepared = transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
      to: 'prepared',
      operationId: 'onb-op-1',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    expect(() =>
      transitionOnboardingStep(prepared, 'enroll', {
        to: 'prepared',
        operationId: 'onb-op-2',
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      }),
    ).toThrow(/operation identity/u);
    const replayed = transitionOnboardingStep(prepared, 'enroll', {
      to: 'prepared',
      operationId: 'onb-op-1',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    expect(replayed.steps.enroll.operation_id).toBe('onb-op-1');
    expect(replayed.steps.enroll.attempt_count).toBe(2);
  });

  it('refuses to succeed a step that was never prepared', () => {
    expect(() =>
      transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
        to: 'succeeded',
        now: LATER,
      }),
    ).toThrow(OnboardingTransactionError);
  });

  it('records the accepted receipt digest when a prepared step succeeds', () => {
    const prepared = transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
      to: 'prepared',
      operationId: 'onb-op-1',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    const succeeded = transitionOnboardingStep(prepared, 'enroll', {
      to: 'succeeded',
      acceptedReceiptSha256: RECEIPT_SHA256,
      now: LATER,
    });
    expect(succeeded.steps.enroll.state).toBe('succeeded');
    expect(succeeded.steps.enroll.accepted_receipt_sha256).toBe(
      RECEIPT_SHA256,
    );
  });

  it('freezes succeeded and terminal steps', () => {
    const prepared = transitionOnboardingStep(transactionAt('enroll'), 'enroll', {
      to: 'prepared',
      operationId: 'onb-op-1',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    const succeeded = transitionOnboardingStep(prepared, 'enroll', {
      to: 'succeeded',
      acceptedReceiptSha256: RECEIPT_SHA256,
      now: LATER,
    });
    expect(() =>
      transitionOnboardingStep(succeeded, 'enroll', {
        to: 'prepared',
        operationId: 'onb-op-1',
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      }),
    ).toThrow(/illegal/iu);
    const denialPrepared = transitionOnboardingStep(
      transactionAt('verify_trust'),
      'verify_trust',
      {
        to: 'prepared',
        operationId: 'onb-op-denied',
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      },
    );
    const denied = transitionOnboardingStep(denialPrepared, 'verify_trust', {
      to: 'terminal_denied',
      now: LATER,
    });
    expect(() =>
      transitionOnboardingStep(denied, 'verify_trust', {
        to: 'prepared',
        operationId: 'onb-op-denied',
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      }),
    ).toThrow(/illegal/iu);
  });

  it('pauses without consuming an operation identity and resumes with one', () => {
    const waiting = transitionOnboardingStep(transactionAt('confirm_human'), 'confirm_human', {
      to: 'waiting_for_user',
      now: LATER,
    });
    expect(waiting.steps.confirm_human.operation_id).toBeNull();
    expect(waiting.steps.confirm_human.attempt_count).toBe(0);
    const resumed = transitionOnboardingStep(waiting, 'confirm_human', {
      to: 'prepared',
      operationId: 'onb-op-3',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    expect(resumed.steps.confirm_human.attempt_count).toBe(1);
  });
});

describe('markOnboardingEffect', () => {
  it('records an effect boundary irreversibly', () => {
    const marked = markOnboardingEffect(
      freshTransaction(),
      'central_enrollment',
      LATER,
    );
    expect(marked.effects.central_enrollment).toBe(true);
    const again = markOnboardingEffect(marked, 'central_enrollment', LATER);
    expect(again.effects.central_enrollment).toBe(true);
  });

  it('cannot mutate effects after the transaction is finished', () => {
    let transaction = freshTransaction();
    for (const step of ONBOARDING_STEPS) {
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'prepared',
        operationId: `onb-op-${step}`,
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      });
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'succeeded',
        acceptedReceiptSha256: RECEIPT_SHA256,
        now: LATER,
      });
    }
    const finished = finishOnboardingTransaction(
      transaction,
      'ready',
      'profile_ready',
      LATER,
    ).transaction;
    expect(() =>
      markOnboardingEffect(finished, 'product_work', LATER),
    ).toThrow(/finished|immutable/u);
    expect(() =>
      transitionOnboardingStep(finished, 'classify', {
        to: 'prepared',
        operationId: 'onb-op-classify',
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      }),
    ).toThrow(/finished|immutable/u);
  });
});

describe('presentOnboardingStatus', () => {
  it('reports retryable for a fresh in-progress flow without next steps', () => {
    const status = presentOnboardingStatus(freshTransaction(), 'flow_created');
    expect(status).toEqual({
      status: 'retryable',
      reason_code: 'flow_created',
      flow_id: freshTransaction().flow_id,
      step: 'classify',
      effects: {
        local_mutation: false,
        central_enrollment: false,
        provider_connection: false,
        service_activation: false,
        product_work: false,
      },
    });
    expect(Object.keys(status)).not.toContain('next_steps');
  });

  it('reports waiting_for_user at the first waiting step', () => {
    const waiting = transitionOnboardingStep(transactionAt('confirm_human'), 'confirm_human', {
      to: 'waiting_for_user',
      now: LATER,
    });
    const status = presentOnboardingStatus(waiting, 'consent_required');
    expect(status.status).toBe('waiting_for_user');
    expect(status.step).toBe('confirm_human');
  });

  it('reports denied at the one active frontier', () => {
    let transaction = transitionOnboardingStep(transactionAt('verify_trust'), 'verify_trust', {
      to: 'prepared',
      operationId: 'onb-op-denied',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    transaction = transitionOnboardingStep(transaction, 'verify_trust', {
      to: 'terminal_denied',
      now: LATER,
    });
    expect(presentOnboardingStatus(transaction, 'pin_mismatch').status).toBe(
      'denied',
    );
  });

  it('reports preserved at the one active frontier', () => {
    let transaction = transitionOnboardingStep(freshTransaction(), 'classify', {
      to: 'prepared',
      operationId: 'onb-op-preserved',
      preparedRequestSha256: REQUEST_SHA256,
      now: LATER,
    });
    transaction = transitionOnboardingStep(transaction, 'classify', {
      to: 'terminal_preserved',
      now: LATER,
    });
    expect(
      presentOnboardingStatus(transaction, 'ambiguous_installation').status,
    ).toBe('preserved');
  });

  it('reports ready only when every step succeeded', () => {
    let transaction = freshTransaction();
    for (const step of ONBOARDING_STEPS) {
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'prepared',
        operationId: `onb-op-${step}`,
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      });
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'succeeded',
        acceptedReceiptSha256: RECEIPT_SHA256,
        now: LATER,
      });
    }
    const finished = finishOnboardingTransaction(
      transaction,
      'ready',
      'profile_ready',
      LATER,
    ).transaction;
    const status = presentOnboardingStatus(finished, 'profile_ready');
    expect(status.status).toBe('ready');
    expect(status.step).toBe('activate');
  });

  it('does not report ready before the terminal receipt preimage is committed', () => {
    let transaction = freshTransaction();
    for (const step of ONBOARDING_STEPS) {
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'prepared',
        operationId: `onb-op-${step}`,
        preparedRequestSha256: REQUEST_SHA256,
        now: LATER,
      });
      transaction = transitionOnboardingStep(transaction, step, {
        to: 'succeeded',
        acceptedReceiptSha256: RECEIPT_SHA256,
        now: LATER,
      });
    }
    expect(presentOnboardingStatus(transaction, 'not_finished').status).toBe(
      'retryable',
    );
  });
});
