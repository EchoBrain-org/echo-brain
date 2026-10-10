import { randomUUID } from 'node:crypto';
import type {
  PersonDiagnosticPrepareRequestV1,
  PersonDiagnosticReadResponseV1,
} from '@echo-brain/organization-api';
import { validatePersonDiagnosticCaptureIdV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonDiagnosticsHttpApplicationV1 } from '../presentation/person-diagnostics-http-application.js';
import { createPersonDiagnosticTraceV1, type PersonDiagnosticTraceCollectorV1 } from './person-diagnostic-trace-v1.js';

export const PERSON_DIAGNOSTICS_RESULT_TTL_MS_V1 = 15 * 60_000;
export const PERSON_DIAGNOSTICS_REREAD_MS_V1 = 60_000;
const PURGE_INTERVAL_MS = 60_000;
type Actor = Pick<PersonAccessAuthorization, 'organization_id' | 'principal_id' | 'membership_id'>;
type Target = PersonDiagnosticPrepareRequestV1['target'];
type CaptureError = NonNullable<PersonDiagnosticReadResponseV1['error']>;
type Fence = (signal?: AbortSignal) => Promise<unknown>;

export interface PersonDiagnosticCaptureHandleV1 {
  /** Suitable for the selected core diagnostic sink. Never throws into the observed operation. */
  record(event: Readonly<Record<string, unknown>>): void;
  /** The request's existing source-access fence, not a credential or serialized token. */
  bindFence(fence: Fence): void;
  complete(): void;
  fail(error: unknown): void;
}

export interface CreatePersonDiagnosticsOptionsV1 {
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): Actor };
  readonly now?: () => number;
  readonly limits?: {
    /** Each entry independently retains at most 8 MiB; eight entries bound retained bytes to 64 MiB. */
    readonly max_captures?: number;
    readonly max_captures_per_actor?: number;
    readonly ttl_ms?: number;
    readonly reread_ms?: number;
  };
}

export interface PersonDiagnosticsV1 extends PersonDiagnosticsHttpApplicationV1 {
  /** Claim before model or source work. Reuse, mismatched targets, and foreign actors fail closed. */
  claim(input: { readonly access_token: string; readonly capture_id: string; readonly target: Target }): PersonDiagnosticCaptureHandleV1;
  /** Only the trusted meeting worker can claim a prepared selection. Never queues work or grants a retry. */
  claimMeeting(input: { readonly actor: Actor; readonly target: Extract<Target, { kind: 'meeting_extraction' }>; readonly fence: Fence }): PersonDiagnosticCaptureHandleV1 | undefined;
}

interface Capture {
  readonly owner: string;
  readonly target: Target;
  readonly collector: PersonDiagnosticTraceCollectorV1;
  status: 'prepared' | 'running' | 'completed' | 'failed';
  expires_at: number;
  fence?: Fence;
  error?: CaptureError;
  erased: boolean;
}

const FAILURE_MESSAGES = Object.freeze({
  conflict: 'The captured operation conflicted with another operation',
  invalid_request: 'The captured operation request was invalid',
  invalid_output: 'The captured operation received invalid output',
  not_found: 'The captured operation could not find its evidence',
  stale_access_state: 'Access changed while the captured operation was running',
  unauthorized: 'The captured operation is not permitted for this evidence',
  rate_limited: 'A source rate limited the captured operation',
  quota_exceeded: 'A source quota stopped the captured operation',
  unavailable: 'The captured operation could not be completed',
  timed_out: 'The captured operation reached its deadline',
});

function failure(error: unknown): CaptureError {
  const code = error instanceof AgenticAskDeadlineErrorV1 ? 'timed_out'
    : error instanceof AuthorityOperationError && Object.hasOwn(FAILURE_MESSAGES, error.code) ? error.code as keyof typeof FAILURE_MESSAGES : 'unavailable';
  return Object.freeze({ code, message: FAILURE_MESSAGES[code] });
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Diagnostic ${label} must be a positive integer`);
  return value;
}

/**
 * Actor-bound, one-use capture selection for real product operations. Payloads
 * remain only in this process; CloudWatch is the independent durable metadata
 * projection. Expiry or restart means the exact capture is unavailable.
 */
export function createPersonDiagnosticsV1(options: CreatePersonDiagnosticsOptionsV1): PersonDiagnosticsV1 {
  const now = options.now ?? Date.now;
  const maximum = positive(options.limits?.max_captures ?? 8, 'global capacity');
  const perActor = positive(options.limits?.max_captures_per_actor ?? 2, 'actor capacity');
  const ttl = positive(options.limits?.ttl_ms ?? PERSON_DIAGNOSTICS_RESULT_TTL_MS_V1, 'expiry');
  const reread = positive(options.limits?.reread_ms ?? PERSON_DIAGNOSTICS_REREAD_MS_V1, 'reread expiry');
  const captures = new Map<string, Capture>();
  let closed = false;
  const ownerOf = (actor: Actor) => `${actor.organization_id}\u0000${actor.principal_id}\u0000${actor.membership_id}`;
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw new AuthorityOperationError('unavailable', 'Diagnostic clock is unavailable');
    return value;
  };
  const erase = (capture: Capture) => { capture.collector.close(); capture.erased = true; delete capture.fence; };
  const remove = (id: string, capture: Capture) => { erase(capture); captures.delete(id); };
  const purge = () => {
    const current = timestamp();
    for (const [id, capture] of captures) if (capture.expires_at <= current) remove(id, capture);
  };
  const sweeper = setInterval(() => { try { purge(); } catch { /* Observation cleanup cannot crash the service. */ } }, PURGE_INTERVAL_MS);
  sweeper.unref?.();
  const authenticate = (token: string) => {
    const actor = options.sessions.authenticateAccess({ access_token: token });
    if (closed) throw new AuthorityOperationError('unavailable', 'Diagnostic capture is unavailable');
    purge();
    return ownerOf(actor);
  };
  const find = (owner: string, id: string) => {
    const capture = captures.get(id);
    if (capture === undefined || capture.owner !== owner) throw new AuthorityOperationError('not_found', 'Diagnostic capture is unavailable');
    return capture;
  };
  const active = (id: string, capture: Capture) => !closed && captures.get(id) === capture && capture.expires_at > timestamp();
  // A faulty diagnostic clock or observer is never allowed to change product outcomes.
  const observe = (id: string, capture: Capture, action: () => void) => {
    try { if (active(id, capture)) action(); else if (captures.get(id) === capture) remove(id, capture); }
    catch { if (captures.get(id) === capture) remove(id, capture); }
  };

  const matches = (left: Target, right: Target) => left.kind === right.kind &&
    (left.kind === 'ask' || (left.kind === 'trigger_run' && right.kind === 'trigger_run' && left.run_id === right.run_id) ||
      (left.kind === 'meeting_extraction' && right.kind === 'meeting_extraction' && left.source_key === right.source_key && left.meeting_id === right.meeting_id));
  const startCapture = (id: string, capture: Capture): PersonDiagnosticCaptureHandleV1 => {
    capture.status = 'running';
    capture.expires_at = timestamp() + ttl;
    const settle = (error?: unknown) => observe(id, capture, () => {
      if (capture.status !== 'running') return;
      capture.status = error === undefined ? 'completed' : 'failed';
      if (error !== undefined) capture.error = failure(error);
      if (capture.error?.code === 'unauthorized' || capture.error?.code === 'stale_access_state') erase(capture);
      capture.collector.seal();
      capture.expires_at = timestamp() + ttl;
    });
    return Object.freeze<PersonDiagnosticCaptureHandleV1>({
      record(event) { observe(id, capture, () => { if (capture.status === 'running') capture.collector.record(event); }); },
      bindFence(fence) { observe(id, capture, () => { if (capture.status === 'running') capture.fence = fence; }); },
      complete() { settle(); },
      fail(error) { settle(error ?? new Error('Captured operation failed')); },
    });
  };

  return Object.freeze({
    async prepare(input) {
      input.signal?.throwIfAborted();
      const owner = authenticate(input.access_token);
      if (captures.size >= maximum || [...captures.values()].filter(capture => capture.owner === owner).length >= perActor) {
        throw new AuthorityOperationError('quota_exceeded', 'Diagnostic capture capacity is full');
      }
      const id = validatePersonDiagnosticCaptureIdV1(`cap_${randomUUID()}`);
      const expires = timestamp() + ttl;
      const target: Target = Object.freeze({ ...input.request.target });
      if (target.kind === 'meeting_extraction' && [...captures.values()].some(capture => capture.owner === owner &&
          (capture.status === 'prepared' || capture.status === 'running') && matches(capture.target, target))) {
        throw new AuthorityOperationError('conflict', 'An extraction capture is already selected for this meeting');
      }
      captures.set(id, { owner, target, collector: createPersonDiagnosticTraceV1(now), status: 'prepared', expires_at: expires, erased: false });
      return Object.freeze({ schema_version: 1 as const, kind: 'echo-person-diagnostic-capture-v1' as const, capture_id: id, status: 'prepared' as const, expires_at: new Date(expires).toISOString() });
    },
    claim(input) {
      const owner = authenticate(input.access_token);
      const capture = find(owner, input.capture_id);
      const target = input.target;
      if (!matches(capture.target, target)) {
        throw new AuthorityOperationError('invalid_request', 'Diagnostic capture target does not match');
      }
      if (capture.status !== 'prepared') throw new AuthorityOperationError('conflict', 'Diagnostic capture was already claimed');
      return startCapture(input.capture_id, capture);
    },
    claimMeeting(input) {
      // Diagnostic selection cannot fail or change an ordinary extraction.
      try {
        if (closed) return undefined;
        purge();
        const owner = ownerOf(input.actor);
        const selected = [...captures.entries()].find(([, capture]) => capture.owner === owner && capture.status === 'prepared' && matches(capture.target, input.target));
        if (selected === undefined) return undefined;
        const handle = startCapture(...selected);
        handle.bindFence(input.fence);
        return handle;
      } catch { return undefined; }
    },
    async read(input) {
      input.signal?.throwIfAborted();
      const owner = authenticate(input.access_token);
      const id = input.request.capture_id;
      const capture = find(owner, id);
      const base = () => ({ schema_version: 1 as const, kind: 'echo-person-diagnostic-result-v1' as const, capture_id: id, expires_at: new Date(capture.expires_at).toISOString() });
      if (capture.status === 'prepared' || capture.status === 'running') return Object.freeze({ ...base(), status: capture.status });
      if (capture.erased || capture.fence === undefined) {
        erase(capture);
        capture.expires_at = Math.min(capture.expires_at, timestamp() + reread);
        return Object.freeze({ ...base(), status: 'failed' as const, error: capture.error ?? failure(undefined) });
      }
      try { await capture.fence(input.signal); }
      catch (error) {
        // Cancelling a read does not invalidate its source-access snapshot.
        // A concrete denial still wins if cancellation happens at the same time.
        const denied = error instanceof AuthorityOperationError && ['unauthorized', 'stale_access_state', 'not_found'].includes(error.code);
        if (!denied && input.signal?.aborted && (error === input.signal.reason || (error instanceof Error && error.name === 'AbortError'))) throw error;
        remove(id, capture);
        const failed = failure(error);
        return Object.freeze({ ...base(), status: 'failed' as const, error: failed.code === 'unavailable' ? failure(new AuthorityOperationError('stale_access_state', 'Access cannot be checked')) : failed });
      }
      // Reads arriving after expiry, shutdown, or concurrent invalidation cannot revive content.
      if (!active(id, capture)) {
        if (captures.get(id) === capture) remove(id, capture);
        throw new AuthorityOperationError('not_found', 'Diagnostic capture is unavailable');
      }
      input.signal?.throwIfAborted();
      // The fence may have awaited remote sources using the execution's own
      // session. The reading session must still be valid at the release edge.
      try {
        if (ownerOf(options.sessions.authenticateAccess({ access_token: input.access_token })) !== capture.owner) {
          throw new AuthorityOperationError('unauthorized', 'Diagnostic capture is not permitted');
        }
      } catch (error) { remove(id, capture); throw error; }
      const trace = capture.collector.snapshot();
      // A cancelled or rejected read has released nothing and does not start
      // the shorter lost-response reread window.
      capture.expires_at = Math.min(capture.expires_at, timestamp() + reread);
      return Object.freeze({ ...base(), status: capture.status, ...(capture.error === undefined ? {} : { error: capture.error }), trace });
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      for (const [id, capture] of captures) remove(id, capture);
    },
  } satisfies PersonDiagnosticsV1);
}
