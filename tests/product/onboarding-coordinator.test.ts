import { describe, expect, it } from 'vitest';
import {
  runOnboardingFlow,
  type OnboardingStepDefinition,
  type OnboardingTransactionStore,
} from '../../src/product/onboarding/onboarding-coordinator.js';
import {
  ONBOARDING_STEPS,
  deriveOnboardingIdentity,
  type OnboardingReceiptV1,
  type OnboardingStepName,
  type OnboardingTransactionV1,
} from '../../src/product/onboarding/onboarding-transaction.js';

const IDENTITY = deriveOnboardingIdentity({
  authorityId: 'auth_1',
  organizationId: 'org_1',
  membershipId: 'mem_1',
  invitationCommandId: 'adm_1',
  enrollmentGrantSha256: `sha256:${'a'.repeat(64)}`,
});

class MemoryStore implements OnboardingTransactionStore {
  active: OnboardingTransactionV1 | null = null;
  receipts: OnboardingReceiptV1[] = [];
  locked = false;
  failReceiptOnce = false;

  async acquireMutationLock(): Promise<() => Promise<void>> {
    if (this.locked) {
      throw new Error('test onboarding lock is busy');
    }
    this.locked = true;
    return async () => {
      this.locked = false;
    };
  }

  async loadActive(): Promise<OnboardingTransactionV1 | null> {
    return this.active;
  }

  async saveActive(transaction: OnboardingTransactionV1): Promise<void> {
    this.active = transaction;
  }

  async saveReceipt(receipt: OnboardingReceiptV1): Promise<void> {
    if (this.failReceiptOnce) {
      this.failReceiptOnce = false;
      throw new Error('simulated receipt publication failure');
    }
    const existing = this.receipts.find(
      (candidate) => candidate.flow_id === receipt.flow_id,
    );
    if (existing === undefined) this.receipts.push(receipt);
  }
}

interface HarnessOptions {
  overrides?: Partial<
    Record<OnboardingStepName, OnboardingStepDefinition['run']>
  >;
  effects?: Partial<
    Record<OnboardingStepName, readonly (keyof OnboardingTransactionV1['effects'])[]>
  >;
  store?: MemoryStore;
  afterReadyCommit?: Parameters<typeof runOnboardingFlow>[0]['afterReadyCommit'];
  withReadyCommit?: Parameters<typeof runOnboardingFlow>[0]['withReadyCommit'];
  beforeCreate?: Parameters<typeof runOnboardingFlow>[0]['beforeCreate'];
}

function harness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const calls: Array<{ step: OnboardingStepName; operationId: string }> = [];
  let tick =
    store.active === null
      ? 0
      : Math.floor(
          (Date.parse(store.active.updated_at) -
            Date.parse('2026-08-15T12:00:00.000Z')) /
            1_000,
        );
  const steps = {} as Record<OnboardingStepName, OnboardingStepDefinition>;
  for (const step of ONBOARDING_STEPS) {
    const run =
      options.overrides?.[step] ??
      (async () => ({ result: 'succeeded', reasonCode: `${step}_ok` }) as const);
    steps[step] = {
      run: async (context) => {
        calls.push({ step, operationId: context.operationId });
        return await run(context);
      },
      ...(options.effects?.[step] === undefined
        ? {}
        : { effects: options.effects[step] }),
    };
  }
  return {
    store,
    calls,
    steps,
    run: async () =>
      await runOnboardingFlow({
        store,
        steps,
        identity: IDENTITY,
        configPath: '/private/example/config.json',
        stateDirectory: '/private/example/state',
        inputSha256: `sha256:${'b'.repeat(64)}`,
        now: () => {
          tick += 1;
          return `2026-08-15T12:00:${String(tick).padStart(2, '0')}.000Z`;
        },
        nextOperationId: (step) => `op-${step}-${tick}`,
        ...(options.beforeCreate === undefined
          ? {}
          : { beforeCreate: options.beforeCreate }),
        validateResume: async () => null,
        afterReadyCommit:
          options.afterReadyCommit ?? (async () => undefined),
        withReadyCommit:
          options.withReadyCommit ?? (async (commit) => await commit()),
      }),
  };
}

describe('runOnboardingFlow', () => {
  it('runs every step in order once and reports ready with a receipt', async () => {
    const flow = harness();
    const status = await flow.run();
    expect(status.status).toBe('ready');
    expect(flow.calls.map((call) => call.step)).toEqual([...ONBOARDING_STEPS]);
    expect(flow.store.active?.finished_at).not.toBeNull();
    expect(flow.store.receipts).toHaveLength(1);
    expect(flow.store.receipts[0].result).toBe('ready');
  });

  it('resumes an interrupted effect step with the same operation identity', async () => {
    const store = new MemoryStore();
    const crashing = harness({
      store,
      overrides: {
        enroll: async () => {
          throw new Error('simulated crash after the wire call');
        },
      },
      effects: { enroll: ['central_enrollment'] },
    });
    const status = await crashing.run();
    expect(status.status).toBe('retryable');
    const persisted = store.active;
    expect(persisted?.steps.enroll.state).toBe('prepared');
    expect(persisted?.effects.central_enrollment).toBe(true);
    const firstOperationId = persisted?.steps.enroll.operation_id;
    expect(firstOperationId).not.toBeNull();

    const resumed = harness({
      store,
      effects: { enroll: ['central_enrollment'] },
    });
    const resumedStatus = await resumed.run();
    expect(resumedStatus.status).toBe('ready');
    const enrollCalls = resumed.calls.filter((call) => call.step === 'enroll');
    expect(enrollCalls).toHaveLength(1);
    expect(enrollCalls[0].operationId).toBe(firstOperationId);
    const succeededSteps = resumed.calls.map((call) => call.step);
    expect(succeededSteps).not.toContain('classify');
  });

  it('does not re-run steps that already succeeded', async () => {
    const store = new MemoryStore();
    const first = harness({
      store,
      overrides: {
        doctor: async () => ({ result: 'retryable', reasonCode: 'doctor_down' }),
      },
    });
    const firstStatus = await first.run();
    expect(firstStatus.status).toBe('retryable');
    const second = harness({ store });
    await second.run();
    expect(second.calls.map((call) => call.step)).toEqual([
      'doctor',
      'readiness',
      'activate',
    ]);
  });

  it('repairs a terminal transaction whose immutable receipt publication was interrupted', async () => {
    const store = new MemoryStore();
    store.failReceiptOnce = true;
    const first = harness({ store });
    await expect(first.run()).rejects.toThrow(/receipt publication/u);
    expect(store.active?.finished_at).not.toBeNull();
    expect(store.receipts).toHaveLength(0);

    const resumed = harness({ store });
    const status = await resumed.run();
    expect(status.status).toBe('ready');
    expect(resumed.calls).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0].result).toBe('ready');

    const replayed = harness({ store });
    expect((await replayed.run()).status).toBe('ready');
    expect(store.receipts).toHaveLength(1);
  });

  it('refuses a changed target or input under an existing flow identity', async () => {
    const store = new MemoryStore();
    const paused = harness({
      store,
      overrides: {
        doctor: async () => ({ result: 'retryable', reasonCode: 'doctor_down' }),
      },
      effects: {
        stage_local: [
          'local_mutation',
          'provider_connection',
          'central_enrollment',
        ],
      },
    });
    await paused.run();
    const steps = harness({ store });
    await expect(
      runOnboardingFlow({
        store,
        steps: steps.steps,
        identity: IDENTITY,
        configPath: '/private/example/other-config.json',
        stateDirectory: '/private/example/state',
        inputSha256: `sha256:${'b'.repeat(64)}`,
        now: () => '2026-08-15T12:10:00.000Z',
        nextOperationId: (step) => `other-${step}`,
        validateResume: async () => null,
        afterReadyCommit: async () => undefined,
        withReadyCommit: async (commit) => await commit(),
      }),
    ).rejects.toThrow(/exact flow and target/u);
  });

  it('supersedes a changed zero-effect attempt before any external boundary', async () => {
    const store = new MemoryStore();
    const paused = harness({
      store,
      overrides: {
        verify_trust: async () => ({
          result: 'retryable',
          reasonCode: 'trust_check_interrupted',
        }),
      },
    });
    expect((await paused.run()).status).toBe('retryable');
    expect(Object.values(store.active!.effects).every((value) => !value)).toBe(
      true,
    );

    const replacement = harness({ store });
    const status = await runOnboardingFlow({
      store,
      steps: replacement.steps,
      identity: IDENTITY,
      configPath: '/private/example/config.json',
      stateDirectory: '/private/example/state',
      inputSha256: `sha256:${'e'.repeat(64)}`,
      now: () => '2026-08-15T12:10:00.000Z',
      nextOperationId: (step) => `replacement-${step}`,
      validateResume: async () => null,
      afterReadyCommit: async () => undefined,
      withReadyCommit: async (commit) => await commit(),
    });
    expect(status.status).toBe('ready');
    expect(replacement.calls[0]?.step).toBe('classify');
    expect(store.active?.input_sha256).toBe(`sha256:${'e'.repeat(64)}`);
  });

  it('re-proves trust before effects from a seeded zero-effect journal', async () => {
    const store = new MemoryStore();
    const seeded = harness({
      store,
      overrides: {
        verify_trust: async () => ({
          result: 'retryable',
          reasonCode: 'simulated_pre_effect_crash',
        }),
      },
      beforeCreate: async () => null,
    });
    expect((await seeded.run()).status).toBe('retryable');
    expect(Object.values(store.active!.effects).every((value) => !value)).toBe(
      true,
    );

    let stageEntered = false;
    const resumed = harness({
      store,
      effects: {
        stage_local: [
          'local_mutation',
          'provider_connection',
          'central_enrollment',
        ],
      },
      overrides: {
        stage_local: async () => {
          stageEntered = true;
          return { result: 'succeeded', reasonCode: 'must_not_run' };
        },
      },
      beforeCreate: async () => ({
        status: 'denied',
        reasonCode: 'invitation_expired',
        step: 'verify_trust',
      }),
    });
    const status = await resumed.run();
    expect(status).toMatchObject({
      status: 'denied',
      reason_code: 'invitation_expired',
    });
    expect(stageEntered).toBe(false);
    expect(Object.values(store.active!.effects).every((value) => !value)).toBe(
      true,
    );
  });

  it('commits the terminal journal and receipt inside the ready fence before activation', async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    const originalSaveActive = store.saveActive.bind(store);
    store.saveActive = async (transaction) => {
      if (transaction.finished_at !== null) events.push('terminal-active');
      await originalSaveActive(transaction);
    };
    const originalSaveReceipt = store.saveReceipt.bind(store);
    store.saveReceipt = async (receipt) => {
      events.push('receipt');
      await originalSaveReceipt(receipt);
    };
    let activationAttempts = 0;
    const first = harness({
      store,
      withReadyCommit: async (commit) => {
        events.push('fence-enter');
        try {
          return await commit();
        } finally {
          events.push('fence-exit');
        }
      },
      afterReadyCommit: async ({ transaction, operationId }) => {
        activationAttempts += 1;
        events.push('activate');
        expect(store.receipts).toHaveLength(1);
        expect(transaction.finished_at).not.toBeNull();
        expect(operationId).toBe(transaction.steps.activate.operation_id);
        if (activationAttempts === 1) throw new Error('lost activation response');
      },
    });
    expect((await first.run()).status).toBe('retryable');
    const firstOperationId = store.active?.steps.activate.operation_id;
    expect(events.slice(-5)).toEqual([
      'fence-enter',
      'terminal-active',
      'receipt',
      'activate',
      'fence-exit',
    ]);

    events.length = 0;
    const resumed = harness({
      store,
      withReadyCommit: async (commit) => {
        events.push('fence-enter');
        try {
          return await commit();
        } finally {
          events.push('fence-exit');
        }
      },
      afterReadyCommit: async ({ transaction, operationId }) => {
        events.push('activate');
        expect(store.receipts).toHaveLength(1);
        expect(operationId).toBe(firstOperationId);
        expect(transaction.steps.activate.operation_id).toBe(firstOperationId);
      },
    });
    expect((await resumed.run()).status).toBe('ready');
    expect(resumed.calls).toHaveLength(0);
    expect(store.active?.steps.activate.operation_id).toBe(firstOperationId);
    expect(events).toEqual(['receipt', 'fence-enter', 'activate', 'fence-exit']);
  });

  it('admits only one coordinator into the mutation protocol', async () => {
    const store = new MemoryStore();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    const first = harness({
      store,
      overrides: {
        classify: async () => {
          entered();
          await blocked;
          return { result: 'succeeded', reasonCode: 'classify_ok' };
        },
      },
    });
    const firstRun = first.run();
    await started;

    const contender = harness({ store });
    await expect(contender.run()).rejects.toThrow(/lock is busy/u);
    expect(contender.calls).toHaveLength(0);

    continueFirst();
    expect((await firstRun).status).toBe('ready');
    expect(store.receipts).toHaveLength(1);
  });

  it('pauses for the user without consuming a new operation identity on resume', async () => {
    const store = new MemoryStore();
    const paused = harness({
      store,
      overrides: {
        confirm_human: async () => ({
          result: 'waiting_for_user',
          reasonCode: 'consent_required',
        }),
      },
    });
    const pausedStatus = await paused.run();
    expect(pausedStatus.status).toBe('waiting_for_user');
    expect(pausedStatus.step).toBe('confirm_human');
    const pausedOperationId = store.active?.steps.confirm_human.operation_id;

    const resumed = harness({ store });
    const resumedStatus = await resumed.run();
    expect(resumedStatus.status).toBe('ready');
    const confirmCalls = resumed.calls.filter(
      (call) => call.step === 'confirm_human',
    );
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].operationId).toBe(pausedOperationId);
  });

  it('finishes closed on denial and never executes again', async () => {
    const store = new MemoryStore();
    const denied = harness({
      store,
      overrides: {
        verify_trust: async () => ({
          result: 'denied',
          reasonCode: 'pin_mismatch',
        }),
      },
    });
    const deniedStatus = await denied.run();
    expect(deniedStatus.status).toBe('denied');
    expect(store.active?.finished_at).not.toBeNull();
    expect(store.receipts.map((receipt) => receipt.result)).toEqual(['denied']);

    const again = harness({ store });
    const againStatus = await again.run();
    expect(againStatus.status).toBe('denied');
    expect(again.calls).toHaveLength(0);
    expect(store.receipts).toHaveLength(1);
  });

  it('preserves ambiguous installations closed', async () => {
    const store = new MemoryStore();
    const preserved = harness({
      store,
      overrides: {
        classify: async () => ({
          result: 'preserved',
          reasonCode: 'ambiguous_installation',
        }),
      },
    });
    const status = await preserved.run();
    expect(status.status).toBe('preserved');
    expect(store.receipts.map((receipt) => receipt.result)).toEqual([
      'preserved',
    ]);
  });
});
