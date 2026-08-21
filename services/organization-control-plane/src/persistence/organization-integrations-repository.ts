import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AUTHORITY_FILE_SECRET_BACKEND,
  SLACK_DEFAULT_APPROVE_REACTION,
  SLACK_DEFAULT_REJECT_REACTION,
  SLACK_ORGANIZATION_TOOL_PROFILE,
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  SLACK_PROVIDER,
  SLACK_PROVIDER_ISSUER,
  type ActiveSlackOrganizationTool,
  type ActiveSlackApprovalRuntimeBinding,
  type ActivateExistingSlackApprovalInput,
  type ActivateExistingSlackApprovalResult,
  type ApprovalAuthorizationEvidenceLookup,
  type ApprovalAuthorizationEvidenceMatch,
  type BeginPersonSlackIdentityLinkChallengeInput,
  type BeginSlackIdentityLinkChallengeInput,
  type BegunSlackIdentityLinkChallenge,
  type LegacySlackOrganizationTool,
  type UpgradeableSlackOrganizationTool,
  type CompletePersonSlackIdentityLinkChallengeInput,
  type CompleteSlackIdentityLinkChallengeInput,
  type CompletedPersonSlackIdentityLink,
  type CompletedSlackIdentityLink,
  type OnboardSlackOrganizationToolInput,
  type OnboardSlackOrganizationToolResult,
  type OrganizationIntegrationsOverview,
  type OrganizationPermissionPilotEligibilityProof,
  type RecordPermissionDecisionInput,
  type RecordReviewerPermissionDecisionInput,
  type RecordOrganizationMemberReadablePermissionDecisionInput,
  type RecordedPermissionDecision,
  type RecordedReviewerPermissionDecision,
  type RecordedOrganizationMemberReadablePermissionDecision,
  type OrganizationMemberAuthorizationEvidenceExpectation,
  type OrganizationMemberAuthorizationEvidenceMatch,
  type ReviewerAuthorizationEvidenceExpectation,
  type ReviewerAuthorizationEvidenceMatch,
  type ReviewerAuthorizationEvidenceRead,
  type OrganizationIntegrationAuditChainVerification,
  type SlackApprovalPermissionCandidate,
  type SlackApprovalPermissionLookup,
  type OrganizationSecretReference,
  type PendingPersonSlackIdentityLinkChallenge,
  type PendingSlackIdentityLinkChallenge,
} from "../application/contracts.js";
import {
  REVIEWER_RESTRICTED_AUDIT_DETAIL_KIND,
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_POLICY_ID,
  organizationIntegrationAuditEntryPreimage,
  reviewerMessagePresentationPreimage,
  reviewerRestrictedSemanticPreimage,
  type OrganizationIntegrationAuditEntryPreimageInput,
} from "../application/reviewer-restricted-policy.js";
import { ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE } from "../application/organization-member-readable-policy.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../canonical/canonical-json.js";

interface AuditTail {
  audit_sequence: number;
  entry_sha256: string;
}

interface AuditReplayRow {
  detail_json: string;
}

interface ApprovalAuthorizationEvidenceRow {
  reason_code: string;
  detail_json: string;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PERSON_SLACK_IDENTITY_LINK_REDIRECT_URI =
  "urn:echo:organization:person:slack-channel-link";
const PERSON_SLACK_IDENTITY_LINK_AUDIT_ACTION =
  "person_slack_identity_link.completed";

function permissionPilotEligibilityFromAudit(
  row: ApprovalAuthorizationEvidenceRow,
  action: ApprovalAuthorizationEvidenceLookup["action"],
): OrganizationPermissionPilotEligibilityProof | null | undefined {
  if (
    row.reason_code !==
    "active_membership_direct_grant_pilot_notice_v1"
  ) {
    return null;
  }
  if (action !== "approve") return undefined;
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json) as unknown;
  } catch {
    return undefined;
  }
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  const value = detail as Record<string, unknown>;
  if (
    value["presentation_policy_id"] !==
      "pilot-two-person-audience-v1" ||
    typeof value["audience_notice_sha256"] !== "string" ||
    !SHA256_DIGEST.test(value["audience_notice_sha256"]) ||
    typeof value["message_presentation_sha256"] !== "string" ||
    !SHA256_DIGEST.test(value["message_presentation_sha256"])
  ) {
    return undefined;
  }
  return Object.freeze({
    policy_id: "pilot-member-readable-v1",
    presentation_policy_id: "pilot-two-person-audience-v1",
    audience_notice_sha256: value["audience_notice_sha256"] as `sha256:${string}`,
    message_presentation_sha256: value[
      "message_presentation_sha256"
    ] as `sha256:${string}`,
  });
}

interface ToolConnectionOverviewRow extends Record<string, unknown> {
  public_configuration_json: string;
  public_configuration_sha256: string;
}

interface ActiveSlackOrganizationToolRow extends ToolConnectionOverviewRow {
  connection_id: string;
  verification_attempt_id: string;
  activated_at: string;
  provider_tenant_id: string;
  provider_subject_id: string;
  granted_scopes_json: string;
  granted_scopes_sha256: string;
  secret_backend_id: string;
  secret_handle_id: string;
}

interface SlackIdentityLinkAttemptRow {
  connection_attempt_id: string;
  requested_by_principal_id: string;
  requested_by_membership_id: string;
  target_principal_id: string;
  target_membership_id: string;
  provider_tenant_id: string;
  state_sha256: string;
  pkce_challenge_sha256: string;
  admin_session_sha256: string;
  status: "pending" | "succeeded" | "failed" | "expired";
  created_at: string;
  expires_at: string;
}

interface ActiveSlackIdentityLinkRow {
  identity_link_id: string;
  principal_id: string;
  membership_id: string;
  provider_subject_id: string;
}

interface ActiveSlackBindingRow {
  adapter_binding_id: string;
  installation_id: string;
  installation_key_id: string;
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  connection_id: string;
  public_configuration_json: string;
  public_configuration_sha256: string;
}

interface SlackAppIdentityBindingPromotion {
  adapter_binding_id: string;
  previous_public_configuration_sha256: string;
  public_configuration_sha256: `sha256:${string}`;
}

interface ActiveSlackApprovalGrantRow {
  permission_grant_id: string;
  principal_id: string;
  membership_id: string;
  action: "approve" | "reject";
  resource_scope_json: string;
}

interface ActiveSlackApprovalRuntimeBindingRow extends ActiveSlackBindingRow {
  identity_link_id: string;
  principal_id: string;
  membership_id: string;
  reviewer_slack_user_id: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
}

interface SlackIdentityLinkCompletionReplayKey {
  challenge_attempt_id: string;
  challenge_code_sha256: `sha256:${string}`;
  challenge_message_ts: string;
  installation: BeginSlackIdentityLinkChallengeInput["installation"];
  organization_tool: ActiveSlackOrganizationTool;
  adapter_id: "slack-reactions";
  adapter_instance_id: string;
  adapter_version: string;
}

interface PersonSlackIdentityLinkCompletionReplayKey {
  challenge_attempt_id: string;
  challenge_code_sha256: `sha256:${string}`;
  challenge_message_ts: string;
  person_session: BeginPersonSlackIdentityLinkChallengeInput["person_session"];
  organization_tool: ActiveSlackOrganizationTool;
}

interface CompleteSlackOrganizationToolAttemptInput {
  attempt_id: string;
  administrator_principal_id: string;
  administrator_membership_id: string;
  team_id: string;
  scopes_json: string;
  scopes_sha256: string;
  subject_id: string;
  evidence_sha256: string;
  command_id: string;
  now: string;
  expires_at: string;
}

export class OrganizationIntegrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationIntegrationConflictError";
  }
}

/**
 * Strings are hashed as their own bytes rather than as canonical JSON. Live
 * `state_sha256`, `nonce_sha256`, `pkce_challenge_sha256`,
 * `admin_session_sha256` and `public_configuration_sha256` values were written
 * that way; quoting them here would break every stored digest.
 */
function digest(value: unknown): `sha256:${string}` {
  return typeof value === "string"
    ? sha256Digest(value)
    : canonicalSha256(value);
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * The one chained-entry hash, used by both append and verification so stored
 * entry bytes never depend on which caller computed them.
 */
export function organizationIntegrationAuditEntrySha256(
  input: OrganizationIntegrationAuditEntryPreimageInput,
): `sha256:${string}` {
  return canonicalSha256(organizationIntegrationAuditEntryPreimage(input));
}

interface ReviewerAuditRow {
  audit_sequence: number;
  audit_event_id: string;
  previous_entry_sha256: string | null;
  entry_sha256: string;
  organization_id: string;
  occurred_at: string;
  actor_kind: string;
  actor_principal_id: string | null;
  actor_membership_id: string | null;
  actor_identity_link_id: string | null;
  actor_installation_id: string | null;
  command_id: string;
  provider_event_sha256: string | null;
  action: string;
  subject_kind: string;
  subject_id: string;
  membership_id: string | null;
  identity_link_id: string | null;
  connection_id: string | null;
  adapter_binding_id: string | null;
  permission_grant_id: string | null;
  outcome: string;
  reason_code: string;
  idempotency_key: string;
  authority_checked_at: string | null;
  authority_evidence_sha256: string | null;
  correlation_id: string;
  detail_json: string;
  detail_sha256: string;
}

const REVIEWER_AUDIT_COLUMNS = `audit_sequence, audit_event_id,
          previous_entry_sha256, entry_sha256, organization_id, occurred_at,
          actor_kind, actor_principal_id, actor_membership_id,
          actor_identity_link_id, actor_installation_id, command_id,
          provider_event_sha256, action, subject_kind, subject_id,
          membership_id, identity_link_id, connection_id, adapter_binding_id,
          permission_grant_id, outcome, reason_code, idempotency_key,
          authority_checked_at, authority_evidence_sha256, correlation_id,
          detail_json, detail_sha256`;

function reviewerAuditDetail(
  row: ReviewerAuditRow,
): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.detail_json) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const detail = parsed as Record<string, unknown>;
  if (canonicalJson(detail) !== row.detail_json) return undefined;
  const exactKeys = [
    "schema_version",
    "kind",
    "authority_id",
    "request_sha256",
    "provider_event_sha256",
    "principal_id",
    "policy_id",
    "provider",
    "provider_issuer",
    "team_id",
    "enterprise_id",
    "bot_user_id",
    "bot_id",
    "app_id",
    "actor_user_id",
    "adapter_id",
    "adapter_instance_id",
    "adapter_version",
    "channel_id",
    "message_ts",
    "reaction_name",
    "approve_reaction",
    "reject_reaction",
    "reviewer_release_draft_sha256",
    "approval_presentation_sha256",
    "semantic_intent_sha256",
    "message_presentation_sha256",
    "message_unedited",
    "consequence_version",
  ].sort();
  if (Object.keys(detail).sort().join("\u0000") !== exactKeys.join("\u0000")) {
    return undefined;
  }
  if (
    detail["kind"] !== REVIEWER_RESTRICTED_AUDIT_DETAIL_KIND ||
    detail["schema_version"] !== 2 ||
    detail["policy_id"] !== RESTRICTED_REVIEWER_POLICY_ID ||
    detail["message_unedited"] !== true
  ) {
    return undefined;
  }
  return detail;
}

function canonicalAuditDetail(
  row: ReviewerAuditRow,
): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.detail_json) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const detail = parsed as Readonly<Record<string, unknown>>;
  return canonicalJson(detail) === row.detail_json ? detail : undefined;
}

function digestField(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): `sha256:${string}` | undefined {
  const value = detail[key];
  return typeof value === "string" && SHA256_DIGEST.test(value)
    ? (value as `sha256:${string}`)
    : undefined;
}

function textField(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = detail[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function addMinutes(value: string, minutes: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("organization integration timestamp is invalid");
  }
  return new Date(timestamp + minutes * 60_000).toISOString();
}

function validatedPublicConfiguration(
  row: {
    public_configuration_json: string;
    public_configuration_sha256: string;
  },
): Record<string, unknown> {
  let parsed: unknown;
  let canonical: string;
  try {
    parsed = JSON.parse(row.public_configuration_json);
    canonical = canonicalJson(parsed);
  } catch {
    throw new Error("stored organization tool configuration is invalid");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    canonical !== row.public_configuration_json ||
    digest(row.public_configuration_json) !== row.public_configuration_sha256
  ) {
    throw new Error("stored organization tool configuration is invalid");
  }
  return parsed as Record<string, unknown>;
}

function validatedSlackToolData(
  row: ActiveSlackOrganizationToolRow,
  error: string,
): {
  configuration: Record<string, unknown>;
  scopes: readonly string[];
} {
  const configuration = validatedPublicConfiguration(row);
  let scopes: unknown;
  let canonicalScopes: string;
  try {
    scopes = JSON.parse(row.granted_scopes_json);
    canonicalScopes = canonicalJson(scopes);
  } catch {
    throw new Error(error);
  }
  if (
    row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string") ||
    canonicalScopes !== row.granted_scopes_json ||
    digest(scopes) !== row.granted_scopes_sha256
  ) {
    throw new Error(error);
  }
  return { configuration, scopes: Object.freeze(scopes) };
}

function hasSlackOrganizationToolScopes(scopes: readonly string[]): boolean {
  const observed = new Set(scopes);
  return SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.every((scope) =>
    observed.has(scope),
  );
}

function slackIdentityLinkSessionSha256(
  input: BeginSlackIdentityLinkChallengeInput["installation"],
): `sha256:${string}` {
  return digest({
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_key_id,
  });
}

/** A new preimage; the landed installation preimage above remains frozen. */
function personSlackIdentityLinkSessionSha256(
  input: BeginPersonSlackIdentityLinkChallengeInput["person_session"],
): `sha256:${string}` {
  return digest({
    kind: "echo-organization-person-slack-link-session-v1",
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    identity_binding_id: input.identity_binding_id,
    session_family_id: input.session_family_id,
  });
}

function slackIdentityLinkToolSha256(
  challengeAttemptId: string,
  tool: ActiveSlackOrganizationTool,
): `sha256:${string}` {
  return digest({
    challenge_attempt_id: challengeAttemptId,
    connection_id: tool.connection_id,
    team_id: tool.team_id,
    enterprise_id: tool.enterprise_id,
    bot_user_id: tool.bot_user_id,
    bot_id: tool.bot_id,
    app_id: tool.app_id,
    channel_id: tool.channel_id,
    approve_reaction: tool.approve_reaction,
    reject_reaction: tool.reject_reaction,
  });
}

function slackIdentityLinkCompletionSha256(
  input: SlackIdentityLinkCompletionReplayKey,
): `sha256:${string}` {
  return digest({
    challenge_attempt_id: input.challenge_attempt_id,
    challenge_code_sha256: input.challenge_code_sha256,
    challenge_message_ts: input.challenge_message_ts,
    installation_sha256: slackIdentityLinkSessionSha256(input.installation),
    organization_tool_sha256: slackIdentityLinkToolSha256(
      input.challenge_attempt_id,
      input.organization_tool,
    ),
    adapter_id: input.adapter_id,
    adapter_instance_id: input.adapter_instance_id,
    adapter_version: input.adapter_version,
  });
}

function personSlackIdentityLinkCompletionSha256(
  input: PersonSlackIdentityLinkCompletionReplayKey,
): `sha256:${string}` {
  return digest({
    kind: "echo-organization-person-slack-link-completion-v1",
    challenge_attempt_id: input.challenge_attempt_id,
    challenge_code_sha256: input.challenge_code_sha256,
    challenge_message_ts: input.challenge_message_ts,
    person_session_sha256: personSlackIdentityLinkSessionSha256(
      input.person_session,
    ),
    organization_tool_sha256: slackIdentityLinkToolSha256(
      input.challenge_attempt_id,
      input.organization_tool,
    ),
  });
}

function slackApprovalBindingConfiguration(
  tool: ActiveSlackOrganizationTool,
): Record<string, unknown> {
  return {
    approve_reaction: tool.approve_reaction,
    channel_id: tool.channel_id,
    reject_reaction: tool.reject_reaction,
    slack_app_id: tool.app_id,
    slack_bot_id: tool.bot_id,
    slack_bot_user_id: tool.bot_user_id,
    slack_enterprise_id: tool.enterprise_id,
  };
}

function slackApprovalBindingMatchesTool(
  binding: ActiveSlackBindingRow,
  tool: ActiveSlackOrganizationTool,
): boolean {
  const configuration = validatedPublicConfiguration(binding);
  const expected = slackApprovalBindingConfiguration(tool);
  return (
    canonicalJson(configuration) === canonicalJson(expected) ||
    canonicalJson(configuration) ===
      canonicalJson({
        ...expected,
        organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
        schema_version: 1,
      })
  );
}

function isExactReadySlackOrganizationToolConfiguration(
  configuration: Readonly<Record<string, unknown>>,
): boolean {
  return (
    Object.keys(configuration).sort().join(",") ===
      [
        "approve_reaction",
        "channel_id",
        "organization_tool_profile",
        "reject_reaction",
        "schema_version",
        "slack_app_id",
        "slack_bot_id",
        "slack_bot_user_id",
        "slack_enterprise_id",
      ].join(",") &&
    configuration["organization_tool_profile"] ===
      SLACK_ORGANIZATION_TOOL_PROFILE &&
    configuration["schema_version"] === 1
  );
}

export class OrganizationIntegrationsRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly identity: {
      organization_id: string;
      authority_id: string;
    },
  ) {
    const metadata = database
      .prepare(
        `SELECT organization_id, authority_id
         FROM organization_control_plane_metadata
         WHERE singleton = 1`,
      )
      .get() as { organization_id: string; authority_id: string } | undefined;
    if (
      metadata === undefined ||
      metadata.organization_id !== identity.organization_id ||
      metadata.authority_id !== identity.authority_id
    ) {
      throw new Error(
        "organization integrations database identity does not match the authority",
      );
    }
  }

  /**
   * Verifies the complete immutable integration-audit chain through its
   * current head.  Reviewer readiness calls this once at startup; checking
   * only the selected row and its immediate predecessor would allow a
   * tampered older ancestor to remain outside the trust decision.
   */
  verifyIntegrationAuditChain(): OrganizationIntegrationAuditChainVerification {
    let rows: ReviewerAuditRow[];
    try {
      rows = this.database
        .prepare(
          `SELECT ${REVIEWER_AUDIT_COLUMNS}
           FROM organization_integration_audit
           ORDER BY audit_sequence ASC`,
        )
        .all() as ReviewerAuditRow[];
    } catch (error) {
      return Object.freeze({
        valid: false,
        entries_verified: 0,
        head_sequence: 0,
        head_entry_sha256: null,
        failure: `integration audit could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    let previous: `sha256:${string}` | null = null;
    let verified = 0;
    for (const [index, row] of rows.entries()) {
      const expectedSequence = index + 1;
      const detail = canonicalAuditDetail(row);
      const failure =
        row.audit_sequence !== expectedSequence
          ? `integration audit sequence ${row.audit_sequence} is not ${expectedSequence}`
          : row.organization_id !== this.identity.organization_id
            ? `integration audit sequence ${row.audit_sequence} belongs to another organization`
            : row.previous_entry_sha256 !== previous
              ? `integration audit sequence ${row.audit_sequence} does not link to its predecessor`
              : detail === undefined
                ? `integration audit sequence ${row.audit_sequence} has noncanonical detail`
                : digest(detail) !== row.detail_sha256
                  ? `integration audit sequence ${row.audit_sequence} has a mismatched detail digest`
                  : organizationIntegrationAuditEntrySha256({ ...row, detail }) !==
                      row.entry_sha256
                    ? `integration audit sequence ${row.audit_sequence} has a mismatched entry digest`
                    : null;
      if (failure !== null) {
        return Object.freeze({
          valid: false,
          entries_verified: verified,
          head_sequence: verified,
          head_entry_sha256: previous,
          failure,
        });
      }
      previous = row.entry_sha256 as `sha256:${string}`;
      verified += 1;
    }
    return Object.freeze({
      valid: true,
      entries_verified: verified,
      head_sequence: verified,
      head_entry_sha256: previous,
      failure: null,
    });
  }

  slackApprovalActivationReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): ActivateExistingSlackApprovalResult | null {
    return this.replay<ActivateExistingSlackApprovalResult>(
      commandId,
      commandSha256,
      "slack_approval.activated",
      "Slack approval activation",
    );
  }

  slackOrganizationToolReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): OnboardSlackOrganizationToolResult | null {
    return this.replay<OnboardSlackOrganizationToolResult>(
      commandId,
      commandSha256,
      "organization_tool.slack.onboarded",
      "Slack organization tool",
    );
  }

  slackIdentityLinkCompletionReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): CompletedSlackIdentityLink | null {
    return this.replay<CompletedSlackIdentityLink>(
      commandId,
      commandSha256,
      "slack_identity_link.completed",
      "Slack identity link completion",
    );
  }

  slackIdentityLinkChallengeCompletionReplay(
    input: SlackIdentityLinkCompletionReplayKey,
  ): CompletedSlackIdentityLink | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM organization_integration_audit
         WHERE correlation_id = ?
           AND action = 'slack_identity_link.completed'
           AND outcome = 'succeeded'`,
      )
      .get(input.challenge_attempt_id) as AuditReplayRow | undefined;
    if (row === undefined) return null;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    if (
      detail["completion_sha256"] !==
      slackIdentityLinkCompletionSha256(input)
    ) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link challenge was completed with different input",
      );
    }
    const result = detail["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("stored Slack identity link audit result is invalid");
    }
    return result as CompletedSlackIdentityLink;
  }

  personSlackIdentityLinkCompletionReplay(
    commandId: string,
    commandSha256: `sha256:${string}`,
  ): CompletedPersonSlackIdentityLink | null {
    return this.replay<CompletedPersonSlackIdentityLink>(
      commandId,
      commandSha256,
      PERSON_SLACK_IDENTITY_LINK_AUDIT_ACTION,
      "Person Slack identity link completion",
    );
  }

  personSlackIdentityLinkChallengeCompletionReplay(
    input: PersonSlackIdentityLinkCompletionReplayKey,
  ): CompletedPersonSlackIdentityLink | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM organization_integration_audit
         WHERE correlation_id = ?
           AND action = ?
           AND outcome = 'succeeded'`,
      )
      .get(
        input.challenge_attempt_id,
        PERSON_SLACK_IDENTITY_LINK_AUDIT_ACTION,
      ) as AuditReplayRow | undefined;
    if (row === undefined) return null;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    if (
      detail["completion_sha256"] !==
      personSlackIdentityLinkCompletionSha256(input)
    ) {
      throw new OrganizationIntegrationConflictError(
        "Person Slack identity link challenge was completed with different input",
      );
    }
    const result = detail["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(
        "stored Person Slack identity link audit result is invalid",
      );
    }
    return result as CompletedPersonSlackIdentityLink;
  }

  private replay<T>(
    commandId: string,
    commandSha256: `sha256:${string}`,
    action: string,
    label: string,
  ): T | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM organization_integration_audit
         WHERE command_id = ? AND action = ?`,
      )
      .get(commandId, action) as AuditReplayRow | undefined;
    if (row === undefined) return null;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    if (detail["command_sha256"] !== commandSha256) {
      throw new Error(
        "organization integration command ID was reused with different input",
      );
    }
    const result = detail["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`stored ${label} audit result is invalid`);
    }
    return result as T;
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private completeSlackOrganizationToolAttempt(
    input: CompleteSlackOrganizationToolAttemptInput,
  ): void {
    this.database
      .prepare(
        `INSERT INTO organization_connection_attempts (
           connection_attempt_id, organization_id,
           requested_by_principal_id, requested_by_membership_id,
           attempt_purpose, target_owner_kind, target_principal_id,
           target_membership_id, provider, provider_issuer,
           provider_tenant_kind, provider_tenant_id, redirect_uri,
           requested_scopes_json, requested_scopes_sha256, state_sha256,
           nonce_sha256, pkce_challenge_sha256, admin_session_sha256, status,
           provider_subject_kind, provider_subject_id, granted_scopes_json,
           granted_scopes_sha256, verification_evidence_sha256, created_at,
           expires_at, consumed_at, outcome_reason
         ) VALUES (
           @attempt_id, @organization_id, @administrator_principal_id,
           @administrator_membership_id, 'tool_connection', 'organization',
           NULL, NULL, @provider, @provider_issuer, 'workspace', @team_id,
           'urn:echo:organization:admin:slack-tool-onboarding',
           @scopes_json, @scopes_sha256, @state_sha256, @nonce_sha256,
           @pkce_sha256, @admin_session_sha256, 'pending',
           NULL, NULL, NULL, NULL, NULL, @now, @expires_at, NULL, NULL
         )`,
      )
      .run({
        ...input,
        organization_id: this.identity.organization_id,
        provider: SLACK_PROVIDER,
        provider_issuer: SLACK_PROVIDER_ISSUER,
        state_sha256: digest(`state:${input.command_id}`),
        nonce_sha256: digest(`nonce:${input.command_id}`),
        pkce_sha256: digest(`pkce:${input.command_id}`),
        admin_session_sha256: digest(`admin:${input.command_id}`),
      });
    this.database
      .prepare(
        `UPDATE organization_connection_attempts
         SET status = 'succeeded', provider_subject_kind = 'service_account',
             provider_subject_id = @subject_id,
             granted_scopes_json = @scopes_json,
             granted_scopes_sha256 = @scopes_sha256,
             verification_evidence_sha256 = @evidence_sha256,
             consumed_at = @now
         WHERE connection_attempt_id = @attempt_id`,
      )
      .run(input);
  }

  private slackOrganizationToolRow():
    | ActiveSlackOrganizationToolRow
    | undefined {
    return this.database
      .prepare(
        `SELECT connection_id, verification_attempt_id, activated_at,
                provider_tenant_id, provider_subject_id, granted_scopes_json,
                granted_scopes_sha256, secret_backend_id, secret_handle_id,
                public_configuration_json, public_configuration_sha256
         FROM organization_tool_connections
         WHERE organization_id = ?
           AND provider = ?
           AND provider_issuer = ?
           AND provider_tenant_kind = 'workspace'
           AND provider_subject_kind = 'service_account'
           AND owner_kind = 'organization'
           AND status = 'active'`,
      )
      .get(
        this.identity.organization_id,
        SLACK_PROVIDER,
        SLACK_PROVIDER_ISSUER,
      ) as ActiveSlackOrganizationToolRow | undefined;
  }

  activeSlackOrganizationTool(): ActiveSlackOrganizationTool | null {
    const row = this.slackOrganizationToolRow();
    if (row === undefined) return null;
    const { configuration, scopes } = validatedSlackToolData(
      row,
      "stored Slack organization tool is invalid",
    );
    if (
      configuration["organization_tool_profile"] !==
      SLACK_ORGANIZATION_TOOL_PROFILE
    ) {
      return null;
    }
    if (
      !hasSlackOrganizationToolScopes(scopes) ||
      configuration["schema_version"] !== 1 ||
      typeof configuration["channel_id"] !== "string" ||
      typeof configuration["slack_bot_id"] !== "string" ||
      typeof configuration["approve_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["approve_reaction"]) ||
      typeof configuration["reject_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["reject_reaction"]) ||
      configuration["approve_reaction"] ===
        configuration["reject_reaction"] ||
      configuration["slack_bot_user_id"] !== row.provider_subject_id ||
      !(
        configuration["slack_enterprise_id"] === null ||
        typeof configuration["slack_enterprise_id"] === "string"
      ) ||
      !(
        configuration["slack_app_id"] === null ||
        typeof configuration["slack_app_id"] === "string"
      )
    ) {
      throw new Error("stored Slack organization tool is invalid");
    }
    return Object.freeze({
      connection_attempt_id: row.verification_attempt_id,
      connection_id: row.connection_id,
      team_id: row.provider_tenant_id,
      enterprise_id: configuration["slack_enterprise_id"],
      bot_user_id: row.provider_subject_id,
      bot_id: configuration["slack_bot_id"],
      app_id: configuration["slack_app_id"],
      channel_id: configuration["channel_id"],
      approve_reaction: configuration["approve_reaction"],
      reject_reaction: configuration["reject_reaction"],
      granted_scopes: scopes,
      secret: Object.freeze({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: row.secret_handle_id,
      }),
    });
  }

  /**
   * Proves that one exact active Slack approval-surface instance is bound to
   * the current organization tool. This is intentionally stricter than an
   * adapter-id existence check: a one-way policy activation must not accept a
   * misspelled instance id or a binding whose public Slack identity drifted.
   */
  hasActiveSlackApprovalSurfaceInstance(adapterInstanceId: string): boolean {
    if (
      adapterInstanceId.length < 1 ||
      adapterInstanceId.length > 128 ||
      adapterInstanceId.trim() !== adapterInstanceId ||
      adapterInstanceId.includes("\0")
    ) {
      return false;
    }
    const tool = this.activeSlackOrganizationTool();
    if (tool === null) return false;
    const rows = this.database
      .prepare(
        `SELECT adapter_binding_id, installation_id, installation_key_id,
                adapter_id, adapter_instance_id, adapter_version,
                connection_id, public_configuration_json,
                public_configuration_sha256
         FROM organization_adapter_bindings
         WHERE organization_id = ?
           AND product_namespace = 'echo-brain'
           AND adapter_kind = 'approval-surface'
           AND adapter_id = 'slack-reactions'
           AND adapter_instance_id = ?
           AND connection_id = ?
           AND status = 'active'
         ORDER BY adapter_binding_id`,
      )
      .all(
        this.identity.organization_id,
        adapterInstanceId,
        tool.connection_id,
      ) as ActiveSlackBindingRow[];
    for (const row of rows) {
      if (!slackApprovalBindingMatchesTool(row, tool)) {
        throw new OrganizationIntegrationConflictError(
          "active Slack approval binding is not an exact organization-tool binding",
        );
      }
    }
    return rows.length > 0;
  }

  /**
   * Resolves the exact installation-scoped, single-reviewer Slack capability
   * used by the live meeting worker. Historical installations on the same
   * surface are irrelevant. A partial exact binding is simply not ready;
   * competing complete rows for the exact key are a configuration conflict.
   */
  activeSlackApprovalRuntimeBinding(
    adapterInstanceId: string,
    installationId: string,
    installationKeyId: `sha256:${string}`,
  ): ActiveSlackApprovalRuntimeBinding | null {
    const tool = this.activeSlackOrganizationTool();
    if (tool === null) return null;
    const bindings = this.database
      .prepare(
        `SELECT adapter_binding_id, installation_id, installation_key_id,
                adapter_id, adapter_instance_id, adapter_version,
                connection_id, public_configuration_json,
                public_configuration_sha256
           FROM organization_adapter_bindings
          WHERE organization_id = ?
            AND product_namespace = 'echo-brain'
            AND adapter_kind = 'approval-surface'
            AND adapter_id = 'slack-reactions'
            AND adapter_instance_id = ?
            AND installation_id = ?
            AND installation_key_id = ?
            AND connection_id = ?
            AND status = 'active'
          ORDER BY adapter_binding_id`,
      )
      .all(
        this.identity.organization_id,
        adapterInstanceId,
        installationId,
        installationKeyId,
        tool.connection_id,
      ) as ActiveSlackBindingRow[];
    for (const binding of bindings) {
      if (!slackApprovalBindingMatchesTool(binding, tool)) {
        throw new OrganizationIntegrationConflictError(
          "active Slack approval binding is not an exact organization-tool binding",
        );
      }
    }
    if (bindings.length === 0) return null;
    if (bindings.length !== 1) {
      throw new OrganizationIntegrationConflictError(
        "Slack approval runtime binding is ambiguous",
      );
    }
    const rows = this.database
      .prepare(
        `SELECT binding.adapter_binding_id, binding.installation_id,
                binding.installation_key_id, binding.adapter_id,
                binding.adapter_instance_id, binding.adapter_version,
                binding.connection_id, binding.public_configuration_json,
                binding.public_configuration_sha256,
                identity.identity_link_id, identity.principal_id,
                identity.membership_id,
                identity.provider_subject_id AS reviewer_slack_user_id,
                approve.permission_grant_id AS approve_permission_grant_id,
                reject.permission_grant_id AS reject_permission_grant_id
           FROM organization_adapter_bindings AS binding
           JOIN organization_permission_grants AS approve
             ON approve.organization_id = binding.organization_id
            AND approve.adapter_binding_id = binding.adapter_binding_id
            AND approve.action = 'approve' AND approve.status = 'active'
           JOIN organization_permission_grants AS reject
             ON reject.organization_id = binding.organization_id
            AND reject.adapter_binding_id = binding.adapter_binding_id
            AND reject.principal_id = approve.principal_id
            AND reject.membership_id = approve.membership_id
            AND reject.action = 'reject' AND reject.status = 'active'
           JOIN organization_external_identity_links AS identity
             ON identity.organization_id = binding.organization_id
            AND identity.principal_id = approve.principal_id
            AND identity.membership_id = approve.membership_id
            AND identity.provider = 'slack'
            AND identity.provider_issuer = 'https://slack.com'
            AND identity.provider_tenant_kind = 'workspace'
            AND identity.provider_tenant_id = ?
            AND identity.status = 'active'
          WHERE binding.adapter_binding_id = ?
          ORDER BY identity.identity_link_id`,
      )
      .all(tool.team_id, bindings[0]!.adapter_binding_id) as
      ActiveSlackApprovalRuntimeBindingRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new OrganizationIntegrationConflictError(
        "Slack approval runtime reviewer is ambiguous",
      );
    }
    const row = rows[0]!;
    if (row.adapter_id !== "slack-reactions") {
      throw new Error("stored Slack approval runtime binding is invalid");
    }
    return Object.freeze({
      organization_tool: tool,
      identity_link_id: row.identity_link_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      reviewer_slack_user_id: row.reviewer_slack_user_id,
      adapter_binding_id: row.adapter_binding_id,
      installation_id: row.installation_id,
      installation_key_id: row.installation_key_id as `sha256:${string}`,
      adapter_id: "slack-reactions",
      adapter_instance_id: row.adapter_instance_id,
      adapter_version: row.adapter_version,
      approve_permission_grant_id: row.approve_permission_grant_id,
      reject_permission_grant_id: row.reject_permission_grant_id,
    });
  }

  upgradeableSlackOrganizationTool(): UpgradeableSlackOrganizationTool | null {
    const row = this.slackOrganizationToolRow();
    if (row === undefined) return null;
    const { configuration, scopes } = validatedSlackToolData(
      row,
      "stored upgradeable Slack organization tool is invalid",
    );
    if (
      configuration["organization_tool_profile"] !==
        SLACK_ORGANIZATION_TOOL_PROFILE ||
      configuration["slack_app_id"] !== null
    ) {
      return null;
    }
    const active = this.activeSlackOrganizationTool();
    if (
      !isExactReadySlackOrganizationToolConfiguration(configuration) ||
      active === null ||
      !hasSlackOrganizationToolScopes(scopes) ||
      !/^T[A-Z0-9]{2,}$/.test(active.team_id) ||
      !/^C[A-Z0-9]{2,}$/.test(active.channel_id) ||
      !/^B[A-Z0-9]{2,}$/.test(active.bot_id) ||
      !/^[UW][A-Z0-9]{2,}$/.test(active.bot_user_id) ||
      !(
        active.enterprise_id === null ||
        /^E[A-Z0-9]{2,}$/.test(active.enterprise_id)
      )
    ) {
      throw new Error("stored upgradeable Slack organization tool is invalid");
    }
    return Object.freeze({
      ...active,
      activated_at: row.activated_at,
      app_id: null,
    });
  }

  private slackAppIdentityBindingPromotions(
    tool: UpgradeableSlackOrganizationTool,
    appId: string,
  ): readonly SlackAppIdentityBindingPromotion[] {
    const rows = this.database
      .prepare(
        `SELECT adapter_binding_id, installation_id, installation_key_id,
                adapter_id, adapter_instance_id, adapter_version,
                connection_id, public_configuration_json,
                public_configuration_sha256
         FROM organization_adapter_bindings
         WHERE organization_id = ?
           AND product_namespace = 'echo-brain'
           AND adapter_kind = 'approval-surface'
           AND adapter_id = 'slack-reactions'
           AND connection_id = ?
           AND status = 'active'
         ORDER BY adapter_binding_id`,
      )
      .all(this.identity.organization_id, tool.connection_id) as
      ActiveSlackBindingRow[];
    return Object.freeze(
      rows.map((row) => {
        if (!slackApprovalBindingMatchesTool(row, tool)) {
          throw new OrganizationIntegrationConflictError(
            "active Slack approval binding is not an exact null-app organization-tool binding",
          );
        }
        const previous = validatedPublicConfiguration(row);
        if (previous["slack_app_id"] !== null) {
          throw new OrganizationIntegrationConflictError(
            "active Slack approval binding app identity is inconsistent",
          );
        }
        const promoted = { ...previous, slack_app_id: appId };
        return Object.freeze({
          adapter_binding_id: row.adapter_binding_id,
          previous_public_configuration_sha256:
            row.public_configuration_sha256,
          public_configuration_sha256: digest(promoted),
        });
      }),
    );
  }

  beginSlackIdentityLinkChallenge(
    input: BeginSlackIdentityLinkChallengeInput,
  ): BegunSlackIdentityLinkChallenge {
    if (
      input.installation.organization_id !== this.identity.organization_id ||
      input.installation.authority_id !== this.identity.authority_id ||
      input.organization_tool.team_id.length === 0
    ) {
      throw new Error("Slack identity link installation is inconsistent");
    }
    const requestedScopes = ["users:read"];
    const requestedScopesJson = canonicalJson(requestedScopes);
    const requestedScopesSha256 = digest(requestedScopes);
    const expiresAt = addMinutes(input.now, 15);
    const challengeAttemptId = id("cat");
    return this.immediateTransaction(() => {
      const activeTool = this.activeSlackOrganizationTool();
      if (
        activeTool === null ||
        canonicalJson(activeTool) !==
          canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before link challenge",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT connection_attempt_id
           FROM organization_connection_attempts
           WHERE nonce_sha256 = ?`,
        )
        .get(input.request_sha256) as
        | { connection_attempt_id: string }
        | undefined;
      if (existing !== undefined) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge already started",
        );
      }
      this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'expired', consumed_at = ?,
               outcome_reason = 'superseded_by_new_challenge'
           WHERE organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND target_membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND status = 'pending'`,
        )
        .run(
          input.now,
          this.identity.organization_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        );
      this.database
        .prepare(
          `INSERT INTO organization_connection_attempts (
             connection_attempt_id, organization_id,
             requested_by_principal_id, requested_by_membership_id,
             attempt_purpose, target_owner_kind, target_principal_id,
             target_membership_id, provider, provider_issuer,
             provider_tenant_kind, provider_tenant_id, redirect_uri,
             requested_scopes_json, requested_scopes_sha256, state_sha256,
             nonce_sha256, pkce_challenge_sha256, admin_session_sha256,
             status, provider_subject_kind, provider_subject_id,
             granted_scopes_json, granted_scopes_sha256,
             verification_evidence_sha256, created_at, expires_at,
             consumed_at, outcome_reason
           ) VALUES (
             ?, ?, ?, ?, 'identity_link', 'membership', ?, ?, ?, ?,
             'workspace', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL,
             NULL, NULL, NULL, ?, ?, NULL, NULL
           )`,
        )
        .run(
          challengeAttemptId,
          this.identity.organization_id,
          input.installation.principal_id,
          input.installation.membership_id,
          input.installation.principal_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          activeTool.team_id,
          "urn:echo:organization:employee:slack-channel-link",
          requestedScopesJson,
          requestedScopesSha256,
          input.challenge_code_sha256,
          input.request_sha256,
          slackIdentityLinkToolSha256(challengeAttemptId, activeTool),
          slackIdentityLinkSessionSha256(input.installation),
          input.now,
          expiresAt,
        );
      return Object.freeze({
        challenge_attempt_id: challengeAttemptId,
        created_at: input.now,
        expires_at: expiresAt,
      });
    });
  }

  beginPersonSlackIdentityLinkChallenge(
    input: BeginPersonSlackIdentityLinkChallengeInput,
  ): BegunSlackIdentityLinkChallenge {
    if (
      input.person_session.organization_id !== this.identity.organization_id ||
      input.person_session.authority_id !== this.identity.authority_id ||
      input.organization_tool.team_id.length === 0
    ) {
      throw new Error("Person Slack identity link session is inconsistent");
    }
    const requestedScopes = ["users:read"];
    const requestedScopesJson = canonicalJson(requestedScopes);
    const requestedScopesSha256 = digest(requestedScopes);
    const expiresAt = addMinutes(input.now, 15);
    const challengeAttemptId = id("cat");
    return this.immediateTransaction(() => {
      const activeTool = this.activeSlackOrganizationTool();
      if (
        activeTool === null ||
        canonicalJson(activeTool) !== canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before Person link challenge",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT connection_attempt_id
           FROM organization_connection_attempts
           WHERE nonce_sha256 = ?`,
        )
        .get(input.request_sha256) as
        | { connection_attempt_id: string }
        | undefined;
      if (existing !== undefined) {
        throw new OrganizationIntegrationConflictError(
          "Person Slack identity link challenge already started",
        );
      }
      this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'expired', consumed_at = ?,
               outcome_reason = 'superseded_by_new_challenge'
           WHERE organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND target_membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND status = 'pending'`,
        )
        .run(
          input.now,
          this.identity.organization_id,
          input.person_session.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        );
      this.database
        .prepare(
          `INSERT INTO organization_connection_attempts (
             connection_attempt_id, organization_id,
             requested_by_principal_id, requested_by_membership_id,
             attempt_purpose, target_owner_kind, target_principal_id,
             target_membership_id, provider, provider_issuer,
             provider_tenant_kind, provider_tenant_id, redirect_uri,
             requested_scopes_json, requested_scopes_sha256, state_sha256,
             nonce_sha256, pkce_challenge_sha256, admin_session_sha256,
             status, provider_subject_kind, provider_subject_id,
             granted_scopes_json, granted_scopes_sha256,
             verification_evidence_sha256, created_at, expires_at,
             consumed_at, outcome_reason
           ) VALUES (
             ?, ?, ?, ?, 'identity_link', 'membership', ?, ?, ?, ?,
             'workspace', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL,
             NULL, NULL, NULL, ?, ?, NULL, NULL
           )`,
        )
        .run(
          challengeAttemptId,
          this.identity.organization_id,
          input.person_session.principal_id,
          input.person_session.membership_id,
          input.person_session.principal_id,
          input.person_session.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          activeTool.team_id,
          PERSON_SLACK_IDENTITY_LINK_REDIRECT_URI,
          requestedScopesJson,
          requestedScopesSha256,
          input.challenge_code_sha256,
          input.request_sha256,
          slackIdentityLinkToolSha256(challengeAttemptId, activeTool),
          personSlackIdentityLinkSessionSha256(input.person_session),
          input.now,
          expiresAt,
        );
      return Object.freeze({
        challenge_attempt_id: challengeAttemptId,
        created_at: input.now,
        expires_at: expiresAt,
      });
    });
  }

  slackIdentityLinkChallenge(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    installation: BeginSlackIdentityLinkChallengeInput["installation"];
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): PendingSlackIdentityLinkChallenge {
    const challenge = this.immediateTransaction<
      PendingSlackIdentityLinkChallenge | null
    >(() => {
      const row = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (row === undefined) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge was not found",
        );
      }
      if (row.status === "pending" && input.now >= row.expires_at) {
        this.database
          .prepare(
            `UPDATE organization_connection_attempts
             SET status = 'expired', consumed_at = ?,
                 outcome_reason = 'challenge_expired'
             WHERE connection_attempt_id = ? AND status = 'pending'`,
          )
          .run(input.now, input.challenge_attempt_id);
        return null;
      }
      if (
        row.status !== "pending" ||
        row.requested_by_principal_id !== input.installation.principal_id ||
        row.requested_by_membership_id !== input.installation.membership_id ||
        row.target_principal_id !== input.installation.principal_id ||
        row.target_membership_id !== input.installation.membership_id ||
        row.provider_tenant_id !== input.organization_tool.team_id ||
        row.state_sha256 !== input.challenge_code_sha256 ||
        row.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(
            input.challenge_attempt_id,
            input.organization_tool,
          ) ||
        row.admin_session_sha256 !==
          slackIdentityLinkSessionSha256(input.installation)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge does not match this installation",
        );
      }
      return Object.freeze({
        challenge_attempt_id: row.connection_attempt_id,
        principal_id: row.target_principal_id,
        membership_id: row.target_membership_id,
        installation_id: input.installation.installation_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });
    });
    if (challenge === null) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link challenge expired",
      );
    }
    return challenge;
  }

  personSlackIdentityLinkChallenge(input: {
    challenge_attempt_id: string;
    challenge_code_sha256: `sha256:${string}`;
    person_session: BeginPersonSlackIdentityLinkChallengeInput["person_session"];
    organization_tool: ActiveSlackOrganizationTool;
    now: string;
  }): PendingPersonSlackIdentityLinkChallenge {
    const challenge = this.immediateTransaction<
      PendingPersonSlackIdentityLinkChallenge | null
    >(() => {
      const row = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND redirect_uri = ?`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          PERSON_SLACK_IDENTITY_LINK_REDIRECT_URI,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (row === undefined) {
        throw new OrganizationIntegrationConflictError(
          "Person Slack identity link challenge was not found",
        );
      }
      if (row.status === "pending" && input.now >= row.expires_at) {
        this.database
          .prepare(
            `UPDATE organization_connection_attempts
             SET status = 'expired', consumed_at = ?,
                 outcome_reason = 'challenge_expired'
             WHERE connection_attempt_id = ? AND status = 'pending'`,
          )
          .run(input.now, input.challenge_attempt_id);
        return null;
      }
      if (
        row.status !== "pending" ||
        row.requested_by_principal_id !== input.person_session.principal_id ||
        row.requested_by_membership_id !== input.person_session.membership_id ||
        row.target_principal_id !== input.person_session.principal_id ||
        row.target_membership_id !== input.person_session.membership_id ||
        row.provider_tenant_id !== input.organization_tool.team_id ||
        row.state_sha256 !== input.challenge_code_sha256 ||
        row.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(
            input.challenge_attempt_id,
            input.organization_tool,
          ) ||
        row.admin_session_sha256 !==
          personSlackIdentityLinkSessionSha256(input.person_session)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Person Slack identity link challenge does not match this session",
        );
      }
      return Object.freeze({
        challenge_attempt_id: row.connection_attempt_id,
        principal_id: row.target_principal_id,
        membership_id: row.target_membership_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });
    });
    if (challenge === null) {
      throw new OrganizationIntegrationConflictError(
        "Person Slack identity link challenge expired",
      );
    }
    return challenge;
  }

  failSlackIdentityLinkChallenge(
    challengeAttemptId: string,
    failedAt: string,
    reason: string,
  ): void {
    this.immediateTransaction(() => {
      this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'failed', consumed_at = ?, outcome_reason = ?
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND status = 'pending'`,
        )
        .run(
          failedAt,
          reason,
          challengeAttemptId,
          this.identity.organization_id,
        );
    });
  }

  legacySlackOrganizationTool(): LegacySlackOrganizationTool | null {
    const row = this.slackOrganizationToolRow();
    if (row === undefined) return null;
    const { configuration, scopes } = validatedSlackToolData(
      row,
      "stored legacy Slack organization tool is invalid",
    );
    if (configuration["organization_tool_profile"] !== undefined) {
      return null;
    }
    if (
      Object.keys(configuration).sort().join(",") !==
        [
          "approve_reaction",
          "channel_id",
          "reject_reaction",
          "slack_app_id",
          "slack_bot_id",
          "slack_bot_user_id",
          "slack_enterprise_id",
        ].join(",") ||
      typeof configuration["channel_id"] !== "string" ||
      !/^C[A-Z0-9]{2,}$/.test(configuration["channel_id"]) ||
      typeof configuration["slack_bot_id"] !== "string" ||
      !/^B[A-Z0-9]{2,}$/.test(configuration["slack_bot_id"]) ||
      configuration["slack_bot_user_id"] !== row.provider_subject_id ||
      !/^[UW][A-Z0-9]{2,}$/.test(row.provider_subject_id) ||
      typeof configuration["approve_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["approve_reaction"]) ||
      typeof configuration["reject_reaction"] !== "string" ||
      !/^[a-z0-9_+-]{1,64}$/.test(configuration["reject_reaction"]) ||
      configuration["approve_reaction"] ===
        configuration["reject_reaction"] ||
      !(
        configuration["slack_enterprise_id"] === null ||
        (typeof configuration["slack_enterprise_id"] === "string" &&
          /^E[A-Z0-9]{2,}$/.test(configuration["slack_enterprise_id"]))
      ) ||
      !(
        configuration["slack_app_id"] === null ||
        (typeof configuration["slack_app_id"] === "string" &&
          /^A[A-Z0-9]{2,}$/.test(configuration["slack_app_id"]))
      )
    ) {
      throw new Error("stored legacy Slack organization tool is invalid");
    }
    return Object.freeze({
      connection_attempt_id: row.verification_attempt_id,
      connection_id: row.connection_id,
      activated_at: row.activated_at,
      team_id: row.provider_tenant_id,
      enterprise_id: configuration["slack_enterprise_id"],
      bot_user_id: row.provider_subject_id,
      bot_id: configuration["slack_bot_id"],
      app_id: configuration["slack_app_id"],
      channel_id: configuration["channel_id"],
      approve_reaction: configuration["approve_reaction"],
      reject_reaction: configuration["reject_reaction"],
      granted_scopes: scopes,
      secret: Object.freeze({
        secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
        secret_handle_id: row.secret_handle_id,
      }),
    });
  }

  organizationSecretReferences(): readonly Readonly<{
    reference: OrganizationSecretReference;
    active: boolean;
  }>[] {
    const rows = this.database
      .prepare(
        `SELECT secret_backend_id, secret_handle_id, status
         FROM organization_tool_connections
         ORDER BY secret_backend_id, secret_handle_id`,
      )
      .all() as {
      secret_backend_id: string;
      secret_handle_id: string;
      status: string;
    }[];
    return Object.freeze(
      rows.map((row) => {
        if (
          row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
          !/^sch_[0-9a-f-]{36}$/.test(row.secret_handle_id) ||
          (row.status !== "active" && row.status !== "revoked")
        ) {
          throw new Error("stored organization integration secret is invalid");
        }
        return Object.freeze({
          reference: Object.freeze({
            secret_backend_id: AUTHORITY_FILE_SECRET_BACKEND,
            secret_handle_id: row.secret_handle_id,
          }),
          active: row.status === "active",
        });
      }),
    );
  }

  onboardSlackOrganizationTool(
    input: OnboardSlackOrganizationToolInput,
  ): OnboardSlackOrganizationToolResult {
    const legacy = this.legacySlackOrganizationTool();
    const upgradeable = this.upgradeableSlackOrganizationTool();
    const existingTool = legacy ?? upgradeable;
    const verifiedAppId = input.connection.app_id as string | null;
    const nullAppTool: UpgradeableSlackOrganizationTool | null =
      upgradeable ??
      (legacy?.app_id === null
        ? Object.freeze({ ...legacy, app_id: null })
        : null);
    const promotesAppIdentity =
      nullAppTool !== null &&
      verifiedAppId !== null &&
      /^A[A-Z0-9]{2,}$/.test(verifiedAppId);
    const preV5Schema =
      (this.database.pragma("user_version", { simple: true }) as number) < 5;
    const acceptsPreV5FreshNullApp =
      existingTool === null &&
      verifiedAppId === null &&
      preV5Schema;
    const acceptsPreV5LegacyNullApp =
      legacy?.app_id === null && verifiedAppId === null && preV5Schema;
    if (
      input.organization_id !== this.identity.organization_id ||
      input.authority_id !== this.identity.authority_id ||
      input.secret.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      input.channel.team_id !== input.connection.team_id ||
      !/^C[A-Z0-9]{2,}$/.test(input.channel.channel_id) ||
      !(
        (verifiedAppId !== null && /^A[A-Z0-9]{2,}$/.test(verifiedAppId)) ||
        acceptsPreV5FreshNullApp ||
        acceptsPreV5LegacyNullApp
      ) ||
      !hasSlackOrganizationToolScopes(input.connection.granted_scopes) ||
      (existingTool !== null &&
        (existingTool.connection_id.length === 0 ||
          input.secret.secret_handle_id !==
            existingTool.secret.secret_handle_id ||
          input.connection.team_id !== existingTool.team_id ||
          input.connection.enterprise_id !== existingTool.enterprise_id ||
          input.connection.bot_user_id !== existingTool.bot_user_id ||
          input.connection.bot_id !== existingTool.bot_id ||
          (legacy !== null &&
            legacy.app_id !== null &&
            input.connection.app_id !== legacy.app_id) ||
          input.channel.channel_id !== existingTool.channel_id))
    ) {
      throw new Error("Slack organization tool identities are inconsistent");
    }
    const replay = this.slackOrganizationToolReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;

    const connectionAttemptId = id("cat");
    const connectionId = existingTool?.connection_id ?? id("con");
    const expiresAt = addMinutes(input.now, 15);
    const connectionScopes = [...input.connection.granted_scopes].sort();
    const connectionScopesJson = canonicalJson(connectionScopes);
    const connectionScopesSha256 = digest(connectionScopes);
    const publicConfiguration = {
      approve_reaction:
        existingTool?.approve_reaction ?? SLACK_DEFAULT_APPROVE_REACTION,
      channel_id: input.channel.channel_id,
      organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
      reject_reaction:
        existingTool?.reject_reaction ?? SLACK_DEFAULT_REJECT_REACTION,
      schema_version: 1,
      slack_app_id: input.connection.app_id,
      slack_bot_id: input.connection.bot_id,
      slack_bot_user_id: input.connection.bot_user_id,
      slack_enterprise_id: input.connection.enterprise_id,
    };
    const publicConfigurationJson = canonicalJson(publicConfiguration);
    const publicConfigurationSha256 = digest(publicConfiguration);
    const verificationEvidenceSha256 = digest({
      schema_version: 1,
      connection_evidence_sha256: input.connection.verification_evidence_sha256,
      channel_evidence_sha256: input.channel.verification_evidence_sha256,
      public_configuration_sha256: publicConfigurationSha256,
    });
    const result: OnboardSlackOrganizationToolResult = {
      connection_attempt_id: connectionAttemptId,
      connection_id: connectionId,
      organization_id: input.organization_id,
      provider: SLACK_PROVIDER,
      status: "active",
      slack_team_id: input.connection.team_id,
      slack_bot_user_id: input.connection.bot_user_id,
      channel_id: input.channel.channel_id,
      granted_scopes: Object.freeze(connectionScopes),
      activated_at: existingTool?.activated_at ?? input.now,
    };
    const bindingPromotions =
      !promotesAppIdentity
        ? Object.freeze([])
        : this.slackAppIdentityBindingPromotions(
            nullAppTool,
            verifiedAppId,
          );

    return this.immediateTransaction(() => {
      const concurrent = this.slackOrganizationToolReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const existing = this.database
        .prepare(
          `SELECT connection_id
           FROM organization_tool_connections
           WHERE organization_id = ?
             AND provider = ?
             AND owner_kind = 'organization'
             AND status = 'active'`,
        )
        .get(input.organization_id, SLACK_PROVIDER) as
        | { connection_id: string }
        | undefined;
      if (existingTool === null && existing !== undefined) {
        throw new Error("Slack organization tool is already active");
      }
      if (
        existingTool !== null &&
        existing?.connection_id !== existingTool.connection_id
      ) {
        throw new Error("Slack organization tool state changed during onboarding");
      }
      if (promotesAppIdentity) {
        const currentLegacy = this.legacySlackOrganizationTool();
        const currentUpgradeable = this.upgradeableSlackOrganizationTool();
        const currentNullAppTool: UpgradeableSlackOrganizationTool | null =
          currentUpgradeable ??
          (currentLegacy?.app_id === null
            ? Object.freeze({ ...currentLegacy, app_id: null })
            : null);
        if (
          currentNullAppTool === null ||
          canonicalJson(currentNullAppTool) !== canonicalJson(nullAppTool) ||
          canonicalJson(
            this.slackAppIdentityBindingPromotions(
              currentNullAppTool,
              verifiedAppId,
            ),
          ) !== canonicalJson(bindingPromotions)
        ) {
          throw new OrganizationIntegrationConflictError(
            "Slack organization tool app identity changed during onboarding",
          );
        }
      }

      this.completeSlackOrganizationToolAttempt({
        attempt_id: connectionAttemptId,
        administrator_principal_id: input.administrator_principal_id,
        administrator_membership_id: input.administrator_membership_id,
        team_id: input.connection.team_id,
        scopes_json: connectionScopesJson,
        scopes_sha256: connectionScopesSha256,
        subject_id: input.connection.bot_user_id,
        evidence_sha256: verificationEvidenceSha256,
        command_id: input.command_id,
        now: input.now,
        expires_at: expiresAt,
      });

      if (existingTool === null) {
        this.database
          .prepare(
            `INSERT INTO organization_tool_connections (
               connection_id, organization_id, connection_kind, owner_kind,
               owner_principal_id, owner_membership_id, human_identity_link_id,
               provider, provider_issuer, provider_tenant_kind,
               provider_tenant_id, provider_subject_kind, provider_subject_id,
               granted_scopes_json, granted_scopes_sha256,
               verification_attempt_id, verification_evidence_sha256,
               secret_backend_id, secret_handle_id, status,
               created_by_principal_id, created_by_membership_id, activated_at,
               revoked_at, revocation_reason, public_configuration_json,
               public_configuration_sha256
             ) VALUES (
               ?, ?, 'service_account', 'organization', NULL, NULL, NULL, ?, ?,
               'workspace', ?, 'service_account', ?, ?, ?, ?, ?, ?, ?, 'active',
               ?, ?, ?, NULL, NULL, ?, ?
             )`,
          )
          .run(
            connectionId,
            input.organization_id,
            SLACK_PROVIDER,
            SLACK_PROVIDER_ISSUER,
            input.connection.team_id,
            input.connection.bot_user_id,
            connectionScopesJson,
            connectionScopesSha256,
            connectionAttemptId,
            verificationEvidenceSha256,
            input.secret.secret_backend_id,
            input.secret.secret_handle_id,
            input.administrator_principal_id,
            input.administrator_membership_id,
            input.now,
            publicConfigurationJson,
            publicConfigurationSha256,
          );
      } else if (!promotesAppIdentity && legacy !== null) {
        const promoted = this.database
          .prepare(
            `UPDATE organization_tool_connections
             SET granted_scopes_json = ?,
                 granted_scopes_sha256 = ?,
                 verification_attempt_id = ?,
                 verification_evidence_sha256 = ?,
                 public_configuration_json = ?,
                 public_configuration_sha256 = ?
             WHERE connection_id = ?
               AND organization_id = ?
               AND status = 'active'
               AND json_type(
                 public_configuration_json,
                 '$.organization_tool_profile'
               ) IS NULL`,
          )
          .run(
            connectionScopesJson,
            connectionScopesSha256,
            connectionAttemptId,
            verificationEvidenceSha256,
            publicConfigurationJson,
            publicConfigurationSha256,
            legacy.connection_id,
            input.organization_id,
          );
        if (promoted.changes !== 1) {
          throw new Error(
            "legacy Slack organization tool could not be promoted",
          );
        }
      } else if (promotesAppIdentity) {
        const previousPublicConfiguration = {
          approve_reaction: nullAppTool.approve_reaction,
          channel_id: nullAppTool.channel_id,
          ...(upgradeable === null
            ? {}
            : {
                organization_tool_profile: SLACK_ORGANIZATION_TOOL_PROFILE,
                schema_version: 1,
              }),
          reject_reaction: nullAppTool.reject_reaction,
          slack_app_id: null,
          slack_bot_id: nullAppTool.bot_id,
          slack_bot_user_id: nullAppTool.bot_user_id,
          slack_enterprise_id: nullAppTool.enterprise_id,
        };
        const previousPublicConfigurationJson = canonicalJson(
          previousPublicConfiguration,
        );
        const previousPublicConfigurationSha256 = digest(
          previousPublicConfiguration,
        );
        const appIdentityPromotion = Object.freeze({
          schema_version: 1,
          kind: "slack-null-app-identity-promotion-v1",
          app_id: verifiedAppId,
          previous_public_configuration_sha256:
            previousPublicConfigurationSha256,
          public_configuration_sha256: publicConfigurationSha256,
          binding_updates: Object.freeze(
            bindingPromotions.map((binding) =>
              Object.freeze({
                adapter_binding_id: binding.adapter_binding_id,
                previous_public_configuration_sha256:
                  binding.previous_public_configuration_sha256,
                public_configuration_sha256:
                  binding.public_configuration_sha256,
              }),
            ),
          ),
        });
        this.appendAudit({
          occurred_at: input.now,
          actor_kind: "membership",
          actor_principal_id: input.administrator_principal_id,
          actor_membership_id: input.administrator_membership_id,
          actor_identity_link_id: null,
          actor_installation_id: null,
          command_id: input.command_id,
          provider_event_sha256: null,
          action: "organization_tool.slack.onboarded",
          subject_kind: "tool_connection",
          subject_id: connectionId,
          membership_id: null,
          identity_link_id: null,
          connection_id: connectionId,
          adapter_binding_id: null,
          permission_grant_id: null,
          outcome: "succeeded",
          reason_code: "null_app_identity_reverified_and_promoted",
          idempotency_key: `organization-tool:slack:${input.command_id}`,
          authority_checked_at: input.now,
          authority_evidence_sha256: input.command_sha256,
          correlation_id: input.command_id,
          detail: {
            command_sha256: input.command_sha256,
            public_configuration_sha256: publicConfigurationSha256,
            app_identity_promotion: appIdentityPromotion,
            result,
          },
        });
        const promoted = this.database
          .prepare(
            `UPDATE organization_tool_connections
             SET granted_scopes_json = ?,
                 granted_scopes_sha256 = ?,
                 verification_attempt_id = ?,
                 verification_evidence_sha256 = ?,
                 public_configuration_json = ?,
                 public_configuration_sha256 = ?
             WHERE connection_id = ?
               AND organization_id = ?
               AND status = 'active'
               AND verification_attempt_id = ?
               AND public_configuration_json = ?
               AND public_configuration_sha256 = ?`,
          )
          .run(
            connectionScopesJson,
            connectionScopesSha256,
            connectionAttemptId,
            verificationEvidenceSha256,
            publicConfigurationJson,
            publicConfigurationSha256,
            connectionId,
            input.organization_id,
            nullAppTool.connection_attempt_id,
            previousPublicConfigurationJson,
            previousPublicConfigurationSha256,
          );
        if (promoted.changes !== 1) {
          throw new OrganizationIntegrationConflictError(
            "ready Slack organization tool app identity could not be promoted",
          );
        }
      }
      if (!promotesAppIdentity) {
        this.appendAudit({
          occurred_at: input.now,
          actor_kind: "membership",
          actor_principal_id: input.administrator_principal_id,
          actor_membership_id: input.administrator_membership_id,
          actor_identity_link_id: null,
          actor_installation_id: null,
          command_id: input.command_id,
          provider_event_sha256: null,
          action: "organization_tool.slack.onboarded",
          subject_kind: "tool_connection",
          subject_id: connectionId,
          membership_id: null,
          identity_link_id: null,
          connection_id: connectionId,
          adapter_binding_id: null,
          permission_grant_id: null,
          outcome: "succeeded",
          reason_code:
            legacy === null
              ? "provider_and_channel_verified"
              : "legacy_connection_reverified_and_promoted",
          idempotency_key: `organization-tool:slack:${input.command_id}`,
          authority_checked_at: input.now,
          authority_evidence_sha256: input.command_sha256,
          correlation_id: input.command_id,
          detail: {
            command_sha256: input.command_sha256,
            public_configuration_sha256: publicConfigurationSha256,
            result,
          },
        });
      }
      return Object.freeze(result);
    });
  }

  activateExistingSlackApproval(
    input: ActivateExistingSlackApprovalInput,
  ): ActivateExistingSlackApprovalResult {
    if (
      input.organization_id !== this.identity.organization_id ||
      input.authority_id !== this.identity.authority_id
    ) {
      throw new OrganizationIntegrationConflictError(
        "Slack approval activation Authority context is inconsistent",
      );
    }
    const replay = this.slackApprovalActivationReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;

    return this.immediateTransaction(() => {
      const concurrent = this.slackApprovalActivationReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;

      const organizationTool = this.activeSlackOrganizationTool();
      if (organizationTool === null) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval activation requires the active organization Slack tool",
        );
      }
      const identity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE identity_link_id = ?
             AND organization_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND status = 'active'`,
        )
        .get(
          input.identity_link_id,
          input.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          organizationTool.team_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      if (
        identity === undefined ||
        identity.principal_id !== input.target_principal_id ||
        identity.membership_id !== input.target_membership_id
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval activation identity link does not match the active target membership",
        );
      }

      const binding = this.database
        .prepare(
          `SELECT adapter_binding_id, installation_id, installation_key_id,
                  adapter_id, adapter_instance_id, adapter_version,
                  connection_id, public_configuration_json,
                  public_configuration_sha256
           FROM organization_adapter_bindings
           WHERE adapter_binding_id = ?
             AND organization_id = ?
             AND product_namespace = 'echo-brain'
             AND adapter_kind = 'approval-surface'
             AND status = 'active'`,
        )
        .get(input.adapter_binding_id, input.organization_id) as
        | ActiveSlackBindingRow
        | undefined;
      if (
        binding === undefined ||
        binding.installation_id !== input.installation_id ||
        binding.installation_key_id !== input.installation_key_id ||
        binding.adapter_id !== "slack-reactions" ||
        binding.connection_id !== organizationTool.connection_id ||
        !slackApprovalBindingMatchesTool(binding, organizationTool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval activation adapter binding does not match the active installation and organization tool",
        );
      }

      const activeGrants = this.database
        .prepare(
          `SELECT permission_grant_id, principal_id, membership_id, action,
                  resource_scope_json
           FROM organization_permission_grants
           WHERE organization_id = ?
             AND adapter_binding_id = ?
             AND action IN ('approve', 'reject')
             AND status = 'active'
           ORDER BY action, permission_grant_id`,
        )
        .all(input.organization_id, input.adapter_binding_id) as
        ActiveSlackApprovalGrantRow[];
      const exactExistingPair =
        activeGrants.length === 2 &&
        activeGrants.every(
          (grant) =>
            grant.principal_id === input.target_principal_id &&
            grant.membership_id === input.target_membership_id &&
            grant.resource_scope_json === "{}",
        ) &&
        activeGrants.some((grant) => grant.action === "approve") &&
        activeGrants.some((grant) => grant.action === "reject");
      if (activeGrants.length !== 0 && !exactExistingPair) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval activation found conflicting existing direct grants",
        );
      }

      let approveGrantId: string;
      let rejectGrantId: string;
      let reasonCode: string;
      if (exactExistingPair) {
        approveGrantId = activeGrants.find(
          (grant) => grant.action === "approve",
        )!.permission_grant_id;
        rejectGrantId = activeGrants.find(
          (grant) => grant.action === "reject",
        )!.permission_grant_id;
        reasonCode = "existing_direct_grants_reused";
      } else {
        approveGrantId = id("pgr");
        rejectGrantId = id("pgr");
        const insertGrant = this.database.prepare(
          `INSERT INTO organization_permission_grants (
             permission_grant_id, organization_id, adapter_binding_id,
             principal_id, membership_id, action, resource_scope_json, status,
             granted_by_principal_id, granted_by_membership_id, granted_at,
             revoked_at, revocation_reason
           ) VALUES (
             ?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, NULL, NULL
           )`,
        );
        insertGrant.run(
          approveGrantId,
          input.organization_id,
          input.adapter_binding_id,
          input.target_principal_id,
          input.target_membership_id,
          "approve",
          input.administrator_principal_id,
          input.administrator_membership_id,
          input.now,
        );
        insertGrant.run(
          rejectGrantId,
          input.organization_id,
          input.adapter_binding_id,
          input.target_principal_id,
          input.target_membership_id,
          "reject",
          input.administrator_principal_id,
          input.administrator_membership_id,
          input.now,
        );
        reasonCode = "direct_grants_created";
      }

      const result: ActivateExistingSlackApprovalResult = {
        identity_link_id: identity.identity_link_id,
        adapter_binding_id: binding.adapter_binding_id,
        approve_permission_grant_id: approveGrantId,
        reject_permission_grant_id: rejectGrantId,
        membership_id: input.target_membership_id,
        installation_id: input.installation_id,
        activated_at: input.now,
        permission_grants_created: exactExistingPair ? 0 : 2,
      };
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "membership",
        actor_principal_id: input.administrator_principal_id,
        actor_membership_id: input.administrator_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: null,
        command_id: input.command_id,
        provider_event_sha256: null,
        action: "slack_approval.activated",
        subject_kind: "adapter_binding",
        subject_id: binding.adapter_binding_id,
        membership_id: input.target_membership_id,
        identity_link_id: identity.identity_link_id,
        connection_id: organizationTool.connection_id,
        adapter_binding_id: binding.adapter_binding_id,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code: reasonCode,
        idempotency_key: `slack-approval-activation:${input.command_id}`,
        authority_checked_at: input.now,
        authority_evidence_sha256: input.command_sha256,
        correlation_id: input.command_id,
        detail: {
          command_sha256: input.command_sha256,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  completeSlackIdentityLinkChallenge(
    input: CompleteSlackIdentityLinkChallengeInput,
  ): CompletedSlackIdentityLink {
    if (
      input.installation.organization_id !== this.identity.organization_id ||
      input.installation.authority_id !== this.identity.authority_id ||
      input.observed.team_id !== input.organization_tool.team_id ||
      input.observed.channel_id !== input.organization_tool.channel_id ||
      input.observed.challenge_message_ts !== input.challenge_message_ts
    ) {
      throw new OrganizationIntegrationConflictError(
        "Slack identity link evidence is inconsistent",
      );
    }
    const replay = this.slackIdentityLinkCompletionReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;
    const challengeReplay =
      this.slackIdentityLinkChallengeCompletionReplay(input);
    if (challengeReplay !== null) return challengeReplay;
    this.slackIdentityLinkChallenge({
      challenge_attempt_id: input.challenge_attempt_id,
      challenge_code_sha256: input.challenge_code_sha256,
      installation: input.installation,
      organization_tool: input.organization_tool,
      now: input.now,
    });

    const publicConfiguration = slackApprovalBindingConfiguration(
      input.organization_tool,
    );
    const publicConfigurationJson = canonicalJson(publicConfiguration);
    const publicConfigurationSha256 = digest(publicConfiguration);
    const identityScopes = ["users:read"];
    const identityScopesJson = canonicalJson(identityScopes);
    const identityScopesSha256 = digest(identityScopes);

    return this.immediateTransaction(() => {
      const concurrent = this.slackIdentityLinkCompletionReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const concurrentChallenge =
        this.slackIdentityLinkChallengeCompletionReplay(input);
      if (concurrentChallenge !== null) return concurrentChallenge;
      const currentTool = this.activeSlackOrganizationTool();
      if (
        currentTool === null ||
        canonicalJson(currentTool) !==
          canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before identity link completion",
        );
      }
      const attempt = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (
        attempt === undefined ||
        attempt.status !== "pending" ||
        input.now >= attempt.expires_at ||
        attempt.requested_by_principal_id !== input.installation.principal_id ||
        attempt.requested_by_membership_id !==
          input.installation.membership_id ||
        attempt.target_principal_id !== input.installation.principal_id ||
        attempt.target_membership_id !== input.installation.membership_id ||
        attempt.provider_tenant_id !== currentTool.team_id ||
        attempt.state_sha256 !== input.challenge_code_sha256 ||
        attempt.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(
            input.challenge_attempt_id,
            currentTool,
          ) ||
        attempt.admin_session_sha256 !==
          slackIdentityLinkSessionSha256(input.installation)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge cannot be completed by this installation",
        );
      }

      const memberIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          input.installation.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const subjectIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND provider_subject_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
          input.observed.user_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const existingIdentity = memberIdentity ?? subjectIdentity;
      if (
        (memberIdentity !== undefined &&
          memberIdentity.provider_subject_id !== input.observed.user_id) ||
        (subjectIdentity !== undefined &&
          (subjectIdentity.principal_id !== input.installation.principal_id ||
            subjectIdentity.membership_id !==
              input.installation.membership_id)) ||
        (memberIdentity !== undefined &&
          subjectIdentity !== undefined &&
          memberIdentity.identity_link_id !==
            subjectIdentity.identity_link_id)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity is already linked to another active membership",
        );
      }

      const binding = this.database
        .prepare(
          `SELECT adapter_binding_id, installation_id, installation_key_id,
                  adapter_id, adapter_instance_id, adapter_version,
                  connection_id, public_configuration_json,
                  public_configuration_sha256
           FROM organization_adapter_bindings
           WHERE organization_id = ?
             AND product_namespace = 'echo-brain'
             AND installation_id = ?
             AND adapter_kind = 'approval-surface'
             AND adapter_id = ?
             AND adapter_instance_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          input.installation.installation_id,
          input.adapter_id,
          input.adapter_instance_id,
        ) as ActiveSlackBindingRow | undefined;
      if (
        binding !== undefined &&
        (binding.installation_key_id !==
          input.installation.installation_key_id ||
          binding.adapter_version !== input.adapter_version ||
          binding.connection_id !== currentTool.connection_id ||
          binding.public_configuration_json !== publicConfigurationJson ||
          binding.public_configuration_sha256 !==
            publicConfigurationSha256)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack approval adapter is already bound to different organization configuration",
        );
      }

      const completedAttempt = this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'succeeded', provider_subject_kind = 'human_user',
               provider_subject_id = ?, granted_scopes_json = ?,
               granted_scopes_sha256 = ?,
               verification_evidence_sha256 = ?, consumed_at = ?
           WHERE connection_attempt_id = ? AND status = 'pending'`,
        )
        .run(
          input.observed.user_id,
          identityScopesJson,
          identityScopesSha256,
          input.observed.verification_evidence_sha256,
          input.now,
          input.challenge_attempt_id,
        );
      if (completedAttempt.changes !== 1) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity link challenge lost its completion race",
        );
      }

      const identityLinkCreated = existingIdentity === undefined;
      const identityLinkId = existingIdentity?.identity_link_id ?? id("clm");
      if (identityLinkCreated) {
        this.database
          .prepare(
            `INSERT INTO organization_external_identity_links (
               identity_link_id, organization_id, principal_id, membership_id,
               provider, provider_issuer, provider_tenant_kind,
               provider_tenant_id, provider_subject_id,
               verification_attempt_id, verification_evidence_sha256, status,
               verified_at, revoked_at, revocation_reason
             ) VALUES (
               ?, ?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, 'active', ?,
               NULL, NULL
             )`,
          )
          .run(
            identityLinkId,
            this.identity.organization_id,
            input.installation.principal_id,
            input.installation.membership_id,
            SLACK_PROVIDER,
            SLACK_PROVIDER_ISSUER,
            currentTool.team_id,
            input.observed.user_id,
            input.challenge_attempt_id,
            input.observed.verification_evidence_sha256,
            input.now,
          );
      }

      const adapterBindingCreated = binding === undefined;
      const adapterBindingId = binding?.adapter_binding_id ?? id("bnd");
      if (adapterBindingCreated) {
        this.database
          .prepare(
            `INSERT INTO organization_adapter_bindings (
               adapter_binding_id, organization_id, product_namespace,
               installation_id, installation_key_id, adapter_kind,
               adapter_id, adapter_instance_id, adapter_version,
               connection_id, public_configuration_json,
               public_configuration_sha256, status, created_by_principal_id,
               created_by_membership_id, bound_at, revoked_at,
               revocation_reason
             ) VALUES (
               ?, ?, 'echo-brain', ?, ?, 'approval-surface', ?, ?, ?, ?, ?,
               ?, 'active', ?, ?, ?, NULL, NULL
             )`,
          )
          .run(
            adapterBindingId,
            this.identity.organization_id,
            input.installation.installation_id,
            input.installation.installation_key_id,
            input.adapter_id,
            input.adapter_instance_id,
            input.adapter_version,
            currentTool.connection_id,
            publicConfigurationJson,
            publicConfigurationSha256,
            input.installation.principal_id,
            input.installation.membership_id,
            input.now,
          );
      }

      const result: CompletedSlackIdentityLink = {
        schema_version: 1,
        kind: "echo-organization-slack-link-result",
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        adapter_binding_id: adapterBindingId,
        organization_id: this.identity.organization_id,
        principal_id: input.installation.principal_id,
        membership_id: input.installation.membership_id,
        installation_id: input.installation.installation_id,
        provider: SLACK_PROVIDER,
        provider_tenant_id: currentTool.team_id,
        provider_subject_id: input.observed.user_id,
        channel_id: currentTool.channel_id,
        linked_at: input.now,
        identity_link_created: identityLinkCreated,
        adapter_binding_created: adapterBindingCreated,
        permission_grants_created: 0,
      };
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "installation",
        actor_principal_id: input.installation.principal_id,
        actor_membership_id: input.installation.membership_id,
        actor_identity_link_id: identityLinkId,
        actor_installation_id: input.installation.installation_id,
        command_id: input.command_id,
        provider_event_sha256:
          input.observed.verification_evidence_sha256,
        action: "slack_identity_link.completed",
        subject_kind: "identity_link",
        subject_id: identityLinkId,
        membership_id: input.installation.membership_id,
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        adapter_binding_id: adapterBindingId,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code: identityLinkCreated
          ? "employee_proved_slack_identity"
          : "employee_reverified_slack_identity",
        idempotency_key: `slack-identity-link:${input.command_id}`,
        authority_checked_at: input.authority_checked_at,
        authority_evidence_sha256: input.command_sha256,
        correlation_id: input.challenge_attempt_id,
        detail: {
          command_sha256: input.command_sha256,
          completion_sha256: slackIdentityLinkCompletionSha256(input),
          challenge_attempt_id: input.challenge_attempt_id,
          challenge_message_ts: input.challenge_message_ts,
          reply_message_ts: input.observed.reply_message_ts,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  completePersonSlackIdentityLinkChallenge(
    input: CompletePersonSlackIdentityLinkChallengeInput,
  ): CompletedPersonSlackIdentityLink {
    if (
      input.person_session.organization_id !== this.identity.organization_id ||
      input.person_session.authority_id !== this.identity.authority_id ||
      input.observed.team_id !== input.organization_tool.team_id ||
      input.observed.channel_id !== input.organization_tool.channel_id ||
      input.observed.challenge_message_ts !== input.challenge_message_ts
    ) {
      throw new OrganizationIntegrationConflictError(
        "Person Slack identity link evidence is inconsistent",
      );
    }
    const replay = this.personSlackIdentityLinkCompletionReplay(
      input.command_id,
      input.command_sha256,
    );
    if (replay !== null) return replay;
    const challengeReplay =
      this.personSlackIdentityLinkChallengeCompletionReplay(input);
    if (challengeReplay !== null) return challengeReplay;
    this.personSlackIdentityLinkChallenge({
      challenge_attempt_id: input.challenge_attempt_id,
      challenge_code_sha256: input.challenge_code_sha256,
      person_session: input.person_session,
      organization_tool: input.organization_tool,
      now: input.now,
    });

    const identityScopes = ["users:read"];
    const identityScopesJson = canonicalJson(identityScopes);
    const identityScopesSha256 = digest(identityScopes);

    return this.immediateTransaction(() => {
      const concurrent = this.personSlackIdentityLinkCompletionReplay(
        input.command_id,
        input.command_sha256,
      );
      if (concurrent !== null) return concurrent;
      const concurrentChallenge =
        this.personSlackIdentityLinkChallengeCompletionReplay(input);
      if (concurrentChallenge !== null) return concurrentChallenge;
      const currentTool = this.activeSlackOrganizationTool();
      if (
        currentTool === null ||
        canonicalJson(currentTool) !== canonicalJson(input.organization_tool)
      ) {
        throw new OrganizationIntegrationConflictError(
          "active organization Slack tool changed before Person identity link completion",
        );
      }
      const attempt = this.database
        .prepare(
          `SELECT connection_attempt_id, requested_by_principal_id,
                  requested_by_membership_id, target_principal_id,
                  target_membership_id, provider_tenant_id, state_sha256,
                  pkce_challenge_sha256, admin_session_sha256, status,
                  created_at, expires_at
           FROM organization_connection_attempts
           WHERE connection_attempt_id = ?
             AND organization_id = ?
             AND attempt_purpose = 'identity_link'
             AND target_owner_kind = 'membership'
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND redirect_uri = ?`,
        )
        .get(
          input.challenge_attempt_id,
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          PERSON_SLACK_IDENTITY_LINK_REDIRECT_URI,
        ) as SlackIdentityLinkAttemptRow | undefined;
      if (
        attempt === undefined ||
        attempt.status !== "pending" ||
        input.now >= attempt.expires_at ||
        attempt.requested_by_principal_id !==
          input.person_session.principal_id ||
        attempt.requested_by_membership_id !==
          input.person_session.membership_id ||
        attempt.target_principal_id !== input.person_session.principal_id ||
        attempt.target_membership_id !== input.person_session.membership_id ||
        attempt.provider_tenant_id !== currentTool.team_id ||
        attempt.state_sha256 !== input.challenge_code_sha256 ||
        attempt.pkce_challenge_sha256 !==
          slackIdentityLinkToolSha256(input.challenge_attempt_id, currentTool) ||
        attempt.admin_session_sha256 !==
          personSlackIdentityLinkSessionSha256(input.person_session)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Person Slack identity link challenge cannot be completed by this session",
        );
      }

      const memberIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND membership_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          input.person_session.membership_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const subjectIdentity = this.database
        .prepare(
          `SELECT identity_link_id, principal_id, membership_id,
                  provider_subject_id
           FROM organization_external_identity_links
           WHERE organization_id = ?
             AND provider = ?
             AND provider_issuer = ?
             AND provider_tenant_kind = 'workspace'
             AND provider_tenant_id = ?
             AND provider_subject_id = ?
             AND status = 'active'`,
        )
        .get(
          this.identity.organization_id,
          SLACK_PROVIDER,
          SLACK_PROVIDER_ISSUER,
          currentTool.team_id,
          input.observed.user_id,
        ) as ActiveSlackIdentityLinkRow | undefined;
      const existingIdentity = memberIdentity ?? subjectIdentity;
      if (
        (memberIdentity !== undefined &&
          memberIdentity.provider_subject_id !== input.observed.user_id) ||
        (subjectIdentity !== undefined &&
          (subjectIdentity.principal_id !== input.person_session.principal_id ||
            subjectIdentity.membership_id !==
              input.person_session.membership_id)) ||
        (memberIdentity !== undefined &&
          subjectIdentity !== undefined &&
          memberIdentity.identity_link_id !==
            subjectIdentity.identity_link_id)
      ) {
        throw new OrganizationIntegrationConflictError(
          "Slack identity is already linked to another active membership",
        );
      }

      const completedAttempt = this.database
        .prepare(
          `UPDATE organization_connection_attempts
           SET status = 'succeeded', provider_subject_kind = 'human_user',
               provider_subject_id = ?, granted_scopes_json = ?,
               granted_scopes_sha256 = ?,
               verification_evidence_sha256 = ?, consumed_at = ?
           WHERE connection_attempt_id = ? AND status = 'pending'`,
        )
        .run(
          input.observed.user_id,
          identityScopesJson,
          identityScopesSha256,
          input.observed.verification_evidence_sha256,
          input.now,
          input.challenge_attempt_id,
        );
      if (completedAttempt.changes !== 1) {
        throw new OrganizationIntegrationConflictError(
          "Person Slack identity link challenge lost its completion race",
        );
      }

      const identityLinkCreated = existingIdentity === undefined;
      const identityLinkId = existingIdentity?.identity_link_id ?? id("clm");
      if (identityLinkCreated) {
        this.database
          .prepare(
            `INSERT INTO organization_external_identity_links (
               identity_link_id, organization_id, principal_id, membership_id,
               provider, provider_issuer, provider_tenant_kind,
               provider_tenant_id, provider_subject_id,
               verification_attempt_id, verification_evidence_sha256, status,
               verified_at, revoked_at, revocation_reason
             ) VALUES (
               ?, ?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, 'active', ?,
               NULL, NULL
             )`,
          )
          .run(
            identityLinkId,
            this.identity.organization_id,
            input.person_session.principal_id,
            input.person_session.membership_id,
            SLACK_PROVIDER,
            SLACK_PROVIDER_ISSUER,
            currentTool.team_id,
            input.observed.user_id,
            input.challenge_attempt_id,
            input.observed.verification_evidence_sha256,
            input.now,
          );
      }

      const result: CompletedPersonSlackIdentityLink = {
        schema_version: 2,
        kind: "echo-organization-person-slack-link-result",
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        organization_id: this.identity.organization_id,
        principal_id: input.person_session.principal_id,
        membership_id: input.person_session.membership_id,
        provider: SLACK_PROVIDER,
        provider_tenant_id: currentTool.team_id,
        provider_subject_id: input.observed.user_id,
        channel_id: currentTool.channel_id,
        linked_at: input.now,
        identity_link_created: identityLinkCreated,
      };
      this.appendAudit({
        occurred_at: input.now,
        actor_kind: "membership",
        actor_principal_id: input.person_session.principal_id,
        actor_membership_id: input.person_session.membership_id,
        actor_identity_link_id: identityLinkId,
        actor_installation_id: null,
        command_id: input.command_id,
        provider_event_sha256:
          input.observed.verification_evidence_sha256,
        action: PERSON_SLACK_IDENTITY_LINK_AUDIT_ACTION,
        subject_kind: "identity_link",
        subject_id: identityLinkId,
        membership_id: input.person_session.membership_id,
        identity_link_id: identityLinkId,
        connection_id: currentTool.connection_id,
        adapter_binding_id: null,
        permission_grant_id: null,
        outcome: "succeeded",
        reason_code: identityLinkCreated
          ? "person_proved_slack_identity"
          : "person_reverified_slack_identity",
        idempotency_key: `person-slack-identity-link:${input.command_id}`,
        authority_checked_at: input.authority_checked_at,
        authority_evidence_sha256: personSlackIdentityLinkSessionSha256(
          input.person_session,
        ),
        correlation_id: input.challenge_attempt_id,
        detail: {
          command_sha256: input.command_sha256,
          completion_sha256:
            personSlackIdentityLinkCompletionSha256(input),
          challenge_attempt_id: input.challenge_attempt_id,
          challenge_message_ts: input.challenge_message_ts,
          reply_message_ts: input.observed.reply_message_ts,
          result,
        },
      });
      return Object.freeze(result);
    });
  }

  findSlackApprovalPermission(
    input: SlackApprovalPermissionLookup,
  ): SlackApprovalPermissionCandidate | null {
    const row = this.database
      .prepare(
        `SELECT
           identity.identity_link_id,
           identity.principal_id,
           identity.membership_id,
           connection.connection_id,
           binding.adapter_binding_id,
           grant_row.permission_grant_id,
           connection.secret_backend_id,
           connection.secret_handle_id,
           connection.provider_subject_id AS slack_bot_user_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_bot_id'
           ) AS slack_bot_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_enterprise_id'
           ) AS slack_enterprise_id,
           json_extract(
             binding.public_configuration_json,
             '$.slack_app_id'
           ) AS slack_app_id,
           json_extract(
             binding.public_configuration_json,
             '$.approve_reaction'
           ) AS approve_reaction,
           json_extract(
             binding.public_configuration_json,
             '$.reject_reaction'
           ) AS reject_reaction
         FROM organization_external_identity_links AS identity
         JOIN organization_permission_grants AS grant_row
           ON grant_row.organization_id = identity.organization_id
          AND grant_row.principal_id = identity.principal_id
          AND grant_row.membership_id = identity.membership_id
         JOIN organization_adapter_bindings AS binding
           ON binding.adapter_binding_id = grant_row.adapter_binding_id
          AND binding.organization_id = grant_row.organization_id
         JOIN organization_tool_connections AS connection
           ON connection.connection_id = binding.connection_id
          AND connection.organization_id = binding.organization_id
         WHERE identity.organization_id = ?
           AND identity.provider = ?
           AND identity.provider_issuer = ?
           AND identity.provider_tenant_kind = 'workspace'
           AND identity.provider_tenant_id = ?
           AND identity.provider_subject_id = ?
           AND identity.status = 'active'
           AND grant_row.action = ?
           AND grant_row.status = 'active'
           AND binding.product_namespace = 'echo-brain'
           AND binding.installation_id = ?
           AND binding.installation_key_id = ?
           AND binding.adapter_kind = 'approval-surface'
           AND binding.adapter_id = ?
           AND binding.adapter_instance_id = ?
           AND binding.adapter_version = ?
           AND connection.provider_subject_id = ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_bot_id'
           ) = ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_app_id'
           ) IS ?
           AND json_extract(
             binding.public_configuration_json,
             '$.slack_enterprise_id'
           ) IS ?
           AND json_extract(
             binding.public_configuration_json,
             '$.channel_id'
           ) = ?
           AND (
             (
               grant_row.action = 'approve' AND
               json_extract(
                 binding.public_configuration_json,
                 '$.approve_reaction'
               ) = ?
             ) OR (
               grant_row.action = 'reject' AND
               json_extract(
                 binding.public_configuration_json,
                 '$.reject_reaction'
               ) = ?
             )
           )
           AND binding.status = 'active'
           AND connection.provider = identity.provider
           AND connection.provider_issuer = identity.provider_issuer
           AND connection.provider_tenant_kind =
             identity.provider_tenant_kind
           AND connection.provider_tenant_id = identity.provider_tenant_id
           AND connection.status = 'active'`,
      )
      .get(
        input.organization_id,
        SLACK_PROVIDER,
        SLACK_PROVIDER_ISSUER,
        input.slack_team_id,
        input.slack_user_id,
        input.action,
        input.installation_id,
        input.installation_key_id,
        input.adapter_id,
        input.adapter_instance_id,
        input.adapter_version,
        input.slack_bot_user_id,
        input.slack_bot_id,
        input.slack_app_id,
        input.slack_enterprise_id,
        input.channel_id,
        input.reaction_name,
        input.reaction_name,
      ) as SlackApprovalPermissionCandidate | undefined;
    if (row === undefined) return null;
    if (
      row.secret_backend_id !== AUTHORITY_FILE_SECRET_BACKEND ||
      typeof row.slack_bot_id !== "string" ||
      !(
        row.slack_enterprise_id === null ||
        typeof row.slack_enterprise_id === "string"
      ) ||
      !(row.slack_app_id === null || typeof row.slack_app_id === "string") ||
      typeof row.approve_reaction !== "string" ||
      typeof row.reject_reaction !== "string" ||
      row.approve_reaction === row.reject_reaction
    ) {
      throw new Error("stored Slack approval binding is invalid");
    }
    return Object.freeze(row);
  }

  secretReferenceIsInUse(reference: OrganizationSecretReference): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
           FROM organization_tool_connections
           WHERE secret_backend_id = ? AND secret_handle_id = ?`,
        )
        .get(reference.secret_backend_id, reference.secret_handle_id) !==
      undefined
    );
  }

  recordPermissionDecision(
    input: RecordPermissionDecisionInput,
  ): RecordedPermissionDecision {
    const evaluationId = id("pce");
    return this.immediateTransaction(() => {
      this.appendAudit({
        occurred_at: input.evaluated_at,
        actor_kind: "installation",
        actor_principal_id: input.caller_principal_id,
        actor_membership_id: input.caller_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: input.installation_id,
        command_id: evaluationId,
        provider_event_sha256: input.provider_event_sha256,
        action: `permission.${input.action}`,
        subject_kind: "approval",
        subject_id: input.approval_id,
        membership_id: input.membership_id,
        identity_link_id: input.identity_link_id,
        connection_id: input.connection_id,
        adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id,
        outcome: input.allowed ? "allowed" : "denied",
        reason_code: input.reason_code,
        idempotency_key: `permission-evaluation:${evaluationId}`,
        authority_checked_at: input.authority_checked_at,
        authority_evidence_sha256: input.authority_evidence_sha256,
        correlation_id: input.request_id,
        detail: {
          ...input.detail,
          request_sha256: input.request_sha256,
          provider_event_sha256: input.provider_event_sha256,
          principal_id: input.principal_id,
        },
      });
      return Object.freeze({
        request_sha256: input.request_sha256,
        provider_event_sha256: input.provider_event_sha256,
        action: input.action,
        allowed: input.allowed,
        reason_code: input.reason_code,
        principal_id: input.principal_id,
        membership_id: input.membership_id,
        adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id,
        evaluated_at: input.evaluated_at,
      });
    });
  }

  /**
   * Appends exactly one immutable reviewer allow and returns its generated
   * `aud_*` id and chained entry hash. Nothing here is derived from a caller
   * proof object: every digest arrives already recomputed by the Authority
   * verifier from the live provider card.
   */
  recordReviewerPermissionDecision(
    input: RecordReviewerPermissionDecisionInput,
  ): RecordedReviewerPermissionDecision {
    const evaluationId = id("pce");
    return this.immediateTransaction(() => {
      const appended = this.appendAudit({
        occurred_at: input.evaluated_at,
        actor_kind: "installation",
        actor_principal_id: input.reviewer_principal_id,
        actor_membership_id: input.reviewer_membership_id,
        actor_identity_link_id: null,
        actor_installation_id: input.installation_id,
        command_id: evaluationId,
        provider_event_sha256: input.provider_event_sha256,
        action: "permission.approve",
        subject_kind: "approval",
        subject_id: input.approval_id,
        membership_id: input.reviewer_membership_id,
        identity_link_id: input.identity_link_id,
        connection_id: input.connection_id,
        adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id,
        outcome: "allowed",
        reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
        idempotency_key: `permission-evaluation:${evaluationId}`,
        authority_checked_at: input.evaluated_at,
        authority_evidence_sha256: input.authority_evidence_sha256,
        correlation_id: input.request_id,
        detail: input.detail,
      });
      return Object.freeze({
        authorization_audit_event_id: appended.audit_event_id,
        authorization_audit_entry_sha256: appended.entry_sha256,
      });
    });
  }

  /** Appends the separate schema-v3 organization-member allow audit row. */
  recordOrganizationMemberReadablePermissionDecision(
    input: RecordOrganizationMemberReadablePermissionDecisionInput,
  ): RecordedOrganizationMemberReadablePermissionDecision {
    const evaluationId = id("pce");
    return this.immediateTransaction(() => {
      const appended = this.appendAudit({
        occurred_at: input.evaluated_at, actor_kind: "installation",
        actor_principal_id: input.approving_principal_id,
        actor_membership_id: input.approving_membership_id,
        actor_identity_link_id: null, actor_installation_id: input.installation_id,
        command_id: evaluationId, provider_event_sha256: input.provider_event_sha256,
        action: "permission.approve", subject_kind: "approval", subject_id: input.approval_id,
        membership_id: input.approving_membership_id, identity_link_id: input.identity_link_id,
        connection_id: input.connection_id, adapter_binding_id: input.adapter_binding_id,
        permission_grant_id: input.permission_grant_id, outcome: "allowed",
        reason_code: ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE,
        idempotency_key: `permission-evaluation:${evaluationId}`,
        authority_checked_at: input.evaluated_at,
        authority_evidence_sha256: input.authority_evidence_sha256,
        correlation_id: input.request_id, detail: input.detail,
      });
      return Object.freeze({ authorization_audit_event_id: appended.audit_event_id, authorization_audit_entry_sha256: appended.entry_sha256 });
    });
  }

  /** Exact-ID v3 evidence proof. It rehashes canonical detail and the audit
   * chain entry before comparing every caller-quoted commitment. */
  findAllowedOrganizationMemberAuthorizationEvidenceById(
    auditEventId: string,
    expected: OrganizationMemberAuthorizationEvidenceExpectation,
  ): OrganizationMemberAuthorizationEvidenceMatch {
    let row: ReviewerAuditRow | undefined;
    let predecessor: { entry_sha256: string } | undefined;
    try {
      row = this.database.prepare(`SELECT ${REVIEWER_AUDIT_COLUMNS} FROM organization_integration_audit WHERE audit_event_id = ?`).get(auditEventId) as ReviewerAuditRow | undefined;
      if (row !== undefined && row.audit_sequence > 1) predecessor = this.database.prepare('SELECT entry_sha256 FROM organization_integration_audit WHERE audit_sequence = ?').get(row.audit_sequence - 1) as { entry_sha256: string } | undefined;
    } catch { return Object.freeze({ status: 'unavailable' as const }); }
    if (row === undefined) return Object.freeze({ status: 'absent' as const });
    if (row.organization_id !== this.identity.organization_id || (row.audit_sequence > 1 && (predecessor === undefined || predecessor.entry_sha256 !== row.previous_entry_sha256)) || (row.audit_sequence === 1 && row.previous_entry_sha256 !== null)) return Object.freeze({ status: 'corrupt' as const });
    let detail: Record<string, unknown>;
    try { const parsed = JSON.parse(row.detail_json) as unknown; if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || canonicalJson(parsed as Record<string, unknown>) !== row.detail_json) return Object.freeze({ status: 'corrupt' as const }); detail = parsed as Record<string, unknown>; } catch { return Object.freeze({ status: 'corrupt' as const }); }
    if (digest(detail) !== row.detail_sha256 || organizationIntegrationAuditEntrySha256({ ...row, detail }) !== row.entry_sha256) return Object.freeze({ status: 'corrupt' as const });
    const fields: Readonly<Record<string, unknown>> = { request_sha256: expected.request_sha256, provider_event_sha256: expected.provider_event_sha256, principal_id: expected.principal_id, adapter_instance_id: expected.adapter_instance_id, policy_contract_sha256: expected.policy_contract_sha256, release_draft_sha256: expected.release_draft_sha256, approval_presentation_sha256: expected.approval_presentation_sha256, semantic_intent_sha256: expected.semantic_intent_sha256, message_presentation_sha256: expected.message_presentation_sha256 };
    if (row.reason_code !== ORGANIZATION_MEMBER_READABLE_ALLOW_REASON_CODE || row.outcome !== 'allowed' || row.action !== 'permission.approve' || row.subject_kind !== 'approval' || row.subject_id !== expected.approval_id || row.actor_installation_id !== expected.installation_id || row.actor_principal_id !== expected.principal_id || row.actor_membership_id !== expected.membership_id || row.membership_id !== expected.membership_id || row.correlation_id !== expected.request_id || row.adapter_binding_id !== expected.adapter_binding_id || row.permission_grant_id !== expected.permission_grant_id || row.provider_event_sha256 !== expected.provider_event_sha256 || row.occurred_at !== expected.evaluated_at || row.authority_checked_at !== expected.evaluated_at || row.entry_sha256 !== expected.authorization_audit_entry_sha256 || detail.kind !== 'organization-member-readable-approval-audit-detail-v1' || detail.policy_id !== 'organization-member-readable-v1' || detail.adapter_id !== 'slack-reactions' || Object.entries(fields).some(([key, value]) => detail[key] !== value)) return Object.freeze({ status: 'mismatch' as const });
    return Object.freeze({ status: 'matched' as const, audit_entry_sha256: row.entry_sha256 as `sha256:${string}`, adapter_instance_id: detail.adapter_instance_id as string });
  }

  /**
   * Reconstructs the complete text-free reviewer authorization from one exact
   * immutable audit row.  Startup admission and reviewer reads use this form
   * before canonical record content is available; the existing expected-value
   * lookup below remains the append boundary for a client-signed envelope.
   */
  readAllowedReviewerAuthorizationEvidenceById(
    auditEventId: string,
  ): ReviewerAuthorizationEvidenceRead {
    let row: ReviewerAuditRow | undefined;
    try {
      row = this.database
        .prepare(
          `SELECT ${REVIEWER_AUDIT_COLUMNS}
           FROM organization_integration_audit
           WHERE audit_event_id = ?`,
        )
        .get(auditEventId) as ReviewerAuditRow | undefined;
    } catch {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (row === undefined) return Object.freeze({ status: "absent" as const });
    const detail = reviewerAuditDetail(row);
    const requestSha256 =
      detail === undefined ? undefined : digestField(detail, "request_sha256");
    if (
      detail === undefined ||
      requestSha256 === undefined ||
      row.actor_installation_id === null ||
      row.actor_principal_id === null ||
      row.actor_membership_id === null ||
      row.provider_event_sha256 === null ||
      row.adapter_binding_id === null ||
      row.permission_grant_id === null
    ) {
      return Object.freeze({ status: "corrupt" as const });
    }
    const match = this.findAllowedReviewerAuthorizationEvidenceById(
      auditEventId,
      {
        organization_id: row.organization_id,
        installation_id: row.actor_installation_id,
        approval_id: row.subject_id,
        request_id: row.correlation_id,
        principal_id: row.actor_principal_id,
        membership_id: row.actor_membership_id,
        request_sha256: requestSha256,
        provider_event_sha256: row.provider_event_sha256,
        adapter_binding_id: row.adapter_binding_id,
        permission_grant_id: row.permission_grant_id,
        evaluated_at: row.occurred_at,
        reviewer_release_draft_sha256:
          digestField(detail, "reviewer_release_draft_sha256") ?? "",
        approval_presentation_sha256:
          digestField(detail, "approval_presentation_sha256") ?? "",
        semantic_intent_sha256:
          digestField(detail, "semantic_intent_sha256") ?? "",
        message_presentation_sha256:
          digestField(detail, "message_presentation_sha256") ?? "",
        authorization_audit_entry_sha256: row.entry_sha256,
      },
    );
    if (match.status !== "matched") {
      return Object.freeze({
        status:
          match.status === "unavailable"
            ? ("unavailable" as const)
            : match.status === "absent"
              ? ("absent" as const)
              : ("corrupt" as const),
      });
    }
    return Object.freeze({
      status: "matched" as const,
      evidence: Object.freeze({
        ...match.proof,
        authority_id: detail["authority_id"] as string,
        organization_id: row.organization_id,
        installation_id: row.actor_installation_id,
        approval_id: row.subject_id,
        request_id: row.correlation_id,
        request_sha256: requestSha256,
        provider_event_sha256:
          row.provider_event_sha256 as `sha256:${string}`,
        adapter_binding_id: row.adapter_binding_id,
        permission_grant_id: row.permission_grant_id,
      }),
    });
  }

  /**
   * The exact-primary-key reviewer evidence lookup.
   *
   * It reselects every outer column plus the detail, validates the
   * organization binding and the predecessor/sequence relation, recomputes
   * both the detail digest and the chained entry hash with the same shared
   * helper the append used, reconstructs the semantic and provider-message
   * preimages from the stored values and the fixed consequence, and only then
   * matches the closed reviewer proof. It returns digests and identifiers
   * only: no title, item text, or reconstructed draft.
   */
  findAllowedReviewerAuthorizationEvidenceById(
    auditEventId: string,
    expected: ReviewerAuthorizationEvidenceExpectation,
  ): ReviewerAuthorizationEvidenceMatch {
    let row: ReviewerAuditRow | undefined;
    let predecessor: { entry_sha256: string } | undefined;
    try {
      row = this.database
        .prepare(
          `SELECT ${REVIEWER_AUDIT_COLUMNS}
           FROM organization_integration_audit
           WHERE audit_event_id = ?`,
        )
        .get(auditEventId) as ReviewerAuditRow | undefined;
      if (row !== undefined && row.audit_sequence > 1) {
        predecessor = this.database
          .prepare(
            `SELECT entry_sha256
             FROM organization_integration_audit
             WHERE audit_sequence = ?`,
          )
          .get(row.audit_sequence - 1) as { entry_sha256: string } | undefined;
      }
    } catch {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (row === undefined) return Object.freeze({ status: "absent" as const });
    if (row.organization_id !== this.identity.organization_id) {
      return Object.freeze({ status: "mismatch" as const });
    }
    if (
      row.audit_sequence === 1
        ? row.previous_entry_sha256 !== null
        : predecessor === undefined ||
          predecessor.entry_sha256 !== row.previous_entry_sha256
    ) {
      return Object.freeze({ status: "corrupt" as const });
    }

    const detail = reviewerAuditDetail(row);
    if (detail === undefined) {
      return Object.freeze({ status: "corrupt" as const });
    }
    if (digest(detail) !== row.detail_sha256) {
      return Object.freeze({ status: "corrupt" as const });
    }
    const recomputedEntry = organizationIntegrationAuditEntrySha256({
      ...row,
      detail,
    });
    if (recomputedEntry !== row.entry_sha256) {
      return Object.freeze({ status: "corrupt" as const });
    }

    const releaseDraftSha256 = digestField(
      detail,
      "reviewer_release_draft_sha256",
    );
    const presentationSha256 = digestField(
      detail,
      "approval_presentation_sha256",
    );
    const semanticSha256 = digestField(detail, "semantic_intent_sha256");
    const messageSha256 = digestField(detail, "message_presentation_sha256");
    const authorityId = textField(detail, "authority_id");
    if (
      releaseDraftSha256 === undefined ||
      presentationSha256 === undefined ||
      semanticSha256 === undefined ||
      messageSha256 === undefined ||
      authorityId === undefined ||
      row.actor_principal_id === null ||
      row.actor_membership_id === null
    ) {
      return Object.freeze({ status: "corrupt" as const });
    }

    // Recompute both Authority preimages from stored values and the fixed
    // consequence; a row whose digests do not regenerate is corrupt evidence,
    // never a mismatch the caller could fix by presenting other bytes.
    const recomputedSemantic = canonicalSha256(
      reviewerRestrictedSemanticPreimage({
        authority_id: authorityId,
        organization_id: row.organization_id,
        approval_id: row.subject_id,
        reviewer_principal_id: row.actor_principal_id,
        reviewer_membership_id: row.actor_membership_id,
        reviewer_release_draft_sha256: releaseDraftSha256,
        approval_presentation_sha256: presentationSha256,
        evaluated_at: row.occurred_at,
      }),
    );
    const teamId = textField(detail, "team_id");
    const botUserId = textField(detail, "bot_user_id");
    const botId = textField(detail, "bot_id");
    const appId = textField(detail, "app_id");
    const actorUserId = textField(detail, "actor_user_id");
    const channelId = textField(detail, "channel_id");
    const messageTs = textField(detail, "message_ts");
    const reactionName = textField(detail, "reaction_name");
    const enterpriseId = detail["enterprise_id"];
    if (
      teamId === undefined ||
      botUserId === undefined ||
      botId === undefined ||
      appId === undefined ||
      actorUserId === undefined ||
      channelId === undefined ||
      messageTs === undefined ||
      reactionName === undefined ||
      row.provider_event_sha256 === null ||
      !(enterpriseId === null || typeof enterpriseId === "string")
    ) {
      return Object.freeze({ status: "corrupt" as const });
    }
    const recomputedMessage = canonicalSha256(
      reviewerMessagePresentationPreimage({
        provider_event_sha256: row.provider_event_sha256,
        approval_presentation_sha256: presentationSha256,
        team_id: teamId,
        enterprise_id: enterpriseId,
        bot_user_id: botUserId,
        bot_id: botId,
        app_id: appId,
        actor_user_id: actorUserId,
        channel_id: channelId,
        message_ts: messageTs,
        reaction_name: reactionName,
      }),
    );
    if (
      recomputedSemantic !== semanticSha256 ||
      recomputedMessage !== messageSha256
    ) {
      return Object.freeze({ status: "corrupt" as const });
    }

    if (
      row.reason_code !== RESTRICTED_REVIEWER_ALLOW_REASON_CODE ||
      row.outcome !== "allowed" ||
      row.action !== "permission.approve" ||
      row.subject_kind !== "approval" ||
      row.actor_kind !== "installation" ||
      row.actor_identity_link_id !== null ||
      row.subject_id !== expected.approval_id ||
      row.actor_installation_id !== expected.installation_id ||
      row.correlation_id !== expected.request_id ||
      row.actor_principal_id !== expected.principal_id ||
      row.actor_membership_id !== expected.membership_id ||
      row.membership_id !== expected.membership_id ||
      row.adapter_binding_id !== expected.adapter_binding_id ||
      row.permission_grant_id !== expected.permission_grant_id ||
      row.provider_event_sha256 !== expected.provider_event_sha256 ||
      row.occurred_at !== expected.evaluated_at ||
      row.authority_checked_at !== expected.evaluated_at ||
      authorityId !== this.identity.authority_id ||
      detail["request_sha256"] !== expected.request_sha256 ||
      detail["provider_event_sha256"] !== expected.provider_event_sha256 ||
      detail["principal_id"] !== expected.principal_id ||
      releaseDraftSha256 !== expected.reviewer_release_draft_sha256 ||
      presentationSha256 !== expected.approval_presentation_sha256 ||
      semanticSha256 !== expected.semantic_intent_sha256 ||
      messageSha256 !== expected.message_presentation_sha256 ||
      row.entry_sha256 !== expected.authorization_audit_entry_sha256 ||
      this.identity.organization_id !== expected.organization_id
    ) {
      return Object.freeze({ status: "mismatch" as const });
    }

    return Object.freeze({
      status: "matched" as const,
      audit_entry_sha256: row.entry_sha256 as `sha256:${string}`,
      proof: Object.freeze({
        policy_id: RESTRICTED_REVIEWER_POLICY_ID,
        reviewer_principal_id: row.actor_principal_id,
        reviewer_membership_id: row.actor_membership_id,
        reviewer_release_draft_sha256: releaseDraftSha256,
        approval_presentation_sha256: presentationSha256,
        semantic_intent_sha256: semanticSha256,
        message_presentation_sha256: messageSha256,
        authorization_audit_event_id: row.audit_event_id,
        authorization_audit_entry_sha256: row.entry_sha256 as `sha256:${string}`,
        evaluated_at: row.occurred_at,
      }),
    });
  }

  /**
   * Read-only confirmation that one frozen authorization evidence document is
   * a real allowed evaluation this control plane appended.
   *
   * This adds no table and no column: `organization_integration_audit` already
   * records every permission evaluation, and organization-record ingest reads
   * it exactly as it was written by `recordPermissionDecision`. Every field a
   * caller can present is compared, so a member cannot swap the binding, the
   * grant, the reviewer, the request, or the act and still match.
   *
   * The row proves the evaluation happened; it never proves the installation
   * is still authorized *now*. Currency is the Authority's live lease and
   * enrollment check, which runs alongside this lookup.
   */
  findAllowedApprovalAuthorizationEvidence(
    input: ApprovalAuthorizationEvidenceLookup,
  ): ApprovalAuthorizationEvidenceMatch {
    const rows = this.database
      .prepare(
        `SELECT reason_code, detail_json
         FROM organization_integration_audit
         WHERE organization_id = ?
           AND actor_installation_id = ?
           AND subject_kind = 'approval'
           AND subject_id = ?
           AND action = ?
           AND outcome = 'allowed'
           AND correlation_id = ?
           AND membership_id = ?
           AND adapter_binding_id = ?
           AND permission_grant_id = ?
           AND provider_event_sha256 = ?
           AND reason_code = ?
           AND occurred_at = ?
           AND authority_checked_at = ?
           AND json_extract(detail_json, '$.principal_id') = ?
           AND json_extract(detail_json, '$.request_sha256') = ?
         LIMIT 2`,
      )
      .all(
        input.organization_id,
        input.installation_id,
        input.approval_id,
        `permission.${input.action}`,
        input.request_id,
        input.membership_id,
        input.adapter_binding_id,
        input.permission_grant_id,
        input.provider_event_sha256,
        input.reason_code,
        input.evaluated_at,
        input.evaluated_at,
        input.principal_id,
        input.request_sha256,
      ) as ApprovalAuthorizationEvidenceRow[];
    if (rows.length === 0) return Object.freeze({ status: "absent" as const });
    if (rows.length > 1) {
      return Object.freeze({ status: "ambiguous" as const });
    }
    const eligibility = permissionPilotEligibilityFromAudit(
      rows[0] as ApprovalAuthorizationEvidenceRow,
      input.action,
    );
    if (eligibility === undefined) {
      return Object.freeze({ status: "corrupt" as const });
    }
    return Object.freeze({
      status: "matched" as const,
      ...(eligibility === null
        ? {}
        : { permission_pilot_eligibility: eligibility }),
    });
  }

  overview(): OrganizationIntegrationsOverview {
    const identityLinks = this.database
      .prepare(
        `SELECT identity_link_id, membership_id, provider,
                provider_tenant_id, provider_subject_id, status, verified_at,
                revoked_at
         FROM organization_external_identity_links
         ORDER BY verified_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const connections = this.database
      .prepare(
        `SELECT connection_id, owner_kind, provider, provider_tenant_id,
                provider_subject_id, granted_scopes_json, status,
                public_configuration_json, public_configuration_sha256,
                activated_at, revoked_at
         FROM organization_tool_connections
         ORDER BY activated_at DESC`,
      )
      .all() as ToolConnectionOverviewRow[];
    for (const connection of connections) {
      validatedPublicConfiguration(connection);
    }
    const bindings = this.database
      .prepare(
        `SELECT adapter_binding_id, installation_id, adapter_kind, adapter_id,
                adapter_instance_id, adapter_version, connection_id, status,
                public_configuration_json, bound_at, revoked_at
         FROM organization_adapter_bindings
         ORDER BY bound_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const grants = this.database
      .prepare(
        `SELECT permission_grant_id, adapter_binding_id, membership_id,
                action, status, granted_at, revoked_at
         FROM organization_permission_grants
         ORDER BY granted_at DESC`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    const audit = this.database
      .prepare(
        `SELECT audit_sequence, occurred_at, actor_kind, action, subject_kind,
                subject_id, membership_id, outcome, reason_code
         FROM organization_integration_audit
         ORDER BY audit_sequence DESC
         LIMIT 50`,
      )
      .all() as Readonly<Record<string, unknown>>[];
    return Object.freeze({
      identity_links: Object.freeze(identityLinks),
      tool_connections: Object.freeze(connections),
      adapter_bindings: Object.freeze(bindings),
      permission_grants: Object.freeze(grants),
      recent_audit: Object.freeze(audit),
    });
  }

  close(): void {
    this.database.close();
  }

  private appendAudit(input: {
    occurred_at: string;
    actor_kind: "membership" | "provider_identity" | "installation" | "system";
    actor_principal_id: string | null;
    actor_membership_id: string | null;
    actor_identity_link_id: string | null;
    actor_installation_id: string | null;
    command_id: string;
    provider_event_sha256: string | null;
    action: string;
    subject_kind: string;
    subject_id: string;
    membership_id: string | null;
    identity_link_id: string | null;
    connection_id: string | null;
    adapter_binding_id: string | null;
    permission_grant_id: string | null;
    outcome: "allowed" | "denied" | "succeeded" | "failed";
    reason_code: string;
    idempotency_key: string;
    authority_checked_at: string | null;
    authority_evidence_sha256: string | null;
    correlation_id: string;
    detail: Readonly<Record<string, unknown>>;
  }): { audit_event_id: string; entry_sha256: `sha256:${string}` } {
    const tail = this.database
      .prepare(
        `SELECT audit_sequence, entry_sha256
         FROM organization_integration_audit
         ORDER BY audit_sequence DESC
         LIMIT 1`,
      )
      .get() as AuditTail | undefined;
    const auditSequence = (tail?.audit_sequence ?? 0) + 1;
    const previousEntrySha256 = tail?.entry_sha256 ?? null;
    const detailJson = canonicalJson(input.detail);
    const detailSha256 = digest(input.detail);
    const auditEventId = id("aud");
    const entrySha256 = organizationIntegrationAuditEntrySha256({
      audit_sequence: auditSequence,
      audit_event_id: auditEventId,
      previous_entry_sha256: previousEntrySha256,
      ...input,
      detail_json: detailJson,
      detail_sha256: detailSha256,
    });
    this.database
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
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        auditSequence,
        auditEventId,
        previousEntrySha256,
        entrySha256,
        this.identity.organization_id,
        input.occurred_at,
        input.actor_kind,
        input.actor_principal_id,
        input.actor_membership_id,
        input.actor_identity_link_id,
        input.actor_installation_id,
        input.command_id,
        input.provider_event_sha256,
        input.action,
        input.subject_kind,
        input.subject_id,
        input.membership_id,
        input.identity_link_id,
        input.connection_id,
        input.adapter_binding_id,
        input.permission_grant_id,
        input.outcome,
        input.reason_code,
        input.idempotency_key,
        input.authority_checked_at,
        input.authority_evidence_sha256,
        input.correlation_id,
        detailJson,
        detailSha256,
      );
    return { audit_event_id: auditEventId, entry_sha256: entrySha256 };
  }
}
