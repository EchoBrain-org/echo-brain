import { createGranolaMeetingSourceAdapter } from '../adapters/meeting-sources/granola/meeting-source-adapter.js';
import { createStructuredTextDecisionProcessor } from '../adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { createJsonlOutboxCommunicationChannel } from '../adapters/communication-channels/jsonl-outbox/jsonl-outbox-channel.js';
import { ProductAdapterFactoryRegistry } from './adapter-factories.js';

/**
 * Adapters bundled with the standalone package.
 *
 * This is the composition root: concrete implementations may be named here,
 * while `src/core` remains unaware of every tool and protocol.
 */
export function createDefaultAdapterFactories(): ProductAdapterFactoryRegistry {
  const factories = new ProductAdapterFactoryRegistry();
  factories.register({
    kind: 'meeting-source',
    adapter_id: 'granola',
    create: (config, context) =>
      createGranolaMeetingSourceAdapter(config, {
        env: context.environment,
        now: context.now,
      }),
  });
  factories.register({
    kind: 'decision-processor',
    adapter_id: 'structured-text',
    create: (config, context) =>
      createStructuredTextDecisionProcessor(config, { now: context.now }),
  });
  factories.register({
    kind: 'communication-channel',
    adapter_id: 'jsonl-outbox',
    create: (config, context) =>
      createJsonlOutboxCommunicationChannel(config, { now: context.now }),
  });
  return factories;
}
