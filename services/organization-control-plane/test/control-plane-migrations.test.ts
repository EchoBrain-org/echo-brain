import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  currentOrganizationControlSchemaVersion,
  openOrganizationControlDatabase,
  OrganizationIntegrationsRepository,
  organizationControlApplicationId,
} from "../src/index.js";
import {
  migrateOrganizationControlDatabaseWithMigrations,
  type OrganizationControlMigration,
} from "../src/persistence/migrate.js";

/**
 * This is the executable scope contract. Every table must belong to one
 * externally observable v1 behavior. A future table addition must name and
 * test a new behavior instead of claiming speculative future use.
 */
const TABLES_BY_OBSERVABLE_BEHAVIOR = {
  "opens only the intended private organization database": [
    "organization_control_plane_metadata",
    "organization_schema_migrations",
  ],
  "proves a provider human before linking it to an Authority membership": [
    "organization_connection_attempts",
    "organization_external_identity_links",
  ],
  "binds a customer-held connection to one exact product adapter": [
    "organization_adapter_bindings",
    "organization_tool_connections",
  ],
  "grants one membership one explicit approval action": [
    "organization_permission_grants",
  ],
  "records mutations and permission results without provider-event replay": [
    "organization_integration_audit",
  ],
} as const;

const TABLES = Object.values(TABLES_BY_OBSERVABLE_BEHAVIOR).flat().sort();
const V1_SCHEMA_CONTRACT_SHA256 =
  "sha256:5f6ef3d7154d7708a716d68042aa77978d5df3767f8ee558b31557dc21457571";

const IDS = {
  authority: "oau_test-authority",
  binding: "bnd_slack-approval",
  connection: "con_slack-app",
  controlPlane: "ocp_test-control-plane",
  identityLink: "clm_zhen-slack",
  installation: "ins_test-installation",
  membership: "mem_zhen-membership",
  otherMembership: "mem_other-membership",
  organization: "org_test-organization",
  principal: "prn_zhen-principal",
  otherPrincipal: "prn_other-principal",
} as const;

const TIME = {
  created: "2026-07-29T10:00:00.000Z",
  completed: "2026-07-29T10:01:00.000Z",
  granted: "2026-07-29T10:02:00.000Z",
  revoked: "2026-07-29T10:03:00.000Z",
  expires: "2026-07-29T10:10:00.000Z",
  tooLate: "2026-07-29T10:11:00.000Z",
} as const;

const LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON =
  '{"approve_reaction":"white_check_mark","channel_id":"C123CHANNEL","reject_reaction":"x","slack_app_id":null,"slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}';
const PROMOTED_LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON =
  '{"approve_reaction":"white_check_mark","channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":null,"slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}';
const READY_SLACK_PUBLIC_CONFIGURATION_JSON =
  '{"channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}';
const READY_SLACK_APPROVAL_BINDING_CONFIGURATION_JSON =
  '{"approve_reaction":"white_check_mark","channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}';
const FOUNDER_LIVE_SLACK_SCOPES_JSON =
  '["channels:history","chat:write","groups:history","incoming-webhook","reactions:read","users:read"]';
const REQUIRED_SLACK_SCOPES_JSON =
  '["channels:history","channels:read","chat:write","reactions:read","users:read"]';
const AUTHORITY_SECRET_HANDLE = "sch_11111111-1111-4111-8111-111111111111";
const IMMUTABLE_MIGRATION_SHA256 = [
  "sha256:453291a88f61b2675c06bd2359af5cdc5b71097b85418b2ac5b32fe8d7e7060e",
  "sha256:b8dfb1a432ec709a7fa8298ad105e25987ab40aca6e238fa685cc01f2d5d7425",
  "sha256:83c7ad70666693deed991861dfe55e8e949127421c5e70d79127905c7264aa7b",
] as const;

const temporaryDirectories: string[] = [];

function digest(label: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function controlPlaneMigrationsThroughV3(): readonly OrganizationControlMigration[] {
  return [
    "0001_organization_control_plane.sql",
    "0002_organization_tool_public_configuration.sql",
    "0003_single_canonical_slack_promotion.sql",
  ].map((filename, index) => {
    const sql = readFileSync(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8",
    );
    return {
      version: index + 1,
      filename,
      sql,
      sha256: digest(sql),
    };
  });
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-org-control-"));
  temporaryDirectories.push(directory);
  return join(directory, "organization-control.sqlite");
}

function seedMetadata(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata (
         singleton, control_plane_id, organization_id, authority_id,
         authority_descriptor_sha256, created_at
       ) VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      IDS.controlPlane,
      IDS.organization,
      IDS.authority,
      digest("authority-descriptor"),
      TIME.created,
    );
}

interface AttemptInput {
  id: string;
  ownerKind: "membership" | "organization";
  requestedScopes?: string;
}

function insertPendingAttempt(
  database: Database.Database,
  input: AttemptInput,
): void {
  const membershipOwned = input.ownerKind === "membership";
  const requestedScopes = input.requestedScopes ?? '["identity.basic"]';
  database
    .prepare(
      `INSERT INTO organization_connection_attempts (
         connection_attempt_id, organization_id, requested_by_principal_id,
         requested_by_membership_id, attempt_purpose, target_owner_kind,
         target_principal_id, target_membership_id, provider, provider_issuer,
         provider_tenant_kind, provider_tenant_id, redirect_uri,
         requested_scopes_json, requested_scopes_sha256, state_sha256,
         nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
         provider_subject_kind, provider_subject_id, granted_scopes_json,
         granted_scopes_sha256, verification_evidence_sha256, created_at,
         expires_at, consumed_at, outcome_reason
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         'https://echo.internal/connect/callback', ?, ?, ?, ?, ?, ?, 'pending',
         NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL
       )`,
    )
    .run(
      input.id,
      IDS.organization,
      IDS.principal,
      IDS.membership,
      input.ownerKind === "organization" ? "tool_connection" : "identity_link",
      input.ownerKind,
      membershipOwned ? IDS.principal : null,
      membershipOwned ? IDS.membership : null,
      "slack",
      "https://slack.com",
      "workspace",
      "T_TEST",
      requestedScopes,
      digest(requestedScopes),
      digest(`state:${input.id}`),
      digest(`nonce:${input.id}`),
      digest(`pkce:${input.id}`),
      digest(`admin-session:${input.id}`),
      TIME.created,
      TIME.expires,
    );
}

interface CompleteAttemptInput {
  id: string;
  subjectKind: "human_user" | "service_account";
  subjectId: string;
  grantedScopes?: string;
  consumedAt?: string;
}

function completeAttempt(
  database: Database.Database,
  input: CompleteAttemptInput,
): void {
  const grantedScopes = input.grantedScopes ?? '["identity.basic"]';
  database
    .prepare(
      `UPDATE organization_connection_attempts
       SET status = 'succeeded', provider_subject_kind = ?,
           provider_subject_id = ?, granted_scopes_json = ?,
           granted_scopes_sha256 = ?, verification_evidence_sha256 = ?,
           consumed_at = ?
       WHERE connection_attempt_id = ?`,
    )
    .run(
      input.subjectKind,
      input.subjectId,
      grantedScopes,
      digest(grantedScopes),
      digest(`verification-evidence:${input.id}`),
      input.consumedAt ?? TIME.completed,
      input.id,
    );
}

function insertIdentityLink(
  database: Database.Database,
  attemptId = "cat_slack-human",
): void {
  database
    .prepare(
      `INSERT INTO organization_external_identity_links (
         identity_link_id, organization_id, principal_id, membership_id,
         provider, provider_issuer, provider_tenant_kind, provider_tenant_id,
         provider_subject_id, verification_attempt_id,
         verification_evidence_sha256, status, verified_at, revoked_at,
         revocation_reason
       ) VALUES (
         ?, ?, ?, ?, 'slack', 'https://slack.com', 'workspace', 'T_TEST',
         'U_ZHEN', ?, ?, 'active', ?, NULL, NULL
       )`,
    )
    .run(
      IDS.identityLink,
      IDS.organization,
      IDS.principal,
      IDS.membership,
      attemptId,
      digest(`verification-evidence:${attemptId}`),
      TIME.completed,
    );
}

function insertServiceConnection(
  database: Database.Database,
  options: {
    connectionId?: string;
    attemptId?: string;
    providerSubjectId?: string;
    grantedScopesJson?: string;
    secretHandle?: string;
    publicConfigurationJson?: string;
  } = {},
): void {
  const hasPublicConfiguration = (
    database
      .prepare("PRAGMA table_info(organization_tool_connections)")
      .all() as Array<{ name: string }>
  ).some(({ name }) => name === "public_configuration_json");
  const publicConfigurationColumns = hasPublicConfiguration
    ? ", public_configuration_json, public_configuration_sha256"
    : "";
  const publicConfigurationValues = hasPublicConfiguration ? ", ?, ?" : "";
  const attemptId = options.attemptId ?? "cat_slack-app";
  const completedAttempt = database
    .prepare(
      `SELECT granted_scopes_json
       FROM organization_connection_attempts
       WHERE connection_attempt_id = ?`,
    )
    .get(attemptId) as { granted_scopes_json: string } | undefined;
  const grantedScopesJson =
    options.grantedScopesJson ??
    completedAttempt?.granted_scopes_json ??
    REQUIRED_SLACK_SCOPES_JSON;
  const publicConfigurationJson =
    options.publicConfigurationJson ??
    (hasPublicConfiguration
      ? READY_SLACK_PUBLIC_CONFIGURATION_JSON
      : LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON);
  database
    .prepare(
      `INSERT INTO organization_tool_connections (
         connection_id, organization_id, connection_kind, owner_kind,
         owner_principal_id, owner_membership_id, human_identity_link_id,
         provider, provider_issuer, provider_tenant_kind, provider_tenant_id,
         provider_subject_kind, provider_subject_id, granted_scopes_json,
         granted_scopes_sha256, verification_attempt_id,
         verification_evidence_sha256, secret_backend_id, secret_handle_id,
         status, created_by_principal_id, created_by_membership_id,
         activated_at, revoked_at, revocation_reason
         ${publicConfigurationColumns}
       ) VALUES (
         ?, ?, 'service_account', 'organization', NULL, NULL, NULL,
         'slack', 'https://slack.com', 'workspace', 'T_TEST',
         'service_account', ?, ?, ?, ?,
         ?, 'authority-file-v1', ?, 'active', ?, ?, ?, NULL, NULL
         ${publicConfigurationValues}
       )`,
    )
    .run(
      options.connectionId ?? IDS.connection,
      IDS.organization,
      options.providerSubjectId ?? "U123BOT",
      grantedScopesJson,
      digest(grantedScopesJson),
      attemptId,
      digest(`verification-evidence:${attemptId}`),
      options.secretHandle ?? AUTHORITY_SECRET_HANDLE,
      IDS.principal,
      IDS.membership,
      TIME.completed,
      ...(hasPublicConfiguration
        ? [publicConfigurationJson, digest(publicConfigurationJson)]
        : []),
    );
}

function insertBinding(
  database: Database.Database,
  options: {
    bindingId?: string;
    installationId?: string;
    adapterInstanceId?: string;
    publicConfigurationJson?: string;
  } = {},
): void {
  const publicConfigurationJson =
    options.publicConfigurationJson ??
    ((
      database
        .prepare("PRAGMA table_info(organization_tool_connections)")
        .all() as Array<{ name: string }>
    ).some(({ name }) => name === "public_configuration_json")
      ? READY_SLACK_APPROVAL_BINDING_CONFIGURATION_JSON
      : LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON);
  database
    .prepare(
      `INSERT INTO organization_adapter_bindings (
         adapter_binding_id, organization_id, product_namespace,
         installation_id, installation_key_id, adapter_kind, adapter_id,
         adapter_instance_id, adapter_version, connection_id,
         public_configuration_json, public_configuration_sha256, status,
         created_by_principal_id, created_by_membership_id, bound_at,
         revoked_at, revocation_reason
       ) VALUES (
         ?, ?, 'echo-brain', ?, ?, 'approval-surface', 'slack-reactions',
         ?, '1.0.0', ?, ?, ?, 'active',
         ?, ?, ?, NULL, NULL
       )`,
    )
    .run(
      options.bindingId ?? IDS.binding,
      IDS.organization,
      options.installationId ?? IDS.installation,
      digest("installation-key"),
      options.adapterInstanceId ?? "primary",
      IDS.connection,
      publicConfigurationJson,
      digest(publicConfigurationJson),
      IDS.principal,
      IDS.membership,
      TIME.completed,
    );
}

function insertGrant(
  database: Database.Database,
  options: { id?: string; action?: "view" | "approve" | "reject" } = {},
): void {
  database
    .prepare(
      `INSERT INTO organization_permission_grants (
         permission_grant_id, organization_id, adapter_binding_id,
         principal_id, membership_id, action, resource_scope_json, status,
         granted_by_principal_id, granted_by_membership_id, granted_at,
         revoked_at, revocation_reason
       ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, NULL, NULL)`,
    )
    .run(
      options.id ?? "pgr_zhen-approve",
      IDS.organization,
      IDS.binding,
      IDS.principal,
      IDS.membership,
      options.action ?? "approve",
      IDS.principal,
      IDS.membership,
      TIME.granted,
    );
}

function seedApprovalFlow(
  database: Database.Database,
  connectionScopes = REQUIRED_SLACK_SCOPES_JSON,
  bindingConfiguration = LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
): void {
  seedMetadata(database);
  insertPendingAttempt(database, {
    id: "cat_slack-human",
    ownerKind: "membership",
  });
  completeAttempt(database, {
    id: "cat_slack-human",
    subjectKind: "human_user",
    subjectId: "U_ZHEN",
  });
  insertIdentityLink(database);
  insertPendingAttempt(database, {
    id: "cat_slack-app",
    ownerKind: "organization",
    requestedScopes: connectionScopes,
  });
  completeAttempt(database, {
    id: "cat_slack-app",
    subjectKind: "service_account",
    subjectId: "U123BOT",
    grantedScopes: connectionScopes,
  });
  insertServiceConnection(database);
  insertBinding(database, { publicConfigurationJson: bindingConfiguration });
  insertGrant(database);
}

function effectivePermission(
  database: Database.Database,
  input: {
    membershipId?: string;
    providerSubjectId?: string;
    action?: string;
  } = {},
): unknown {
  return database
    .prepare(
      `SELECT grant_row.permission_grant_id
       FROM organization_external_identity_links AS identity
       JOIN organization_permission_grants AS grant_row
         ON grant_row.organization_id = identity.organization_id
         AND grant_row.principal_id = identity.principal_id
         AND grant_row.membership_id = identity.membership_id
       JOIN organization_adapter_bindings AS binding
         ON binding.adapter_binding_id = grant_row.adapter_binding_id
       JOIN organization_tool_connections AS connection
         ON connection.connection_id = binding.connection_id
       WHERE identity.organization_id = ?
         AND identity.membership_id = ?
         AND identity.provider = 'slack'
         AND identity.provider_issuer = 'https://slack.com'
         AND identity.provider_tenant_kind = 'workspace'
         AND identity.provider_tenant_id = 'T_TEST'
         AND identity.provider_subject_id = ?
         AND identity.status = 'active'
         AND grant_row.action = ?
         AND grant_row.status = 'active'
         AND binding.status = 'active'
         AND connection.status = 'active'`,
    )
    .get(
      IDS.organization,
      input.membershipId ?? IDS.membership,
      input.providerSubjectId ?? "U_ZHEN",
      input.action ?? "approve",
    );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("minimum organization control-plane v1 schema", () => {
  it("locks every v1 table, column, enum check, index, and trigger", () => {
    const controlDatabase = openOrganizationControlDatabase(":memory:");
    try {
      const schema = controlDatabase
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all();
      expect(digest(JSON.stringify(schema))).toBe(V1_SCHEMA_CONTRACT_SHA256);
    } finally {
      controlDatabase.close();
    }
  });

  it("installs only tables assigned to observable v1 behavior", () => {
    const path = databasePath();
    const database = openOrganizationControlDatabase(path);
    expect(currentOrganizationControlSchemaVersion()).toBe(3);
    expect(database.pragma("user_version", { simple: true })).toBe(3);
    expect(database.pragma("application_id", { simple: true })).toBe(
      organizationControlApplicationId(),
    );
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");

    const declared = Object.values(TABLES_BY_OBSERVABLE_BEHAVIOR).flat();
    expect(new Set(declared).size).toBe(declared.length);
    const actual = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(actual.map(({ name }) => name)).toEqual(TABLES);
    expect(TABLES).toHaveLength(8);
    database.close();

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("rejects missing, foreign, partial, future, and tampered databases", () => {
    const path = databasePath();
    openOrganizationControlDatabase(path).close();
    expect(() => openOrganizationControlDatabase(path).close()).not.toThrow();

    const missing = join(path, "..", "missing.sqlite");
    expect(() =>
      openOrganizationControlDatabase(missing, { fileMustExist: true }),
    ).toThrow();
    expect(existsSync(missing)).toBe(false);

    const foreignPath = join(path, "..", "foreign.sqlite");
    const foreign = new Database(foreignPath);
    foreign.pragma("application_id = 1234");
    foreign.close();
    chmodSync(foreignPath, 0o600);
    expect(() => openOrganizationControlDatabase(foreignPath)).toThrow(
      "not an organization control-plane database",
    );

    const occupiedPath = join(path, "..", "occupied.sqlite");
    const occupied = new Database(occupiedPath);
    occupied.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT");
    occupied.close();
    chmodSync(occupiedPath, 0o600);
    expect(() => openOrganizationControlDatabase(occupiedPath)).toThrow(
      "refusing to claim a non-empty uninitialized database",
    );

    const partialPath = join(path, "..", "partial.sqlite");
    const partial = new Database(partialPath);
    partial.pragma(`application_id = ${organizationControlApplicationId()}`);
    partial.pragma("user_version = 1");
    partial.close();
    chmodSync(partialPath, 0o600);
    expect(() => openOrganizationControlDatabase(partialPath)).toThrow(
      "migration ledger does not match user_version",
    );

    const futurePath = join(path, "..", "future.sqlite");
    const future = new Database(futurePath);
    future.pragma("user_version = 4");
    future.close();
    chmodSync(futurePath, 0o600);
    expect(() => openOrganizationControlDatabase(futurePath)).toThrow(
      "newer than supported schema 3",
    );

    const tamperedPath = join(path, "..", "tampered.sqlite");
    openOrganizationControlDatabase(tamperedPath).close();
    const tampered = new Database(tamperedPath);
    tampered.exec(
      "DROP TRIGGER organization_permission_grants_immutable_delete",
    );
    tampered.close();
    expect(() => openOrganizationControlDatabase(tamperedPath)).toThrow(
      "schema fingerprint is invalid",
    );
  });

  it("authenticates v1 before attempting any future migration", () => {
    const path = databasePath();
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    const firstSql = readFileSync(
      new URL(
        "../migrations/0001_organization_control_plane.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const secondSql =
      "CREATE TABLE organization_future_marker (singleton INTEGER PRIMARY KEY) STRICT;";
    const migrations: readonly OrganizationControlMigration[] = [
      {
        version: 1,
        filename: "0001_organization_control_plane.sql",
        sql: firstSql,
        sha256: digest(firstSql),
      },
      {
        version: 2,
        filename: "0002_future_marker.sql",
        sql: secondSql,
        sha256: digest(secondSql),
      },
    ];
    migrateOrganizationControlDatabaseWithMigrations(
      database,
      migrations.slice(0, 1),
    );
    database.exec(
      "DROP TRIGGER organization_permission_grants_immutable_delete",
    );

    expect(() =>
      migrateOrganizationControlDatabaseWithMigrations(database, migrations),
    ).toThrow("schema fingerprint is invalid");
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name = 'organization_future_marker'`,
        )
        .get(),
    ).toBeUndefined();
    database.close();
  });

  it("preserves and re-verifies the founder-live Slack approval path through immutable v2 and forward v3", () => {
    const path = databasePath();
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    const migrations = controlPlaneMigrationsThroughV3();
    expect(migrations.map(({ sha256 }) => sha256)).toEqual(
      IMMUTABLE_MIGRATION_SHA256,
    );
    migrateOrganizationControlDatabaseWithMigrations(
      database,
      migrations.slice(0, 1),
    );
    seedApprovalFlow(database, FOUNDER_LIVE_SLACK_SCOPES_JSON);

    expect(effectivePermission(database)).toEqual({
      permission_grant_id: "pgr_zhen-approve",
    });
    migrateOrganizationControlDatabaseWithMigrations(
      database,
      migrations.slice(0, 2),
    );
    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(
      database
        .prepare(
          `SELECT migration_sha256
           FROM organization_schema_migrations
           WHERE version = 2`,
        )
        .get(),
    ).toEqual({ migration_sha256: IMMUTABLE_MIGRATION_SHA256[1] });
    expect(
      database
        .prepare(
          `SELECT public_configuration_json
           FROM organization_tool_connections
           WHERE connection_id = ?`,
        )
        .get(IDS.connection),
    ).toEqual({
      public_configuration_json: LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
    });

    migrateOrganizationControlDatabaseWithMigrations(database, migrations);
    expect(database.pragma("user_version", { simple: true })).toBe(3);
    expect(
      database
        .prepare(
          `SELECT binding.adapter_binding_id, binding.connection_id,
                  grant_row.permission_grant_id, grant_row.action,
                  connection.granted_scopes_json,
                  connection.public_configuration_json
           FROM organization_adapter_bindings AS binding
           JOIN organization_permission_grants AS grant_row
             ON grant_row.adapter_binding_id = binding.adapter_binding_id
           JOIN organization_tool_connections AS connection
             ON connection.connection_id = binding.connection_id
           WHERE binding.adapter_binding_id = ?
             AND grant_row.permission_grant_id = ?`,
        )
        .get(IDS.binding, "pgr_zhen-approve"),
    ).toEqual({
      adapter_binding_id: IDS.binding,
      connection_id: IDS.connection,
      permission_grant_id: "pgr_zhen-approve",
      action: "approve",
      granted_scopes_json: FOUNDER_LIVE_SLACK_SCOPES_JSON,
      public_configuration_json: LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
    });
    expect(effectivePermission(database)).toEqual({
      permission_grant_id: "pgr_zhen-approve",
    });
    const legacyConnectionBeforeRejectedRewrite = database
      .prepare(
        `SELECT granted_scopes_json, granted_scopes_sha256,
                verification_attempt_id, verification_evidence_sha256,
                public_configuration_json, public_configuration_sha256
         FROM organization_tool_connections
         WHERE connection_id = ?`,
      )
      .get(IDS.connection);
    insertPendingAttempt(database, {
      id: "cat_profileless-rewrite",
      ownerKind: "organization",
      requestedScopes: REQUIRED_SLACK_SCOPES_JSON,
    });
    completeAttempt(database, {
      id: "cat_profileless-rewrite",
      subjectKind: "service_account",
      subjectId: "U123BOT",
      grantedScopes: REQUIRED_SLACK_SCOPES_JSON,
    });
    expect(() =>
      database
        .prepare(
          `UPDATE organization_tool_connections
           SET granted_scopes_json = ?,
               granted_scopes_sha256 = ?,
               verification_attempt_id = ?,
               verification_evidence_sha256 = ?
           WHERE connection_id = ?`,
        )
        .run(
          REQUIRED_SLACK_SCOPES_JSON,
          digest(REQUIRED_SLACK_SCOPES_JSON),
          "cat_profileless-rewrite",
          digest("verification-evidence:cat_profileless-rewrite"),
          IDS.connection,
        ),
    ).toThrow("tool connections may only be revoked or promoted");
    expect(
      database
        .prepare(
          `SELECT granted_scopes_json, granted_scopes_sha256,
                  verification_attempt_id, verification_evidence_sha256,
                  public_configuration_json, public_configuration_sha256
           FROM organization_tool_connections
           WHERE connection_id = ?`,
        )
        .get(IDS.connection),
    ).toEqual(legacyConnectionBeforeRejectedRewrite);

    const repository = new OrganizationIntegrationsRepository(database, {
      organization_id: IDS.organization,
      authority_id: IDS.authority,
    });
    const permissionLookup = {
      organization_id: IDS.organization,
      installation_id: IDS.installation,
      installation_key_id: digest("installation-key"),
      adapter_id: "slack-reactions",
      adapter_instance_id: "primary",
      adapter_version: "1.0.0",
      channel_id: "C123CHANNEL",
      reaction_name: "white_check_mark",
      slack_team_id: "T_TEST",
      slack_user_id: "U_ZHEN",
      slack_enterprise_id: null,
      slack_bot_user_id: "U123BOT",
      slack_bot_id: "B123BOT",
      slack_app_id: null,
      action: "approve",
    } as const;
    expect(repository.activeSlackOrganizationTool()).toBeNull();
    expect(repository.legacySlackOrganizationTool()).toMatchObject({
      connection_id: IDS.connection,
      channel_id: "C123CHANNEL",
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      granted_scopes: [
        "channels:history",
        "chat:write",
        "groups:history",
        "incoming-webhook",
        "reactions:read",
        "users:read",
      ],
    });
    expect(
      repository.findSlackApprovalPermission(permissionLookup),
    ).toMatchObject({
      connection_id: IDS.connection,
      adapter_binding_id: IDS.binding,
      permission_grant_id: "pgr_zhen-approve",
      secret_handle_id: AUTHORITY_SECRET_HANDLE,
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
    });

    const promoted = repository.onboardSlackOrganizationTool({
      command_id: "cmd_reverify-founder-live-slack",
      command_sha256: digest("reverify-founder-live-slack"),
      organization_id: IDS.organization,
      authority_id: IDS.authority,
      administrator_principal_id: IDS.principal,
      administrator_membership_id: IDS.membership,
      connection: {
        team_id: "T_TEST",
        enterprise_id: null,
        bot_user_id: "U123BOT",
        bot_id: "B123BOT",
        app_id: null,
        granted_scopes: [
          "channels:history",
          "channels:read",
          "chat:write",
          "reactions:read",
          "users:read",
        ],
        verification_evidence_sha256: digest(
          "reverified-founder-live-connection",
        ),
      },
      channel: {
        team_id: "T_TEST",
        channel_id: "C123CHANNEL",
        verification_evidence_sha256: digest("reverified-founder-live-channel"),
      },
      secret: {
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: AUTHORITY_SECRET_HANDLE,
      },
      now: TIME.revoked,
    });

    expect(promoted.connection_id).toBe(IDS.connection);
    expect(repository.activeSlackOrganizationTool()).toMatchObject({
      connection_id: IDS.connection,
      granted_scopes: [
        "channels:history",
        "channels:read",
        "chat:write",
        "reactions:read",
        "users:read",
      ],
    });
    insertPendingAttempt(database, {
      id: "cat_ready-successor",
      ownerKind: "organization",
      requestedScopes: REQUIRED_SLACK_SCOPES_JSON,
    });
    completeAttempt(database, {
      id: "cat_ready-successor",
      subjectKind: "service_account",
      subjectId: "U123BOT",
      grantedScopes: REQUIRED_SLACK_SCOPES_JSON,
    });
    expect(() =>
      insertServiceConnection(database, {
        connectionId: "con_ready-successor",
        attemptId: "cat_ready-successor",
        secretHandle: "sch_22222222-2222-4222-8222-222222222222",
        grantedScopesJson: REQUIRED_SLACK_SCOPES_JSON,
        publicConfigurationJson: READY_SLACK_PUBLIC_CONFIGURATION_JSON,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM organization_tool_connections
           WHERE organization_id = ? AND provider = 'slack'
             AND owner_kind = 'organization' AND status = 'active'`,
        )
        .get(IDS.organization),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT public_configuration_json
           FROM organization_tool_connections
           WHERE connection_id = ?`,
        )
        .get(IDS.connection),
    ).toEqual({
      public_configuration_json:
        PROMOTED_LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
    });
    expect(
      database
        .prepare(
          `SELECT status, granted_scopes_json
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?`,
        )
        .get(promoted.connection_attempt_id),
    ).toEqual({
      status: "succeeded",
      granted_scopes_json: REQUIRED_SLACK_SCOPES_JSON,
    });
    expect(
      repository.findSlackApprovalPermission(permissionLookup),
    ).toMatchObject({
      connection_id: IDS.connection,
      adapter_binding_id: IDS.binding,
      permission_grant_id: "pgr_zhen-approve",
      secret_handle_id: AUTHORITY_SECRET_HANDLE,
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
    });
    repository.close();
  });

  it("rejects a null legacy Slack identity before it can reach promotion", () => {
    const database = new Database(databasePath());
    database.pragma("foreign_keys = ON");
    const migrations = controlPlaneMigrationsThroughV3();
    migrateOrganizationControlDatabaseWithMigrations(
      database,
      migrations.slice(0, 1),
    );
    seedApprovalFlow(
      database,
      REQUIRED_SLACK_SCOPES_JSON,
      LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON.replace(
        '"slack_bot_id":"B123BOT"',
        '"slack_bot_id":null',
      ),
    );
    expect(() =>
      migrateOrganizationControlDatabaseWithMigrations(database, migrations),
    ).toThrow("CHECK constraint failed: compatible = 1");
    expect(database.pragma("user_version", { simple: true })).toBe(1);
    database.close();
  });

  it("aborts v1 upgrade rather than guessing missing or ambiguous Slack configuration", () => {
    for (const scenario of ["missing", "ambiguous"] as const) {
      const path = databasePath();
      const database = new Database(path);
      database.pragma("foreign_keys = ON");
      const migrations = controlPlaneMigrationsThroughV3();
      migrateOrganizationControlDatabaseWithMigrations(
        database,
        migrations.slice(0, 1),
      );
      seedMetadata(database);
      insertPendingAttempt(database, {
        id: "cat_slack-app",
        ownerKind: "organization",
        requestedScopes: '["chat:write"]',
      });
      completeAttempt(database, {
        id: "cat_slack-app",
        subjectKind: "service_account",
        subjectId: "U123BOT",
        grantedScopes: '["chat:write"]',
      });
      insertServiceConnection(database);
      insertBinding(database, {
        publicConfigurationJson:
          scenario === "missing"
            ? "{}"
            : LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
      });
      if (scenario === "ambiguous") {
        insertBinding(database, {
          bindingId: "bnd_second-slack-approval",
          installationId: "ins_second-installation",
          adapterInstanceId: "secondary",
        });
      }

      expect(() =>
        migrateOrganizationControlDatabaseWithMigrations(database, migrations),
      ).toThrow();
      expect(database.pragma("user_version", { simple: true })).toBe(1);
      expect(
        (
          database
            .prepare("PRAGMA table_info(organization_tool_connections)")
            .all() as Array<{ name: string }>
        ).some(({ name }) => name === "public_configuration_json"),
      ).toBe(false);
      database.close();
    }
  });

  it("accepts one exact terminal result for a pending connect ceremony", () => {
    const database = openOrganizationControlDatabase(":memory:");
    seedMetadata(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO organization_connection_attempts (
             connection_attempt_id, organization_id,
             requested_by_principal_id, requested_by_membership_id,
             attempt_purpose, target_owner_kind, target_principal_id,
             target_membership_id, provider, provider_issuer,
             provider_tenant_kind,
             provider_tenant_id, redirect_uri, requested_scopes_json,
             requested_scopes_sha256, state_sha256, nonce_sha256,
             pkce_challenge_sha256, admin_session_sha256, status,
             provider_subject_kind, provider_subject_id, granted_scopes_json,
             granted_scopes_sha256, verification_evidence_sha256, created_at,
             expires_at, consumed_at, outcome_reason
           ) VALUES (
             'cat_forced', ?, ?, ?, 'identity_link', 'membership', ?, ?, 'slack',
             'https://slack.com', 'workspace', 'T_TEST',
             'https://echo.internal/callback', '[]', ?, ?, ?, ?, ?,
             'succeeded', 'human_user', 'U_ATTACKER', '[]', ?, ?, ?, ?, ?,
             NULL
           )`,
        )
        .run(
          IDS.organization,
          IDS.principal,
          IDS.membership,
          IDS.principal,
          IDS.membership,
          digest("forced-scopes"),
          digest("forced-state"),
          digest("forced-nonce"),
          digest("forced-pkce"),
          digest("forced-session"),
          digest("forced-scopes"),
          digest("forced-evidence"),
          TIME.created,
          TIME.expires,
          TIME.completed,
        ),
    ).toThrow("connection attempts must start pending");

    insertPendingAttempt(database, {
      id: "cat_valid",
      ownerKind: "membership",
    });
    completeAttempt(database, {
      id: "cat_valid",
      subjectKind: "human_user",
      subjectId: "U_ZHEN",
    });
    expect(() =>
      database
        .prepare(
          `UPDATE organization_connection_attempts
           SET outcome_reason = 'rewrite'
           WHERE connection_attempt_id = 'cat_valid'`,
        )
        .run(),
    ).toThrow("connection attempt transition is invalid");

    insertPendingAttempt(database, {
      id: "cat_expired",
      ownerKind: "membership",
    });
    expect(() =>
      completeAttempt(database, {
        id: "cat_expired",
        subjectKind: "human_user",
        subjectId: "U_LATE",
        consumedAt: TIME.tooLate,
      }),
    ).toThrow();
    database.close();
  });

  it("rejects every incomplete or non-public new Slack organization profile", () => {
    const cases = [
      {
        label: "missing profile",
        configuration: LEGACY_SLACK_PUBLIC_CONFIGURATION_JSON,
        scopes: REQUIRED_SLACK_SCOPES_JSON,
      },
      {
        label: "missing required scope",
        configuration: READY_SLACK_PUBLIC_CONFIGURATION_JSON,
        scopes:
          '["channels:history","channels:read","chat:write","reactions:read"]',
      },
      {
        label: "null bot identity",
        configuration:
          '{"channel_id":"C123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":null,"slack_bot_user_id":"U123BOT","slack_enterprise_id":null}',
        scopes: REQUIRED_SLACK_SCOPES_JSON,
      },
      {
        label: "missing channel",
        configuration:
          '{"organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}',
        scopes: REQUIRED_SLACK_SCOPES_JSON,
      },
      {
        label: "non-public channel",
        configuration:
          '{"channel_id":"G123CHANNEL","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A123APP","slack_bot_id":"B123BOT","slack_bot_user_id":"U123BOT","slack_enterprise_id":null}',
        scopes: REQUIRED_SLACK_SCOPES_JSON,
      },
    ] as const;

    for (const scenario of cases) {
      const database = openOrganizationControlDatabase(":memory:");
      seedMetadata(database);
      insertPendingAttempt(database, {
        id: "cat_slack-app",
        ownerKind: "organization",
        requestedScopes: scenario.scopes,
      });
      completeAttempt(database, {
        id: "cat_slack-app",
        subjectKind: "service_account",
        subjectId: "U123BOT",
        grantedScopes: scenario.scopes,
      });

      expect(
        () =>
          insertServiceConnection(database, {
            grantedScopesJson: scenario.scopes,
            publicConfigurationJson: scenario.configuration,
          }),
        scenario.label,
      ).toThrow(
        "active Slack organization connection configuration is incomplete",
      );
      expect(
        database.prepare("SELECT 1 FROM organization_tool_connections").get(),
      ).toBeUndefined();
      database.close();
    }
  });

  it("links only the exact provider human proved by the connect ceremony", () => {
    const database = openOrganizationControlDatabase(":memory:");
    seedMetadata(database);
    insertPendingAttempt(database, {
      id: "cat_slack-human",
      ownerKind: "membership",
    });
    completeAttempt(database, {
      id: "cat_slack-human",
      subjectKind: "human_user",
      subjectId: "U_ZHEN",
    });
    expect(() =>
      database
        .prepare(
          `INSERT INTO organization_external_identity_links (
             identity_link_id, organization_id, principal_id, membership_id,
             provider, provider_issuer, provider_tenant_kind,
             provider_tenant_id, provider_subject_id,
             verification_attempt_id, verification_evidence_sha256, status,
             verified_at, revoked_at, revocation_reason
           ) VALUES (
             'clm_forged', ?, ?, ?, 'slack', 'https://slack.com', 'workspace',
             'T_TEST', 'U_ATTACKER', 'cat_slack-human', ?, 'active', ?,
             NULL, NULL
           )`,
        )
        .run(
          IDS.organization,
          IDS.principal,
          IDS.membership,
          digest("verification-evidence:cat_slack-human"),
          TIME.completed,
        ),
    ).toThrow("does not match a completed connect attempt");

    insertIdentityLink(database);
    expect(() =>
      database
        .prepare(
          `UPDATE organization_external_identity_links
           SET membership_id = ?
           WHERE identity_link_id = ?`,
        )
        .run(IDS.otherMembership, IDS.identityLink),
    ).toThrow("external identity links may only be revoked");
    database.close();
  });

  it("supports the complete minimum Slack identity and approval grant flow", () => {
    const database = openOrganizationControlDatabase(":memory:");
    seedApprovalFlow(database);

    expect(effectivePermission(database)).toEqual({
      permission_grant_id: "pgr_zhen-approve",
    });
    expect(
      effectivePermission(database, {
        membershipId: IDS.otherMembership,
        providerSubjectId: "U_OTHER",
      }),
    ).toBeUndefined();
    expect(
      effectivePermission(database, {
        action: "reject",
      }),
    ).toBeUndefined();

    const connectionColumns = database
      .prepare("PRAGMA table_info(organization_tool_connections)")
      .all() as Array<{ name: string }>;
    expect(
      connectionColumns
        .map(({ name }) => name)
        .filter((name) => /token|credential|secret/i.test(name)),
    ).toEqual(["secret_backend_id", "secret_handle_id"]);

    expect(() =>
      database
        .prepare(
          `UPDATE organization_permission_grants
           SET status = 'revoked', revoked_at = ?,
               revocation_reason = 'organization admin revoked access'
           WHERE permission_grant_id = 'pgr_zhen-approve'`,
        )
        .run(TIME.revoked),
    ).not.toThrow();
    expect(effectivePermission(database)).toBeUndefined();
    database.close();
  });

  it("fails closed when a connection or binding is retired", () => {
    const database = openOrganizationControlDatabase(":memory:");
    seedApprovalFlow(database);
    database
      .prepare(
        `UPDATE organization_tool_connections
         SET status = 'revoked', revoked_at = ?,
             revocation_reason = 'customer disconnected Slack'
         WHERE connection_id = ?`,
      )
      .run(TIME.revoked, IDS.connection);
    expect(effectivePermission(database)).toBeUndefined();
    expect(() =>
      database
        .prepare(
          `INSERT INTO organization_adapter_bindings (
             adapter_binding_id, organization_id, product_namespace,
             installation_id, installation_key_id, adapter_kind, adapter_id,
             adapter_instance_id, adapter_version, connection_id,
             public_configuration_json, public_configuration_sha256, status,
             created_by_principal_id, created_by_membership_id, bound_at,
             revoked_at, revocation_reason
           ) VALUES (
             'bnd_after-revoke', ?, 'echo-brain', ?, ?,
             'approval-surface', 'slack-reactions', 'secondary', '1.0.0', ?,
             '{}', ?, 'active', ?, ?, ?, NULL, NULL
           )`,
        )
        .run(
          IDS.organization,
          IDS.installation,
          digest("installation-key"),
          IDS.connection,
          digest("empty-config"),
          IDS.principal,
          IDS.membership,
          TIME.revoked,
        ),
    ).toThrow("requires an active organization connection");
    database.close();
  });

  it("keeps audit append-only and permits fresh checks of one provider event", () => {
    const database = openOrganizationControlDatabase(":memory:");
    seedApprovalFlow(database);
    const firstEntry = digest("audit-entry-1");
    database
      .prepare(
        `INSERT INTO organization_integration_audit (
           audit_sequence, audit_event_id, previous_entry_sha256,
           entry_sha256, organization_id, occurred_at, actor_kind,
           actor_principal_id, actor_membership_id, actor_identity_link_id,
           actor_installation_id, command_id, provider_event_sha256, action,
           subject_kind, subject_id, membership_id, identity_link_id,
           connection_id, adapter_binding_id, permission_grant_id, outcome,
           reason_code, idempotency_key, authority_checked_at,
           authority_evidence_sha256, correlation_id, detail_json,
           detail_sha256
         ) VALUES (
           1, 'aud_approval-1', NULL, ?, ?, ?, 'provider_identity', ?, ?, ?,
           ?, 'cmd_approval-1', ?, 'approval.evaluate', 'candidate',
           'candidate-1', ?, ?, ?, ?, 'pgr_zhen-approve', 'allowed',
           'active_membership_and_direct_grant', 'slack-event-1', ?, ?,
           'corr-1', '{}', ?
         )`,
      )
      .run(
        firstEntry,
        IDS.organization,
        TIME.granted,
        IDS.principal,
        IDS.membership,
        IDS.identityLink,
        IDS.installation,
        digest("slack-event-1"),
        IDS.membership,
        IDS.identityLink,
        IDS.connection,
        IDS.binding,
        TIME.granted,
        digest("authority-evidence"),
        digest("empty-detail"),
      );

    database
      .prepare(
        `INSERT INTO organization_integration_audit (
             audit_sequence, audit_event_id, previous_entry_sha256,
             entry_sha256, organization_id, occurred_at, actor_kind,
             command_id, provider_event_sha256, action, subject_kind,
             subject_id, outcome, reason_code, idempotency_key,
             correlation_id, detail_json, detail_sha256
           ) VALUES (
             2, 'aud_replay', ?, ?, ?, ?, 'system', 'cmd_replay', ?,
             'approval.evaluate', 'candidate', 'candidate-1', 'denied',
             'provider_event_replay', 'slack-event-replay', 'corr-2', '{}', ?
           )`,
      )
      .run(
        firstEntry,
        digest("audit-entry-replay"),
        IDS.organization,
        TIME.revoked,
        digest("slack-event-1"),
        digest("empty-detail-2"),
      );
    expect(
      database
        .prepare(
          `SELECT count(*) AS count
           FROM organization_integration_audit
           WHERE provider_event_sha256 = ?`,
        )
        .get(digest("slack-event-1")),
    ).toEqual({ count: 2 });
    expect(() =>
      database
        .prepare(
          `UPDATE organization_integration_audit
           SET reason_code = 'rewritten'
           WHERE audit_sequence = 1`,
        )
        .run(),
    ).toThrow("organization integration audit is append-only");
    expect(() =>
      database
        .prepare(
          "DELETE FROM organization_integration_audit WHERE audit_sequence = 1",
        )
        .run(),
    ).toThrow("organization integration audit cannot be deleted");
    database.close();
  });
});
