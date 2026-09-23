import { describe, expect, it, vi } from "vitest";
import {
  MeetingSourceBridgeV1,
  meetingFromSourceEnvelopeV1,
  meetingSourceEnvelopeV1,
  pullAndAdmitSourceBatchV1,
  sourceContentSha256V1,
  sourceItemIdV1,
  type MeetingDocument,
  type SourceAdapterV1,
  type SourceAdmissionScopeV1,
  type SourceEnvelopeV1,
} from "../../src/core/index.js";

const identity = { kind: "source" as const, adapter_id: "person", instance_id: "inbox", version: "1" };
const scope: SourceAdmissionScopeV1 = { organization_id: "org-1", custody_ref: "project:scout", access_policy_ref: "audience:scout", analysis_policy: "on_request" };
const at = "2026-09-23T00:00:00.000Z";

function sourceEnvelope(id = "doc-1"): SourceEnvelopeV1 {
  const content = { kind: "document", schema_version: 1, document_id: id };
  const sourceId = sourceItemIdV1(identity, id);
  return {
    item: { schema_version: 1, source_id: sourceId, adapter: identity, external_id: id },
    revision: { schema_version: 1, source_id: sourceId, revision_id: "revision-1", captured_at: at, content_sha256: sourceContentSha256V1(content), artifact_refs: [], representation_refs: [] },
    content,
  };
}

function adapter(sources: readonly SourceEnvelopeV1[]): SourceAdapterV1 {
  return {
    identity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: "healthy", checked_at: at }),
    pull: vi.fn(async () => ({ sources, next_cursor: "next" })),
  };
}

function meeting(): MeetingDocument {
  return {
    schema_version: 1,
    id: "meeting-1",
    provenance: { source: { kind: "meeting-source", adapter_id: "meeting", instance_id: "connection", version: "1" }, external_id: "meeting-1", canonical_revision: "revision-1", observed_at: at, normalizer_version: "1" },
    capture: { state: "complete", components: [] }, participants: [], artifacts: [],
    content: [{ id: "note-1", kind: "note", text: "Hardware needs the software interface." }],
  };
}

describe("common source admission", () => {
  it("binds each source to Authority custody and keeps duplicate admission available for processing recovery", async () => {
    const sources = [sourceEnvelope(), sourceEnvelope("doc-2")];
    const source = adapter(sources);
    const admitSourceRevision = vi.fn().mockResolvedValueOnce("admitted").mockResolvedValueOnce("duplicate");
    const result = await pullAndAdmitSourceBatchV1({ source, request: { cursor: "previous", limit: 2 }, admission: { scope: (value) => ({ ...scope, custody_ref: `project:${value.item.external_id}` }), store: { admitSourceRevision } } });
    expect(source.pull).toHaveBeenCalledWith({ cursor: "previous", limit: 2 }, undefined);
    expect(admitSourceRevision.mock.calls.map(([input]) => input.scope.custody_ref)).toEqual(["project:doc-1", "project:doc-2"]);
    expect(result.admissions).toEqual(["admitted", "duplicate"]);
    expect(result.sources).toHaveLength(2);
    expect(result.next_cursor).toBe("next");
  });

  it("checks the whole batch before admitting anything, including hashes and source identity", async () => {
    const first = sourceEnvelope();
    const second = sourceEnvelope("doc-2");
    const admitSourceRevision = vi.fn(async () => "admitted" as const);
    const admission = { scope, store: { admitSourceRevision } };
    await expect(pullAndAdmitSourceBatchV1({ source: adapter([first, { ...second, content: { changed: true } }]), request: { limit: 2 }, admission })).rejects.toThrow("digest");
    await expect(pullAndAdmitSourceBatchV1({ source: adapter([{ ...first, item: { ...first.item, adapter: { ...identity, instance_id: "other-inbox" } } }]), request: {}, admission })).rejects.toThrow("configured adapter");
    expect(admitSourceRevision).not.toHaveBeenCalled();
  });

  it("rejects adapter-supplied policy claims and conflicting revision payloads", async () => {
    const first = sourceEnvelope();
    const admitSourceRevision = vi.fn(async () => "admitted" as const);
    const admission = { scope, store: { admitSourceRevision } };
    const claimed = { ...first, item: { ...first.item, access_policy_ref: "public" } };
    await expect(pullAndAdmitSourceBatchV1({ source: adapter([claimed]), request: {}, admission })).rejects.toThrow("unknown field");
    const changedContent = { kind: "document", document_id: "changed" };
    const changed = { ...first, revision: { ...first.revision, content_sha256: sourceContentSha256V1(changedContent) }, content: changedContent };
    await expect(pullAndAdmitSourceBatchV1({ source: adapter([first, changed]), request: { limit: 2 }, admission })).rejects.toThrow("conflicting immutable revisions");
    expect(admitSourceRevision).not.toHaveBeenCalled();
  });

  it("snapshots source data before asynchronous admission", async () => {
    const first = sourceEnvelope();
    const second = sourceEnvelope("doc-2");
    const seen: unknown[] = [];
    await pullAndAdmitSourceBatchV1({ source: adapter([first, second]), request: { limit: 2 }, admission: { scope, store: { admitSourceRevision: async ({ source }) => {
      seen.push(source.content);
      (second.content as { document_id: string }).document_id = "provider-mutated";
      return "admitted";
    } } } });
    expect(seen).toEqual([{ kind: "document", schema_version: 1, document_id: "doc-1" }, { kind: "document", schema_version: 1, document_id: "doc-2" }]);
  });

  it("does not pull after cancellation or admit another revision when cancelled during persistence", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const source = adapter([sourceEnvelope()]);
    await expect(pullAndAdmitSourceBatchV1({ source, request: {}, context: { signal: controller.signal } })).rejects.toThrow("stopped");
    expect(source.pull).not.toHaveBeenCalled();
    const during = new AbortController();
    const admitSourceRevision = vi.fn(async () => { during.abort(new Error("stopped during write")); return "admitted" as const; });
    await expect(pullAndAdmitSourceBatchV1({ source: adapter([sourceEnvelope(), sourceEnvelope("doc-2")]), request: { limit: 2 }, context: { signal: during.signal }, admission: { scope, store: { admitSourceRevision } } })).rejects.toThrow("stopped during write");
    expect(admitSourceRevision).toHaveBeenCalledTimes(1);
  });

  it("keeps source identity across adapter upgrades and hashes canonical JSON without hiding invalid values", () => {
    const upgraded = { ...identity, version: "2" };
    expect(sourceItemIdV1(upgraded, "doc-1")).toBe(sourceItemIdV1(identity, "doc-1"));
    expect(sourceContentSha256V1({ b: 2, a: 1 })).toBe(sourceContentSha256V1({ a: 1, b: 2 }));
    expect(() => sourceContentSha256V1({ a: Number.NaN })).toThrow();
    expect(() => sourceContentSha256V1([undefined])).toThrow();
  });

  it("bridges canonical meetings through the same admission without treating re-observation as changed evidence", async () => {
    const observed = meeting();
    const first = meetingSourceEnvelopeV1(observed);
    const later = meetingSourceEnvelopeV1({ ...observed, provenance: { ...observed.provenance, observed_at: "2026-09-24T00:00:00.000Z" } });
    expect(first.revision.content_sha256).toBe(later.revision.content_sha256);
    expect(first.revision.representation_refs).toEqual([]);
    expect(first.content.provenance.normalizer_version).toBe(observed.provenance.normalizer_version);
    expect(first.revision.captured_at).not.toBe(later.revision.captured_at);
    expect(meetingFromSourceEnvelopeV1(first)).toEqual(observed);
    const admitSourceRevision = vi.fn(async () => "admitted" as const);
    const source = new MeetingSourceBridgeV1({ identity: observed.provenance.source, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: "healthy", checked_at: at }), pull: async () => ({ meetings: [observed], next_cursor: "meeting-next" }) });
    const result = await pullAndAdmitSourceBatchV1({ source, request: { limit: 1 }, admission: { scope: { ...scope, analysis_policy: "automatic" }, store: { admitSourceRevision } } });
    expect(result.admissions).toEqual(["admitted"]);
    expect(meetingFromSourceEnvelopeV1(result.sources[0]!)).toEqual(observed);
    expect(result.next_cursor).toBe("meeting-next");
  });
});
