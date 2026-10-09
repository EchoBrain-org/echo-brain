import { canonicalSha256 } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthorityBaselineV13 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import {
  ReadableSearchGenerationReconcilerV1,
  type ReadableSearchGenerationReconcilerV1Options,
  type ReadableSearchRecordHeadV1,
  type ReadableSearchSnapshotV1,
} from "../src/composition/readable-search-generation-reconciler.js";

const ORGANIZATION_ID = "org_clean";
const CONTRACT = canonicalSha256({ contract: "clean-search" });
const UPDATED_CONTRACT = canonicalSha256({ contract: "clean-search-decision-family" });
const GENERATION = canonicalSha256({ generation: "clean-search" });
const MANIFEST = canonicalSha256({ manifest: "clean-search" });
const NOW = "2026-08-22T12:00:00.000Z";
const databases: Database.Database[] = [];

function database(): Database.Database {
  const value = new Database(":memory:");
  databases.push(value);
  applyAuthorityBaselineV13(value);
  value
    .prepare(
      `INSERT INTO authority_metadata (
         singleton, authority_id, organization_id, organization_display_name,
         descriptor_json, created_at, last_observed_at
       ) VALUES (1, 'oau_clean', ?, 'Clean', '{}', ?, ?)`,
    )
    .run(ORGANIZATION_ID, NOW, NOW);
  return value;
}

function head(position: number): ReadableSearchRecordHeadV1 {
  return Object.freeze({
    position,
    record_sha256:
      position === 0 ? null : canonicalSha256({ record: position }),
  });
}

function generation(record_head: ReadableSearchRecordHeadV1, retrieval_contract_sha256 = CONTRACT) {
  return { generation_id: GENERATION, manifest_sha256: MANIFEST, retrieval_contract_sha256, record_head };
}

/** A reconciler pinned to `current`; tests override only the seams they exercise. */
function reconciler<Snapshot extends ReadableSearchSnapshotV1>(
  authority: Database.Database,
  current: ReadableSearchRecordHeadV1,
  overrides: Partial<ReadableSearchGenerationReconcilerV1Options<Snapshot>> = {},
): ReadableSearchGenerationReconcilerV1<Snapshot> {
  return new ReadableSearchGenerationReconcilerV1<Snapshot>({
    authority, organization_id: ORGANIZATION_ID,
    retrieval_contract_sha256: CONTRACT, read_record_head: () => current,
    capture_snapshot: () => ({ record_head: current }) as Snapshot,
    build_generation: () => generation(current),
    now: () => NOW,
    ...overrides,
  });
}

function insertPrior(authority: Database.Database, prior: ReadableSearchRecordHeadV1): void {
  authority
    .prepare(
      `INSERT INTO authority_readable_search_active_generation (
         singleton, organization_id, generation_id, manifest_sha256,
         retrieval_contract_sha256, record_head_position, record_head_hash,
         published_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ORGANIZATION_ID,
      canonicalSha256({ generation: "prior" }),
      canonicalSha256({ manifest: "prior" }),
      CONTRACT,
      prior.position,
      prior.record_sha256,
      NOW,
    );
}

function active(authority: Database.Database, column = "count(*)"): unknown {
  return authority.prepare(`SELECT ${column} FROM authority_readable_search_active_generation`).pluck().get();
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("readable-search generation reconciliation", () => {
  it("observes each real build boundary under one shared operation identity", async () => {
    const events: { stage: string; event: string; operation_id: string }[] = [];
    const current = head(2);
    const value = reconciler(database(), current, {
      enrich_snapshot: async (snapshot) => snapshot,
      prepare_generation: () => undefined,
      observation: (event: { stage: string; event: string; operation_id: string }) => { events.push(event); },
    });
    await expect(value.reconcile(new AbortController().signal)).resolves.toMatchObject({ status: "published" });
    expect(events.filter((event) => event.event === "succeeded").map((event) => event.stage))
      .toEqual(["search_snapshot", "search_enrichment", "search_build", "search_validation", "search_publication", "search_reconciliation"]);
    expect(new Set(events.map((event) => event.operation_id)).size).toBe(1);
  });

  it("publishes a missing exact-head generation and then no-ops", async () => {
    const authority = database();
    const current = head(2);
    const capture = vi.fn(() => ({ record_head: current, atoms: [] }));
    const build = vi.fn(() => generation(current));
    const value = reconciler(authority, current, { capture_snapshot: capture, build_generation: build });

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toMatchObject({ status: "published", record_head: current });
    expect(
      authority
        .prepare(
          `SELECT generation_id, manifest_sha256, record_head_position,
                  record_head_hash
             FROM authority_readable_search_active_generation`,
        )
        .get(),
    ).toEqual({
      generation_id: GENERATION,
      manifest_sha256: MANIFEST,
      record_head_position: 2,
      record_head_hash: current.record_sha256,
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toEqual({ status: "current", record_head: current });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("validates every build but skips an unchanged head whose generation is still warm", async () => {
    const current = head(2);
    let warm = true;
    const prepare = vi.fn();
    const isWarm = vi.fn(() => warm);
    const value = reconciler(database(), current, { prepare_generation: prepare, is_generation_warm: isWarm });
    await expect(value.reconcile(new AbortController().signal)).resolves.toMatchObject({ status: "published" });
    expect(isWarm).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    await expect(value.reconcile(new AbortController().signal)).resolves.toMatchObject({ status: "current" });
    expect(isWarm).toHaveBeenCalledWith(generation(current));
    expect(prepare).toHaveBeenCalledOnce();
    warm = false; // The handle was cleared.
    await expect(value.reconcile(new AbortController().signal)).resolves.toMatchObject({ status: "current" });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when only the immutable retrieval contract changes at an unchanged head", async () => {
    const authority = database();
    const current = head(2);
    insertPrior(authority, current);
    const capture = vi.fn(() => ({ record_head: current }));
    const build = vi.fn(() => generation(current, UPDATED_CONTRACT));
    const value = reconciler(authority, current, {
      retrieval_contract_sha256: UPDATED_CONTRACT, capture_snapshot: capture, build_generation: build,
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toMatchObject({ status: "published", record_head: current });
    expect(capture).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(active(authority, "retrieval_contract_sha256")).toBe(UPDATED_CONTRACT);
  });

  it("leaves the prior pointer untouched when a build fails", async () => {
    const authority = database();
    insertPrior(authority, head(1));
    const value = reconciler(authority, head(2), {
      build_generation: () => {
        throw new Error("generation interrupted");
      },
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).rejects.toThrow("generation interrupted");
    expect(active(authority, "record_head_position")).toBe(1);
  });

  it("enriches only a stale snapshot after capture and before the pure build", async () => {
    const authority = database();
    const current = head(2);
    const order: string[] = [];
    const captured = { record_head: current, related: [] as readonly string[] };
    const enriched = { record_head: current, related: ["linked"] };
    const enrich = vi.fn(async (snapshot: typeof captured, signal: AbortSignal) => {
      order.push("enrich");
      expect(snapshot).toBe(captured);
      expect(signal.aborted).toBe(false);
      return enriched;
    });
    const build = vi.fn((snapshot: typeof captured) => {
      order.push("build");
      expect(snapshot).toBe(enriched);
      return generation(current);
    });
    const value = reconciler(authority, current, {
      capture_snapshot: () => {
        order.push("capture");
        return captured;
      },
      enrich_snapshot: enrich,
      build_generation: build,
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toMatchObject({ status: "published" });
    expect(order).toEqual(["capture", "enrich", "build"]);
    expect(enrich).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toMatchObject({ status: "current" });
    expect(enrich).toHaveBeenCalledOnce();
  });

  it("does not build or publish when asynchronous enrichment is cancelled", async () => {
    const authority = database();
    const current = head(1);
    const controller = new AbortController();
    const build = vi.fn();
    const value = reconciler(authority, current, {
      enrich_snapshot: async (snapshot) => {
        controller.abort();
        return snapshot;
      },
      build_generation: build as never,
    });

    await expect(value.reconcile(controller.signal)).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();
    expect(active(authority)).toBe(0);
  });

  it("skips obsolete build work after held enrichment and publishes the newest head on retry", async () => {
    const authority = database();
    let current = head(2);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const build = vi.fn((snapshot: { record_head: ReadableSearchRecordHeadV1 }) => generation(snapshot.record_head));
    // Both reads follow the mutable head, so the retry captures head(4).
    const value = reconciler(authority, current, {
      read_record_head: () => current,
      capture_snapshot: () => ({ record_head: current }),
      enrich_snapshot: async (snapshot) => { await held; return snapshot; },
      build_generation: build,
    });
    const pending = value.reconcile(new AbortController().signal);
    expect(build).not.toHaveBeenCalled();
    expect(active(authority)).toBe(0);
    current = head(4);
    release();
    await expect(pending).resolves.toEqual({ status: "superseded", captured_head: head(2), current_head: head(4) });
    expect(build).not.toHaveBeenCalled();
    await expect(value.reconcile(new AbortController().signal)).resolves.toMatchObject({ status: "published", record_head: head(4) });
    expect(build).toHaveBeenCalledOnce();
    expect(active(authority, "record_head_position")).toBe(4);
  });

  it("rejects enrichment that changes the captured record head", async () => {
    const authority = database();
    const current = head(1);
    const build = vi.fn();
    const value = reconciler(authority, current, {
      enrich_snapshot: async () => ({ record_head: head(2) }),
      build_generation: build as never,
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).rejects.toThrow("enrichment changed its captured record head");
    expect(build).not.toHaveBeenCalled();
  });

  it("does not publish a completed generation when its captured head was superseded", async () => {
    const authority = database();
    const captured = head(2);
    const advanced = head(3);
    let reads = 0;
    const value = reconciler(authority, captured, {
      read_record_head: () => (++reads < 3 ? captured : advanced),
    });

    await expect(
      value.reconcile(new AbortController().signal),
    ).resolves.toEqual({
      status: "superseded",
      captured_head: captured,
      current_head: advanced,
    });
    expect(active(authority)).toBe(0);
  });

  it("checks cancellation before building and before pointer publication", async () => {
    const authority = database();
    const current = head(1);
    const beforeBuild = new AbortController();
    beforeBuild.abort();
    const build = vi.fn();
    await expect(reconciler(authority, current, { build_generation: build as never }).reconcile(beforeBuild.signal)).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();

    const duringBuild = new AbortController();
    const second = reconciler(authority, current, {
      build_generation: () => {
        duringBuild.abort();
        return generation(current);
      },
    });
    await expect(second.reconcile(duringBuild.signal)).rejects.toThrow();
    expect(active(authority)).toBe(0);
  });
});
