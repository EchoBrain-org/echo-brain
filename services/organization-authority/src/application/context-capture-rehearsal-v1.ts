import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  assertContextCaptureEnvelopeV1,
  type AdapterOperationContext,
  type ContextCaptureEnvelopeV1,
  type SourcePullRequestV1,
} from '@echo-brain/organization-processing/core';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FAILURE = 'Context capture rehearsal failed';
const CANCELLED = 'Context capture rehearsal was cancelled';

/**
 * The minimal result shape of an already-authorized intake. This structural
 * port deliberately avoids importing composition: its trusted caller selects
 * the provider, current-read fence and retention policy before rehearsal.
 *
 * The upstream intake must enforce source batch bounds, authorization before
 * admission, and its own transaction fence. This wrapper validates only the
 * returned observation and cannot undo an admission that already occurred.
 */
export interface ContextCaptureRehearsalPullPortV1 {
  pull(
    request?: SourcePullRequestV1,
    context?: AdapterOperationContext,
  ): Promise<{
    readonly captures: readonly ContextCaptureRehearsalCaptureV1[];
    /** A provider cursor is deliberately never included in a rehearsal receipt. */
    readonly next_cursor?: string;
  }>;
}

export interface ContextCaptureRehearsalCaptureV1 {
  readonly source: ContextCaptureEnvelopeV1;
  readonly admission: 'admitted' | 'duplicate' | 'request_only';
}

export interface ContextCaptureRehearsalReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-context-capture-rehearsal-receipt-v1';
  /** Commitment to the configured adapter identity, never its raw instance ID. */
  readonly source_identity_sha256: `sha256:${string}`;
  readonly captures: readonly {
    readonly source_type: ContextCaptureEnvelopeV1['content']['source_type'];
    readonly admission: ContextCaptureRehearsalCaptureV1['admission'];
    readonly source_id_sha256: `sha256:${string}`;
    /** A source revision can be an opaque provider string, so only its digest leaves rehearsal. */
    readonly revision_id_sha256: `sha256:${string}`;
    readonly content_sha256: string;
  }[];
  readonly counts: {
    readonly captured: number;
    readonly admitted: number;
    readonly duplicate: number;
    readonly request_only: number;
  };
}

export interface ContextCaptureRehearsalInputV1 {
  /** Already composed with its provider, current-read authorization and retention policy. */
  readonly intake: ContextCaptureRehearsalPullPortV1;
  /** Caller-derived commitment to its configured source identity. */
  readonly expected_source_identity_sha256: `sha256:${string}`;
  /** A deliberately small, one-page observation bound. */
  readonly limit: number;
  /** Opaque provider cursor accepted only as pull input, never included in output. */
  readonly cursor?: string;
  /** An optional host cancellation signal, combined with the required deadline. */
  readonly signal?: AbortSignal;
  /** Cooperative per-rehearsal deadline, not a hard wall-clock interruption. */
  readonly timeout_ms: number;
}

function inputError(message: string): Error { return new Error(message); }
function failure(): Error { return new Error(FAILURE); }
function cancelled(): DOMException { return new DOMException(CANCELLED, 'AbortError'); }

function assertInput(input: ContextCaptureRehearsalInputV1): void {
  if (input === null || typeof input !== 'object' || typeof input.intake?.pull !== 'function') {
    throw inputError('Context capture rehearsal intake is invalid');
  }
  if (typeof input.expected_source_identity_sha256 !== 'string' || !SHA256.test(input.expected_source_identity_sha256)) {
    throw inputError('Context capture rehearsal source identity digest is invalid');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5) {
    throw inputError('Context capture rehearsal limit must be from 1 to 5');
  }
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length === 0 || Buffer.byteLength(input.cursor, 'utf8') > 16 * 1024)) {
    throw inputError('Context capture rehearsal cursor exceeds its bound');
  }
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 30_000) {
    throw inputError('Context capture rehearsal deadline must be from 1 to 30000 milliseconds');
  }
}

/**
 * Runs exactly one bounded source pull for local qualification. It neither
 * constructs a provider nor grants reads/retention. Deadline enforcement is
 * cooperative through the signal passed to the trusted upstream intake.
 *
 * The receipt is safe for human-visible qualification logs: no capture bytes,
 * labels, provider identifiers, cursors, links, participants or credentials
 * can leave this application boundary.
 */
export async function runContextCaptureRehearsalV1(
  input: ContextCaptureRehearsalInputV1,
): Promise<ContextCaptureRehearsalReceiptV1> {
  assertInput(input);
  if (input.signal?.aborted) throw cancelled();
  const deadline = AbortSignal.timeout(input.timeout_ms);
  const signal = input.signal === undefined
    ? deadline
    : AbortSignal.any([input.signal, deadline]);
  if (signal.aborted) throw cancelled();
  try {
    const result = await input.intake.pull(
      Object.freeze({ limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }),
      Object.freeze({ signal }),
    );
    if (signal.aborted) throw cancelled();
    if (result === null || typeof result !== 'object' || !Array.isArray(result.captures) ||
        result.captures.length > input.limit) {
      throw failure();
    }

    const captures = result.captures.map((capture) => {
      if (capture === null || typeof capture !== 'object' ||
          !['admitted', 'duplicate', 'request_only'].includes(capture.admission)) {
        throw failure();
      }
      const source = capture.source;
      if (source === null || typeof source !== 'object' || source.item?.adapter === undefined) {
        throw failure();
      }
      assertContextCaptureEnvelopeV1(source, source.item.adapter);
      if (canonicalSha256(source.item.adapter) !== input.expected_source_identity_sha256) throw failure();
      return Object.freeze({
        source_type: source.content.source_type,
        admission: capture.admission,
        source_id_sha256: canonicalSha256(source.item.source_id),
        revision_id_sha256: canonicalSha256(source.revision.revision_id),
        content_sha256: source.revision.content_sha256,
      });
    });
    const counts = {
      captured: captures.length,
      admitted: captures.filter(capture => capture.admission === 'admitted').length,
      duplicate: captures.filter(capture => capture.admission === 'duplicate').length,
      request_only: captures.filter(capture => capture.admission === 'request_only').length,
    };
    return Object.freeze({
      schema_version: 1,
      kind: 'echo-context-capture-rehearsal-receipt-v1',
      source_identity_sha256: input.expected_source_identity_sha256,
      captures: Object.freeze(captures),
      counts: Object.freeze(counts),
    });
  } catch (_error) {
    if (signal.aborted) throw cancelled();
    // Provider and validation errors can contain source bytes. Do not let them
    // cross the printable rehearsal boundary.
    throw failure();
  }
}
