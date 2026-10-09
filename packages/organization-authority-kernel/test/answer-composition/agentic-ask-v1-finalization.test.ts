import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import { createAgenticAskV1, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import type { EvidenceDeskItemV1, EvidenceDeskPortV1 } from "../../src/shared/evidence-desk-v1.js";
import { deferred } from "./fixtures/deferred.js";

const checked = { checked_at: "2026-09-29T00:00:00.000Z" };

function fixture(options: {
  readonly finalFence?: () => Promise<typeof checked>;
  readonly append?: (entry: AgenticAskAuditEntryV1) => Promise<unknown> | unknown;
} = {}) {
  const launch: EvidenceDeskItemV1 = {
    id: "desk_launch", kind: "decision", text: "Launch is Tuesday.", label: "Launch review", visibility: "team",
    citation: { kind: "approved_record", atom_id: canonicalSha256("launch"), record_sha256: canonicalSha256("record"), policy_id: "organization-member-readable-person-v2" },
    receipt_sha256: canonicalSha256("receipt"),
  };
  const need = (status: string, evidence: string[]) => [{ question: "When is launch?", notes: "", needs: [{ need: "launch date", status, evidence }] }];
  const replies = [
    { parts: need("open", []), actions: [{ tool: "search", args: { query: "launch" } }] },
    { parts: need("found", ["E1"]), actions: [{ tool: "finish", args: {} }] },
    { sentences: [{ text: "Launch is Tuesday.", evidence: ["E1"] }], not_found: [] },
  ];
  let calls = 0;
  const generate = vi.fn(async () => {
    if (calls >= replies.length) throw new Error("unexpected model retry during finalization");
    return replies[calls++];
  });
  let fences = 0;
  const revalidate = vi.fn(async () => {
    fences += 1;
    return fences === 4 && options.finalFence !== undefined ? options.finalFence() : checked;
  });
  const desk: EvidenceDeskPortV1 = {
    scope: { kind: "global" },
    search: async () => ({ items: [launch], truncated: false, receipt_digests: [launch.receipt_sha256] }),
    open: async () => { throw new Error("unexpected open during finalization"); },
    list: async () => { throw new Error("unexpected list during finalization"); },
    revalidate,
  };
  const append = vi.fn(async (entry: AgenticAskAuditEntryV1) => options.append?.(entry));
  const published = vi.fn();
  const ask = createAgenticAskV1({
    desk, model: { generate }, audit: { append },
    generation: { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 30_000 },
  });
  return { generate, revalidate, append, published, run: (signal?: AbortSignal) => ask.answer({ question: "When is launch?", signal }).then(published) };
}

function expectNoPublicationOrRetry(f: ReturnType<typeof fixture>) {
  expect(f.published).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledTimes(3);
  expect(f.revalidate).toHaveBeenCalledTimes(4);
}

describe("agentic Ask: final publication boundary", () => {
  it("does not publish or audit a valid answer when final evidence revalidation fails", async () => {
    const refusal = new Error("membership revoked at the final fence");
    const f = fixture({ finalFence: async () => { throw refusal; } });

    await expect(f.run()).rejects.toBe(refusal);

    expectNoPublicationOrRetry(f);
    expect(f.append).not.toHaveBeenCalled();
  });

  it("does not retry the audit or publish a valid answer when its audit append fails", async () => {
    const failure = new Error("audit storage unavailable");
    const f = fixture({ append: async () => { throw failure; } });

    await expect(f.run()).rejects.toBe(failure);

    expectNoPublicationOrRetry(f);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "answered", repairs: 0, fallbacks: 0 }));
  });

  it("cancels a pending final fence and ignores its late successful result", async () => {
    const entered = deferred<void>();
    const released = deferred<typeof checked>();
    const controller = new AbortController();
    const f = fixture({ finalFence: () => { entered.resolve(); return released.promise; } });
    const pending = f.run(controller.signal);
    await entered.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejected;
    released.resolve(checked);
    await Promise.resolve();

    expectNoPublicationOrRetry(f);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled", repairs: 0, fallbacks: 0, prompt_sha256: null, answer_sha256: null, response_sha256: null }));
  });

  it("suppresses publication after cancellation during an audit without appending a second witness", async () => {
    const entered = deferred<void>();
    const persisted = deferred<void>();
    const controller = new AbortController();
    const f = fixture({ append: () => { entered.resolve(); return persisted.promise; } });
    const pending = f.run(controller.signal);
    await entered.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    persisted.resolve();
    await rejected;

    expectNoPublicationOrRetry(f);
    // The completed audit is retained, but its answer never reaches the caller.
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ outcome: "answered", repairs: 0, fallbacks: 0 }));
  });
});
