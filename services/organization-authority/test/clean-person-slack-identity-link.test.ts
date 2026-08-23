import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { organizationSlackLinkChallengeCodeSha256 } from "@echo-brain/organization-api";
import type { SlackIntegrationProvider } from "@echo-brain/organization-control-plane";
import { describe, expect, it, vi } from "vitest";
import { applyOrganizationControlBaselineV1 } from "../../organization-control-plane/src/persistence/baseline.js";
import { SlackIntegrationProviderError } from "../../organization-control-plane/src/adapters/slack/slack-integration-provider.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import { ReadableSearchAuthorizationFence } from "../src/application/readable-search-authorization-fence.js";
import { createCleanPersonSlackIdentityLinkServiceV1 } from "../src/composition/clean-person-slack-identity-link.js";
import { connectCleanSlackV1 } from "../../organization-control-plane/src/persistence/sqlite-clean-slack-connection-v1.js";

const NOW = "2026-08-22T00:00:00.000Z";
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "lineage-00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
const CODE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_CODE = Buffer.alloc(32, 1).toString("base64url");
const TOKEN = "fake-slack-token";

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

function setup(
  options: {
    readonly afterObserve?: () => void;
    readonly authorization?: () => PersonAccessAuthorization;
    readonly postFailure?: unknown;
  } = {},
) {
  const database = new Database(":memory:");
  applyOrganizationControlBaselineV1(database);
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata
    (singleton, control_plane_id, organization_id, authority_id, authority_descriptor_sha256, created_at)
    VALUES (1, 'ocp_00000000-0000-4000-8000-000000000001', ?, ?, ?, ?)`,
    )
    .run(ORGANIZATION_ID, AUTHORITY_ID, canonicalSha256("authority"), NOW);
  const verifyConnection = vi.fn(async () => ({
    team_id: "T01",
    enterprise_id: null,
    bot_user_id: "U_BOT",
    bot_id: "B01",
    app_id: "A01",
    granted_scopes: [
      "channels:history",
      "channels:read",
      "chat:write",
      "reactions:read",
      "users:read",
    ],
    verification_evidence_sha256: canonicalSha256("connection"),
  }));
  const verifyChannel = vi.fn(async () => ({
    team_id: "T01",
    channel_id: "C123ABC",
    is_public_organization_channel: true,
    is_active: true,
    bot_membership_verified: true,
    bot_access_verified: true,
    verification_evidence_sha256: canonicalSha256("channel"),
  }));
  const secrets = {
    create: vi.fn(() => ({
      secret_backend_id: "authority-file-v1" as const,
      secret_handle_id: "sch_test",
    })),
    remove: vi.fn(),
  };
  const connection = connectCleanSlackV1({
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: LINEAGE_ID,
    connection_id: CONNECTION_ID,
    approval_channel_id: "C123ABC",
    slack_bot_token: TOKEN,
    database,
    secrets,
    verifier: { verifyConnection, verifyChannel },
    now: () => NOW,
  });
  const slack: SlackIntegrationProvider = {
    verifyConnection,
    verifyChannel,
    verifyHuman: vi.fn(),
    verifyReaction: vi.fn(),
    postIdentityLinkChallenge: vi.fn(async () => {
      if (options.postFailure !== undefined) throw options.postFailure;
      return {
        team_id: "T01",
        channel_id: "C123ABC",
        challenge_message_ts: "100.001",
      };
    }),
    observeIdentityLinkChallenge: vi.fn(async (_token, input) => {
      options.afterObserve?.();
      return {
        team_id: "T01",
        user_id: "U123PERSON",
        channel_id: "C123ABC",
        challenge_message_ts: input.challenge_message_ts,
        reply_message_ts: "100.002",
        verification_evidence_sha256: canonicalSha256("observed"),
      };
    }),
  };
  const slackTokenAccess = vi.fn(() => TOKEN);
  return connection.then(() => ({
    database,
    slack,
    slackTokenAccess,
    application: createCleanPersonSlackIdentityLinkServiceV1({
      database,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: LINEAGE_ID,
      approval_channel_id: "C123ABC",
      authentication: {
        authenticateAccess: vi.fn(
          options.authorization ?? (() => authorization),
        ),
      },
      membership_type: () => "owner",
      slack,
      slack_token_access: { readActiveSlackBotToken: slackTokenAccess },
      authorization_fence: new ReadableSearchAuthorizationFence(),
      now: () => NOW,
    }),
  }));
}

function beginRequest() {
  return {
    request_id: "psb_00000000-0000-4000-8000-000000000001",
    challenge_code_sha256: organizationSlackLinkChallengeCodeSha256(CODE),
  };
}

describe("clean Person Slack identity-link adapter", () => {
  it("preserves legacy provider unavailable mapping without loading it in the clean runtime", async () => {
    const context = await setup({
      postFailure: new SlackIntegrationProviderError(
        "temporary",
        "unavailable",
      ),
    });
    await expect(
      context.application.begin(beginRequest(), "bearer"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("authenticates a founder, persists the D2 challenge and completes the exact Slack proof", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    const result = await context.application.complete(
      {
        request_id: "psc_00000000-0000-4000-8000-000000000001",
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_message_ts: begun.challenge_message_ts,
        challenge_code: CODE,
      },
      "bearer",
    );
    expect(result).toMatchObject({
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_subject_id: "U123PERSON",
      identity_link_created: true,
    });
    expect(
      context.database
        .prepare("SELECT status FROM organization_person_slack_link_challenges")
        .get(),
    ).toEqual({ status: "completed" });
    expect(
      context.database
        .prepare(
          "SELECT current_status FROM organization_external_human_link_current",
        )
        .get(),
    ).toEqual({ current_status: "active" });
  });

  it("replays an exact completion without observing Slack again", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    const request = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
      challenge_code: CODE,
    };
    await context.application.complete(request, "bearer");
    await expect(
      context.application.complete(request, "bearer"),
    ).resolves.toMatchObject({ identity_link_created: true });
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("replays an exact begin without another Slack verify or challenge post", async () => {
    const context = await setup();
    const first = await context.application.begin(beginRequest(), "bearer");
    const verifiedConnections = vi.mocked(context.slack.verifyConnection).mock
      .calls.length;
    const verifiedChannels = vi.mocked(context.slack.verifyChannel).mock.calls
      .length;
    const tokenReads = context.slackTokenAccess.mock.calls.length;
    await expect(
      context.application.begin(beginRequest(), "bearer"),
    ).resolves.toEqual(first);
    expect(context.slack.verifyConnection).toHaveBeenCalledTimes(
      verifiedConnections,
    );
    expect(context.slack.verifyChannel).toHaveBeenCalledTimes(verifiedChannels);
    expect(context.slackTokenAccess).toHaveBeenCalledTimes(tokenReads);
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("expires a prior pending challenge for the same membership before beginning another", async () => {
    const context = await setup();
    const first = await context.application.begin(beginRequest(), "bearer");
    await context.application.begin(
      {
        ...beginRequest(),
        request_id: "psb_00000000-0000-4000-8000-000000000002",
        challenge_code_sha256:
          organizationSlackLinkChallengeCodeSha256(OTHER_CODE),
      },
      "bearer",
    );
    expect(
      context.database
        .prepare(
          "SELECT status FROM organization_person_slack_link_challenges WHERE challenge_attempt_id = ?",
        )
        .get(first.challenge_attempt_id),
    ).toEqual({ status: "expired" });
  });

  it("rejects a completion request ID reused for a different proof", async () => {
    const context = await setup();
    const first = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(
      {
        request_id: "psc_00000000-0000-4000-8000-000000000001",
        challenge_attempt_id: first.challenge_attempt_id,
        challenge_message_ts: first.challenge_message_ts,
        challenge_code: CODE,
      },
      "bearer",
    );
    const second = await context.application.begin(
      {
        ...beginRequest(),
        request_id: "psb_00000000-0000-4000-8000-000000000002",
        challenge_code_sha256:
          organizationSlackLinkChallengeCodeSha256(OTHER_CODE),
      },
      "bearer",
    );
    await expect(
      context.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000001",
          challenge_attempt_id: second.challenge_attempt_id,
          challenge_message_ts: second.challenge_message_ts,
          challenge_code: OTHER_CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("never reconstructs a completion replay against a rotated Slack tool", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    const request = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
      challenge_code: CODE,
    };
    await context.application.complete(request, "bearer");
    context.database
      .prepare(
        "UPDATE organization_tool_connection_current_state SET current_status = 'revoked'",
      )
      .run();
    await connectCleanSlackV1({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: LINEAGE_ID,
      connection_id: "con_00000000-0000-4000-8000-000000000002",
      approval_channel_id: "C123ABC",
      slack_bot_token: TOKEN,
      database: context.database,
      secrets: {
        create: vi.fn(() => ({
          secret_backend_id: "authority-file-v1" as const,
          secret_handle_id: "sch_rotated",
        })),
        remove: vi.fn(),
      },
      verifier: context.slack,
      now: () => NOW,
    });
    const observations = vi.mocked(context.slack.observeIdentityLinkChallenge)
      .mock.calls.length;
    await expect(
      context.application.begin(beginRequest(), "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      context.application.complete(request, "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(
      observations,
    );
  });

  it("rejects the wrong code and a different authenticated Person session", async () => {
    let currentAuthorization = authorization;
    const context = await setup({ authorization: () => currentAuthorization });
    const begun = await context.application.begin(beginRequest(), "bearer");
    await expect(
      context.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000001",
          challenge_attempt_id: begun.challenge_attempt_id,
          challenge_message_ts: begun.challenge_message_ts,
          challenge_code: OTHER_CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    currentAuthorization = {
      ...authorization,
      membership_id: "mem_00000000-0000-4000-8000-000000000002",
    };
    await expect(
      context.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000001",
          challenge_attempt_id: begun.challenge_attempt_id,
          challenge_message_ts: begun.challenge_message_ts,
          challenge_code: CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a Slack user already linked to another authenticated Person", async () => {
    let currentAuthorization = authorization;
    const context = await setup({ authorization: () => currentAuthorization });
    const first = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(
      {
        request_id: "psc_00000000-0000-4000-8000-000000000001",
        challenge_attempt_id: first.challenge_attempt_id,
        challenge_message_ts: first.challenge_message_ts,
        challenge_code: CODE,
      },
      "bearer",
    );
    currentAuthorization = {
      ...authorization,
      principal_id: "prn_00000000-0000-4000-8000-000000000002",
      membership_id: "mem_00000000-0000-4000-8000-000000000002",
      identity_binding_id: "oib_00000000-0000-4000-8000-000000000002",
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
    };
    const second = await context.application.begin(
      {
        ...beginRequest(),
        request_id: "psb_00000000-0000-4000-8000-000000000002",
        challenge_code_sha256:
          organizationSlackLinkChallengeCodeSha256(OTHER_CODE),
      },
      "bearer",
    );
    await expect(
      context.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000002",
          challenge_attempt_id: second.challenge_attempt_id,
          challenge_message_ts: second.challenge_message_ts,
          challenge_code: OTHER_CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires stale challenges and refuses a connection pointer changed during verification", async () => {
    let currentAuthorization = {
      ...authorization,
      checked_at: "2026-08-21T00:00:00.000Z",
    };
    const stale = await setup({ authorization: () => currentAuthorization });
    const begun = await stale.application.begin(beginRequest(), "bearer");
    currentAuthorization = authorization;
    await expect(
      stale.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000001",
          challenge_attempt_id: begun.challenge_attempt_id,
          challenge_message_ts: begun.challenge_message_ts,
          challenge_code: CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    let changedDatabase: Database.Database | undefined;
    const changed = await setup({
      afterObserve: () => {
        changedDatabase
          ?.prepare(
            "UPDATE organization_tool_connection_current_state SET current_status = 'revoked'",
          )
          .run();
      },
    });
    changedDatabase = changed.database;
    const second = await changed.application.begin(
      {
        ...beginRequest(),
        request_id: "psb_00000000-0000-4000-8000-000000000002",
        challenge_code_sha256:
          organizationSlackLinkChallengeCodeSha256(OTHER_CODE),
      },
      "bearer",
    );
    await expect(
      changed.application.complete(
        {
          request_id: "psc_00000000-0000-4000-8000-000000000002",
          challenge_attempt_id: second.challenge_attempt_id,
          challenge_message_ts: second.challenge_message_ts,
          challenge_code: OTHER_CODE,
        },
        "bearer",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
