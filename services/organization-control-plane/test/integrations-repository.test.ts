import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalSha256,
  sha256Digest,
} from "../src/canonical/canonical-json.js";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  FileOrganizationSecretStore,
  OrganizationIntegrationsRepository,
  openOrganizationControlDatabase,
  type OnboardSlackOrganizationToolInput,
} from "../src/index.js";

const directories: string[] = [];
const NOW = "2026-07-29T20:00:00.000Z";
const ORGANIZATION_ID = "org_test-organization";
const AUTHORITY_ID = "oau_test-authority";
const PRINCIPAL_ID = "prn_test-principal";
const MEMBERSHIP_ID = "mem_test-membership";
const INSTALLATION_ID = "ins_test-installation";

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function database() {
  const database = openOrganizationControlDatabase(":memory:");
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_test-control-plane', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, digest("authority"), NOW);
  return database;
}

function organizationToolInput(
  command: string,
  secretHandle: string,
): OnboardSlackOrganizationToolInput {
  return {
    command_id: `cmd_${command}`,
    command_sha256: digest(command),
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
    administrator_principal_id: PRINCIPAL_ID,
    administrator_membership_id: MEMBERSHIP_ID,
    connection: {
      team_id: "T123TEAM",
      enterprise_id: null,
      bot_user_id: "U123BOT",
      bot_id: "B123BOT",
      app_id: "A123APP",
      granted_scopes: [
        "users:read",
        "chat:write",
        "channels:read",
        "channels:history",
        "reactions:read",
      ],
      verification_evidence_sha256: digest("connection-evidence"),
    },
    channel: {
      team_id: "T123TEAM",
      channel_id: "C123CHANNEL",
      verification_evidence_sha256: digest("channel-evidence"),
    },
    secret: {
      secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
      secret_handle_id: secretHandle,
    },
    now: NOW,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization integrations repository", () => {
  it("activates one verified organization Slack tool without employee state", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const input = organizationToolInput(
      "organization-slack-one",
      "sch_22222222-2222-4222-8222-222222222222",
    );
    const result = repository.onboardSlackOrganizationTool(input);

    expect(result).toMatchObject({
      organization_id: ORGANIZATION_ID,
      provider: "slack",
      status: "active",
      slack_team_id: "T123TEAM",
      slack_bot_user_id: "U123BOT",
      channel_id: "C123CHANNEL",
      granted_scopes: [
        "channels:history",
        "channels:read",
        "chat:write",
        "reactions:read",
        "users:read",
      ],
      activated_at: NOW,
    });
    const overview = repository.overview();
    expect(overview.identity_links).toEqual([]);
    expect(overview.adapter_bindings).toEqual([]);
    expect(overview.permission_grants).toEqual([]);
    expect(overview.tool_connections).toHaveLength(1);
    expect(overview.tool_connections[0]).toMatchObject({
      connection_id: result.connection_id,
      owner_kind: "organization",
      provider: "slack",
      provider_tenant_id: "T123TEAM",
      provider_subject_id: "U123BOT",
      granted_scopes_json:
        '["channels:history","channels:read","chat:write","reactions:read","users:read"]',
      status: "active",
      public_configuration_json:
        '{"approve_reaction":"white_check_mark","channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}',
    });
    expect(overview.recent_audit).toEqual([
      expect.objectContaining({
        action: "organization_tool.slack.onboarded",
        subject_kind: "tool_connection",
        subject_id: result.connection_id,
        membership_id: null,
        outcome: "succeeded",
      }),
    ]);
    expect(
      repository.slackOrganizationToolReplay(
        "cmd_organization-slack-one",
        digest("organization-slack-one"),
      ),
    ).toEqual(result);
    expect(() =>
      repository.slackOrganizationToolReplay(
        "cmd_organization-slack-one",
        digest("different-command"),
      ),
    ).toThrow(/reused with different input/);
    expect(() =>
      repository.onboardSlackOrganizationTool({
        ...input,
        command_id: "cmd_organization-slack-two",
        command_sha256: digest("organization-slack-two"),
        connection: {
          ...input.connection,
          bot_user_id: "U456BOT",
          bot_id: "B456BOT",
          verification_evidence_sha256: digest("second-connection-evidence"),
        },
        secret: {
          secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
          secret_handle_id: "sch_33333333-3333-4333-8333-333333333333",
        },
      }),
    ).toThrow("Slack organization tool is already active");
    expect(repository.overview().tool_connections).toHaveLength(1);
    expect(repository.overview().recent_audit).toHaveLength(1);
    integrationDatabase.exec(
      "DROP TRIGGER organization_tool_connections_revoke_only",
    );
    integrationDatabase
      .prepare(
        `UPDATE organization_tool_connections
         SET public_configuration_sha256 = ?
         WHERE connection_id = ?`,
      )
      .run(digest("wrong-configuration"), result.connection_id);
    expect(() => repository.overview()).toThrow(
      "stored organization tool configuration is invalid",
    );
    repository.close();
  });

  it("links a Slack human to the enrolled installation without granting permission", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    repository.onboardSlackOrganizationTool(
      organizationToolInput(
        "organization-slack-before-employee-link",
        "sch_44444444-4444-4444-8444-444444444444",
      ),
    );
    const organizationTool = repository.activeSlackOrganizationTool()!;
    const installation = {
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      enrollment_id: "enr_test-enrollment",
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: digest("installation-key"),
    } as const;
    const begun = repository.beginSlackIdentityLinkChallenge({
      request_sha256: digest("employee-link-begin-one"),
      challenge_code_sha256: digest("challenge-one"),
      installation,
      organization_tool: organizationTool,
      now: NOW,
    });
    expect(
      repository.slackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: digest("challenge-one"),
        installation,
        organization_tool: organizationTool,
        now: NOW,
      }),
    ).toMatchObject({
      membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
    });
    const completion = {
      command_id: "slc_employee-link-one",
      command_sha256: digest("employee-link-complete-one"),
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_code_sha256: digest("challenge-one"),
      challenge_message_ts: "1753822800.000001",
      installation,
      organization_tool: organizationTool,
      observed: {
        team_id: "T123TEAM",
        user_id: "U_ZHEN",
        channel_id: "C123CHANNEL",
        challenge_message_ts: "1753822800.000001",
        reply_message_ts: "1753822801.000001",
        verification_evidence_sha256: digest("employee-link-observation"),
      },
      adapter_id: "slack-reactions",
      adapter_instance_id: "founder-approvals",
      adapter_version: "1.0.0",
      authority_checked_at: NOW,
      now: NOW,
    } as const;
    const completed =
      repository.completeSlackIdentityLinkChallenge(completion);

    expect(completed).toMatchObject({
      membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      provider_subject_id: "U_ZHEN",
      identity_link_created: true,
      adapter_binding_created: true,
      permission_grants_created: 0,
    });
    expect(repository.overview()).toMatchObject({
      identity_links: [expect.objectContaining({ membership_id: MEMBERSHIP_ID })],
      adapter_bindings: [
        expect.objectContaining({ installation_id: INSTALLATION_ID }),
      ],
      permission_grants: [],
    });
    expect(
      repository.slackIdentityLinkCompletionReplay(
        "slc_employee-link-one",
        digest("employee-link-complete-one"),
      ),
    ).toEqual(completed);
    expect(
      repository.completeSlackIdentityLinkChallenge({
        ...completion,
        command_id: "slc_employee-link-response-loss-retry",
        command_sha256: digest("employee-link-response-loss-retry"),
      }),
    ).toEqual(completed);

    const secondBegun = repository.beginSlackIdentityLinkChallenge({
      request_sha256: digest("employee-link-begin-two"),
      challenge_code_sha256: digest("challenge-two"),
      installation,
      organization_tool: organizationTool,
      now: "2026-07-29T20:01:00.000Z",
    });
    const reverified = repository.completeSlackIdentityLinkChallenge({
      command_id: "slc_employee-link-two",
      command_sha256: digest("employee-link-complete-two"),
      challenge_attempt_id: secondBegun.challenge_attempt_id,
      challenge_code_sha256: digest("challenge-two"),
      challenge_message_ts: "1753822860.000001",
      installation,
      organization_tool: organizationTool,
      observed: {
        team_id: "T123TEAM",
        user_id: "U_ZHEN",
        channel_id: "C123CHANNEL",
        challenge_message_ts: "1753822860.000001",
        reply_message_ts: "1753822861.000001",
        verification_evidence_sha256: digest("employee-link-reverification"),
      },
      adapter_id: "slack-reactions",
      adapter_instance_id: "founder-approvals",
      adapter_version: "1.0.0",
      authority_checked_at: "2026-07-29T20:01:00.000Z",
      now: "2026-07-29T20:01:00.000Z",
    });
    expect(reverified).toMatchObject({
      identity_link_id: completed.identity_link_id,
      adapter_binding_id: completed.adapter_binding_id,
      identity_link_created: false,
      adapter_binding_created: false,
      permission_grants_created: 0,
    });
    expect(repository.overview().identity_links).toHaveLength(1);
    expect(repository.overview().adapter_bindings).toHaveLength(1);
    expect(repository.overview().permission_grants).toEqual([]);

    const expiring = repository.beginSlackIdentityLinkChallenge({
      request_sha256: digest("employee-link-begin-expiring"),
      challenge_code_sha256: digest("challenge-expiring"),
      installation,
      organization_tool: organizationTool,
      now: "2026-07-29T20:02:00.000Z",
    });
    expect(() =>
      repository.slackIdentityLinkChallenge({
        challenge_attempt_id: expiring.challenge_attempt_id,
        challenge_code_sha256: digest("challenge-expiring"),
        installation,
        organization_tool: organizationTool,
        now: "2026-07-29T20:17:00.000Z",
      }),
    ).toThrow("Slack identity link challenge expired");
    expect(
      integrationDatabase
        .prepare(
          `SELECT status, outcome_reason
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?`,
        )
        .get(expiring.challenge_attempt_id),
    ).toEqual({
      status: "expired",
      outcome_reason: "challenge_expired",
    });
    repository.close();
  });

  it("creates one verified Slack link, binding, and direct grants atomically", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const organizationTool = repository.onboardSlackOrganizationTool(
      organizationToolInput(
        "organization-slack-before-bootstrap",
        "sch_11111111-1111-4111-8111-111111111111",
      ),
    );
    const result = repository.bootstrapSlackApproval({
      command_id: "cmd_bootstrap-one",
      command_sha256: digest("bootstrap-one"),
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      administrator_principal_id: PRINCIPAL_ID,
      administrator_membership_id: MEMBERSHIP_ID,
      target_principal_id: PRINCIPAL_ID,
      target_membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: digest("installation-key"),
      adapter_id: "slack-reactions",
      adapter_instance_id: "primary",
      adapter_version: "1.0.0",
      channel_id: "C123CHANNEL",
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      organization_connection_id: organizationTool.connection_id,
      connection: {
        team_id: "T123TEAM",
        enterprise_id: null,
        bot_user_id: "U123BOT",
        bot_id: "B123BOT",
        app_id: "A123APP",
        granted_scopes: [
          "channels:history",
          "channels:read",
          "chat:write",
          "reactions:read",
          "users:read",
        ],
        verification_evidence_sha256: digest("connection-evidence"),
      },
      channel: {
        team_id: "T123TEAM",
        channel_id: "C123CHANNEL",
        verification_evidence_sha256: digest("channel-evidence"),
      },
      human: {
        team_id: "T123TEAM",
        user_id: "U_ZHEN",
        verification_evidence_sha256: digest("human-evidence"),
      },
      now: NOW,
    });

    expect(result.membership_id).toBe(MEMBERSHIP_ID);
    expect(result.slack_user_id).toBe("U_ZHEN");
    const permissionLookup = {
      organization_id: ORGANIZATION_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: digest("installation-key"),
      adapter_id: "slack-reactions",
      adapter_instance_id: "primary",
      adapter_version: "1.0.0",
      channel_id: "C123CHANNEL",
      reaction_name: "white_check_mark",
      slack_team_id: "T123TEAM",
      slack_user_id: "U_ZHEN",
      slack_enterprise_id: null,
      slack_bot_user_id: "U123BOT",
      slack_bot_id: "B123BOT",
      slack_app_id: "A123APP",
      action: "approve",
    } as const;
    expect(
      repository.findSlackApprovalPermission(permissionLookup),
    ).toMatchObject({
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
      secret_handle_id: "sch_11111111-1111-4111-8111-111111111111",
      slack_bot_user_id: "U123BOT",
      slack_bot_id: "B123BOT",
    });
    expect(
      repository.findSlackApprovalPermission({
        ...permissionLookup,
        reaction_name: "x",
      }),
    ).toBeNull();
    expect(
      repository.bootstrapReplay("cmd_bootstrap-one", digest("bootstrap-one")),
    ).toEqual(result);
    expect(() =>
      repository.bootstrapReplay(
        "cmd_bootstrap-one",
        digest("different-command"),
      ),
    ).toThrow(/reused with different input/);

    const overview = repository.overview();
    expect(overview.identity_links).toHaveLength(1);
    expect(overview.tool_connections).toHaveLength(1);
    expect(result.connection_id).toBe(organizationTool.connection_id);
    expect(overview.tool_connections[0]).toMatchObject({
      public_configuration_json: expect.stringContaining(
        '"organization_tool_profile":"slack-organization-tool-v1"',
      ),
    });
    expect(overview.adapter_bindings).toHaveLength(1);
    expect(overview.permission_grants).toHaveLength(2);
    expect(overview.recent_audit).toHaveLength(2);
    const evidence = integrationDatabase
      .prepare(
        `SELECT
           connection.verification_evidence_sha256 AS connection_evidence,
           attempt.verification_evidence_sha256 AS attempt_evidence
         FROM organization_tool_connections AS connection
         JOIN organization_connection_attempts AS attempt
           ON attempt.connection_attempt_id =
              connection.verification_attempt_id
         WHERE connection.connection_id = ?`,
      )
      .get(result.connection_id) as {
      connection_evidence: string;
      attempt_evidence: string;
    };
    expect(evidence.connection_evidence).toBe(evidence.attempt_evidence);
    expect(evidence.connection_evidence).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.connection_evidence).not.toBe(
      digest("connection-evidence"),
    );
    repository.close();
  });

  it("commits every live permission evaluation without caching by provider event", () => {
    const repository = new OrganizationIntegrationsRepository(database(), {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
    });
    const decision = repository.recordPermissionDecision({
      request_id: "pcr_request-one",
      request_sha256: digest("request-one"),
      provider_event_sha256: digest("event-one"),
      action: "approve",
      allowed: false,
      reason_code: "no_active_link_binding_or_grant",
      principal_id: null,
      membership_id: null,
      adapter_binding_id: null,
      permission_grant_id: null,
      evaluated_at: NOW,
      authority_evidence_sha256: digest("authority-status"),
      authority_checked_at: NOW,
      organization_id: ORGANIZATION_ID,
      caller_principal_id: PRINCIPAL_ID,
      caller_membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      identity_link_id: null,
      connection_id: null,
      approval_id: "approval-one",
      detail: { provider: "slack" },
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason_code: "no_active_link_binding_or_grant",
    });
    const reevaluated = repository.recordPermissionDecision({
      request_id: "pcr_request-one",
      request_sha256: digest("request-one"),
      provider_event_sha256: digest("event-one"),
      action: "approve",
      allowed: false,
      reason_code: "provider_unavailable",
      principal_id: null,
      membership_id: null,
      adapter_binding_id: null,
      permission_grant_id: null,
      evaluated_at: "2026-07-29T20:00:01.000Z",
      authority_evidence_sha256: digest("new-authority-status"),
      authority_checked_at: "2026-07-29T20:00:01.000Z",
      organization_id: ORGANIZATION_ID,
      caller_principal_id: PRINCIPAL_ID,
      caller_membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      identity_link_id: null,
      connection_id: null,
      approval_id: "approval-one",
      detail: { provider: "slack" },
    });
    expect(reevaluated).toMatchObject({
      reason_code: "provider_unavailable",
      evaluated_at: "2026-07-29T20:00:01.000Z",
    });
    expect(repository.overview().recent_audit).toHaveLength(2);
    repository.close();
  });

  it("writes an audit chain whose entries recompute from their stored columns", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      { organization_id: ORGANIZATION_ID, authority_id: AUTHORITY_ID },
    );
    repository.onboardSlackOrganizationTool(
      organizationToolInput(
        "organization-slack-audit-chain",
        "sch_55555555-5555-4555-8555-555555555555",
      ),
    );
    const organizationTool = repository.activeSlackOrganizationTool()!;
    const installation = {
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      enrollment_id: "enr_test-enrollment",
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: digest("installation-key"),
    } as const;
    const begun = repository.beginSlackIdentityLinkChallenge({
      request_sha256: digest("audit-chain-begin"),
      challenge_code_sha256: digest("audit-chain-challenge"),
      installation,
      organization_tool: organizationTool,
      now: NOW,
    });
    repository.completeSlackIdentityLinkChallenge({
      command_id: "slc_audit-chain-link",
      command_sha256: digest("audit-chain-link"),
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_code_sha256: digest("audit-chain-challenge"),
      challenge_message_ts: "1753822800.000001",
      installation,
      organization_tool: organizationTool,
      observed: {
        team_id: "T123TEAM",
        user_id: "U_ZHEN",
        channel_id: "C123CHANNEL",
        challenge_message_ts: "1753822800.000001",
        reply_message_ts: "1753822801.000001",
        verification_evidence_sha256: digest("audit-chain-observation"),
      },
      adapter_id: "slack-reactions",
      adapter_instance_id: "founder-approvals",
      adapter_version: "1.0.0",
      authority_checked_at: NOW,
      now: NOW,
    });

    const rows = integrationDatabase
      .prepare(
        `SELECT * FROM organization_integration_audit ORDER BY audit_sequence`,
      )
      .all() as Array<
      Record<string, unknown> & {
        entry_sha256: string;
        previous_entry_sha256: string | null;
        detail_json: string;
        detail_sha256: string;
      }
    >;
    expect(rows.map((row) => row["action"])).toEqual([
      "organization_tool.slack.onboarded",
      "slack_identity_link.completed",
    ]);
    let previous: string | null = null;
    for (const row of rows) {
      // entry_sha256 covers every stored column except itself and
      // organization_id, plus the parsed detail object appendAudit hashed.
      const entry: Record<string, unknown> = {
        ...row,
        detail: JSON.parse(row.detail_json) as Record<string, unknown>,
      };
      delete entry["entry_sha256"];
      delete entry["organization_id"];
      expect(row.previous_entry_sha256).toBe(previous);
      expect(canonicalSha256(entry)).toBe(row.entry_sha256);
      expect(sha256Digest(row.detail_json)).toBe(row.detail_sha256);
      previous = row.entry_sha256;
    }
    repository.close();
  });
});

describe("organization integration file secret store", () => {
  it("keeps token bytes outside SQLite in a private opaque-handle file", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "echo-org-secrets-")),
    );
    directories.push(directory);
    const store = new FileOrganizationSecretStore(
      join(directory, "integrations"),
    );
    const reference = store.create("xoxb-test-token-12345678");
    expect(lstatSync(join(directory, "integrations")).mode & 0o777).toBe(0o700);
    expect(reference).toMatchObject({
      secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
    });
    expect(store.read(reference)).toBe("xoxb-test-token-12345678");
    expect(store.listReferences()).toEqual([reference]);
    expect(
      lstatSync(
        join(directory, "integrations", `${reference.secret_handle_id}.secret`),
      ).mode & 0o777,
    ).toBe(0o600);
    const reopened = new FileOrganizationSecretStore(
      join(directory, "integrations"),
    );
    expect(reopened.read(reference)).toBe("xoxb-test-token-12345678");
    reopened.remove(reference);
    reopened.remove(reference);
    expect(reopened.listReferences()).toEqual([]);
    expect(
      existsSync(
        join(directory, "integrations", `${reference.secret_handle_id}.secret`),
      ),
    ).toBe(false);
    expect(() => reopened.read(reference)).toThrow();
  });
});
