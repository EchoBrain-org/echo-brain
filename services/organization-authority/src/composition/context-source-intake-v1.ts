import type Database from 'better-sqlite3';
import {
  assertContextCaptureEnvelopeV1, canonicalSourceContentV1, CONTEXT_CAPTURE_LIMITS_V1,
  type AdapterOperationContext, type ContextCaptureContentV1, type ContextCaptureEnvelopeV1,
  type SourceAdapterIdentityV1, type SourceAdapterV1, type SourcePullRequestV1,
} from '@echo-brain/organization-processing/core';
import { SqliteContextCaptureStoreV1 } from '../adapters/persistence/sqlite/context-capture-store-v1.js';
import {
  intakeContextBatchV1, selectContextIntakePolicyV1,
  type ContextIntakeAuthorityV1,
} from '../application/context-intake-v1.js';

export interface ContextSourceIntakeV1 {
  /** The caller owns the cursor and advances it only after this call succeeds. */
  pull(request?: SourcePullRequestV1, context?: AdapterOperationContext): Promise<{
    readonly captures: Awaited<ReturnType<typeof intakeContextBatchV1>>;
    readonly next_cursor?: string;
  }>;
}

export interface ContextSourceIntakeOptionsV1 {
  readonly source: SourceAdapterV1<ContextCaptureContentV1>;
  /** Configured by Authority, independently of the adapter's returned data. */
  readonly identity: SourceAdapterIdentityV1;
  readonly organization_id: string;
  readonly authority: ContextIntakeAuthorityV1;
  /** Check the source read grant before fetching and again before admission. */
  readonly require_read_current: (context?: AdapterOperationContext) => void | Promise<void>;
  readonly retention:
    | { readonly disposition: 'retained'; readonly database: Database.Database }
    | { readonly disposition: 'request_only' };
}

function cursor(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > 16 * 1024)) throw new Error('Context source cursor exceeds its bound');
}

/**
 * Opt-in composition for an already configured provider source. It does not
 * register a production source or scheduler. One pull enters the existing
 * shared intake; the retention choice is fixed outside the provider result.
 */
export function createContextSourceIntakeV1(options: ContextSourceIntakeOptionsV1): ContextSourceIntakeV1 {
  const identity = Object.freeze({ ...options.identity });
  const identityJson = canonicalSourceContentV1(identity);
  const organizationId = options.organization_id;
  const source = options.source;
  const selectedAuthority = options.authority;
  const requireReadCurrent = options.require_read_current;
  const disposition = options.retention.disposition;
  if (identity.kind !== 'source' || organizationId.trim() === '' ||
      !['retained', 'request_only'].includes(disposition)) throw new Error('Context source composition is invalid');
  const checkIdentity = (): void => {
    if (canonicalSourceContentV1(source.identity) !== identityJson) throw new Error('Context source differs from the configured adapter');
  };
  checkIdentity();
  const authority: ContextIntakeAuthorityV1 = {
    select(capture) {
      const policy = selectContextIntakePolicyV1(capture, selectedAuthority);
      if (policy.disposition !== disposition || policy.scope.organization_id !== organizationId) {
        throw new Error('Context source retention or organization differs from its configured binding');
      }
      return policy;
    },
    requireCurrent: (capture, policy) => selectedAuthority.requireCurrent(capture, policy),
  };
  // A request-only composition never constructs or receives a storage adapter.
  const store = options.retention.disposition === 'retained'
    ? new SqliteContextCaptureStoreV1(options.retention.database, authority, identity)
    : undefined;
  let pulling = false;
  return Object.freeze({
    async pull(request: SourcePullRequestV1 = {}, context?: AdapterOperationContext) {
      context?.signal.throwIfAborted();
      if (pulling) throw new Error('Context source already has a pull in progress');
      if (request === null || typeof request !== 'object' || Array.isArray(request) ||
          Object.keys(request).some(key => key !== 'cursor' && key !== 'limit')) throw new Error('Context source pull request is invalid');
      cursor(request.cursor);
      const limit = request.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTEXT_CAPTURE_LIMITS_V1.batch) throw new Error('Context source pull limit exceeds its bound');
      const pullRequest = Object.freeze({ limit, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
      pulling = true;
      try {
        checkIdentity();
        await requireReadCurrent(context);
        context?.signal.throwIfAborted();
        checkIdentity();
        const batch = await source.pull(pullRequest, context);
        context?.signal.throwIfAborted();
        checkIdentity();
        if (batch === null || typeof batch !== 'object' || Array.isArray(batch) ||
            Object.keys(batch).some(key => key !== 'sources' && key !== 'next_cursor') ||
            !Array.isArray(batch.sources) || batch.sources.length > limit) throw new Error('Context source returned an invalid batch');
        cursor(batch.next_cursor);
        const nextCursor = batch.next_cursor;
        for (const capture of batch.sources) assertContextCaptureEnvelopeV1(capture, identity);
        // Own returned bytes before an asynchronous grant recheck can yield.
        const sources = JSON.parse(canonicalSourceContentV1(batch.sources)) as ContextCaptureEnvelopeV1[];
        await requireReadCurrent(context);
        context?.signal.throwIfAborted();
        checkIdentity();
        const captures = await intakeContextBatchV1({ identity, sources, authority, ...(store === undefined ? {} : { store }), ...(context === undefined ? {} : { context }) });
        return Object.freeze({ captures, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }) });
      } finally {
        pulling = false;
      }
    },
  });
}
