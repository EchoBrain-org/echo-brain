import {
  validateExternalHumanIdentityLinkContractV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type ExternalHumanIdentityLinkContractV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
  type PersonMembershipType,
} from "../application/organization-tool-connection-contracts-v2.js";
import type { ApprovalContractSha256 } from "../application/record-visibility-policy-contracts-v1.js";
import type { PrivateApprovalSlackIdentityLinkV1 } from "../application/private-approval-policy-resolution-v1.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type Database from "better-sqlite3";

/** One validated contract body together with its canonical digest. */
export interface FrozenApprovalContractV2<T> {
  readonly body: T;
  readonly sha256: ApprovalContractSha256;
}

/** Additional observed scopes required to open and reconcile a private DM. */
export const SLACK_DM_APPROVAL_REQUIRED_SCOPES = Object.freeze([
  "im:history",
  "im:write",
] as const);

const SLACK_HUMAN_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;

export interface CurrentSlackDmApprovalReviewerV1 {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
}

/** The Authority coordinates that fence a delivery target to one lineage. */
export interface SlackDmApprovalReviewerTargetCoordinatesV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

/**
 * The exact current provider commitments needed to open a private Slack DM.
 * This proves delivery eligibility only; it deliberately grants no approval
 * authority. A later assignment capability remains the action-time boundary.
 */
export interface CurrentSlackDmApprovalReviewerTargetV1 {
  readonly connection: FrozenApprovalContractV2<OrganizationToolConnectionContractV2>;
  readonly connection_state: FrozenApprovalContractV2<OrganizationToolConnectionStateV2>;
  readonly current_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
}

interface ConnectionRow {
  readonly contract_json: string;
  readonly contract_sha256: string;
  readonly state_json: string;
  readonly state_sha256: string;
  readonly current_status: "active" | "revoked";
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

function frozen<T>(
  json: string,
  sha256: string,
  label: string,
  validate: (value: unknown) => T,
): FrozenApprovalContractV2<T> {
  const parsed = parseCanonical(json, label);
  if (canonicalSha256(parsed) !== sha256) {
    throw new Error(`${label} digest is invalid`);
  }
  return Object.freeze({
    body: validate(parsed),
    sha256: sha256 as `sha256:${string}`,
  });
}

function sameCoordinates(
  connection: OrganizationToolConnectionContractV2,
  state: SlackDmApprovalReviewerTargetCoordinatesV1,
): boolean {
  return (
    connection.authority_id === state.authority_id &&
    connection.organization_id === state.organization_id &&
    connection.state_lineage_id === state.state_lineage_id &&
    connection.tool_kind === "slack"
  );
}

function stateIsPrivateDmEligible(
  connection: OrganizationToolConnectionContractV2,
  state: OrganizationToolConnectionStateV2,
): boolean {
  return [
    ...connection.required_provider_scopes,
    ...SLACK_DM_APPROVAL_REQUIRED_SCOPES,
  ].every((scope) => state.observed_granted_scopes.includes(scope));
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
 * Resolves one exact, active Slack identity for a current approval reviewer.
 *
 * Missing, inactive, ambiguous, or DM-scope-ineligible provider state is a
 * normal no-target outcome. Canonical-body, digest-chain, or projection/body
 * disagreement is stored-state corruption and therefore throws.
 */
export function resolveCurrentSlackDmApprovalReviewerTargetV1(
  database: Database.Database,
  state: SlackDmApprovalReviewerTargetCoordinatesV1,
  connectionId: string,
  reviewer: CurrentSlackDmApprovalReviewerV1,
): CurrentSlackDmApprovalReviewerTargetV1 | undefined {
  const connectionRow = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256,
              current_state.state_json, current_state.state_sha256,
              current_state.current_status
       FROM organization_tool_connection_contracts AS contract
       JOIN organization_tool_connection_current_state AS current_state
         ON current_state.connection_id = contract.connection_id
        AND current_state.connection_contract_sha256 = contract.contract_sha256
       WHERE contract.connection_id = ?`,
    )
    .get(connectionId) as ConnectionRow | undefined;
  if (connectionRow === undefined || connectionRow.current_status !== "active") {
    return undefined;
  }
  const connection = frozen(
    connectionRow.contract_json,
    connectionRow.contract_sha256,
    "stored private approval Slack connection contract",
    validateOrganizationToolConnectionContractV2,
  );
  const connectionState = frozen(
    connectionRow.state_json,
    connectionRow.state_sha256,
    "stored private approval Slack connection state",
    validateOrganizationToolConnectionStateV2,
  );
  if (
    connection.body.connection_id !== connectionId ||
    connectionState.body.connection_id !== connection.body.connection_id ||
    connectionState.body.connection_contract_sha256 !== connection.sha256 ||
    connectionState.body.connection_status !== "active"
  ) {
    throw new Error("stored private approval Slack connection state is inconsistent");
  }
  if (!sameCoordinates(connection.body, state)) return undefined;
  if (!stateIsPrivateDmEligible(connection.body, connectionState.body)) {
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
      connection.body.provider_tenant_id,
      connection.body.provider_enterprise_id,
      connection.body.provider_enterprise_id,
    ) as LinkRow[];
  if (links.length !== 1 || links[0] === undefined) return undefined;

  const row = links[0];
  const frozenLink = frozen(
    row.contract_json,
    row.contract_sha256,
    "stored private approval Slack identity link",
    validateExternalHumanIdentityLinkContractV2,
  );
  const link = frozenLink.body;
  if (!currentRowMatchesLink(row, link, frozenLink.sha256)) {
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
    link.provider_tenant_id !== connection.body.provider_tenant_id ||
    link.provider_enterprise_id !== connection.body.provider_enterprise_id ||
    !SLACK_HUMAN_SUBJECT.test(link.provider_subject_id)
  ) {
    return undefined;
  }
  return Object.freeze({
    connection,
    connection_state: connectionState,
    current_slack_identity_link: Object.freeze({
      provider: "slack",
      external_identity_link_id: link.external_identity_link_id,
      external_identity_link_contract_sha256: frozenLink.sha256,
      provider_subject_id: link.provider_subject_id,
    }),
  });
}
