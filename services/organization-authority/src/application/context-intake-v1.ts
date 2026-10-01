import {
  assertContextCaptureEnvelopeV1,
  CONTEXT_CAPTURE_LIMITS_V1,
  type ContextCaptureEnvelopeV1,
  type ContextRepresentationV1,
} from '@echo-brain/organization-processing/core';
import {
  assertSourceAdmissionScopeV1, canonicalSourceContentV1, sourceContentSha256V1,
  type AdapterOperationContext, type SourceAdapterIdentityV1, type SourceAdmissionScopeV1,
  type SourceAdmissionStoreV1, type SourceEnvelopeV1,
} from '@echo-brain/organization-processing/core';

export {
  assertContextCaptureEnvelopeV1, buildContextCaptureEnvelopeV1, CONTEXT_CAPTURE_LIMITS_V1,
} from '@echo-brain/organization-processing/core';
export type {
  BuildContextCaptureEnvelopeInputV1, ContextCaptureContentV1, ContextCaptureEnvelopeV1,
  ContextObservationV1, ContextPassageV1, ContextRepresentationV1,
} from '@echo-brain/organization-processing/core';

export interface RetainedContextCaptureV1 {
  readonly source: ContextCaptureEnvelopeV1;
  readonly scope: SourceAdmissionScopeV1;
  /** Existing admission's immutable manifest commitment, excluding capture time. */
  readonly revision_sha256: string;
}
export interface ContextCaptureReadPortV1 {
  list(input: { readonly organization_id: string; readonly limit?: number }): readonly RetainedContextCaptureV1[];
}
export interface ContextIntakePolicyV1 {
  readonly disposition: 'retained' | 'request_only';
  readonly scope: SourceAdmissionScopeV1;
  readonly permitted_representations: readonly ContextRepresentationV1['kind'][];
}
/** Trusted Authority composition owns this port, independently of read grants. */
export interface ContextIntakeAuthorityV1 {
  select(source: ContextCaptureEnvelopeV1): ContextIntakePolicyV1;
  requireCurrent(source: ContextCaptureEnvelopeV1, policy: ContextIntakePolicyV1): void;
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} has an unknown field`);
  return result;
}

function plainData(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Context data exceeds its depth bound');
  if (value === null || typeof value !== 'object') return;
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('Context data has symbol fields');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Context data must be plain');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (array && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('Context data has non-data fields');
    plainData(descriptor.value, depth + 1);
  }
}

/** Shared policy validation for intake and the persistence owner's atomic fence. */
export function selectContextIntakePolicyV1(source: ContextCaptureEnvelopeV1, authority: ContextIntakeAuthorityV1): ContextIntakePolicyV1 {
  const raw = authority.select(source);
  plainData(raw);
  object(raw, ['disposition', 'scope', 'permitted_representations'], 'Context Authority policy');
  assertSourceAdmissionScopeV1(raw.scope);
  if (!['retained', 'request_only'].includes(raw.disposition) || raw.scope.analysis_policy !== 'on_request' ||
      !Array.isArray(raw.permitted_representations) || raw.permitted_representations.length < 1 || raw.permitted_representations.length > 3 ||
      raw.permitted_representations.some(kind => !['pointer', 'excerpt', 'full_snapshot'].includes(kind)) ||
      new Set(raw.permitted_representations).size !== raw.permitted_representations.length ||
      !raw.permitted_representations.includes(source.content.representation.kind)) throw new Error('Context retention is not authorized');
  return freeze(JSON.parse(canonicalSourceContentV1(raw)) as ContextIntakePolicyV1);
}

/** Authority checks must finish synchronously, including inside a custody transaction. */
export function requireCurrentContextIntakePolicyV1(source: ContextCaptureEnvelopeV1, policy: ContextIntakePolicyV1, authority: ContextIntakeAuthorityV1): void {
  const result: unknown = authority.requireCurrent(source, policy);
  if (result !== undefined) {
    // An invalid async fence must not also turn recovery into an unhandled rejection.
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new Error('Context Authority fence must complete synchronously');
  }
}

/** The persistence adapter shares the gate even when called without the batch coordinator. */
export function snapshotContextCaptureAdmissionV1(
  input: { readonly source: SourceEnvelopeV1; readonly scope: SourceAdmissionScopeV1 },
  identity: SourceAdapterIdentityV1,
): { readonly source: ContextCaptureEnvelopeV1; readonly scope: SourceAdmissionScopeV1 } {
  plainData(input);
  object(input, ['source', 'scope'], 'Context admission');
  assertContextCaptureEnvelopeV1(input.source, identity);
  assertSourceAdmissionScopeV1(input.scope);
  return freeze(JSON.parse(canonicalSourceContentV1(input)) as { readonly source: ContextCaptureEnvelopeV1; readonly scope: SourceAdmissionScopeV1 });
}

/** Shared gate. Request-only policy cannot accidentally fall through to storage. */
export async function intakeContextBatchV1(options: {
  readonly identity: SourceAdapterIdentityV1;
  readonly sources: readonly unknown[];
  readonly authority: ContextIntakeAuthorityV1;
  /** Retained composition must repeat requireCurrent atomically with admission. */
  readonly store?: SourceAdmissionStoreV1;
  readonly context?: AdapterOperationContext;
}): Promise<readonly { readonly source: ContextCaptureEnvelopeV1; readonly policy: ContextIntakePolicyV1; readonly admission: 'admitted' | 'duplicate' | 'request_only' }[]> {
  options.context?.signal.throwIfAborted();
  if (!Array.isArray(options.sources) || options.sources.length > CONTEXT_CAPTURE_LIMITS_V1.batch) throw new Error('Context batch exceeds its bound');
  // Validate raw closed fields before JSON snapshotting can erase undefined extras.
  for (const source of options.sources) assertContextCaptureEnvelopeV1(source, options.identity);
  const sources = freeze(JSON.parse(canonicalSourceContentV1(options.sources)) as ContextCaptureEnvelopeV1[]);
  const policies: ContextIntakePolicyV1[] = [];
  const revisions = new Map<string, string>();
  const bindings = new Map<string, string>();
  for (const source of sources) {
    assertContextCaptureEnvelopeV1(source, options.identity);
    const policy = selectContextIntakePolicyV1(source, options.authority);
    if (policy.disposition === 'retained' && options.store === undefined) throw new Error('Retained context requires an admission store');
    const key = canonicalSourceContentV1([policy.scope.organization_id, source.item.source_id, source.revision.revision_id]);
    const { captured_at: _captured, ...immutable } = source.revision;
    const hash = sourceContentSha256V1(immutable);
    if (revisions.has(key) && revisions.get(key) !== hash) throw new Error('Context batch contains immutable revision conflicts');
    revisions.set(key, hash);
    const bindingKey = canonicalSourceContentV1([policy.scope.organization_id, source.item.source_id]);
    const binding = canonicalSourceContentV1(policy.scope);
    if (bindings.has(bindingKey) && bindings.get(bindingKey) !== binding) throw new Error('Context batch contains custody conflicts');
    bindings.set(bindingKey, binding);
    requireCurrentContextIntakePolicyV1(source, policy, options.authority); policies.push(policy);
  }
  const results = [];
  for (const [index, source] of sources.entries()) {
    options.context?.signal.throwIfAborted();
    const policy = policies[index]!;
    requireCurrentContextIntakePolicyV1(source, policy, options.authority);
    const admission = policy.disposition === 'request_only' ? 'request_only' as const :
      await options.store!.admitSourceRevision({ source, scope: policy.scope }, options.context);
    options.context?.signal.throwIfAborted();
    results.push({ source, policy, admission });
  }
  return results;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
