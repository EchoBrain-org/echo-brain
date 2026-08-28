import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import {
  validateOrganizationRecordReceiptBodyV2,
  type OrganizationRecordReceiptBodyV2,
} from "@echo-brain/organization-protocol";
import {
  validatePrivateApprovalResolutionV1,
  type ApprovalContractSha256,
  type PrivateApprovalAssignmentV1,
  type PrivateApprovalResolutionV1,
  type PrivateApprovalSlackIdentityLinkV1,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import type Database from "better-sqlite3";
import type { GranolaMeetingOwnerPrivateApprovalTargetV1 } from "./resolve-granola-meeting-owner-private-approval-target-v1.js";

/**
 * The Authority-owned, immutable assignment persistence for the private
 * meeting-owner path. It has no Slack ingress or Control Plane write path:
 * callers must first obtain the read-only owner target and open the DM.
 */
export const PRIVATE_APPROVAL_ASSIGNMENT_CAPABILITY_KIND_V1 =
  "echo-private-approval-assignment-capability-v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SLACK_WORKSPACE_ID = /^T[A-Z0-9]{2,255}$/;
const SLACK_ENTERPRISE_ID = /^E[A-Z0-9]{2,255}$/;
const SLACK_SUBJECT_ID = /^[UW][A-Z0-9]{2,255}$/;
const SLACK_DM_CHANNEL_ID = /^D[A-Z0-9]{2,255}$/;
const SLACK_MESSAGE_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{1,9}$/;

type Digest = ApprovalContractSha256;
type UnknownRecord = Record<string, unknown>;

/**
 * The Authority never signs or verifies a V4 receipt. It persists the exact
 * canonical receipt returned by the V4 append boundary after validating its
 * versioned body and self-digest. Signature verification belongs to the V4
 * caller which owns the configured public-key trust set.
 */
export interface CanonicalPrivateApprovalV4ReceiptV1 {
  readonly body: OrganizationRecordReceiptBodyV2;
  readonly receipt_sha256: Digest;
  readonly signing_key_descriptor: Readonly<Record<string, unknown>>;
  readonly signature: string;
}

export interface PrivateApprovalCandidateCommitmentV1 {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly candidate_sha256: Digest;
  readonly frozen_card_sha256: Digest;
  readonly approved_snapshot_sha256: Digest;
}

/** A current Slack approval binding is an input commitment, never inferred. */
export interface PrivateApprovalSlackApprovalBindingV1 {
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: Digest;
}

/** The direct-message proof returned by `conversations.open`. */
export interface PrivateApprovalSlackDmChannelV1 {
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly channel_id: string;
}

export interface StagePrivateApprovalAssignmentInputV1 {
  readonly candidate: PrivateApprovalCandidateCommitmentV1;
  readonly owner_target: GranolaMeetingOwnerPrivateApprovalTargetV1;
  readonly approval_binding: PrivateApprovalSlackApprovalBindingV1;
  readonly dm_channel: PrivateApprovalSlackDmChannelV1;
}

export interface PrivateApprovalAssignmentStateV1 {
  readonly organization_id: string;
  readonly candidate: PrivateApprovalCandidateCommitmentV1;
  readonly assignment: PrivateApprovalAssignmentV1;
  readonly connection_id: string;
  readonly connection_contract_sha256: Digest;
  readonly connection_state_sha256: Digest;
  readonly approval_binding: PrivateApprovalSlackApprovalBindingV1;
  readonly dm_channel: PrivateApprovalSlackDmChannelV1;
  readonly created_at: string;
}

export interface StagedPrivateApprovalAssignmentV1 {
  readonly assignment: PrivateApprovalAssignmentStateV1;
  /** True only for the transaction which inserted the immutable row. */
  readonly created: boolean;
}

/**
 * Recovery-only presentation data. This is intentionally not a current
 * approval capability: callers must use `readCurrent` before authorizing a
 * new action. It exists so a superseded DM can be tombstoned from its frozen
 * card/snapshot evidence.
 */
export interface PrivateApprovalPresentationRecoveryV1 {
  readonly assignment: PrivateApprovalAssignmentStateV1;
  readonly provider_message_ts: string;
  readonly source_outbox_state: "posted" | "staged" | "superseded";
}

export interface RecordPrivateApprovalTerminalReceiptInputV1 {
  readonly candidate_id: string;
  readonly resolution: PrivateApprovalResolutionV1;
  /** Mandatory for approval, forbidden for rejection. */
  readonly v4_receipt?: CanonicalPrivateApprovalV4ReceiptV1;
}

export interface PrivateApprovalTerminalReceiptV1 {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly outcome: "approved" | "rejected";
  readonly resolution: PrivateApprovalResolutionV1;
  readonly resolution_sha256: Digest;
  readonly v4_receipt: CanonicalPrivateApprovalV4ReceiptV1 | null;
  readonly v4_receipt_sha256: Digest | null;
  readonly card_render_state: "unrendered" | "rendered";
  readonly card_rendered_at: string | null;
  readonly recorded_at: string;
}

interface AssignmentRow {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly assignment_version: number;
  readonly assignment_json: string;
  readonly assignment_sha256: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: string;
  readonly connection_state_sha256: string;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: string;
  readonly external_identity_link_id: string;
  readonly external_identity_link_contract_sha256: string;
  readonly assignee_principal_id: string;
  readonly assignee_membership_id: string;
  readonly slack_workspace_id: string;
  readonly slack_enterprise_id: string | null;
  readonly slack_subject_id: string;
  readonly slack_dm_channel_id: string;
  readonly created_at: string;
}

interface TerminalRow {
  readonly approval_id: string;
  readonly candidate_id: string;
  readonly outcome: "approved" | "rejected";
  readonly resolution_json: string;
  readonly resolution_sha256: string;
  readonly v4_receipt_json: string | null;
  readonly v4_receipt_sha256: string | null;
  readonly card_render_state: "unrendered" | "rendered";
  readonly card_rendered_at: string | null;
  readonly recorded_at: string;
}

interface CurrentCandidateRow {
  readonly candidate_id: string;
  readonly candidate_semantic_sha256: string;
}

interface PresentationCandidateRow extends CurrentCandidateRow {
  readonly approval_id: string;
  readonly frozen_card_sha256: string;
  readonly approved_snapshot_sha256: string;
  readonly provider_message_ts: string;
  readonly state: "posted" | "staged" | "superseded";
}

interface AuthorityMetadataRow {
  readonly organization_id: string;
}

function fail(detail: string): never {
  throw new Error(`private approval assignment ${detail}`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(`${label} must be a bounded canonical identifier`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertPositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function assertCanonicalUtcMillis(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    fail(`${label} must be a UTC-millisecond timestamp`);
  }
}

function plainRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not contain symbol keys`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail(`${label} field ${key} must be an enumerable data property`);
    }
  }
  return value as UnknownRecord;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  const record = plainRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return record;
}

function parseCanonical(json: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== json) fail(`${label} is not canonical`);
  return parsed;
}

function slackLink(
  value: unknown,
  label: string,
): PrivateApprovalSlackIdentityLinkV1 {
  const record = exactRecord(
    value,
    [
      "provider",
      "external_identity_link_id",
      "external_identity_link_contract_sha256",
      "provider_subject_id",
    ],
    label,
  );
  if (record.provider !== "slack") fail(`${label} provider is invalid`);
  assertIdentifier(record.external_identity_link_id, `${label} external identity link`);
  assertDigest(
    record.external_identity_link_contract_sha256,
    `${label} external identity link contract`,
  );
  if (
    typeof record.provider_subject_id !== "string" ||
    !SLACK_SUBJECT_ID.test(record.provider_subject_id)
  ) {
    fail(`${label} Slack subject is invalid`);
  }
  return Object.freeze({
    provider: "slack",
    external_identity_link_id: record.external_identity_link_id,
    external_identity_link_contract_sha256:
      record.external_identity_link_contract_sha256,
    provider_subject_id: record.provider_subject_id,
  });
}

function assignment(
  value: unknown,
  label: string,
): PrivateApprovalAssignmentV1 {
  const record = exactRecord(
    value,
    [
      "schema_version",
      "assignment_version",
      "current_assignee",
      "current_slack_identity_link",
      "assignment_capability_sha256",
    ],
    label,
  );
  if (record.schema_version !== 1) fail(`${label} schema version is invalid`);
  assertPositive(record.assignment_version, `${label} version`);
  const assignee = exactRecord(
    record.current_assignee,
    ["principal_id", "membership_id"],
    `${label} assignee`,
  );
  assertIdentifier(assignee.principal_id, `${label} assignee principal`);
  assertIdentifier(assignee.membership_id, `${label} assignee membership`);
  assertDigest(record.assignment_capability_sha256, `${label} capability`);
  return Object.freeze({
    schema_version: 1,
    assignment_version: record.assignment_version,
    current_assignee: Object.freeze({
      principal_id: assignee.principal_id,
      membership_id: assignee.membership_id,
    }),
    current_slack_identity_link: slackLink(
      record.current_slack_identity_link,
      `${label} Slack identity link`,
    ),
    assignment_capability_sha256: record.assignment_capability_sha256,
  });
}

function candidate(
  value: unknown,
  label: string,
): PrivateApprovalCandidateCommitmentV1 {
  const record = exactRecord(
    value,
    [
      "approval_id",
      "candidate_id",
      "candidate_sha256",
      "frozen_card_sha256",
      "approved_snapshot_sha256",
    ],
    label,
  );
  assertIdentifier(record.approval_id, `${label} approval id`);
  assertIdentifier(record.candidate_id, `${label} candidate id`);
  assertDigest(record.candidate_sha256, `${label} candidate`);
  assertDigest(record.frozen_card_sha256, `${label} frozen card`);
  assertDigest(record.approved_snapshot_sha256, `${label} approved snapshot`);
  return Object.freeze({
    approval_id: record.approval_id,
    candidate_id: record.candidate_id,
    candidate_sha256: record.candidate_sha256,
    frozen_card_sha256: record.frozen_card_sha256,
    approved_snapshot_sha256: record.approved_snapshot_sha256,
  });
}

function approvalBinding(
  value: unknown,
  label: string,
): PrivateApprovalSlackApprovalBindingV1 {
  const record = exactRecord(
    value,
    ["approval_binding_id", "approval_binding_contract_sha256"],
    label,
  );
  assertIdentifier(record.approval_binding_id, `${label} id`);
  assertDigest(record.approval_binding_contract_sha256, `${label} contract`);
  return Object.freeze({
    approval_binding_id: record.approval_binding_id,
    approval_binding_contract_sha256: record.approval_binding_contract_sha256,
  });
}

function dmChannel(
  value: unknown,
  label: string,
): PrivateApprovalSlackDmChannelV1 {
  const record = exactRecord(
    value,
    ["workspace_id", "enterprise_id", "channel_id"],
    label,
  );
  if (
    typeof record.workspace_id !== "string" ||
    !SLACK_WORKSPACE_ID.test(record.workspace_id)
  ) {
    fail(`${label} workspace id is invalid`);
  }
  if (
    record.enterprise_id !== null &&
    (typeof record.enterprise_id !== "string" ||
      !SLACK_ENTERPRISE_ID.test(record.enterprise_id))
  ) {
    fail(`${label} enterprise id is invalid`);
  }
  if (
    typeof record.channel_id !== "string" ||
    !SLACK_DM_CHANNEL_ID.test(record.channel_id)
  ) {
    fail(`${label} channel id is not a direct-message channel`);
  }
  return Object.freeze({
    workspace_id: record.workspace_id,
    enterprise_id: record.enterprise_id,
    channel_id: record.channel_id,
  });
}

function v4Receipt(
  value: unknown,
  label: string,
): CanonicalPrivateApprovalV4ReceiptV1 {
  const record = exactRecord(
    value,
    ["body", "receipt_sha256", "signing_key_descriptor", "signature"],
    label,
  );
  const body = validateOrganizationRecordReceiptBodyV2(record.body);
  assertDigest(record.receipt_sha256, `${label} receipt digest`);
  if (canonicalSha256(body) !== record.receipt_sha256) {
    fail(`${label} receipt digest is invalid`);
  }
  const descriptor = plainRecord(
    record.signing_key_descriptor,
    `${label} signing key descriptor`,
  );
  if (typeof record.signature !== "string" || record.signature.length === 0) {
    fail(`${label} signature is invalid`);
  }
  return Object.freeze({
    body,
    receipt_sha256: record.receipt_sha256,
    signing_key_descriptor: Object.freeze({ ...descriptor }),
    signature: record.signature,
  });
}

/**
 * Deterministically binds an assignment to the exact private approval
 * candidate, pending card and snapshot. The DM is deliberately excluded: it
 * is a presentation binding reproved separately at interaction time.
 */
export function privateApprovalAssignmentCapabilitySha256V1(input: {
  readonly organization_id: string;
  readonly candidate: PrivateApprovalCandidateCommitmentV1;
  readonly assignment_version: number;
  readonly current_assignee: PrivateApprovalAssignmentV1["current_assignee"];
  readonly current_slack_identity_link: PrivateApprovalSlackIdentityLinkV1;
}): Digest {
  const organizationId = input.organization_id;
  assertIdentifier(organizationId, "capability organization id");
  const commitment = candidate(input.candidate, "capability candidate");
  assertPositive(input.assignment_version, "capability assignment version");
  const assignee = exactRecord(
    input.current_assignee,
    ["principal_id", "membership_id"],
    "capability assignee",
  );
  assertIdentifier(assignee.principal_id, "capability assignee principal");
  assertIdentifier(assignee.membership_id, "capability assignee membership");
  const link = slackLink(
    input.current_slack_identity_link,
    "capability Slack identity link",
  );
  return canonicalSha256({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_ASSIGNMENT_CAPABILITY_KIND_V1,
    approval_id: commitment.approval_id,
    organization_id: organizationId,
    candidate_sha256: commitment.candidate_sha256,
    frozen_card_sha256: commitment.frozen_card_sha256,
    approved_snapshot_sha256: commitment.approved_snapshot_sha256,
    assignment_version: input.assignment_version,
    current_assignee: {
      principal_id: assignee.principal_id,
      membership_id: assignee.membership_id,
    },
    current_slack_identity_link: link,
  }) as Digest;
}

function currentCandidate(
  database: Database.Database,
  candidateCommitment: PrivateApprovalCandidateCommitmentV1,
): CurrentCandidateRow | undefined {
  return database
    .prepare(
      `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256
         FROM authority_clean_live_candidates_v1 AS candidate
         JOIN authority_clean_live_approval_outbox_v1 AS outbox
           ON outbox.candidate_id = candidate.candidate_id
         JOIN authority_clean_live_review_lineage_heads_v1 AS head
           ON head.review_lineage_id = candidate.review_lineage_id
        WHERE outbox.approval_id = ?
          AND candidate.candidate_id = ?
          AND candidate.candidate_semantic_sha256 = ?
          AND candidate.disposition = 'actionable'
          AND outbox.state != 'superseded'
          AND head.candidate_id = candidate.candidate_id`,
    )
    .get(
      candidateCommitment.approval_id,
      candidateCommitment.candidate_id,
      candidateCommitment.candidate_sha256,
    ) as CurrentCandidateRow | undefined;
}

function metadataOrganizationId(database: Database.Database): string {
  const row = database
    .prepare(
      `SELECT organization_id FROM authority_metadata WHERE singleton = 1`,
    )
    .get() as AuthorityMetadataRow | undefined;
  if (row === undefined) fail("has no Authority metadata");
  assertIdentifier(row.organization_id, "stored Authority organization id");
  return row.organization_id;
}

function assignmentFromRow(
  row: AssignmentRow,
): Omit<
  PrivateApprovalAssignmentStateV1,
  "organization_id" | "candidate"
> {
  const parsed = assignment(parseCanonical(row.assignment_json, "stored assignment"), "stored assignment");
  assertDigest(row.assignment_sha256, "stored assignment digest");
  if (canonicalSha256(parsed) !== row.assignment_sha256) {
    fail("stored assignment digest is invalid");
  }
  if (parsed.assignment_version !== row.assignment_version) {
    fail("stored assignment version disagrees with its projection");
  }
  assertIdentifier(row.connection_id, "stored connection id");
  assertDigest(row.connection_contract_sha256, "stored connection contract");
  assertDigest(row.connection_state_sha256, "stored connection state");
  const binding = approvalBinding(
    {
      approval_binding_id: row.approval_binding_id,
      approval_binding_contract_sha256: row.approval_binding_contract_sha256,
    },
    "stored approval binding",
  );
  const link = slackLink(
    {
      provider: "slack",
      external_identity_link_id: row.external_identity_link_id,
      external_identity_link_contract_sha256:
        row.external_identity_link_contract_sha256,
      provider_subject_id: row.slack_subject_id,
    },
    "stored Slack identity link",
  );
  if (
    parsed.current_assignee.principal_id !== row.assignee_principal_id ||
    parsed.current_assignee.membership_id !== row.assignee_membership_id ||
    parsed.current_slack_identity_link.external_identity_link_id !==
      link.external_identity_link_id ||
    parsed.current_slack_identity_link.external_identity_link_contract_sha256 !==
      link.external_identity_link_contract_sha256 ||
    parsed.current_slack_identity_link.provider_subject_id !== link.provider_subject_id
  ) {
    fail("stored assignment identity projection disagrees with its body");
  }
  const dm = dmChannel(
    {
      workspace_id: row.slack_workspace_id,
      enterprise_id: row.slack_enterprise_id,
      channel_id: row.slack_dm_channel_id,
    },
    "stored Slack DM",
  );
  assertCanonicalUtcMillis(row.created_at, "stored assignment creation time");
  return Object.freeze({
    assignment: parsed,
    connection_id: row.connection_id,
    connection_contract_sha256: row.connection_contract_sha256,
    connection_state_sha256: row.connection_state_sha256,
    approval_binding: binding,
    dm_channel: dm,
    created_at: row.created_at,
  });
}

function sameAssignment(
  left: PrivateApprovalAssignmentStateV1,
  right: PrivateApprovalAssignmentStateV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Stages exactly one immutable owner assignment. A retry gets the same row;
 * any changed owner, Slack proof, DM, card, or current-candidate commitment
 * is an explicit conflict rather than a replacement.
 */
export class SqlitePrivateApprovalAssignmentStateV1 {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  stage(
    input: StagePrivateApprovalAssignmentInputV1,
  ): StagedPrivateApprovalAssignmentV1 {
    return this.database.transaction(() => {
      const organizationId = metadataOrganizationId(this.database);
      const commitment = candidate(input.candidate, "stage candidate");
      const dm = dmChannel(input.dm_channel, "stage Slack DM");
      const binding = approvalBinding(input.approval_binding, "stage approval binding");
      const owner = input.owner_target;
      if (owner.slack_target.connection.body.organization_id !== organizationId) {
        fail("stage owner target does not match Authority metadata");
      }
      if (
        owner.slack_target.connection.body.provider_tenant_id !== dm.workspace_id ||
        owner.slack_target.connection.body.provider_enterprise_id !== dm.enterprise_id
      ) {
        fail("stage Slack DM does not match the verified workspace");
      }
      assertIdentifier(
        owner.slack_target.connection.body.connection_id,
        "stage connection id",
      );
      assertDigest(owner.slack_target.connection.sha256, "stage connection contract");
      assertDigest(
        owner.slack_target.connection_state.sha256,
        "stage connection state",
      );
      if (currentCandidate(this.database, commitment) === undefined) {
        fail("stage candidate is not current");
      }
      const currentAssignee = Object.freeze({
        principal_id: owner.assignee.principal_id,
        membership_id: owner.assignee.membership_id,
      });
      const currentLink = owner.slack_target.current_slack_identity_link;
      const assignmentVersion = 1;
      const capability = privateApprovalAssignmentCapabilitySha256V1({
        organization_id: organizationId,
        candidate: commitment,
        assignment_version: assignmentVersion,
        current_assignee: currentAssignee,
        current_slack_identity_link: currentLink,
      });
      const assignmentBody: PrivateApprovalAssignmentV1 = assignment(
        {
          schema_version: 1,
          assignment_version: assignmentVersion,
          current_assignee: currentAssignee,
          current_slack_identity_link: currentLink,
          assignment_capability_sha256: capability,
        },
        "stage assignment",
      );
      const expected: PrivateApprovalAssignmentStateV1 = Object.freeze({
        organization_id: organizationId,
        candidate: commitment,
        assignment: assignmentBody,
        connection_id: owner.slack_target.connection.body.connection_id,
        connection_contract_sha256: owner.slack_target.connection.sha256,
        connection_state_sha256: owner.slack_target.connection_state.sha256,
        approval_binding: binding,
        dm_channel: dm,
        created_at: "",
      });
      const existing = this.rowByApprovalId(commitment.approval_id);
      if (existing !== undefined) {
        const stored = this.reproveRow(existing, commitment, organizationId);
        const candidateExpected = { ...expected, created_at: stored.created_at };
        if (!sameAssignment(stored, candidateExpected)) {
          fail("stage conflicts with the immutable assignment");
        }
        return Object.freeze({ assignment: stored, created: false });
      }
      const createdAt = this.now();
      assertCanonicalUtcMillis(createdAt, "stage time");
      this.database
        .prepare(
          `INSERT INTO authority_private_approval_assignments_v2 (
             approval_id, candidate_id, assignment_version, assignment_json,
             assignment_sha256, connection_id, connection_contract_sha256,
             connection_state_sha256, approval_binding_id,
             approval_binding_contract_sha256, external_identity_link_id,
             external_identity_link_contract_sha256, assignee_principal_id,
             assignee_membership_id, slack_workspace_id, slack_enterprise_id,
             slack_subject_id, slack_dm_channel_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commitment.approval_id,
          commitment.candidate_id,
          assignmentVersion,
          canonicalJson(assignmentBody),
          canonicalSha256(assignmentBody),
          owner.slack_target.connection.body.connection_id,
          owner.slack_target.connection.sha256,
          owner.slack_target.connection_state.sha256,
          binding.approval_binding_id,
          binding.approval_binding_contract_sha256,
          currentLink.external_identity_link_id,
          currentLink.external_identity_link_contract_sha256,
          currentAssignee.principal_id,
          currentAssignee.membership_id,
          dm.workspace_id,
          dm.enterprise_id,
          currentLink.provider_subject_id,
          dm.channel_id,
          createdAt,
        );
      const row = this.rowByApprovalId(commitment.approval_id);
      if (row === undefined) fail("stage insert is absent");
      return Object.freeze({
        assignment: this.reproveRow(row, commitment, organizationId),
        created: true,
      });
    })();
  }

  /**
   * Reproves the assignment against the current source candidate. Slack
   * ingress must separately reprove the connection/link/message presentation
   * commitments from the Control Plane; this method exposes no such authority.
   */
  readCurrent(
    candidateCommitment: PrivateApprovalCandidateCommitmentV1,
    assignmentVersion = 1,
  ): PrivateApprovalAssignmentStateV1 | undefined {
    const commitment = candidate(candidateCommitment, "read candidate");
    assertPositive(assignmentVersion, "read assignment version");
    return this.database.transaction(() => {
      const row = this.rowByApprovalId(commitment.approval_id);
      if (row === undefined || row.assignment_version !== assignmentVersion) {
        return undefined;
      }
      if (currentCandidate(this.database, commitment) === undefined) return undefined;
      return this.reproveRow(
        row,
        commitment,
        metadataOrganizationId(this.database),
      );
    })();
  }

  /**
   * Reconstructs frozen presentation evidence without requiring the lineage
   * head to remain current. It is read-only and must never be used to accept
   * a Slack action: a superseded assignment can be returned specifically so
   * its already-posted DM card can be rendered inert.
   */
  readForPresentation(
    approvalId: string,
  ): PrivateApprovalPresentationRecoveryV1 | undefined {
    assertIdentifier(approvalId, "presentation approval id");
    return this.database.transaction(() => {
      const row = this.rowByApprovalId(approvalId);
      if (row === undefined) return undefined;
      const source = this.presentationCandidate(row);
      if (source === undefined) return undefined;
      const commitment = candidate(
        {
          approval_id: source.approval_id,
          candidate_id: source.candidate_id,
          candidate_sha256: source.candidate_semantic_sha256,
          frozen_card_sha256: source.frozen_card_sha256,
          approved_snapshot_sha256: source.approved_snapshot_sha256,
        },
        "presentation candidate",
      );
      if (!SLACK_MESSAGE_TIMESTAMP.test(source.provider_message_ts)) {
        fail("presentation provider message timestamp is invalid");
      }
      return Object.freeze({
        assignment: this.reproveRow(
          row,
          commitment,
          metadataOrganizationId(this.database),
        ),
        provider_message_ts: source.provider_message_ts,
        source_outbox_state: source.state,
      });
    })();
  }

  readTerminal(
    approvalId: string,
  ): PrivateApprovalTerminalReceiptV1 | undefined {
    assertIdentifier(approvalId, "terminal approval id");
    return this.database.transaction(() => {
      const row = this.terminalRowByApprovalId(approvalId);
      return row === undefined ? undefined : this.terminalFromRow(row);
    })();
  }

  recordTerminal(
    input: RecordPrivateApprovalTerminalReceiptInputV1,
  ): PrivateApprovalTerminalReceiptV1 {
    return this.database.transaction(() => {
      assertIdentifier(input.candidate_id, "terminal candidate id");
      const resolution = validatePrivateApprovalResolutionV1(input.resolution);
      const assignmentRow = this.rowByApprovalId(resolution.approval_id);
      if (
        assignmentRow === undefined ||
        assignmentRow.candidate_id !== input.candidate_id
      ) {
        fail("terminal receipt has no matching assignment");
      }
      const organizationId = metadataOrganizationId(this.database);
      const candidateCommitment = this.commitmentFromResolution(
        assignmentRow,
        organizationId,
        resolution,
      );
      const staged = this.reproveRow(
        assignmentRow,
        candidateCommitment,
        organizationId,
      );
      if (
        resolution.assignment_version !== staged.assignment.assignment_version ||
        resolution.assignment_capability_sha256 !==
          staged.assignment.assignment_capability_sha256 ||
        resolution.final_approver.principal_id !==
          staged.assignment.current_assignee.principal_id ||
        resolution.final_approver.membership_id !==
          staged.assignment.current_assignee.membership_id ||
        canonicalJson(resolution.current_slack_identity_link) !==
          canonicalJson(staged.assignment.current_slack_identity_link)
      ) {
        fail("terminal resolution does not match its assignment");
      }
      const outcome = resolution.action === "approve" ? "approved" : "rejected";
      const receipt =
        input.v4_receipt === undefined
          ? undefined
          : v4Receipt(input.v4_receipt, "terminal V4 receipt");
      if (
        (outcome === "approved" && receipt === undefined) ||
        (outcome === "rejected" && receipt !== undefined)
      ) {
        fail("terminal V4 receipt does not match its outcome");
      }
      const resolutionJson = canonicalJson(resolution);
      const resolutionSha256 = canonicalSha256(resolution) as Digest;
      const receiptJson = receipt === undefined ? null : canonicalJson(receipt);
      const receiptSha256 =
        receipt === undefined ? null : (canonicalSha256(receipt) as Digest);
      const existing = this.terminalRowByApprovalId(resolution.approval_id);
      if (existing !== undefined) {
        const durable = this.terminalFromRow(existing);
        if (
          durable.candidate_id !== input.candidate_id ||
          durable.outcome !== outcome ||
          durable.resolution_sha256 !== resolutionSha256 ||
          durable.v4_receipt_sha256 !== receiptSha256
        ) {
          fail("terminal receipt conflicts with the immutable outcome");
        }
        return durable;
      }
      /*
       * Finalization itself is current-only under the Authority fence. Once
       * Control Plane has committed that terminal, however, recovery must
       * complete it even if a newer meeting revision supersedes this outbox
       * before the V4 receipt can be recorded. Reprove the immutable frozen
       * presentation tuple instead of requiring the lineage head to remain
       * current. This cannot authorize a new action: it is reachable only
       * after the durable CP terminal above has been independently reproved.
       */
      const presentation = this.presentationCandidate(assignmentRow);
      if (
        presentation === undefined ||
        presentation.candidate_semantic_sha256 !== candidateCommitment.candidate_sha256 ||
        presentation.frozen_card_sha256 !== candidateCommitment.frozen_card_sha256 ||
        presentation.approved_snapshot_sha256 !==
          candidateCommitment.approved_snapshot_sha256
      ) {
        fail("terminal receipt frozen candidate is unavailable");
      }
      const recordedAt = this.now();
      assertCanonicalUtcMillis(recordedAt, "terminal receipt time");
      this.database
        .prepare(
          `INSERT INTO authority_private_approval_terminal_receipts_v2 (
             approval_id, candidate_id, outcome, resolution_json,
             resolution_sha256, v4_receipt_json, v4_receipt_sha256,
             card_render_state, card_rendered_at, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unrendered', NULL, ?)`,
        )
        .run(
          resolution.approval_id,
          input.candidate_id,
          outcome,
          resolutionJson,
          resolutionSha256,
          receiptJson,
          receiptSha256,
          recordedAt,
        );
      const row = this.terminalRowByApprovalId(resolution.approval_id);
      if (row === undefined) fail("terminal receipt insert is absent");
      return this.terminalFromRow(row);
    })();
  }

  /** One-way projection receipt for the eventual Slack `chat.update` worker. */
  markTerminalCardRendered(
    approvalId: string,
  ): PrivateApprovalTerminalReceiptV1 | undefined {
    assertIdentifier(approvalId, "terminal card approval id");
    return this.database.transaction(() => {
      const existing = this.terminalRowByApprovalId(approvalId);
      if (existing === undefined) return undefined;
      const durable = this.terminalFromRow(existing);
      if (durable.card_render_state === "rendered") return durable;
      const renderedAt = this.now();
      assertCanonicalUtcMillis(renderedAt, "terminal card render time");
      const update = this.database
        .prepare(
          `UPDATE authority_private_approval_terminal_receipts_v2
              SET card_render_state = 'rendered', card_rendered_at = ?
            WHERE approval_id = ?
              AND card_render_state = 'unrendered'
              AND card_rendered_at IS NULL`,
        )
        .run(renderedAt, approvalId);
      if (update.changes !== 1) fail("terminal card render state drifted");
      const updated = this.terminalRowByApprovalId(approvalId);
      if (updated === undefined) fail("terminal receipt disappeared");
      return this.terminalFromRow(updated);
    })();
  }

  private rowByApprovalId(approvalId: string): AssignmentRow | undefined {
    return this.database
      .prepare(
        `SELECT approval_id, candidate_id, assignment_version, assignment_json,
                assignment_sha256, connection_id, connection_contract_sha256,
                connection_state_sha256, approval_binding_id,
                approval_binding_contract_sha256, external_identity_link_id,
                external_identity_link_contract_sha256, assignee_principal_id,
                assignee_membership_id, slack_workspace_id, slack_enterprise_id,
                slack_subject_id, slack_dm_channel_id, created_at
           FROM authority_private_approval_assignments_v2
          WHERE approval_id = ?`,
      )
      .get(approvalId) as AssignmentRow | undefined;
  }

  private terminalRowByApprovalId(approvalId: string): TerminalRow | undefined {
    return this.database
      .prepare(
        `SELECT approval_id, candidate_id, outcome, resolution_json,
                resolution_sha256, v4_receipt_json, v4_receipt_sha256,
                card_render_state, card_rendered_at, recorded_at
           FROM authority_private_approval_terminal_receipts_v2
          WHERE approval_id = ?`,
      )
      .get(approvalId) as TerminalRow | undefined;
  }

  private presentationCandidate(
    assignmentRow: AssignmentRow,
  ): PresentationCandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT candidate.candidate_id, candidate.candidate_semantic_sha256,
                outbox.approval_id, outbox.frozen_card_sha256,
                outbox.approved_snapshot_sha256, outbox.provider_message_ts,
                outbox.state
           FROM authority_clean_live_candidates_v1 AS candidate
           JOIN authority_clean_live_approval_outbox_v1 AS outbox
             ON outbox.candidate_id = candidate.candidate_id
          WHERE outbox.approval_id = ?
            AND candidate.candidate_id = ?
            AND candidate.disposition = 'actionable'
            AND outbox.state IN ('posted', 'staged', 'superseded')
            AND outbox.frozen_card_sha256 IS NOT NULL
            AND outbox.approved_snapshot_sha256 IS NOT NULL
            AND outbox.provider_message_ts IS NOT NULL`,
      )
      .get(
        assignmentRow.approval_id,
        assignmentRow.candidate_id,
      ) as PresentationCandidateRow | undefined;
  }

  private commitmentFromResolution(
    row: AssignmentRow,
    organizationId: string,
    resolution: PrivateApprovalResolutionV1,
  ): PrivateApprovalCandidateCommitmentV1 {
    const commitment: PrivateApprovalCandidateCommitmentV1 = Object.freeze({
      approval_id: resolution.approval_id,
      candidate_id: row.candidate_id,
      candidate_sha256: resolution.candidate_sha256,
      frozen_card_sha256: resolution.frozen_card_sha256,
      approved_snapshot_sha256: resolution.approved_snapshot_sha256,
    });
    const parsed = assignment(parseCanonical(row.assignment_json, "stored assignment"), "stored assignment");
    const expectedCapability = privateApprovalAssignmentCapabilitySha256V1({
      organization_id: organizationId,
      candidate: commitment,
      assignment_version: parsed.assignment_version,
      current_assignee: parsed.current_assignee,
      current_slack_identity_link: parsed.current_slack_identity_link,
    });
    if (expectedCapability !== parsed.assignment_capability_sha256) {
      fail("terminal resolution does not reproduce the assignment capability");
    }
    return commitment;
  }

  private reproveRow(
    row: AssignmentRow,
    commitment: PrivateApprovalCandidateCommitmentV1,
    organizationId: string,
  ): PrivateApprovalAssignmentStateV1 {
    if (
      row.approval_id !== commitment.approval_id ||
      row.candidate_id !== commitment.candidate_id
    ) {
      fail("stored assignment differs from its candidate commitment");
    }
    const stored = assignmentFromRow(row);
    const expectedCapability = privateApprovalAssignmentCapabilitySha256V1({
      organization_id: organizationId,
      candidate: commitment,
      assignment_version: stored.assignment.assignment_version,
      current_assignee: stored.assignment.current_assignee,
      current_slack_identity_link: stored.assignment.current_slack_identity_link,
    });
    if (stored.assignment.assignment_capability_sha256 !== expectedCapability) {
      fail("stored assignment capability is invalid");
    }
    return Object.freeze({
      organization_id: organizationId,
      candidate: commitment,
      ...stored,
    });
  }

  private terminalFromRow(row: TerminalRow): PrivateApprovalTerminalReceiptV1 {
    if (row.outcome !== "approved" && row.outcome !== "rejected") {
      fail("stored terminal outcome is invalid");
    }
    const resolution = validatePrivateApprovalResolutionV1(
      parseCanonical(row.resolution_json, "stored terminal resolution"),
    );
    assertDigest(row.resolution_sha256, "stored terminal resolution digest");
    if (canonicalSha256(resolution) !== row.resolution_sha256) {
      fail("stored terminal resolution digest is invalid");
    }
    const receipt =
      row.v4_receipt_json === null
        ? null
        : v4Receipt(
            parseCanonical(row.v4_receipt_json, "stored terminal V4 receipt"),
            "stored terminal V4 receipt",
          );
    if ((receipt === null) !== (row.v4_receipt_sha256 === null)) {
      fail("stored terminal V4 receipt projection is incomplete");
    }
    if (receipt !== null) {
      assertDigest(row.v4_receipt_sha256, "stored terminal V4 receipt digest");
      if (canonicalSha256(receipt) !== row.v4_receipt_sha256) {
        fail("stored terminal V4 receipt digest is invalid");
      }
    }
    if (
      (row.outcome === "approved" &&
        (resolution.action !== "approve" || receipt === null)) ||
      (row.outcome === "rejected" &&
        (resolution.action !== "reject" || receipt !== null))
    ) {
      fail("stored terminal outcome does not match its evidence");
    }
    if (
      (row.card_render_state === "unrendered" && row.card_rendered_at !== null) ||
      (row.card_render_state === "rendered" && row.card_rendered_at === null) ||
      (row.card_render_state !== "unrendered" && row.card_render_state !== "rendered")
    ) {
      fail("stored terminal card projection is invalid");
    }
    if (row.card_rendered_at !== null) {
      assertCanonicalUtcMillis(row.card_rendered_at, "stored terminal card render time");
    }
    assertCanonicalUtcMillis(row.recorded_at, "stored terminal receipt time");
    return Object.freeze({
      approval_id: row.approval_id,
      candidate_id: row.candidate_id,
      outcome: row.outcome,
      resolution,
      resolution_sha256: row.resolution_sha256 as Digest,
      v4_receipt: receipt,
      v4_receipt_sha256: row.v4_receipt_sha256 as Digest | null,
      card_render_state: row.card_render_state,
      card_rendered_at: row.card_rendered_at,
      recorded_at: row.recorded_at,
    });
  }
}
