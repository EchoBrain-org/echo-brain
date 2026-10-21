import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  clearReadableSearchActiveGenerationV1,
  READABLE_SEARCH_SCORER_ID,
  searchReadableSearchGenerationV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { FileOrganizationAuthoritySigner } from "../src/adapters/security/file-organization-authority-signer.js";
import {
  createReadableSearchGenerationReconcilerV1,
  readableSearchGenerationContractV1,
} from "../src/composition/readable-search-generation-composition.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage";

vi.mock("@echo-brain/federation-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@echo-brain/federation-protocol")>();
  return { ...actual, canonicalSha256: vi.fn(actual.canonicalSha256) };
});

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

describe("readable-search generation composition", () => {
  it("binds the query scoring contract to the runtime BM25 scorer", () => {
    vi.mocked(canonicalSha256).mockClear();
    readableSearchGenerationContractV1();
    expect(canonicalSha256).toHaveBeenCalledWith(expect.objectContaining({
      kind: "echo-clean-permission-aware-readable-search-contract-v1",
      query: expect.objectContaining({ score: READABLE_SEARCH_SCORER_ID }),
    }));
  });

  it("publishes the zero-head generation once and leaves a restart-verifiable pointer", async () => {
    const parent = root();
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, "state"),
      organization_display_name: "Clean Search Organization",
      owner_display_name: "Founder",
      created_at: "2026-08-22T12:00:00.000Z",
      creating_artifact_revision: "clean-search-runtime-test",
    });
    const lineage = verifyAuthorityStateLineage(initialized.state_directory);
    const authority = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      const reconciler = createReadableSearchGenerationReconcilerV1({
        state_directory: initialized.state_directory,
        root: lineage.root,
        authority,
        record,
        signer: FileOrganizationAuthoritySigner.openExisting({
          directory: join(initialized.state_directory, "keys"),
          authority_id: initialized.authority_id,
          organization_id: initialized.organization_id,
        }),
        policy_projectors: createRecordPolicyFactProjectorRegistryV1([
          createPersonPolicyFactProjectorV2(),
        ]),
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
      const generationsDirectory = join(
        initialized.state_directory,
        "record-retrieval",
        "generations",
      );
      const generations = readdirSync(generationsDirectory);
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
      const restartSearch = () =>
        searchReadableSearchGenerationV1({
          state_directory: initialized.state_directory,
          active_generation,
          reader: { principal_id: "restart", membership_id: "restart" },
          query: "restart",
        });
      // A warm unchanged generation is not re-read; after a clear it is.
      const generationDirectory = join(generationsDirectory, String(pointer.generation_id));
      renameSync(generationDirectory, join(parent, "hidden"));
      expect(await reconciler.reconcile(new AbortController().signal)).toMatchObject({ status: "current" });
      expect(restartSearch().items).toEqual([]);
      clearReadableSearchActiveGenerationV1();
      await expect(reconciler.reconcile(new AbortController().signal)).rejects.toThrow("generation is missing");
      renameSync(join(parent, "hidden"), generationDirectory);
      expect(restartSearch).toThrow("active-generation handle is unavailable");
      expect(
        await reconciler.reconcile(new AbortController().signal),
      ).toMatchObject({
        status: "current",
        record_head: { position: 0, record_sha256: null },
      });
      expect(restartSearch().items).toEqual([]);
      expect(readdirSync(generationsDirectory)).toEqual(generations);

      const restartVerification = verifyAuthorityStateLineage(
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
