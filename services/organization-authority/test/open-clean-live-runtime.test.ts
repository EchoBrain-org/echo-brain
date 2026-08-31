import { createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  openOrganizationControlDatabase,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
} from "../../organization-control-plane/src/application/person-slack-approval-contracts-v2.js";
import { openOrganizationRecordDatabase } from "@echo-brain/organization-record/new-lineage-v1";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BegunPersonOidcLogin,
  PersonAccessAuthorization,
} from "../src/application/person-identity-sessions.js";
import { PersonIdentitySessionApplication } from "../src/application/person-identity-sessions.js";
import { SqliteCleanPersonAnswerCompositionAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-answer-composition-audit-v1.js";
import { SqliteCleanPersonSessionRepository } from "../src/adapters/persistence/sqlite/clean-person-session-repository.js";
import { SqliteCleanPersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../src/adapters/security/node-person-session-crypto.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../src/adapters/security/private-file-credentials.js";
import { SystemAuthorityClock } from "../src/adapters/runtime/system-runtime-ports.js";
import { admitCleanGranolaSource } from "../src/composition/clean-granola-source-admission.js";
import {
  initializeCleanPersonCredentials,
  issueCleanPersonInvitation,
} from "../src/composition/clean-person-onboarding.js";
import {
  openCleanLiveRuntime,
  type OpenCleanLiveRuntimeConfig,
} from "../src/composition/open-clean-live-runtime.js";
import { cleanReadableSearchRuntimeContractV1 } from "../src/composition/clean-readable-search-runtime.js";
import { createCleanPersonAnswerRouteV1 } from "../src/composition/clean-person-answer-route.js";
import { createCleanPersonRecordSearchRouteV1 } from "../src/composition/clean-person-record-search-route.js";
import type { Layer4StructuredOutputPort } from "../src/answer-composition/lean-answer-composition.js";
import {
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1,
  privateApprovalBlockKitActionIdV1,
} from "../src/composition/private-approval-block-kit-card-v1.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import type {
  AdapterHealth,
  DecisionProcessorAdapter,
  DecisionSet,
  MeetingDocument,
  MeetingSourceAdapter,
} from "../src/processing/core/index.js";
import { createGranolaLiveOnlyCursor } from "../src/processing/adapters/meeting-sources/granola/index.js";
import type {
  PrivateSlackApprovalCardPresentationV1,
  PrivateSlackApprovalPostOutcomeV1,
  PrivateSlackApprovalTerminalPresentationV1,
  PrivateSlackApprovalUpdateOutcomeV1,
} from "../src/processing/clean-v1/private-slack-approval-card-poster-v1.js";

const roots: string[] = [];
let testAuthorizationCheck = 0;
const NOW = "2026-08-22T12:00:00.000Z";
const SLACK_WORKSPACE = "T012LIVETEST";
const SLACK_APP = "A012LIVETEST";
const SLACK_BOT = "B012LIVETEST";
const SLACK_BOT_USER = "U012LIVEBOT";
const SLACK_OWNER = "U012FOUNDER";
const SLACK_DM_CHANNEL = "D012LIVETEST";
const SLACK_SIGNING_SECRET = "test-slack-signing-secret-000000000";
const PRIVATE_SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "im:history",
  "im:write",
  "reactions:read",
  "users:read",
] as const;
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-open-clean-live-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test port did not resolve");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function privateFile(parent: string, name: string, value: string): string {
  const path = join(parent, name);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

class FounderOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private attempt: BegunPersonOidcLogin | undefined;
  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.attempt = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }
  async redeemAuthorizationCode() {
    if (this.attempt === undefined)
      throw new Error("OIDC begin was not called");
    return {
      kind: "verified" as const,
      token: {
        issuer: OIDC.issuer,
        subject: "founder-subject",
        audience: OIDC.client_id,
        nonce: this.attempt.nonce,
        issued_at: Math.floor(Date.now() / 1_000),
        claims: { email: "founder@example.com", email_verified: true },
      },
    };
  }
}

async function completeFounderReonboarding(input: {
  readonly state_directory: string;
  readonly parent: string;
  readonly owner_membership_id: string;
}): Promise<string> {
  const credentials = initializeCleanPersonCredentials({
    state_directory: input.state_directory,
  });
  const pkce = credentials.pkce_sealing_key_reference.slice("file:".length);
  const invitations = join(input.parent, "invitations");
  mkdirSync(invitations, { mode: 0o700 });
  chmodSync(invitations, 0o700);
  const invitationPath = join(invitations, "founder.invitation.json");
  issueCleanPersonInvitation({
    state_directory: input.state_directory,
    oidc: OIDC,
    pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
      credentials.pkce_sealing_key_reference,
    ),
    membership_id: input.owner_membership_id,
    expected_email: "founder@example.com",
    authority_url: "https://authority.example",
    output_path: invitationPath,
  });
  const invitation = JSON.parse(readFileSync(invitationPath, "utf8")) as {
    login_grant: string;
  };
  const authority = openAuthorityDatabase(
    join(input.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  try {
    const provider = new FounderOidcProvider();
    const crypto = new NodePersonSessionCrypto(
      readPrivateAuthorityPersonSessionPkceKey(
        credentials.pkce_sealing_key_reference,
      ),
    );
    const sessions = new PersonIdentitySessionApplication(
      new SqliteCleanPersonSessionRepository(authority),
      OIDC,
      {
        clock: new SystemAuthorityClock(),
        random: crypto,
        hash: crypto,
        pkce_sealer: crypto,
        oidc_provider: provider,
      },
    );
    const begun = sessions.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: invitation.login_grant,
    });
    provider.buildAuthorizationUrl(begun);
    await sessions.completeOidcLogin({
      state: begun.state,
      authorization_code: "founder-code",
    });
  } finally {
    authority.close();
  }
  return pkce;
}

/** Seed only the connection and verified owner identity needed for a private DM. */
function seedPrivateSlackConnection(input: {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}): void {
  const control = openOrganizationControlDatabase(
    join(input.state_directory, "integrations.sqlite"),
    { fileMustExist: true },
  );
  try {
    const coordinates = {
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
    };
    const connection = buildOrganizationToolConnectionContractV2({
      ...coordinates,
      connection_id: "con_live_test",
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: SLACK_WORKSPACE,
      provider_enterprise_id: null,
      tool_kind: "slack",
      provider_app_id: SLACK_APP,
      provider_bot_id: SLACK_BOT,
      provider_bot_user_id: SLACK_BOT_USER,
      required_provider_scopes: PRIVATE_SLACK_SCOPES,
      public_connection_configuration_sha256: canonicalSha256({ kind: "test" }),
    });
    const connectionSha = canonicalSha256(connection);
    const state = buildOrganizationToolConnectionStateV2({
      connection_id: connection.connection_id,
      connection_contract_sha256: connectionSha,
      connection_status: "active",
      credential_reference_sha256: canonicalSha256({ kind: "test-token" }),
      observed_granted_scopes: PRIVATE_SLACK_SCOPES,
      verification_event_id: "verify_live_test",
      verification_evidence_sha256: canonicalSha256({ kind: "verification" }),
      verification_revision: 1,
      verified_at: NOW,
    });
    const stateSha = canonicalSha256(state);
    control
      .prepare(
        "INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?, ?)",
      )
      .run(
        connection.connection_id,
        canonicalJson(connection),
        connectionSha,
        NOW,
      );
    control
      .prepare(
        "INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, 'active', ?)",
      )
      .run(
        connection.connection_id,
        connectionSha,
        canonicalJson(state),
        stateSha,
        NOW,
      );
    const link = buildExternalHumanIdentityLinkContractV2({
      ...coordinates,
      external_identity_link_id: "clm_live_test",
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: SLACK_WORKSPACE,
      provider_enterprise_id: null,
      provider_subject_id: SLACK_OWNER,
      principal_id: input.principal_id,
      membership_id: input.membership_id,
      membership_type: "owner",
      verification_event_id: "verify_founder_link",
      verification_evidence_sha256: canonicalSha256({ kind: "founder-link" }),
      verified_at: NOW,
    });
    const linkSha = canonicalSha256(link);
    control
      .prepare(
        "INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)",
      )
      .run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
    control
      .prepare(
        "INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
      )
      .run(
        link.external_identity_link_id,
        linkSha,
        link.provider_issuer,
        link.provider_tenant_kind,
        link.provider_tenant_id,
        link.provider_enterprise_id,
        link.provider_subject_id,
        link.principal_id,
        link.membership_id,
        NOW,
      );
  } finally {
    control.close();
  }
}

const healthy = (): AdapterHealth => ({ status: "healthy", checked_at: NOW });

function fakeSource(
  identity: MeetingSourceAdapter["identity"],
): MeetingSourceAdapter & { readonly pulls: () => number } {
  let pulls = 0;
  const meeting: MeetingDocument = {
    schema_version: 1,
    id: "granola:founder-granola:note-live-test",
    title: "Live migration review",
    provenance: {
      source: identity,
      external_id: "note-live-test",
      canonical_revision: canonicalSha256({ note: "live-test" }),
      observed_at: NOW,
      normalizer_version: identity.version,
    },
    capture: { state: "complete", components: [] },
    participants: [],
    content: [
      {
        id: "note-live-test",
        kind: "note",
        text: "Ship the clean live migration.",
      },
    ],
    artifacts: [],
    extensions: {
      granola: {
        calendar_event: null,
        owner: { email: "founder@example.com" },
      },
    },
  };
  return {
    identity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    pull: async (request) => {
      pulls += 1;
      return pulls === 1
        ? {
            meetings: [meeting],
            next_cursor: createGranolaLiveOnlyCursor(
              "2026-08-22T12:00:01.000Z",
            ),
          }
        : { meetings: [], next_cursor: request.cursor };
    },
    pulls: () => pulls,
  };
}

function fakeProcessor(
  identity: DecisionProcessorAdapter["identity"],
): DecisionProcessorAdapter {
  return {
    identity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    extract: async (meeting): Promise<DecisionSet> => ({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: identity,
      generated_at: NOW,
      signals: [
        {
          id: "decision-live-test",
          kind: "decision",
          status: "decided",
          text: meeting.content[0]?.text ?? "Ship the clean live migration.",
          subject: null,
          confidence: 1,
          evidence: [
            {
              meeting_id: meeting.id,
              block_id: meeting.content[0]?.id ?? "note-live-test",
            },
          ],
        },
      ],
    }),
  };
}

type PublishedCard = {
  readonly approval_id: string;
  readonly dm_channel_id: string;
  readonly provider_message_ts: string;
  readonly card: PrivateSlackApprovalCardPresentationV1;
};

/** Provider-free structural seam. It retains only private delivery inputs. */
class FakePrivateApprovalPoster {
  readonly markers: Array<{
    readonly approval_id: string;
    readonly dm_channel_id: string;
  }> = [];
  readonly published: PublishedCard[] = [];
  readonly terminal: Array<
    PrivateSlackApprovalTerminalPresentationV1 & {
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
    }
  > = [];
  readonly tombstones: string[] = [];
  async openDirectMessage(providerSubjectId: string) {
    expect(providerSubjectId).toBe(SLACK_OWNER);
    return {
      kind: "opened" as const,
      channel_id: SLACK_DM_CHANNEL,
      user_id: SLACK_OWNER,
    };
  }
  async postMarker(input: {
    readonly approval_id: string;
    readonly dm_channel_id: string;
  }): Promise<PrivateSlackApprovalPostOutcomeV1> {
    this.markers.push(input);
    return {
      kind: "posted",
      provider_message_ts: `1724112000.${String(this.markers.length).padStart(6, "0")}`,
    };
  }
  async reconcileMarker(): Promise<PrivateSlackApprovalPostOutcomeV1> {
    return { kind: "uncertain" };
  }
  async publish(
    input: PublishedCard,
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    this.published.push(input);
    return { kind: "done" };
  }
  async renderTerminal(
    input: PrivateSlackApprovalTerminalPresentationV1 & {
      readonly dm_channel_id: string;
      readonly provider_message_ts: string;
    },
  ): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    this.terminal.push(input);
    return { kind: "done" };
  }
  async tombstone(input: {
    readonly approval_id: string;
  }): Promise<PrivateSlackApprovalUpdateOutcomeV1> {
    this.tombstones.push(input.approval_id);
    return { kind: "done" };
  }
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function activeFixture() {
  const parent = root();
  const initialized = initializeCleanResetState({
    state_directory: join(parent, "state"),
    organization_display_name: "Founder Organization",
    owner_display_name: "Founder",
    created_at: "2026-08-22T11:00:00.000Z",
    creating_artifact_revision: "open-clean-live-runtime-test",
  });
  const pkce_key_file = await completeFounderReonboarding({
    state_directory: initialized.state_directory,
    parent,
    owner_membership_id: initialized.owner_membership_id,
  });
  const granola_credential_file = privateFile(
    parent,
    "granola.key",
    `grn_${"a".repeat(32)}`,
  );
  const granola_owner_email_file = privateFile(
    parent,
    "granola-owner-email",
    "founder@example.com",
  );
  const llm_credential_file = privateFile(
    parent,
    "llm.key",
    "llm-private-credential-material-000000",
  );
  const slack_signing_secret_file = privateFile(
    parent,
    "slack-signing-secret",
    SLACK_SIGNING_SECRET,
  );
  const admitted = await admitCleanGranolaSource({
    state_directory: initialized.state_directory,
    source_instance_id: "founder-granola",
    processor_instance_id: "founder-llm",
    granola_credential_reference: `file:${granola_credential_file}`,
    granola_owner_email_reference: `file:${granola_owner_email_file}`,
    llm_credential_reference: `file:${llm_credential_file}`,
    create_granola_record_owner_client: () => ({
      async listNotes() {
        return {
          notes: [
            { id: "preflight-only", owner: { email: "founder@example.com" } },
          ],
          hasMore: false,
          cursor: null,
        };
      },
    }),
    now: () => NOW,
  });
  seedPrivateSlackConnection({
    state_directory: initialized.state_directory,
    authority_id: initialized.authority_id,
    organization_id: initialized.organization_id,
    state_lineage_id: initialized.state_lineage_id,
    principal_id: initialized.owner_principal_id,
    membership_id: initialized.owner_membership_id,
  });
  const source = fakeSource({
    kind: "meeting-source",
    adapter_id: "granola",
    instance_id: admitted.source.instance_id,
    version: admitted.source.version,
  });
  const poster = new FakePrivateApprovalPoster();
  const errors: Error[] = [];
  const config: OpenCleanLiveRuntimeConfig = {
    state_directory: initialized.state_directory,
    host: "127.0.0.1",
    port: await availablePort(),
    authority_url: "https://authority.example",
    oidc: OIDC,
    client_authentication: { method: "none" },
    pkce_key_file,
    slack_signing_secret_file,
    slack_connection_id: "con_live_test",
    // Identity-link onboarding still uses this field. Delivery never does.
    slack_approval_channel_id: "C0123456789",
    granola_credential_file,
    granola_owner_email_file,
    llm_credential_file,
    worker_interval_ms: 10,
    on_worker_error: (error) => errors.push(error),
  };
  const processorIdentity = {
    kind: "decision-processor" as const,
    adapter_id: "llm",
    instance_id: admitted.processor.instance_id,
    version: admitted.processor.version,
  };
  const runtime = await openCleanLiveRuntime(config, {
    live_adapters: {
      source,
      processor: fakeProcessor(processorIdentity),
      private_approval_card_poster: poster,
    },
  });
  return {
    initialized,
    config,
    source,
    processorIdentity,
    poster,
    errors,
    runtime,
  };
}

function cardParts(card: PublishedCard["card"]) {
  const blocks = card.blocks as ReadonlyArray<Record<string, unknown>>;
  const policy = blocks.find(
    (block) =>
      block.type === "input" && String(block.block_id).endsWith("-policy-v1"),
  );
  const comment = blocks.find(
    (block) =>
      block.type === "input" && String(block.block_id).endsWith("-comment-v1"),
  );
  const actions = blocks.find((block) => block.type === "actions");
  if (policy === undefined || comment === undefined || actions === undefined)
    throw new Error("published private approval card is incomplete");
  const policyElement = policy.element as Record<string, unknown>;
  const commentElement = comment.element as Record<string, unknown>;
  const elements = actions.elements as ReadonlyArray<Record<string, unknown>>;
  const identity = JSON.parse(String(elements[0]?.value)) as {
    readonly approval_id: string;
  };
  const approve = elements.find(
    (element) =>
      element.action_id ===
      privateApprovalBlockKitActionIdV1(
        identity,
        PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
      ),
  );
  const reject = elements.find(
    (element) =>
      element.action_id ===
      privateApprovalBlockKitActionIdV1(
        identity,
        PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.reject,
      ),
  );
  if (approve === undefined || reject === undefined)
    throw new Error("published card has no terminal buttons");
  return {
    policy,
    comment,
    actions,
    policyElement,
    commentElement,
    approve,
    reject,
  };
}

/** Signs and posts an exact form-encoded Slack block_actions request. */
async function clickCard(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly card: PublishedCard;
  readonly action: "approve" | "reject";
  readonly policy_id:
    | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
    | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
  readonly comment?: string;
  readonly request_timestamp?: string;
}): Promise<Response> {
  const parts = cardParts(input.card.card);
  const terminal = input.action === "approve" ? parts.approve : parts.reject;
  const trigger_id = "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD";
  const action_ts = "1712345680.123456";
  const payload = {
    type: "block_actions",
    user: { id: SLACK_OWNER, team_id: SLACK_WORKSPACE },
    api_app_id: SLACK_APP,
    trigger_id,
    container: {
      type: "message",
      channel_id: input.card.dm_channel_id,
      message_ts: input.card.provider_message_ts,
      is_ephemeral: false,
    },
    team: { id: SLACK_WORKSPACE, domain: "echo" },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: input.card.dm_channel_id, name: "directmessage" },
    message: {
      type: "message",
      user: SLACK_BOT_USER,
      ts: input.card.provider_message_ts,
      app_id: SLACK_APP,
      bot_id: SLACK_BOT,
      blocks: input.card.card.blocks,
    },
    state: {
      values: {
        [parts.policy.block_id as string]: {
          [parts.policyElement.action_id as string]: {
            type: "radio_buttons",
            selected_option: {
              text: {
                type: "plain_text",
                text:
                  input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID
                    ? "Only me"
                    : "Team",
                emoji: false,
              },
              value: input.policy_id,
            },
          },
        },
        [parts.comment.block_id as string]: {
          [parts.commentElement.action_id as string]: {
            type: "plain_text_input",
            // Slack sends null, rather than an empty string, when an optional
            // plain-text input is untouched.
            value: input.comment ?? null,
          },
        },
      },
    },
    actions: [
      {
        type: "button",
        action_id: terminal.action_id,
        block_id: parts.actions.block_id,
        value: terminal.value,
        action_ts,
      },
    ],
  };
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const timestamp =
    input.request_timestamp ?? String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest("hex");
  return fetch(
    `http://127.0.0.1:${String(input.fixture.runtime.address.port)}/v2/integrations/slack/interactions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
      body,
    },
  );
}

function readerAuthorization(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}): PersonAccessAuthorization {
  return {
    organization_id: input.fixture.initialized.organization_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    membership_type: input.membership_type,
    identity_binding_id: `identity-${input.principal_id}`,
    session_family_id: `session-${input.membership_id}`,
    access_credential_sha256: canonicalSha256({
      kind: "test-access",
      membership_id: input.membership_id,
    }),
    access_expires_at: "2026-08-22T13:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T14:00:00.000Z",
    person_state_sha256: canonicalSha256({
      kind: "test-person",
      membership_id: input.membership_id,
    }),
    session_state_sha256: canonicalSha256({
      kind: "test-session",
      membership_id: input.membership_id,
    }),
    checked_at: NOW,
  };
}

/**
 * Exercise the composed Person retrieval route against the generation the
 * live runtime actually published. The tokens are only a test seam: the
 * reader tuples are still derived by the route's sessions port, never passed
 * into the retrieval API itself.
 */
function createOwnerAndMemberSearchRoute(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly authority: ReturnType<typeof openAuthorityDatabase>;
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
}) {
  const owner = readerAuthorization({
    fixture: input.fixture,
    principal_id: input.fixture.initialized.owner_principal_id,
    membership_id: input.fixture.initialized.owner_membership_id,
    membership_type: "owner",
  });
  const member = readerAuthorization({
    fixture: input.fixture,
    principal_id: "principal_active_member",
    membership_id: "membership_active_member",
    membership_type: "employee",
  });
  const byToken = new Map([
    ["owner", owner],
    ["member", member],
  ]);
  const route = createCleanPersonRecordSearchRouteV1({
    state_directory: input.fixture.initialized.state_directory,
    authority_id: input.fixture.initialized.authority_id,
    organization_id: input.fixture.initialized.organization_id,
    state_lineage_id: input.fixture.initialized.state_lineage_id,
    retrieval_contract_sha256:
      cleanReadableSearchRuntimeContractV1().retrieval_contract_sha256,
    sessions: {
      authenticateAccess: ({ access_token }) => {
        const authorization = byToken.get(access_token);
        if (authorization === undefined) throw new Error("unknown test bearer");
        // The compact audit intentionally deduplicates identical observations.
        // A real session verifier supplies a fresh check time for each request.
        testAuthorizationCheck += 1;
        return {
          ...authorization,
          checked_at: `2026-08-22T12:00:00.${String(testAuthorizationCheck).padStart(3, "0")}Z`,
        };
      },
    },
    authority: input.authority,
    record: input.record,
    audit: new SqliteCleanPersonRecordReadAuditV1(input.authority),
  });
  return route;
}

function answerModel(): Layer4StructuredOutputPort {
  return {
    async generate(input) {
      const properties = input.schema.properties as
        | Record<string, unknown>
        | undefined;
      if (properties !== undefined && Object.hasOwn(properties, "queries")) {
        return { queries: [] };
      }
      return {
        status: "answered",
        answer: "Ship the clean live migration.",
        citations: ["a1"],
      };
    },
  };
}

function createAnswerRoute(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly authority: ReturnType<typeof openAuthorityDatabase>;
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
}) {
  return createCleanPersonAnswerRouteV1({
    authority_id: input.fixture.initialized.authority_id,
    organization_id: input.fixture.initialized.organization_id,
    state_lineage_id: input.fixture.initialized.state_lineage_id,
    search: createOwnerAndMemberSearchRoute(input),
    model: answerModel(),
    audit: new SqliteCleanPersonAnswerCompositionAuditV1(input.authority),
  });
}

async function answerAsOwnerAndMember(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly authority: ReturnType<typeof openAuthorityDatabase>;
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
}) {
  const answers = createAnswerRoute(input);
  return {
    owner: await answers.ask({
      access_token: "owner",
      question: "What decision was made about the migration?",
    }),
    member: await answers.ask({
      access_token: "member",
      question: "What decision was made about the migration?",
    }),
  };
}

async function answerAsOwner(input: {
  readonly fixture: Awaited<ReturnType<typeof activeFixture>>;
  readonly authority: ReturnType<typeof openAuthorityDatabase>;
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
}) {
  const answers = createAnswerRoute(input);
  return answers.ask({
    access_token: "owner",
    question: "What decision was made about the migration?",
  });
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("open clean live runtime private approval lane", () => {
  it("starts the Person server before finalize without reading provider credentials", async () => {
    const parent = root();
    const initialized = initializeCleanResetState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: NOW,
      creating_artifact_revision: "open-clean-live-runtime-test",
    });
    const credentials = initializeCleanPersonCredentials({
      state_directory: initialized.state_directory,
    });
    const runtime = await openCleanLiveRuntime({
      state_directory: initialized.state_directory,
      host: "127.0.0.1",
      port: await availablePort(),
      authority_url: "https://authority.example",
      oidc: { ...OIDC, issuer: "https://issuer.invalid" },
      client_authentication: { method: "none" },
      pkce_key_file: credentials.pkce_sealing_key_reference.slice(
        "file:".length,
      ),
      slack_signing_secret_file: join(parent, "not-read-slack-signing-secret"),
      slack_connection_id: "con_not_read",
      slack_approval_channel_id: "C0123456789",
      granola_credential_file: join(parent, "not-read-granola"),
      granola_owner_email_file: join(parent, "not-read-owner"),
      llm_credential_file: join(parent, "not-read-llm"),
    });
    try {
      expect(runtime.processing).toBe("idle_until_finalize");
      expect(
        (
          await fetch(
            `http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`,
          )
        ).status,
      ).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it("stages a null-policy private card, then a signed Team approve binds policy, appends one V4 record, and is replay-safe", async () => {
    const fixture = await activeFixture();
    const control = openOrganizationControlDatabase(
      join(fixture.initialized.state_directory, "integrations.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 || fixture.poster.published.length === 1,
        "private approval card",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      const card = fixture.poster.published[0]!;
      const parts = cardParts(card.card);
      const policyElement = parts.policyElement as {
        initial_option: { value: string };
        options: readonly { value: string }[];
      };
      expect(policyElement.initial_option.value).toBe(
        RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      );
      expect(policyElement.options.map((option) => option.value)).toEqual([
        RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      ]);
      expect((parts.comment.element as { multiline: boolean }).multiline).toBe(
        true,
      );
      const replayTimestamp = String(Math.floor(Date.now() / 1_000));
      expect(
        (
          await clickCard({
            fixture,
            card,
            action: "approve",
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            comment: "Share with the team after review.",
            request_timestamp: replayTimestamp,
          })
        ).status,
      ).toBe(200);
      // Same complete provider action is a receipt replay, never a second approval.
      expect(
        (
          await clickCard({
            fixture,
            card,
            action: "approve",
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            comment: "Share with the team after review.",
            request_timestamp: replayTimestamp,
          })
        ).status,
      ).toBe(200);
      await waitFor(
        () =>
          fixture.errors.length > 0 ||
          (
            record
              .prepare("SELECT count(*) AS count FROM organization_record_log")
              .get() as { count: number }
          ).count === 1,
        "Team V4 append",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      expect(
        control
          .prepare(
            "SELECT count(*) AS count FROM organization_private_approval_signed_action_receipts_v2",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        control
          .prepare(
            "SELECT count(*) AS count FROM organization_private_approval_terminal_evidence_v2",
          )
          .get(),
      ).toEqual({ count: 1 });
      const resolution = JSON.parse(
        (
          control
            .prepare(
              "SELECT resolution_json FROM organization_private_approval_terminal_evidence_v2 WHERE approval_id = ?",
            )
            .get(card.approval_id) as { resolution_json: string }
        ).resolution_json,
      ) as {
        readonly comment: string | null;
        readonly canonical_record_policy: { readonly policy_id: string } | null;
      };
      expect(resolution).toMatchObject({
        comment: "Share with the team after review.",
        canonical_record_policy: {
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        },
      });
      expect(
        record
          .prepare(
            "SELECT policy_id FROM organization_record_member_readable_person_fact",
          )
          .all(),
      ).toEqual([{ policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID }]);
      await waitFor(
        () =>
          (
            authority
              .prepare(
                "SELECT record_head_position FROM authority_readable_search_active_generation WHERE singleton = 1",
              )
              .get() as { record_head_position: number } | undefined
          )?.record_head_position === 1,
        "Team readable-search generation",
      );
      const teamAnswers = await answerAsOwnerAndMember({
        fixture,
        authority,
        record,
      });
      expect(teamAnswers.owner).toMatchObject({
        answer: "Ship the clean live migration.",
        citations: [
          { policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID },
        ],
      });
      expect(teamAnswers.member).toMatchObject({
        answer: "Ship the clean live migration.",
        citations: [
          { policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID },
        ],
      });
      await waitFor(
        () => fixture.poster.terminal.length === 1,
        "approved terminal card",
      );
      expect(fixture.poster.terminal[0]).toMatchObject({
        approval_id: card.approval_id,
        outcome: "approved",
        policy_label: "Team",
        dm_channel_id: SLACK_DM_CHANNEL,
      });
    } finally {
      record.close();
      authority.close();
      control.close();
      await fixture.runtime.close();
    }
  });

  it("uses Only me when approved and recovers a restart without reposting the private card", async () => {
    const fixture = await activeFixture();
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 || fixture.poster.published.length === 1,
        "private approval card",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      const card = fixture.poster.published[0]!;
      expect(
        (
          await clickCard({
            fixture,
            card,
            action: "approve",
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          })
        ).status,
      ).toBe(200);
      await waitFor(
        () =>
          fixture.errors.length > 0 ||
          (
            record
              .prepare("SELECT count(*) AS count FROM organization_record_log")
              .get() as { count: number }
          ).count === 1,
        "Only me V4 append",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      expect(
        record
          .prepare(
            "SELECT policy_id FROM organization_record_restricted_reviewer_person_fact",
          )
          .all(),
      ).toEqual([{ policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID }]);
      await waitFor(
        () =>
          (
            authority
              .prepare(
                "SELECT record_head_position FROM authority_readable_search_active_generation WHERE singleton = 1",
              )
              .get() as { record_head_position: number } | undefined
          )?.record_head_position === 1,
        "Only-me readable-search generation",
      );
      const onlyMeAnswers = await answerAsOwnerAndMember({
        fixture,
        authority,
        record,
      });
      expect(onlyMeAnswers.owner).toMatchObject({
        answer: "Ship the clean live migration.",
        citations: [{ policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID }],
      });
      expect(onlyMeAnswers.member).toMatchObject({
        answer: "Insufficient accessible evidence to answer this question.",
        citations: [],
      });
      await fixture.runtime.close();
      const restartedPoster = new FakePrivateApprovalPoster();
      const restarted = await openCleanLiveRuntime(fixture.config, {
        live_adapters: {
          source: fixture.source,
          processor: fakeProcessor(fixture.processorIdentity),
          private_approval_card_poster: restartedPoster,
        },
      });
      try {
        await waitFor(() => fixture.source.pulls() >= 2, "restart source poll");
        expect(restartedPoster.markers).toEqual([]);
        expect(restartedPoster.published).toEqual([]);
        // The restart must warm the already-published exact-head generation,
        // not merely avoid reposting the Slack card.
        const recoveredOnlyMeAnswer = await answerAsOwner({
          fixture,
          authority,
          record,
        });
        expect(recoveredOnlyMeAnswer).toMatchObject({
          answer: "Ship the clean live migration.",
          citations: [{ policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID }],
        });
      } finally {
        await restarted.close();
      }
    } finally {
      record.close();
      authority.close();
    }
  });

  it("accepts a signed Reject, leaves policy null, creates no V4 record, and renders a rejected private card", async () => {
    const fixture = await activeFixture();
    const control = openOrganizationControlDatabase(
      join(fixture.initialized.state_directory, "integrations.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 || fixture.poster.published.length === 1,
        "private approval card",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      const card = fixture.poster.published[0]!;
      expect(
        (
          await clickCard({
            fixture,
            card,
            action: "reject",
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
            comment: "Needs a clearer decision.",
          })
        ).status,
      ).toBe(200);
      await waitFor(
        () => fixture.errors.length > 0 || fixture.poster.terminal.length === 1,
        "rejected terminal card",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      expect(
        record
          .prepare("SELECT count(*) AS count FROM organization_record_log")
          .get(),
      ).toEqual({ count: 0 });
      expect(fixture.poster.terminal[0]).toMatchObject({
        approval_id: card.approval_id,
        outcome: "rejected",
        policy_label: null,
        dm_channel_id: SLACK_DM_CHANNEL,
      });
    } finally {
      record.close();
      control.close();
      await fixture.runtime.close();
    }
  });
});
