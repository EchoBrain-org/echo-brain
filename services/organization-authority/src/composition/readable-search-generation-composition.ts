import { HUMAN_ACT_RECORD_INPUT_CODECS_V4, type RecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { currentCoreRuntimeDetailV1, coreRuntimeIdentityV1, annotateCoreRuntimeV1, observeCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
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
  READABLE_SEARCH_FACTS_BASELINE_V2,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  READABLE_SEARCH_BM25_B,
  READABLE_SEARCH_BM25_K1,
  READABLE_SEARCH_SCORE_SCALE,
  READABLE_SEARCH_SCORER_ID,
  readableSearchPlaneBaselineSha256,
  readableSearchPlaneBaselineSha256V1,
  warmReadableSearchActiveGenerationV1,
  type ReadableSearchAtomV1,
  type ReadableSearchLineagePlaneV1,
  type ReadableSearchRelatedAtomPairV1,
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
  type StateLineageRootManifest,
} from "@echo-brain/organization-authority-kernel/state-lineage/state-lineage-manifest-v1";
import {
  MAX_RELATED_ATOM_CANDIDATES_V1,
  MAX_RELATED_ATOM_LINKS_PER_ATOM_V1,
  MAX_RELATED_ATOM_LINKS_TOTAL_V1,
  MAX_RELATED_ATOM_SOURCE_ATOMS_V1,
  MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1,
  MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1,
  RELATED_ATOM_PROJECTOR_CORE_RELEASE_SHA256_V1,
  RELATED_ATOM_PROJECTOR_MAX_OUTPUT_TOKENS_V1,
  projectRelatedAtomsV1,
  type RelatedAtomPairV1,
  type RelatedAtomStructuredGenerationPortV1,
} from "./related-atom-projector-v1.js";

export const READABLE_SEARCH_SOURCE_REVISION_V1 =
  "organization-authority-clean-readable-search-v2" as const;

/**
 * This release is intentionally explicit in the retrieval contract. The
 * generated pairs are disposable, but a prompt, validation, or bound change
 * must rebuild them rather than leaving an old adjacency list current.
 */
export const READABLE_SEARCH_RELATED_ATOM_PROJECTOR_RELEASE_V1 = Object.freeze({
  schema_version: 1,
  kind: "echo-related-atom-projector-release-v1",
  core_release_sha256: RELATED_ATOM_PROJECTOR_CORE_RELEASE_SHA256_V1,
  cross_record_only: true,
  source_atom_limit: MAX_RELATED_ATOM_SOURCE_ATOMS_V1,
  source_text_utf8_bytes_limit: MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1,
  minimum_supporting_excerpt_length:
    MIN_RELATED_ATOM_SUPPORTING_EXCERPT_LENGTH_V1,
  candidate_limit: MAX_RELATED_ATOM_CANDIDATES_V1,
  links_per_atom_limit: MAX_RELATED_ATOM_LINKS_PER_ATOM_V1,
  links_total_limit: MAX_RELATED_ATOM_LINKS_TOTAL_V1,
  max_output_tokens: RELATED_ATOM_PROJECTOR_MAX_OUTPUT_TOKENS_V1,
  source_selection:
    "newest-record-position-desc-atom-order-asc-atom-id-asc-first-200",
});

/** Non-secret selected model profile for the disposable Layer 2 projector. */
export interface ReadableSearchRelatedAtomProjectorProfileV1 {
  readonly generation_adapter_id: string;
  readonly model: string;
  readonly timeout_ms: number;
}

/** Provider-neutral projector seam. It receives only already-approved atoms. */
export interface ReadableSearchRelatedAtomProjectorBindingV1 {
  readonly structured_output: RelatedAtomStructuredGenerationPortV1;
  readonly profile: ReadableSearchRelatedAtomProjectorProfileV1;
}

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
export function readableSearchGenerationContractV1(input: Readonly<{
  readonly related_atom_projector?: ReadableSearchRelatedAtomProjectorProfileV1;
}> = {}):
  ReadableSearchGenerationContractV1 {
  const organizationMemberPolicy =
    organizationMemberReadablePersonPolicyContractSha256();
  const restrictedReviewerPolicy =
    restrictedReviewerPersonPolicyContractSha256();
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
  const relatedAtomProjector =
    input.related_atom_projector === undefined
      ? Object.freeze({
          state: "disabled" as const,
          release: READABLE_SEARCH_RELATED_ATOM_PROJECTOR_RELEASE_V1,
        })
      : Object.freeze({
          state: "enabled" as const,
          release: READABLE_SEARCH_RELATED_ATOM_PROJECTOR_RELEASE_V1,
          generation_adapter_id:
            input.related_atom_projector.generation_adapter_id,
          model: input.related_atom_projector.model,
          timeout_ms: input.related_atom_projector.timeout_ms,
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
      related_atom_projector: relatedAtomProjector,
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
  /** Validated, policy-segment-local, disposable Layer 2 pairs. */
  readonly related_atom_pairs?: readonly ReadableSearchRelatedAtomPairV1[];
}

const observedSegmentInputs = new WeakMap<object, Map<string, string>>();

// Process-local validated results, not observed fingerprints or pending work.
// Each binding retains at most 32 digests and bounded endpoint-pair lists; no
// source text is retained. Runtime composition gives each reconciler its own binding.
const MAX_RETAINED_PROJECTIONS = 32;
const projectionResults = new WeakMap<ReadableSearchRelatedAtomProjectorBindingV1, {
  readonly port: RelatedAtomStructuredGenerationPortV1;
  readonly entries: Map<Sha256Digest, readonly RelatedAtomPairV1[]>;
}>();

function visibilitySegmentKey(atom: RecordRetrievalSourceSnapshotV1["atoms"][number]): string {
  return canonicalJson({
    policy_id: atom.policy_id,
    policy_contract_sha256: atom.policy_contract_sha256,
    reviewer_principal_id: atom.reviewer_principal_id,
    reviewer_membership_id: atom.reviewer_membership_id,
  });
}

/**
 * Runs projection after the verified snapshot transaction has closed. Each
 * request contains exactly one authorization-equivalent visibility segment,
 * so a returned relationship can never bridge a private-review boundary.
 */
export async function projectSnapshotRelatedAtomsV1(input: {
  readonly snapshot: ReconciliationSnapshotV1;
  readonly projector: ReadableSearchRelatedAtomProjectorBindingV1;
  readonly signal: AbortSignal;
}): Promise<ReconciliationSnapshotV1> {
  input.signal.throwIfAborted();
  let retained = projectionResults.get(input.projector);
  if (retained === undefined || retained.port !== input.projector.structured_output) {
    retained = { port: input.projector.structured_output, entries: new Map() };
    projectionResults.set(input.projector, retained);
  }
  const segments = new Map<
    string,
    RecordRetrievalSourceSnapshotV1["atoms"][number][]
  >();
  for (const atom of input.snapshot.source_snapshot.atoms) {
    const key = visibilitySegmentKey(atom);
    const segment = segments.get(key);
    if (segment === undefined) segments.set(key, [atom]);
    else segment.push(atom);
  }
  const observing = currentCoreRuntimeDetailV1() !== null;
  const previous = observing ? observedSegmentInputs.get(input.projector) ?? new Map<string, string>() : new Map<string, string>();
  let recomputed = 0, reused = 0, unchanged = 0, changed = 0, newlyObserved = 0;
  annotateCoreRuntimeV1({ counts: { visibility_groups: segments.size, reused_count: 0 } });
  let included = 0;
  let excluded = 0;
  const pairs: ReadableSearchRelatedAtomPairV1[] = [];
  for (const [segmentKey, atoms] of segments) {
    input.signal.throwIfAborted();
    // The search builder can retain more atoms than one bounded projection
    // call. Keep its full lexical corpus, but choose the newest deterministic
    // window for the disposable link pass.
    const newestFirst = [...atoms]
      .sort(
        (left, right) =>
          right.record_position - left.record_position ||
          left.atom_order - right.atom_order ||
          left.atom_id.localeCompare(right.atom_id),
      );
    const selected: typeof newestFirst = [];
    let selectedTextBytes = 0;
    for (const atom of newestFirst) {
      if (selected.length === MAX_RELATED_ATOM_SOURCE_ATOMS_V1) break;
      const textBytes = Buffer.byteLength(atom.text, "utf8");
      if (
        selectedTextBytes + textBytes >
        MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1
      ) {
        break;
      }
      selected.push(atom);
      selectedTextBytes += textBytes;
    }
    if (new Set(selected.map((atom) => atom.record_sha256)).size < 2) { excluded += atoms.length; continue; }
    if (observing) {
      const fingerprint = coreRuntimeIdentityV1("projection_input", JSON.stringify(selected.map((atom) => atom.atom_id)));
      const prior = previous.get(segmentKey);
      if (prior === undefined) newlyObserved += 1;
      else if (prior === fingerprint) unchanged += 1;
      else changed += 1;
      previous.set(segmentKey, fingerprint);
    }
    included += selected.length;
    excluded += atoms.length - selected.length;
    // Include the complete visibility tuple, verified provenance and ordered
    // selected input, plus every processor/prompt/profile contract. A newer
    // global head alone does not change an otherwise identical segment.
    const resultKey = canonicalSha256({
      release: READABLE_SEARCH_RELATED_ATOM_PROJECTOR_RELEASE_V1,
      profile: input.projector.profile,
      segment: segmentKey,
      atoms: selected,
    });
    let projected = retained.entries.get(resultKey);
    if (projected === undefined) {
      recomputed += 1;
      projected = await projectRelatedAtomsV1({
        atoms: selected.map((atom) =>
          Object.freeze({
            atom_id: atom.atom_id,
            record_id: atom.record_sha256,
            item_kind: atom.item_kind,
            text: atom.text,
          }),
        ),
        model: input.projector.profile.model,
        structured_output: input.projector.structured_output,
        timeout_ms: input.projector.profile.timeout_ms,
        signal: input.signal,
      });
      // An abort-ignoring provider must settle, but its cancelled work is never
      // cached or reported as reusable success.
      input.signal.throwIfAborted();
      retained.entries.set(resultKey, projected);
      if (retained.entries.size > MAX_RETAINED_PROJECTIONS) {
        retained.entries.delete(retained.entries.keys().next().value!);
      }
    } else {
      reused += 1;
      retained.entries.delete(resultKey);
      retained.entries.set(resultKey, projected);
      const cached = projected;
      await observeCoreRuntimeV1("related_projection", async () => {
        annotateCoreRuntimeV1({ counts: { reused_count: 1, recomputed_count: 0, included_count: cached.length } });
      });
      input.signal.throwIfAborted();
    }
    const admittedAtomIds = new Map<string, Sha256Digest>(
      selected.map((atom) => [atom.atom_id, atom.atom_id]),
    );
    for (const pair of projected) {
      const leftAtomId = admittedAtomIds.get(pair.left_atom_id);
      const rightAtomId = admittedAtomIds.get(pair.right_atom_id);
      if (leftAtomId === undefined || rightAtomId === undefined) {
        throw new Error("related atom projector returned an unadmitted atom ID");
      }
      pairs.push(
        Object.freeze({
          left_atom_id: leftAtomId,
          right_atom_id: rightAtomId,
        }),
      );
    }
  }
  if (observing) observedSegmentInputs.set(input.projector, previous);
  annotateCoreRuntimeV1({ counts: { included_count: included, excluded_count: excluded, recomputed_count: recomputed, reused_count: reused, unchanged_group_count: unchanged, changed_group_count: changed, newly_observed_group_count: newlyObserved } });
  return Object.freeze({
    ...input.snapshot,
    related_atom_pairs: Object.freeze(pairs),
  });
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
  root: StateLineageRootManifest,
  role: Extract<
    StateLineageRoleV1,
    "retrieval-facts" | "retrieval-content" | "retrieval-lexical"
  >,
  schemaSha256: Sha256Digest,
  databaseSchemaVersion: 1 | 2 =
    READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
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
 * index builder, and the single Authority publication pointer. Optional
 * provider IO stays behind the injected projector and runs only after the
 * verified snapshot transaction has closed.
 */
export function createReadableSearchGenerationReconcilerV1(input: {
  readonly record_input_codecs?: RecordInputCodecRegistryV4;
  readonly state_directory: string;
  readonly root: StateLineageRootManifest;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly signer: FileOrganizationAuthoritySigner;
  /** Chosen with the active approval protocol; this runtime names no provider. */
  readonly policy_projectors: RecordPolicyFactProjectorRegistryV1;
  /** Omitted only for pre-admission or provider-free local setup. */
  readonly related_atom_projector?: ReadableSearchRelatedAtomProjectorBindingV1;
  readonly now?: () => string;
}): ReadableSearchGenerationReconcilerV1<ReconciliationSnapshotV1> {
  const contract = readableSearchGenerationContractV1({
    ...(input.related_atom_projector === undefined
      ? {}
      : { related_atom_projector: input.related_atom_projector.profile }),
  });
  const descriptor = input.signer.inspectSync();
  const pinnedAuthority = verifyOrganizationAuthorityPin(
    descriptor,
    organizationAuthorityPinSha256(descriptor),
  );
  const snapshotPort = new RecordRetrievalSourceSnapshotPortV1(input.record);
  const facts = lineagePlane(
    input.root,
    "retrieval-facts",
    readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V2),
    READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V2,
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
  const relatedProjector = input.related_atom_projector === undefined
    ? undefined
    : Object.freeze({ ...input.related_atom_projector });

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
            input.record_input_codecs ?? HUMAN_ACT_RECORD_INPUT_CODECS_V4,
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
    ...(input.related_atom_projector === undefined
      ? {}
      : {
          enrich_snapshot: (snapshot: ReconciliationSnapshotV1, signal: AbortSignal) =>
            projectSnapshotRelatedAtomsV1({
              snapshot,
              projector: relatedProjector!,
              signal,
            }),
        }),
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
        related_atom_pairs: snapshot.related_atom_pairs,
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
