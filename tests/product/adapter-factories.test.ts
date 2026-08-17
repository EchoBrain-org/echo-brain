import { describe, expect, it } from 'vitest';
import type {
  AdapterConfigValidation,
  AdapterHealth,
  MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import {
  assertConfiguredAdaptersValid,
  createConfiguredAdapterRegistry,
  ProductAdapterFactoryRegistry,
} from '../../src/product/adapter-factories.js';
import { createDefaultAdapterFactories } from '../../src/product/default-adapters.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import type { ApprovalActionAuthorizer } from '../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';

function config(adapterId = 'meeting-fixture') {
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: '/tmp/adapter-factory-test/state',
    meeting_sources: [
      { adapter_id: adapterId, instance_id: 'primary', settings: {} },
    ],
    decision_processor: {
      adapter_id: 'processor-fixture',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [
      { adapter_id: 'delivery-fixture', instance_id: 'primary', settings: {} },
    ],
    approval_mode: 'manual',
  });
}

const valid = (): AdapterConfigValidation => ({ ok: true, errors: [] });
const healthy = async (): Promise<AdapterHealth> => ({
  status: 'healthy',
  checked_at: '2026-07-16T00:00:00.000Z',
});

describe('product adapter factories', () => {
  it('creates configured instances through one shared factory shape', async () => {
    const factories = new ProductAdapterFactoryRegistry();
    const approvalActionAuthorizer: ApprovalActionAuthorizer = {
      authorize: async () => ({ allowed: true, evidence: { test: true } }),
    };
    const afterDecisionResolved = (): void => undefined;
    let observedApprovalActionAuthorizer:
      | ApprovalActionAuthorizer
      | undefined;
    let observedAfterDecisionResolved: (() => void) | undefined;
    factories.register({
      kind: 'meeting-source',
      adapter_id: 'meeting-fixture',
      create: (adapterConfig, context): MeetingSourceAdapter => {
        observedApprovalActionAuthorizer =
          context.approvalActionAuthorizer;
        observedAfterDecisionResolved = context.afterDecisionResolved;
        return {
          identity: {
            kind: 'meeting-source',
            adapter_id: adapterConfig.adapter_id,
            instance_id: adapterConfig.instance_id,
            version: '1',
          },
          validateConfig: valid,
          healthCheck: healthy,
          pull: async () => ({ meetings: [] }),
        };
      },
    });
    factories.register({
      kind: 'decision-processor',
      adapter_id: 'processor-fixture',
      create: (adapterConfig) => ({
        identity: {
          kind: 'decision-processor',
          adapter_id: adapterConfig.adapter_id,
          instance_id: adapterConfig.instance_id,
          version: '1',
        },
        validateConfig: valid,
        healthCheck: healthy,
        extract: async (meeting) => ({
          schema_version: 1,
          meeting_id: meeting.id,
          meeting_revision: meeting.provenance.canonical_revision,
          processor: {
            kind: 'decision-processor',
            adapter_id: adapterConfig.adapter_id,
            instance_id: adapterConfig.instance_id,
            version: '1',
          },
          generated_at: '2026-07-16T00:00:00.000Z',
          signals: [],
        }),
      }),
    });
    factories.register({
      kind: 'delivery-surface',
      adapter_id: 'delivery-fixture',
      create: (adapterConfig) => ({
        identity: {
          kind: 'delivery-surface',
          adapter_id: adapterConfig.adapter_id,
          instance_id: adapterConfig.instance_id,
          version: '1',
        },
        destination: {
          adapter_id: adapterConfig.adapter_id,
          instance_id: adapterConfig.instance_id,
          external_id: 'destination',
        },
        validateConfig: valid,
        healthCheck: healthy,
        publish: async (envelope) => ({
          schema_version: 1,
          envelope_id: envelope.id,
          status: 'delivered',
          external_id: envelope.idempotency_key,
          recorded_at: '2026-07-16T00:00:00.000Z',
          retryable: false,
        }),
      }),
    });

    const registry = await createConfiguredAdapterRegistry(
      config(),
      factories,
      { approvalActionAuthorizer, afterDecisionResolved },
    );
    expect(registry.list()).toHaveLength(3);
    expect(observedApprovalActionAuthorizer).toBe(approvalActionAuthorizer);
    expect(observedAfterDecisionResolved).toBe(afterDecisionResolved);
  });

  it('fails before creating a partial runtime when a factory is absent', async () => {
    await expect(
      createConfiguredAdapterRegistry(
        config(),
        new ProductAdapterFactoryRegistry(),
      ),
    ).rejects.toThrow(
      /meeting-source adapter factory 'meeting-fixture' is not installed/,
    );
  });

  it('proves configured adapters statically, aggregating every rejection', () => {
    const factories = new ProductAdapterFactoryRegistry();
    // `create` is the only path to a credential resolver, `fetch`, and
    // `healthCheck`, so counting it counts all of them.
    let creates = 0;
    const register = (
      kind: 'meeting-source' | 'decision-processor' | 'delivery-surface',
      adapterId: string,
      validateStaticConfig?: () => AdapterConfigValidation,
    ) =>
      factories.register({
        kind,
        adapter_id: adapterId,
        ...(validateStaticConfig === undefined ? {} : { validateStaticConfig }),
        create: () => {
          creates += 1;
          throw new Error('create must not run during the static proof');
        },
      });
    // 'meeting-fixture' is deliberately unregistered for the first pass.
    register('decision-processor', 'processor-fixture', () => ({
      ok: false,
      errors: ['model setting is required'],
    }));
    register('delivery-surface', 'delivery-fixture', () => {
      throw new Error('validator exploded');
    });

    // One pass names the missing factory, the invalid configuration, and the
    // validator that threw.
    expect(() => assertConfiguredAdaptersValid(config(), factories)).toThrow(
      /meeting-source adapter factory 'meeting-fixture' is not installed[\s\S]*model setting is required[\s\S]*validator exploded/,
    );

    // A factory with no static validator fails closed instead of passing.
    register('meeting-source', 'meeting-fixture');
    expect(() => assertConfiguredAdaptersValid(config(), factories)).toThrow(
      /meeting-source 'meeting-fixture\/primary' exposes no static configuration validator/,
    );
    expect(creates).toBe(0);
    // The accepting direction is proven by the bundled validators below and by
    // the operator reconfigure tests, which rewrite a manifest only after this
    // same proof passes.
  });

  it('validates every bundled adapter without constructing it', () => {
    const factories = createDefaultAdapterFactories();
    // A bundled factory without a static validator would fail the proof
    // closed, so the composition root must carry one everywhere.
    expect(
      factories
        .list()
        .every((f) => typeof f.validateStaticConfig === 'function'),
    ).toBe(true);
    // Slack construction normally needs a receipt store, an environment, and a
    // credential resolver; static validation runs with inert stand-ins that
    // throw on any access, so reaching a verdict at all proves none were used.
    const slack = factories.get('delivery-surface', 'slack')!;
    const base = {
      adapter_id: 'slack',
      instance_id: 'team-decisions',
      settings: { channel_id: 'C123' },
    };
    expect(
      slack.validateStaticConfig!({
        ...base,
        credential_ref: 'env:SLACK_BOT_TOKEN',
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(slack.validateStaticConfig!(base).errors).toContain(
      'credential_ref is required',
    );
  });

  it('bundles the llm decision processor in the default composition root', async () => {
    const factory = createDefaultAdapterFactories().get(
      'decision-processor',
      'llm',
    );
    expect(factory).toBeDefined();
    const adapter = await factory!.create(
      {
        adapter_id: 'llm',
        instance_id: 'primary',
        settings: { model: 'qwen3:4b' },
      },
      {
        stateDirectory: '/tmp/unused',
        environment: {},
        credentialResolver: () => undefined,
        now: () => '2026-07-17T00:00:00.000Z',
      },
    );
    expect(adapter.identity).toMatchObject({
      kind: 'decision-processor',
      adapter_id: 'llm',
      instance_id: 'primary',
    });
  });

  it('bundles independent Slack delivery and approval surface factories', async () => {
    const factories = createDefaultAdapterFactories();
    const deliveryFactory = factories.get('delivery-surface', 'slack');
    const approvalFactory = factories.get(
      'approval-surface',
      'slack-reactions',
    );
    expect(deliveryFactory).toBeDefined();
    expect(approvalFactory).toBeDefined();

    const approvalActionAuthorizer: ApprovalActionAuthorizer = {
      authorize: async () => ({ allowed: true, evidence: { test: true } }),
    };
    const context = {
      stateDirectory: '/tmp/adapter-factory-test/state',
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' },
      credentialResolver: () => 'xoxb-test',
      now: () => '2026-07-18T00:00:00.000Z',
      approvalActionAuthorizer,
    };
    const delivery = await deliveryFactory!.create(
      {
        adapter_id: 'slack',
        instance_id: 'team-decisions',
        credential_ref: 'env:SLACK_BOT_TOKEN',
        settings: { channel_id: 'C123' },
      },
      context,
    );
    const approval = await approvalFactory!.create(
      {
        adapter_id: 'slack-reactions',
        instance_id: 'founder-approval',
        credential_ref: 'env:SLACK_BOT_TOKEN',
        settings: {
          channel_id: 'C123',
          reviewer: { slack_user_id: 'U123', name: 'zhenye' },
        },
      },
      context,
    );

    expect(delivery).not.toBe(approval);
    expect(delivery.identity).toMatchObject({
      kind: 'delivery-surface',
      adapter_id: 'slack',
      instance_id: 'team-decisions',
    });
    expect(approval.identity).toMatchObject({
      kind: 'approval-surface',
      adapter_id: 'slack-reactions',
      instance_id: 'founder-approval',
    });
    expect(
      (
        approval as unknown as {
          approvalActionAuthorizer?: ApprovalActionAuthorizer;
        }
      ).approvalActionAuthorizer,
    ).toBe(approvalActionAuthorizer);
  });
});
