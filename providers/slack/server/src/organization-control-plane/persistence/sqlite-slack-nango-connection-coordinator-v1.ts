import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import type { NangoSlackConnectionV1 } from "../adapters/nango/nango-connection-client-v1.js";
import { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../application/organization-tool-connection-contracts-v2.js";
import { findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../application/slack-app-credentials-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, type OrganizationSecretReference, type OrganizationSecretStore, type VerifiedSlackConnection } from "../application/slack-integration-contracts.js";
import { assertSlackConnectionMetadataV1, insertActiveSlackConnectionV1, readActiveSlackConnectionV1, slackNangoAppPublicConfigurationSha256V1, type StoredSlackConnectionV1 } from "./sqlite-slack-active-connection-v1.js";
import type Database from "better-sqlite3";

/** Slack's `auth.test` check of an installed bot token. */
export interface SlackConnectionVerifierV1 {
  verifyConnection(
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection>;
}

export class SlackConnectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConnectionConflictError";
  }
}

export type SlackConnectionRefusalReasonV1 =
  | "workspace_mismatch"
  | "permissions_missing"
  | "already_connected";

const REFUSAL_MESSAGES: Readonly<Record<SlackConnectionRefusalReasonV1, string>> = {
  workspace_mismatch: "the Slack install does not match this organization's Slack app and workspace",
  permissions_missing: "the Slack install did not grant every permission ECHO needs",
  already_connected: "Slack is already connected to a different app or workspace.",
};

/** An expected refusal the owner can act on; never carries a secret. */
export class SlackConnectionRefusedErrorV1 extends Error {
  constructor(
    readonly reason: SlackConnectionRefusalReasonV1,
    message: string = REFUSAL_MESSAGES[reason],
  ) {
    super(message);
    this.name = "SlackConnectionRefusedErrorV1";
  }
}

export interface ActivateNangoSlackConnectionInputV1 {
  readonly database: Database.Database;
  readonly secrets: OrganizationSecretStore;
  readonly verifier: SlackConnectionVerifierV1;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly credential: {
    readonly reference: OrganizationSecretReference;
    readonly credentials: SlackAppCredentialsV1;
  };
  readonly nango: NangoSlackConnectionV1;
  readonly now: () => string;
  readonly new_connection_id: () => string;
  readonly signal?: AbortSignal;
}

export type ActivatedNangoSlackConnectionV1 = {
  readonly kind: "created" | "reconnected";
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
};

function grantsRecipeScopes(granted: readonly string[]): boolean {
  return SLACK_PRIVATE_APP_BOT_SCOPES_V1.every((scope) => granted.includes(scope));
}

/** Nango's install and Slack's auth.test must name the same app, workspace and bot. */
async function verifyInstall(
  input: ActivateNangoSlackConnectionInputV1,
): Promise<VerifiedSlackConnection> {
  const { nango } = input;
  // The Nango parser already refuses an Enterprise Grid org-wide install.
  if (nango.app_id !== input.credential.credentials.app_id) {
    throw new SlackConnectionRefusedErrorV1("workspace_mismatch");
  }
  if (!grantsRecipeScopes(nango.granted_scopes)) {
    throw new SlackConnectionRefusedErrorV1("permissions_missing");
  }
  const verified = await input.verifier.verifyConnection(nango.bot_token, input.signal);
  if (
    verified.team_id !== nango.team_id ||
    verified.app_id !== nango.app_id ||
    verified.bot_user_id !== nango.bot_user_id
  ) {
    throw new SlackConnectionRefusedErrorV1("workspace_mismatch");
  }
  if (!grantsRecipeScopes(verified.granted_scopes)) {
    throw new SlackConnectionRefusedErrorV1("permissions_missing");
  }
  return verified;
}

/** True when the active connection's bundle names this app and this Nango connection. */
function namesActiveNangoConnection(
  active: StoredSlackConnectionV1,
  input: ActivateNangoSlackConnectionInputV1,
): boolean {
  const bundle = findSlackAppCredentialsByReferenceSha256V1(
    input.secrets,
    active.state.credential_reference_sha256,
  ).credentials;
  return bundle.app_id === input.nango.app_id && bundle.nango_connection_id === input.nango.connection_id;
}

function sameProviderIdentity(
  connection: OrganizationToolConnectionContractV2,
  verified: VerifiedSlackConnection,
): boolean {
  return (
    connection.provider_app_id === verified.app_id &&
    connection.provider_tenant_id === verified.team_id &&
    connection.provider_enterprise_id === verified.enterprise_id &&
    connection.provider_bot_id === verified.bot_id &&
    connection.provider_bot_user_id === verified.bot_user_id
  );
}

function observedScopes(verified: VerifiedSlackConnection): string[] {
  return [...new Set(verified.granted_scopes)].sort();
}

function stateVerificationEvidenceSha256(verified: VerifiedSlackConnection): `sha256:${string}` {
  return canonicalSha256({
    connection_verification_evidence_sha256: verified.verification_evidence_sha256,
    kind: "echo-slack-nango-connection-verification-v1",
  });
}

/**
 * Turns a finished Nango install into the organization's Slack connection:
 * created when no connection is active, or reconnected (no write, same state
 * hash) on the exact same Nango connection. That connection now holding
 * another workspace or bot refuses it as workspace_mismatch; the owner
 * reconnects to the original one. Any other active connection refuses the
 * install as already_connected. ECHO writes nothing for either: replacing an
 * organization's connection is out of scope for v1 because it leaves decided
 * approval cards unable to restart. A connection stored before in-app setup
 * refuses it too, with the replace-rehearsal message.
 */
export async function activateNangoSlackConnectionV1(
  input: ActivateNangoSlackConnectionInputV1,
): Promise<ActivatedNangoSlackConnectionV1> {
  assertSlackConnectionMetadataV1(input.database, input);
  const verified = await verifyInstall(input);
  const before = readActiveSlackConnectionV1(input.database);
  if (before !== undefined) {
    if (!namesActiveNangoConnection(before, input)) {
      throw new SlackConnectionRefusedErrorV1("already_connected");
    }
    if (!sameProviderIdentity(before.connection, verified)) {
      throw new SlackConnectionRefusedErrorV1("workspace_mismatch");
    }
    return Object.freeze({
      kind: "reconnected",
      connection: before.connection,
      state: before.state,
    });
  }

  const now = input.now();
  const connection = buildOrganizationToolConnectionContractV2({
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    state_lineage_id: input.state_lineage_id,
    connection_id: input.new_connection_id(),
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: verified.team_id,
    provider_enterprise_id: verified.enterprise_id,
    tool_kind: "slack",
    provider_app_id: verified.app_id,
    provider_bot_id: verified.bot_id,
    provider_bot_user_id: verified.bot_user_id,
    required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    public_connection_configuration_sha256: slackNangoAppPublicConfigurationSha256V1(),
  });
  const bundle = input.secrets.create(
    serializeSlackAppCredentialsV1({
      ...input.credential.credentials,
      nango_connection_id: input.nango.connection_id,
    }),
  );
  let committed = false;
  let state: OrganizationToolConnectionStateV2;
  try {
    state = buildOrganizationToolConnectionStateV2({
      connection_id: connection.connection_id,
      connection_contract_sha256: canonicalSha256(connection),
      connection_status: "active",
      credential_reference_sha256: canonicalSha256(bundle),
      observed_granted_scopes: observedScopes(verified),
      verification_event_id: `nango_${connection.connection_id}`,
      verification_evidence_sha256: stateVerificationEvidenceSha256(verified),
      verification_revision: 1,
      verified_at: now,
    });
    input.database
      .transaction(() => {
        // `before` is always undefined by this point (the only other path returns earlier),
        // so this is a plain TOCTOU guard: no connection may have appeared since it was read.
        if (readActiveSlackConnectionV1(input.database) !== undefined) {
          throw new SlackConnectionConflictError("the active Slack connection changed during activation");
        }
        insertActiveSlackConnectionV1(input.database, { connection, state, now });
      })
      .immediate();
    committed = true;
  } finally {
    if (!committed) input.secrets.remove(bundle);
  }

  // Best-effort only: the connection already committed, so a failure removing
  // the now-superseded pending bundle must never surface as an error.
  try {
    input.secrets.remove(input.credential.reference);
  } catch {
    // The pending bundle is orphaned but harmless: nothing reads it without the state's reference.
  }
  return Object.freeze({ kind: "created", connection, state });
}

export interface RebindNangoSlackConnectionInputV1 extends ActivateNangoSlackConnectionInputV1 {
  /** The active state, and the Nango connection its bundle named, when Nango no longer had that connection. */
  readonly rebind: { readonly state_sha256: `sha256:${string}`; readonly nango_connection_id: string };
}

/**
 * Points the active connection's credential bundle at a new Nango connection
 * after Nango lost the one it named; the caller checks the loss. The new
 * install must reproduce the stored verification evidence and scopes, so it
 * is the same app, workspace and bot. The bundle must still hold the begin's
 * app credentials and the lost id, and only that id changes, under the same
 * handle. The state row is untouched: the state hash and every outstanding
 * approval card stay valid. Another identity is refused as workspace_mismatch.
 */
export async function rebindNangoSlackConnectionV1(
  input: RebindNangoSlackConnectionInputV1,
): Promise<ActivatedNangoSlackConnectionV1> {
  assertSlackConnectionMetadataV1(input.database, input);
  const verified = await verifyInstall(input);
  return input.database
    .transaction((): ActivatedNangoSlackConnectionV1 => {
      const active = readActiveSlackConnectionV1(input.database);
      if (active === undefined || active.state_sha256 !== input.rebind.state_sha256) {
        throw new SlackConnectionConflictError("the active Slack connection changed during activation");
      }
      const scopes = observedScopes(verified);
      if (
        !sameProviderIdentity(active.connection, verified) ||
        stateVerificationEvidenceSha256(verified) !== active.state.verification_evidence_sha256 ||
        scopes.length !== active.state.observed_granted_scopes.length ||
        scopes.some((scope, index) => scope !== active.state.observed_granted_scopes[index])
      ) {
        throw new SlackConnectionRefusedErrorV1("workspace_mismatch");
      }
      const current = findSlackAppCredentialsByReferenceSha256V1(input.secrets, active.state.credential_reference_sha256);
      const begun = input.credential;
      if (
        current.reference.secret_handle_id !== begun.reference.secret_handle_id ||
        current.credentials.app_id !== begun.credentials.app_id ||
        current.credentials.client_id !== begun.credentials.client_id ||
        current.credentials.client_secret !== begun.credentials.client_secret ||
        current.credentials.signing_secret !== begun.credentials.signing_secret ||
        current.credentials.nango_connection_id !== input.rebind.nango_connection_id
      ) {
        throw new SlackConnectionConflictError("the Slack credential bundle changed during activation");
      }
      input.secrets.replace(
        current.reference,
        serializeSlackAppCredentialsV1({ ...current.credentials, nango_connection_id: input.nango.connection_id }),
      );
      return Object.freeze({ kind: "reconnected", connection: active.connection, state: active.state });
    })
    .immediate();
}
