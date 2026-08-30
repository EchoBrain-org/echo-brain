import { canonicalSha256 } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import {
  ReadableSearchGenerationReconcilerV1,
  type ReadableSearchRecordHeadV1,
} from "../src/composition/readable-search-generation-reconciler.js";

const ORGANIZATION_ID = "org_clean";
const CONTRACT = canonicalSha256({ contract: "clean-search" });
const GENERATION = canonicalSha256({ generation: "clean-search" });
const MANIFEST = canonicalSha256({ manifest: "clean-search" });
const NOW = "2026-08-22T12:00:00.000Z";
const databases: Database.Database[] = [];

function database(): Database.Database {
  const value = new Database(":memory:");
  databases.push(value);
  applyAuthorityBaselineV1(value);
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

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("readable-search generation reconciliation", () => {
  it("publishes a missing exact-head generation and then no-ops", async () => {
    const authority = database();
    const current = head(2);
    const capture = vi.fn(() => ({ record_head: current, atoms: [] }));
    const build = vi.fn(() => ({
      generation_id: GENERATION,
      manifest_sha256: MANIFEST,
      retrieval_contract_sha256: CONTRACT,
      record_head: current,
    }));
    const reconciler = new ReadableSearchGenerationReconcilerV1({
      authority,
      organization_id: ORGANIZATION_ID,
      retrieval_contract_sha256: CONTRACT,
      read_record_head: () => current,
      capture_snapshot: capture,
      build_generation: build,
      now: () => NOW,
    });

    await expect(
      reconciler.reconcile(new AbortController().signal),
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
      reconciler.reconcile(new AbortController().signal),
    ).resolves.toEqual({ status: "current", record_head: current });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("leaves the prior pointer untouched when a build fails", async () => {
    const authority = database();
    const prior = head(1);
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
    const current = head(2);
    const reconciler = new ReadableSearchGenerationReconcilerV1({
      authority,
      organization_id: ORGANIZATION_ID,
      retrieval_contract_sha256: CONTRACT,
      read_record_head: () => current,
      capture_snapshot: () => ({ record_head: current }),
      build_generation: () => {
        throw new Error("generation interrupted");
      },
      now: () => NOW,
    });

    await expect(
      reconciler.reconcile(new AbortController().signal),
    ).rejects.toThrow("generation interrupted");
    expect(
      authority
        .prepare(
          "SELECT record_head_position FROM authority_readable_search_active_generation",
        )
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("does not publish a completed generation when its captured head was superseded", async () => {
    const authority = database();
    const captured = head(2);
    const advanced = head(3);
    let reads = 0;
    const reconciler = new ReadableSearchGenerationReconcilerV1({
      authority,
      organization_id: ORGANIZATION_ID,
      retrieval_contract_sha256: CONTRACT,
      read_record_head: () => (++reads === 1 ? captured : advanced),
      capture_snapshot: () => ({ record_head: captured }),
      build_generation: () => ({
        generation_id: GENERATION,
        manifest_sha256: MANIFEST,
        retrieval_contract_sha256: CONTRACT,
        record_head: captured,
      }),
      now: () => NOW,
    });

    await expect(
      reconciler.reconcile(new AbortController().signal),
    ).resolves.toEqual({
      status: "superseded",
      captured_head: captured,
      current_head: advanced,
    });
    expect(
      authority
        .prepare(
          "SELECT count(*) FROM authority_readable_search_active_generation",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("checks cancellation before building and before pointer publication", async () => {
    const authority = database();
    const current = head(1);
    const beforeBuild = new AbortController();
    beforeBuild.abort();
    const build = vi.fn();
    const reconciler = new ReadableSearchGenerationReconcilerV1({
      authority,
      organization_id: ORGANIZATION_ID,
      retrieval_contract_sha256: CONTRACT,
      read_record_head: () => current,
      capture_snapshot: () => ({ record_head: current }),
      build_generation: build as never,
      now: () => NOW,
    });
    await expect(reconciler.reconcile(beforeBuild.signal)).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();

    const duringBuild = new AbortController();
    const second = new ReadableSearchGenerationReconcilerV1({
      authority,
      organization_id: ORGANIZATION_ID,
      retrieval_contract_sha256: CONTRACT,
      read_record_head: () => current,
      capture_snapshot: () => ({ record_head: current }),
      build_generation: () => {
        duringBuild.abort();
        return {
          generation_id: GENERATION,
          manifest_sha256: MANIFEST,
          retrieval_contract_sha256: CONTRACT,
          record_head: current,
        };
      },
      now: () => NOW,
    });
    await expect(second.reconcile(duringBuild.signal)).rejects.toThrow();
    expect(
      authority
        .prepare(
          "SELECT count(*) FROM authority_readable_search_active_generation",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });
});
