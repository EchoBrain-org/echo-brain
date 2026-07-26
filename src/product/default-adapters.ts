import { createGranolaMeetingSourceAdapter } from '../adapters/meeting-sources/granola/meeting-source-adapter.js';
import { createLlmDecisionProcessor } from '../adapters/decision-processors/llm/llm-decision-processor.js';
import { createStructuredTextDecisionProcessor } from '../adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { createJsonlOutboxDeliverySurface } from '../adapters/delivery-surfaces/jsonl-outbox/jsonl-outbox-delivery-surface.js';
import { createSlackDeliverySurface } from '../adapters/delivery-surfaces/slack/slack-delivery-surface.js';
import { FileSlackDeliveryReceiptStore } from '../adapters/delivery-surfaces/slack/slack-delivery-receipt-store.js';
import { createSlackReactionsApprovalSurface } from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { DecisionNodeStore } from './approval/decision-node-store.js';
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
        credentialResolver: context.credentialResolver,
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
    kind: 'decision-processor',
    adapter_id: 'llm',
    create: (config, context) =>
      createLlmDecisionProcessor(config, {
        credentialResolver: context.credentialResolver,
        now: context.now,
      }),
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: 'jsonl-outbox',
    create: (config, context) =>
      createJsonlOutboxDeliverySurface(config, { now: context.now }),
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: 'slack',
    create: (config, context) =>
      createSlackDeliverySurface(config, {
        receiptStore: new FileSlackDeliveryReceiptStore(
          context.stateDirectory,
          config.instance_id,
        ),
        environment: context.environment,
        credentialResolver: context.credentialResolver,
        now: context.now,
      }),
  });
  factories.register({
    kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    create: (config, context) =>
      createSlackReactionsApprovalSurface(config, {
        // The surface resolves against the same shared decision node store
        // as the CLI; the composition root owns that store choice.
        store: new DecisionNodeStore(context.stateDirectory, {
          now: context.now,
          ...(context.approvalFederationCapture === undefined
            ? {}
            : { federationCapture: context.approvalFederationCapture }),
        }),
        environment: context.environment,
        credentialResolver: context.credentialResolver,
        now: context.now,
      }),
  });
  return factories;
}
