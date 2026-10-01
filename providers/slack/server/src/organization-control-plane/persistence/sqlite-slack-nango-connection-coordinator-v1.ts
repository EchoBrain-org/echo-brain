import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import type { NangoSlackConnectionV1 } from "../adapters/nango/nango-connection-client-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../adapters/slack/slack-app-manifest-provider-v1.js";
import { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../application/organization-tool-connection-contracts-v2.js";
import { findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../application/slack-app-credentials-v1.js";
import type { OrganizationSecretReference, OrganizationSecretStore, VerifiedSlackConnection } from "../application/slack-integration-contracts.js";
import { assertSlackConnectionMetadataV1, insertActiveSlackConnectionV1, outstandingPrivateApprovalCountV1, readActiveSlackConnectionV1, slackNangoAppPublicConfigurationSha256V1, type StoredSlackConnectionV1 } from "./sqlite-slack-active-connection-v1.js";
import { SlackConnectionConflictError, type SlackConnectionVerifierV1 } from "./sqlite-slack-connection-coordinator-v1.js";
import type Database from "better-sqlite3";

export type SlackConnectionRefusalReasonV1 =
  | "workspace_mismatch"
  | "permissions_missing"
  | "confirmation_required"
  | "approvals_outstanding";

const REFUSAL_MESSAGES: Readonly<Record<SlackConnectionRefusalReasonV1, string>> = {
  workspace_mismatch: "the Slack install does not match this organization's Slack app and workspace",
  permissions_missing: "the Slack install did not grant every permission ECHO needs",
  confirmation_required: "replacing the active Slack connection requires confirmation",
  approvals_outstanding: "approvals are still waiting under the active Slack connection",
};

/** An expected refusal the owner can act on; never carries a secret. */
export class SlackConnectionRefusedErrorV1 extends Error {
  constructor(
    readonly reason: SlackConnectionRefusalReasonV1,
    readonly outstanding_approvals: number | null,
    message: string = REFUSAL_MESSAGES[reason],
  ) {
    super(message);
    this.name = "SlackConnectionRefusedErrorV1";
  }
}

export interface ActivateNangoSlackConnectionInputV1 {
  readonly database: Database.Database;
  readonly secrets: OrganizationSecretStore;
  readonly verifier: Pick<SlackConnectionVerifierV1, "verifyConnection">;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly credential: {
    readonly reference: OrganizationSecretReference;
    readonly credentials: SlackAppCredentialsV1;
  };
  readonly nango: NangoSlackConnectionV1;
  readonly confirm_replacement: boolean;
  readonly now: () => string;
  readonly new_connection_id: () => string;
  readonly signal?: AbortSignal;
}

export type ActivatedNangoSlackConnectionV1 = {
  readonly kind: "created" | "reconnected" | "replaced";
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
  readonly person_links_revoked: number;
};

function grantsRecipeScopes(granted: readonly string[]): boolean {
  return SLACK_PRIVATE_APP_BOT_SCOPES_V1.every((scope) => granted.includes(scope));
}

/** Nango's install and Slack's auth.test must name the same app, workspace and bot. */
async function verifyInstall(
  input: ActivateNangoSlackConnectionInputV1,
): Promise<VerifiedSlackConnection> {
  const { nango } = input;
  if (nango.app_id !== input.credential.credentials.app_id || nango.is_enterprise_install) {
    throw new SlackConnectionRefusedErrorV1("workspace_mismatch", null);
  }
  if (!grantsRecipeScopes(nango.granted_scopes)) {
    throw new SlackConnectionRefusedErrorV1("permissions_missing", null);
  }
  const verified = await input.verifier.verifyConnection(nango.bot_token, input.signal);
  if (
    verified.team_id !== nango.team_id ||
    verified.app_id !== nango.app_id ||
    verified.bot_user_id !== nango.bot_user_id
  ) {
    throw new SlackConnectionRefusedErrorV1("workspace_mismatch", null);
  }
  if (!grantsRecipeScopes(verified.granted_scopes)) {
    throw new SlackConnectionRefusedErrorV1("permissions_missing", null);
  }
  return verified;
}

/** True when the active Nango connection is this exact install; refuses a second Nango connection for its app. */
function isSameNangoConnection(
  active: StoredSlackConnectionV1,
  input: ActivateNangoSlackConnectionInputV1,
  verified: VerifiedSlackConnection,
): boolean {
  const bundle = findSlackAppCredentialsByReferenceSha256V1(
    input.secrets,
    active.state.credential_reference_sha256,
  ).credentials;
  if (bundle.app_id !== input.nango.app_id) return false;
  if (bundle.nango_connection_id !== input.nango.connection_id) {
    throw new SlackConnectionRefusedErrorV1(
      "workspace_mismatch",
      null,
      "reconnect requires the same Nango connection",
    );
  }
  const { connection } = active;
  return (
    connection.provider_app_id === verified.app_id &&
    connection.provider_tenant_id === verified.team_id &&
    connection.provider_enterprise_id === verified.enterprise_id &&
    connection.provider_bot_id === verified.bot_id &&
    connection.provider_bot_user_id === verified.bot_user_id
  );
}

/** Status-column-only revoke: waiting cards reference the old state by foreign key. */
function retireConnection(
  database: Database.Database,
  old: StoredSlackConnectionV1,
  next: OrganizationToolConnectionContractV2,
  now: string,
): number {
  const revoked = database
    .prepare(
      `UPDATE organization_tool_connection_current_state
       SET current_status = 'revoked', updated_at = ?
       WHERE connection_id = ? AND current_status = 'active'`,
    )
    .run(now, old.connection.connection_id);
  if (revoked.changes !== 1) {
    throw new SlackConnectionConflictError("the active Slack connection changed during activation");
  }
  database
    .prepare(
      `UPDATE organization_person_slack_link_challenges
       SET status = 'expired', completed_at = ?
       WHERE connection_id = ? AND status = 'pending'`,
    )
    .run(now, old.connection.connection_id);
  if (
    old.connection.provider_tenant_id === next.provider_tenant_id &&
    old.connection.provider_enterprise_id === next.provider_enterprise_id
  ) {
    return 0;
  }
  return database
    .prepare(
      `UPDATE organization_external_human_link_current
       SET current_status = 'revoked', updated_at = ?
       WHERE provider_issuer = 'https://slack.com'
         AND provider_tenant_kind = 'workspace'
         AND provider_tenant_id = ?
         AND COALESCE(provider_enterprise_id, '') = COALESCE(?, '')
         AND current_status = 'active'`,
    )
    .run(now, old.connection.provider_tenant_id, old.connection.provider_enterprise_id)
    .changes;
}

/**
 * Turns a finished Nango install into the organization's Slack connection:
 * created when none is active, reconnected (no write, same state hash) on the
 * same Nango connection, or replaced only with confirmation and no waiting
 * approval card.
 */
export async function activateNangoSlackConnectionV1(
  input: ActivateNangoSlackConnectionInputV1,
): Promise<ActivatedNangoSlackConnectionV1> {
  assertSlackConnectionMetadataV1(input.database, input);
  const verified = await verifyInstall(input);
  const before = readActiveSlackConnectionV1(input.database);
  if (before?.kind === "nango" && isSameNangoConnection(before, input, verified)) {
    return Object.freeze({
      kind: "reconnected",
      connection: before.connection,
      state: before.state,
      person_links_revoked: 0,
    });
  }
  if (before !== undefined && !input.confirm_replacement) {
    throw new SlackConnectionRefusedErrorV1("confirmation_required", null);
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
  let personLinksRevoked = 0;
  let state: OrganizationToolConnectionStateV2;
  try {
    state = buildOrganizationToolConnectionStateV2({
      connection_id: connection.connection_id,
      connection_contract_sha256: canonicalSha256(connection),
      connection_status: "active",
      credential_reference_sha256: canonicalSha256(bundle),
      observed_granted_scopes: [...new Set(verified.granted_scopes)].sort(),
      verification_event_id: `nango_${connection.connection_id}`,
      verification_evidence_sha256: canonicalSha256({
        connection_verification_evidence_sha256: verified.verification_evidence_sha256,
        kind: "echo-slack-nango-connection-verification-v1",
      }),
      verification_revision: 1,
      verified_at: now,
    });
    personLinksRevoked = input.database
      .transaction(() => {
        const current = readActiveSlackConnectionV1(input.database);
        if (current?.state_sha256 !== before?.state_sha256) {
          throw new SlackConnectionConflictError("the active Slack connection changed during activation");
        }
        let revoked = 0;
        if (current !== undefined) {
          const outstanding = outstandingPrivateApprovalCountV1(input.database, current.connection.connection_id);
          if (outstanding > 0) {
            throw new SlackConnectionRefusedErrorV1("approvals_outstanding", outstanding);
          }
          revoked = retireConnection(input.database, current, connection, now);
        }
        insertActiveSlackConnectionV1(input.database, { connection, state, now });
        return revoked;
      })
      .immediate();
    committed = true;
  } finally {
    if (!committed) input.secrets.remove(bundle);
  }

  input.secrets.remove(input.credential.reference);
  if (before?.kind === "nango") {
    for (const reference of input.secrets.listReferences()) {
      if (canonicalSha256(reference) === before.state.credential_reference_sha256) {
        input.secrets.remove(reference);
      }
    }
  }
  return Object.freeze({
    kind: before === undefined ? "created" : "replaced",
    connection,
    state,
    person_links_revoked: personLinksRevoked,
  });
}
