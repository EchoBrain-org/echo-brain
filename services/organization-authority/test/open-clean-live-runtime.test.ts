import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  CleanPersonRecordReaderV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  buildCleanReadableSearchGenerationV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  readableSearchPlaneBaselineSha256V1,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  type BuildCleanReadableSearchGenerationV1Input,
  type CleanReadableSearchAtomV1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  openOrganizationControlDatabase,
  type PersonSlackApprovalObserverV2,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  buildPersonSlackApprovalActionCapabilityV2,
  buildPersonSlackApprovalBindingContractV2,
} from "../../organization-control-plane/src/application/person-slack-approval-contracts-v2.js";
import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import { PersonIdentitySessionApplication } from "../src/application/person-identity-sessions.js";
import { SqliteCleanPersonSessionRepository } from "../src/adapters/persistence/sqlite/clean-person-session-repository.js";
import { SqliteCleanPersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../src/adapters/security/node-person-session-crypto.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../src/adapters/security/private-file-credentials.js";
import { SystemAuthorityClock } from "../src/adapters/runtime/system-runtime-ports.js";
import { admitCleanGranolaSource } from "../src/composition/clean-granola-source-admission.js";
import { initializeCleanPersonCredentials } from "../src/composition/clean-person-onboarding.js";
import { issueCleanPersonInvitation } from "../src/composition/clean-person-onboarding.js";
import { createCleanPersonRecordReadRouteV1 } from "../src/composition/clean-person-record-read-route.js";
import { createCleanPersonRecordSearchRouteV1 } from "../src/composition/clean-person-record-search-route.js";
import { cleanReadableSearchRuntimeContractV1 } from "../src/composition/clean-readable-search-runtime.js";
import { initializeCleanResetState } from "../src/composition/clean-reset-state.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import {
  openCleanLiveRuntime,
  type OpenCleanLiveRuntimeConfig,
} from "../src/composition/open-clean-live-runtime.js";
import { createGranolaLiveOnlyCursor } from "../src/processing/adapters/meeting-sources/granola/index.js";
import type {
  AdapterHealth,
  DecisionProcessorAdapter,
  DecisionSet,
  MeetingDocument,
  MeetingSourceAdapter,
} from "../src/processing/core/index.js";

const roots: string[] = [];

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
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};
const SLACK_CHANNEL = "C0123456789";
const NOW = "2026-08-22T12:00:00.000Z";

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

/** A deterministic browser-login stand-in for the owner and one employee. */
class OwnerAndEmployeeOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private attempt: BegunPersonOidcLogin | undefined;
  email = "founder@example.com";

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.attempt = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode() {
    if (this.attempt === undefined)
      throw new Error("OIDC begin was not called");
    const founder = this.email === "founder@example.com";
    return {
      kind: "verified" as const,
      token: {
        issuer: OIDC.issuer,
        subject: founder ? "founder-subject" : "employee-subject",
        audience: OIDC.client_id,
        nonce: this.attempt.nonce,
        issued_at: Math.floor(Date.now() / 1_000),
        claims: { email: this.email, email_verified: true },
      },
    };
  }
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function browserLogin(
  origin: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      loopback_handoff: {
        url: `http://127.0.0.1:39999/${"P".repeat(43)}`,
        token: "T".repeat(43),
      },
    }),
  });
  expect(begun.status).toBe(201);
  const authorization = await responseJson(begun);
  const state = new URL(
    authorization.authorization_url as string,
  ).searchParams.get("state");
  expect(state).not.toBeNull();
  const callback = await fetch(
    `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=browser-code`,
  );
  expect(callback.status).toBe(200);
  const page = await callback.text();
  const encoded = /name="session" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(
    Buffer.from(encoded!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function privateFile(parent: string, name: string, value: string): string {
  const path = join(parent, name);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
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
  const invitationDirectory = join(input.parent, "invitations");
  mkdirSync(invitationDirectory, { mode: 0o700 });
  chmodSync(invitationDirectory, 0o700);
  const invitationPath = join(invitationDirectory, "founder.invitation.json");
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

function seedActiveSlackApproval(input: {
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
      provider_tenant_id: "T_LIVE_TEST",
      provider_enterprise_id: null,
      tool_kind: "slack",
      provider_app_id: "A_LIVE_TEST",
      provider_bot_id: "B_LIVE_TEST",
      provider_bot_user_id: "U_LIVE_BOT",
      required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
      public_connection_configuration_sha256: canonicalSha256({
        kind: "configuration",
      }),
    });
    const connectionSha = canonicalSha256(connection);
    const state = buildOrganizationToolConnectionStateV2({
      connection_id: connection.connection_id,
      connection_contract_sha256: connectionSha,
      connection_status: "active",
      credential_reference_sha256: canonicalSha256({
        kind: "test-only-unread-token",
      }),
      observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
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
      provider_tenant_id: "T_LIVE_TEST",
      provider_enterprise_id: null,
      provider_subject_id: "UFOUNDER",
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
    const binding = buildPersonSlackApprovalBindingContractV2({
      ...coordinates,
      approval_binding_id: "bnd_live_test",
      connection_id: connection.connection_id,
      connection_contract_sha256: connectionSha,
      approval_adapter_kind: "approval-surface",
      approval_adapter_id: "slack-reactions",
      approval_adapter_instance_id: "founder-approval",
      approval_adapter_version: "1.0.0",
      approval_channel_id: SLACK_CHANNEL,
      approve_reaction: "white_check_mark",
      reject_reaction: "x",
      supported_policy_actions: [
        {
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          policy_contract_sha256:
            ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
          actions: ["approve", "reject"],
        },
        {
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          policy_contract_sha256:
            RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
          actions: ["approve", "reject"],
        },
      ],
    });
    const bindingSha = canonicalSha256(binding);
    control
      .prepare(
        "INSERT INTO organization_approval_binding_contracts VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        binding.approval_binding_id,
        canonicalJson(binding),
        bindingSha,
        connection.connection_id,
        NOW,
      );
    control
      .prepare(
        "INSERT INTO organization_approval_binding_current VALUES (?, ?, 'active', ?)",
      )
      .run(binding.approval_binding_id, bindingSha, NOW);
    for (const policy of [
      {
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        policy_contract_sha256:
          ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      },
      {
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        policy_contract_sha256:
          RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
      },
    ] as const) {
      for (const action of ["approve", "reject"] as const) {
        const capability = buildPersonSlackApprovalActionCapabilityV2({
          ...coordinates,
          action_capability_id: `cap_live_${policy.policy_id}_${action}`,
          approval_binding_id: binding.approval_binding_id,
          approval_binding_contract_sha256: bindingSha,
          external_identity_link_id: link.external_identity_link_id,
          principal_id: input.principal_id,
          membership_id: input.membership_id,
          membership_type: "owner",
          policy_id: policy.policy_id,
          policy_contract_sha256: policy.policy_contract_sha256,
          action,
        });
        const capabilitySha = canonicalSha256(capability);
        control
          .prepare(
            "INSERT INTO organization_approval_action_capability_contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            capability.action_capability_id,
            canonicalJson(capability),
            capabilitySha,
            binding.approval_binding_id,
            link.external_identity_link_id,
            capability.policy_id,
            action,
            NOW,
          );
        control
          .prepare(
            "INSERT INTO organization_approval_action_capability_current VALUES (?, ?, 'active', ?)",
          )
          .run(capability.action_capability_id, capabilitySha, NOW);
      }
    }
  } finally {
    control.close();
  }
}

const healthy = (): AdapterHealth => ({
  status: "healthy",
  checked_at: NOW,
});

function fakeSource(
  meetings: readonly MeetingDocument[],
  source: MeetingSourceAdapter["identity"],
): MeetingSourceAdapter & { readonly pulls: () => number } {
  let pulls = 0;
  return {
    identity: source,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => healthy(),
    pull: async (request) => {
      pulls += 1;
      const meeting = meetings[pulls - 1];
      return meeting !== undefined
        ? {
            meetings: [meeting],
            next_cursor: createGranolaLiveOnlyCursor(
              `2026-08-22T12:00:0${String(pulls)}.000Z`,
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

function fakeReaction(
  action: "approve" | "reject",
): PersonSlackApprovalObserverV2 & { readonly calls: () => number } {
  let calls = 0;
  return {
    async observeApprovalReaction(expectation, expectation_sha256) {
      calls += 1;
      return {
        kind: "observed",
        expectation_sha256,
        provider_actor_subject: "UFOUNDER",
        observed_reaction:
          action === "approve"
            ? expectation.approve_reaction
            : expectation.reject_reaction,
        observed_action: action,
        provider_response_evidence_sha256: canonicalSha256({
          kind: "synthetic-slack-reaction",
          approval_id: expectation.approval_id,
          action,
        }),
        observed_at: NOW,
      };
    },
    calls: () => calls,
  };
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function activeFixture(
  action: "approve" | "reject",
  person?: PersonSessionOidcAuthorizationProvider,
  meetingVariants?: readonly {
    readonly title: string;
    readonly external_id: string;
    readonly text: string;
    readonly folder_membership?: readonly { readonly name: string }[];
  }[],
) {
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
  seedActiveSlackApproval({
    state_directory: initialized.state_directory,
    authority_id: initialized.authority_id,
    organization_id: initialized.organization_id,
    state_lineage_id: initialized.state_lineage_id,
    principal_id: initialized.owner_principal_id,
    membership_id: initialized.owner_membership_id,
  });
  const sourceIdentity = {
    kind: "meeting-source" as const,
    adapter_id: "granola",
    instance_id: admitted.source.instance_id,
    version: admitted.source.version,
  };
  const processorIdentity = {
    kind: "decision-processor" as const,
    adapter_id: "llm",
    instance_id: admitted.processor.instance_id,
    version: admitted.processor.version,
  };
  const meeting: MeetingDocument = {
    schema_version: 1,
    id: "granola:founder-granola:note-live-test",
    title: "Live migration review",
    provenance: {
      source: sourceIdentity,
      external_id: "note-live-test",
      canonical_revision: canonicalSha256({ note: "live-test" }),
      observed_at: NOW,
      normalizer_version: sourceIdentity.version,
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
  };
  const source = fakeSource(
    meetingVariants?.map((variant) => ({
      ...meeting,
      id: `granola:founder-granola:${variant.external_id}`,
      title: variant.title,
      provenance: {
        ...meeting.provenance,
        external_id: variant.external_id,
        canonical_revision: canonicalSha256({ note: variant.external_id }),
      },
      content: [{ id: variant.external_id, kind: "note", text: variant.text }],
      ...(variant.folder_membership === undefined
        ? {}
        : {
            extensions: {
              granola: {
                folder_membership: variant.folder_membership.map((folder) => ({
                  ...folder,
                })),
              },
            },
          }),
    })) ?? [meeting],
    sourceIdentity,
  );
  const reaction = fakeReaction(action);
  const posted: string[] = [];
  const errors: Error[] = [];
  const config: OpenCleanLiveRuntimeConfig = {
    state_directory: initialized.state_directory,
    host: "127.0.0.1",
    port: await availablePort(),
    authority_url: "https://authority.example",
    oidc: OIDC,
    client_authentication: { method: "none" },
    pkce_key_file,
    slack_approval_channel_id: SLACK_CHANNEL,
    granola_credential_file,
    granola_owner_email_file,
    llm_credential_file,
    worker_interval_ms: meetingVariants === undefined ? 60_000 : 10,
    on_worker_error: (error) => errors.push(error),
  };
  const runtime = await openCleanLiveRuntime(config, {
    ...(person === undefined ? {} : { person: { oidc_provider: person } }),
    live_adapters: {
      source,
      processor: fakeProcessor(processorIdentity),
      approval_card_poster: {
        async post(input) {
          posted.push(input.text);
          return {
            provider_message_ts: `1724112000.${String(posted.length).padStart(6, "0")}`,
          };
        },
      },
      approval_observer: reaction,
    },
  });
  return {
    initialized,
    config,
    source,
    processorIdentity,
    reaction,
    posted,
    errors,
    runtime,
  };
}

function readableSearchBuildInput(input: {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly exact_head: {
    readonly position: number;
    readonly record_sha256: Sha256Digest;
  };
  readonly atoms: readonly CleanReadableSearchAtomV1[];
}): BuildCleanReadableSearchGenerationV1Input {
  const plane = (role: string, schema_sha256: Sha256Digest) => {
    const manifest_json = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
      database_schema_version: 1,
      schema_sha256,
      created_at: NOW,
      creating_artifact_revision: "employee-permission-acceptance",
    });
    return {
      database_schema_version: 1 as const,
      schema_sha256,
      manifest_json,
      manifest_sha256: sha256Digest(manifest_json),
    };
  };
  const contract = cleanReadableSearchRuntimeContractV1();
  return {
    state_directory: input.state_directory,
    lineage: {
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
      planes: {
        facts: plane(
          "retrieval-facts",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_FACTS_BASELINE_V1,
          ),
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_CONTENT_BASELINE_V1,
          ),
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_LEXICAL_BASELINE_V1,
          ),
        ),
      },
    },
    exact_head: {
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
      position: input.exact_head.position,
      record_sha256: input.exact_head.record_sha256,
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
    atoms: input.atoms,
  };
}

function syntheticRestrictedRecord(input: {
  readonly record: ReturnType<typeof openOrganizationRecordDatabase>;
  readonly initialized: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly owner_principal_id: string;
    readonly owner_membership_id: string;
  };
}): {
  readonly record_sha256: Sha256Digest;
  readonly atom: CleanReadableSearchAtomV1;
} {
  const prior = input.record
    .prepare(
      `SELECT position, record_sha256, canonical_envelope
       FROM organization_record_log WHERE position = 1`,
    )
    .get() as {
    readonly position: number;
    readonly record_sha256: Sha256Digest;
    readonly canonical_envelope: string;
  };
  const memberFact = input.record
    .prepare(
      `SELECT atom_order, signal_id_sha256, item_kind, audit_event_id, audit_sequence,
            audit_entry_sha256, provider_action_sha256, authorization_proof_sha256
       FROM organization_record_member_readable_person_fact
      WHERE record_position = 1 AND record_sha256 = ?`,
    )
    .get(prior.record_sha256) as {
    readonly atom_order: number;
    readonly signal_id_sha256: Sha256Digest;
    readonly item_kind: "decision" | "action" | "rationale";
    readonly audit_event_id: string;
    readonly audit_sequence: number;
    readonly audit_entry_sha256: Sha256Digest;
    readonly provider_action_sha256: Sha256Digest;
    readonly authorization_proof_sha256: Sha256Digest;
  };
  const record_sha256 = sha256Digest("employee-permission-restricted-record");
  const envelope = JSON.parse(prior.canonical_envelope) as {
    body: Record<string, unknown>;
    record_sha256: string;
  };
  const body = envelope.body;
  const reference = body.human_act_resolution_ref as Record<string, unknown>;
  const event = body.event as Record<string, unknown>;
  const approval_id = "approval-employee-permission-restricted";
  body.envelope_id = "envelope-employee-permission-restricted";
  body.semantic_idempotency_key = sha256Digest(
    "employee-permission-restricted-idempotency",
  );
  body.predecessor_position = prior.position;
  body.predecessor_record_sha256 = prior.record_sha256;
  reference.approval_id = approval_id;
  reference.policy_id = RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  reference.policy_contract_sha256 =
    cleanReadableSearchRuntimeContractV1().restricted_reviewer_policy_contract_sha256;
  event.policy_id = RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  event.policy_contract_sha256 =
    cleanReadableSearchRuntimeContractV1().restricted_reviewer_policy_contract_sha256;
  envelope.record_sha256 = record_sha256;
  const canonical_envelope = canonicalJson(envelope);
  const receipt = canonicalJson({
    schema_version: 2,
    kind: "echo-organization-record-receipt-v2",
    authority_id: input.initialized.authority_id,
    organization_id: input.initialized.organization_id,
    state_lineage_id: input.initialized.state_lineage_id,
    envelope_id: body.envelope_id,
    semantic_idempotency_key: body.semantic_idempotency_key,
    event_kind: "approved",
    record_position: 2,
    record_sha256,
    predecessor_record_sha256: prior.record_sha256,
    record_head_position: 2,
    record_head_sha256: record_sha256,
    issued_at: NOW,
  });
  input.record
    .prepare(
      `INSERT INTO organization_record_log
      (position, envelope_id, event_kind, approval_id, action, semantic_idempotency_key,
       canonical_envelope, envelope_sha256, predecessor_position, predecessor_record_sha256,
       record_sha256, receipt_payload, receipt_issued_at)
     VALUES (2, ?, 'approved', ?, 'approve', ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      body.envelope_id,
      approval_id,
      body.semantic_idempotency_key,
      canonical_envelope,
      sha256Digest(canonical_envelope),
      prior.record_sha256,
      record_sha256,
      receipt,
      NOW,
    );
  const atom_id = sha256Digest("employee-permission-restricted-atom");
  input.record
    .prepare(
      `INSERT INTO organization_record_restricted_reviewer_person_fact
      (authority_id, organization_id, state_lineage_id, approval_id, action, policy_id,
       policy_contract_sha256, record_position, record_sha256, atom_order,
       signal_id_sha256, atom_id, item_kind, audit_event_id, audit_sequence,
       audit_entry_sha256, provider_action_sha256, authorization_proof_sha256,
       reviewer_principal_id, reviewer_membership_id)
     VALUES (?, ?, ?, ?, 'approve', ?, ?, 2, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.initialized.authority_id,
      input.initialized.organization_id,
      input.initialized.state_lineage_id,
      approval_id,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
      cleanReadableSearchRuntimeContractV1()
        .restricted_reviewer_policy_contract_sha256,
      record_sha256,
      memberFact.signal_id_sha256,
      atom_id,
      memberFact.item_kind,
      memberFact.audit_event_id,
      memberFact.audit_sequence,
      memberFact.audit_entry_sha256,
      memberFact.provider_action_sha256,
      memberFact.authorization_proof_sha256,
      input.initialized.owner_principal_id,
      input.initialized.owner_membership_id,
    );
  return {
    record_sha256,
    atom: {
      authority_id: input.initialized.authority_id,
      organization_id: input.initialized.organization_id,
      state_lineage_id: input.initialized.state_lineage_id,
      record_position: 2,
      record_sha256,
      envelope_sha256: sha256Digest(canonical_envelope),
      approval_id,
      atom_id,
      atom_order: 0,
      signal_id_sha256: memberFact.signal_id_sha256,
      item_kind: memberFact.item_kind,
      text: "restricted employee permission acceptance",
      text_sha256: sha256Digest("restricted employee permission acceptance"),
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
      policy_contract_sha256:
        cleanReadableSearchRuntimeContractV1()
          .restricted_reviewer_policy_contract_sha256,
      authorization_audit_event_id: memberFact.audit_event_id,
      authorization_audit_sequence: memberFact.audit_sequence,
      authorization_audit_entry_sha256: memberFact.audit_entry_sha256,
      provider_action_sha256: memberFact.provider_action_sha256,
      authorization_proof_sha256: memberFact.authorization_proof_sha256,
      reviewer_principal_id: input.initialized.owner_principal_id,
      reviewer_membership_id: input.initialized.owner_membership_id,
    },
  };
}

function ownerAuthorization(input: {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}) {
  const digest = (value: string): Sha256Digest => canonicalSha256({ value });
  return {
    organization_id: input.organization_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    membership_type: "owner" as const,
    identity_binding_id: "identity_live_test",
    session_family_id: "session_live_test",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-22T13:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T14:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: NOW,
  };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("open clean live runtime", () => {
  it("starts the same Person server before finalize without contacting OIDC, Granola, OpenRouter, or Slack", async () => {
    const parent = root();
    const initialized = initializeCleanResetState({
      state_directory: join(parent, "state"),
      organization_display_name: "Founder Organization",
      owner_display_name: "Founder",
      created_at: "2026-08-22T12:00:00.000Z",
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
      // A real discovery request to this deliberately invalid issuer would
      // fail. Successful startup proves construction is provider-free.
      oidc: {
        issuer: "https://issuer.invalid",
        client_id: "founder-client",
        redirect_uri: "https://authority.example/v2/session/oidc/callback",
        tenant: { kind: "issuer" },
        id_token_algorithms: ["RS256"],
      },
      client_authentication: { method: "none" },
      pkce_key_file: credentials.pkce_sealing_key_reference.slice(
        "file:".length,
      ),
      slack_approval_channel_id: "C0123456789",
      // Admission is intentionally absent, so these private paths must not be
      // touched until stopped-state finalize admits the source.
      granola_credential_file: join(parent, "not-read-granola"),
      granola_owner_email_file: join(parent, "not-read-owner"),
      llm_credential_file: join(parent, "not-read-llm"),
    });
    try {
      expect(runtime.processing).toBe("idle_until_finalize");
      const descriptor = await fetch(
        `http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`,
      );
      expect(descriptor.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it("carries one synthetic Granola decision through Slack approval, D2 finalization, V4, exact-head Layer 2, and an authenticated read", async () => {
    const fixture = await activeFixture("approve");
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 ||
          (
            record
              .prepare("SELECT count(*) AS count FROM organization_record_log")
              .get() as { count: number }
          ).count === 1,
        "V4 append",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      expect(fixture.posted).toHaveLength(1);
      expect(fixture.posted[0]).toContain("Ship the clean live migration.");
      expect(fixture.reaction.calls()).toBe(1);
      expect(
        authority
          .prepare(
            `SELECT record_head_position
               FROM authority_readable_search_active_generation
              WHERE singleton = 1`,
          )
          .get(),
      ).toEqual({ record_head_position: 1 });
    } finally {
      record.close();
      authority.close();
      await fixture.runtime.close();
    }

    // A normal restart first recovers append receipts and cannot append the
    // finalized action a second time.
    const restarted = await openCleanLiveRuntime(fixture.config, {
      live_adapters: {
        source: fixture.source,
        processor: fakeProcessor(fixture.processorIdentity),
        approval_card_poster: {
          async post() {
            throw new Error("restart must not post a duplicate approval card");
          },
        },
        approval_observer: fixture.reaction,
      },
    });
    try {
      await waitFor(() => fixture.source.pulls() >= 2, "restart source poll");
    } finally {
      await restarted.close();
    }

    const rereadAuthority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const rereadRecord = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      expect(
        rereadRecord
          .prepare("SELECT count(*) AS count FROM organization_record_log")
          .get(),
      ).toEqual({ count: 1 });
      const authorization = ownerAuthorization({
        organization_id: fixture.initialized.organization_id,
        principal_id: fixture.initialized.owner_principal_id,
        membership_id: fixture.initialized.owner_membership_id,
      });
      const sessions = { authenticateAccess: () => authorization };
      const list = createCleanPersonRecordReadRouteV1({
        authority_id: fixture.initialized.authority_id,
        organization_id: fixture.initialized.organization_id,
        state_lineage_id: fixture.initialized.state_lineage_id,
        sessions,
        records: new CleanPersonRecordReaderV1(rereadRecord),
        audit: new SqliteCleanPersonRecordReadAuditV1(rereadAuthority),
      });
      expect(
        list.list({ access_token: "synthetic-founder-token" }).records,
      ).toHaveLength(1);

      const search = createCleanPersonRecordSearchRouteV1({
        state_directory: fixture.initialized.state_directory,
        authority_id: fixture.initialized.authority_id,
        organization_id: fixture.initialized.organization_id,
        state_lineage_id: fixture.initialized.state_lineage_id,
        retrieval_contract_sha256:
          cleanReadableSearchRuntimeContractV1().retrieval_contract_sha256,
        sessions,
        authority: rereadAuthority,
        record: rereadRecord,
        audit: new SqliteCleanPersonRecordReadAuditV1(rereadAuthority),
      });
      const result = search.search({
        access_token: "synthetic-founder-token",
        query: "ship live migration",
      });
      expect(result.record_head.position).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        text: "Ship the clean live migration.",
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      });
    } finally {
      rereadRecord.close();
      rereadAuthority.close();
    }
  });

  it("gives an employee only member-readable Layer 1 and Layer 2 content, then revocation fences both paths", async () => {
    const provider = new OwnerAndEmployeeOidcProvider();
    const fixture = await activeFixture("approve", provider);
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 ||
          (
            record
              .prepare("SELECT count(*) AS count FROM organization_record_log")
              .get() as { count: number }
          ).count === 1,
        "member-readable V4 append",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];

      const member = record
        .prepare(
          `SELECT log.record_sha256, log.envelope_sha256, fact.atom_id, fact.atom_order,
                fact.signal_id_sha256, fact.item_kind, fact.audit_event_id, fact.audit_sequence,
                fact.audit_entry_sha256, fact.provider_action_sha256, fact.authorization_proof_sha256
           FROM organization_record_log AS log
           JOIN organization_record_member_readable_person_fact AS fact
             ON fact.record_position = log.position AND fact.record_sha256 = log.record_sha256
          WHERE log.position = 1`,
        )
        .get() as {
        readonly record_sha256: Sha256Digest;
        readonly envelope_sha256: Sha256Digest;
        readonly atom_id: Sha256Digest;
        readonly atom_order: number;
        readonly signal_id_sha256: Sha256Digest;
        readonly item_kind: "decision" | "action" | "rationale";
        readonly audit_event_id: string;
        readonly audit_sequence: number;
        readonly audit_entry_sha256: Sha256Digest;
        readonly provider_action_sha256: Sha256Digest;
        readonly authorization_proof_sha256: Sha256Digest;
      };
      const restricted = syntheticRestrictedRecord({
        record,
        initialized: fixture.initialized,
      });
      const contract = cleanReadableSearchRuntimeContractV1();
      const built = buildCleanReadableSearchGenerationV1(
        readableSearchBuildInput({
          state_directory: fixture.initialized.state_directory,
          authority_id: fixture.initialized.authority_id,
          organization_id: fixture.initialized.organization_id,
          state_lineage_id: fixture.initialized.state_lineage_id,
          exact_head: { position: 2, record_sha256: restricted.record_sha256 },
          atoms: [
            {
              authority_id: fixture.initialized.authority_id,
              organization_id: fixture.initialized.organization_id,
              state_lineage_id: fixture.initialized.state_lineage_id,
              record_position: 1,
              record_sha256: member.record_sha256,
              envelope_sha256: member.envelope_sha256,
              approval_id: "apr_live_test",
              atom_id: member.atom_id,
              atom_order: member.atom_order,
              signal_id_sha256: member.signal_id_sha256,
              item_kind: member.item_kind,
              text: "Ship the clean live migration.",
              text_sha256: sha256Digest("Ship the clean live migration."),
              policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
              policy_contract_sha256:
                contract.organization_member_policy_contract_sha256,
              authorization_audit_event_id: member.audit_event_id,
              authorization_audit_sequence: member.audit_sequence,
              authorization_audit_entry_sha256: member.audit_entry_sha256,
              provider_action_sha256: member.provider_action_sha256,
              authorization_proof_sha256: member.authorization_proof_sha256,
              reviewer_principal_id: null,
              reviewer_membership_id: null,
            },
            restricted.atom,
          ],
        }),
      );
      authority
        .prepare(
          `UPDATE authority_readable_search_active_generation
            SET generation_id = ?, manifest_sha256 = ?, retrieval_contract_sha256 = ?,
                record_head_position = 2, record_head_hash = ?, published_at = ?
          WHERE singleton = 1`,
        )
        .run(
          built.manifest.generation_id,
          built.manifest_sha256,
          contract.retrieval_contract_sha256,
          restricted.record_sha256,
          NOW,
        );

      const origin = `http://127.0.0.1:${String(fixture.runtime.address.port)}`;
      const owner = await browserLogin(origin, {
        kind: "existing_identity_login",
      });
      const ownerAccess = owner.access_token as string;
      const invitation = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Employee",
          email: "employee@example.com",
        }),
      });
      expect(invitation.status).toBe(201);
      const invitationBody = await responseJson(invitation);
      provider.email = "employee@example.com";
      const employee = await browserLogin(origin, {
        kind: "identity_bootstrap",
        login_grant: invitationBody.login_grant,
      });
      const employeeAccess = employee.access_token as string;

      const employeeList = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(employeeList.status).toBe(200);
      const employeeListBody = await responseJson(employeeList);
      expect(employeeListBody.records).toEqual([
        expect.objectContaining({ record_sha256: member.record_sha256 }),
      ]);
      const employeeSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${employeeAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "migration restricted" }),
      });
      expect(employeeSearch.status).toBe(200);
      const employeeSearchBody = await responseJson(employeeSearch);
      expect(employeeSearchBody).toMatchObject({
        generation_id: built.manifest.generation_id,
        record_head: { position: 2, record_sha256: restricted.record_sha256 },
      });
      expect(employeeSearchBody.items).toEqual([
        expect.objectContaining({
          atom_id: member.atom_id,
          record_sha256: member.record_sha256,
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
      ]);

      provider.email = "founder@example.com";
      const ownerList = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${ownerAccess}` },
      });
      expect(ownerList.status).toBe(200);
      expect((await responseJson(ownerList)).records).toHaveLength(2);
      const ownerSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "migration restricted" }),
      });
      expect(ownerSearch.status).toBe(200);
      expect((await responseJson(ownerSearch)).items).toHaveLength(2);

      const revoked = await fetch(`${origin}/v1/person/employees`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "employee@example.com" }),
      });
      expect(revoked.status).toBe(204);
      const employeeListAfterRevoke = await fetch(
        `${origin}/v1/person/records`,
        {
          headers: { authorization: `Bearer ${employeeAccess}` },
        },
      );
      expect(employeeListAfterRevoke.status).toBe(401);
      const employeeSearchAfterRevoke = await fetch(
        `${origin}/v1/person/records`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${employeeAccess}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "migration" }),
        },
      );
      expect(employeeSearchAfterRevoke.status).toBe(401);
      const ownerContinues = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${ownerAccess}` },
      });
      expect(ownerContinues.status).toBe(200);
      const ownerSearchContinues = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "migration restricted" }),
      });
      expect(ownerSearchContinues.status).toBe(200);
      expect((await responseJson(ownerSearchContinues)).items).toHaveLength(2);
    } finally {
      record.close();
      authority.close();
      await fixture.runtime.close();
    }
  });

  it("processes an echo-restricted Granola folder record through approval while an active employee receives only member-readable content", async () => {
    const provider = new OwnerAndEmployeeOidcProvider();
    const fixture = await activeFixture("approve", provider, [
      {
        title: "Member record",
        external_id: "member-visible",
        text: "MemberVisibleC186576",
      },
      {
        title: "Founder review",
        external_id: "restricted-only",
        text: "RestrictedOnlyC186576",
        folder_membership: [{ name: "echo-restricted" }],
      },
    ]);
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () =>
          fixture.errors.length > 0 ||
          (
            record
              .prepare("SELECT count(*) AS count FROM organization_record_log")
              .get() as { count: number }
          ).count === 2,
        "both live Granola approvals appended",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      expect(fixture.posted).toHaveLength(2);
      expect(fixture.posted[0]).toContain(
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
      );
      expect(fixture.posted[1]).toContain(
        RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
      );
      expect(
        record
          .prepare(
            `SELECT policy_id
               FROM (
                 SELECT record_position, policy_id
                   FROM organization_record_member_readable_person_fact
                 UNION ALL
                 SELECT record_position, policy_id
                   FROM organization_record_restricted_reviewer_person_fact
               )
              ORDER BY record_position`,
          )
          .all(),
      ).toEqual([
        { policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID },
        { policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID },
      ]);
      await waitFor(
        () =>
          (
            authority
              .prepare(
                `SELECT record_head_position
                   FROM authority_readable_search_active_generation
                  WHERE singleton = 1`,
              )
              .get() as { record_head_position: number }
          ).record_head_position === 2,
        "exact-head search generation",
      );

      const origin = `http://127.0.0.1:${String(fixture.runtime.address.port)}`;
      const owner = await browserLogin(origin, { kind: "existing_identity_login" });
      const ownerAccess = owner.access_token as string;
      const invitation = await fetch(`${origin}/v1/person/employees`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Employee",
          email: "employee@example.com",
        }),
      });
      expect(invitation.status).toBe(201);
      provider.email = "employee@example.com";
      const employee = await browserLogin(origin, {
        kind: "identity_bootstrap",
        login_grant: (await responseJson(invitation)).login_grant,
      });
      const employeeAccess = employee.access_token as string;

      const employeeList = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${employeeAccess}` },
      });
      expect(employeeList.status).toBe(200);
      expect((await responseJson(employeeList)).records).toHaveLength(1);
      const employeeMemberSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${employeeAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "MemberVisibleC186576" }),
      });
      expect(employeeMemberSearch.status).toBe(200);
      expect((await responseJson(employeeMemberSearch)).items).toHaveLength(1);
      const employeeRestrictedSearch = await fetch(
        `${origin}/v1/person/records`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${employeeAccess}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "RestrictedOnlyC186576" }),
        },
      );
      expect(employeeRestrictedSearch.status).toBe(200);
      expect((await responseJson(employeeRestrictedSearch)).items).toEqual([]);

      provider.email = "founder@example.com";
      const ownerList = await fetch(`${origin}/v1/person/records`, {
        headers: { authorization: `Bearer ${ownerAccess}` },
      });
      expect(ownerList.status).toBe(200);
      expect((await responseJson(ownerList)).records).toHaveLength(2);
      const ownerRestrictedSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerAccess}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "RestrictedOnlyC186576" }),
      });
      expect(ownerRestrictedSearch.status).toBe(200);
      expect((await responseJson(ownerRestrictedSearch)).items).toHaveLength(1);
    } finally {
      record.close();
      authority.close();
      await fixture.runtime.close();
    }
  });

  it("records a synthetic Slack rejection without a readable V4 record or Layer 2 result", async () => {
    const fixture = await activeFixture("reject");
    const authority = openAuthorityDatabase(
      join(fixture.initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    const record = openOrganizationRecordDatabase(
      join(fixture.initialized.state_directory, "record-log.sqlite"),
      { fileMustExist: true },
    );
    try {
      await waitFor(
        () => fixture.reaction.calls() === 1,
        "D2 rejection finalization",
      );
      if (fixture.errors[0] !== undefined) throw fixture.errors[0];
      // A rejection is durably recorded for replay/audit, but it is not a
      // readable content record and therefore never becomes a Layer 2 atom.
      expect(
        record
          .prepare("SELECT count(*) AS count FROM organization_record_log")
          .get(),
      ).toEqual({ count: 1 });
      const authorization = ownerAuthorization({
        organization_id: fixture.initialized.organization_id,
        principal_id: fixture.initialized.owner_principal_id,
        membership_id: fixture.initialized.owner_membership_id,
      });
      const list = createCleanPersonRecordReadRouteV1({
        authority_id: fixture.initialized.authority_id,
        organization_id: fixture.initialized.organization_id,
        state_lineage_id: fixture.initialized.state_lineage_id,
        sessions: { authenticateAccess: () => authorization },
        records: new CleanPersonRecordReaderV1(record),
        audit: new SqliteCleanPersonRecordReadAuditV1(authority),
      });
      expect(
        list.list({ access_token: "synthetic-founder-token" }).records,
      ).toEqual([]);
      const search = createCleanPersonRecordSearchRouteV1({
        state_directory: fixture.initialized.state_directory,
        authority_id: fixture.initialized.authority_id,
        organization_id: fixture.initialized.organization_id,
        state_lineage_id: fixture.initialized.state_lineage_id,
        retrieval_contract_sha256:
          cleanReadableSearchRuntimeContractV1().retrieval_contract_sha256,
        sessions: { authenticateAccess: () => authorization },
        authority,
        record,
        audit: new SqliteCleanPersonRecordReadAuditV1(authority),
      });
      expect(
        search.search({
          access_token: "synthetic-founder-token",
          query: "ship live migration",
        }).items,
      ).toEqual([]);
    } finally {
      record.close();
      authority.close();
      await fixture.runtime.close();
    }
  });
});
