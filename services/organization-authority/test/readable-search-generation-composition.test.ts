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
import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  clearReadableSearchActiveGenerationV1,
  searchReadableSearchGenerationV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../src/adapters/security/file-organization-authority-signer.js";
import {
  createReadableSearchGenerationReconcilerV1,
  projectSnapshotRelatedAtomsV1,
  readableSearchGenerationContractV1,
} from "../src/composition/readable-search-generation-composition.js";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "../src/composition/verify-authority-state-lineage.js";

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
      clearReadableSearchActiveGenerationV1();
      expect(() =>
        searchReadableSearchGenerationV1({
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
        searchReadableSearchGenerationV1({
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

describe("related-atom snapshot projection", () => {
  const digest = (character: string) =>
    `sha256:${character.repeat(64)}` as Sha256Digest;
  const profile = Object.freeze({
    generation_adapter_id: "test-structured-output",
    model: "test-projector",
    timeout_ms: 1_000,
  });

  it("projects separately per complete visibility tuple and skips single-record segments", async () => {
    const first = digest("1");
    const second = digest("2");
    const third = digest("3");
    const fourth = digest("4");
    const fifth = digest("6");
    const sixth = digest("7");
    const single = digest("5");
    let projectorCalls = 0;
    const structured_output = {
      generate: async (input: { readonly user_prompt: string }) => {
        projectorCalls += 1;
        const atoms = (
          JSON.parse(input.user_prompt) as {
            readonly atoms: readonly { readonly atom_id: string; readonly text: string }[];
          }
        ).atoms;
        return {
          relationships: [
            {
              left_atom_id: atoms[0]!.atom_id,
              right_atom_id: atoms[1]!.atom_id,
              left_supporting_excerpt: atoms[0]!.text,
              right_supporting_excerpt: atoms[1]!.text,
            },
          ],
        };
      },
    };
    const atom = (
      atom_id: Sha256Digest,
      record_sha256: Sha256Digest,
      text: string,
      reviewer_principal_id: string | null,
      reviewer_membership_id: string | null,
    ) =>
      Object.freeze({
        atom_id,
        record_sha256,
        record_position: Number.parseInt(atom_id.slice(-1), 16),
        atom_order: 0,
        text,
        item_kind: "decision",
        policy_id: "organization-member-readable-person-v2",
        policy_contract_sha256: digest("a"),
        reviewer_principal_id,
        reviewer_membership_id,
      });
    const snapshot = {
      record_head: { position: 5, record_sha256: digest("f") },
      source_snapshot: {
        atoms: [
          atom(first, digest("b"), "first public condition", null, null),
          atom(second, digest("c"), "second public condition", null, null),
          {
            ...atom(third, digest("d"), "first private condition", "p1", "m1"),
            policy_id: "restricted-reviewer-person-v2",
            policy_contract_sha256: digest("8"),
          },
          {
            ...atom(fourth, digest("e"), "second private condition", "p1", "m1"),
            policy_id: "restricted-reviewer-person-v2",
            policy_contract_sha256: digest("8"),
          },
          {
            ...atom(fifth, digest("d"), "first second-reviewer condition", "p2", "m2"),
            policy_id: "restricted-reviewer-person-v2",
            policy_contract_sha256: digest("8"),
          },
          {
            ...atom(sixth, digest("e"), "second second-reviewer condition", "p2", "m2"),
            policy_id: "restricted-reviewer-person-v2",
            policy_contract_sha256: digest("8"),
          },
          {
            ...atom(single, digest("b"), "single-record segment", null, null),
            policy_contract_sha256: digest("9"),
          },
        ],
      },
    } as unknown as Parameters<
      typeof projectSnapshotRelatedAtomsV1
    >[0]["snapshot"];

    const result = await projectSnapshotRelatedAtomsV1({
      snapshot,
      projector: { structured_output, profile },
      signal: new AbortController().signal,
    });

    expect(result.record_head).toEqual(snapshot.record_head);
    expect(projectorCalls).toBe(3);
    expect(result.related_atom_pairs).toEqual([
      { left_atom_id: first, right_atom_id: second },
      { left_atom_id: third, right_atom_id: fourth },
      { left_atom_id: fifth, right_atom_id: sixth },
    ]);
  });

  it("binds enabled projector profile changes into the retrieval contract", () => {
    const first = readableSearchGenerationContractV1({
      related_atom_projector: profile,
    });
    const second = readableSearchGenerationContractV1({
      related_atom_projector: { ...profile, model: "different-projector" },
    });

    expect(first.retrieval_contract_sha256).not.toBe(
      second.retrieval_contract_sha256,
    );
  });

  it("attests each approved projector segment before forwarding its causal token", async () => {
    const first = digest("1");
    const second = digest("2");
    const exactHead = {
      authority_id: "authority-test",
      organization_id: "organization-test",
      state_lineage_id: "lineage-test",
      position: 2,
      record_sha256: digest("f"),
    };
    const snapshot = {
      record_head: { position: 2, record_sha256: digest("f") },
      exact_head: exactHead,
      source_snapshot: {
        atoms: [
          {
            atom_id: first,
            record_sha256: digest("b"),
            record_position: 1,
            atom_order: 0,
            text: "first approved condition",
            item_kind: "decision",
            policy_id: "organization-member-readable-person-v2",
            policy_contract_sha256: digest("a"),
            reviewer_principal_id: null,
            reviewer_membership_id: null,
          },
          {
            atom_id: second,
            record_sha256: digest("c"),
            record_position: 2,
            atom_order: 0,
            text: "second approved condition",
            item_kind: "decision",
            policy_id: "organization-member-readable-person-v2",
            policy_contract_sha256: digest("a"),
            reviewer_principal_id: null,
            reviewer_membership_id: null,
          },
        ],
      },
    } as unknown as Parameters<typeof projectSnapshotRelatedAtomsV1>[0]["snapshot"];
    const attestations: unknown[] = [];
    const transports: unknown[] = [];

    await projectSnapshotRelatedAtomsV1({
      snapshot,
      projector: {
        profile,
        approved_snapshot_attestor: {
          async attest(input) {
            attestations.push(input);
            return {
              operation_correlation: "projection_offer_nonce_0001",
              causal_token: "attested_snapshot_token_0001",
            };
          },
        },
        structured_output: {
          async generate(input) {
            transports.push(input.transport);
            return { relationships: [] };
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(attestations).toEqual([
      expect.objectContaining({
        exact_head: exactHead,
        visibility_segment_sha256: expect.stringMatching(/^sha256:/),
        content_sha256: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(transports).toEqual([
      {
        operation_correlation: "projection_offer_nonce_0001",
        predecessor_token: "attested_snapshot_token_0001",
      },
    ]);
  });

  it("projects only the newest deterministic 200-atom window without dropping lexical input", async () => {
    const seen: string[][] = [];
    const snapshot = {
      record_head: { position: 201, record_sha256: digest("f") },
      source_snapshot: {
        atoms: Array.from({ length: 201 }, (_, index) => {
          const position = index + 1;
          const atomId =
            `sha256:${position.toString(16).padStart(64, "0")}` as Sha256Digest;
          return {
            atom_id: atomId,
            record_sha256: digest(position % 2 === 0 ? "b" : "c"),
            record_position: position,
            atom_order: 0,
            text: `condition ${position}`,
            item_kind: "decision",
            policy_id: "organization-member-readable-person-v2",
            policy_contract_sha256: digest("a"),
            reviewer_principal_id: null,
            reviewer_membership_id: null,
          };
        }),
      },
    } as unknown as Parameters<
      typeof projectSnapshotRelatedAtomsV1
    >[0]["snapshot"];

    const result = await projectSnapshotRelatedAtomsV1({
      snapshot,
      projector: {
        profile,
        structured_output: {
          async generate(input: { readonly user_prompt: string }) {
            seen.push(
              (
                JSON.parse(input.user_prompt) as {
                  readonly atoms: readonly { readonly atom_id: string }[];
                }
              ).atoms.map((atom) => atom.atom_id),
            );
            return { relationships: [] };
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(seen).toHaveLength(1);
    expect(result.source_snapshot.atoms).toHaveLength(201);
    expect(seen[0]).toHaveLength(200);
    expect(seen[0]![0]).toBe(
      `sha256:${"c9".padStart(64, "0")}`,
    );
    expect(seen[0]![199]).toBe(
      `sha256:${"02".padStart(64, "0")}`,
    );
  });

  it("does not call the projector when newest atoms exceed its text window before two records fit", async () => {
    const snapshot = {
      record_head: { position: 3, record_sha256: digest("f") },
      source_snapshot: {
        atoms: [3, 2, 1].map((position) => ({
          atom_id:
            `sha256:${position.toString(16).padStart(64, "0")}` as Sha256Digest,
          record_sha256: digest(position % 2 === 0 ? "b" : "c"),
          record_position: position,
          atom_order: 0,
          text: "x".repeat(100_000),
          item_kind: "decision",
          policy_id: "organization-member-readable-person-v2",
          policy_contract_sha256: digest("a"),
          reviewer_principal_id: null,
          reviewer_membership_id: null,
        })),
      },
    } as unknown as Parameters<
      typeof projectSnapshotRelatedAtomsV1
    >[0]["snapshot"];
    let calls = 0;

    const result = await projectSnapshotRelatedAtomsV1({
      snapshot,
      projector: {
        profile,
        structured_output: {
          async generate() {
            calls += 1;
            return { relationships: [] };
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(0);
    expect(result.related_atom_pairs).toEqual([]);
  });
});
