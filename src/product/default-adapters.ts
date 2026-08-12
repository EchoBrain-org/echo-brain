import { createGranolaMeetingSourceAdapter } from '../adapters/meeting-sources/granola/meeting-source-adapter.js';
import { createLlmDecisionProcessor } from '../adapters/decision-processors/llm/llm-decision-processor.js';
import { createStructuredTextDecisionProcessor } from '../adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { createJsonlOutboxDeliverySurface } from '../adapters/delivery-surfaces/jsonl-outbox/jsonl-outbox-delivery-surface.js';
import { createSlackDeliverySurface } from '../adapters/delivery-surfaces/slack/slack-delivery-surface.js';
import { FileSlackDeliveryReceiptStore } from '../adapters/delivery-surfaces/slack/slack-delivery-receipt-store.js';
import { createSlackReactionsApprovalSurface } from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type {
  ApprovalActionAuthorizer,
  ApprovalDecisionStore,
  ReviewerApprovalActionAuthorizer,
  ReviewerApprovalPresentationRenderer,
} from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { AdapterConfig } from '../core/index.js';
import { SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION } from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { DecisionNodeStore } from './approval/decision-node-store.js';
import {
  assertReviewerDisplayName,
  validateReviewerAuthorizationEvidence,
} from './approval/reviewer-authorization-evidence.js';
import { assertReviewerPublicationPreflight } from './approval/reviewer-publication-preflight.js';
import type { ReviewerPublicationMode } from './approval/reviewer-publication-preflight.js';
import {
  ProductAdapterFactoryRegistry,
  type ProductAdapterFactoryContext,
} from './adapter-factories.js';

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

/**
 * Wraps the decision node store so a terminal local resolution immediately
 * offers organization ingest a chance to run.
 *
 * The hook fires only after `resolve` has durably returned, and a hook failure
 * is swallowed: the human act is already recorded locally, and the per-cycle
 * sweep is the durable path. This is the design's "best-effort
 * post-resolve hook" and nothing more — no queue, no daemon, no retry here.
 */
export function notifyOnResolve(
  store: ApprovalDecisionStore,
  afterDecisionResolved: (() => void) | undefined,
): ApprovalDecisionStore {
  if (afterDecisionResolved === undefined) return store;
  // The optional reviewer members must survive this wrapper. Dropping them
  // silently disables reviewer mode wherever a post-resolve hook is wired --
  // which is every production composition -- because the surface then sees a
  // store that cannot freeze a publication contract. Each delegate closes over
  // `store`, so the receiver stays the original object.
  const freeze = store.freezeApprovalPresentationContract;
  const read = store.readApprovalPresentationContract;
  return {
    ensureRequested: (request) => store.ensureRequested(request),
    recordPublished: (input) => store.recordPublished(input),
    ...(freeze === undefined
      ? {}
      : {
          freezeApprovalPresentationContract: (
            input: Parameters<typeof freeze>[0],
          ) => freeze.call(store, input),
        }),
    ...(read === undefined
      ? {}
      : {
          readApprovalPresentationContract: (approvalId: string) =>
            read.call(store, approvalId),
        }),
    resolve: async (input) => {
      const resolved = await store.resolve(input);
      try {
        afterDecisionResolved();
      } catch {}
      return resolved;
    },
  };
}

const inertCredentialResolver = (): never => {
  throw new Error('static adapter validation must not resolve credentials');
};

function settingString(
  settings: Record<string, unknown>,
  key: string,
): string {
  const value = settings[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Runs the local reviewer preflight for one configured Slack approval surface.
 *
 * It is deliberately here, in the composition root, rather than inside the
 * adapter: the refusal must happen before any surface can render, post, poll,
 * or authorize, and it needs the state directory and credential resolver the
 * factory context owns.
 */
function assertSlackReviewerPublicationPreflight(
  config: AdapterConfig,
  context: ProductAdapterFactoryContext,
  store: DecisionNodeStore,
): void {
  const settings = config.settings as Record<string, unknown>;
  const declared = settings['presentation_mode'];
  const mode: ReviewerPublicationMode =
    declared === 'restricted-reviewer-v1'
      ? 'restricted-reviewer-v1'
      : declared === 'pilot-member-readable-v1'
        ? 'pilot-member-readable-v1'
        : 'ordinary-v1';
  const unresolved = store.listUnresolvedApprovalPresentationContracts();
  // Nothing frozen and nothing to enable: the landed path is untouched.
  if (mode !== 'restricted-reviewer-v1' && unresolved.every(
    (slot) => slot.contract === null,
  )) {
    return;
  }
  const reviewer = (
    typeof settings['reviewer'] === 'object' && settings['reviewer'] !== null
      ? settings['reviewer']
      : {}
  ) as Record<string, unknown>;
  const credentialRef = config.credential_ref ?? '';
  let fingerprint: string | null = null;
  try {
    const token =
      credentialRef === '' ? undefined : context.credentialResolver(credentialRef);
    fingerprint =
      typeof token === 'string' && token.length > 0
        ? (context.reviewerPresentationRenderer?.credentialFingerprint(token) ??
          null)
        : null;
  } catch {
    // An unresolvable credential cannot prove the value did not rotate.
    fingerprint = null;
  }
  assertReviewerPublicationPreflight(
    {
      mode,
      adapter_id: config.adapter_id,
      adapter_instance_id: config.instance_id,
      adapter_version: SLACK_REACTIONS_APPROVAL_SURFACE_ADAPTER_VERSION,
      channel_id: settingString(settings, 'channel_id'),
      reviewer_slack_user_id: settingString(reviewer, 'slack_user_id'),
      reviewer_name: settingString(reviewer, 'name'),
      credential_ref: credentialRef,
      credential_fingerprint_sha256: fingerprint,
      approve_reaction:
        settings['approve_reaction'] === undefined
          ? 'white_check_mark'
          : settingString(settings, 'approve_reaction'),
      reject_reaction:
        settings['reject_reaction'] === undefined
          ? 'x'
          : settingString(settings, 'reject_reaction'),
      permission_pilot_presentation_enabled:
        settings['permission_pilot_presentation'] !== undefined,
    },
    unresolved,
  );
}

function staticValidationRefusal(dependency: string): never {
  throw new Error(`static adapter validation must not use ${dependency}`);
}

/**
 * Present-but-refusing stand-ins. `validateConfig` asks whether the reviewer
 * ports exist; answering that question must not require a state directory, a
 * credential, or a provider.
 */
function staticValidationDecisionStore(): ApprovalDecisionStore {
  return {
    ensureRequested: () => staticValidationRefusal('the decision node store'),
    recordPublished: () => staticValidationRefusal('the decision node store'),
    resolve: () => staticValidationRefusal('the decision node store'),
    freezeApprovalPresentationContract: () =>
      staticValidationRefusal('the decision node store'),
    readApprovalPresentationContract: () =>
      staticValidationRefusal('the decision node store'),
  };
}

const inertApprovalActionAuthorizer: ApprovalActionAuthorizer = {
  authorize: () => staticValidationRefusal('the approval action authorizer'),
};

const inertReviewerApprovalActionAuthorizer: ReviewerApprovalActionAuthorizer = {
  authorizeReviewerApproval: () =>
    staticValidationRefusal('the reviewer approval authorizer'),
};

const inertReviewerPresentationRenderer: ReviewerApprovalPresentationRenderer = {
  render: () => staticValidationRefusal('the reviewer presentation renderer'),
  credentialFingerprint: () =>
    staticValidationRefusal('the reviewer presentation renderer'),
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
        // Static validation judges configuration, never composition, so the
        // reviewer ports are present but refuse every call.
        store: staticValidationDecisionStore(),
        approvalActionAuthorizer: inertApprovalActionAuthorizer,
        reviewerApprovalActionAuthorizer: inertReviewerApprovalActionAuthorizer,
        reviewerAuthorizationEvidenceValidator:
          validateReviewerAuthorizationEvidence,
        reviewerDisplayNameValidator: assertReviewerDisplayName,
        reviewerPresentationRenderer: inertReviewerPresentationRenderer,
        environment: INERT_ENVIRONMENT,
        credentialResolver: inertCredentialResolver,
      }).validateConfig(config),
    create: (config, context) => {
      const store = new DecisionNodeStore(context.stateDirectory, {
        now: context.now,
      });
      // The local lifecycle preflight runs before the surface exists, so an
      // unresolved card published under another mode, or an in-place rotation
      // of anything a frozen card pinned, refuses this start instead of being
      // reinterpreted at action time.
      assertSlackReviewerPublicationPreflight(config, context, store);
      return createSlackReactionsApprovalSurface(config, {
        // The surface resolves against the same shared decision node store
        // as the CLI; the composition root owns that store choice.
        store: notifyOnResolve(store, context.afterDecisionResolved),
        environment: context.environment,
        credentialResolver: context.credentialResolver,
        now: context.now,
        reviewerAuthorizationEvidenceValidator:
          validateReviewerAuthorizationEvidence,
        reviewerDisplayNameValidator: assertReviewerDisplayName,
        ...(context.approvalActionAuthorizer === undefined
          ? {}
          : {
              approvalActionAuthorizer: context.approvalActionAuthorizer,
            }),
        ...(context.reviewerApprovalActionAuthorizer === undefined
          ? {}
          : {
              reviewerApprovalActionAuthorizer:
                context.reviewerApprovalActionAuthorizer,
            }),
        ...(context.reviewerPresentationRenderer === undefined
          ? {}
          : {
              reviewerPresentationRenderer:
                context.reviewerPresentationRenderer,
            }),
      });
    },
  });
  return factories;
}
