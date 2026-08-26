import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  analyzeReadableSearchDocument,
  analyzeReadableSearchQuery,
  compareReadableSearchCandidates,
} from "./application/analyzer.js";
import {
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  applyReadableSearchPlaneBaselineV1,
  readableSearchPlaneBaselineSha256V1,
  type ReadableSearchPlaneBaselineV1,
} from "./persistence/baseline.js";
import { openReadableSearchPlane } from "./persistence/open-readable-search-plane.js";

/** The only policies accepted by the clean multi-person retrieval lineage. */
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 =
  "organization-member-readable-person-v2" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 =
  "restricted-reviewer-person-v2" as const;
export type CleanReadableSearchPolicyIdV1 =
  | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2
  | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
type Plane = "facts" | "content" | "lexical";
type SegmentKind = "organization-member" | "reviewer";

/**
 * Lean V1 admission ceiling. The values leave room for roughly one thousand
 * approved signal atoms while bounding every collection traversed by the
 * synchronous reader. Validation happens before retrieval staging is touched.
 */
export const CLEAN_READABLE_SEARCH_ADMISSION_BUDGET_V1 = Object.freeze({
  maximum_atoms: 1_024,
  maximum_segments: 32,
  maximum_atom_text_utf8_bytes: 4_096,
  maximum_postings: 16_384,
});

export const CLEAN_READABLE_SEARCH_READER_BEHAVIOR_V1 = Object.freeze({
  active_generation_cache_entries: 1,
  cache_miss: "bounded-unavailable",
  request_segments: "member-plus-exact-reviewer-tuple",
  validation: "complete-before-publication-or-current-status",
});

export interface CleanReadableSearchLineagePlaneV1 {
  readonly database_schema_version: 1;
  readonly schema_sha256: Sha256Digest;
  /** Canonical state-lineage database manifest for this exact plane role. */
  readonly manifest_json: string;
  readonly manifest_sha256: Sha256Digest;
}
export interface CleanReadableSearchLineageV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly planes: Readonly<{
    facts: CleanReadableSearchLineagePlaneV1;
    content: CleanReadableSearchLineagePlaneV1;
    lexical: CleanReadableSearchLineagePlaneV1;
  }>;
}
export interface CleanReadableSearchExactHeadV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly position: number;
  readonly record_sha256: Sha256Digest | null;
}
/** Fully materialized Layer 1 item. This package never opens Authority or record state. */
export interface CleanReadableSearchAtomV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly approval_id: string;
  readonly atom_id: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: "decision" | "action" | "rationale";
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  readonly policy_id: CleanReadableSearchPolicyIdV1;
  readonly policy_contract_sha256: Sha256Digest;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_sequence: number;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
}
export interface CleanReadableSearchAnalyzerV1 {
  readonly analyzer_contract_sha256: Sha256Digest;
  readonly analyzer_source_sha256: Sha256Digest;
  readonly node_version: string;
  readonly unicode_version: string;
  readonly icu_version: string;
}
export interface BuildCleanReadableSearchGenerationV1Input {
  readonly state_directory: string;
  readonly lineage: CleanReadableSearchLineageV1;
  readonly exact_head: CleanReadableSearchExactHeadV1;
  readonly retrieval_contract_sha256: Sha256Digest;
  /** Exact current policy contracts, committed even when a segment is empty. */
  readonly organization_member_policy_contract_sha256: Sha256Digest;
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
  readonly analyzer: CleanReadableSearchAnalyzerV1;
  readonly source_revision: string;
  readonly builder_artifact_sha256: Sha256Digest;
  readonly sqlite_version: string;
  readonly atoms: readonly CleanReadableSearchAtomV1[];
}
export interface CleanReadableSearchSegmentManifestV1 {
  readonly schema_version: 1;
  readonly kind: "clean-readable-search-segment-manifest-v1";
  readonly segment_id: Sha256Digest;
  readonly segment_kind: SegmentKind;
  readonly policy_id: CleanReadableSearchPolicyIdV1;
  readonly policy_contract_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly facts_root: Sha256Digest;
  readonly content_root: Sha256Digest;
  readonly lexical_root: Sha256Digest;
  readonly fact_count: number;
  readonly content_count: number;
  readonly document_count: number;
  readonly posting_count: number;
}
export interface CleanReadableSearchGenerationManifestV1 {
  readonly schema_version: 1;
  readonly kind: "clean-readable-search-generation-manifest-v1";
  readonly generation_id: Sha256Digest;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly exact_head: CleanReadableSearchExactHeadV1;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly policies: readonly [
    Readonly<{
      policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2;
      policy_contract_sha256: Sha256Digest;
    }>,
    Readonly<{
      policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
      policy_contract_sha256: Sha256Digest;
    }>,
  ];
  readonly input_root: Sha256Digest;
  readonly source_revision: string;
  readonly builder_artifact_sha256: Sha256Digest;
  readonly analyzer: CleanReadableSearchAnalyzerV1;
  readonly index: {
    readonly format_version: 1;
    readonly sqlite_version: string;
  };
  readonly roots: Readonly<{
    facts_root: Sha256Digest;
    content_root: Sha256Digest;
    lexical_root: Sha256Digest;
  }>;
  readonly segments: readonly Readonly<{
    segment_id: Sha256Digest;
    segment_manifest_sha256: Sha256Digest;
    facts_root: Sha256Digest;
    content_root: Sha256Digest;
    lexical_root: Sha256Digest;
  }>[];
}
export interface BuiltCleanReadableSearchGenerationV1 {
  readonly generation_directory: string;
  readonly manifest: CleanReadableSearchGenerationManifestV1;
  readonly manifest_sha256: Sha256Digest;
}

const RETRIEVAL_DIRECTORY = "record-retrieval";
const GENERATIONS_DIRECTORY = "generations";
const SEGMENTS_DIRECTORY = "segments";
const STAGING_DIRECTORY = /^\.staging-[0-9a-f]{32}$/;
const MANIFEST_TABLE = "echo_state_lineage_manifest";
const PLANES: readonly Plane[] = ["facts", "content", "lexical"];
const digest = (value: string): Sha256Digest => sha256Digest(value);
function validDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error(`${label} must be a sha256 digest`);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    throw new Error(`${label} must be non-empty bounded text`);
}
function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${label} must be a positive safe integer`);
}
function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}
function ensurePrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o700 ||
    resolve(path) !== path
  )
    throw new Error(`${label} must be a current-user 0700 canonical directory`);
}
function assertPrivateFile(path: string, label: string): void {
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o600 ||
    resolve(path) !== path
  )
    throw new Error(`${label} must be a current-user 0600 canonical file`);
}
function assertWithin(path: string, parent: string, label: string): void {
  const difference = relative(parent, path);
  if (difference === "" || difference === ".." || difference.startsWith("../"))
    throw new Error(`${label} escapes its parent`);
}
function writePrivateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function baselineFor(plane: Plane): ReadableSearchPlaneBaselineV1 {
  if (plane === "facts") return READABLE_SEARCH_FACTS_BASELINE_V1;
  if (plane === "content") return READABLE_SEARCH_CONTENT_BASELINE_V1;
  return READABLE_SEARCH_LEXICAL_BASELINE_V1;
}

function policyBranch(atom: CleanReadableSearchAtomV1): SegmentKind {
  if (atom.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2) {
    if (
      atom.reviewer_principal_id !== null ||
      atom.reviewer_membership_id !== null
    )
      throw new Error("member atom must not carry a reviewer tuple");
    return "organization-member";
  }
  if (atom.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2) {
    text(atom.reviewer_principal_id, "reviewer_principal_id");
    text(atom.reviewer_membership_id, "reviewer_membership_id");
    return "reviewer";
  }
  throw new Error("clean retrieval atom policy is unsupported");
}
function assertAtom(
  atom: CleanReadableSearchAtomV1,
  input: BuildCleanReadableSearchGenerationV1Input,
): void {
  if (
    atom.authority_id !== input.lineage.authority_id ||
    atom.organization_id !== input.lineage.organization_id ||
    atom.state_lineage_id !== input.lineage.state_lineage_id
  )
    throw new Error(
      "clean retrieval atom lineage disagrees with generation lineage",
    );
  positive(atom.record_position, "record_position");
  if (atom.record_position > input.exact_head.position)
    throw new Error("clean retrieval atom is beyond exact head");
  if (
    atom.record_position === input.exact_head.position &&
    atom.record_sha256 !== input.exact_head.record_sha256
  ) {
    throw new Error("clean retrieval atom disagrees with exact head record");
  }
  nonNegative(atom.atom_order, "atom_order");
  positive(atom.authorization_audit_sequence, "authorization_audit_sequence");
  text(atom.approval_id, "approval_id");
  text(atom.authorization_audit_event_id, "authorization_audit_event_id");
  for (const [value, label] of [
    [atom.record_sha256, "record_sha256"],
    [atom.envelope_sha256, "envelope_sha256"],
    [atom.atom_id, "atom_id"],
    [atom.signal_id_sha256, "signal_id_sha256"],
    [atom.text_sha256, "text_sha256"],
    [atom.policy_contract_sha256, "policy_contract_sha256"],
    [atom.authorization_audit_entry_sha256, "authorization_audit_entry_sha256"],
    [atom.provider_action_sha256, "provider_action_sha256"],
    [atom.authorization_proof_sha256, "authorization_proof_sha256"],
  ] as const)
    validDigest(value, label);
  if (digest(atom.text) !== atom.text_sha256)
    throw new Error("clean retrieval atom text does not bind text_sha256");
  const branch = policyBranch(atom);
  const expected =
    branch === "organization-member"
      ? input.organization_member_policy_contract_sha256
      : input.restricted_reviewer_policy_contract_sha256;
  if (atom.policy_contract_sha256 !== expected)
    throw new Error(
      "clean retrieval atom policy contract disagrees with current policy",
    );
}
function segmentIdentity(
  lineage: CleanReadableSearchLineageV1,
  policy_id: CleanReadableSearchPolicyIdV1,
  policy_contract_sha256: Sha256Digest,
  reviewer_principal_id: string | null,
  reviewer_membership_id: string | null,
): { segment_id: Sha256Digest; segment_kind: SegmentKind } {
  const segment_kind =
    policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2
      ? "organization-member"
      : "reviewer";
  return {
    segment_kind,
    segment_id: canonicalSha256({
      schema_version: 1,
      kind: "clean-readable-search-segment-identity-v1",
      authority_id: lineage.authority_id,
      organization_id: lineage.organization_id,
      state_lineage_id: lineage.state_lineage_id,
      segment_kind,
      policy_id,
      policy_contract_sha256,
      reviewer_principal_id,
      reviewer_membership_id,
    }),
  };
}
function contentBinding(atom: CleanReadableSearchAtomV1): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-content-binding-v1",
    authority_id: atom.authority_id,
    organization_id: atom.organization_id,
    state_lineage_id: atom.state_lineage_id,
    record_position: atom.record_position,
    record_sha256: atom.record_sha256,
    envelope_sha256: atom.envelope_sha256,
    approval_id: atom.approval_id,
    atom_id: atom.atom_id,
    atom_order: atom.atom_order,
    signal_id_sha256: atom.signal_id_sha256,
    item_kind: atom.item_kind,
    text_sha256: atom.text_sha256,
  });
}
function provenanceBinding(atom: CleanReadableSearchAtomV1): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-provenance-binding-v1",
    authority_id: atom.authority_id,
    organization_id: atom.organization_id,
    state_lineage_id: atom.state_lineage_id,
    record_position: atom.record_position,
    record_sha256: atom.record_sha256,
    envelope_sha256: atom.envelope_sha256,
    approval_id: atom.approval_id,
    policy_id: atom.policy_id,
    policy_contract_sha256: atom.policy_contract_sha256,
    authorization_audit_event_id: atom.authorization_audit_event_id,
    authorization_audit_sequence: atom.authorization_audit_sequence,
    authorization_audit_entry_sha256: atom.authorization_audit_entry_sha256,
    provider_action_sha256: atom.provider_action_sha256,
    authorization_proof_sha256: atom.authorization_proof_sha256,
    reviewer_principal_id: atom.reviewer_principal_id,
    reviewer_membership_id: atom.reviewer_membership_id,
  });
}
function stampLineageManifest(
  database: Database.Database,
  plane: Plane,
  lineage: CleanReadableSearchLineageV1,
): void {
  const metadata = lineage.planes[plane];
  validDigest(metadata.schema_sha256, `${plane} schema_sha256`);
  validDigest(metadata.manifest_sha256, `${plane} manifest_sha256`);
  if (
    metadata.schema_sha256 !==
    readableSearchPlaneBaselineSha256V1(baselineFor(plane))
  )
    throw new Error(
      `${plane} lineage schema digest does not match clean baseline`,
    );
  if (
    digest(metadata.manifest_json) !== metadata.manifest_sha256 ||
    canonicalJson(JSON.parse(metadata.manifest_json) as never) !==
      metadata.manifest_json
  )
    throw new Error(`${plane} lineage manifest is not canonical`);
  const body = JSON.parse(metadata.manifest_json) as Record<string, unknown>;
  if (
    body.role !== `retrieval-${plane}` ||
    body.authority_id !== lineage.authority_id ||
    body.organization_id !== lineage.organization_id ||
    body.state_lineage_id !== lineage.state_lineage_id ||
    body.database_schema_version !== 1 ||
    body.schema_sha256 !== metadata.schema_sha256
  )
    throw new Error(`${plane} lineage manifest is not bound to the generation`);
  database.exec(
    `CREATE TABLE ${MANIFEST_TABLE} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL) STRICT`,
  );
  database
    .prepare(
      `INSERT INTO ${MANIFEST_TABLE} (singleton, manifest_json, manifest_sha256) VALUES (1, ?, ?)`,
    )
    .run(metadata.manifest_json, metadata.manifest_sha256);
}
function initializePlane(
  database: Database.Database,
  plane: Plane,
  identity: ReturnType<typeof segmentIdentity>,
  policy_id: CleanReadableSearchPolicyIdV1,
  policy_contract_sha256: Sha256Digest,
  reviewer_principal_id: string | null,
  reviewer_membership_id: string | null,
  lineage: CleanReadableSearchLineageV1,
  analyzer: CleanReadableSearchAnalyzerV1,
): void {
  applyReadableSearchPlaneBaselineV1(database, baselineFor(plane));
  stampLineageManifest(database, plane, lineage);
  database
    .prepare(
      `INSERT INTO retrieval_plane_metadata (singleton, schema_version, plane, organization_id, segment_id, segment_kind, policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id, analyzer_contract_sha256, finalized) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      plane,
      lineage.organization_id,
      identity.segment_id,
      identity.segment_kind,
      policy_id,
      policy_contract_sha256,
      reviewer_principal_id,
      reviewer_membership_id,
      analyzer.analyzer_contract_sha256,
    );
}
function rows(
  database: Database.Database,
  sql: string,
): readonly Record<string, unknown>[] {
  return database.prepare(sql).all() as readonly Record<string, unknown>[];
}
function root(
  kind: string,
  segment_id: Sha256Digest,
  values: readonly Record<string, unknown>[],
): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind, segment_id, rows: values });
}
function buildSegment(
  staging: string,
  lineage: CleanReadableSearchLineageV1,
  analyzer: CleanReadableSearchAnalyzerV1,
  policy_id: CleanReadableSearchPolicyIdV1,
  policy_contract_sha256: Sha256Digest,
  reviewer_principal_id: string | null,
  reviewer_membership_id: string | null,
  atoms: readonly CleanReadableSearchAtomV1[],
): CleanReadableSearchGenerationManifestV1["segments"][number] {
  const identity = segmentIdentity(
    lineage,
    policy_id,
    policy_contract_sha256,
    reviewer_principal_id,
    reviewer_membership_id,
  );
  const directory = join(staging, SEGMENTS_DIRECTORY, identity.segment_id);
  ensurePrivateDirectory(directory, "clean retrieval segment directory");
  const databases = new Map<Plane, Database.Database>();
  try {
    for (const plane of PLANES) {
      const database = openReadableSearchPlane(
        join(directory, `${plane}.sqlite`),
      );
      databases.set(plane, database);
      initializePlane(
        database,
        plane,
        identity,
        policy_id,
        policy_contract_sha256,
        reviewer_principal_id,
        reviewer_membership_id,
        lineage,
        analyzer,
      );
    }
    const facts = databases.get("facts")!;
    const content = databases.get("content")!;
    const lexical = databases.get("lexical")!;
    for (const atom of atoms) {
      const content_binding_sha256 = contentBinding(atom);
      const provenance_binding_sha256 = provenanceBinding(atom);
      facts
        .prepare(
          `INSERT INTO retrieval_permission_fact (atom_id, authority_id, organization_id, state_lineage_id, envelope_sha256, log_position, record_hash, atom_order, signal_id_sha256, item_kind, approval_id, policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id, authorization_audit_event_id, authorization_audit_sequence, authorization_audit_entry_sha256, provider_action_sha256, authorization_proof_sha256, content_binding_sha256, provenance_binding_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          atom.atom_id,
          atom.authority_id,
          atom.organization_id,
          atom.state_lineage_id,
          atom.envelope_sha256,
          atom.record_position,
          atom.record_sha256,
          atom.atom_order,
          atom.signal_id_sha256,
          atom.item_kind,
          atom.approval_id,
          atom.policy_id,
          atom.policy_contract_sha256,
          atom.reviewer_principal_id,
          atom.reviewer_membership_id,
          atom.authorization_audit_event_id,
          atom.authorization_audit_sequence,
          atom.authorization_audit_entry_sha256,
          atom.provider_action_sha256,
          atom.authorization_proof_sha256,
          content_binding_sha256,
          provenance_binding_sha256,
        );
      content
        .prepare(
          `INSERT INTO retrieval_content_atom (atom_id, log_position, record_hash, atom_order, item_kind, text, text_sha256, content_binding_sha256, provenance_binding_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          atom.atom_id,
          atom.record_position,
          atom.record_sha256,
          atom.atom_order,
          atom.item_kind,
          atom.text,
          atom.text_sha256,
          content_binding_sha256,
          provenance_binding_sha256,
        );
      lexical
        .prepare(
          `INSERT INTO retrieval_lexical_document (atom_id, log_position, atom_order, content_binding_sha256) VALUES (?, ?, ?, ?)`,
        )
        .run(
          atom.atom_id,
          atom.record_position,
          atom.atom_order,
          content_binding_sha256,
        );
      for (const [term, term_frequency] of analyzeReadableSearchDocument(
        atom.text,
      ))
        lexical
          .prepare(
            "INSERT INTO retrieval_term_posting (term, atom_id, term_frequency) VALUES (?, ?, ?)",
          )
          .run(term, atom.atom_id, term_frequency);
    }
    const factRows = rows(
      facts,
      "SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id",
    );
    const contentRows = rows(
      content,
      "SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id",
    );
    const documents = rows(
      lexical,
      "SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id",
    );
    const postings = rows(
      lexical,
      "SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id",
    );
    const facts_root = root(
      "clean-readable-search-facts-root-v1",
      identity.segment_id,
      factRows,
    );
    const content_root = root(
      "clean-readable-search-content-root-v1",
      identity.segment_id,
      contentRows,
    );
    const lexical_root = canonicalSha256({
      schema_version: 1,
      kind: "clean-readable-search-lexical-root-v1",
      segment_id: identity.segment_id,
      documents,
      postings,
    });
    for (const database of databases.values())
      database
        .prepare(
          "UPDATE retrieval_plane_metadata SET finalized = 1 WHERE singleton = 1",
        )
        .run();
    const manifest: CleanReadableSearchSegmentManifestV1 = {
      schema_version: 1,
      kind: "clean-readable-search-segment-manifest-v1",
      segment_id: identity.segment_id,
      segment_kind: identity.segment_kind,
      policy_id,
      policy_contract_sha256,
      reviewer_principal_id,
      reviewer_membership_id,
      facts_root,
      content_root,
      lexical_root,
      fact_count: factRows.length,
      content_count: contentRows.length,
      document_count: documents.length,
      posting_count: postings.length,
    };
    writePrivateFile(
      join(directory, "segment-manifest.json"),
      canonicalJson(manifest),
    );
    return {
      segment_id: identity.segment_id,
      segment_manifest_sha256: canonicalSha256(manifest),
      facts_root,
      content_root,
      lexical_root,
    };
  } finally {
    for (const database of databases.values()) database.close();
    for (const plane of PLANES) {
      const path = join(directory, `${plane}.sqlite`);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    syncDirectory(directory);
  }
}
function inputRoot(
  input: BuildCleanReadableSearchGenerationV1Input,
): Sha256Digest {
  const atoms = [...input.atoms].sort(
    (left, right) =>
      left.record_position - right.record_position ||
      left.atom_order - right.atom_order ||
      Buffer.compare(Buffer.from(left.atom_id), Buffer.from(right.atom_id)),
  );
  return canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-input-root-v1",
    lineage: input.lineage,
    exact_head: input.exact_head,
    atoms,
  });
}

function assertWithinAdmissionBudget(
  input: BuildCleanReadableSearchGenerationV1Input,
): void {
  const budget = CLEAN_READABLE_SEARCH_ADMISSION_BUDGET_V1;
  if (input.atoms.length > budget.maximum_atoms)
    throw new Error("clean retrieval generation exceeds maximum_atoms");
  const segments = new Set<string>();
  segments.add(
    segmentIdentity(
      input.lineage,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
      input.organization_member_policy_contract_sha256,
      null,
      null,
    ).segment_id,
  );
  let postings = 0;
  for (const atom of input.atoms) {
    if (
      Buffer.byteLength(atom.text, "utf8") >
      budget.maximum_atom_text_utf8_bytes
    )
      throw new Error(
        "clean retrieval generation exceeds maximum_atom_text_utf8_bytes",
      );
    segments.add(
      segmentIdentity(
        input.lineage,
        atom.policy_id,
        atom.policy_contract_sha256,
        atom.reviewer_principal_id,
        atom.reviewer_membership_id,
      ).segment_id,
    );
    postings += analyzeReadableSearchDocument(atom.text).size;
    if (postings > budget.maximum_postings)
      throw new Error("clean retrieval generation exceeds maximum_postings");
  }
  if (segments.size > budget.maximum_segments)
    throw new Error("clean retrieval generation exceeds maximum_segments");
}

/** Builds one immutable Layer 2 generation solely from an exact materialized Layer 1 head. */
export function buildCleanReadableSearchGenerationV1(
  input: BuildCleanReadableSearchGenerationV1Input,
): BuiltCleanReadableSearchGenerationV1 {
  if (
    !resolve(input.state_directory).startsWith("/") ||
    resolve(input.state_directory) !== input.state_directory
  )
    throw new Error(
      "clean retrieval state_directory must be canonical absolute path",
    );
  text(input.lineage.authority_id, "authority_id");
  text(input.lineage.organization_id, "organization_id");
  text(input.lineage.state_lineage_id, "state_lineage_id");
  if (
    input.exact_head.authority_id !== input.lineage.authority_id ||
    input.exact_head.organization_id !== input.lineage.organization_id ||
    input.exact_head.state_lineage_id !== input.lineage.state_lineage_id
  )
    throw new Error("exact head lineage disagrees with generation lineage");
  nonNegative(input.exact_head.position, "exact_head.position");
  if (
    input.exact_head.position === 0
      ? input.exact_head.record_sha256 !== null
      : input.exact_head.record_sha256 === null
  )
    throw new Error("exact head record digest is invalid");
  if (input.exact_head.record_sha256 !== null)
    validDigest(input.exact_head.record_sha256, "exact_head.record_sha256");
  validDigest(input.retrieval_contract_sha256, "retrieval_contract_sha256");
  validDigest(
    input.organization_member_policy_contract_sha256,
    "organization_member_policy_contract_sha256",
  );
  validDigest(
    input.restricted_reviewer_policy_contract_sha256,
    "restricted_reviewer_policy_contract_sha256",
  );
  validDigest(input.builder_artifact_sha256, "builder_artifact_sha256");
  validDigest(
    input.analyzer.analyzer_contract_sha256,
    "analyzer_contract_sha256",
  );
  validDigest(input.analyzer.analyzer_source_sha256, "analyzer_source_sha256");
  const seen = new Set<string>();
  for (const atom of input.atoms) {
    assertAtom(atom, input);
    if (seen.has(atom.atom_id))
      throw new Error("duplicate clean retrieval atom identity");
    seen.add(atom.atom_id);
  }
  assertWithinAdmissionBudget(input);
  const root = join(input.state_directory, RETRIEVAL_DIRECTORY);
  const generations = join(root, GENERATIONS_DIRECTORY);
  ensurePrivateDirectory(
    input.state_directory,
    "clean retrieval state directory",
  );
  ensurePrivateDirectory(root, "clean retrieval root");
  ensurePrivateDirectory(generations, "clean retrieval generations directory");
  for (const name of readdirSync(generations))
    if (STAGING_DIRECTORY.test(name)) {
      const orphan = join(generations, name);
      assertWithin(orphan, generations, "clean retrieval staging");
      ensurePrivateDirectory(orphan, "clean retrieval staging");
      rmSync(orphan, { recursive: true, force: false });
    }
  const staging = join(
    generations,
    `.staging-${randomBytes(16).toString("hex")}`,
  );
  mkdirSync(staging, { mode: 0o700 });
  try {
    ensurePrivateDirectory(
      join(staging, SEGMENTS_DIRECTORY),
      "clean retrieval staging segments directory",
    );
    const groups = new Map<
      string,
      {
        policy_id: CleanReadableSearchPolicyIdV1;
        policy_contract_sha256: Sha256Digest;
        reviewer_principal_id: string | null;
        reviewer_membership_id: string | null;
        atoms: CleanReadableSearchAtomV1[];
      }
    >();
    const memberContract = input.organization_member_policy_contract_sha256;
    const member = segmentIdentity(
      input.lineage,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
      memberContract,
      null,
      null,
    );
    groups.set(member.segment_id, {
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
      policy_contract_sha256: memberContract,
      reviewer_principal_id: null,
      reviewer_membership_id: null,
      atoms: [],
    });
    for (const atom of input.atoms) {
      const identity = segmentIdentity(
        input.lineage,
        atom.policy_id,
        atom.policy_contract_sha256,
        atom.reviewer_principal_id,
        atom.reviewer_membership_id,
      );
      const group = groups.get(identity.segment_id);
      if (group === undefined)
        groups.set(identity.segment_id, {
          policy_id: atom.policy_id,
          policy_contract_sha256: atom.policy_contract_sha256,
          reviewer_principal_id: atom.reviewer_principal_id,
          reviewer_membership_id: atom.reviewer_membership_id,
          atoms: [atom],
        });
      else group.atoms.push(atom);
    }
    const groupsOrdered = [...groups.values()].sort((left, right) =>
      Buffer.compare(
        Buffer.from(
          segmentIdentity(
            input.lineage,
            left.policy_id,
            left.policy_contract_sha256,
            left.reviewer_principal_id,
            left.reviewer_membership_id,
          ).segment_id,
        ),
        Buffer.from(
          segmentIdentity(
            input.lineage,
            right.policy_id,
            right.policy_contract_sha256,
            right.reviewer_principal_id,
            right.reviewer_membership_id,
          ).segment_id,
        ),
      ),
    );
    const segments = groupsOrdered.map((group) =>
      buildSegment(
        staging,
        input.lineage,
        input.analyzer,
        group.policy_id,
        group.policy_contract_sha256,
        group.reviewer_principal_id,
        group.reviewer_membership_id,
        group.atoms,
      ),
    );
    const roots = {
      facts_root: canonicalSha256({
        schema_version: 1,
        kind: "clean-readable-search-generation-facts-root-v1",
        segments,
      }),
      content_root: canonicalSha256({
        schema_version: 1,
        kind: "clean-readable-search-generation-content-root-v1",
        segments,
      }),
      lexical_root: canonicalSha256({
        schema_version: 1,
        kind: "clean-readable-search-generation-lexical-root-v1",
        segments,
      }),
    };
    const policies: CleanReadableSearchGenerationManifestV1["policies"] = [
      {
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        policy_contract_sha256:
          input.organization_member_policy_contract_sha256,
      },
      {
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        policy_contract_sha256:
          input.restricted_reviewer_policy_contract_sha256,
      },
    ];
    const withoutIdentity = {
      schema_version: 1 as const,
      kind: "clean-readable-search-generation-manifest-v1" as const,
      authority_id: input.lineage.authority_id,
      organization_id: input.lineage.organization_id,
      state_lineage_id: input.lineage.state_lineage_id,
      exact_head: input.exact_head,
      retrieval_contract_sha256: input.retrieval_contract_sha256,
      policies,
      input_root: inputRoot(input),
      source_revision: input.source_revision,
      builder_artifact_sha256: input.builder_artifact_sha256,
      analyzer: input.analyzer,
      index: {
        format_version: 1 as const,
        sqlite_version: input.sqlite_version,
      },
      roots,
      segments,
    };
    const manifest: CleanReadableSearchGenerationManifestV1 = {
      ...withoutIdentity,
      generation_id: canonicalSha256({
        ...withoutIdentity,
        kind: "clean-readable-search-generation-identity-v1",
      }),
    };
    writePrivateFile(join(staging, "manifest.json"), canonicalJson(manifest));
    syncDirectory(staging);
    const finalDirectory = join(generations, manifest.generation_id);
    if (existsSync(finalDirectory)) {
      assertWithin(
        finalDirectory,
        generations,
        "existing clean retrieval generation",
      );
      ensurePrivateDirectory(
        finalDirectory,
        "existing clean retrieval generation",
      );
      const manifestPath = join(finalDirectory, "manifest.json");
      assertPrivateFile(manifestPath, "existing clean retrieval manifest");
      if (readFileSync(manifestPath, "utf8") !== canonicalJson(manifest))
        throw new Error(
          "existing clean retrieval generation differs under the same identity",
        );
      rmSync(staging, { recursive: true, force: true });
      return {
        generation_directory: finalDirectory,
        manifest,
        manifest_sha256: canonicalSha256(manifest),
      };
    }
    renameSync(staging, finalDirectory);
    syncDirectory(generations);
    return {
      generation_directory: finalDirectory,
      manifest,
      manifest_sha256: canonicalSha256(manifest),
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Exact immutable-generation identity published by Authority's active pointer. */
export interface CleanReadableSearchActiveGenerationV1 {
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly exact_head: CleanReadableSearchExactHeadV1;
}

export interface CleanReadableSearchReaderV1 {
  readonly principal_id: string;
  readonly membership_id: string;
}

export interface CleanReadableSearchResultItemV1 {
  readonly atom_id: Sha256Digest;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly item_kind: CleanReadableSearchAtomV1["item_kind"];
  readonly text: string;
  readonly policy_id: CleanReadableSearchPolicyIdV1;
}

export interface CleanReadableSearchResultV1 {
  readonly generation_id: Sha256Digest;
  readonly exact_head: CleanReadableSearchExactHeadV1;
  readonly items: readonly CleanReadableSearchResultItemV1[];
}

export interface SearchCleanReadableSearchGenerationV1Input {
  readonly state_directory: string;
  readonly active_generation: CleanReadableSearchActiveGenerationV1;
  readonly reader: CleanReadableSearchReaderV1;
  readonly query: string;
  /** Defaults to 10 and is deliberately bounded to the V1 response ceiling. */
  readonly limit?: number;
}

interface CleanFactRow {
  readonly atom_id: Sha256Digest;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: CleanReadableSearchAtomV1["item_kind"];
  readonly approval_id: string;
  readonly policy_id: CleanReadableSearchPolicyIdV1;
  readonly policy_contract_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_sequence: number;
  readonly authorization_audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

interface CleanContentRow {
  readonly atom_id: Sha256Digest;
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly atom_order: number;
  readonly item_kind: CleanReadableSearchAtomV1["item_kind"];
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
}

interface CleanLexicalDocumentRow {
  readonly atom_id: Sha256Digest;
  readonly log_position: number;
  readonly atom_order: number;
  readonly content_binding_sha256: Sha256Digest;
}

interface CleanTermPostingRow {
  readonly term: string;
  readonly atom_id: Sha256Digest;
  readonly term_frequency: number;
}

interface CleanSegmentRows {
  readonly manifest: CleanReadableSearchSegmentManifestV1;
  readonly facts: readonly CleanFactRow[];
  readonly content_by_atom: ReadonlyMap<Sha256Digest, CleanContentRow>;
  readonly postings: readonly CleanTermPostingRow[];
}

interface ValidatedActiveGenerationHandleV1 {
  readonly key: string;
  readonly manifest: CleanReadableSearchGenerationManifestV1;
  readonly segments: readonly CleanSegmentRows[];
}

let validatedActiveGenerationHandleV1: ValidatedActiveGenerationHandleV1 | null =
  null;

function activeGenerationKey(
  active: CleanReadableSearchActiveGenerationV1,
): string {
  return canonicalJson({
    generation_id: active.generation_id,
    manifest_sha256: active.manifest_sha256,
    retrieval_contract_sha256: active.retrieval_contract_sha256,
    exact_head: active.exact_head,
  });
}

/** Drops the sole process-local handle, primarily for shutdown and tests. */
export function clearCleanReadableSearchActiveGenerationV1(): void {
  validatedActiveGenerationHandleV1 = null;
}

function assertCanonicalAbsoluteDirectory(path: string, label: string): void {
  if (!resolve(path).startsWith("/") || resolve(path) !== path)
    throw new Error(`${label} must be a canonical absolute directory`);
  assertPrivateDirectory(path, label);
}

/** Read-only counterpart to the builder's directory initializer. */
function assertPrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const state = lstatSync(path);
  const uid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (uid !== undefined && state.uid !== uid) ||
    (state.mode & 0o777) !== 0o700 ||
    resolve(path) !== path
  )
    throw new Error(`${label} must be a current-user 0700 canonical directory`);
}

function readCanonicalPrivateJson(path: string, label: string): unknown {
  assertPrivateFile(path, label);
  const source = readFileSync(path, "utf8");
  const parsed = JSON.parse(source) as unknown;
  if (canonicalJson(parsed as never) !== source)
    throw new Error(`${label} must be canonical JSON`);
  return parsed;
}

function assertExactHead(
  value: CleanReadableSearchExactHeadV1,
  label: string,
): void {
  text(value.authority_id, `${label}.authority_id`);
  text(value.organization_id, `${label}.organization_id`);
  text(value.state_lineage_id, `${label}.state_lineage_id`);
  nonNegative(value.position, `${label}.position`);
  if (
    (value.position === 0 && value.record_sha256 !== null) ||
    (value.position > 0 && value.record_sha256 === null)
  )
    throw new Error(`${label} has an invalid empty/non-empty record digest`);
  if (value.record_sha256 !== null)
    validDigest(value.record_sha256, `${label}.record_sha256`);
}

function sameExactHead(
  left: CleanReadableSearchExactHeadV1,
  right: CleanReadableSearchExactHeadV1,
): boolean {
  return (
    left.authority_id === right.authority_id &&
    left.organization_id === right.organization_id &&
    left.state_lineage_id === right.state_lineage_id &&
    left.position === right.position &&
    left.record_sha256 === right.record_sha256
  );
}

function assertCleanGenerationManifest(
  value: unknown,
): asserts value is CleanReadableSearchGenerationManifestV1 {
  const manifest = value as Partial<CleanReadableSearchGenerationManifestV1>;
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== "clean-readable-search-generation-manifest-v1"
  )
    throw new Error("clean retrieval generation manifest kind is invalid");
  validDigest(manifest.generation_id, "generation_id");
  text(manifest.authority_id, "generation authority_id");
  text(manifest.organization_id, "generation organization_id");
  text(manifest.state_lineage_id, "generation state_lineage_id");
  assertExactHead(
    manifest.exact_head as CleanReadableSearchExactHeadV1,
    "generation exact_head",
  );
  validDigest(manifest.retrieval_contract_sha256, "retrieval_contract_sha256");
  validDigest(manifest.input_root, "generation input_root");
  validDigest(manifest.builder_artifact_sha256, "builder_artifact_sha256");
  if (!Array.isArray(manifest.policies) || manifest.policies.length !== 2)
    throw new Error("clean retrieval generation policies are invalid");
  const [member, reviewer] = manifest.policies;
  if (
    member?.policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 ||
    reviewer?.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2
  )
    throw new Error("clean retrieval generation policy order is invalid");
  validDigest(member.policy_contract_sha256, "member policy contract");
  validDigest(reviewer.policy_contract_sha256, "reviewer policy contract");
  if (
    manifest.analyzer === undefined ||
    manifest.analyzer.analyzer_contract_sha256 === undefined ||
    manifest.analyzer.analyzer_source_sha256 === undefined
  )
    throw new Error("clean retrieval generation analyzer is missing");
  validDigest(
    manifest.analyzer.analyzer_contract_sha256,
    "generation analyzer contract",
  );
  validDigest(
    manifest.analyzer.analyzer_source_sha256,
    "generation analyzer source",
  );
  if (
    manifest.index?.format_version !== 1 ||
    typeof manifest.index.sqlite_version !== "string"
  )
    throw new Error("clean retrieval generation index is invalid");
  for (const [label, value] of Object.entries(manifest.roots ?? {}))
    validDigest(value, `generation ${label}`);
  if (
    manifest.roots?.facts_root === undefined ||
    manifest.roots.content_root === undefined ||
    manifest.roots.lexical_root === undefined ||
    !Array.isArray(manifest.segments) ||
    manifest.segments.length === 0
  )
    throw new Error("clean retrieval generation roots or segments are missing");
  const { generation_id: _generationId, ...withoutIdentity } = manifest;
  if (
    canonicalSha256({
      ...withoutIdentity,
      kind: "clean-readable-search-generation-identity-v1",
    }) !== manifest.generation_id
  )
    throw new Error("clean retrieval generation identity is invalid");
}

function assertSegmentManifest(
  value: unknown,
): asserts value is CleanReadableSearchSegmentManifestV1 {
  const manifest = value as Partial<CleanReadableSearchSegmentManifestV1>;
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== "clean-readable-search-segment-manifest-v1" ||
    (manifest.segment_kind !== "organization-member" &&
      manifest.segment_kind !== "reviewer") ||
    (manifest.policy_id !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 &&
      manifest.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2)
  )
    throw new Error("clean retrieval segment manifest is invalid");
  validDigest(manifest.segment_id, "segment_id");
  validDigest(manifest.policy_contract_sha256, "segment policy contract");
  validDigest(manifest.facts_root, "segment facts root");
  validDigest(manifest.content_root, "segment content root");
  validDigest(manifest.lexical_root, "segment lexical root");
  for (const [value, label] of [
    [manifest.fact_count, "fact_count"],
    [manifest.content_count, "content_count"],
    [manifest.document_count, "document_count"],
    [manifest.posting_count, "posting_count"],
  ] as const)
    nonNegative(value, `segment ${label}`);
  if (
    (manifest.segment_kind === "organization-member" &&
      (manifest.policy_id !==
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 ||
        manifest.reviewer_principal_id !== null ||
        manifest.reviewer_membership_id !== null)) ||
    (manifest.segment_kind === "reviewer" &&
      (manifest.policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 ||
        typeof manifest.reviewer_principal_id !== "string" ||
        typeof manifest.reviewer_membership_id !== "string"))
  )
    throw new Error("clean retrieval segment policy and tuple disagree");
}

function rootForRead(
  kind: string,
  segment_id: Sha256Digest,
  values: readonly object[],
): Sha256Digest {
  return canonicalSha256({ schema_version: 1, kind, segment_id, rows: values });
}

function cleanContentBindingFromRows(
  fact: CleanFactRow,
  text_sha256: Sha256Digest,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-content-binding-v1",
    authority_id: fact.authority_id,
    organization_id: fact.organization_id,
    state_lineage_id: fact.state_lineage_id,
    record_position: fact.log_position,
    record_sha256: fact.record_hash,
    envelope_sha256: fact.envelope_sha256,
    approval_id: fact.approval_id,
    atom_id: fact.atom_id,
    atom_order: fact.atom_order,
    signal_id_sha256: fact.signal_id_sha256,
    item_kind: fact.item_kind,
    text_sha256,
  });
}

function cleanProvenanceBindingFromFact(fact: CleanFactRow): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-provenance-binding-v1",
    authority_id: fact.authority_id,
    organization_id: fact.organization_id,
    state_lineage_id: fact.state_lineage_id,
    record_position: fact.log_position,
    record_sha256: fact.record_hash,
    envelope_sha256: fact.envelope_sha256,
    approval_id: fact.approval_id,
    policy_id: fact.policy_id,
    policy_contract_sha256: fact.policy_contract_sha256,
    authorization_audit_event_id: fact.authorization_audit_event_id,
    authorization_audit_sequence: fact.authorization_audit_sequence,
    authorization_audit_entry_sha256: fact.authorization_audit_entry_sha256,
    provider_action_sha256: fact.provider_action_sha256,
    authorization_proof_sha256: fact.authorization_proof_sha256,
    reviewer_principal_id: fact.reviewer_principal_id,
    reviewer_membership_id: fact.reviewer_membership_id,
  });
}

function validateCleanPlaneLineage(
  database: Database.Database,
  plane: Plane,
  manifest: CleanReadableSearchGenerationManifestV1,
  segment: CleanReadableSearchSegmentManifestV1,
): void {
  const baseline = baselineFor(plane);
  if (
    database.pragma("application_id", { simple: true }) !==
      baseline.application_id ||
    database.pragma("user_version", { simple: true }) !== 1
  )
    throw new Error(
      `clean retrieval ${plane} plane baseline identity is invalid`,
    );
  if (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_schema_migrations'",
      )
      .get() !== undefined
  )
    throw new Error("clean retrieval plane must not have a migration ledger");
  const lineage = database
    .prepare(
      `SELECT manifest_json, manifest_sha256 FROM ${MANIFEST_TABLE} WHERE singleton = 1`,
    )
    .get() as
    { manifest_json: string; manifest_sha256: Sha256Digest } | undefined;
  if (
    lineage === undefined ||
    digest(lineage.manifest_json) !== lineage.manifest_sha256 ||
    canonicalJson(JSON.parse(lineage.manifest_json) as never) !==
      lineage.manifest_json
  )
    throw new Error(
      `clean retrieval ${plane} plane lineage manifest is invalid`,
    );
  const lineageBody = JSON.parse(lineage.manifest_json) as Record<
    string,
    unknown
  >;
  if (
    lineageBody.role !== `retrieval-${plane}` ||
    lineageBody.authority_id !== manifest.authority_id ||
    lineageBody.organization_id !== manifest.organization_id ||
    lineageBody.state_lineage_id !== manifest.state_lineage_id ||
    lineageBody.database_schema_version !== 1 ||
    lineageBody.schema_sha256 !== readableSearchPlaneBaselineSha256V1(baseline)
  )
    throw new Error(
      `clean retrieval ${plane} plane lineage is not generation-bound`,
    );
  const metadata = database
    .prepare(
      "SELECT schema_version, plane, organization_id, segment_id, segment_kind, policy_id, policy_contract_sha256, reviewer_principal_id, reviewer_membership_id, analyzer_contract_sha256, finalized FROM retrieval_plane_metadata WHERE singleton = 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (
    metadata === undefined ||
    metadata.schema_version !== 1 ||
    metadata.plane !== plane ||
    metadata.organization_id !== manifest.organization_id ||
    metadata.segment_id !== segment.segment_id ||
    metadata.segment_kind !== segment.segment_kind ||
    metadata.policy_id !== segment.policy_id ||
    metadata.policy_contract_sha256 !== segment.policy_contract_sha256 ||
    metadata.reviewer_principal_id !== segment.reviewer_principal_id ||
    metadata.reviewer_membership_id !== segment.reviewer_membership_id ||
    metadata.analyzer_contract_sha256 !==
      manifest.analyzer.analyzer_contract_sha256 ||
    metadata.finalized !== 1
  )
    throw new Error(`clean retrieval ${plane} plane metadata is invalid`);
}

function openCleanReadonlyPlane(
  path: string,
  label: string,
): Database.Database {
  assertPrivateFile(path, label);
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.pragma("trusted_schema = OFF");
    database.pragma("foreign_keys = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function readAndValidateCleanSegment(
  generationDirectory: string,
  generation: CleanReadableSearchGenerationManifestV1,
  entry: CleanReadableSearchGenerationManifestV1["segments"][number],
): CleanSegmentRows {
  validDigest(entry.segment_id, "generation segment_id");
  validDigest(entry.segment_manifest_sha256, "generation segment manifest");
  validDigest(entry.facts_root, "generation segment facts root");
  validDigest(entry.content_root, "generation segment content root");
  validDigest(entry.lexical_root, "generation segment lexical root");
  const directory = join(
    generationDirectory,
    SEGMENTS_DIRECTORY,
    entry.segment_id,
  );
  assertWithin(
    directory,
    join(generationDirectory, SEGMENTS_DIRECTORY),
    "segment",
  );
  assertPrivateDirectory(directory, "clean retrieval segment directory");
  const names = readdirSync(directory).sort();
  if (
    canonicalJson(names) !==
    canonicalJson([
      "content.sqlite",
      "facts.sqlite",
      "lexical.sqlite",
      "segment-manifest.json",
    ])
  )
    throw new Error("clean retrieval segment has undeclared entries");
  const segmentSource = readFileSync(
    join(directory, "segment-manifest.json"),
    "utf8",
  );
  const segmentValue = readCanonicalPrivateJson(
    join(directory, "segment-manifest.json"),
    "clean retrieval segment manifest",
  );
  assertSegmentManifest(segmentValue);
  const segment = segmentValue;
  if (
    digest(segmentSource) !== entry.segment_manifest_sha256 ||
    segment.segment_id !== entry.segment_id ||
    segment.facts_root !== entry.facts_root ||
    segment.content_root !== entry.content_root ||
    segment.lexical_root !== entry.lexical_root
  )
    throw new Error(
      "clean retrieval segment manifest does not match generation",
    );
  const policy = generation.policies.find(
    (value) => value.policy_id === segment.policy_id,
  );
  if (
    policy === undefined ||
    policy.policy_contract_sha256 !== segment.policy_contract_sha256
  )
    throw new Error("clean retrieval segment policy is not generation-bound");
  const expectedSegmentId = canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-segment-identity-v1",
    authority_id: generation.authority_id,
    organization_id: generation.organization_id,
    state_lineage_id: generation.state_lineage_id,
    segment_kind: segment.segment_kind,
    policy_id: segment.policy_id,
    policy_contract_sha256: segment.policy_contract_sha256,
    reviewer_principal_id: segment.reviewer_principal_id,
    reviewer_membership_id: segment.reviewer_membership_id,
  });
  if (expectedSegmentId !== segment.segment_id)
    throw new Error("clean retrieval segment identity is invalid");
  const databases = new Map<Plane, Database.Database>();
  try {
    for (const plane of PLANES) {
      const database = openCleanReadonlyPlane(
        join(directory, `${plane}.sqlite`),
        `clean retrieval ${plane} plane`,
      );
      databases.set(plane, database);
      validateCleanPlaneLineage(database, plane, generation, segment);
    }
    const facts = rows(
      databases.get("facts")!,
      "SELECT * FROM retrieval_permission_fact ORDER BY log_position, atom_order, atom_id",
    ) as unknown as readonly CleanFactRow[];
    const content = rows(
      databases.get("content")!,
      "SELECT * FROM retrieval_content_atom ORDER BY log_position, atom_order, atom_id",
    ) as unknown as readonly CleanContentRow[];
    const documents = rows(
      databases.get("lexical")!,
      "SELECT * FROM retrieval_lexical_document ORDER BY log_position, atom_order, atom_id",
    ) as unknown as readonly CleanLexicalDocumentRow[];
    const postings = rows(
      databases.get("lexical")!,
      "SELECT * FROM retrieval_term_posting ORDER BY CAST(term AS BLOB), atom_id",
    ) as unknown as readonly CleanTermPostingRow[];
    if (
      facts.length !== segment.fact_count ||
      content.length !== segment.content_count ||
      documents.length !== segment.document_count ||
      postings.length !== segment.posting_count ||
      rootForRead(
        "clean-readable-search-facts-root-v1",
        segment.segment_id,
        facts,
      ) !== segment.facts_root ||
      rootForRead(
        "clean-readable-search-content-root-v1",
        segment.segment_id,
        content,
      ) !== segment.content_root ||
      canonicalSha256({
        schema_version: 1,
        kind: "clean-readable-search-lexical-root-v1",
        segment_id: segment.segment_id,
        documents,
        postings,
      }) !== segment.lexical_root
    )
      throw new Error("clean retrieval segment plane roots are invalid");
    const contentByAtom = new Map(content.map((item) => [item.atom_id, item]));
    const documentByAtom = new Map(
      documents.map((item) => [item.atom_id, item]),
    );
    if (
      contentByAtom.size !== facts.length ||
      documentByAtom.size !== facts.length
    )
      throw new Error("clean retrieval segment has unbound rows");
    for (const fact of facts) {
      const item = contentByAtom.get(fact.atom_id);
      const document = documentByAtom.get(fact.atom_id);
      if (
        item === undefined ||
        document === undefined ||
        fact.authority_id !== generation.authority_id ||
        fact.organization_id !== generation.organization_id ||
        fact.state_lineage_id !== generation.state_lineage_id ||
        fact.policy_id !== segment.policy_id ||
        fact.policy_contract_sha256 !== segment.policy_contract_sha256 ||
        fact.reviewer_principal_id !== segment.reviewer_principal_id ||
        fact.reviewer_membership_id !== segment.reviewer_membership_id ||
        item.log_position !== fact.log_position ||
        item.record_hash !== fact.record_hash ||
        item.atom_order !== fact.atom_order ||
        item.item_kind !== fact.item_kind ||
        document.log_position !== fact.log_position ||
        document.atom_order !== fact.atom_order ||
        item.text_sha256 !== digest(item.text) ||
        item.content_binding_sha256 !== fact.content_binding_sha256 ||
        item.provenance_binding_sha256 !== fact.provenance_binding_sha256 ||
        document.content_binding_sha256 !== fact.content_binding_sha256 ||
        cleanContentBindingFromRows(fact, item.text_sha256) !==
          fact.content_binding_sha256 ||
        cleanProvenanceBindingFromFact(fact) !== fact.provenance_binding_sha256
      )
        throw new Error(
          "clean retrieval fact/content/lexical binding is invalid",
        );
    }
    return {
      manifest: segment,
      facts,
      content_by_atom: contentByAtom,
      postings,
    };
  } finally {
    for (const database of databases.values()) database.close();
  }
}

/**
 * Reads one active, immutable Layer 2 generation. It does not open Authority,
 * record, or a migration ledger, and it never creates or modifies state.
 */
function validateAndWarmCleanReadableSearchGenerationV1(
  input: SearchCleanReadableSearchGenerationV1Input,
): CleanReadableSearchResultV1 {
  assertCanonicalAbsoluteDirectory(
    input.state_directory,
    "clean retrieval state directory",
  );
  const active = input.active_generation;
  validDigest(active.generation_id, "active generation_id");
  validDigest(active.manifest_sha256, "active manifest_sha256");
  validDigest(active.retrieval_contract_sha256, "active retrieval contract");
  assertExactHead(active.exact_head, "active exact_head");
  text(input.reader.principal_id, "reader principal_id");
  text(input.reader.membership_id, "reader membership_id");
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error(
      "clean retrieval limit must be a safe integer from one through ten",
    );
  const terms = analyzeReadableSearchQuery(input.query);
  const generations = join(
    input.state_directory,
    RETRIEVAL_DIRECTORY,
    GENERATIONS_DIRECTORY,
  );
  assertCanonicalAbsoluteDirectory(
    generations,
    "clean retrieval generations directory",
  );
  const generationDirectory = join(generations, active.generation_id);
  assertWithin(generationDirectory, generations, "active generation");
  assertPrivateDirectory(
    generationDirectory,
    "active clean retrieval generation",
  );
  const entries = readdirSync(generationDirectory).sort();
  if (
    canonicalJson(entries) !==
    canonicalJson(["manifest.json", SEGMENTS_DIRECTORY])
  )
    throw new Error("active clean retrieval generation has undeclared entries");
  const manifestSource = readFileSync(
    join(generationDirectory, "manifest.json"),
    "utf8",
  );
  const manifestValue = readCanonicalPrivateJson(
    join(generationDirectory, "manifest.json"),
    "active clean retrieval manifest",
  );
  assertCleanGenerationManifest(manifestValue);
  const manifest = manifestValue;
  if (
    digest(manifestSource) !== active.manifest_sha256 ||
    manifest.generation_id !== active.generation_id ||
    manifest.retrieval_contract_sha256 !== active.retrieval_contract_sha256 ||
    !sameExactHead(manifest.exact_head, active.exact_head)
  )
    throw new Error(
      "active clean retrieval pointer does not bind this generation",
    );
  if (resolve(generationDirectory) !== generationDirectory)
    throw new Error("active clean retrieval generation is not canonical");
  const segmentDirectory = join(generationDirectory, SEGMENTS_DIRECTORY);
  assertPrivateDirectory(
    segmentDirectory,
    "clean retrieval segments directory",
  );
  const names = readdirSync(segmentDirectory).sort();
  const declared = manifest.segments
    .map((segment) => segment.segment_id)
    .sort();
  if (
    names.length !== declared.length ||
    names.some((name, index) => name !== declared[index])
  )
    throw new Error("active clean retrieval generation has mixed segments");
  const expectedRoots = {
    facts_root: canonicalSha256({
      schema_version: 1,
      kind: "clean-readable-search-generation-facts-root-v1",
      segments: manifest.segments,
    }),
    content_root: canonicalSha256({
      schema_version: 1,
      kind: "clean-readable-search-generation-content-root-v1",
      segments: manifest.segments,
    }),
    lexical_root: canonicalSha256({
      schema_version: 1,
      kind: "clean-readable-search-generation-lexical-root-v1",
      segments: manifest.segments,
    }),
  };
  if (
    expectedRoots.facts_root !== manifest.roots.facts_root ||
    expectedRoots.content_root !== manifest.roots.content_root ||
    expectedRoots.lexical_root !== manifest.roots.lexical_root
  )
    throw new Error("clean retrieval generation roots are invalid");
  const seenSegments = new Set<string>();
  const seenAtoms = new Set<string>();
  const validatedSegments: CleanSegmentRows[] = [];
  const admitted: CleanSegmentRows[] = [];
  for (const entry of manifest.segments) {
    if (seenSegments.has(entry.segment_id))
      throw new Error("clean retrieval generation repeats a segment");
    seenSegments.add(entry.segment_id);
    const segment = readAndValidateCleanSegment(
      generationDirectory,
      manifest,
      entry,
    );
    validatedSegments.push(segment);
    for (const fact of segment.facts) {
      if (seenAtoms.has(fact.atom_id))
        throw new Error("clean retrieval generation repeats an atom");
      seenAtoms.add(fact.atom_id);
    }
    if (
      segment.manifest.policy_id ===
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 ||
      (segment.manifest.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 &&
        segment.manifest.reviewer_principal_id === input.reader.principal_id &&
        segment.manifest.reviewer_membership_id === input.reader.membership_id)
    )
      admitted.push(segment);
  }
  const memberContract = manifest.policies[0].policy_contract_sha256;
  const memberSegmentId = canonicalSha256({
    schema_version: 1,
    kind: "clean-readable-search-segment-identity-v1",
    authority_id: manifest.authority_id,
    organization_id: manifest.organization_id,
    state_lineage_id: manifest.state_lineage_id,
    segment_kind: "organization-member",
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
    policy_contract_sha256: memberContract,
    reviewer_principal_id: null,
    reviewer_membership_id: null,
  });
  if (!seenSegments.has(memberSegmentId))
    throw new Error("clean retrieval generation omits its member segment");
  const budget = CLEAN_READABLE_SEARCH_ADMISSION_BUDGET_V1;
  const postingCount = validatedSegments.reduce(
    (sum, segment) => sum + segment.postings.length,
    0,
  );
  if (
    seenAtoms.size > budget.maximum_atoms ||
    validatedSegments.length > budget.maximum_segments ||
    postingCount > budget.maximum_postings ||
    validatedSegments.some((segment) =>
      [...segment.content_by_atom.values()].some(
        (item) =>
          Buffer.byteLength(item.text, "utf8") >
          budget.maximum_atom_text_utf8_bytes,
      ),
    )
  )
    throw new Error("clean retrieval generation exceeds current admission budget");
  // Replacement is deliberately one-for-one. No generation survives beside
  // the newly validated immutable rows.
  validatedActiveGenerationHandleV1 = null;
  validatedActiveGenerationHandleV1 = Object.freeze({
    key: activeGenerationKey(active),
    manifest,
    segments: Object.freeze(validatedSegments),
  });
  const candidates: Array<{
    readonly fact: CleanFactRow;
    readonly content: CleanContentRow;
    readonly score: number;
  }> = [];
  for (const segment of admitted) {
    const scoreByAtom = new Map<Sha256Digest, number>();
    for (const posting of segment.postings)
      if (terms.includes(posting.term))
        scoreByAtom.set(
          posting.atom_id,
          (scoreByAtom.get(posting.atom_id) ?? 0) + posting.term_frequency,
        );
    for (const fact of segment.facts) {
      const score = scoreByAtom.get(fact.atom_id);
      const content = segment.content_by_atom.get(fact.atom_id);
      if (score === undefined || content === undefined) continue;
      candidates.push({ fact, content, score });
    }
  }
  candidates.sort((left, right) =>
    compareReadableSearchCandidates(
      {
        score: left.score,
        log_position: left.fact.log_position,
        atom_order: left.fact.atom_order,
        atom_id: left.fact.atom_id,
      },
      {
        score: right.score,
        log_position: right.fact.log_position,
        atom_order: right.fact.atom_order,
        atom_id: right.fact.atom_id,
      },
    ),
  );
  return Object.freeze({
    generation_id: manifest.generation_id,
    exact_head: manifest.exact_head,
    items: Object.freeze(
      candidates.slice(0, limit).map((candidate) =>
        Object.freeze({
          atom_id: candidate.fact.atom_id,
          record_position: candidate.fact.log_position,
          record_sha256: candidate.fact.record_hash,
          envelope_sha256: candidate.fact.envelope_sha256,
          item_kind: candidate.content.item_kind,
          text: candidate.content.text,
          policy_id: candidate.fact.policy_id,
        }),
      ),
    ),
  });
}

/** Fully validates and replaces the sole eligible active-generation handle. */
export function warmCleanReadableSearchActiveGenerationV1(input: {
  readonly state_directory: string;
  readonly active_generation: CleanReadableSearchActiveGenerationV1;
}): void {
  validatedActiveGenerationHandleV1 = null;
  validateAndWarmCleanReadableSearchGenerationV1({
    ...input,
    reader: { principal_id: "warm-validator", membership_id: "warm-validator" },
    query: "warm",
    limit: 1,
  });
}

/** Searches only immutable rows in the exact, already validated one-entry handle. */
export function searchCleanReadableSearchGenerationV1(
  input: SearchCleanReadableSearchGenerationV1Input,
): CleanReadableSearchResultV1 {
  text(input.reader.principal_id, "reader principal_id");
  text(input.reader.membership_id, "reader membership_id");
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error(
      "clean retrieval limit must be a safe integer from one through ten",
    );
  const handle = validatedActiveGenerationHandleV1;
  if (
    handle === null ||
    handle.key !== activeGenerationKey(input.active_generation)
  )
    throw new Error("clean retrieval active-generation handle is unavailable");
  const terms = analyzeReadableSearchQuery(input.query);
  const admitted = handle.segments.filter(
    (segment) =>
      segment.manifest.policy_id ===
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 ||
      (segment.manifest.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 &&
        segment.manifest.reviewer_principal_id === input.reader.principal_id &&
        segment.manifest.reviewer_membership_id === input.reader.membership_id),
  );
  const candidates: Array<{
    readonly fact: CleanFactRow;
    readonly content: CleanContentRow;
    readonly score: number;
  }> = [];
  for (const segment of admitted) {
    const scoreByAtom = new Map<Sha256Digest, number>();
    for (const posting of segment.postings)
      if (terms.includes(posting.term))
        scoreByAtom.set(
          posting.atom_id,
          (scoreByAtom.get(posting.atom_id) ?? 0) + posting.term_frequency,
        );
    for (const fact of segment.facts) {
      const score = scoreByAtom.get(fact.atom_id);
      const content = segment.content_by_atom.get(fact.atom_id);
      if (score !== undefined && content !== undefined)
        candidates.push({ fact, content, score });
    }
  }
  candidates.sort((left, right) =>
    compareReadableSearchCandidates(
      {
        score: left.score,
        log_position: left.fact.log_position,
        atom_order: left.fact.atom_order,
        atom_id: left.fact.atom_id,
      },
      {
        score: right.score,
        log_position: right.fact.log_position,
        atom_order: right.fact.atom_order,
        atom_id: right.fact.atom_id,
      },
    ),
  );
  return Object.freeze({
    generation_id: handle.manifest.generation_id,
    exact_head: handle.manifest.exact_head,
    items: Object.freeze(
      candidates.slice(0, limit).map(({ fact, content }) =>
        Object.freeze({
          atom_id: fact.atom_id,
          record_position: fact.log_position,
          record_sha256: fact.record_hash,
          envelope_sha256: fact.envelope_sha256,
          item_kind: content.item_kind,
          text: content.text,
          policy_id: fact.policy_id,
        }),
      ),
    ),
  });
}

export {
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  READABLE_SEARCH_PLANE_BASELINE_SCHEMA_VERSION_V1,
  readableSearchPlaneBaselineSha256V1,
} from "./persistence/baseline.js";
