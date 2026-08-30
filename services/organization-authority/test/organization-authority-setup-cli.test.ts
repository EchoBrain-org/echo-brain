import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  buildReadableSearchGenerationV1,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  readableSearchPlaneBaselineSha256V1,
} from "@echo-brain/organization-retrieval/readable-search-runtime-v1";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrganizationAuthoritySetupManifest,
  runOrganizationAuthoritySetupCli,
  type OrganizationAuthoritySetupCliDependencies,
} from "../src/composition/organization-authority-setup-cli.js";
import { initializeAuthorityState } from "../src/composition/authority-state-initializer.js";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { readableSearchRuntimeContractV1 } from "../src/composition/readable-search-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-clean-founder-"));
  temporaryDirectories.push(root);
  const oidcConfig = join(root, "oidc.json");
  writeFileSync(
    oidcConfig,
    JSON.stringify({
      issuer: "https://issuer.example",
      client_id: "founder-client",
      redirect_uri: "https://authority.example/v2/session/oidc/callback",
      tenant: { kind: "issuer" },
      id_token_algorithms: ["RS256"],
      client_authentication: "none",
    }),
    { mode: 0o600 },
  );
  chmodSync(oidcConfig, 0o600);
  return join(root, "state");
}

function dependencies(order: string[]): OrganizationAuthoritySetupCliDependencies {
  return {
    now: () => "2026-08-22T12:00:00.000Z",
    initialize_state: (input) => {
      order.push(
        `initialize:${input.created_at}:${input.creating_artifact_revision}`,
      );
      return initializeAuthorityState(input);
    },
    initialize_credentials: async () => {
      order.push("credentials");
    },
    connect_slack: async (input) => {
      order.push(`slack:${await input.read_stdin()}`);
      return {
        connection_id: input.connection_id ?? "con_clean-founder",
        verification: {
          workspace_id: "T_WORKSPACE",
          enterprise_id: null,
          app_id: "A_APP",
          bot_id: "B_BOT",
          bot_user_id: "U_BOT",
          identity_link_channel_id: input.approval_channel_id,
          required_scopes: [
            "channels:history",
            "channels:read",
            "chat:write",
            "im:history",
            "im:write",
            "reactions:read",
            "users:read",
          ],
          identity_link_channel_access: "verified" as const,
          selected_channel_public: true,
          selected_channel_active: true,
          bot_membership_verified: true,
          bot_access_verified: true,
          verified_at: "2026-08-22T12:00:00.000Z",
        },
      };
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
    admit_source: async (input) => {
      order.push(`admit:${input.granola_credential_file}`);
    },
  };
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
      granola_credentials_valid: true,
      granola_admission_present: true,
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
  readonly cursor_version?: number;
  readonly pointer_current?: boolean;
  readonly pointer_current_contract?: boolean;
  readonly layer1_result_count?: number | null;
  readonly layer2_result_count?: number | null;
  readonly layer1_owner_tuple?: "owner" | "other";
  readonly layer2_owner_tuple?: "owner" | "other";
}

function buildInputForCanary(
  state: string,
  manifest: ReturnType<typeof readOrganizationAuthoritySetupManifest>,
  recordSha256: Sha256Digest,
) {
  const contract = readableSearchRuntimeContractV1();
  const plane = (role: string, schemaSha256: Sha256Digest) => {
    const manifestJson = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      database_schema_version: 1,
      schema_sha256: schemaSha256,
      created_at: "2026-08-22T12:00:00.000Z",
      creating_artifact_revision: "clean-founder-v1",
    });
    return {
      database_schema_version: 1 as const,
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
          readableSearchPlaneBaselineSha256V1(READABLE_SEARCH_FACTS_BASELINE_V1),
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256V1(READABLE_SEARCH_CONTENT_BASELINE_V1),
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256V1(READABLE_SEARCH_LEXICAL_BASELINE_V1),
        ),
      },
    },
    exact_head: {
      authority_id: manifest.authority_id,
      organization_id: manifest.organization_id,
      state_lineage_id: manifest.state_lineage_id,
      position: 1,
      record_sha256: recordSha256,
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
    buildInputForCanary(state, manifest, recordSha256),
  );
  const authority = new Database(join(state, "authority.sqlite"));
  try {
    const admissionSemanticSha256 = sha256Digest("founder-canary-admission");
    authority
      .prepare(
        `INSERT INTO authority_live_source_admission_v2
         (singleton, organization_id, principal_id, membership_id, membership_type,
          source_adapter_id, source_adapter_version, source_adapter_instance_id,
          normalizer_version, source_custodian_sha256,
          source_custodian_assurance, source_custodian_observed_at,
          source_credential_reference_sha256, initial_cursor, cutoff_at,
          processor_adapter_id, processor_instance_id, processor_adapter_version,
          processor_configuration_sha256, processor_credential_reference_sha256,
          semantic_input_sha256, admitted_at)
         VALUES (1, ?, ?, ?, 'owner', 'granola', '2.2.0', 'founder-granola-v1', '2.2.0',
                 ?, 'provider_record_owner_observed', ?, ?, 'granola:v1:live:admission', ?,
                 'llm', 'founder-llm-v1', '1.3.0+processing.a', ?, ?, ?, ?)`,
      )
      .run(
        manifest.organization_id,
        manifest.owner_principal_id,
        manifest.owner_membership_id,
        sha256Digest("founder@example.com"),
        issuedAt,
        sha256Digest("source-credential"),
        issuedAt,
        sha256Digest("processor-configuration"),
        sha256Digest("processor-credential"),
        admissionSemanticSha256,
        issuedAt,
      );
    authority
      .prepare(
        `INSERT INTO authority_live_source_progress_v2
         (singleton, admission_semantic_input_sha256, cursor, cursor_version, updated_at)
         VALUES (1, ?, 'granola:v1:live:canary', ?, ?)`,
      )
      .run(admissionSemanticSha256, options.cursor_version ?? 1, issuedAt);
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
  } finally {
    authority.close();
  }
}

describe("Organization Authority setup coordinator", () => {
  const bootstrapArgs = (state: string) => [
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
    "--slack-approval-channel-id",
    "C123",
  ];

  it("runs reset, credentials, Slack, manifest, and invitation last", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    let stdout = "";
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
        "founder@example.com",
        "--authority-url",
        "https://authority.example",
        "--oidc-config",
        join(dirname(state), "oidc.json"),
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
        read_stdin: async () => "xoxb-test-token\n",
      },
      dependencies(order),
    );

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(order).toEqual([
      "initialize:2026-08-22T12:00:00.000Z:clean-founder-v1",
      "credentials",
      "slack:xoxb-test-token\n",
      expect.stringMatching(/^invite:mem_/),
    ]);
    const output = JSON.parse(stdout) as Record<string, string>;
    expect(output).toEqual({
      ok: true,
      invitation_path: join(
        state,
        "onboarding",
        "founder-person-invitation.json",
      ),
      slack_verification: {
        workspace_id: "T_WORKSPACE",
        enterprise_id: null,
        app_id: "A_APP",
        bot_id: "B_BOT",
        bot_user_id: "U_BOT",
        identity_link_channel_id: "C123",
        required_scopes: [
          "channels:history",
          "channels:read",
          "chat:write",
          "im:history",
          "im:write",
          "reactions:read",
          "users:read",
        ],
        identity_link_channel_access: "verified",
        selected_channel_public: true,
        selected_channel_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
        verified_at: "2026-08-22T12:00:00.000Z",
      },
      next_step: "resume_bootstrap",
      next_instruction:
        "Run echo-organization-authority-clean-founder resume --state-dir <absolute-path>.",
    });
    expect(stdout).not.toContain("xoxb-test-token");
    expect(stdout).not.toContain("con_clean-founder");

    const manifestPath = join(state, "onboarding", "clean-founder-v1.json");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(manifestPath, "utf8")).not.toContain("xoxb-test-token");
    expect(readOrganizationAuthoritySetupManifest(state)).toMatchObject({
      owner_membership_id: expect.stringMatching(/^mem_/),
      slack_connection_id: expect.stringMatching(/^con_/),
      granola_credential_file: join(state, "credentials", "granola-credential"),
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
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: () => undefined,
        stderr: (value) => (stderr += value),
        read_stdin: async () => "token",
      },
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
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "token" },
      dependencies(order),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("OIDC config has an unexpected shape");
    expect(order).toEqual([]);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.clean-founder-setup-plan-v1.json`)).toBe(false);
  });

  it("rejects a legacy founder manifest shape instead of treating it as compatible", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
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
        read_stdin: async () => {
          throw new Error("resume must not read Slack stdin without a plan");
        },
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
        "--slack-approval-channel-id",
        "C123",
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        read_stdin: async () => "token",
      },
      deps,
    );
    order.splice(0);
    let stdout = "";
    const status = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      {
        stdout: (value) => (stdout += value),
        stderr: () => undefined,
        read_stdin: async () => "",
      },
      {
        ...deps,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          granola_credentials_valid: true,
          granola_admission_present: false,
        }),
      },
    );

    expect(status).toBe(0);
    expect(order).toEqual([
      `admit:${join(state, "credentials", "granola-credential")}`,
    ]);
    expect(stdout).not.toContain("con_clean-founder");
    expect(stdout).toContain("live-only cutoff");
  });

  it("refuses finalize before every founder prerequisite without publishing anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);

    let stderr = "";
    const result = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "" },
      {
        ...base,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: false,
          founder_slack_link_active: false,
          granola_credentials_valid: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    expect(stderr).toContain("initial-owner OIDC binding");
    expect(stderr).toContain("initial-owner Slack link");
    expect(stderr).toContain("provider credentials");
    expect(order).toEqual([]);
  });

  it("proves genesis before a full-status seam can publish anything", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);
    writeFileSync(join(state, "state-lineage-root.v1.json"), "{}", { mode: 0o600 });

    let stderr = "";
    const result = await runOrganizationAuthoritySetupCli(
      ["finalize", "--state-dir", state],
      { stdout: () => undefined, stderr: (value) => (stderr += value), read_stdin: async () => "" },
      {
        ...base,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: true,
          granola_credentials_valid: true,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(1);
    expect(stderr).toContain("valid clean state-lineage root manifest");
    expect(order).toEqual([]);
  });

  it("resumes finalize after source admission fails without creating a Slack approval binding", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const base = dependencies(order);
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "token" },
      base,
    );
    order.splice(0);
    const full = {
      founder_oidc_bound: true,
      founder_slack_link_active: true,
      granola_credentials_valid: true,
      granola_admission_present: false,
    };
    let failAdmission = true;
    const retrying: OrganizationAuthoritySetupCliDependencies = {
      ...base,
      admit_source: async (input) => {
        order.push(`admit:${input.granola_credential_file}`);
        if (failAdmission) {
          failAdmission = false;
          throw new Error("injected source admission failure");
        }
        full.granola_admission_present = true;
      },
      read_initial_owner_setup_status: () => ({ ...full }),
    };
    const io = { stdout: () => undefined, stderr: () => undefined, read_stdin: async () => "" };

    expect(await runOrganizationAuthoritySetupCli(["finalize", "--state-dir", state], io, retrying)).toBe(1);
    expect(await runOrganizationAuthoritySetupCli(["finalize", "--state-dir", state], io, retrying)).toBe(0);
    expect(order.filter((entry) => entry.startsWith("activate:"))).toHaveLength(0);
    expect(order.filter((entry) => entry.startsWith("admit:"))).toHaveLength(2);
  });

  it("reports the actual post-bootstrap action instead of sending a bound founder to login", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const completedStage = {
      credentials_ready: true,
      slack_connected: true,
      invitation_file_present: false,
    };
    let stdout = "";
    const result = await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      { stdout: (value) => (stdout += value), stderr: () => undefined, read_stdin: async () => "token" },
      {
        ...dependencies(order),
        read_setup_stage: () => completedStage,
        read_initial_owner_setup_status: () => ({
          founder_oidc_bound: true,
          founder_slack_link_active: false,
          granola_credentials_valid: false,
          granola_admission_present: false,
        }),
      },
    );

    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      next_step: "complete_founder_slack_link",
      next_instruction:
        "Complete the initial-owner Slack identity link in the Authority.",
    });
    expect(stdout).not.toContain("invitation_path");
    expect(order).toEqual([
      "initialize:2026-08-22T12:00:00.000Z:clean-founder-v1",
    ]);
  });

  it("installs all provider credentials from private files without printing their values", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    await runOrganizationAuthoritySetupCli(
      bootstrapArgs(state),
      {
        stdout: () => undefined,
        stderr: () => undefined,
        read_stdin: async () => "xoxb-test-token",
      },
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
        "--granola-credential-file",
        sources.granola,
        "--granola-owner-email-file",
        sources.owner,
        "--llm-credential-file",
        sources.llm,
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
        read_stdin: async () => "",
      },
    );

    expect(result).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      credentials_ready: true,
    });
    for (const value of Object.values(values)) expect(stdout).not.toContain(value);
    expect(readFileSync(join(credentialDirectory, "granola-credential"), "utf8"))
      .toBe(values.granola);
    expect(readFileSync(join(credentialDirectory, "granola-owner-email"), "utf8"))
      .toBe(values.owner);
    expect(readFileSync(join(credentialDirectory, "llm-credential"), "utf8"))
      .toBe(values.llm);
    for (const filename of [
      "granola-credential",
      "granola-owner-email",
      "llm-credential",
    ]) {
      expect(statSync(join(credentialDirectory, filename)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("resumes a lost bootstrap response from the durable plan without rereading connected Slack stdin", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    const stage = {
      credentials_ready: false,
      slack_connected: false,
      invitation_file_present: false,
    };
    let resetFails = true;
    let failAfter: "credentials" | "slack" | "invitation" | undefined =
      undefined;
    let stdinReads = 0;
    const base = dependencies(order);
    const deps: OrganizationAuthoritySetupCliDependencies = {
      ...base,
      initialize_state: (input) => {
        if (resetFails) throw new Error("injected before genesis");
        return initializeAuthorityState(input);
      },
      initialize_credentials: async () => {
        order.push("credentials");
        stage.credentials_ready = true;
        if (failAfter === "credentials") throw new Error("injected after credentials");
      },
      connect_slack: async (input) => {
        stdinReads += 1;
        await input.read_stdin();
        order.push("slack");
        stage.slack_connected = true;
        if (failAfter === "slack") throw new Error("injected after slack");
        return { connection_id: input.connection_id ?? "con_unexpected" };
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
      stderr: () => undefined,
      read_stdin: async () => "xoxb-test-token",
    };

    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, deps)).toBe(1);
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
    expect(status).not.toContain("xoxb-test-token");
    expect(JSON.parse(status)).toMatchObject({
      setup_plan_present: true,
      genesis_published: false,
      next_step: "resume_bootstrap",
    });

    resetFails = false;
    failAfter = "credentials";
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    failAfter = "slack";
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    expect(order.filter((value) => value === "credentials")).toHaveLength(1);
    failAfter = "invitation";
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps),
    ).toBe(1);
    expect(order.filter((value) => value === "slack")).toHaveLength(1);
    expect(stdinReads).toBe(1);
    failAfter = undefined;
    expect(
      await runOrganizationAuthoritySetupCli(["resume", "--state-dir", state], io, deps),
    ).toBe(0);
    expect(order.filter((value) => value === "invitation")).toHaveLength(1);
    expect(stdinReads).toBe(1);
  });

  it("reports only safe incomplete and complete one-note canary evidence", async () => {
    const state = stateDirectory();
    const order: string[] = [];
    let canaryComplete = false;
    const deps = readyStatusDependencies(order, () => canaryComplete);
    const io = {
      stdout: () => undefined,
      stderr: () => undefined,
      read_stdin: async () => "token",
    };
    expect(await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, deps)).toBe(0);

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
    ["requires a real source cursor advance", { cursor_version: 0 }, false, true, true, true, true],
    ["rejects a stale record-head pointer", { pointer_current: false }, true, true, false, false, false],
    ["rejects a stale retrieval contract", { pointer_current_contract: false }, true, true, false, false, false],
    ["requires a positive Layer 1 audit", { layer1_result_count: null }, true, true, true, false, true],
    ["rejects a zero-result Layer 1 audit", { layer1_result_count: 0 }, true, true, true, false, true],
    ["requires a positive Layer 2 audit", { layer2_result_count: null }, true, true, true, true, false],
    ["rejects a zero-result Layer 2 audit", { layer2_result_count: 0 }, true, true, true, true, false],
    ["requires the owner tuple for Layer 1", { layer1_owner_tuple: "other" }, true, true, true, false, true],
    ["requires the owner tuple for Layer 2", { layer2_owner_tuple: "other" }, true, true, true, true, false],
  ] as const)(
    "derives durable canary evidence from SQLite: %s",
    async (
      _name,
      fixtureOptions,
      sourceProgress,
      approvedRecord,
      activeGeneration,
      layer1Read,
      layer2Read,
    ) => {
      const state = stateDirectory();
      const prereq = readyStatusDependencies([]);
      const productionDependencies: OrganizationAuthoritySetupCliDependencies = {
        ...prereq,
        read_setup_canary_evidence: undefined,
      };
      const io = {
        stdout: () => undefined,
        stderr: () => undefined,
        read_stdin: async () => "token",
      };
      expect(
        await runOrganizationAuthoritySetupCli(bootstrapArgs(state), io, productionDependencies),
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
});
