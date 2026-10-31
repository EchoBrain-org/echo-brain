import { validateExternalHumanIdentityLinkContractV2, type ExternalHumanIdentityLinkContractV2, type PersonMembershipType } from "../application/organization-tool-connection-contracts-v2.js";
import type { ApprovalContractSha256 } from "@echo-brain/organization-control-plane/application/record-visibility-policy-contracts-v1";
import { canonicalJson, canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import type Database from "better-sqlite3";
import type { SlackApprovalTargetV1 } from "../../private-approval/slack-approval-presenter-v1.js";
import { readActiveSlackConnectionV1, type SlackConnectionCoordinatesV1, type StoredSlackConnectionV1 } from "./sqlite-slack-active-connection-v1.js";

/** Exact Slack external-human-link commitment for the assigned human. */
interface PrivateApprovalSlackIdentityLinkV1 {
  readonly provider: "slack";
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: ApprovalContractSha256;
  readonly provider_subject_id: string;
}

const SLACK_HUMAN_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;

interface CurrentSlackDmApprovalReviewerV1 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
}

interface LinkRow {
  readonly external_identity_link_id: string;
  readonly contract_json: string;
  readonly contract_sha256: string;
  readonly current_contract_sha256: string;
  readonly current_status: "active" | "revoked";
  readonly provider_issuer: string;
  readonly provider_tenant_kind: string;
  readonly provider_tenant_id: string;
  readonly provider_enterprise_id: string | null;
  readonly provider_subject_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}

function parseCanonical(json: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== json) {
    throw new Error(`${label} is not canonical`);
  }
  return parsed;
}

function currentRowMatchesLink(
  row: LinkRow,
  link: ExternalHumanIdentityLinkContractV2,
  frozenLinkSha256: string,
): boolean {
  return (
    row.current_status === "active" &&
    row.external_identity_link_id === link.external_identity_link_id &&
    row.contract_sha256 === frozenLinkSha256 &&
    row.current_contract_sha256 === frozenLinkSha256 &&
    row.provider_issuer === link.provider_issuer &&
    row.provider_tenant_kind === link.provider_tenant_kind &&
    row.provider_tenant_id === link.provider_tenant_id &&
    row.provider_enterprise_id === link.provider_enterprise_id &&
    row.provider_subject_id === link.provider_subject_id &&
    row.principal_id === link.principal_id &&
    row.membership_id === link.membership_id
  );
}

/**
 * One exact, active Slack identity for a current approval reviewer on the active connection, which
 * `readActiveSlackConnectionV1` has already proven for this lineage. It proves delivery eligibility only and grants no
 * approval authority.
 *
 * Missing, inactive, ambiguous, or DM-scope-ineligible provider state is a
 * normal no-target outcome. Canonical-body, digest-chain, or projection/body
 * disagreement is stored-state corruption and therefore throws.
 */
function currentSlackIdentityLink(
  database: Database.Database,
  state: SlackConnectionCoordinatesV1,
  active: StoredSlackConnectionV1,
  reviewer: CurrentSlackDmApprovalReviewerV1,
): PrivateApprovalSlackIdentityLinkV1 | undefined {
  const { connection } = active;
  // A body stored under another connection's row is no target.
  if (database.prepare("SELECT 1 FROM organization_tool_connection_contracts WHERE connection_id = ? AND contract_sha256 = ?")
    .get(connection.connection_id, active.contract_sha256) === undefined) return undefined;
  if (active.state.connection_id !== connection.connection_id) {
    throw new Error("stored private approval Slack connection state is inconsistent");
  }
  // A private DM needs every scope the connection requires.
  if (!connection.required_provider_scopes.every((scope) => active.state.observed_granted_scopes.includes(scope))) {
    return undefined;
  }

  const links = database
    .prepare(
      `SELECT current_link.external_identity_link_id,
              contract.contract_json, contract.contract_sha256,
              current_link.contract_sha256 AS current_contract_sha256,
              current_link.current_status, current_link.provider_issuer,
              current_link.provider_tenant_kind, current_link.provider_tenant_id,
              current_link.provider_enterprise_id, current_link.provider_subject_id,
              current_link.principal_id, current_link.membership_id
       FROM organization_external_human_link_current AS current_link
       JOIN organization_external_human_link_contracts AS contract
         ON contract.external_identity_link_id = current_link.external_identity_link_id
        AND contract.contract_sha256 = current_link.contract_sha256
       WHERE current_link.current_status = 'active'
         AND current_link.principal_id = ?
         AND current_link.membership_id = ?
         AND current_link.provider_issuer = 'https://slack.com'
         AND current_link.provider_tenant_kind = 'workspace'
         AND current_link.provider_tenant_id = ?
         AND (current_link.provider_enterprise_id IS ?
              OR current_link.provider_enterprise_id = ?)
       ORDER BY current_link.external_identity_link_id ASC`,
    )
    .all(
      reviewer.principal_id,
      reviewer.membership_id,
      connection.provider_tenant_id,
      connection.provider_enterprise_id,
      connection.provider_enterprise_id,
    ) as LinkRow[];
  if (links.length !== 1 || links[0] === undefined) return undefined;

  const row = links[0];
  const label = "stored private approval Slack identity link";
  const parsed = parseCanonical(row.contract_json, label);
  if (canonicalSha256(parsed) !== row.contract_sha256) {
    throw new Error(`${label} digest is invalid`);
  }
  const link = validateExternalHumanIdentityLinkContractV2(parsed);
  const linkSha256 = row.contract_sha256 as ApprovalContractSha256;
  if (!currentRowMatchesLink(row, link, linkSha256)) {
    throw new Error("stored private approval Slack identity link is inconsistent");
  }
  if (
    link.authority_id !== state.authority_id ||
    link.organization_id !== state.organization_id ||
    link.state_lineage_id !== state.state_lineage_id ||
    link.principal_id !== reviewer.principal_id ||
    link.membership_id !== reviewer.membership_id ||
    link.membership_type !== reviewer.membership_type ||
    link.provider_issuer !== "https://slack.com" ||
    link.provider_tenant_kind !== "workspace" ||
    link.provider_tenant_id !== connection.provider_tenant_id ||
    link.provider_enterprise_id !== connection.provider_enterprise_id ||
    !SLACK_HUMAN_SUBJECT.test(link.provider_subject_id)
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: "slack",
    external_identity_link_id: link.external_identity_link_id,
    external_identity_link_contract_sha256: linkSha256,
    provider_subject_id: link.provider_subject_id,
  });
}

/**
 * The approval card target for a current reviewer on the active connection, or null when the reviewer has no
 * exact, DM-eligible Slack identity there.
 */
export function resolveSlackDmApprovalTargetV1(
  database: Database.Database,
  state: SlackConnectionCoordinatesV1,
  reviewer: CurrentSlackDmApprovalReviewerV1,
): SlackApprovalTargetV1 | null {
  const active = readActiveSlackConnectionV1(database, state);
  if (active === undefined) return null;
  const link = currentSlackIdentityLink(database, state, active, reviewer);
  if (link === undefined) return null;
  return {
    connection_id: active.connection.connection_id,
    external_identity_link_id: link.external_identity_link_id,
    external_identity_link_contract_sha256: link.external_identity_link_contract_sha256,
    slack_workspace_id: active.connection.provider_tenant_id,
    slack_subject_id: link.provider_subject_id,
    api_app_id: active.connection.provider_app_id,
  };
}

/**
 * Whether a stored card target still names the active connection and app, and an active identity link with the
 * same contract and Slack user.
 */
export function isCurrentSlackDmApprovalTargetV1(
  database: Database.Database,
  state: SlackConnectionCoordinatesV1,
  target: SlackApprovalTargetV1,
): boolean {
  const active = readActiveSlackConnectionV1(database, state);
  if (
    active === undefined ||
    active.connection.connection_id !== target.connection_id ||
    active.connection.provider_tenant_id !== target.slack_workspace_id ||
    active.connection.provider_app_id !== target.api_app_id
  )
    return false;
  return (
    database
      .prepare(
        `SELECT 1 FROM organization_external_human_link_current WHERE external_identity_link_id=? AND contract_sha256=? AND current_status='active' AND provider_subject_id=?`,
      )
      .get(target.external_identity_link_id, target.external_identity_link_contract_sha256, target.slack_subject_id) !== undefined
  );
}

/** A clicking Slack user resolved to one ECHO member and the identity link the click is checked against. */
interface SlackApprovalClickActorV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly connection_id: string;
  readonly api_app_id: string;
  readonly external_identity_link_id: string;
  readonly contract_sha256: string;
}

/**
 * The one active owner or employee, among `members`, whose current Slack identity on the active connection is the
 * clicking user in its workspace; null when none or several match.
 */
export function matchSlackApprovalClickActorV1(
  database: Database.Database,
  state: SlackConnectionCoordinatesV1,
  click: { readonly workspace_id: string; readonly subject_id: string },
  members: readonly {
    readonly organization_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: string;
  }[],
): SlackApprovalClickActorV1 | null {
  const active = readActiveSlackConnectionV1(database, state);
  if (active === undefined || active.connection.provider_tenant_id !== click.workspace_id) return null;
  const matches = members.flatMap((actor) => {
    if (actor.membership_type !== "owner" && actor.membership_type !== "employee") return [];
    const link = currentSlackIdentityLink(database, state, active, {
      principal_id: actor.principal_id,
      membership_id: actor.membership_id,
      membership_type: actor.membership_type,
    });
    return link === undefined || link.provider_subject_id !== click.subject_id ? [] : [{ actor, link }];
  });
  if (matches.length !== 1 || matches[0] === undefined) return null;
  const { actor, link } = matches[0];
  return {
    organization_id: actor.organization_id,
    principal_id: actor.principal_id,
    membership_id: actor.membership_id,
    connection_id: active.connection.connection_id,
    api_app_id: active.connection.provider_app_id,
    external_identity_link_id: link.external_identity_link_id,
    contract_sha256: link.external_identity_link_contract_sha256,
  };
}
