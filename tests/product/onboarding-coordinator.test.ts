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

  async loadActive(): Promise<OnboardingTransactionV1 | null> {
    return this.active;
  }

  async saveActive(transaction: OnboardingTransactionV1): Promise<void> {
    this.active = transaction;
  }

  async saveReceipt(receipt: OnboardingReceiptV1): Promise<void> {
    this.receipts.push(receipt);
  }
}

interface HarnessOptions {
  overrides?: Partial<
    Record<OnboardingStepName, OnboardingStepDefinition['run']>
  >;
  effects?: Partial<Record<OnboardingStepName, OnboardingStepDefinition['effect']>>;
  store?: MemoryStore;
}

function harness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const calls: Array<{ step: OnboardingStepName; operationId: string }> = [];
  let tick = 0;
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
        : { effect: options.effects[step] }),
    };
    }
  return {
    store,
    calls,
    run: async () =>
      await runOnboardingFlow({
        store,
        steps,
        identity: IDENTITY,
        configPath: '/private/example/config.json',
        stateDirectory: '/private/example/state',
        now: () => {
          tick += 1;
          return `2026-08-15T12:00:${String(tick).padStart(2, '0')}.000Z`;
        },
        nextOperationId: (step) => `op-${step}-${tick}`,
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
      effects: { enroll: 'central_enrollment' },
    });
    const status = await crashing.run();
    expect(status.status).toBe('retryable');
    const persisted = store.active;
    expect(persisted?.steps.enroll.state).toBe('prepared');
    expect(persisted?.effects.central_enrollment).toBe(true);
    const firstOperationId = persisted?.steps.enroll.operation_id;
    expect(firstOperationId).not.toBeNull();

    const resumed = harness({ store, effects: { enroll: 'central_enrollment' } });
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
