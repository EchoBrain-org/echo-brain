import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
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
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
  warmReadableSearchActiveGenerationV1,
  type ReadableSearchAtomV1,
  type ReadableSearchLineagePlaneV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type Database from "better-sqlite3";
import { FileOrganizationAuthoritySigner } from "../adapters/security/file-organization-authority-signer.js";
import {
  ReadableSearchGenerationReconcilerV1,
  type ReadableSearchRecordHeadV1,
} from "./readable-search-generation-reconciler.js";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  stateLineageDatabaseManifestSha256V1,
  validateStateLineageDatabaseManifestV1,
  type StateLineageRoleV1,
  type StateLineageRootManifestV1,
} from "../state-lineage/state-lineage-manifest-v1.js";

export const READABLE_SEARCH_SOURCE_REVISION_V1 =
  "organization-authority-clean-readable-search-v1" as const;

const READABLE_SEARCH_ANALYZER_RELEASE_V3 = Object.freeze({
  schema_version: 3,
  kind: "echo-clean-readable-search-analyzer-release-v3",
  analyzer_id: "echo-unicode-alnum-decision-category-frequency-v3",
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

export interface ReadableSearchGenerationContractV1 {
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
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
export function readableSearchGenerationContractV1():
  ReadableSearchGenerationContractV1 {
  const organizationMemberPolicy =
    organizationMemberReadablePersonPolicyContractSha256();
  const restrictedReviewerPolicy =
    restrictedReviewerPersonPolicyContractSha256();
  const analyzerSource = sha256Digest(
    canonicalJson(READABLE_SEARCH_ANALYZER_RELEASE_V3),
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
          policy_id: "organization-member-readable-person-v2",
          policy_contract_sha256: organizationMemberPolicy,
          reader: "current-active-owner-or-employee-in-record-organization",
        },
        {
          policy_id: "restricted-reviewer-person-v2",
          policy_contract_sha256: restrictedReviewerPolicy,
          reader: "exact-current-approver-principal-and-membership-tenure",
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
        score: "sum-matched-term-frequency",
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
    organization_member_policy_contract_sha256: organizationMemberPolicy,
    restricted_reviewer_policy_contract_sha256: restrictedReviewerPolicy,
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

function recordHead(database: Database.Database): ReadableSearchRecordHeadV1 {
  const row = database
    .prepare(
      `SELECT position, record_sha256
         FROM organization_record_log
        ORDER BY position DESC
        LIMIT 1`,
    )
    .get() as
    | { readonly position: number; readonly record_sha256: Sha256Digest }
    | undefined;
  return row === undefined
    ? Object.freeze({ position: 0, record_sha256: null })
    : Object.freeze({ ...row });
}

function lineagePlane(
  root: StateLineageRootManifestV1,
  role: Extract<
    StateLineageRoleV1,
    "retrieval-facts" | "retrieval-content" | "retrieval-lexical"
  >,
  schemaSha256: Sha256Digest,
): ReadableSearchLineagePlaneV1 {
  const body = validateStateLineageDatabaseManifestV1({
    schema_version: 1,
    kind: STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
    role,
    authority_id: root.authority_id,
    organization_id: root.organization_id,
    state_lineage_id: root.state_lineage_id,
    database_schema_version:
      READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
    schema_sha256: schemaSha256,
    created_at: root.created_at,
    creating_artifact_revision: root.creating_artifact_revision,
  });
  return Object.freeze({
    database_schema_version:
      READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
    schema_sha256: schemaSha256,
    manifest_json: canonicalJson(body),
    manifest_sha256: stateLineageDatabaseManifestSha256V1(body),
  });
}

/**
 * Composes the verified record retrieval-source snapshot, immutable search
 * index builder, and the
 * single Authority publication pointer. It performs no provider IO.
 */
export function createReadableSearchGenerationReconcilerV1(input: {
  readonly state_directory: string;
  readonly root: StateLineageRootManifestV1;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly signer: FileOrganizationAuthoritySigner;
  /** Chosen with the active approval protocol; this runtime names no provider. */
  readonly policy_projectors: RecordPolicyFactProjectorRegistryV1;
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
    readableSearchPlaneBaselineSha256V1(
      READABLE_SEARCH_FACTS_BASELINE_V1,
    ),
  );
  const content = lineagePlane(
    input.root,
    "retrieval-content",
    readableSearchPlaneBaselineSha256V1(
      READABLE_SEARCH_CONTENT_BASELINE_V1,
    ),
  );
  const lexical = lineagePlane(
    input.root,
    "retrieval-lexical",
    readableSearchPlaneBaselineSha256V1(
      READABLE_SEARCH_LEXICAL_BASELINE_V1,
    ),
  );
  const sqliteVersion = (
    input.record.prepare("SELECT sqlite_version() AS version").get() as {
      readonly version: string;
    }
  ).version;

  return new ReadableSearchGenerationReconcilerV1({
    authority: input.authority,
    organization_id: input.root.organization_id,
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    read_record_head: () => recordHead(input.record),
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
          ),
      });
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
        organization_member_policy_contract_sha256:
          contract.organization_member_policy_contract_sha256,
        restricted_reviewer_policy_contract_sha256:
          contract.restricted_reviewer_policy_contract_sha256,
        analyzer: contract.analyzer,
        source_revision: contract.source_revision,
        builder_artifact_sha256: contract.builder_artifact_sha256,
        sqlite_version: sqliteVersion,
        atoms,
      });
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
    prepare_generation: (generation) =>
      warmReadableSearchActiveGenerationV1({
        state_directory: input.state_directory,
        active_generation: {
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
        },
      }),
    invalidate_generation: clearReadableSearchActiveGenerationV1,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
