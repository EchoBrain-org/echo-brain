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
import { afterEach, describe, expect, it } from "vitest";
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

function installDurableCanaryFixture(
  state: string,
  options: DurableCanaryFixtureOptions = {},
): void {
  const manifest = readOrganizationAuthoritySetupManifest(state);
  const issuedAt = "2026-08-23T00:00:00.000Z";
  const recordSha256 = sha256Digest("founder-canary-record");
  const semanticSha256 = sha256Digest("founder-canary-semantic");
  const envelopeId = "env_founder_canary";
  const approvalId = "apr_founder_canary";
  const envelope = canonicalJson({
    body: {
      schema_version: 4,
      kind: "echo-organization-record-envelope-v4",
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      envelope_id: envelopeId,
      event: { kind: "approved" },
      semantic_idempotency_key: semanticSha256,
      human_act_resolution_ref: { approval_id: approvalId, action: "approve" },
      predecessor_position: null,
      predecessor_record_sha256: null,
    },
    record_sha256: recordSha256,
  });
  const receipt = canonicalJson({
    schema_version: 2,
    kind: "echo-organization-record-receipt-v2",
    authority_id: manifest.authority_id,
    organization_id: manifest.organization_id,
    state_lineage_id: manifest.state_lineage_id,
    envelope_id: envelopeId,
    semantic_idempotency_key: semanticSha256,
    event_kind: "approved",
    record_position: 1,
    record_sha256: recordSha256,
    predecessor_record_sha256: null,
    record_head_position: 1,
    record_head_sha256: recordSha256,
    issued_at: issuedAt,
  });
  const record = new Database(join(state, "record-log.sqlite"));
  try {
    record
      .prepare(
        `INSERT INTO organization_record_log
         (position, envelope_id, event_kind, approval_id, action,
          semantic_idempotency_key, canonical_envelope, envelope_sha256,
          predecessor_position, predecessor_record_sha256, record_sha256,
          receipt_payload, receipt_issued_at)
         VALUES (1, ?, 'approved', ?, 'approve', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        envelopeId,
        approvalId,
        semanticSha256,
        envelope,
        sha256Digest(envelope),
        recordSha256,
        receipt,
        issuedAt,
      );
  } finally {
    record.close();
  }
  const built = buildReadableSearchGenerationV1(
    buildInputForCanary(
      state,
      manifest,
      { position: 1, record_sha256: recordSha256 },
      !options.pointer_uses_disabled_projector_contract,
    ),
  );
  const authority = new Database(join(state, "authority.sqlite"));
  try {
    const pointerCurrent = options.pointer_current ?? true;
    const pointerContractCurrent = options.pointer_current_contract ?? true;
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
        pointerContractCurrent
          ? built.manifest.retrieval_contract_sha256
          : sha256Digest("stale-retrieval-contract"),
        pointerCurrent ? 1 : 0,
        pointerCurrent ? recordSha256 : null,
        "2026-08-23T00:00:01.000Z",
      );
    const audit = new SqlitePersonRecordReadAuditV1(authority);
    const appendAudit = (
      mode: "layer1" | "layer2",
      resultCount: number | null | undefined,
      ownerTuple: "owner" | "other" | undefined,
      checkedAt: string,
    ) => {
      if (resultCount === null) return;
      audit.append({
        read_mode: mode,
        authority_id: manifest.authority_id,
        organization_id: manifest.organization_id,
        state_lineage_id: manifest.state_lineage_id,
        principal_id:
          ownerTuple === "other" ? "prn_other" : manifest.owner_principal_id,
        membership_id:
          ownerTuple === "other" ? "mem_other" : manifest.owner_membership_id,
        session_family_id: "sfm_founder_canary",
        result_count: resultCount ?? 1,
        response_sha256: sha256Digest(`${mode}-${checkedAt}`),
        checked_at: checkedAt,
      });
    };
    appendAudit(
      "layer1",
      options.layer1_result_count,
      options.layer1_owner_tuple,
      "2026-08-23T00:00:02.000Z",
    );
    appendAudit(
      "layer2",
      options.layer2_result_count,
      options.layer2_owner_tuple,
      "2026-08-23T00:00:03.000Z",
    );
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
  const approved = proposals.filter((proposal) => proposal.approved);
  const record = new Database(join(state, "record-log.sqlite"));
  let head: { position: number; record_sha256: Sha256Digest } | undefined;
  try {
    for (const [index, proposal] of approved.entries()) {
      const position = index + 1;
      const recordSha256 = sha256Digest(`synthetic-fixture-record-${String(position)}`);
      const semanticIdempotencyKey = sha256Digest(`synthetic-fixture-semantic-${String(position)}`);
      const envelopeId = `env_synthetic_fixture_${String(position)}`;
      const envelope = canonicalJson({
        body: {
          schema_version: 4,
          kind: "echo-organization-record-envelope-v4",
          authority_id: manifest.authority_id,
          organization_id: manifest.organization_id,
          state_lineage_id: manifest.state_lineage_id,
          envelope_id: envelopeId,
          event: { kind: "approved" },
          semantic_idempotency_key: semanticIdempotencyKey,
          human_act_resolution_ref: { approval_id: proposal.approval_id, action: "approve" },
          predecessor_position: head?.position ?? null,
          predecessor_record_sha256: head?.record_sha256 ?? null,
        },
        record_sha256: recordSha256,
      });
      const receipt = canonicalJson({
        schema_version: 2,
        kind: "echo-organization-record-receipt-v2",
        authority_id: manifest.authority_id,
        organization_id: manifest.organization_id,
        state_lineage_id: manifest.state_lineage_id,
        envelope_id: envelopeId,
        semantic_idempotency_key: semanticIdempotencyKey,
        event_kind: "approved",
        record_position: position,
        record_sha256: recordSha256,
        predecessor_record_sha256: head?.record_sha256 ?? null,
        record_head_position: position,
        record_head_sha256: recordSha256,
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
          envelopeId,
          proposal.approval_id,
          semanticIdempotencyKey,
          envelope,
          sha256Digest(envelope),
          head?.position ?? null,
          head?.record_sha256 ?? null,
          recordSha256,
          receipt,
          SYNTHETIC_ISSUED_AT,
        );
      head = { position, record_sha256: recordSha256 };
    }
  } finally {
    record.close();
  }
  if (head === undefined) throw new Error("synthetic fixture evidence has no records");
  const built = buildReadableSearchGenerationV1(
    buildInputForCanary(state, manifest, head, true),
  );
  const authority = new Database(join(state, "authority.sqlite"));
  try {
    const semantic = insertStagingSyntheticSource(authority, manifest, {
      pending: shape === "pending" ? ["fictional-budget-sync"] : [],
    });
    for (const [index, proposal] of proposals.entries()) insertSyntheticProposal(authority, semantic, { index, ...proposal });
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
        built.manifest.retrieval_contract_sha256,
        head.position,
        head.record_sha256,
        "2026-08-23T00:00:01.000Z",
      );
    const audit = new SqlitePersonRecordReadAuditV1(authority);
    for (const [mode, checkedAt] of [
      ["layer1", "2026-08-23T00:00:02.000Z"],
      ["layer2", "2026-08-23T00:00:03.000Z"],
    ] as const) {
      audit.append({
        read_mode: mode,
        authority_id: manifest.authority_id,
        organization_id: manifest.organization_id,
        state_lineage_id: manifest.state_lineage_id,
        principal_id: manifest.owner_principal_id,
        membership_id: manifest.owner_membership_id,
        session_family_id: "sfm_synthetic_fixture",
        result_count: 1,
        response_sha256: sha256Digest(`${mode}-${checkedAt}`),
        checked_at: checkedAt,
      });
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
    let stdout = "";
    let stderr = "";
    // The retired channel flag is refused before bootstrap changes anything.
    expect(await runOrganizationAuthoritySetupCli(
      [...bootstrapArgs(state), "--slack-approval-channel-id", "C123"],
      { stdout: (value) => (stdout += value), stderr: (value) => (stderr += value) },
      dependencies(order),
    )).toBe(1);
    expect(order).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage:");
    stderr = "";
    const status = await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: (value) => (stdout += value), stderr: (value) => (stderr += value) },
      dependencies(order),
    );

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(order).toEqual([
      "initialize:2026-08-22T12:00:00.000Z:clean-founder-v1",
      "credentials",
      expect.stringMatching(/^invite:mem_/),
    ]);
    expect(JSON.parse(stdout)).toEqual({
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
    await runOrganizationAuthoritySetupCli(bootstrapArgs(state), { stdout: () => undefined, stderr: () => undefined }, dependencies([]));
    const path = join(state, "onboarding", "clean-founder-v1.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { setup_seed: Record<string, unknown> };
    const v1 = { ...manifest, schema_version: 1, kind: "echo-clean-founder-onboarding-manifest-v1",
      slack_approval_channel_id: "C123", slack_connection_id: "con_00000000-0000-4000-8000-000000000001",
      setup_seed: { ...manifest.setup_seed, slack_connection_id: "con_00000000-0000-4000-8000-000000000001" } };
    writeFileSync(path, `${canonicalJson(v1)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(() => readOrganizationAuthoritySetupManifest(state)).toThrow(
      "organization setup manifest predates in-app Slack setup; install this release's host tooling, then run replace-rehearsal",
    );
    let stderr = "";
    expect(await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value) }, dependencies([]))).toBe(1);
    expect(stderr).toContain("install this release's host tooling, then run replace-rehearsal");
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
          { stdout: () => undefined, stderr: () => undefined },
        );
        expect(status).toBe(0);
      },
      issue_invitation: async (input) => {
        invitationIssues += 1;
        const status = await runOrganizationAuthorityPersonAdministrationCli(
          [
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
          ],
          { stdout: () => undefined, stderr: () => undefined },
        );
        expect(status).toBe(0);
      },
    };
    let stderr = "";
    const io = {
      stdout: () => undefined,
      stderr: (value: string) => (stderr += value) };

    const bootstrapStatus = await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      io,
      defaultPathDependencies,
    );
    expect(bootstrapStatus, stderr).toBe(0);
    const manifest = readOrganizationAuthoritySetupManifest(state);
    expect(JSON.parse(readFileSync(manifest.invitation_path, "utf8")),).toMatchObject({
      schema_version: 2,
      expected_email: "founder@example.com",
    });

    expect(
      await runOrganizationAuthoritySetupCli(
        ["resume", "--state-dir", state],
        io,
        defaultPathDependencies,
      ),
    ).toBe(0);
    expect(invitationIssues).toBe(1);

    // A pre-v2 artifact remains a usable legacy invitation when its grant is
    // otherwise valid. This protects a setup resumed after an older release.
    const legacy = JSON.parse(
      readFileSync(manifest.invitation_path, "utf8"),
    ) as Record<string, unknown>;
    delete legacy.expected_email;
    legacy.schema_version = 1;
    writeFileSync(
      manifest.invitation_path,
      `${canonicalJson(legacy)}\n`,
      { mode: 0o600 ,}
    );
    chmodSync(manifest.invitation_path, 0o600);
    let statusOutput = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (statusOutput += value) ,}
      ),
    ).toBe(0);
    expect(JSON.parse(statusOutput)).toMatchObject({
      founder_invitation_valid: true,
    });

    // A manifest alone cannot opt an identity into legacy issuance.
    const historicManifest = JSON.parse(
      readFileSync(join(state, "onboarding", "clean-founder-v1.json"), "utf8"),
    ) as Record<string, unknown>;
    historicManifest.owner_email = "founder@localhost";
    writeFileSync(
      join(state, "onboarding", "clean-founder-v1.json"),
      `${canonicalJson(historicManifest)}\n`,
      { mode: 0o600 },
    );
    chmodSync(join(state, "onboarding", "clean-founder-v1.json"), 0o600);
    unlinkSync(manifest.invitation_path);

    expect(
      await runOrganizationAuthoritySetupCli(
        ["resume", "--state-dir", state],
        io,
        defaultPathDependencies,
      ),
    ).toBe(1);
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

    expect(
      await runOrganizationAuthoritySetupCli(
        ["resume", "--state-dir", state],
        io,
        defaultPathDependencies,
      ),
    ).toBe(0);
    expect(invitationIssues).toBe(1);
    expect(
      JSON.parse(readFileSync(manifest.invitation_path, "utf8")),
    ).toMatchObject({ schema_version: 1 });
    expect(
      JSON.parse(readFileSync(manifest.invitation_path, "utf8")),
    ).not.toHaveProperty("expected_email");const mismatchedPath = join(dirname(manifest.invitation_path), "other.json",);
    expect(
      await runOrganizationAuthorityPersonAdministrationCli(
        [
          "invite",
          "--state-dir",
          manifest.state_directory,
          "--oidc-config",
          manifest.oidc_config_path,
          "--pkce-key-file",
          manifest.pkce_key_file,
          "--membership-id",
          manifest.owner_membership_id,
          "--expected-email",
          "other@example.com",
          "--authority-url",
          manifest.authority_url,
          "--out",
          mismatchedPath,
        ],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).toBe(0);
    const mismatchedLegacy = JSON.parse(
      readFileSync(mismatchedPath, "utf8"),
    ) as Record<string, unknown>;
    delete mismatchedLegacy.expected_email;
    mismatchedLegacy.schema_version = 1;
    writeFileSync(
      manifest.invitation_path,
      `${canonicalJson(mismatchedLegacy)}\n`,
      { mode: 0o600 },
    );
    chmodSync(manifest.invitation_path, 0o600);
    statusOutput = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (statusOutput += value) ,}
      ),
    ).toBe(0);
    expect(JSON.parse(statusOutput)).toMatchObject({
      founder_invitation_valid: false,
    });
  });

  it("rejects a noncanonical owner email before creating state or connecting Slack", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    let stderr = "";
    const status = await runOrganizationAuthoritySetupCli(
      [
        "bootstrap",
        "--state-dir",
        state,
        "--organization-name",
        "ECHO",
        "--owner-display-name",
        "Founder",
        "--owner-email",
        "Founder@Example.com",
        "--authority-url",
        "https://authority.example",
        "--oidc-config",
        join(dirname(state), "oidc.json"),
      ],
      {
        stdout: () => undefined,
        stderr: (value) => (stderr += value) },
      dependencies(order),
    );

    expect(status).toBe(1);
    expect(stderr).toContain("canonical lowercase email");
    expect(order).toEqual([]);
  });

  it("rejects OIDC configuration before creating a setup plan, genesis, or Slack connection", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    writeFileSync(join(dirname(state), "oidc.json"), "{}", { mode: 0o600 });
    let stderr = "";

    const result = await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: (value) => (stderr += value) },
      dependencies(order),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("OIDC config has an unexpected shape");
    expect(order).toEqual([]);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.clean-founder-setup-plan-v1.json`)).toBe(false);
  });

  it("rejects a legacy onboarding manifest shape instead of treating it as compatible", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined },
      dependencies(order),
    );
    const path = join(state, "onboarding", "clean-founder-v1.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete manifest.setup_seed;
    delete manifest.owner_email;
    delete manifest.organization_name;
    delete manifest.owner_display_name;
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(() => readOrganizationAuthoritySetupManifest(state)).toThrow(
      "organization setup manifest is invalid",
    );
  });

  it("refuses resume when state exists but its exact setup plan is missing", async () => {
    const state = stateDirectory();
    mkdirSync(state, { mode: 0o700 });
    let stderr = "";

    const result = await runOrganizationAuthoritySetupCli(
      ["resume", "--state-dir", state],
      {
        stdout: () => undefined,
        stderr: (value) => (stderr += value),
      },
      dependencies([]),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("restore the exact setup plan");
    expect(stderr).toContain("new state directory");
  });

  it("finalizes from the private manifest without asking for IDs", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const deps = dependencies(order);
    await runOrganizationAuthoritySetupCli(
      [
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
        "https://authority.example",
        "--oidc-config",
        join(dirname(state), "oidc.json"),
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined },
      deps,
    );
    order.splice(0);
    let stdout = "";
    const status = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      {
        stdout: (value) => (stdout += value),
        stderr: () => undefined },
      {
        ...deps,
        read_setup_stage: () => CONNECTED_STAGE,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          llm_credential_valid: true,
          source_admission_present: false,
        }),
      },
    );

    expect(status).toBe(0);
    expect(order).toEqual([]);
    expect(stdout).not.toContain("con_clean-founder");
    expect(JSON.parse(stdout)).toMatchObject({ source_mode: "none", source_admission_present: false });
  });

  it("queues fixture meetings only for the exact staging Authority", async () => {
    const state = stateDirectory("https://authority-staging.echobrain.org");
    const order: string[] = [];
    const deps = dependencies(order);
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(
      await runOrganizationAuthoritySetupCli(
        bootstrapArgs(state, "https://authority-staging.echobrain.org"),
        io,
        deps,
      ),
    ).toBe(0);
    order.splice(0);
    const result = await runOrganizationAuthoritySetupCli(
      [
        "finalize",
        "--state-dir",
        state,
        "--staging-synthetic-meetings-dir",
        "/echo-clean/meetings",
      ],
      io,
      {
        ...deps,
        read_setup_stage: () => CONNECTED_STAGE,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          llm_credential_valid: true,
          source_admission_present: false,
        }),
      },
    );
    expect(result).toBe(0);
    expect(order).toEqual(["queue-synthetic:/echo-clean/meetings"]);

    const productionState = stateDirectory();
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(productionState), io, deps)).toBe(0);
    let stderr = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        [
          "finalize",
          "--state-dir",
          productionState,
          "--staging-synthetic-meetings-dir",
          "/echo-clean/meetings",
        ],
        { ...io, stderr: (value) => (stderr += value) },
        {
          ...deps,
          read_setup_stage: () => CONNECTED_STAGE,
          read_initial_owner_setup_status: () => ({
            founder_oidc_bound: true,
            founder_slack_link_active: true,
            llm_credential_valid: true,
            source_admission_present: false,
          }),
        },
      ),
    ).toBe(1);
    expect(stderr).toContain("staging synthetic meeting source is allowed only");
  });

  it("queues the fixture meetings again on a synthetic finalize retry", async () => {
    const state = stateDirectory("https://authority-staging.echobrain.org");
    const order: string[] = [];
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(
      await runOrganizationAuthoritySetupCli(
        bootstrapArgs(state, "https://authority-staging.echobrain.org"),
        io,
        dependencies(order),
      ),
    ).toBe(0);
    order.splice(0);
    expect(
      await runOrganizationAuthoritySetupCli(
        [
          "finalize",
          "--state-dir",
          state,
          "--staging-synthetic-meetings-dir",
          "/echo-clean/meetings",
        ],
        io,
        {
          ...dependencies(order),
          read_setup_stage: () => CONNECTED_STAGE,
          read_initial_owner_setup_status: () => ({
            founder_oidc_bound: true,
            founder_slack_link_active: true,
            llm_credential_valid: true,
            source_mode: "staging_synthetic",
            source_admission_present: true,
          }),
        },
      ),
    ).toBe(0);
    expect(order).toEqual(["queue-synthetic:/echo-clean/meetings"]);
  });

  it("sets up the owner's synthetic source for the canary when staging finalize has no fixtures", async () => {
    const state = stateDirectory(STAGING_ORIGIN);
    const order: string[] = [];
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state, STAGING_ORIGIN), io, dependencies(order))).toBe(0);
    order.splice(0);
    let stdout = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["finalize", "--state-dir", state],
        { ...io, stdout: (value) => (stdout += value) },
        {
          ...dependencies(order),
          read_setup_stage: () => CONNECTED_STAGE,
          read_initial_owner_setup_status: () => ({
            founder_oidc_bound: true,
            founder_slack_link_active: true,
            llm_credential_valid: true,
            source_admission_present: false,
          }),
        },
      ),
    ).toBe(0);
    expect(order).toEqual(["queue-synthetic:canary"]);
    expect(JSON.parse(stdout)).toMatchObject({ source_mode: "staging_canary", source_admission_present: true, canary_status: "not_complete" });
  });

  it("finalize queues fixture meetings into the owner's synthetic source and admits no organization source", async () => {
    const state = stateDirectory(STAGING_ORIGIN);
    const { queue_staging_synthetic_meetings: _stub, ...real } = dependencies([]);
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state, STAGING_ORIGIN), io, real)).toBe(0);
    const manifest = readOrganizationAuthoritySetupManifest(state);
    mkdirSync(dirname(manifest.llm_credential_file), { recursive: true, mode: 0o700 });
    writeFileSync(manifest.llm_credential_file, "l".repeat(40), { mode: 0o600 });
    chmodSync(manifest.llm_credential_file, 0o600);
    let stdout = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["finalize", "--state-dir", state, "--staging-synthetic-meetings-dir", fictionalFixtureDirectory()],
        { ...io, stdout: (value) => (stdout += value) },
        {
          ...real,
          read_setup_stage: () => CONNECTED_STAGE,
          read_initial_owner_setup_status: () => ({
            founder_oidc_bound: true,
            founder_slack_link_active: true,
            llm_credential_valid: true,
            source_admission_present: false,
          }),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ source_mode: "staging_synthetic", source_admission_present: true });
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
    stdout = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (stdout += value) },
        { ...real, read_setup_stage: () => CONNECTED_STAGE },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ source_mode: "staging_synthetic", source_admission_present: true });
  });

  it("rejects a fixture selector outside finalization", async () => {
    const state = stateDirectory();
    let stderr = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        [
          "status",
          "--state-dir",
          state,
          "--staging-synthetic-meetings-dir",
          "/echo-clean/meetings",
        ],
        {
          stdout: () => undefined,
          stderr: (value) => (stderr += value) },
        dependencies([]),
      ),
    ).toBe(1);
    expect(stderr).toContain("usage:");
  });

  it("reports a synthetic admitted source without demanding the release canary record", async () => {
    const state = stateDirectory("https://authority-staging.echobrain.org");
    const order: string[] = [];
    const io = { stdout: () => undefined, stderr: () => undefined };
    const deps: OrganizationAuthoritySetupCliDependencies = {
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
        source_mode: "staging_synthetic",
      }),
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
    expect(
      await runOrganizationAuthoritySetupCli(
        bootstrapArgs(state, "https://authority-staging.echobrain.org"),
        io,
        deps,
      ),
    ).toBe(0);
    let stdout = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (stdout += value) },
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
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
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined },
      base,
    );
    order.splice(0);

    let stderr = "";
    const result = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value) },
      {
        ...base,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: false,
          founder_slack_link_active: false,
          llm_credential_valid: false,
          source_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    // The real durable stage: nobody has set up Slack in the ECHO app yet.
    expect(stderr).toContain(
      "organization setup finalize requires initial-owner OIDC binding, organization Slack connection, initial-owner Slack identity link, LLM credential",
    );
    expect(order).toEqual([]);
  });

  it("proves genesis before a full-status seam can publish anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined },
      base,
    );
    order.splice(0);
    writeFileSync(join(state, "state-lineage-root.v2.json"), "{}", { mode: 0o600 ,});

    let stderr = "";
    const result = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value) },
      {
        ...base,
        read_setup_stage: () => CONNECTED_STAGE,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          llm_credential_valid: true,
          source_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    expect(stderr).toContain("valid state-lineage root manifest");
    expect(order).toEqual([]);
  });

  it("finalize is idempotent with no meeting source and leaves intake idle", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runOrganizationAuthoritySetupCli(bootstrapArgs(state), { stdout: () => undefined, stderr: () => undefined }, base);
    order.splice(0);
    const deps: OrganizationAuthoritySetupCliDependencies = {
      ...base,
      read_initial_owner_setup_status: () => ({
        founder_oidc_bound: true, founder_slack_link_active: true, llm_credential_valid: true,
        source_admission_present: false,
      }),
      read_setup_stage: () => CONNECTED_STAGE,
    };
    let stdout = "";
    const io = { stdout: (value: string) => { stdout += value; }, stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(["finalize", "--state-dir", state], io, deps)).toBe(0);
    expect(await runOrganizationAuthoritySetupCli(["finalize", "--state-dir", state], io, deps)).toBe(0);
    expect(order).toEqual([]);
    for (const line of stdout.trim().split("\n")) {
      expect(JSON.parse(line)).toMatchObject({ source_mode: "none", source_admission_present: false });
    }
    for (const command of ["status", "resume"]) {
      stdout = "";
      expect(await runOrganizationAuthoritySetupCli([command, "--state-dir", state], io, deps)).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
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
    let stdout = "";
    const io = { stdout: (value: string) => (stdout += value), stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, deps)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      next_step: "connect_slack_in_app",
      next_instruction: "An owner runs person tools setup --tool slack and pastes a Slack app configuration token.",
    });
    expect(stdout).not.toContain("invitation_path");
    expect(order).toEqual(["initialize:2026-08-22T12:00:00.000Z:clean-founder-v1"]);

    stage.slack_connected = true;
    stdout = "";
    expect(await runOrganizationAuthoritySetupCli(["status", "--state-dir", state], io, deps)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ slack_connected: true, next_step: "complete_founder_slack_link" });
    stdout = "";
    expect(await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      next_step: "complete_founder_slack_link",
      next_instruction: "The owner runs person tools connect --tool slack to link their own Slack.",
    });
  });

  it("installs only the LLM credential from a private file without printing its value", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      {
        stdout: () => undefined,
        stderr: () => undefined },
      dependencies(order),
    );
    const credentialDirectory = join(state, "credentials");
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    const sourceDirectory = join(dirname(state), "private-inputs");
    mkdirSync(sourceDirectory, { mode: 0o700 });
    const values = {
      granola: `grn_${"g".repeat(40)}`,
      owner: "founder@example.com",
      llm: "l".repeat(40),
    };
    const sources = {
      granola: join(sourceDirectory, "granola"),
      owner: join(sourceDirectory, "owner-email"),
      llm: join(sourceDirectory, "llm"),
    };
    for (const [name, path] of Object.entries(sources)) {
      writeFileSync(path, values[name as keyof typeof values], { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    let stdout = "";
    let stderr = "";
    const result = await runOrganizationAuthoritySetupCli(
      [
        "credentials-install",
        "--state-dir",
        state,
        "--llm-credential-file",
        sources.llm,
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value) },
    );

    expect(result).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      credentials_ready: true,
    });
    for (const value of Object.values(values)) expect(stdout).not.toContain(value);
    expect(readFileSync(join(credentialDirectory, "llm-credential"), "utf8"),)
      .toBe(values.llm);
    for (const filename of ["llm-credential"]) {
      expect(statSync(join(credentialDirectory, filename)).mode & 0o777).toBe(
        0o600,
      );
    }
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
    const io = {
      stdout: () => undefined,
      stderr: () => undefined };

    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, deps),).toBe(1);
    let status = "";
    expect(
      await runOrganizationAuthoritySetupCli(["status", "--state-dir", state], {
        ...io,
        stdout: (value) => (status += value),
      }),
    ).toBe(0);
    expect(status).not.toContain("founder@example.com");
    expect(status).not.toContain(state);
    expect(status).not.toContain("oau_");
    expect(JSON.parse(status)).toMatchObject({
      setup_plan_present: true,
      genesis_published: false,
      next_step: "resume_bootstrap",
    });

    resetFails = false;
    failAfter = "credentials";
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps,),
    ).toBe(1);
    failAfter = "invitation";
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps,),
    ).toBe(1);
    expect(order.filter((value) => value === "credentials")).toHaveLength(1);
    failAfter = undefined;
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps,),
    ).toBe(0);
    expect(order.filter((value) => value === "invitation")).toHaveLength(1);
  });

  it("reports only safe incomplete and complete one-note canary evidence", async () => {
    // Only staging proves a rehearsal; every other origin completes source-free.
    const state = stateDirectory(STAGING_ORIGIN);
    const order: string[] = [];
    let canaryComplete = false;
    const deps = readyStatusDependencies(order, () => canaryComplete);
    const io = {
      stdout: () => undefined,
      stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state, STAGING_ORIGIN), io, deps),).toBe(0);

    let incompleteOutput = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (incompleteOutput += value) },
        deps,
      ),
    ).toBe(0);
    const incomplete = JSON.parse(incompleteOutput) as Record<string, unknown>;
    expect(incomplete).not.toHaveProperty("slack_approval_binding_active");
    expect(incomplete).toMatchObject({
      next_step: "ready_to_start",
      canary_status: "not_complete",
      source_progress_observed: false,
      approved_record_present: false,
      active_generation_current: false,
      owner_layer1_read_after_head: false,
      owner_layer2_read_after_generation: false,
    });

    canaryComplete = true;
    let completeOutput = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["status", "--state-dir", state],
        { ...io, stdout: (value) => (completeOutput += value) },
        deps,
      ),
    ).toBe(0);
    const complete = JSON.parse(completeOutput) as Record<string, unknown>;
    expect(complete).toMatchObject({
      next_step: "complete",
      canary_status: "complete",
      source_progress_observed: true,
      approved_record_present: true,
      active_generation_current: true,
      owner_layer1_read_after_head: true,
      owner_layer2_read_after_generation: true,
    });
    expect(completeOutput).not.toContain("oau_");
    expect(completeOutput).not.toContain("org_");
    expect(completeOutput).not.toContain("prn_");
    expect(completeOutput).not.toContain("sha256:");
    expect(completeOutput).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(complete).not.toHaveProperty("slack_verification");
    expect(complete).not.toHaveProperty("granola_admission_proof");
    expect(complete).not.toHaveProperty("next_instruction");

    let resumedOutput = "";
    expect(
      await runOrganizationAuthoritySetupCli(
        ["resume", "--state-dir", state],
        { ...io, stdout: (value) => (resumedOutput += value) },
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(resumedOutput)).toMatchObject({ next_step: "complete" });
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
      const originalHost = process.env.ECHO_CLEAN_AUTHORITY_HOST;
      const originalReleaseId = process.env.ECHO_CLEAN_RELEASE_ID;
      process.env.ECHO_CLEAN_AUTHORITY_HOST = "authority-staging.echobrain.org";
      process.env.ECHO_CLEAN_RELEASE_ID = CURRENT_RELEASE;
      try {
        const state = stateDirectory(STAGING_ORIGIN);
        const prereq = readyStatusDependencies([]);
        const productionDependencies: OrganizationAuthoritySetupCliDependencies = {
          ...prereq,
          read_setup_canary_evidence: undefined,
        };
        const io = {
          stdout: () => undefined,
          stderr: () => undefined };
        expect(
          await runOrganizationAuthoritySetupCli(bootstrapArgs(state, STAGING_ORIGIN), io, productionDependencies,),
        ).toBe(0);
        installDurableCanaryFixture(state, fixtureOptions);

        let stdout = "";
        expect(
          await runOrganizationAuthoritySetupCli(
            ["status", "--state-dir", state],
            { ...io, stdout: (value) => (stdout += value) },
            productionDependencies,
          ),
        ).toBe(0);
        const status = JSON.parse(stdout) as Record<string, unknown>;
        expect(status).toMatchObject({
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
      } finally {
        if (originalHost === undefined) delete process.env.ECHO_CLEAN_AUTHORITY_HOST;
        else process.env.ECHO_CLEAN_AUTHORITY_HOST = originalHost;
        if (originalReleaseId === undefined) delete process.env.ECHO_CLEAN_RELEASE_ID;
        else process.env.ECHO_CLEAN_RELEASE_ID = originalReleaseId;
      }
    },
  );

  it("completes source-free outside staging even when no rehearsal evidence exists", async () => {
    const state = stateDirectory();
    const productionDependencies: OrganizationAuthoritySetupCliDependencies = {
      ...readyStatusDependencies([]),
      read_setup_canary_evidence: undefined,
    };
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, productionDependencies)).toBe(0);
    for (const command of ["status", "resume"]) {
      let stdout = "";
      expect(await runOrganizationAuthoritySetupCli([command, "--state-dir", state], { ...io, stdout: (value) => (stdout += value) }, productionDependencies)).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
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
      const io = {
        stdout: () => undefined,
        stderr: () => undefined };
      const dependencies: OrganizationAuthoritySetupCliDependencies = {
        ...readyStatusDependencies([]),
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          llm_credential_valid: true,
          source_mode: "staging_synthetic",
          source_admission_present: true,
        }),
        read_setup_canary_evidence: undefined,
      };
      expect(
        await runOrganizationAuthoritySetupCli(
          bootstrapArgs(state, STAGING_ORIGIN),
          io,
          dependencies,
        ),
      ).toBe(0);
      installSyntheticFixtureApprovalEvidence(state, shape);
      let stdout = "";
      expect(
        await runOrganizationAuthoritySetupCli(
          ["status", "--state-dir", state],
          { ...io, stdout: (value) => (stdout += value) },
          dependencies,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ next_step: nextStep });
    },
  );

  it("reports canary evidence once the current release's synthetic canary proposal has an approved record, only on staging", async () => {
    const originalHost = process.env.ECHO_CLEAN_AUTHORITY_HOST;
    const originalReleaseId = process.env.ECHO_CLEAN_RELEASE_ID;
    const io = {
      stdout: () => undefined,
      stderr: () => undefined };
    const productionDependencies: OrganizationAuthoritySetupCliDependencies = {
      ...readyStatusDependencies([]),
      read_setup_canary_evidence: undefined,
    };
    const statusAfter = async (authorityUrl: string, synthetic: "owner" | "granola", release = CURRENT_RELEASE) => {
      const state = stateDirectory(authorityUrl);
      expect(
        await runOrganizationAuthoritySetupCli(
          bootstrapArgs(state, authorityUrl),
          io,
          productionDependencies,
        ),
      ).toBe(0);
      installDurableCanaryFixture(state, { synthetic_canary: synthetic, synthetic_canary_release: release });
      let stdout = "";
      expect(
        await runOrganizationAuthoritySetupCli(
          ["status", "--state-dir", state],
          { ...io, stdout: (value) => (stdout += value) },
          productionDependencies,
        ),
      ).toBe(0);
      return JSON.parse(stdout) as Record<string, unknown>;
    };
    try {
      process.env.ECHO_CLEAN_AUTHORITY_HOST = "authority-staging.echobrain.org";
      process.env.ECHO_CLEAN_RELEASE_ID = CURRENT_RELEASE;
      expect(await statusAfter(STAGING_ORIGIN, "owner")).toMatchObject({
        source_progress_observed: true,
        synthetic_staging_canary_observed: true,
        next_step: "complete",
      });
      // An approved canary from an earlier release is not evidence for the running one.
      expect(await statusAfter(STAGING_ORIGIN, "owner", "clean-v1-staging-earlier-release")).toMatchObject({
        synthetic_staging_canary_observed: false,
        next_step: "ready_to_start",
      });
      // A canary-shaped proposal from another meeting tool is not synthetic evidence.
      expect(await statusAfter(STAGING_ORIGIN, "granola")).toMatchObject({
        source_progress_observed: false,
        synthetic_staging_canary_observed: false,
        next_step: "ready_to_start",
      });
      // Outside staging the synthetic source is not evidence, and none is required.
      expect(await statusAfter("https://authority.example", "owner")).toMatchObject({
        synthetic_staging_canary_observed: false,
        canary_status: "not_required",
        next_step: "complete",
      });
      delete process.env.ECHO_CLEAN_RELEASE_ID;
      expect(await statusAfter(STAGING_ORIGIN, "owner")).toMatchObject({
        synthetic_staging_canary_observed: false,
        next_step: "ready_to_start",
      });
      process.env.ECHO_CLEAN_RELEASE_ID = CURRENT_RELEASE;
      delete process.env.ECHO_CLEAN_AUTHORITY_HOST;
      expect(await statusAfter(STAGING_ORIGIN, "owner")).toMatchObject({
        synthetic_staging_canary_observed: false,
        next_step: "ready_to_start",
      });
    } finally {
      if (originalHost === undefined)
        delete process.env.ECHO_CLEAN_AUTHORITY_HOST;
      else process.env.ECHO_CLEAN_AUTHORITY_HOST = originalHost;
      if (originalReleaseId === undefined)
        delete process.env.ECHO_CLEAN_RELEASE_ID;
      else process.env.ECHO_CLEAN_RELEASE_ID = originalReleaseId;
    }
  });
});
