import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signMessage,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ORGANIZATION_API_PROXY_AUTH_SCHEME } from "@echo-brain/organization-api";
import {
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  type JsonObject,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationEnrollmentGrantSha256,
  validateOrganizationAuthorityDescriptor,
  verifyOrganizationAuthorityPin,
} from "@echo-brain/organization-protocol";
import {
  FileOrganizationSecretStore,
  openOrganizationControlDatabase,
} from "../../services/organization-control-plane/src/index.js";
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from "../../services/organization-authority/src/composition/operator-config.js";
import {
  activateOrganizationPermissionPilot,
  initializeDevelopmentAuthority,
} from "../../services/organization-authority/src/composition/operator-state.js";
import { OrganizationAdminApiClient } from "../../services/organization-authority/src/adapters/http/organization-admin-api-client.js";
import {
  startOrganizationAuthority,
  type RunningOrganizationAuthority,
} from "../../services/organization-authority/src/composition/runtime.js";
import {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from "../../services/organization-authority/src/presentation/trusted-proxy-client-identity.js";
import type { ApprovalRequest } from "@echo-brain/organization-authority/processing/core/index.js";
import { DecisionNodeStore } from "../../src/product/approval/decision-node-store.js";
import { OrganizationApprovalActionAuthorizer } from "../../src/product/organization/approval-action-authorizer.js";
import { HttpOrganizationAuthorityClient } from "../../src/product/organization/client/http-organization-authority-client.js";
import { LocalOrganizationCoordinator } from "../../src/product/organization/enrollment/local-organization-coordinator.js";
import { OrganizationRecentDecisionsReader } from "../../src/product/organization/recent-decisions-reader.js";
import {
  createOrganizationIngestExclusion,
  OrganizationRecordSubmitter,
  ProtocolOrganizationRecordEnvelopeBuilder,
} from "../../src/product/organization/record/index.js";
import { HttpOrganizationRecordClient } from "../../src/product/organization/client/http-organization-record-client.js";
import { SqliteOrganizationStateStore } from "../../src/product/organization/state/sqlite-organization-state-store.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "../../src/product/machine/security/installation-signer.js";

const roots: string[] = [];
const CLIENT_ID = `cid_${createHash("sha256").update("permission-pilot-acceptance").digest("base64url")}`;
const DECISION = "Adopt usage-based pricing.";
const TEAM = "T12345678";
const BOT_USER = "U12345679";
const REVIEWER = "U12345678";
const CHANNEL = "C12345678";
const MESSAGE_TS = "1721678400.123456";
const scopes =
  '["channels:history","channels:read","chat:write","reactions:read","users:read"]';
const toolConfig =
  '{"channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';
const bindingConfig =
  '{"approve_reaction":"white_check_mark","channel_id":"C12345678","organization_tool_profile":"slack-organization-tool-v1","reject_reaction":"x","schema_version":1,"slack_app_id":"A12345678","slack_bot_id":"B12345678","slack_bot_user_id":"U12345679","slack_enterprise_id":null}';

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const digest = (value: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function port(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        return reject(new Error("no test port"));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    }),
  );
}

class Signer implements InstallationSigner {
  private readonly pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  private readonly publicKey = this.pair.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  private descriptor: InstallationKeyDescriptor | null = null;
  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    this.descriptor ??= {
      installation_id: installationId,
      key_id: p256KeyId(this.publicKey),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: this.publicKey.toString("base64"),
      protection: "development-file",
      assurance: "software_key_development_only",
      private_key_exportable: true,
    };
    return structuredClone(this.descriptor);
  }
  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    return this.descriptor?.installation_id === installationId
      ? structuredClone(this.descriptor)
      : null;
  }
  async sign(
    installationId: string,
    bytes: Buffer,
    expected?: Sha256Digest,
  ): Promise<Buffer> {
    const key = await this.inspect(installationId);
    if (key === null || key.key_id !== expected)
      throw new Error("wrong installation key");
    return normalizeP256LowS(
      signMessage("sha256", bytes, {
        key: this.pair.privateKey,
        dsaEncoding: "der",
      }),
    );
  }
}

function approval(): ApprovalRequest {
  const meeting = "granola:meeting-1";
  return {
    processing_key:
      "granola:primary:meeting-1:rev-1:structured-text:default:1.0.0",
    requested_at: new Date().toISOString(),
    meeting: {
      schema_version: 1,
      id: meeting,
      title: "Pricing review",
      time: { actual_start_at: "2026-08-08T11:00:00.000Z" },
      capture: { state: "complete", components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: "meeting-source",
          adapter_id: "granola",
          instance_id: "primary",
          version: "1.0.0",
        },
        external_id: "meeting-1",
        canonical_revision: "rev-1",
        observed_at: "2026-08-08T11:30:00.000Z",
        normalizer_version: "1",
        source_updated_at: "2026-08-08T11:30:00.000Z",
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: meeting,
      meeting_revision: "rev-1",
      processor: {
        kind: "decision-processor",
        adapter_id: "structured-text",
        instance_id: "default",
        version: "1.0.0",
      },
      generated_at: "2026-08-08T12:00:00.000Z",
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: "brief-1",
      meeting: {
        id: meeting,
        title: "Pricing review",
        time: { actual_start_at: "2026-08-08T11:00:00.000Z" },
        participants: [],
      },
      decisions: [
        {
          id: "decision-1",
          kind: "decision",
          text: DECISION,
          subject: "pricing",
          confidence: 1,
          evidence: [{ meeting_id: meeting, block_id: "block-1" }],
          status: "decided",
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: "rev-1",
        processor: {
          kind: "decision-processor",
          adapter_id: "structured-text",
          instance_id: "default",
          version: "1.0.0",
        },
        generated_at: "2026-08-08T12:00:00.000Z",
      },
    },
  } as unknown as ApprovalRequest;
}

function seedSlack(
  database: Database.Database,
  input: {
    organizationId: string;
    installationId: string;
    installationKeyId: string;
    principalId: string;
    membershipId: string;
    now: string;
    secret: { secret_backend_id: string; secret_handle_id: string };
  },
): void {
  const exp = new Date(Date.parse(input.now) + 600_000).toISOString();
  const insertAttempt = (
    id: string,
    purpose: string,
    owner: string,
    principal: string | null,
    membership: string | null,
    subjectKind: string,
    subject: string,
  ) => {
    database
      .prepare(
        `INSERT INTO organization_connection_attempts (connection_attempt_id,organization_id,requested_by_principal_id,requested_by_membership_id,attempt_purpose,target_owner_kind,target_principal_id,target_membership_id,provider,provider_issuer,provider_tenant_kind,provider_tenant_id,redirect_uri,requested_scopes_json,requested_scopes_sha256,state_sha256,nonce_sha256,pkce_challenge_sha256,admin_session_sha256,status,provider_subject_kind,provider_subject_id,granted_scopes_json,granted_scopes_sha256,verification_evidence_sha256,created_at,expires_at,consumed_at,outcome_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.organizationId,
        input.principalId,
        input.membershipId,
        purpose,
        owner,
        principal,
        membership,
        "slack",
        "https://slack.com",
        "workspace",
        TEAM,
        "https://authority.invalid/callback",
        scopes,
        digest(scopes),
        digest(`${id}-state`),
        digest(`${id}-nonce`),
        digest(`${id}-pkce`),
        digest(`${id}-session`),
        "pending",
        null,
        null,
        null,
        null,
        null,
        input.now,
        exp,
        null,
        null,
      );
    database
      .prepare(
        `UPDATE organization_connection_attempts SET status='succeeded',provider_subject_kind=?,provider_subject_id=?,granted_scopes_json=?,granted_scopes_sha256=?,verification_evidence_sha256=?,consumed_at=? WHERE connection_attempt_id=?`,
      )
      .run(
        subjectKind,
        subject,
        scopes,
        digest(scopes),
        digest(`${id}-verified`),
        input.now,
        id,
      );
  };
  const identityAttempt = `cat_${randomUUID()}`;
  insertAttempt(
    identityAttempt,
    "identity_link",
    "membership",
    input.principalId,
    input.membershipId,
    "human_user",
    REVIEWER,
  );
  const identity = `clm_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO organization_external_identity_links (identity_link_id,organization_id,principal_id,membership_id,provider,provider_issuer,provider_tenant_kind,provider_tenant_id,provider_subject_id,verification_attempt_id,verification_evidence_sha256,status,verified_at,revoked_at,revocation_reason) VALUES (?,?,?,?,'slack','https://slack.com','workspace',?,?,? ,?,'active',?,NULL,NULL)`,
    )
    .run(
      identity,
      input.organizationId,
      input.principalId,
      input.membershipId,
      TEAM,
      REVIEWER,
      identityAttempt,
      digest(`${identityAttempt}-verified`),
      input.now,
    );
  const toolAttempt = `cat_${randomUUID()}`;
  insertAttempt(
    toolAttempt,
    "tool_connection",
    "organization",
    null,
    null,
    "service_account",
    BOT_USER,
  );
  const connection = `con_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO organization_tool_connections (connection_id,organization_id,connection_kind,owner_kind,owner_principal_id,owner_membership_id,human_identity_link_id,provider,provider_issuer,provider_tenant_kind,provider_tenant_id,provider_subject_kind,provider_subject_id,granted_scopes_json,granted_scopes_sha256,verification_attempt_id,verification_evidence_sha256,secret_backend_id,secret_handle_id,status,created_by_principal_id,created_by_membership_id,activated_at,revoked_at,revocation_reason,public_configuration_json,public_configuration_sha256) VALUES (?,?,'service_account','organization',NULL,NULL,NULL,'slack','https://slack.com','workspace',?,'service_account',?,?,?,?,?,?,?,'active',?,?,?,NULL,NULL,?,?)`,
    )
    .run(
      connection,
      input.organizationId,
      TEAM,
      BOT_USER,
      scopes,
      digest(scopes),
      toolAttempt,
      digest(`${toolAttempt}-verified`),
      input.secret.secret_backend_id,
      input.secret.secret_handle_id,
      input.principalId,
      input.membershipId,
      input.now,
      toolConfig,
      digest(toolConfig),
    );
  const binding = `bnd_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO organization_adapter_bindings (adapter_binding_id,organization_id,product_namespace,installation_id,installation_key_id,adapter_kind,adapter_id,adapter_instance_id,adapter_version,connection_id,public_configuration_json,public_configuration_sha256,status,created_by_principal_id,created_by_membership_id,bound_at,revoked_at,revocation_reason) VALUES (?,?, 'echo-brain',?,?,'approval-surface','slack-reactions','primary','1.0.0',?,?,?,'active',?,?,?,NULL,NULL)`,
    )
    .run(
      binding,
      input.organizationId,
      input.installationId,
      input.installationKeyId,
      connection,
      bindingConfig,
      digest(bindingConfig),
      input.principalId,
      input.membershipId,
      input.now,
    );
  database
    .prepare(
      `INSERT INTO organization_permission_grants (permission_grant_id,organization_id,adapter_binding_id,principal_id,membership_id,action,resource_scope_json,status,granted_by_principal_id,granted_by_membership_id,granted_at,revoked_at,revocation_reason) VALUES (?,?,?, ?,?,'approve','{}','active',?,?,?,NULL,NULL)`,
    )
    .run(
      `pgr_${randomUUID()}`,
      input.organizationId,
      binding,
      input.principalId,
      input.membershipId,
      input.principalId,
      input.membershipId,
      input.now,
    );
}

describe("permission-pilot full lifecycle", () => {
  it("proves a Slack-notice-qualified approval through ingest, restart, and signed member read", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "echo-permission-pilot-")),
    );
    roots.push(root);
    chmodSync(root, 0o700);
    const configPath = join(root, "authority.json");
    const stateDir = join(root, "state");
    await initializeDevelopmentAuthority({
      config_path: configPath,
      state_directory: stateDir,
      organization_display_name: "Example Company",
      port: await port(),
    });
    const config = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(configPath),
    );
    const nativeFetch = globalThis.fetch;
    const recentDecisionsHeaders: { value: Headers | null } = { value: null };
    const proxyFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(
        TRUSTED_PROXY_AUTHORIZATION_HEADER,
        `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${config.trusted_proxy_token}`,
      );
      headers.set(TRUSTED_PROXY_CLIENT_ID_HEADER, CLIENT_ID);
      const response = await nativeFetch(input, { ...init, headers });
      if (new URL(String(input)).pathname === "/v1/recent-decisions") {
        recentDecisionsHeaders.value = new Headers(response.headers);
      }
      return response;
    };
    let runtime: RunningOrganizationAuthority =
      await startOrganizationAuthority(config);
    const admin = new OrganizationAdminApiClient({
      base_url: `http://127.0.0.1:${runtime.address.port}/`,
      admin_token: config.admin_token,
      trusted_proxy_token: config.trusted_proxy_token,
      client_identity: CLIENT_ID,
    });
    const ada = await admin.provisionMembership({
      command_id: `adm_${randomUUID()}`,
      display_name: "Ada Founder",
      membership_type: "employee",
    });
    const bob = await admin.provisionMembership({
      command_id: `adm_${randomUUID()}`,
      display_name: "Bob Founder",
      membership_type: "employee",
    });
    const grant = Uint8Array.from(randomBytes(32));
    await admin.registerEnrollmentGrant(ada.membership_id, {
      command_id: `adm_${randomUUID()}`,
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(grant),
      lifetime_seconds: 3600,
    });
    const paths = authorityStatePaths(stateDir);
    const identity = JSON.parse(readFileSync(paths.identity_path, "utf8")) as {
      authority_descriptor: unknown;
      authority_pin_sha256: Sha256Digest;
    };
    const descriptor = validateOrganizationAuthorityDescriptor(
      identity.authority_descriptor,
    );
    const pinned = verifyOrganizationAuthorityPin(
      descriptor,
      identity.authority_pin_sha256,
    );
    const signer = new Signer();
    const installationId = `ins_${randomUUID()}`;
    let state = new SqliteOrganizationStateStore(join(root, "member.sqlite"));
    await new LocalOrganizationCoordinator({
      state,
      authorityClient: new HttpOrganizationAuthorityClient({
        baseUrl: `http://127.0.0.1:${runtime.address.port}/`,
        fetch: proxyFetch,
        allowInsecureLoopback: true,
      }),
      installationSigner: signer,
      maximumActiveLeaseTtlMs: config.active_lease_ttl_ms,
    }).enroll({
      authorityBaseUrl: `http://127.0.0.1:${runtime.address.port}`,
      authorityDescriptor: descriptor,
      independentlyTrustedAuthorityPin: identity.authority_pin_sha256,
      enrollmentGrant: grant,
      principalId: ada.principal_id,
      membershipId: ada.membership_id,
      installationId,
    });
    state.close();
    state = new SqliteOrganizationStateStore(join(root, "member.sqlite"));
    const bobGrant = Uint8Array.from(randomBytes(32));
    await admin.registerEnrollmentGrant(bob.membership_id, {
      command_id: `adm_${randomUUID()}`,
      enrollment_grant_sha256: organizationEnrollmentGrantSha256(bobGrant),
      lifetime_seconds: 3600,
    });
    const bobSigner = new Signer();
    const bobInstallationId = `ins_${randomUUID()}`;
    let bobState = new SqliteOrganizationStateStore(join(root, "bob.sqlite"));
    await new LocalOrganizationCoordinator({
      state: bobState,
      authorityClient: new HttpOrganizationAuthorityClient({
        baseUrl: `http://127.0.0.1:${runtime.address.port}/`,
        fetch: proxyFetch,
        allowInsecureLoopback: true,
      }),
      installationSigner: bobSigner,
      maximumActiveLeaseTtlMs: config.active_lease_ttl_ms,
    }).enroll({
      authorityBaseUrl: `http://127.0.0.1:${runtime.address.port}`,
      authorityDescriptor: descriptor,
      independentlyTrustedAuthorityPin: identity.authority_pin_sha256,
      enrollmentGrant: bobGrant,
      principalId: bob.principal_id,
      membershipId: bob.membership_id,
      installationId: bobInstallationId,
    });
    bobState.close();
    bobState = new SqliteOrganizationStateStore(join(root, "bob.sqlite"));
    await runtime.close();
    const activatedAt = new Date().toISOString();
    const commandPath = join(root, "pilot.json");
    const audience = [
      { membership_id: ada.membership_id, label: ada.display_name },
      { membership_id: bob.membership_id, label: bob.display_name },
    ].sort((left, right) =>
      left.membership_id.localeCompare(right.membership_id),
    );
    writeFileSync(
      commandPath,
      `${canonicalJson({ schema_version: 1, kind: "echo-organization-permission-pilot-activation-command", command_id: `ppa_${randomUUID()}`, authority_id: config.authority_id, organization_id: config.organization_id, policy_id: "pilot-member-readable-v1", presentation_policy_id: "pilot-two-person-audience-v1", audience, requested_at: activatedAt, reason: "Two-founder pilot" })}\n`,
      { mode: 0o600 },
    );
    chmodSync(commandPath, 0o600);
    const activation = await activateOrganizationPermissionPilot(
      configPath,
      commandPath,
      { now: () => activatedAt },
    );
    const secret = new FileOrganizationSecretStore(
      join(stateDir, "credentials", "integrations"),
    ).create("xoxb-test-token-12345678");
    const control = openOrganizationControlDatabase(
      config.integrations_database_path,
      { fileMustExist: true },
    );
    try {
      seedSlack(control, {
        organizationId: config.organization_id,
        installationId,
        installationKeyId: (await signer.inspect(installationId))!.key_id,
        principalId: ada.principal_id,
        membershipId: ada.membership_id,
        now: activatedAt,
        secret,
      });
    } finally {
      control.close();
    }
    const approvalIdHolder: { value: string } = { value: "" };
    globalThis.fetch = async (input) => {
      const method = new URL(String(input)).pathname.split("/").at(-1);
      const message = {
        type: "message",
        user: BOT_USER,
        bot_id: "B12345678",
        app_id: "A12345678",
        ts: MESSAGE_TS,
        text: activation.presentation_descriptor.fallback_text,
        blocks: [
          {
            type: "section",
            block_id: `echo-approval-${approvalIdHolder.value}-0`,
            text: { type: "mrkdwn", text: "Approve?" },
          },
          {
            type: "section",
            block_id: `echo-approval-${approvalIdHolder.value}-audience-v1`,
            text: {
              type: "plain_text",
              text: activation.presentation_descriptor.notice_text,
              emoji: false,
            },
          },
        ],
        reactions: [{ name: "white_check_mark", users: [REVIEWER], count: 1 }],
      };
      const value =
        method === "auth.test"
          ? {
              ok: true,
              team_id: TEAM,
              user_id: BOT_USER,
              bot_id: "B12345678",
              app_id: "A12345678",
            }
          : method === "bots.info"
            ? {
                ok: true,
                bot: {
                  id: "B12345678",
                  user_id: BOT_USER,
                  app_id: "A12345678",
                  deleted: false,
                },
              }
          : method === "users.info"
            ? {
                ok: true,
                user: {
                  id: REVIEWER,
                  team_id: TEAM,
                  deleted: false,
                  is_bot: false,
                  is_app_user: false,
                },
              }
            : { ok: true, message };
      return new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "content-length": String(JSON.stringify(value).length),
          ...(method === "auth.test"
            ? {
                "x-oauth-scopes":
                  "channels:history,channels:read,chat:write,reactions:read,users:read",
              }
            : {}),
        },
      });
    };
    try {
      runtime = await startOrganizationAuthority(config);
    } finally {
      globalThis.fetch = nativeFetch;
    }
    try {
      const nodes = new DecisionNodeStore(join(root, "member"));
      const requested = await nodes.ensureRequested(approval());
      approvalIdHolder.value = requested.approval_id;
      const authority = new HttpOrganizationAuthorityClient({
        baseUrl: `http://127.0.0.1:${runtime.address.port}/`,
        fetch: proxyFetch,
        allowInsecureLoopback: true,
      });
      const authorized = await new OrganizationApprovalActionAuthorizer({
        openState: () =>
          new SqliteOrganizationStateStore(join(root, "member.sqlite")),
        authorityClient: authority,
        installationSigner: signer,
        now: () => new Date().toISOString(),
      }).authorize({
        approval_id: requested.approval_id,
        action: "approve",
        adapter_identity: {
          kind: "approval-surface",
          adapter_id: "slack-reactions",
          instance_id: "primary",
          version: "1.0.0",
        },
        provider_identity: {
          provider: "slack",
          team_id: TEAM,
          enterprise_id: null,
          bot_user_id: BOT_USER,
          bot_id: "B12345678",
          app_id: "A12345678",
        },
        actor: { provider: "slack", team_id: TEAM, user_id: REVIEWER },
        channel_id: CHANNEL,
        message_ts: MESSAGE_TS,
        reaction_name: "white_check_mark",
      });
      expect(authorized).toMatchObject({
        allowed: true,
        evidence: {
          reason_code: "active_membership_direct_grant_pilot_notice_v1",
        },
      });
      if (!authorized.allowed) throw new Error("permission check denied");
      await nodes.resolve({
        approvalId: requested.approval_id,
        status: "approved",
        reviewedBy: "Ada Founder",
        surface: "slack-reactions",
        metadata: JSON.parse(
          canonicalJson({ authorization: authorized.evidence }),
        ) as JsonObject,
      });
      const key = state.readEnrollment()!.request.installation_signing_key;
      const submitter = new OrganizationRecordSubmitter({
        nodes,
        envelopes: new ProtocolOrganizationRecordEnvelopeBuilder({
          pinnedAuthority: pinned,
          installationSigningKey: key,
          sign: (bytes) => signer.sign(installationId, bytes, key.key_id),
        }),
        client: new HttpOrganizationRecordClient({
          baseUrl: `http://127.0.0.1:${runtime.address.port}/`,
          pinnedAuthority: pinned,
          installationSigningKey: key,
          fetch: proxyFetch,
          allowInsecureLoopback: true,
        }),
        installationId,
        exclusion: createOrganizationIngestExclusion({
          sources: [],
          meetings: [],
        }),
        now: () => new Date().toISOString(),
      });
      const sweep = await submitter.sweep();
      expect(sweep.alerts).toEqual([]);
      expect(sweep).toMatchObject({ ok: true, published: 1 });
      await runtime.close();
      runtime = await startOrganizationAuthority(config);
      const restartedBaseUrl = `http://${runtime.address.address}:${runtime.address.port}/`;
      await Promise.race([
        runtime.fatalFailure.then((failure) => {
          throw failure;
        }),
        new Promise((resolve) => setTimeout(resolve, 10)),
      ]);
      const probe = await nativeFetch(restartedBaseUrl).catch((error) => {
        throw new Error(
          `restarted listener ${restartedBaseUrl} is unavailable: ${(error as Error).message}`,
        );
      });
      expect(probe.status).toBe(403);
      const read = await new OrganizationRecentDecisionsReader({
        state: bobState,
        authorityClient: new HttpOrganizationAuthorityClient({
          baseUrl: restartedBaseUrl,
          fetch: proxyFetch,
          allowInsecureLoopback: true,
        }),
        installationSigner: bobSigner,
        now: () => new Date().toISOString(),
      }).read();
      expect(read).toMatchObject({
        schema_version: 1,
        policy_id: "pilot-member-readable-v1",
      });
      expect(read.items).toHaveLength(1);
      expect(read.items[0]?.text).toBe(DECISION);
      expect(recentDecisionsHeaders.value?.get("cache-control")).toBe(
        "no-store",
      );
      const persistedResponses = new Database(join(root, "bob.sqlite"))
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE '%recent%decision%'`,
        )
        .all();
      expect(persistedResponses).toEqual([]);
    } finally {
      state.close();
      bobState.close();
      await runtime.close();
    }
  });
});
