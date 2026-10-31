import type { RecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { currentCoreRuntimeDetailV1, annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  restrictedReviewerPersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  verifyOrganizationAuthorityPin,
  verifyOrganizationRecordEnvelopeV4,
} from "@echo-brain/organization-protocol";
import {
  RecordRetrievalSourceSnapshotPortV1,
  type RecordPolicyFactProjectorRegistryV1,
  type RecordRetrievalSourceSnapshotV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  buildReadableSearchGenerationV1,
  clearReadableSearchActiveGenerationV1,
  READABLE_SEARCH_ADMISSION_BUDGET_V1,
  READABLE_SEARCH_READER_BEHAVIOR_V1,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  READABLE_SEARCH_BM25_B,
  READABLE_SEARCH_BM25_K1,
  READABLE_SEARCH_SCORE_SCALE,
  READABLE_SEARCH_SCORER_ID,
  readableSearchPlaneBaselineSha256,
  isReadableSearchActiveGenerationWarmV1,
  retireReadableSearchGenerationsV1,
  warmReadableSearchActiveGenerationV1,
  type ReadableSearchActiveGenerationV1,
  type ReadableSearchAtomV1,
  type ReadableSearchLineagePlaneV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type Database from "better-sqlite3";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import {
  ReadableSearchGenerationReconcilerV1,
  readReadableSearchRecordHeadV1,
  type BuiltReadableSearchGenerationV1,
  type ReadableSearchRecordHeadV1,
} from "./readable-search-generation-reconciler.js";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  stateLineageDatabaseManifestSha256V1,
  validateStateLineageDatabaseManifestV1,
  type StateLineageRoleV2,
  type StateLineageRootManifestV2,
} from "@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1";

const READABLE_SEARCH_SOURCE_REVISION_V1 =
  "organization-authority-clean-readable-search-v2" as const;

const READABLE_SEARCH_ANALYZER_RELEASE_V4 = Object.freeze({
  schema_version: 4,
  kind: "echo-clean-readable-search-analyzer-release-v4",
  analyzer_id: "echo-unicode-alnum-decision-category-bm25-v4",
  input_normalization: "NFC",
  tokenization: "maximal-ecmascript-unicode-letter-or-number-runs",
  case_mapping: "locale-independent-string-lowercase",
  output_normalization: "NFC",
  document_term_occurrences: "retain-for-frequency",
  document_overlong_term_policy: "omit",
  query_expansion: {
    kind: "closed-exact-term-family-v1",
    family: ["decision", "decisions", "decide", "decided", "deciding"],
    trigger: "any-exact-family-term",
    caller_term_limit: 32,
    generated_family_terms_count_outside_caller_limit: true,
  },
  decision_item_category_index: {
    source: "admitted-item-kind",
    item_kind: "decision",
    term: "decision",
    term_frequency: 1,
  },
  scoring: {
    scorer_id: READABLE_SEARCH_SCORER_ID,
    formula: "okapi-bm25-fixed-point",
    k1: READABLE_SEARCH_BM25_K1,
    b: READABLE_SEARCH_BM25_B,
    idf: "ln(1 + (N - df + 0.5) / (df + 0.5))",
    score_scale: READABLE_SEARCH_SCORE_SCALE,
    statistics_scope: "union-of-segments-admitted-to-the-reader",
    controlled_terms: {
      family: ["decision", "decisions", "decide", "decided", "deciding"],
      weight: "constant-one-unit-no-idf",
    },
    tie_break: "score-desc,log_position-desc,atom_order-asc,atom_id-bytes",
  },
});

const READABLE_SEARCH_BUILDER_RELEASE_V1 = Object.freeze({
  schema_version: 1,
  kind: "echo-clean-readable-search-builder-release-v1",
  source_revision: READABLE_SEARCH_SOURCE_REVISION_V1,
  input: "verified-organization-record-envelope-v4-layer1-snapshot",
  output: "immutable-baseline-only-three-plane-generation-v1",
  admission_budget: READABLE_SEARCH_ADMISSION_BUDGET_V1,
  reader_behavior: READABLE_SEARCH_READER_BEHAVIOR_V1,
});

interface ReadableSearchGenerationContractV1 {
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
  readonly project_members_policy_contract_sha256: Sha256Digest;
  readonly analyzer: {
    readonly analyzer_contract_sha256: Sha256Digest;
    readonly analyzer_source_sha256: Sha256Digest;
    readonly node_version: string;
    readonly unicode_version: string;
    readonly icu_version: string;
  };
  readonly source_revision: typeof READABLE_SEARCH_SOURCE_REVISION_V1;
  readonly builder_artifact_sha256: Sha256Digest;
}

/** One current-only contract shared by current generation publication and serving. */
export function readableSearchGenerationContractV1(): ReadableSearchGenerationContractV1 {
  const restrictedReviewerPolicy =
    restrictedReviewerPersonPolicyContractSha256();
  const projectMembersPolicy = projectMembersReadablePersonPolicyContractSha256();
  const analyzerSource = sha256Digest(
    canonicalJson(READABLE_SEARCH_ANALYZER_RELEASE_V4),
  );
  const analyzer = Object.freeze({
    analyzer_contract_sha256: canonicalSha256({
      schema_version: 1,
      kind: "echo-clean-readable-search-analyzer-contract-v1",
      release_sha256: analyzerSource,
    }),
    analyzer_source_sha256: analyzerSource,
    node_version: process.versions.node,
    unicode_version: process.versions.unicode ?? "unknown",
    icu_version: process.versions.icu ?? "unknown",
  });
  return Object.freeze({
    retrieval_contract_sha256: canonicalSha256({
      schema_version: 1,
      kind: "echo-clean-permission-aware-readable-search-contract-v1",
      analyzer,
      policies: [
        {
          policy_id: "project-members-readable-person-v1",
          policy_contract_sha256: projectMembersPolicy,
          reader: "current-active-member-of-any-audience-project",
          scope: "selected-project-requires-current-membership-and-record-association",
        },
        {
          policy_id: "restricted-reviewer-person-v2",
          policy_contract_sha256: restrictedReviewerPolicy,
          reader: "exact-current-approver-principal-and-membership-tenure",
          // Its approver may file it in projects (ADR-0049), so a project scope narrows it as it narrows a project record.
          scope: "selected-project-requires-current-membership-and-record-association",
        },
      ],
      query: {
        match: "any-unique-query-term",
        exact_term_family_recall: [
          "decision",
          "decisions",
          "decide",
          "decided",
          "deciding",
        ],
        decision_item_category_term: "decision",
        score: READABLE_SEARCH_SCORER_ID,
        order: [
          "score-desc",
          "record-position-desc",
          "atom-order-asc",
          "atom-id-asc",
        ],
        maximum_items: 10,
      },
      admission_budget: READABLE_SEARCH_ADMISSION_BUDGET_V1,
      reader_behavior: READABLE_SEARCH_READER_BEHAVIOR_V1,
    }),
    restricted_reviewer_policy_contract_sha256: restrictedReviewerPolicy,
    project_members_policy_contract_sha256: projectMembersPolicy,
    analyzer,
    source_revision: READABLE_SEARCH_SOURCE_REVISION_V1,
    builder_artifact_sha256: sha256Digest(
      canonicalJson(READABLE_SEARCH_BUILDER_RELEASE_V1),
    ),
  });
}

interface ReconciliationSnapshotV1 {
  readonly record_head: ReadableSearchRecordHeadV1;
  readonly source_snapshot: RecordRetrievalSourceSnapshotV1;
}

function lineagePlane(
  root: StateLineageRootManifestV2,
  role: Extract<
    StateLineageRoleV2,
    "retrieval-facts" | "retrieval-content" | "retrieval-lexical"
  >,
  schemaSha256: Sha256Digest,
  databaseSchemaVersion: 2 | 3,
): ReadableSearchLineagePlaneV1 {
  const body = validateStateLineageDatabaseManifestV1({
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    authority_id: root.authority_id,
    organization_id: root.organization_id,
    state_lineage_id: root.state_lineage_id,
    database_schema_version: databaseSchemaVersion,
    schema_sha256: schemaSha256,
    created_at: root.created_at,
    creating_artifact_revision: root.creating_artifact_revision,
  });
  return Object.freeze({
    database_schema_version: databaseSchemaVersion,
    schema_sha256: schemaSha256,
    manifest_json: canonicalJson(body),
    manifest_sha256: stateLineageDatabaseManifestSha256V1(body),
  });
}

/**
 * Composes the verified record retrieval-source snapshot, immutable search
 * index builder, and the single Authority publication pointer. A rebuild
 * reads approved records only and makes no model call.
 */
export function createReadableSearchGenerationReconcilerV1(input: {
  /** The record codecs the Authority appends with; every stored envelope is verified through them. */
  readonly record_input_codecs: RecordInputCodecRegistryV4;
  readonly state_directory: string;
  readonly root: StateLineageRootManifestV2;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly signer: FileOrganizationAuthoritySigner;
  /** Chosen with the active approval protocol; this runtime names no provider. */
  readonly policy_projectors: RecordPolicyFactProjectorRegistryV1;
  /** Observational only: deleting replaced generations failed after a publication. */
  readonly on_retire_failure?: (error: unknown) => void;
  readonly now?: () => string;
}): ReadableSearchGenerationReconcilerV1<ReconciliationSnapshotV1> {
  const contract = readableSearchGenerationContractV1();
  const descriptor = input.signer.inspectSync();
  const pinnedAuthority = verifyOrganizationAuthorityPin(
    descriptor,
    organizationAuthorityPinSha256(descriptor),
  );
  const snapshotPort = new RecordRetrievalSourceSnapshotPortV1(input.record);
  const facts = lineagePlane(
    input.root,
    "retrieval-facts",
    readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3),
    READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  );
  const content = lineagePlane(
    input.root,
    "retrieval-content",
    readableSearchPlaneBaselineSha256(
      READABLE_SEARCH_CONTENT_BASELINE_V2,
    ),
    READABLE_SEARCH_CONTENT_BASELINE_V2.schema_version,
  );
  const lexical = lineagePlane(
    input.root,
    "retrieval-lexical",
    readableSearchPlaneBaselineSha256(
      READABLE_SEARCH_LEXICAL_BASELINE_V2,
    ),
    READABLE_SEARCH_LEXICAL_BASELINE_V2.schema_version,
  );
  const sqliteVersion = (
    input.record.prepare("SELECT sqlite_version() AS version").get() as {
      readonly version: string;
    }
  ).version;
  const activeGeneration = (
    generation: BuiltReadableSearchGenerationV1,
  ): ReadableSearchActiveGenerationV1 => ({
    generation_id: generation.generation_id,
    manifest_sha256: generation.manifest_sha256,
    retrieval_contract_sha256: generation.retrieval_contract_sha256,
    exact_head: {
      authority_id: input.root.authority_id,
      organization_id: input.root.organization_id,
      state_lineage_id: input.root.state_lineage_id,
      position: generation.record_head.position,
      record_sha256: generation.record_head.record_sha256,
    },
  });

  return new ReadableSearchGenerationReconcilerV1({
    authority: input.authority,
    organization_id: input.root.organization_id,
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    read_record_head: () => readReadableSearchRecordHeadV1(input.record),
    capture_snapshot: (): ReconciliationSnapshotV1 => {
      const sourceSnapshot = snapshotPort.snapshot({
        authority_id: input.root.authority_id,
        organization_id: input.root.organization_id,
        state_lineage_id: input.root.state_lineage_id,
        policy_projectors: input.policy_projectors,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            pinnedAuthority,
            input.root.state_lineage_id,
            input.record_input_codecs,
          ),
      });
      if (currentCoreRuntimeDetailV1() !== null) {
        try { annotateCoreRuntimeV1({ counts: { record_count: sourceSnapshot.rows.length, atom_count: sourceSnapshot.atoms.length, input_bytes: Buffer.byteLength(JSON.stringify(sourceSnapshot)) } }); }
        catch { annotateCoreRuntimeV1({ counts: { input_bytes: null } }); }
      }
      const capturedHead: ReadableSearchRecordHeadV1 =
        sourceSnapshot.head === null
          ? Object.freeze({ position: 0, record_sha256: null })
          : sourceSnapshot.head;
      return Object.freeze({
        record_head: capturedHead,
        source_snapshot: sourceSnapshot,
      });
    },
    build_generation: (snapshot) => {
      const envelopeByPosition = new Map(
        snapshot.source_snapshot.rows.map((row) => [
          row.position,
          row.envelope_sha256,
        ]),
      );
      const atoms: ReadableSearchAtomV1[] = snapshot.source_snapshot.atoms.map(
        (atom) => {
          const envelopeSha256 = envelopeByPosition.get(atom.record_position);
          if (envelopeSha256 === undefined) {
            throw new Error(
              "readable-search atom has no verified V4 envelope",
            );
          }
          return Object.freeze({
            authority_id: atom.authority_id,
            organization_id: atom.organization_id,
            state_lineage_id: atom.state_lineage_id,
            record_position: atom.record_position,
            record_sha256: atom.record_sha256,
            envelope_sha256: envelopeSha256,
            approval_id: atom.approval_id,
            atom_id: atom.atom_id,
            atom_order: atom.atom_order,
            signal_id_sha256: atom.signal_id_sha256,
            item_kind: atom.item_kind,
            text: atom.text,
            text_sha256: sha256Digest(atom.text),
            policy_id: atom.policy_id,
            policy_contract_sha256: atom.policy_contract_sha256,
            authorization_audit_event_id: atom.audit_event_id,
            authorization_audit_sequence: atom.audit_sequence,
            authorization_audit_entry_sha256: atom.audit_entry_sha256,
            provider_action_sha256: atom.provider_action_sha256,
            authorization_proof_sha256: atom.authorization_proof_sha256,
            reviewer_principal_id: atom.reviewer_principal_id,
            reviewer_membership_id: atom.reviewer_membership_id,
            ...(atom.audience_project_ids === undefined ? {} : { audience_project_ids: atom.audience_project_ids }),
            ...(atom.association_project_ids === undefined ? {} : { association_project_ids: atom.association_project_ids }),
          });
        },
      );
      const built = buildReadableSearchGenerationV1({
        state_directory: input.state_directory,
        lineage: {
          authority_id: input.root.authority_id,
          organization_id: input.root.organization_id,
          state_lineage_id: input.root.state_lineage_id,
          planes: { facts, content, lexical },
        },
        exact_head: {
          authority_id: input.root.authority_id,
          organization_id: input.root.organization_id,
          state_lineage_id: input.root.state_lineage_id,
          ...snapshot.record_head,
        },
        retrieval_contract_sha256: contract.retrieval_contract_sha256,
        restricted_reviewer_policy_contract_sha256:
          contract.restricted_reviewer_policy_contract_sha256,
        project_members_policy_contract_sha256: contract.project_members_policy_contract_sha256,
        analyzer: contract.analyzer,
        source_revision: contract.source_revision,
        builder_artifact_sha256: contract.builder_artifact_sha256,
        sqlite_version: sqliteVersion,
        atoms,
      });
      if (currentCoreRuntimeDetailV1() !== null) {
        try {
          const bytes = readdirSync(built.generation_directory, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile()).reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0);
          annotateCoreRuntimeV1({ counts: { output_bytes: bytes } });
        } catch { annotateCoreRuntimeV1({ counts: { output_bytes: null } }); }
      }
      return Object.freeze({
        generation_id: built.manifest.generation_id,
        manifest_sha256: built.manifest_sha256,
        retrieval_contract_sha256:
          built.manifest.retrieval_contract_sha256,
        record_head: Object.freeze({
          position: built.manifest.exact_head.position,
          record_sha256: built.manifest.exact_head.record_sha256,
        }),
      });
    },
    is_generation_warm: (generation) =>
      isReadableSearchActiveGenerationWarmV1(activeGeneration(generation)),
    prepare_generation: (generation) =>
      warmReadableSearchActiveGenerationV1({
        state_directory: input.state_directory,
        active_generation: activeGeneration(generation),
      }),
    invalidate_generation: clearReadableSearchActiveGenerationV1,
    retire_generations: (generation_id) => {
      retireReadableSearchGenerationsV1({
        state_directory: input.state_directory,
        keep_generation_id: generation_id,
      });
    },
    ...(input.on_retire_failure === undefined ? {} : { on_retire_failure: input.on_retire_failure }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
