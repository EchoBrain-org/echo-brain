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
  CleanV4Layer1SnapshotPort,
  type CleanV4Layer1Snapshot,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  buildCleanReadableSearchGenerationV1,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
  type CleanReadableSearchAtomV1,
  type CleanReadableSearchLineagePlaneV1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import type Database from "better-sqlite3";
import { DevelopmentFileOrganizationAuthoritySigner } from "../adapters/security/development-file-authority-signer.js";
import {
  CleanReadableSearchGenerationReconcilerV1,
  type CleanReadableSearchRecordHeadV1,
} from "./clean-readable-search-generation-reconciler.js";
import {
  STATE_LINEAGE_DATABASE_MANIFEST_V1_KIND,
  stateLineageDatabaseManifestSha256V1,
  validateStateLineageDatabaseManifestV1,
  type StateLineageRoleV1,
  type StateLineageRootManifestV1,
} from "../state-lineage/state-lineage-manifest-v1.js";

export const CLEAN_READABLE_SEARCH_SOURCE_REVISION_V1 =
  "organization-authority-clean-readable-search-v1" as const;

const CLEAN_READABLE_SEARCH_ANALYZER_RELEASE_V1 = Object.freeze({
  schema_version: 1,
  kind: "echo-clean-readable-search-analyzer-release-v1",
  analyzer_id: "echo-unicode-alnum-frequency-v1",
  input_normalization: "NFC",
  tokenization: "maximal-ecmascript-unicode-letter-or-number-runs",
  case_mapping: "locale-independent-string-lowercase",
  output_normalization: "NFC",
  document_term_occurrences: "retain-for-frequency",
  document_overlong_term_policy: "omit",
});

const CLEAN_READABLE_SEARCH_BUILDER_RELEASE_V1 = Object.freeze({
  schema_version: 1,
  kind: "echo-clean-readable-search-builder-release-v1",
  source_revision: CLEAN_READABLE_SEARCH_SOURCE_REVISION_V1,
  input: "verified-organization-record-envelope-v4-layer1-snapshot",
  output: "immutable-baseline-only-three-plane-generation-v1",
});

export interface CleanReadableSearchRuntimeContractV1 {
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
  readonly source_revision: typeof CLEAN_READABLE_SEARCH_SOURCE_REVISION_V1;
  readonly builder_artifact_sha256: Sha256Digest;
}

/** One current-only contract shared by clean generation publication and serving. */
export function cleanReadableSearchRuntimeContractV1(): CleanReadableSearchRuntimeContractV1 {
  const organizationMemberPolicy =
    organizationMemberReadablePersonPolicyContractSha256();
  const restrictedReviewerPolicy =
    restrictedReviewerPersonPolicyContractSha256();
  const analyzerSource = sha256Digest(
    canonicalJson(CLEAN_READABLE_SEARCH_ANALYZER_RELEASE_V1),
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
        score: "sum-matched-term-frequency",
        order: [
          "score-desc",
          "record-position-desc",
          "atom-order-asc",
          "atom-id-asc",
        ],
        maximum_items: 10,
      },
    }),
    organization_member_policy_contract_sha256: organizationMemberPolicy,
    restricted_reviewer_policy_contract_sha256: restrictedReviewerPolicy,
    analyzer,
    source_revision: CLEAN_READABLE_SEARCH_SOURCE_REVISION_V1,
    builder_artifact_sha256: sha256Digest(
      canonicalJson(CLEAN_READABLE_SEARCH_BUILDER_RELEASE_V1),
    ),
  });
}

interface ReconciliationSnapshotV1 {
  readonly record_head: CleanReadableSearchRecordHeadV1;
  readonly layer1: CleanV4Layer1Snapshot;
}

function recordHead(database: Database.Database): CleanReadableSearchRecordHeadV1 {
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
): CleanReadableSearchLineagePlaneV1 {
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
 * Composes the verified V4 Layer 1 snapshot, clean immutable builder, and the
 * single Authority publication pointer. It performs no provider IO.
 */
export function createCleanReadableSearchGenerationReconcilerV1(input: {
  readonly state_directory: string;
  readonly root: StateLineageRootManifestV1;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly signer: DevelopmentFileOrganizationAuthoritySigner;
  readonly now?: () => string;
}): CleanReadableSearchGenerationReconcilerV1<ReconciliationSnapshotV1> {
  const contract = cleanReadableSearchRuntimeContractV1();
  const descriptor = input.signer.inspectSync();
  const pinnedAuthority = verifyOrganizationAuthorityPin(
    descriptor,
    organizationAuthorityPinSha256(descriptor),
  );
  const snapshotPort = new CleanV4Layer1SnapshotPort(input.record);
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

  return new CleanReadableSearchGenerationReconcilerV1({
    authority: input.authority,
    organization_id: input.root.organization_id,
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    read_record_head: () => recordHead(input.record),
    capture_snapshot: (): ReconciliationSnapshotV1 => {
      const layer1 = snapshotPort.snapshot({
        authority_id: input.root.authority_id,
        organization_id: input.root.organization_id,
        state_lineage_id: input.root.state_lineage_id,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            pinnedAuthority,
            input.root.state_lineage_id,
          ),
      });
      const capturedHead: CleanReadableSearchRecordHeadV1 =
        layer1.head === null
          ? Object.freeze({ position: 0, record_sha256: null })
          : layer1.head;
      return Object.freeze({
        record_head: capturedHead,
        layer1,
      });
    },
    build_generation: (snapshot) => {
      const envelopeByPosition = new Map(
        snapshot.layer1.rows.map((row) => [
          row.position,
          row.envelope_sha256,
        ]),
      );
      const atoms: CleanReadableSearchAtomV1[] = snapshot.layer1.atoms.map(
        (atom) => {
          const envelopeSha256 = envelopeByPosition.get(atom.record_position);
          if (envelopeSha256 === undefined) {
            throw new Error(
              "clean readable-search atom has no verified V4 envelope",
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
      const built = buildCleanReadableSearchGenerationV1({
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
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
