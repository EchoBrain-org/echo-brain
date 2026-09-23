import { createHash } from "node:crypto";
import type { AdapterOperationContext } from "../contracts/adapter.js";
import type {
  SourceAdapterIdentityV1,
  SourceAdmissionScopeV1,
  SourceBatchV1,
  SourceEnvelopeV1,
  SourcePullRequestV1,
} from "../contracts/source.js";
import type { SourceAdapterV1, SourceAdmissionBindingV1 } from "../ports/source.js";

const MAXIMUM_SOURCE_BATCH = 100;
const MAXIMUM_CONTENT_BYTES = 32 * 1024 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unknown field`);
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 8192) throw new Error(`${label} must be a bounded non-empty string`);
}

function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

function canonical(value: unknown, depth: number): string {
  if (depth > 64) throw new Error("source content exceeds the JSON depth limit");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error("source content arrays must be dense");
      parts.push(canonical(value[index], depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  const record = object(value, "source content");
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
}

/** Object key order is immaterial; array order, text and finite numbers are exact. */
export function canonicalSourceContentV1(value: unknown): string {
  const encoded = canonical(value, 0);
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_CONTENT_BYTES) throw new Error("source content exceeds the safety limit");
  return encoded;
}

export function sourceContentSha256V1(value: unknown): string {
  return createHash("sha256").update(canonicalSourceContentV1(value)).digest("hex");
}

/** Organization namespaces this key in storage; adapter version never changes it. */
export function sourceItemIdV1(adapter: Pick<SourceAdapterIdentityV1, "adapter_id" | "instance_id">, externalId: string): string {
  return `source:${sourceContentSha256V1([adapter.adapter_id, adapter.instance_id, externalId])}`;
}

export function assertSourceAdmissionScopeV1(value: unknown): asserts value is SourceAdmissionScopeV1 {
  const scope = object(value, "source admission scope");
  keys(scope, ["organization_id", "custody_ref", "access_policy_ref", "analysis_policy"], "source admission scope");
  for (const field of ["organization_id", "custody_ref", "access_policy_ref"]) text(scope[field], `source admission scope.${field}`);
  if (scope["analysis_policy"] !== "on_request" && scope["analysis_policy"] !== "automatic") throw new Error("source admission analysis policy is invalid");
}

export function assertSourceEnvelopeV1(value: unknown, expectedIdentity: SourceAdapterIdentityV1): asserts value is SourceEnvelopeV1 {
  const envelope = object(value, "source");
  keys(envelope, ["item", "revision", "content"], "source");
  const item = object(envelope["item"], "source.item");
  keys(item, ["schema_version", "source_id", "adapter", "external_id"], "source.item");
  if (item["schema_version"] !== 1) throw new Error("source item schema version is unsupported");
  text(item["source_id"], "source.item.source_id");
  text(item["external_id"], "source.item.external_id");
  const adapter = object(item["adapter"], "source.item.adapter");
  keys(adapter, ["kind", "adapter_id", "instance_id", "version"], "source.item.adapter");
  if (adapter["kind"] !== "source" && adapter["kind"] !== "meeting-source") throw new Error("source adapter kind is invalid");
  for (const field of ["kind", "adapter_id", "instance_id", "version"] as const) {
    text(adapter[field], `source.item.adapter.${field}`);
    if (adapter[field] !== expectedIdentity[field]) throw new Error("source adapter identity does not match the configured adapter");
  }
  const revision = object(envelope["revision"], "source.revision");
  keys(revision, ["schema_version", "source_id", "revision_id", "captured_at", "content_sha256", "artifact_refs", "representation_refs", "previous_revision_id", "contributor"], "source.revision");
  if (revision["schema_version"] !== 1) throw new Error("source revision schema version is unsupported");
  if (revision["source_id"] !== item["source_id"]) throw new Error("source revision belongs to a different source");
  text(revision["revision_id"], "source.revision.revision_id");
  if (revision["previous_revision_id"] !== undefined) {
    text(revision["previous_revision_id"], "source.revision.previous_revision_id");
    if (revision["previous_revision_id"] === revision["revision_id"]) throw new Error("a source revision cannot precede itself");
  }
  if (revision["contributor"] !== undefined) {
    const contributor = object(revision["contributor"], "source revision contributor");
    keys(contributor, ["principal_id", "membership_id"], "source revision contributor");
    text(contributor["principal_id"], "source revision contributor.principal_id");
    text(contributor["membership_id"], "source revision contributor.membership_id");
  }
  const captured = revision["captured_at"];
  if (typeof captured !== "string" || !Number.isFinite(Date.parse(captured)) || new Date(captured).toISOString() !== captured) throw new Error("source captured_at must be a canonical UTC timestamp");
  digest(revision["content_sha256"], "source.revision.content_sha256");
  if (sourceContentSha256V1(envelope["content"]) !== revision["content_sha256"]) throw new Error("source content does not match its revision digest");
  for (const field of ["artifact_refs", "representation_refs"] as const) {
    const references = revision[field];
    if (!Array.isArray(references) || references.length > 1000) throw new Error(`source.revision.${field} must be a bounded array`);
    const seen = new Set<string>();
    for (const reference of references) {
      const ref = object(reference, `source.revision.${field}`);
      const idField = field === "artifact_refs" ? "artifact_id" : "representation_id";
      keys(ref, field === "artifact_refs" ? ["artifact_id", "media_type", "sha256", "byte_length"] : ["representation_id", "media_type", "sha256", "schema_version", "processor_version"], `source.revision.${field}`);
      text(ref[idField], `source.revision.${field}.${idField}`);
      const id = ref[idField] as string;
      if (seen.has(id)) throw new Error("source references must have unique identities");
      seen.add(id);
      text(ref["media_type"], "source reference media_type");
      digest(ref["sha256"], "source reference sha256");
      if (field === "artifact_refs") {
        if (!Number.isSafeInteger(ref["byte_length"]) || Number(ref["byte_length"]) < 0) throw new Error("source artifact byte_length is invalid");
      } else {
        if (!Number.isSafeInteger(ref["schema_version"]) || Number(ref["schema_version"]) < 1) throw new Error("source representation schema_version is invalid");
        text(ref["processor_version"], "source representation processor_version");
      }
    }
  }
}

export interface AdmittedSourceBatchV1<TContent> extends SourceBatchV1<TContent> {
  readonly admissions: readonly ("admitted" | "duplicate" | "validated")[];
}

function assertNotAborted(context?: AdapterOperationContext): void {
  if (context?.signal.aborted === true) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("source admission was cancelled");
}

/**
 * Common pull/admission boundary. Validates the entire batch before persistence,
 * binds Authority policy separately, and never advances a cursor itself. The
 * caller checkpoints only after its required durable work has succeeded.
 */
export async function pullAndAdmitSourceBatchV1<TContent>(options: {
  readonly source: SourceAdapterV1<TContent>;
  readonly request: SourcePullRequestV1;
  readonly admission?: SourceAdmissionBindingV1<TContent>;
  readonly context?: AdapterOperationContext;
}): Promise<AdmittedSourceBatchV1<TContent>> {
  assertNotAborted(options.context);
  const limit = options.request.limit ?? MAXIMUM_SOURCE_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SOURCE_BATCH) throw new Error("source pull limit is invalid");
  if (options.request.cursor !== undefined) text(options.request.cursor, "source pull cursor");
  const pulled = await options.source.pull(options.request, options.context);
  assertNotAborted(options.context);
  const raw = object(pulled, "source batch");
  keys(raw, ["sources", "next_cursor"], "source batch");
  if (!Array.isArray(raw["sources"]) || raw["sources"].length > limit) throw new Error("source batch exceeds the requested pull limit");
  if (raw["next_cursor"] !== undefined) text(raw["next_cursor"], "source batch next_cursor");
  // Capture a JSON snapshot so the provider cannot mutate content during an await.
  const batch = JSON.parse(canonicalSourceContentV1(pulled)) as SourceBatchV1<TContent>;
  const seenIds = new Map<string, string>();
  const seenExternalIds = new Map<string, string>();
  const seenRevisions = new Map<string, string>();
  const scopes: SourceAdmissionScopeV1[] = [];
  for (const source of batch.sources) {
    assertSourceEnvelopeV1(source, options.source.identity);
    const { source_id: sourceId, external_id: externalId } = source.item;
    if ((seenIds.has(sourceId) && seenIds.get(sourceId) !== externalId) || (seenExternalIds.has(externalId) && seenExternalIds.get(externalId) !== sourceId)) throw new Error("source batch contains conflicting stable identities");
    seenIds.set(sourceId, externalId);
    seenExternalIds.set(externalId, sourceId);
    const revisionKey = JSON.stringify([sourceId, source.revision.revision_id]);
    const revisionDigest = sourceContentSha256V1({ content_sha256: source.revision.content_sha256, artifact_refs: source.revision.artifact_refs, representation_refs: source.revision.representation_refs, previous_revision_id: source.revision.previous_revision_id, contributor: source.revision.contributor });
    if (seenRevisions.has(revisionKey) && seenRevisions.get(revisionKey) !== revisionDigest) throw new Error("source batch contains conflicting immutable revisions");
    seenRevisions.set(revisionKey, revisionDigest);
    if (options.admission) {
      const resolved = typeof options.admission.scope === "function" ? options.admission.scope(source) : options.admission.scope;
      assertSourceAdmissionScopeV1(resolved);
      scopes.push({ ...resolved });
    }
  }
  const admissions: ("admitted" | "duplicate" | "validated")[] = [];
  for (const [index, source] of batch.sources.entries()) {
    assertNotAborted(options.context);
    admissions.push(options.admission ? await options.admission.store.admitSourceRevision({ scope: scopes[index]!, source }, options.context) : "validated");
  }
  assertNotAborted(options.context);
  return { ...batch, admissions };
}
