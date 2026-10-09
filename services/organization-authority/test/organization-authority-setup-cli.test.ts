import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalSha256,
  canonicalJson,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  buildReadableSearchGenerationV1,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchPlaneBaselineSha256,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readOrganizationAuthoritySetupManifest,
  runOrganizationAuthoritySetupCli,
  type OrganizationAuthoritySetupCliDependencies,
} from "../src/composition/organization-authority-setup-cli.js";
import { runOrganizationAuthorityPersonAdministrationCli } from "../src/composition/organization-authority-person-administration-cli.js";
import { personLoginGrantExpectedEmailSha256 } from "@echo-brain/organization-authority-kernel/domain/person-email-binding";
import {bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1, OPENROUTER_ANSWER_COMPOSITION_MODEL_V1, OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { readableSearchGenerationContractV1 } from "../src/composition/readable-search-generation-composition.js";
import {
  readStagingSyntheticCheckpointV1,
  writeStagingSyntheticCheckpointV1,
  stagingSyntheticCanaryMeetingV1,
  STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
  STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
} from "@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1";

const temporaryDirectories: string[] = [];
const STAGING_ORIGIN = "https://authority-staging.echobrain.org";

afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function stateDirectory(authorityUrl = "https://authority.example"): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-founder-"));
  temporaryDirectories.push(root);
  const oidcConfig = join(root, "oidc.json");
  writeFileSync(
    oidcConfig,
    JSON.stringify({
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: `${authorityUrl}/v2/session/oidc/callback`,
      tenant: { kind: "issuer" },
      id_token_algorithms: ["RS256"],
      client_authentication: "none",
    }),
    { mode: 0o600 },
  );
  chmodSync(oidcConfig, 0o600);
  return join(root, "state");
}

function dependencies(order: string[],): OrganizationAuthoritySetupCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    initialize_state: (input) => {
      order.push(
        `initialize:${input.created_at}:${input.creating_artifact_revision}`,
      );
      return bootstrapOrganizationAuthorityState(input);
    },
    initialize_credentials: async () => {
      order.push("credentials");
    },
    issue_invitation: async (input) => {
      order.push(`invite:${input.membership_id}`);
      expect(
        readOrganizationAuthoritySetupManifest(input.state_directory),
      ).toMatchObject({
        invitation_path: input.output_path,
        pkce_key_file: input.pkce_key_file,
      });
    },
    queue_staging_synthetic_meetings: async (input) => {
      order.push(`queue-synthetic:${input.meetings_directory ?? "canary"}`);
    },
  };
}

/** Durable setup facts after the owner set up Slack in the ECHO app. */
const CONNECTED_STAGE = Object.freeze({ credentials_ready: true, slack_connected: true, invitation_file_present: true });

type OwnerSetupStatus = ReturnType<NonNullable<OrganizationAuthoritySetupCliDependencies["read_initial_owner_setup_status"]>>;
/** Every initial-owner prerequisite met, before any meeting source. */
const OWNER_READY: OwnerSetupStatus = Object.freeze({
  founder_oidc_bound: true, founder_slack_link_active: true, llm_credential_valid: true, source_admission_present: false,
});
/** The same owner once staging finalize admitted their synthetic source. */
const OWNER_SYNTHETIC: OwnerSetupStatus = Object.freeze({
  founder_oidc_bound: true, founder_slack_link_active: true, llm_credential_valid: true,
  source_mode: "staging_synthetic", source_admission_present: true,
});

/** Slack connected in the app and the given owner status, ready to finalize. */
function finalizeDeps(
  base: OrganizationAuthoritySetupCliDependencies,
  owner: OwnerSetupStatus = OWNER_READY,
): OrganizationAuthoritySetupCliDependencies {
  return { ...base, read_setup_stage: () => CONNECTED_STAGE, read_initial_owner_setup_status: () => owner };
}

const QUIET = { stdout: () => undefined, stderr: () => undefined };

/** Runs one setup command, asserts its exit code and returns its raw output. */
async function cli(
  args: readonly string[],
  deps?: OrganizationAuthoritySetupCliDependencies,
  expectedExit = 0,
) {
  let stdout = "";
  let stderr = "";
  const status = await runOrganizationAuthoritySetupCli(
    args,
    { stdout: (value) => (stdout += value), stderr: (value) => (stderr += value) },
    deps,
  );
  expect(status, stderr).toBe(expectedExit);
  return {
    stdout,
    stderr,
    get json() {
      return JSON.parse(stdout) as Record<string, unknown>;
    },
  };
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function inviteArgv(input: Parameters<OrganizationAuthoritySetupCliDependencies["issue_invitation"]>[0]): string[] {
  return [
    "invite",
    "--state-dir",
    input.state_directory,
    "--oidc-config",
    input.oidc_config_path,
    "--pkce-key-file",
    input.pkce_key_file,
    "--membership-id",
    input.membership_id,
    "--expected-email",
    input.expected_email,
    "--authority-url",
    input.authority_url,
    "--out",
    input.output_path,
  ];
}

function readyStatusDependencies(
  order: string[],
  complete: () => boolean = () => false,
): OrganizationAuthoritySetupCliDependencies {
  return {
    ...dependencies(order),
    read_setup_stage: () => ({
      credentials_ready: true,
      slack_connected: true,
      invitation_file_present: false,
    }),
    read_initial_owner_setup_status: () => ({
      founder_oidc_bound: true,
      founder_slack_link_active: true,
      llm_credential_valid: true,
      source_admission_present: true,
    }),
    read_setup_canary_evidence: () => ({
      source_progress_observed: complete(),
      approved_record_present: complete(),
      active_generation_current: complete(),
      owner_layer1_read_after_head: complete(),
      owner_layer2_read_after_generation: complete(),
      complete: complete(),
    }),
  };
}

/** Ready prerequisites with canary evidence derived from durable state, as in production. */
function canaryFreeDeps(): OrganizationAuthoritySetupCliDependencies {
  return { ...readyStatusDependencies([]), read_setup_canary_evidence: undefined };
}

interface DurableCanaryFixtureOptions {
  readonly pointer_current?: boolean;
  readonly pointer_current_contract?: boolean;
  readonly pointer_uses_disabled_projector_contract?: boolean;
  readonly layer1_result_count?: number | null;
  readonly layer2_result_count?: number | null;
  readonly layer1_owner_tuple?: "owner" | "other";
  readonly layer2_owner_tuple?: "owner" | "other";
  /**
   * The owner's personal source holding the canary proposal the fixture record approves:
   * the staging synthetic source (default), a source of another meeting tool, or none.
   */
  readonly synthetic_canary?: "owner" | "granola" | "none";
  /** The release whose canary revision that proposal carries. */
  readonly synthetic_canary_release?: string;
}

function buildInputForCanary(
  state: string,
  manifest: ReturnType<typeof readOrganizationAuthoritySetupManifest>,
  recordHead: Readonly<{ position: number; record_sha256: Sha256Digest }>,
  projectorEnabled: boolean,
) {
  const contract = readableSearchGenerationContractV1(
    projectorEnabled
      ? {
          related_atom_projector: {
            generation_adapter_id: OPENROUTER_ANSWER_COMPOSITION_ADAPTER_ID_V1,
            model: OPENROUTER_ANSWER_COMPOSITION_MODEL_V1,
            timeout_ms: OPENROUTER_ANSWER_COMPOSITION_TIMEOUT_MS_V1,
          },
        }
      : {},
  );
  const plane = (
    role: string,
    schemaSha256: Sha256Digest,
    databaseSchemaVersion: 1 | 2 | 3 = 1,
  ) => {
    const manifestJson = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      database_schema_version: databaseSchemaVersion,
      schema_sha256: schemaSha256,
      created_at: "2026-08-22T12:00:00.000Z",
      creating_artifact_revision: "clean-founder-v1",
    });
    return {
      database_schema_version: databaseSchemaVersion,
      schema_sha256: schemaSha256,
      manifest_json: manifestJson,
      manifest_sha256: sha256Digest(manifestJson),
    };
  };
  return {
    state_directory: state,
    lineage: {
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      planes: {
        facts: plane(
          "retrieval-facts",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3),
          3,
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_CONTENT_BASELINE_V2),
          2,
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_LEXICAL_BASELINE_V2),
          2,
        ),
      },
    },
    exact_head: {
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      position: recordHead.position,
      record_sha256: recordHead.record_sha256,
    },
    retrieval_contract_sha256: contract.retrieval_contract_sha256,
    organization_member_policy_contract_sha256:
      contract.organization_member_policy_contract_sha256,
    restricted_reviewer_policy_contract_sha256:
      contract.restricted_reviewer_policy_contract_sha256,
    analyzer: contract.analyzer,
    source_revision: contract.source_revision,
    builder_artifact_sha256: contract.builder_artifact_sha256,
    sqlite_version: "3.50.4",
    atoms: [],
  };
}

type SetupManifest = ReturnType<typeof readOrganizationAuthoritySetupManifest>;
type RecordHead = { position: number; record_sha256: Sha256Digest };

/** Appends one approved V4 record per entry, each after the previous; returns the head. */
function appendApprovedRecords(
  state: string,
  manifest: SetupManifest,
  entries: readonly {
    readonly approval_id: string;
    readonly envelope_id: string;
    readonly record_sha256: Sha256Digest;
    readonly semantic_sha256: Sha256Digest;
  }[],
): RecordHead {
  const record = new Database(join(state, "record-log.sqlite"));
  let head: RecordHead | undefined;
  try {
    for (const [index, entry] of entries.entries()) {
      const position = index + 1;
      const envelope = canonicalJson({
        body: {
          schema_version: 4,
          kind: "echo-organization-record-envelope-v4",
          authority_id: manifest.authority_id,
          organization_id: manifest.organization_id,
          state_lineage_id: manifest.state_lineage_id,
          envelope_id: entry.envelope_id,
          event: { kind: "approved" },
          semantic_idempotency_key: entry.semantic_sha256,
          human_act_resolution_ref: { approval_id: entry.approval_id, action: "approve" },
          predecessor_position: head?.position ?? null,
          predecessor_record_sha256: head?.record_sha256 ?? null,
        },
        record_sha256: entry.record_sha256,
      });
      const receipt = canonicalJson({
        schema_version: 2,
        kind: "echo-organization-record-receipt-v2",
        authority_id: manifest.authority_id,
        organization_id: manifest.organization_id,
        state_lineage_id: manifest.state_lineage_id,
        envelope_id: entry.envelope_id,
        semantic_idempotency_key: entry.semantic_sha256,
        event_kind: "approved",
        record_position: position,
        record_sha256: entry.record_sha256,
        predecessor_record_sha256: head?.record_sha256 ?? null,
        record_head_position: position,
        record_head_sha256: entry.record_sha256,
        issued_at: SYNTHETIC_ISSUED_AT,
      });
      record
        .prepare(
          `INSERT INTO organization_record_log
           (position, envelope_id, event_kind, approval_id, action,
            semantic_idempotency_key, canonical_envelope, envelope_sha256,
            predecessor_position, predecessor_record_sha256, record_sha256,
            receipt_payload, receipt_issued_at)
           VALUES (?, ?, 'approved', ?, 'approve', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          position,
          entry.envelope_id,
          entry.approval_id,
          entry.semantic_sha256,
          envelope,
          sha256Digest(envelope),
          head?.position ?? null,
          head?.record_sha256 ?? null,
          entry.record_sha256,
          receipt,
          SYNTHETIC_ISSUED_AT,
        );
      head = { position, record_sha256: entry.record_sha256 };
    }
  } finally {
    record.close();
  }
  if (head === undefined) throw new Error("fixture evidence has no records");
  return head;
}

/** Points the active readable-search generation at a built generation. */
function insertActiveGeneration(
  authority: Database.Database,
  manifest: SetupManifest,
  built: ReturnType<typeof buildReadableSearchGenerationV1>,
  head: { readonly position: number; readonly record_sha256: Sha256Digest | null },
  retrievalContractSha256: Sha256Digest,
  publishedAt: string,
): void {
  authority
    .prepare(
      `INSERT INTO authority_readable_search_active_generation
       (singleton, organization_id, generation_id, manifest_sha256,
        retrieval_contract_sha256, record_head_position, record_head_hash,
        published_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      manifest.organization_id,
      built.manifest.generation_id,
      built.manifest_sha256,
      retrievalContractSha256,
      head.position,
      head.record_sha256,
      publishedAt,
    );
}

/** One owner read audit; a null result count records nothing and "other" names another member. */
function appendOwnerAudit(
  audit: SqlitePersonRecordReadAuditV1,
  manifest: SetupManifest,
  read: {
    readonly mode: "layer1" | "layer2";
    readonly checked_at: string;
    readonly session_family_id: string;
    readonly result_count?: number | null | undefined;
    readonly owner_tuple?: "owner" | "other" | undefined;
  },
): void {
  if (read.result_count === null) return;
  audit.append({
    read_mode: read.mode,
    authority_id: manifest.authority_id,
    organization_id: manifest.organization_id,
    state_lineage_id: manifest.state_lineage_id,
    principal_id:
      read.owner_tuple === "other" ? "prn_other" : manifest.owner_principal_id,
    membership_id:
      read.owner_tuple === "other" ? "mem_other" : manifest.owner_membership_id,
    session_family_id: read.session_family_id,
    result_count: read.result_count ?? 1,
    response_sha256: sha256Digest(`${read.mode}-${read.checked_at}`),
    checked_at: read.checked_at,
  });
}

function installDurableCanaryFixture(
  state: string,
  options: DurableCanaryFixtureOptions = {},
): void {
  const manifest = readOrganizationAuthoritySetupManifest(state);
  const approvalId = "apr_founder_canary";
  const head = appendApprovedRecords(state, manifest, [{
    approval_id: approvalId,
    envelope_id: "env_founder_canary",
    record_sha256: sha256Digest("founder-canary-record"),
    semantic_sha256: sha256Digest("founder-canary-semantic"),
  }]);
  const built = buildReadableSearchGenerationV1(
    buildInputForCanary(
      state,
      manifest,
      head,
      !options.pointer_uses_disabled_projector_contract,
    ),
  );
  const authority = new Database(join(state, "authority.sqlite"));
  try {
    insertActiveGeneration(
      authority,
      manifest,
      built,
      (options.pointer_current ?? true) ? head : { position: 0, record_sha256: null },
      (options.pointer_current_contract ?? true)
        ? built.manifest.retrieval_contract_sha256
        : sha256Digest("stale-retrieval-contract"),
      "2026-08-23T00:00:01.000Z",
    );
    const audit = new SqlitePersonRecordReadAuditV1(authority);
    appendOwnerAudit(audit, manifest, {
      mode: "layer1",
      checked_at: "2026-08-23T00:00:02.000Z",
      session_family_id: "sfm_founder_canary",
      result_count: options.layer1_result_count,
      owner_tuple: options.layer1_owner_tuple,
    });
    appendOwnerAudit(audit, manifest, {
      mode: "layer2",
      checked_at: "2026-08-23T00:00:03.000Z",
      session_family_id: "sfm_founder_canary",
      result_count: options.layer2_result_count,
      owner_tuple: options.layer2_owner_tuple,
    });
    if (options.synthetic_canary !== "none") {
      const semantic = insertStagingSyntheticSource(authority, manifest, {
        adapter_id: options.synthetic_canary === "granola" ? "granola-person-mcp" : STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
      });
      insertSyntheticProposal(authority, semantic, { index: 0, meeting_id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, approval_id: approvalId,
        revision: stagingSyntheticCanaryMeetingV1(options.synthetic_canary_release ?? CURRENT_RELEASE).provenance.canonical_revision });
    }
  } finally {
    authority.close();
  }
}

const SYNTHETIC_ISSUED_AT = "2026-08-23T00:00:00.000Z";
const CURRENT_RELEASE = "clean-v1-staging-synthetic-canary";

/** The owner's staging synthetic personal source, as setup finalize leaves it. */
function insertStagingSyntheticSource(
  authority: Database.Database,
  manifest: ReturnType<typeof readOrganizationAuthoritySetupManifest>,
  input: { readonly adapter_id?: string; readonly pending?: readonly string[] } = {},
): Sha256Digest {
  const adapterId = input.adapter_id ?? STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1;
  const sourceKey = `pms_${sha256Digest(`synthetic-source-${adapterId}`).slice(7)}`;
  const semantic = sha256Digest(`synthetic-source-admission-${adapterId}`);
  const cursor = writeStagingSyntheticCheckpointV1({ folder: null, baseline: false, revisions: {}, manual: input.pending ?? [] });
  authority
    .prepare(
      `INSERT INTO authority_live_source_admission_v2
       (source_key, organization_id, principal_id, membership_id, membership_type,
        source_adapter_id, source_adapter_version, source_adapter_instance_id,
        normalizer_version, source_custodian_sha256,
        source_custodian_assurance, source_custodian_observed_at,
        source_credential_reference_sha256, initial_cursor, cutoff_at,
        processor_adapter_id, processor_instance_id, processor_adapter_version,
        processor_configuration_sha256, processor_credential_reference_sha256,
        semantic_input_sha256, admitted_at)
       VALUES (?, ?, ?, ?, 'owner', ?, '1.0.0', 'staging-synthetic-fixture', '1.0.0',
               ?, 'staging_synthetic', ?, ?, ?, ?, 'llm', 'personal-fixture', '1.0.0', ?, ?, ?, ?)`,
    )
    .run(
      sourceKey,
      manifest.organization_id,
      manifest.owner_principal_id,
      manifest.owner_membership_id,
      adapterId,
      sha256Digest("synthetic-custodian"),
      SYNTHETIC_ISSUED_AT,
      sha256Digest("synthetic-credential"),
      cursor,
      SYNTHETIC_ISSUED_AT,
      sha256Digest("processor-configuration"),
      sha256Digest("processor-credential"),
      semantic,
      SYNTHETIC_ISSUED_AT,
    );
  authority
    .prepare("INSERT INTO authority_live_source_progress_v2 VALUES (?, ?, ?, 1, ?)")
    .run(sourceKey, semantic, cursor, SYNTHETIC_ISSUED_AT);
  authority
    .prepare("INSERT INTO authority_person_meeting_sources_v2 VALUES (?, ?, NULL, NULL, 0)")
    .run(sourceKey, sha256Digest("synthetic-person"));
  return semantic;
}

/** One staged proposal for a meeting of that source. */
function insertSyntheticProposal(
  authority: Database.Database,
  admissionSemantic: Sha256Digest,
  input: { readonly index: number; readonly meeting_id: string; readonly approval_id: string; readonly revision?: string },
): void {
  const suffix = String(input.index);
  const meeting = { schema_version: 1, id: input.meeting_id, title: `Synthetic meeting ${suffix}`, provenance: { external_id: input.meeting_id, canonical_revision: input.revision ?? `revision-${suffix}` } };
  const candidateId = `cnd_synthetic_${suffix}`;
  authority
    .prepare(
      `INSERT INTO authority_live_source_candidates_v2 (
         candidate_id, candidate_semantic_sha256, admission_semantic_input_sha256,
         review_lineage_id, review_input_sha256, review_semantic_sha256,
         review_policy_id, review_policy_contract_sha256,
         review_policy_consequence_text, review_policy_consequence_sha256,
         disposition, source_cursor, meeting_sha256, meeting_json,
         decisions_sha256, decisions_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'actionable', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      sha256Digest(`synthetic-candidate-${suffix}`),
      admissionSemantic,
      `rli_synthetic_${suffix}`,
      sha256Digest(`synthetic-input-${suffix}`),
      sha256Digest(`synthetic-review-${suffix}`),
      "restricted-reviewer-v1",
      sha256Digest("synthetic-policy"),
      "synthetic proposal",
      sha256Digest("synthetic-consequence"),
      `synthetic-cursor-${suffix}`,
      canonicalSha256(meeting as never),
      canonicalJson(meeting as never),
      sha256Digest(`synthetic-decisions-${suffix}`),
      canonicalJson({ schema_version: 1, signals: [], proposal: input.index }),
      SYNTHETIC_ISSUED_AT,
    );
  authority
    .prepare(
      `INSERT INTO authority_live_approval_outbox_v2
         (candidate_id, approval_id, stage_command_id, state,
          approved_snapshot_json, approved_snapshot_sha256,
          suggested_projects_json, updated_at)
       VALUES (?, ?, ?, 'staged', ?, ?, '[]', ?)`,
    )
    .run(
      candidateId,
      input.approval_id,
      `pas_synthetic_${suffix}`,
      canonicalJson({ approval_id: input.approval_id, schema_version: 1, kind: "synthetic-snapshot", proposal: input.index }),
      canonicalSha256({ approval_id: input.approval_id, schema_version: 1, kind: "synthetic-snapshot", proposal: input.index } as never),
      SYNTHETIC_ISSUED_AT,
    );
}

type SyntheticFixtureApprovalShape = "one" | "all" | "pending" | "canary";

/**
 * Two fixture meetings on the owner's synthetic source. Every shape but "all"
 * leaves a fixture meeting without a published approval.
 */
function installSyntheticFixtureApprovalEvidence(
  state: string,
  shape: SyntheticFixtureApprovalShape,
): void {
  const manifest = readOrganizationAuthoritySetupManifest(state);
  const proposals = [
    { meeting_id: "fictional-roadmap-review", approval_id: "apr_synthetic_fixture_0", approved: true },
    ...(shape === "pending" ? [] : [{ meeting_id: "fictional-budget-sync", approval_id: "apr_synthetic_fixture_1", approved: shape === "all" }]),
    ...(shape === "canary" ? [{ meeting_id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, approval_id: "apr_synthetic_canary", approved: true }] : []),
  ];
  const head = appendApprovedRecords(
    state,
    manifest,
    proposals.filter((proposal) => proposal.approved).map((proposal, index) => ({
      approval_id: proposal.approval_id,
      envelope_id: `env_synthetic_fixture_${String(index + 1)}`,
      record_sha256: sha256Digest(`synthetic-fixture-record-${String(index + 1)}`),
      semantic_sha256: sha256Digest(`synthetic-fixture-semantic-${String(index + 1)}`),
    })),
  );
  const built = buildReadableSearchGenerationV1(
    buildInputForCanary(state, manifest, head, true),
  );
  const authority = new Database(join(state, "authority.sqlite"));
  try {
    const semantic = insertStagingSyntheticSource(authority, manifest, {
      pending: shape === "pending" ? ["fictional-budget-sync"] : [],
    });
    for (const [index, proposal] of proposals.entries()) insertSyntheticProposal(authority, semantic, { index, ...proposal });
    insertActiveGeneration(authority, manifest, built, head, built.manifest.retrieval_contract_sha256, "2026-08-23T00:00:01.000Z");
    const audit = new SqlitePersonRecordReadAuditV1(authority);
    for (const [mode, checked_at] of [
      ["layer1", "2026-08-23T00:00:02.000Z"],
      ["layer2", "2026-08-23T00:00:03.000Z"],
    ] as const) {
      appendOwnerAudit(audit, manifest, { mode, checked_at, session_family_id: "sfm_synthetic_fixture" });
    }
  } finally {
    authority.close();
  }
}

/** Two fictional fixture meetings in a private temporary directory. */
function fictionalFixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-synthetic-fixtures-"));
  temporaryDirectories.push(directory);
  const meeting = (id: string, title: string) => ({
    schema_version: 1,
    id,
    title,
    lifecycle: "completed",
    provenance: {
      source: { kind: "meeting-source", adapter_id: "fictional-fixtures", instance_id: "fixtures", version: "1.0.0" },
      external_id: id,
      canonical_revision: `${id}-r1`,
      observed_at: "2026-10-01T00:00:00.000Z",
      normalizer_version: "fictional-fixtures-v1",
    },
    capture: { state: "complete", components: [] },
    participants: [],
    content: [{ id: "note-1", kind: "note", text: `${title}: the team agreed on the next step.` }],
    artifacts: [],
  });
  writeFileSync(join(directory, "01-roadmap-review.json"), JSON.stringify(meeting("fictional-roadmap-review", "Roadmap review")));
  writeFileSync(join(directory, "02-budget-sync.json"), JSON.stringify(meeting("fictional-budget-sync", "Budget sync")));
  return directory;
}

describe("Organization Authority setup coordinator", () => {
  const bootstrapArgs = (state: string,
    authorityUrl = "https://authority.example",) => [
    "bootstrap",
    "--state-dir",
    state,
    "--organization-name",
    "ECHO",
    "--owner-display-name",
    "Founder",
    "--owner-email",
    "founder@example.com",
    "--authority-url",
    authorityUrl,
    "--oidc-config",
    join(dirname(state), "oidc.json"),
  ];

  it("bootstrap does not touch Slack: reset, credentials, manifest v3 and invitation", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    // The retired channel flag is refused before bootstrap changes anything.
    const refused = await cli(
      [...bootstrapArgs(state), "--slack-approval-channel-id", "C123"],
      dependencies(order),
      1,
    );
    expect(order).toEqual([]);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("usage:");
    const bootstrapped = await cli(bootstrapArgs(state), dependencies(order));

    expect(bootstrapped.stderr).toBe("");
    expect(order).toEqual([
      "initialize:2026-08-22T12:00:00.000Z:clean-founder-v1",
      "credentials",
      expect.stringMatching(/^invite:mem_/),
    ]);
    expect(bootstrapped.json).toEqual({
      ok: true,
      invitation_path: join(state, "onboarding", "founder-person-invitation.json"),
      next_step: "resume_bootstrap",
      next_instruction:
        "Run echo-organization-authority-setup resume --state-dir <absolute-path>.",
    });

    const manifestPath = join(state, "onboarding", "clean-founder-v1.json");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(manifestPath, "utf8")).not.toMatch(/slack|C123/);
    expect(readOrganizationAuthoritySetupManifest(state)).toMatchObject({
      schema_version: 3,
      kind: "echo-clean-founder-onboarding-manifest-v3",
      owner_membership_id: expect.stringMatching(/^mem_/),
      llm_credential_file: join(state, "credentials", "llm-credential"),
    });
  });

  it("refuses a v1 manifest from before in-app Slack setup", async () => {
    const state = stateDirectory();
    await cli(bootstrapArgs(state), dependencies([]));
    const path = join(state, "onboarding", "clean-founder-v1.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { setup_seed: Record<string, unknown> };
    const v1 = { ...manifest, schema_version: 1, kind: "echo-clean-founder-onboarding-manifest-v1",
      slack_approval_channel_id: "C123", slack_connection_id: "con_00000000-0000-4000-8000-000000000001",
      setup_seed: { ...manifest.setup_seed, slack_connection_id: "con_00000000-0000-4000-8000-000000000001" } };
    writePrivate(path, `${canonicalJson(v1)}\n`);

    expect(() => readOrganizationAuthoritySetupManifest(state)).toThrow(
      "organization setup manifest predates in-app Slack setup; install this release's host tooling, then run replace-rehearsal",
    );
    expect((await cli(["resume", "--state-dir", state], dependencies([]), 1)).stderr)
      .toContain("install this release's host tooling, then run replace-rehearsal");
  });

  it("keeps a default-path v2 owner invitation usable when bootstrap resumes", async () => {
    // The production CLI requires the private invitation parent to be its
    // canonical spelling. `tmpdir()` may expose a symlinked macOS path.
    const state = join(realpathSync(dirname(stateDirectory())), "state");
    const order: string[] = [];
    let invitationIssues = 0;
    const defaultPathDependencies: OrganizationAuthoritySetupCliDependencies = {
      ...dependencies(order),
      initialize_credentials: async (stateDirectory) => {
        const status = await runOrganizationAuthorityPersonAdministrationCli(
          ["credentials-init", "--state-dir", stateDirectory],
          QUIET,
        );
        expect(status).toBe(0);
      },
      issue_invitation: async (input) => {
        invitationIssues += 1;
        const status = await runOrganizationAuthorityPersonAdministrationCli(inviteArgv(input), QUIET);
        expect(status).toBe(0);
      },
    };

    await cli(bootstrapArgs(state), defaultPathDependencies);
    const manifest = readOrganizationAuthoritySetupManifest(state);
    expect(JSON.parse(readFileSync(manifest.invitation_path, "utf8")),).toMatchObject({
      schema_version: 2,
      expected_email: "founder@example.com",
    });

    await cli(["resume", "--state-dir", state], defaultPathDependencies);
    expect(invitationIssues).toBe(1);

    /** Rewrites an issued invitation as a pre-v2 artifact at the owner's invitation path. */
    const writeLegacyInvitation = (from: string) => {
      const legacy = JSON.parse(readFileSync(from, "utf8")) as Record<string, unknown>;
      delete legacy.expected_email;
      legacy.schema_version = 1;
      writePrivate(manifest.invitation_path, `${canonicalJson(legacy)}\n`);
    };

    // A pre-v2 artifact remains a usable legacy invitation when its grant is
    // otherwise valid. This protects a setup resumed after an older release.
    writeLegacyInvitation(manifest.invitation_path);
    expect((await cli(["status", "--state-dir", state])).json).toMatchObject({
      founder_invitation_valid: true,
    });

    // A manifest alone cannot opt an identity into legacy issuance.
    const manifestPath = join(state, "onboarding", "clean-founder-v1.json");
    const historicManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    historicManifest.owner_email = "founder@localhost";
    writePrivate(manifestPath, `${canonicalJson(historicManifest)}\n`);
    unlinkSync(manifest.invitation_path);

    await cli(["resume", "--state-dir", state], defaultPathDependencies, 1);
    expect(existsSync(manifest.invitation_path)).toBe(false);

    // A pre-a612c9e owner grant is immutable evidence that this exact broad
    // identity key was historically bound to the same owner and OIDC config.
    // Its expiry is intentionally irrelevant: it is proof, not a credential.
    const authority = new Database(join(state, "authority.sqlite"));
    try {
      authority
        .prepare(
          `INSERT INTO authority_person_login_grants
             (login_grant_sha256, grant_purpose, organization_id, principal_id,
              membership_id, membership_type, expected_issuer,
              expected_email_sha256, oidc_configuration_sha256, issued_at,
              expires_at, consumed_at)
           SELECT ?, grant_purpose, organization_id, principal_id,
                  membership_id, membership_type, expected_issuer,
                  ?, oidc_configuration_sha256, ?, ?, NULL
             FROM authority_person_login_grants
            WHERE organization_id = ? AND principal_id = ? AND membership_id = ?
              AND membership_type = 'owner'
            LIMIT 1`,
        )
        .run(
          sha256Digest("historic-founder-localhost-grant"),
          personLoginGrantExpectedEmailSha256("founder@localhost"),
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:15:00.000Z",
          manifest.organization_id,
          manifest.owner_principal_id,
          manifest.owner_membership_id,
        );
    } finally {
      authority.close();
    }

    await cli(["resume", "--state-dir", state], defaultPathDependencies);
    expect(invitationIssues).toBe(1);
    expect(
      JSON.parse(readFileSync(manifest.invitation_path, "utf8")),
    ).toMatchObject({ schema_version: 1 });
    expect(
      JSON.parse(readFileSync(manifest.invitation_path, "utf8")),
    ).not.toHaveProperty("expected_email");const mismatchedPath = join(dirname(manifest.invitation_path), "other.json",);
    expect(
      await runOrganizationAuthorityPersonAdministrationCli(
        inviteArgv({
          ...manifest,
          membership_id: manifest.owner_membership_id,
          expected_email: "other@example.com",
          output_path: mismatchedPath,
        }),
        QUIET,
      ),
    ).toBe(0);
    writeLegacyInvitation(mismatchedPath);
    expect((await cli(["status", "--state-dir", state])).json).toMatchObject({
      founder_invitation_valid: false,
    });
  });

  it("rejects a noncanonical owner email before creating state or connecting Slack", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const args = bootstrapArgs(state).map((arg) =>
      arg === "founder@example.com" ? "Founder@Example.com" : arg);

    expect((await cli(args, dependencies(order), 1)).stderr).toContain("canonical lowercase email");
    expect(order).toEqual([]);
  });

  it("rejects OIDC configuration before creating a setup plan, genesis, or Slack connection", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    writeFileSync(join(dirname(state), "oidc.json"), "{}", { mode: 0o600 });

    const result = await cli(bootstrapArgs(state), dependencies(order), 1);

    expect(result.stderr).toContain("OIDC config has an unexpected shape");
    expect(order).toEqual([]);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.clean-founder-setup-plan-v1.json`)).toBe(false);
  });

  it("rejects a legacy onboarding manifest shape instead of treating it as compatible", async () => {
    const state = stateDirectory();
    await cli(bootstrapArgs(state), dependencies([]));
    const path = join(state, "onboarding", "clean-founder-v1.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete manifest.setup_seed;
    delete manifest.owner_email;
    delete manifest.organization_name;
    delete manifest.owner_display_name;
    writePrivate(path, JSON.stringify(manifest));

    expect(() => readOrganizationAuthoritySetupManifest(state)).toThrow(
      "organization setup manifest is invalid",
    );
  });

  it("refuses resume when state exists but its exact setup plan is missing", async () => {
    const state = stateDirectory();
    mkdirSync(state, { mode: 0o700 });

    const result = await cli(["resume", "--state-dir", state], dependencies([]), 1);

    expect(result.stderr).toContain("restore the exact setup plan");
    expect(result.stderr).toContain("new state directory");
  });

  it.each([
    ["queues fixture meetings on the exact staging Authority", OWNER_READY],
    ["queues the fixture meetings again on a synthetic finalize retry", OWNER_SYNTHETIC],
  ] as const)("%s", async (_name, owner) => {
    const state = stateDirectory(STAGING_ORIGIN);
    const order: string[] = [];
    const deps = dependencies(order);
    await cli(bootstrapArgs(state, STAGING_ORIGIN), deps);
    order.splice(0);
    await cli(
      ["finalize", "--state-dir", state, "--staging-synthetic-meetings-dir", "/echo-clean/meetings"],
      finalizeDeps(deps, owner),
    );
    expect(order).toEqual(["queue-synthetic:/echo-clean/meetings"]);
  });

  it("refuses fixture meetings outside the exact staging Authority", async () => {
    const deps = dependencies([]);
    const productionState = stateDirectory();
    await cli(bootstrapArgs(productionState), deps);
    const refused = await cli(
      ["finalize", "--state-dir", productionState, "--staging-synthetic-meetings-dir", "/echo-clean/meetings"],
      finalizeDeps(deps),
      1,
    );
    expect(refused.stderr).toContain("staging synthetic meeting source is allowed only");
  });

  it("sets up the owner's synthetic source for the canary when staging finalize has no fixtures", async () => {
    const state = stateDirectory(STAGING_ORIGIN);
    const order: string[] = [];
    await cli(bootstrapArgs(state, STAGING_ORIGIN), dependencies(order));
    order.splice(0);
    const finalized = await cli(["finalize", "--state-dir", state], finalizeDeps(dependencies(order)));
    expect(order).toEqual(["queue-synthetic:canary"]);
    expect(finalized.json).toMatchObject({ source_mode: "staging_canary", source_admission_present: true, canary_status: "not_complete" });
  });

  it("finalize queues fixture meetings into the owner's synthetic source and admits no organization source", async () => {
    const state = stateDirectory(STAGING_ORIGIN);
    const { queue_staging_synthetic_meetings: _stub, ...real } = dependencies([]);
    await cli(bootstrapArgs(state, STAGING_ORIGIN), real);
    const manifest = readOrganizationAuthoritySetupManifest(state);
    mkdirSync(dirname(manifest.llm_credential_file), { recursive: true, mode: 0o700 });
    writeFileSync(manifest.llm_credential_file, "l".repeat(40), { mode: 0o600 });
    chmodSync(manifest.llm_credential_file, 0o600);
    const finalized = await cli(
      ["finalize", "--state-dir", state, "--staging-synthetic-meetings-dir", fictionalFixtureDirectory()],
      finalizeDeps(real),
    );
    expect(finalized.json).toMatchObject({ source_mode: "staging_synthetic", source_admission_present: true });
    const authority = new Database(join(state, "authority.sqlite"), { readonly: true });
    try {
      expect(authority.prepare("SELECT count(*) FROM authority_live_source_admission_v2 WHERE source_key = ?").pluck().get("1")).toBe(0);
      const sources = authority.prepare(
        `SELECT admission.source_adapter_id, admission.source_custodian_assurance, admission.principal_id, admission.membership_id, progress.cursor
           FROM authority_live_source_admission_v2 AS admission
           JOIN authority_live_source_progress_v2 AS progress USING (source_key)`,
      ).all() as { source_adapter_id: string; source_custodian_assurance: string; principal_id: string; membership_id: string; cursor: string }[];
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        source_adapter_id: STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1,
        source_custodian_assurance: "staging_synthetic",
        principal_id: manifest.owner_principal_id,
        membership_id: manifest.owner_membership_id,
      });
      expect(readStagingSyntheticCheckpointV1(sources[0]!.cursor).manual).toEqual(["fictional-roadmap-review", "fictional-budget-sync"]);
    } finally {
      authority.close();
    }
    expect((await cli(["status", "--state-dir", state], { ...real, read_setup_stage: () => CONNECTED_STAGE })).json)
      .toMatchObject({ source_mode: "staging_synthetic", source_admission_present: true });
  });

  it("rejects a fixture selector outside finalization", async () => {
    const state = stateDirectory();
    expect(
      (await cli(
        ["status", "--state-dir", state, "--staging-synthetic-meetings-dir", "/echo-clean/meetings"],
        dependencies([]),
        1,
      )).stderr,
    ).toContain("usage:");
  });

  it("reports a synthetic admitted source without demanding the release canary record", async () => {
    const state = stateDirectory("https://authority-staging.echobrain.org");
    const order: string[] = [];
    const deps: OrganizationAuthoritySetupCliDependencies = {
      ...dependencies(order),
      read_setup_stage: () => ({
        credentials_ready: true,
        slack_connected: true,
        invitation_file_present: false,
      }),
      read_initial_owner_setup_status: () => OWNER_SYNTHETIC,
      read_setup_canary_evidence: () => ({
        source_progress_observed: true,
        synthetic_staging_canary_observed: false,
        approved_record_present: true,
        active_generation_current: true,
        owner_layer1_read_after_head: true,
        owner_layer2_read_after_generation: true,
        complete: true,
      }),
    };
    await cli(bootstrapArgs(state, "https://authority-staging.echobrain.org"), deps);
    expect((await cli(["status", "--state-dir", state], deps)).json).toMatchObject({
      source_mode: "staging_synthetic",
      source_admission_present: true,
      synthetic_staging_canary_observed: false,
      next_step: "complete",
    });
  });

  it("finalize lists the organization Slack connection among the missing prerequisites without publishing anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await cli(bootstrapArgs(state), base);
    order.splice(0);

    const result = await cli(
      ["finalize", "--state-dir", state],
      {
        ...base,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: false,
          founder_slack_link_active: false,
          llm_credential_valid: false,
          source_admission_present: false,
        }),
      },
      1,
    );

    // The real durable stage: nobody has set up Slack in the ECHO app yet.
    expect(result.stderr).toContain(
      "organization setup finalize requires initial-owner OIDC binding, organization Slack connection, initial-owner Slack identity link, LLM credential",
    );
    expect(order).toEqual([]);
  });

  it("proves genesis before a full-status seam can publish anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await cli(bootstrapArgs(state), base);
    order.splice(0);
    writeFileSync(join(state, "state-lineage-root.v2.json"), "{}", { mode: 0o600 ,});

    const result = await cli(["finalize", "--state-dir", state], finalizeDeps(base), 1);

    expect(result.stderr).toContain("valid state-lineage root manifest");
    expect(order).toEqual([]);
  });

  it("finalize is idempotent with no meeting source and leaves intake idle", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await cli(bootstrapArgs(state), base);
    order.splice(0);
    const deps = finalizeDeps(base);
    const finalize = ["finalize", "--state-dir", state];
    const stdout = (await cli(finalize, deps)).stdout + (await cli(finalize, deps)).stdout;
    expect(order).toEqual([]);
    for (const line of stdout.trim().split("\n")) {
      expect(JSON.parse(line)).toMatchObject({ source_mode: "none", source_admission_present: false });
    }
    for (const command of ["status", "resume"]) {
      expect((await cli([command, "--state-dir", state], deps)).json).toMatchObject({
        next_step: "complete", runtime_status: "ready_to_start", canary_status: "not_required",
        source_admission_present: false, source_progress_observed: false,
        approved_record_present: false, owner_layer1_read_after_head: false,
      });
    }
  });

  it("next step after login is connect_slack_in_app, then the owner's own Slack link", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const stage = { credentials_ready: true, slack_connected: false, invitation_file_present: false };
    const deps: OrganizationAuthoritySetupCliDependencies = {
      ...dependencies(order),
      read_setup_stage: () => stage,
      read_initial_owner_setup_status: () => ({
        founder_oidc_bound: true,
        founder_slack_link_active: false,
        llm_credential_valid: false,
        source_admission_present: false,
      }),
    };
    const bootstrapped = await cli(bootstrapArgs(state), deps);
    expect(bootstrapped.json).toMatchObject({
      next_step: "connect_slack_in_app",
      next_instruction: "An owner runs person tools setup --tool slack and pastes a Slack app configuration token.",
    });
    expect(bootstrapped.stdout).not.toContain("invitation_path");
    expect(order).toEqual(["initialize:2026-08-22T12:00:00.000Z:clean-founder-v1"]);

    stage.slack_connected = true;
    expect((await cli(["status", "--state-dir", state], deps)).json)
      .toMatchObject({ slack_connected: true, next_step: "complete_founder_slack_link" });
    expect((await cli(["resume", "--state-dir", state], deps)).json).toMatchObject({
      next_step: "complete_founder_slack_link",
      next_instruction: "The owner runs person tools connect --tool slack to link their own Slack.",
    });
  });

  it("installs only the LLM credential from a private file without printing its value", async () => {
    const state = stateDirectory();
    await cli(bootstrapArgs(state), dependencies([]));
    const credentialDirectory = join(state, "credentials");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    const sourceDirectory = join(dirname(state), "private-inputs");
    mkdirSync(sourceDirectory, { mode: 0o700 });
    const llm = "l".repeat(40);
    const source = join(sourceDirectory, "llm");
    writePrivate(source, llm);

    const installed = await cli([
      "credentials-install",
      "--state-dir",
      state,
      "--llm-credential-file",
      source,
    ]);

    expect(installed.stderr).toBe("");
    expect(installed.json).toMatchObject({
      ok: true,
      credentials_ready: true,
    });
    expect(installed.stdout).not.toContain(llm);
    expect(installed.stdout).not.toContain("founder@example.com");
    expect(readFileSync(join(credentialDirectory, "llm-credential"), "utf8"),)
      .toBe(llm);
    expect(statSync(join(credentialDirectory, "llm-credential")).mode & 0o777).toBe(0o600);
  });

  it("resumes a lost bootstrap response from the durable plan", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const stage = {
      credentials_ready: false,
      slack_connected: false,
      invitation_file_present: false,
    };
    let resetFails = true;
    let failAfter: "credentials" | "invitation" | undefined = undefined;
    const base = dependencies(order);
    const deps: OrganizationAuthoritySetupCliDependencies = {
      ...base,
      initialize_state: (input) => {
        if (resetFails) throw new Error("injected before genesis");
        return bootstrapOrganizationAuthorityState(input);
      },
      initialize_credentials: async () => {
        order.push("credentials");
        stage.credentials_ready = true;
        if (failAfter === "credentials") throw new Error("injected after credentials");
      },
      issue_invitation: async () => {
        order.push("invitation");
        stage.invitation_file_present = true;
        if (failAfter === "invitation") throw new Error("injected after invitation");
      },
      read_setup_stage: () => stage,
    };

    await cli(bootstrapArgs(state), deps, 1);
    const status = await cli(["status", "--state-dir", state]);
    expect(status.stdout).not.toContain("founder@example.com");
    expect(status.stdout).not.toContain(state);
    expect(status.stdout).not.toContain("oau_");
    expect(status.json).toMatchObject({
      setup_plan_present: true,
      genesis_published: false,
      next_step: "resume_bootstrap",
    });

    resetFails = false;
    failAfter = "credentials";
    await cli(["resume", "--state-dir", state], deps, 1);
    failAfter = "invitation";
    await cli(["resume", "--state-dir", state], deps, 1);
    expect(order.filter((value) => value === "credentials")).toHaveLength(1);
    failAfter = undefined;
    await cli(["resume", "--state-dir", state], deps);
    expect(order.filter((value) => value === "invitation")).toHaveLength(1);
  });

  it("reports only safe incomplete and complete one-note canary evidence", async () => {
    // Only staging proves a rehearsal; every other origin completes source-free.
    const state = stateDirectory(STAGING_ORIGIN);
    const order: string[] = [];
    let canaryComplete = false;
    const deps = readyStatusDependencies(order, () => canaryComplete);
    await cli(bootstrapArgs(state, STAGING_ORIGIN), deps);

    expect((await cli(["status", "--state-dir", state], deps)).json).toMatchObject({
      next_step: "ready_to_start",
      canary_status: "not_complete",
      source_progress_observed: false,
      approved_record_present: false,
      active_generation_current: false,
      owner_layer1_read_after_head: false,
      owner_layer2_read_after_generation: false,
    });

    canaryComplete = true;
    const complete = await cli(["status", "--state-dir", state], deps);
    expect(complete.json).toMatchObject({
      next_step: "complete",
      canary_status: "complete",
      source_progress_observed: true,
      approved_record_present: true,
      active_generation_current: true,
      owner_layer1_read_after_head: true,
      owner_layer2_read_after_generation: true,
    });
    expect(complete.stdout).not.toContain("oau_");
    expect(complete.stdout).not.toContain("org_");
    expect(complete.stdout).not.toContain("prn_");
    expect(complete.stdout).not.toContain("sha256:");
    expect(complete.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(complete.json).not.toHaveProperty("next_instruction");

    expect((await cli(["resume", "--state-dir", state], deps)).json).toMatchObject({ next_step: "complete" });
  });

  it.each([
    ["complete", {}, true, true, true, true, true],
    [
      "expects the active projector contract without the owner's synthetic source",
      { synthetic_canary: "none" },
      false,
      true,
      true,
      true,
      true,
    ],
    [
      "rejects a disabled projector contract",
      { pointer_uses_disabled_projector_contract: true },
      true,
      true,
      false,
      false,
      false,
    ],
    ["requires a synthetic proposal rather than another meeting tool's", { synthetic_canary: "granola" }, false, true, true, true, true],
    ["rejects a stale record-head pointer", { pointer_current: false }, true, true, false, false, false,],
    ["rejects a stale retrieval contract", { pointer_current_contract: false }, true, true, false, false, false,],
    ["requires a positive Layer 1 audit", { layer1_result_count: null }, true, true, true, false, true,],
    ["rejects a zero-result Layer 1 audit", { layer1_result_count: 0 }, true, true, true, false, true,],
    ["requires a positive Layer 2 audit", { layer2_result_count: null }, true, true, true, true, false,],
    ["rejects a zero-result Layer 2 audit", { layer2_result_count: 0 }, true, true, true, true, false,],
    ["requires the owner tuple for Layer 1", { layer1_owner_tuple: "other" }, true, true, true, false, true,],
    ["requires the owner tuple for Layer 2", { layer2_owner_tuple: "other" }, true, true, true, true, false,],
  ] as const)(
    "derives durable staging canary evidence from SQLite: %s",
    async (
      _name,
      fixtureOptions,
      sourceProgress,
      approvedRecord,
      activeGeneration,
      layer1Read,
      layer2Read,
    ) => {
      vi.stubEnv("ECHO_CLEAN_AUTHORITY_HOST", "authority-staging.echobrain.org");
      vi.stubEnv("ECHO_CLEAN_RELEASE_ID", CURRENT_RELEASE);
      const state = stateDirectory(STAGING_ORIGIN);
      const productionDependencies = canaryFreeDeps();
      await cli(bootstrapArgs(state, STAGING_ORIGIN), productionDependencies);
      installDurableCanaryFixture(state, fixtureOptions);

      expect((await cli(["status", "--state-dir", state], productionDependencies)).json).toMatchObject({
        source_progress_observed: sourceProgress,
        synthetic_staging_canary_observed: sourceProgress,
        approved_record_present: approvedRecord,
        active_generation_current: activeGeneration,
        owner_layer1_read_after_head: layer1Read,
        owner_layer2_read_after_generation: layer2Read,
        next_step:
          sourceProgress && approvedRecord && activeGeneration && layer1Read && layer2Read
            ? "complete"
            : "ready_to_start",
      });
    },
  );

  it("completes source-free outside staging even when no rehearsal evidence exists", async () => {
    const state = stateDirectory();
    const productionDependencies = canaryFreeDeps();
    await cli(bootstrapArgs(state), productionDependencies);
    for (const command of ["status", "resume"]) {
      expect((await cli([command, "--state-dir", state], productionDependencies)).json).toMatchObject({
        next_step: "complete", canary_status: "not_required",
        source_progress_observed: false, synthetic_staging_canary_observed: false, approved_record_present: false,
      });
    }
  });

  it.each([
    ["one of two fixture proposals approved", "one", "ready_to_start"],
    ["both fixture proposals approved", "all", "complete"],
    ["a fixture import still pending", "pending", "ready_to_start"],
    ["only the canary approved beside a fixture", "canary", "ready_to_start"],
  ] as const)(
    "requires every synthetic fixture meeting approved before synthetic completion: %s",
    async (_name, shape, nextStep) => {
      const state = stateDirectory(STAGING_ORIGIN);
      const deps: OrganizationAuthoritySetupCliDependencies = {
        ...canaryFreeDeps(),
        read_initial_owner_setup_status: () => OWNER_SYNTHETIC,
      };
      await cli(bootstrapArgs(state, STAGING_ORIGIN), deps);
      installSyntheticFixtureApprovalEvidence(state, shape);
      expect((await cli(["status", "--state-dir", state], deps)).json).toMatchObject({ next_step: nextStep });
    },
  );

  it("reports canary evidence once the current release's synthetic canary proposal has an approved record, only on staging", async () => {
    const productionDependencies = canaryFreeDeps();
    const installed = async (authorityUrl: string, release = CURRENT_RELEASE) => {
      const state = stateDirectory(authorityUrl);
      await cli(bootstrapArgs(state, authorityUrl), productionDependencies);
      installDurableCanaryFixture(state, { synthetic_canary: "owner", synthetic_canary_release: release });
      return state;
    };
    const statusOf = async (state: string) =>
      (await cli(["status", "--state-dir", state], productionDependencies)).json;
    vi.stubEnv("ECHO_CLEAN_AUTHORITY_HOST", "authority-staging.echobrain.org");
    vi.stubEnv("ECHO_CLEAN_RELEASE_ID", CURRENT_RELEASE);
    const current = await installed(STAGING_ORIGIN);
    expect(await statusOf(current)).toMatchObject({
      source_progress_observed: true,
      synthetic_staging_canary_observed: true,
      next_step: "complete",
    });
    // An approved canary from an earlier release is not evidence for the running one.
    expect(await statusOf(await installed(STAGING_ORIGIN, "clean-v1-staging-earlier-release"))).toMatchObject({
      synthetic_staging_canary_observed: false,
      next_step: "ready_to_start",
    });
    // Outside staging the synthetic source is not evidence, and none is required.
    expect(await statusOf(await installed("https://authority.example"))).toMatchObject({
      synthetic_staging_canary_observed: false,
      canary_status: "not_required",
      next_step: "complete",
    });
    // Status is read-only, so the same staging state is judged again under each environment.
    vi.stubEnv("ECHO_CLEAN_RELEASE_ID", undefined);
    expect(await statusOf(current)).toMatchObject({
      synthetic_staging_canary_observed: false,
      next_step: "ready_to_start",
    });
    vi.stubEnv("ECHO_CLEAN_RELEASE_ID", CURRENT_RELEASE);
    vi.stubEnv("ECHO_CLEAN_AUTHORITY_HOST", undefined);
    expect(await statusOf(current)).toMatchObject({
      synthetic_staging_canary_observed: false,
      next_step: "ready_to_start",
    });
  });
});
