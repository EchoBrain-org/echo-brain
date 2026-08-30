import { Buffer } from "node:buffer";
import { once } from "node:events";
import Database from "better-sqlite3";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/organization-api";
import type { SlackIdentityProviderV1 } from "@echo-brain/organization-control-plane/slack-external-identity-integration-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOrganizationControlBaselineV1 } from "../../../../../../organization-control-plane/src/persistence/baseline.js";
import { connectSlackConnectionV1 } from "../../../../../../organization-control-plane/src/persistence/sqlite-slack-connection-coordinator-v1.js";
import type { PersonAccessAuthorization } from "../../../../../src/application/person-identity-sessions.js";
import { ReadableSearchAuthorizationFence } from "../../../../../src/application/readable-search-authorization-fence.js";
import { createSqliteSlackPersonIdentityLinkWorkflowV1 } from "../../../../../src/composition/providers/slack/person-identity/sqlite-slack-person-identity-link-repository-v1.js";
import { createSlackExternalIdentityHttpApplicationV1 } from "../../../../../src/composition/providers/slack/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { createOrganizationAuthorityHttpServer } from "../../../../../src/presentation/organization-authority-http-server.js";

const NOW = "2026-08-22T00:00:00.000Z";
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "lineage-00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
const CODE = Buffer.alloc(32).toString("base64url");
const OTHER_CODE = Buffer.alloc(32, 1).toString("base64url");
const TOKEN = "test-slack-token";

const authorization: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: "owner",
  identity_binding_id: "oib_00000000-0000-4000-8000-000000000001",
  session_family_id: "psf_00000000-0000-4000-8000-000000000001",
  access_credential_sha256: canonicalSha256("access"),
  access_expires_at: "2026-08-23T00:00:00.000Z",
  hard_reauthentication_at: "2026-08-29T00:00:00.000Z",
  person_state_sha256: canonicalSha256("person"),
  session_state_sha256: canonicalSha256("session"),
  checked_at: NOW,
};

const databases: Database.Database[] = [];

function beginRequest(requestId = "psb_00000000-0000-4000-8000-000000000001") {
  return {
    request_id: requestId,
    challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(CODE),
  };
}

async function setup(
  currentAuthorization: () => PersonAccessAuthorization = () => authorization,
) {
  const database = new Database(":memory:");
  databases.push(database);
  applyOrganizationControlBaselineV1(database);
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata
       (singleton, control_plane_id, organization_id, authority_id,
        authority_descriptor_sha256, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ocp_00000000-0000-4000-8000-000000000001",
      ORGANIZATION_ID,
      AUTHORITY_ID,
      canonicalSha256("authority"),
      NOW,
    );

  const slack: SlackIdentityProviderV1 = {
    verifyConnection: vi.fn(async () => ({
      team_id: "T12345678",
      enterprise_id: null,
      bot_user_id: "U12345678",
      bot_id: "B12345678",
      app_id: "A12345678",
      granted_scopes: [
        "channels:history",
        "channels:read",
        "chat:write",
        "im:history",
        "im:write",
        "reactions:read",
        "users:read",
      ],
      verification_evidence_sha256: canonicalSha256("connection"),
    })),
    verifyChannel: vi.fn(async (_token, channelId) => ({
      team_id: "T12345678",
      channel_id: channelId,
      is_public_organization_channel: true,
      is_active: true,
      bot_membership_verified: true,
      bot_access_verified: true,
      verification_evidence_sha256: canonicalSha256("channel"),
    })),
    verifyHuman: vi.fn(async () => ({
      team_id: "T12345678",
      user_id: "U12345679",
      verification_evidence_sha256: canonicalSha256("human"),
    })),
    postIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      channel_id: input.channel_id,
      challenge_message_ts: "100.000001",
    })),
    observeIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      user_id: "U12345679",
      channel_id: input.channel_id,
      challenge_message_ts: input.challenge_message_ts,
      reply_message_ts: "100.000002",
      verification_evidence_sha256: canonicalSha256("observed"),
    })),
  };
  await connectSlackConnectionV1({
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: LINEAGE_ID,
    connection_id: CONNECTION_ID,
    approval_channel_id: "C12345678",
    slack_bot_token: TOKEN,
    database,
    secrets: {
      create: vi.fn(() => ({
        secret_backend_id: "authority-file-v1" as const,
        secret_handle_id: "sch_00000000-0000-4000-8000-000000000001",
      })),
      remove: vi.fn(),
    },
    verifier: slack,
    now: () => NOW,
  });

  return {
    database,
    slack,
    application: createSqliteSlackPersonIdentityLinkWorkflowV1({
      database,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: LINEAGE_ID,
      approval_channel_id: "C12345678",
      authentication: {
        authenticateAccess: vi.fn(currentAuthorization),
      },
      membership_type: () => "owner",
      slack,
      slack_token_access: { readActiveSlackBotToken: vi.fn(() => TOKEN) },
      authorization_fence: new ReadableSearchAuthorizationFence(),
      now: () => NOW,
    }),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Person Slack identity-link workflow", () => {
  it("posts a challenge, completes the exact proof, and replays completion without re-observing Slack", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    const completion = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
      challenge_code: CODE,
    };
    const completed = await context.application.complete(completion, "bearer");
    expect(completed).toMatchObject({
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_subject_id: "U12345679",
      identity_link_created: true,
    });
    await expect(context.application.complete(completion, "bearer")).resolves.toEqual(
      completed,
    );
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("denies a wrong code and a different authenticated Person session", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    const input = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
    };
    await expect(
      context.application.complete({ ...input, challenge_code: OTHER_CODE }, "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });

    current = {
      ...authorization,
      membership_id: "mem_00000000-0000-4000-8000-000000000002",
      identity_binding_id: "oib_00000000-0000-4000-8000-000000000002",
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
    };
    await expect(
      context.application.complete({ ...input, challenge_code: CODE }, "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("dispatches an authenticated begin through the configured clean HTTP server", async () => {
    const context = await setup();
    const server = createOrganizationAuthorityHttpServer({
      descriptor: {} as never,
      sessions: {} as never,
      oidc_provider: {} as never,
      expected_issuer: "https://issuer.example",
      person_external_identity_link:
        createSlackExternalIdentityHttpApplicationV1({
          service: context.application,
        }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("clean HTTP server did not bind TCP");
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/v2/integration-links/slack/challenges`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer bearer",
            "content-type": "application/json",
          },
          body: JSON.stringify(beginRequest()),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        provider: "slack",
        channel_id: "C12345678",
      });
      expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
