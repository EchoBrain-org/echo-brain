import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalSha256,
  sha256Digest,
} from "../src/canonical/canonical-json.js";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  FileOrganizationSecretStore,
  OrganizationIntegrationConflictError,
  OrganizationIntegrationsRepository,
  openAndMigrateOrganizationControlDatabase,
  type ActivateExistingSlackApprovalInput,
  type CompletePersonSlackIdentityLinkChallengeInput,
  type CompletedPersonSlackIdentityLink,
  type CompletedSlackIdentityLink,
  type OnboardSlackOrganizationToolInput,
  type PersonSlackIdentityLinkSession,
} from "../src/index.js";
import { migrateOrganizationControlDatabaseWithMigrations } from "../src/persistence/migrate.js";

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
  const database = openAndMigrateOrganizationControlDatabase(":memory:");
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

const V4_MIGRATION_FILENAMES = [
  "0001_organization_control_plane.sql",
  "0002_organization_tool_public_configuration.sql",
  "0003_single_canonical_slack_promotion.sql",
  "0004_slack_enterprise_grid_user_ids.sql",
] as const;

function migration(filename: string, version: number) {
  const sql = readFileSync(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8",
  );
  return { version, filename, sql, sha256: digest(sql) };
}

function databaseThroughV4() {
  const integrationDatabase = new Database(":memory:");
  migrateOrganizationControlDatabaseWithMigrations(
    integrationDatabase,
    V4_MIGRATION_FILENAMES.map((filename, index) =>
      migration(filename, index + 1),
    ),
  );
  integrationDatabase
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, 'ocp_test-control-plane', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, digest("authority"), NOW);
  return integrationDatabase;
}

function migrateDatabaseToV5(integrationDatabase: Database.Database): void {
  migrateOrganizationControlDatabaseWithMigrations(integrationDatabase, [
    ...V4_MIGRATION_FILENAMES.map((filename, index) =>
      migration(filename, index + 1),
    ),
    migration("0005_slack_app_identity_promotion.sql", 5),
  ]);
}

function insertHistoricalSlackBinding(
  integrationDatabase: Database.Database,
  input: {
    binding_id: string;
    installation_id: string;
    adapter_instance_id: string;
    connection_id: string;
    configuration: Readonly<Record<string, unknown>>;
  },
): void {
  const configurationJson = JSON.stringify(input.configuration);
  integrationDatabase.prepare(
    `INSERT INTO organization_adapter_bindings (
       adapter_binding_id, organization_id, product_namespace,
       installation_id, installation_key_id, adapter_kind, adapter_id,
       adapter_instance_id, adapter_version, connection_id,
       public_configuration_json, public_configuration_sha256, status,
       created_by_principal_id, created_by_membership_id, bound_at,
       revoked_at, revocation_reason
     ) VALUES (?, ?, 'echo-brain', ?, ?, 'approval-surface',
       'slack-reactions', ?, '1.0.0', ?, ?, ?, 'active', ?, ?, ?, NULL, NULL)`,
  ).run(
    input.binding_id,
    ORGANIZATION_ID,
    input.installation_id,
    digest(`${input.installation_id}-key`),
    input.adapter_instance_id,
    input.connection_id,
    configurationJson,
    sha256Digest(configurationJson),
    PRINCIPAL_ID,
    MEMBERSHIP_ID,
    NOW,
  );
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

const INSTALLATION = {
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  enrollment_id: "enr_test-enrollment",
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  installation_id: INSTALLATION_ID,
  installation_key_id: digest("installation-key"),
} as const;

const PERSON_SESSION = {
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  identity_binding_id: "oib_11111111-1111-4111-8111-111111111111",
  session_family_id: "psf_22222222-2222-4222-8222-222222222222",
} as const satisfies PersonSlackIdentityLinkSession;

function personSlackIdentityLinkCompletion(
  challengeAttemptId: string,
  organizationTool: NonNullable<
    ReturnType<OrganizationIntegrationsRepository["activeSlackOrganizationTool"]>
  >,
  input: {
    command?: string;
    challenge?: string;
    message_ts?: string;
    user_id?: string;
    person_session?: PersonSlackIdentityLinkSession;
    now?: string;
  } = {},
): CompletePersonSlackIdentityLinkChallengeInput {
  const command = input.command ?? "person-link-complete-one";
  const challenge = input.challenge ?? "person-challenge-one";
  const messageTs = input.message_ts ?? "1753822800.000001";
  const now = input.now ?? NOW;
  return {
    command_id: `psc_${command}`,
    command_sha256: digest(command),
    challenge_attempt_id: challengeAttemptId,
    challenge_code_sha256: digest(challenge),
    challenge_message_ts: messageTs,
    person_session: input.person_session ?? PERSON_SESSION,
    organization_tool: organizationTool,
    observed: {
      team_id: "T123TEAM",
      user_id: input.user_id ?? "U_PERSON",
      channel_id: "C123CHANNEL",
      challenge_message_ts: messageTs,
      reply_message_ts: "1753822801.000001",
      verification_evidence_sha256: digest(`${command}-observation`),
    },
    authority_checked_at: now,
    now,
  };
}

function completeSlackIdentityLink(
  repository: OrganizationIntegrationsRepository,
  label: string,
  secretHandle: string,
): CompletedSlackIdentityLink {
  repository.onboardSlackOrganizationTool(
    organizationToolInput(`organization-slack-${label}`, secretHandle),
  );
  const organizationTool = repository.activeSlackOrganizationTool()!;
  const begun = repository.beginSlackIdentityLinkChallenge({
    request_sha256: digest(`${label}-begin`),
    challenge_code_sha256: digest(`${label}-challenge`),
    installation: INSTALLATION,
    organization_tool: organizationTool,
    now: NOW,
  });
  return repository.completeSlackIdentityLinkChallenge({
    command_id: `slc_${label}`,
    command_sha256: digest(`${label}-link`),
    challenge_attempt_id: begun.challenge_attempt_id,
    challenge_code_sha256: digest(`${label}-challenge`),
    challenge_message_ts: "1753822800.000001",
    installation: INSTALLATION,
    organization_tool: organizationTool,
    observed: {
      team_id: "T123TEAM",
      user_id: "U_ZHEN",
      channel_id: "C123CHANNEL",
      challenge_message_ts: "1753822800.000001",
      reply_message_ts: "1753822801.000001",
      verification_evidence_sha256: digest(`${label}-observation`),
    },
    adapter_id: "slack-reactions",
    adapter_instance_id: "founder-approvals",
    adapter_version: "1.0.0",
    authority_checked_at: NOW,
    now: NOW,
  });
}

function approvalActivationInput(
  linked: CompletedSlackIdentityLink,
  command = "approval-activation-one",
): ActivateExistingSlackApprovalInput {
  return {
    command_id: `cmd_${command}`,
    command_sha256: digest(command),
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
    administrator_principal_id: PRINCIPAL_ID,
    administrator_membership_id: MEMBERSHIP_ID,
    target_principal_id: PRINCIPAL_ID,
    target_membership_id: MEMBERSHIP_ID,
    installation_id: INSTALLATION_ID,
    installation_key_id: digest("installation-key"),
    identity_link_id: linked.identity_link_id,
    adapter_binding_id: linked.adapter_binding_id,
    now: NOW,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("organization integrations repository", () => {
  it("promotes a ready null-app Slack tool and every exact binding atomically", () => {
    const integrationDatabase = databaseThroughV4();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      { organization_id: ORGANIZATION_ID, authority_id: AUTHORITY_ID },
    );
    const secretHandle = "sch_12121212-1212-4121-8121-121212121212";
    const initial = organizationToolInput("null-app-ready", secretHandle);
    repository.onboardSlackOrganizationTool({
      ...initial,
      connection: {
        ...initial.connection,
        app_id: null as unknown as string,
      },
    });
    const nullAppTool = repository.activeSlackOrganizationTool()!;
    const nullBinding = {
      approve_reaction: nullAppTool.approve_reaction,
      channel_id: nullAppTool.channel_id,
      reject_reaction: nullAppTool.reject_reaction,
      slack_app_id: null,
      slack_bot_id: nullAppTool.bot_id,
      slack_bot_user_id: nullAppTool.bot_user_id,
      slack_enterprise_id: nullAppTool.enterprise_id,
    };
    for (const suffix of ["one", "two", "three"] as const) {
      insertHistoricalSlackBinding(integrationDatabase, {
        binding_id: `bnd_app-promotion-${suffix}`,
        installation_id: `ins_app-promotion-${suffix}`,
        adapter_instance_id: `app-promotion-${suffix}`,
        connection_id: nullAppTool.connection_id,
        configuration: nullBinding,
      });
    }
    integrationDatabase.prepare(
      `INSERT INTO organization_permission_grants (
         permission_grant_id, organization_id, adapter_binding_id,
         principal_id, membership_id, action, resource_scope_json, status,
         granted_by_principal_id, granted_by_membership_id, granted_at,
         revoked_at, revocation_reason
       ) VALUES ('pgr_app-promotion', ?, 'bnd_app-promotion-one', ?, ?,
         'approve', '{}', 'active', ?, ?, ?, NULL, NULL)`,
    ).run(
      ORGANIZATION_ID,
      PRINCIPAL_ID,
      MEMBERSHIP_ID,
      PRINCIPAL_ID,
      MEMBERSHIP_ID,
      NOW,
    );
    migrateDatabaseToV5(integrationDatabase);
    const before = {
      connection: nullAppTool.connection_id,
      activated_at: integrationDatabase.prepare(
        `SELECT activated_at FROM organization_tool_connections
         WHERE connection_id = ?`,
      ).get(nullAppTool.connection_id),
      bindings: integrationDatabase.prepare(
        `SELECT adapter_binding_id FROM organization_adapter_bindings
         ORDER BY adapter_binding_id`,
      ).all() as Array<{ adapter_binding_id: string }>,
      grants: integrationDatabase.prepare(
        `SELECT permission_grant_id, adapter_binding_id
         FROM organization_permission_grants ORDER BY permission_grant_id`,
      ).all(),
    };
    const promotion = organizationToolInput("promote-ready-app", secretHandle);
    const promoted = repository.onboardSlackOrganizationTool(promotion);

    expect(promoted).toMatchObject({
      connection_id: before.connection,
      activated_at: NOW,
    });
    expect(repository.activeSlackOrganizationTool()).toMatchObject({
      connection_id: before.connection,
      app_id: "A123APP",
    });
    expect(repository.upgradeableSlackOrganizationTool()).toBeNull();
    expect(
      integrationDatabase.prepare(
        `SELECT adapter_binding_id,
                json_extract(public_configuration_json, '$.slack_app_id') AS app_id
         FROM organization_adapter_bindings ORDER BY adapter_binding_id`,
      ).all(),
    ).toEqual(
      before.bindings.map((row) => ({ ...row, app_id: "A123APP" })),
    );
    expect(
      integrationDatabase.prepare(
        `SELECT permission_grant_id, adapter_binding_id
         FROM organization_permission_grants ORDER BY permission_grant_id`,
      ).all(),
    ).toEqual(before.grants);
    const audit = integrationDatabase.prepare(
      `SELECT reason_code, detail_json FROM organization_integration_audit
       WHERE command_id = ?`,
    ).get(promotion.command_id) as { reason_code: string; detail_json: string };
    const detail = JSON.parse(audit.detail_json) as {
      app_identity_promotion: {
        schema_version: number;
        kind: string;
        app_id: string;
        binding_updates: readonly unknown[];
      };
    };
    expect(audit.reason_code).toBe(
      "null_app_identity_reverified_and_promoted",
    );
    expect(detail.app_identity_promotion).toMatchObject({
      schema_version: 1,
      kind: "slack-null-app-identity-promotion-v1",
      app_id: "A123APP",
    });
    expect(detail.app_identity_promotion.binding_updates).toHaveLength(3);
    const countsBeforeReplay = integrationDatabase.prepare(
      `SELECT
         (SELECT COUNT(*) FROM organization_connection_attempts) AS attempts,
         (SELECT COUNT(*) FROM organization_integration_audit) AS audit`,
    ).get();
    expect(repository.onboardSlackOrganizationTool(promotion)).toEqual(promoted);
    expect(
      integrationDatabase.prepare(
        `SELECT
           (SELECT COUNT(*) FROM organization_connection_attempts) AS attempts,
           (SELECT COUNT(*) FROM organization_integration_audit) AS audit`,
      ).get(),
    ).toEqual(countsBeforeReplay);
    expect(
      integrationDatabase.prepare(
        `SELECT activated_at FROM organization_tool_connections
         WHERE connection_id = ?`,
      ).get(before.connection),
    ).toEqual(before.activated_at);
    repository.close();
  });

  it("rejects one mismatched null-app binding without writing any promotion state", () => {
    const integrationDatabase = databaseThroughV4();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      { organization_id: ORGANIZATION_ID, authority_id: AUTHORITY_ID },
    );
    const secretHandle = "sch_13131313-1313-4131-8131-131313131313";
    const initial = organizationToolInput("null-app-mismatch", secretHandle);
    repository.onboardSlackOrganizationTool({
      ...initial,
      connection: {
        ...initial.connection,
        app_id: null as unknown as string,
      },
    });
    const tool = repository.activeSlackOrganizationTool()!;
    const exact = {
      approve_reaction: tool.approve_reaction,
      channel_id: tool.channel_id,
      reject_reaction: tool.reject_reaction,
      slack_app_id: null,
      slack_bot_id: tool.bot_id,
      slack_bot_user_id: tool.bot_user_id,
      slack_enterprise_id: tool.enterprise_id,
    };
    insertHistoricalSlackBinding(integrationDatabase, {
      binding_id: "bnd_app-mismatch-exact",
      installation_id: "ins_app-mismatch-exact",
      adapter_instance_id: "app-mismatch-exact",
      connection_id: tool.connection_id,
      configuration: exact,
    });
    insertHistoricalSlackBinding(integrationDatabase, {
      binding_id: "bnd_app-mismatch-wrong",
      installation_id: "ins_app-mismatch-wrong",
      adapter_instance_id: "app-mismatch-wrong",
      connection_id: tool.connection_id,
      configuration: { ...exact, channel_id: "C999WRONG" },
    });
    migrateDatabaseToV5(integrationDatabase);
    const stateBefore = {
      attempts: integrationDatabase.prepare(
        `SELECT connection_attempt_id, status
         FROM organization_connection_attempts ORDER BY connection_attempt_id`,
      ).all(),
      audit: integrationDatabase.prepare(
        `SELECT audit_sequence, command_id
         FROM organization_integration_audit ORDER BY audit_sequence`,
      ).all(),
      connection: integrationDatabase.prepare(
        `SELECT connection_id, verification_attempt_id,
                public_configuration_json, public_configuration_sha256
         FROM organization_tool_connections`,
      ).all(),
      bindings: integrationDatabase.prepare(
        `SELECT adapter_binding_id, public_configuration_json,
                public_configuration_sha256
         FROM organization_adapter_bindings ORDER BY adapter_binding_id`,
      ).all(),
      grants: integrationDatabase.prepare(
        `SELECT * FROM organization_permission_grants`,
      ).all(),
    };
    expect(() =>
      repository.onboardSlackOrganizationTool(
        organizationToolInput("mismatched-promotion", secretHandle),
      ),
    ).toThrow(
      "active Slack approval binding is not an exact null-app organization-tool binding",
    );
    expect({
      attempts: integrationDatabase.prepare(
        `SELECT connection_attempt_id, status
         FROM organization_connection_attempts ORDER BY connection_attempt_id`,
      ).all(),
      audit: integrationDatabase.prepare(
        `SELECT audit_sequence, command_id
         FROM organization_integration_audit ORDER BY audit_sequence`,
      ).all(),
      connection: integrationDatabase.prepare(
        `SELECT connection_id, verification_attempt_id,
                public_configuration_json, public_configuration_sha256
         FROM organization_tool_connections`,
      ).all(),
      bindings: integrationDatabase.prepare(
        `SELECT adapter_binding_id, public_configuration_json,
                public_configuration_sha256
         FROM organization_adapter_bindings ORDER BY adapter_binding_id`,
      ).all(),
      grants: integrationDatabase.prepare(
        `SELECT * FROM organization_permission_grants`,
      ).all(),
    }).toEqual(stateBefore);
    repository.close();
  });

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
    const installation = INSTALLATION;
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

  it("links a Slack human to an exact Person session without creating an installation binding or grant", () => {
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
        "organization-slack-before-person-link",
        "sch_55555555-5555-4555-8555-555555555555",
      ),
    );
    const organizationTool = repository.activeSlackOrganizationTool()!;
    const begun = repository.beginPersonSlackIdentityLinkChallenge({
      request_sha256: digest("person-link-begin-one"),
      challenge_code_sha256: digest("person-challenge-one"),
      person_session: PERSON_SESSION,
      organization_tool: organizationTool,
      now: NOW,
    });

    expect(
      repository.personSlackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: digest("person-challenge-one"),
        person_session: PERSON_SESSION,
        organization_tool: organizationTool,
        now: NOW,
      }),
    ).toEqual({
      ...begun,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
    });

    const completion = personSlackIdentityLinkCompletion(
      begun.challenge_attempt_id,
      organizationTool,
    );
    const completed =
      repository.completePersonSlackIdentityLinkChallenge(completion);
    expect(completed).toMatchObject({
      schema_version: 2,
      kind: "echo-organization-person-slack-link-result",
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_subject_id: "U_PERSON",
      identity_link_created: true,
    } satisfies Partial<CompletedPersonSlackIdentityLink>);
    expect(
      repository.personSlackIdentityLinkCompletionReplay(
        completion.command_id,
        completion.command_sha256,
      ),
    ).toEqual(completed);
    expect(repository.completePersonSlackIdentityLinkChallenge(completion)).toEqual(
      completed,
    );
    expect(
      repository.completePersonSlackIdentityLinkChallenge({
        ...completion,
        command_id: "psc_person-link-response-loss-retry",
        command_sha256: digest("person-link-response-loss-retry"),
      }),
    ).toEqual(completed);

    const overview = repository.overview();
    expect(overview.identity_links).toEqual([
      expect.objectContaining({
        identity_link_id: completed.identity_link_id,
        membership_id: MEMBERSHIP_ID,
        provider_subject_id: "U_PERSON",
      }),
    ]);
    expect(overview.adapter_bindings).toEqual([]);
    expect(overview.permission_grants).toEqual([]);
    expect(overview.recent_audit[0]).toMatchObject({
      actor_kind: "membership",
      action: "person_slack_identity_link.completed",
      outcome: "succeeded",
      reason_code: "person_proved_slack_identity",
    });
    expect(
      integrationDatabase
        .prepare(
          `SELECT actor_principal_id, actor_membership_id,
                  actor_installation_id, identity_link_id,
                  adapter_binding_id, permission_grant_id
           FROM organization_integration_audit
           WHERE action = 'person_slack_identity_link.completed'`,
        )
        .get(),
    ).toEqual({
      actor_principal_id: PRINCIPAL_ID,
      actor_membership_id: MEMBERSHIP_ID,
      actor_installation_id: null,
      identity_link_id: completed.identity_link_id,
      adapter_binding_id: null,
      permission_grant_id: null,
    });
    expect(repository.verifyIntegrationAuditChain()).toMatchObject({
      valid: true,
    });
    expect(
      integrationDatabase
        .prepare(
          `SELECT redirect_uri, status
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?`,
        )
        .get(begun.challenge_attempt_id),
    ).toEqual({
      redirect_uri: "urn:echo:organization:person:slack-channel-link",
      status: "succeeded",
    });
    repository.close();
  });

  it("binds a Person Slack challenge to its exact session and active membership identity", () => {
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
        "organization-slack-person-binding",
        "sch_66666666-6666-4666-8666-666666666666",
      ),
    );
    const organizationTool = repository.activeSlackOrganizationTool()!;
    const begun = repository.beginPersonSlackIdentityLinkChallenge({
      request_sha256: digest("person-binding-begin"),
      challenge_code_sha256: digest("person-binding-challenge"),
      person_session: PERSON_SESSION,
      organization_tool: organizationTool,
      now: NOW,
    });
    const differentFamily = {
      ...PERSON_SESSION,
      session_family_id: "psf_33333333-3333-4333-8333-333333333333",
    };
    expect(() =>
      repository.personSlackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: digest("person-binding-challenge"),
        person_session: differentFamily,
        organization_tool: organizationTool,
        now: NOW,
      }),
    ).toThrow("does not match this session");
    expect(() =>
      repository.personSlackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: digest("wrong-person-challenge"),
        person_session: PERSON_SESSION,
        organization_tool: organizationTool,
        now: NOW,
      }),
    ).toThrow("does not match this session");
    expect(() =>
      repository.slackIdentityLinkChallenge({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_code_sha256: digest("person-binding-challenge"),
        installation: INSTALLATION,
        organization_tool: organizationTool,
        now: NOW,
      }),
    ).toThrow("does not match this installation");

    const first = repository.completePersonSlackIdentityLinkChallenge(
      personSlackIdentityLinkCompletion(
        begun.challenge_attempt_id,
        organizationTool,
        { challenge: "person-binding-challenge" },
      ),
    );
    const anotherMemberSession = {
      ...PERSON_SESSION,
      principal_id: "prn_other-person",
      membership_id: "mem_other-membership",
      identity_binding_id: "oib_44444444-4444-4444-8444-444444444444",
      session_family_id: "psf_55555555-5555-4555-8555-555555555555",
    };
    const conflicting = repository.beginPersonSlackIdentityLinkChallenge({
      request_sha256: digest("person-binding-conflicting-begin"),
      challenge_code_sha256: digest("person-binding-conflicting-challenge"),
      person_session: anotherMemberSession,
      organization_tool: organizationTool,
      now: "2026-07-29T20:01:00.000Z",
    });
    expect(() =>
      repository.completePersonSlackIdentityLinkChallenge(
        personSlackIdentityLinkCompletion(
          conflicting.challenge_attempt_id,
          organizationTool,
          {
            command: "person-link-conflicting-member",
            challenge: "person-binding-conflicting-challenge",
            message_ts: "1753822860.000001",
            person_session: anotherMemberSession,
            user_id: first.provider_subject_id,
            now: "2026-07-29T20:01:00.000Z",
          },
        ),
      ),
    ).toThrow("already linked to another active membership");
    expect(repository.overview().identity_links).toHaveLength(1);
    expect(repository.overview().adapter_bindings).toEqual([]);
    expect(repository.overview().permission_grants).toEqual([]);

    const expiring = repository.beginPersonSlackIdentityLinkChallenge({
      request_sha256: digest("person-binding-expiring-begin"),
      challenge_code_sha256: digest("person-binding-expiring-challenge"),
      person_session: PERSON_SESSION,
      organization_tool: organizationTool,
      now: "2026-07-29T20:02:00.000Z",
    });
    expect(() =>
      repository.personSlackIdentityLinkChallenge({
        challenge_attempt_id: expiring.challenge_attempt_id,
        challenge_code_sha256: digest("person-binding-expiring-challenge"),
        person_session: PERSON_SESSION,
        organization_tool: organizationTool,
        now: "2026-07-29T20:17:00.000Z",
      }),
    ).toThrow("Person Slack identity link challenge expired");
    expect(
      integrationDatabase
        .prepare(
          `SELECT status, outcome_reason
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?`,
        )
        .get(expiring.challenge_attempt_id),
    ).toEqual({ status: "expired", outcome_reason: "challenge_expired" });
    repository.close();
  });

  it("activates an existing Slack identity and binding with one direct grant pair", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const linked = completeSlackIdentityLink(
      repository,
      "approval-activation",
      "sch_11111111-1111-4111-8111-111111111111",
    );
    const input = approvalActivationInput(linked);
    const result = repository.activateExistingSlackApproval(input);

    expect(result).toMatchObject({
      identity_link_id: linked.identity_link_id,
      adapter_binding_id: linked.adapter_binding_id,
      membership_id: MEMBERSHIP_ID,
      installation_id: INSTALLATION_ID,
      activated_at: NOW,
      permission_grants_created: 2,
    });
    expect(
      repository.slackApprovalActivationReplay(
        input.command_id,
        input.command_sha256,
      ),
    ).toEqual(result);
    expect(repository.activateExistingSlackApproval(input)).toEqual(result);
    expect(
      repository.activeSlackApprovalRuntimeBinding(
        "founder-approvals",
        INSTALLATION_ID,
        digest("installation-key"),
      ),
    ).toMatchObject({
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      reviewer_slack_user_id: "U_ZHEN",
      installation_id: INSTALLATION_ID,
      adapter_binding_id: linked.adapter_binding_id,
      approve_permission_grant_id: result.approve_permission_grant_id,
      reject_permission_grant_id: result.reject_permission_grant_id,
      organization_tool: {
        team_id: "T123TEAM",
        channel_id: "C123CHANNEL",
      },
    });
    expect(
      repository.activeSlackApprovalRuntimeBinding(
        "missing-approvals",
        INSTALLATION_ID,
        digest("installation-key"),
      ),
    ).toBeNull();
    expect(
      repository.activeSlackApprovalRuntimeBinding(
        "founder-approvals",
        INSTALLATION_ID,
        digest("different-installation-key"),
      ),
    ).toBeNull();
    expect(() =>
      repository.slackApprovalActivationReplay(
        input.command_id,
        digest("different-activation"),
      ),
    ).toThrow(/reused with different input/);

    const permissionLookup = {
      organization_id: ORGANIZATION_ID,
      installation_id: INSTALLATION_ID,
      installation_key_id: digest("installation-key"),
      adapter_id: "slack-reactions",
      adapter_instance_id: "founder-approvals",
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
      permission_grant_id: result.approve_permission_grant_id,
    });
    expect(
      repository.findSlackApprovalPermission({
        ...permissionLookup,
        action: "reject",
        reaction_name: "x",
      }),
    ).toMatchObject({
      permission_grant_id: result.reject_permission_grant_id,
    });

    const overview = repository.overview();
    expect(overview.identity_links).toHaveLength(1);
    expect(overview.tool_connections).toHaveLength(1);
    expect(overview.adapter_bindings).toHaveLength(1);
    expect(overview.permission_grants).toHaveLength(2);
    expect(overview.recent_audit.map((entry) => entry["action"])).toEqual([
      "slack_approval.activated",
      "slack_identity_link.completed",
      "organization_tool.slack.onboarded",
    ]);
    repository.close();
  });

  it("ignores same-surface bindings owned by historical installations", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const linked = completeSlackIdentityLink(
      repository,
      "runtime-installation-scope",
      "sch_19191919-1919-4191-8191-191919191919",
    );
    repository.activateExistingSlackApproval(approvalActivationInput(linked));
    const organizationTool = repository.activeSlackOrganizationTool()!;
    insertHistoricalSlackBinding(integrationDatabase, {
      binding_id: "bnd_historical-internal-approvals",
      installation_id: "ins_historical-installation",
      adapter_instance_id: "founder-approvals",
      connection_id: organizationTool.connection_id,
      configuration: {
        approve_reaction: organizationTool.approve_reaction,
        channel_id: organizationTool.channel_id,
        reject_reaction: organizationTool.reject_reaction,
        slack_app_id: organizationTool.app_id,
        slack_bot_id: organizationTool.bot_id,
        slack_bot_user_id: organizationTool.bot_user_id,
        slack_enterprise_id: organizationTool.enterprise_id,
      },
    });

    expect(
      repository.activeSlackApprovalRuntimeBinding(
        "founder-approvals",
        INSTALLATION_ID,
        digest("installation-key"),
      ),
    ).toMatchObject({ adapter_binding_id: linked.adapter_binding_id });
    expect(
      repository.activeSlackApprovalRuntimeBinding(
        "founder-approvals",
        "ins_historical-installation",
        digest("ins_historical-installation-key"),
      ),
    ).toBeNull();
    repository.close();
  });

  it("reuses the exact live grant pair and historical bootstrap binding", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const linked = completeSlackIdentityLink(
      repository,
      "approval-activation",
      "sch_11111111-1111-4111-8111-111111111111",
    );
    const created = repository.activateExistingSlackApproval(
      approvalActivationInput(linked, "approval-activation-create-pair"),
    );
    const historicalConfiguration =
      '{"approve_reaction":"white_check_mark","channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}';
    integrationDatabase.exec(
      "DROP TRIGGER organization_adapter_bindings_revoke_only",
    );
    integrationDatabase
      .prepare(
        `UPDATE organization_adapter_bindings
         SET public_configuration_json = ?, public_configuration_sha256 = ?
         WHERE adapter_binding_id = ?`,
      )
      .run(
        historicalConfiguration,
        digest(historicalConfiguration),
        linked.adapter_binding_id,
      );

    const reused = repository.activateExistingSlackApproval(
      approvalActivationInput(linked, "approval-activation-reuse-pair"),
    );
    expect(reused).toMatchObject({
      approve_permission_grant_id: created.approve_permission_grant_id,
      reject_permission_grant_id: created.reject_permission_grant_id,
      permission_grants_created: 0,
    });
    expect(repository.overview().permission_grants).toHaveLength(2);
    expect(
      repository
        .overview()
        .recent_audit.filter(
          (entry) => entry["action"] === "slack_approval.activated",
        )
        .map((entry) => entry["reason_code"]),
    ).toEqual(["existing_direct_grants_reused", "direct_grants_created"]);
    repository.close();
  });

  it("fails closed on partial or mismatched approval activation state", () => {
    const integrationDatabase = database();
    const repository = new OrganizationIntegrationsRepository(
      integrationDatabase,
      {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
      },
    );
    const linked = completeSlackIdentityLink(
      repository,
      "approval-activation",
      "sch_11111111-1111-4111-8111-111111111111",
    );
    const input = approvalActivationInput(linked);

    for (const mismatch of [
      { ...input, identity_link_id: "clm_missing" },
      { ...input, adapter_binding_id: "bnd_missing" },
      { ...input, target_principal_id: "prn_other-principal" },
      { ...input, installation_key_id: digest("other-installation-key") },
    ]) {
      expect(() =>
        repository.activateExistingSlackApproval(mismatch),
      ).toThrow(OrganizationIntegrationConflictError);
    }
    integrationDatabase
      .prepare(
        `INSERT INTO organization_permission_grants (
           permission_grant_id, organization_id, adapter_binding_id,
           principal_id, membership_id, action, resource_scope_json, status,
           granted_by_principal_id, granted_by_membership_id, granted_at,
           revoked_at, revocation_reason
         ) VALUES (
           'pgr_partial-approve', ?, ?, ?, ?, 'approve', '{}', 'active',
           ?, ?, ?, NULL, NULL
         )`,
      )
      .run(
        ORGANIZATION_ID,
        linked.adapter_binding_id,
        PRINCIPAL_ID,
        MEMBERSHIP_ID,
        PRINCIPAL_ID,
        MEMBERSHIP_ID,
        NOW,
      );
    expect(() => repository.activateExistingSlackApproval(input)).toThrow(
      "conflicting existing direct grants",
    );
    expect(repository.overview().permission_grants).toHaveLength(1);
    expect(
      repository
        .overview()
        .recent_audit.some(
          (entry) => entry["action"] === "slack_approval.activated",
        ),
    ).toBe(false);
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
    completeSlackIdentityLink(
      repository,
      "audit-chain",
      "sch_55555555-5555-4555-8555-555555555555",
    );

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
