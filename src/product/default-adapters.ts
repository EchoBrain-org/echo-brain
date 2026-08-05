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
 * Stand-in for a runtime dependency that static validation must never touch.
 * Every property access throws, so an adapter that reached for a credential,
 * a state store, or a provider while validating its own configuration would
 * fail loudly here instead of quietly touching the machine.
 */
function inert<T>(dependency: string): T {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error(`static adapter validation must not use ${dependency}`);
      },
    },
  ) as unknown as T;
}

/** Empty rather than `process.env`: static validation reads no environment. */
const INERT_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({});

const inertCredentialResolver = (): never => {
  throw new Error('static adapter validation must not resolve credentials');
};

/**
 * Adapters bundled with the standalone package.
 *
 * This is the composition root: concrete implementations may be named here,
 * while `src/core` remains unaware of every tool and protocol.
 *
 * Each factory's `validateStaticConfig` reuses its adapter's own
 * `validateConfig` through an inert construction: the adapter is built with
 * stand-in dependencies that throw on any access, so the rules stay in one
 * place while the static proof stays provably offline.
 */
export function createDefaultAdapterFactories(): ProductAdapterFactoryRegistry {
  const factories = new ProductAdapterFactoryRegistry();
  factories.register({
    kind: 'meeting-source',
    adapter_id: 'granola',
    // No `client` stand-in: the adapter requires `credential_ref` only when it
    // was not handed a client, and this proof must enforce that requirement.
    validateStaticConfig: (config) =>
      createGranolaMeetingSourceAdapter(config, {
        credentialResolver: inertCredentialResolver,
      }).validateConfig(config),
    create: (config, context) =>
      createGranolaMeetingSourceAdapter(config, {
        credentialResolver: context.credentialResolver,
        now: context.now,
      }),
  });
  factories.register({
    kind: 'decision-processor',
    adapter_id: 'structured-text',
    validateStaticConfig: (config) =>
      createStructuredTextDecisionProcessor(config).validateConfig(config),
    create: (config, context) =>
      createStructuredTextDecisionProcessor(config, { now: context.now }),
  });
  factories.register({
    kind: 'decision-processor',
    adapter_id: 'llm',
    // The stand-in client keeps the constructor from building a provider
    // client; `validateConfig` reads only the configuration.
    validateStaticConfig: (config) =>
      createLlmDecisionProcessor(config, {
        client: inert('an LLM provider client'),
      }).validateConfig(config),
    create: (config, context) =>
      createLlmDecisionProcessor(config, {
        credentialResolver: context.credentialResolver,
        now: context.now,
      }),
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: 'jsonl-outbox',
    validateStaticConfig: (config) =>
      createJsonlOutboxDeliverySurface(config).validateConfig(config),
    create: (config, context) =>
      createJsonlOutboxDeliverySurface(config, { now: context.now }),
  });
  factories.register({
    kind: 'delivery-surface',
    adapter_id: 'slack',
    validateStaticConfig: (config) =>
      createSlackDeliverySurface(config, {
        receiptStore: inert('a delivery receipt store'),
        environment: INERT_ENVIRONMENT,
        credentialResolver: inertCredentialResolver,
      }).validateConfig(config),
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
    validateStaticConfig: (config) =>
      createSlackReactionsApprovalSurface(config, {
        store: inert('the decision node store'),
        environment: INERT_ENVIRONMENT,
        credentialResolver: inertCredentialResolver,
      }).validateConfig(config),
    create: (config, context) =>
      createSlackReactionsApprovalSurface(config, {
        // The surface resolves against the same shared decision node store
        // as the CLI; the composition root owns that store choice.
        store: new DecisionNodeStore(context.stateDirectory, {
          now: context.now,
        }),
        environment: context.environment,
        credentialResolver: context.credentialResolver,
        now: context.now,
        ...(context.approvalActionAuthorizer === undefined
          ? {}
          : {
              approvalActionAuthorizer: context.approvalActionAuthorizer,
            }),
      }),
  });
  return factories;
}
