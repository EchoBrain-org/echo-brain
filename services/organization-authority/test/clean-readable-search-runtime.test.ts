import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openOrganizationRecordDatabase } from "@echo-brain/organization-record/new-lineage-v1";
import {
  clearCleanReadableSearchActiveGenerationV1,
  searchCleanReadableSearchGenerationV1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { DevelopmentFileOrganizationAuthoritySigner } from "../src/adapters/security/development-file-authority-signer.js";
import { createCleanReadableSearchGenerationReconcilerV1 } from "../src/composition/clean-readable-search-runtime.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";
import { verifyCleanStateLineage } from "../src/composition/verify-clean-state-lineage.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-search-runtime-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("clean readable-search runtime composition", () => {
  it("publishes the zero-head generation once and leaves a restart-verifiable pointer", async () => {
    const parent = root();
    const initialized = initializeCleanResetState({
      state_directory: join(parent, "state"),
      organization_display_name: "Clean Search Organization",
      owner_display_name: "Founder",
      created_at: "2026-08-22T12:00:00.000Z",
      creating_artifact_revision: "clean-search-runtime-test",
    });
    const lineage = verifyCleanStateLineage(initialized.state_directory);
    const authority = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      const reconciler = createCleanReadableSearchGenerationReconcilerV1({
        state_directory: initialized.state_directory,
        root: lineage.root,
        authority,
        record,
        signer: DevelopmentFileOrganizationAuthoritySigner.openExisting({
          directory: join(initialized.state_directory, "keys"),
          authority_id: initialized.authority_id,
          organization_id: initialized.organization_id,
        }),
        now: () => "2026-08-22T12:01:00.000Z",
      });
      const first = await reconciler.reconcile(new AbortController().signal);
      expect(first).toMatchObject({
        status: "published",
        record_head: { position: 0, record_sha256: null },
      });
      const pointer = authority
        .prepare(
          `SELECT generation_id, manifest_sha256,
                  retrieval_contract_sha256, record_head_position,
                  record_head_hash, published_at
             FROM authority_readable_search_active_generation
            WHERE singleton = 1`,
        )
        .get() as Record<string, unknown>;
      expect(pointer).toMatchObject({
        generation_id:
          first.status === "published" ? first.generation_id : undefined,
        manifest_sha256:
          first.status === "published" ? first.manifest_sha256 : undefined,
        record_head_position: 0,
        record_head_hash: null,
        published_at: "2026-08-22T12:01:00.000Z",
      });
      const generations = readdirSync(
        join(
          initialized.state_directory,
          "record-retrieval",
          "generations",
        ),
      );
      expect(generations).toEqual([pointer.generation_id]);

      const active_generation = {
        generation_id: pointer.generation_id as `sha256:${string}`,
        manifest_sha256: pointer.manifest_sha256 as `sha256:${string}`,
        retrieval_contract_sha256:
          pointer.retrieval_contract_sha256 as `sha256:${string}`,
        exact_head: {
          authority_id: initialized.authority_id,
          organization_id: initialized.organization_id,
          state_lineage_id: lineage.root.state_lineage_id,
          position: 0,
          record_sha256: null,
        },
      };
      clearCleanReadableSearchActiveGenerationV1();
      expect(() =>
        searchCleanReadableSearchGenerationV1({
          state_directory: initialized.state_directory,
          active_generation,
          reader: { principal_id: "restart", membership_id: "restart" },
          query: "restart",
        }),
      ).toThrow("active-generation handle is unavailable");
      expect(
        await reconciler.reconcile(new AbortController().signal),
      ).toMatchObject({
        status: "current",
        record_head: { position: 0, record_sha256: null },
      });
      expect(
        searchCleanReadableSearchGenerationV1({
          state_directory: initialized.state_directory,
          active_generation,
          reader: { principal_id: "restart", membership_id: "restart" },
          query: "restart",
        }).items,
      ).toEqual([]);
      expect(
        readdirSync(
          join(
            initialized.state_directory,
            "record-retrieval",
            "generations",
          ),
        ),
      ).toEqual(generations);

      const restartVerification = verifyCleanStateLineage(
        initialized.state_directory,
      );
      expect(restartVerification.retrieval).toEqual({
        present: true,
        generation_count: 1,
        segment_count: 1,
      });
    } finally {
      record.close();
      authority.close();
    }
  });
});
