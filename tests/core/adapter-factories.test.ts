import { describe, expect, it } from 'vitest';
import type {
  AdapterConfigValidation,
  AdapterHealth,
  MeetingSourceAdapter,
} from '../../src/core/index.js';
import {
  createConfiguredAdapterRegistry,
  ProductAdapterFactoryRegistry,
} from '../../src/product/adapter-factories.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';

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
    communication_channels: [
      { adapter_id: 'channel-fixture', instance_id: 'primary', settings: {} },
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
    factories.register({
      kind: 'meeting-source',
      adapter_id: 'meeting-fixture',
      create: (adapterConfig): MeetingSourceAdapter => ({
        identity: {
          kind: 'meeting-source',
          adapter_id: adapterConfig.adapter_id,
          instance_id: adapterConfig.instance_id,
          version: '1',
        },
        validateConfig: valid,
        healthCheck: healthy,
        pull: async () => ({ meetings: [] }),
      }),
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
      kind: 'communication-channel',
      adapter_id: 'channel-fixture',
      create: (adapterConfig) => ({
        identity: {
          kind: 'communication-channel',
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

    const registry = await createConfiguredAdapterRegistry(config(), factories);
    expect(registry.list()).toHaveLength(3);
  });

  it('fails before creating a partial runtime when a factory is absent', async () => {
    await expect(
      createConfiguredAdapterRegistry(config(), new ProductAdapterFactoryRegistry()),
    ).rejects.toThrow(/meeting-source adapter factory 'meeting-fixture' is not installed/);
  });

  it('bundles the llm decision processor in the default composition root', async () => {
    const { createDefaultAdapterFactories } = await import(
      '../../src/product/default-adapters.js'
    );
    const factory = createDefaultAdapterFactories().get('decision-processor', 'llm');
    expect(factory).toBeDefined();
    const adapter = await factory!.create(
      { adapter_id: 'llm', instance_id: 'primary', settings: { model: 'qwen3:4b' } },
      {
        stateDirectory: '/tmp/unused',
        environment: {},
        now: () => '2026-07-17T00:00:00.000Z',
      },
    );
    expect(adapter.identity).toMatchObject({
      kind: 'decision-processor',
      adapter_id: 'llm',
      instance_id: 'primary',
    });
  });
});
