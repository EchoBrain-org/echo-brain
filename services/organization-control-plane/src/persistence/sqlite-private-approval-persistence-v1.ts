/**
 * Durable Control Plane boundary for the private-owner approval path.
 *
 * Slack values in a signed receipt are deliberately only lookup hints.  The
 * finalization fence reproves Authority state and this module separately
 * reproves the current Slack installation/link plus the delivered DM/card
 * binding before a policy can be bound.
 */
import {
  resolvePrivateApprovalPolicyV1,
  validatePendingPrivateApprovalV1,
  validatePrivateApprovalAuthorizationAllowV1,
  validatePrivateApprovalResolutionCommandV1,
  validatePrivateApprovalResolutionV1,
  type PendingPrivateApprovalV1,
  type PrivateApprovalAuthorizationAllowV1,
  type PrivateApprovalResolutionCommandV1,
  type PrivateApprovalResolutionV1,
} from "../application/private-approval-policy-resolution-v1.js";
import {
  validatePrivateApprovalSurfaceBindingV1,
  type PrivateApprovalSurfaceBindingV1,
} from "../application/private-approval-surface-binding-v1.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type { ApprovalContractSha256 } from "../application/person-slack-approval-contracts-v2.js";
import type Database from "better-sqlite3";

const PENDING_STAGE_KIND = "echo-private-approval-pending-stage-v1" as const;
const RECEIPT_KIND = "echo-private-approval-signed-block-action-receipt-v1" as const;
const AUDIT_KIND = "echo-private-approval-terminal-audit-v1" as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SLACK_WORKSPACE = /^T[A-Z0-9]{2,255}$/;
const SLACK_ENTERPRISE = /^E[A-Z0-9]{2,255}$/;
const SLACK_SUBJECT = /^[UW][A-Z0-9]{2,255}$/;
const SLACK_DM = /^D[A-Z0-9]{2,255}$/;
const SLACK_MESSAGE_TS = /^[0-9]{1,16}\.[0-9]{1,9}$/;
const SURFACE_CODEC = Object.freeze({ sha256: canonicalSha256 });

type UnknownRecord = Record<string, unknown>;

export interface PrivateApprovalSlackCardBindingV1 {
  readonly schema_version: 1;
  readonly kind: "echo-private-approval-slack-card-binding-v1";
  readonly approval_id: string;
  readonly assignment_version: number;
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly approval_surface_binding_id: string;
  readonly approval_surface_binding_contract_sha256: ApprovalContractSha256;
  readonly slack_workspace_id: string;
  readonly slack_enterprise_id: string | null;
  readonly slack_subject_id: string;
  readonly dm_channel_id: string;
  readonly provider_message_ts: string;
  readonly card_sha256: ApprovalContractSha256;
}

export interface StagePrivateApprovalPendingV1 {
  readonly stage_command_id: string;
  readonly authority_id: string;
  readonly candidate_id: string;
  /** Canonical private Block Kit surface, never a legacy reaction binding. */
  readonly approval_surface_binding: Readonly<{
    readonly body: PrivateApprovalSurfaceBindingV1;
    readonly sha256: ApprovalContractSha256;
  }>;
  readonly pending: PendingPrivateApprovalV1;
  readonly card_binding: PrivateApprovalSlackCardBindingV1;
}

export interface StagedPrivateApprovalPendingV1 {
  readonly pending: PendingPrivateApprovalV1;
  readonly pending_sha256: ApprovalContractSha256;
  readonly card_binding: PrivateApprovalSlackCardBindingV1;
  readonly card_binding_sha256: ApprovalContractSha256;
  readonly stage_command_semantic_sha256: ApprovalContractSha256;
  readonly idempotent: boolean;
}

/** Any retried stage command or approval ID with different commitments fails. */
export class PrivateApprovalPendingConflictError extends Error {
  constructor(message = "private approval pending stage conflicts") {
    super(message);
    this.name = "PrivateApprovalPendingConflictError";
  }
}

export interface PrivateApprovalSlackLookupHintsForReceiptV1 {
  readonly api_app_id: string;
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly slack_user_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly message_user_id: string;
  readonly message_app_id: string;
  readonly message_bot_id: string;
}

/** Normalized after signature verification. Never contains a raw body/URL. */
export interface PrivateApprovalSignedTerminalActionV1 {
  readonly schema_version: 1;
  readonly kind: typeof RECEIPT_KIND;
  readonly provider_action_key_sha256: ApprovalContractSha256;
  readonly request: {
    readonly request_timestamp: string;
    readonly signature_version: "v0";
    readonly signature_sha256: ApprovalContractSha256;
    readonly raw_body_sha256: ApprovalContractSha256;
  };
  readonly approval_id: string;
  readonly assignment_version: number;
  readonly action_id: string;
  readonly action: "approve" | "reject";
  readonly selected_policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2"
    | null;
  readonly comment: string | null;
  readonly lookup: PrivateApprovalSlackLookupHintsForReceiptV1;
  readonly received_at: string;
  readonly verified_at: string;
}

export interface EnqueuePrivateApprovalInteractionV1 {
  readonly disposition: "presentation_change" | "resolution";
  /** Required only for a terminal signed button action. */
  readonly receipt?: PrivateApprovalSignedTerminalActionV1;
}

export type EnqueuePrivateApprovalInteractionResultV1 =
  | Readonly<{ readonly disposition: "presentation_change" }>
  | Readonly<{
      readonly disposition: "resolution";
      readonly receipt: PrivateApprovalSignedTerminalActionV1;
      readonly receipt_sha256: ApprovalContractSha256;
      readonly idempotent: boolean;
    }>;

export class PrivateApprovalSignedActionConflictError extends Error {
  constructor(message = "private approval signed action receipt conflicts") {
    super(message);
    this.name = "PrivateApprovalSignedActionConflictError";
  }
}

export class PrivateApprovalDeniedReceiptConflictError extends Error {
  constructor(message = "private approval denied receipt conflicts") {
    super(message);
    this.name = "PrivateApprovalDeniedReceiptConflictError";
  }
}

export interface QueuedPrivateApprovalSignedActionV1 {
  readonly receipt: PrivateApprovalSignedTerminalActionV1;
  readonly receipt_sha256: ApprovalContractSha256;
}

export type PrivateApprovalDeniedReceiptReasonV1 =
  | "authorization_denied"
  | "state_drift";

export interface DeniedPrivateApprovalSignedActionV1 {
  readonly provider_action_key_sha256: ApprovalContractSha256;
  readonly signed_action_receipt_sha256: ApprovalContractSha256;
  readonly reason_code: PrivateApprovalDeniedReceiptReasonV1;
  readonly denied_at: string;
  readonly idempotent: boolean;
}

export interface PrivateApprovalTerminalAuditV1 {
  readonly schema_version: 1;
  readonly kind: typeof AUDIT_KIND;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly approval_id: string;
  readonly resolution_sha256: ApprovalContractSha256;
  readonly outcome: "approved" | "rejected";
  readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
  readonly occurred_at: string;
}

export interface DurablePrivateApprovalTerminalV1 {
  readonly resolution: PrivateApprovalResolutionV1;
  readonly signed_action_receipt_sha256: ApprovalContractSha256;
  readonly authorization_allow: PrivateApprovalAuthorizationAllowV1;
  readonly outcome: "approved" | "rejected";
  readonly audit: PrivateApprovalTerminalAuditV1;
}

/**
 * Authority owns source-candidate and membership stability. The callback is
 * intentionally given server-owned commitments, not a raw Slack payload.
 */
export interface StablePrivateApprovalAuthorityFenceV1 {
  withStablePrivateApprovalFence<T>(
    commit: (fence: PrivateApprovalAuthorityFenceV1) => Promise<T> | T,
  ): Promise<T>;
}

export interface PrivateApprovalAuthorityFenceV1 {
  /** Reproves that the source candidate is still this approval's current round. */
  approvalIsCurrent(input: {
    readonly approval_id: string;
    readonly candidate_sha256: ApprovalContractSha256;
  }): boolean;
  /** Reproves the exact active membership, rather than trusting the card. */
  currentMembership(input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }): { readonly principal_id: string; readonly membership_id: string } | undefined;
  /**
   * Reproves current candidate, assignment capability and Authority-owned
   * Slack identity commitment. `lookup` stays a hint for its independent
   * provider re-observation; it cannot introduce an actor.
   */
  reprovePrivateApprovalAuthorization(input: {
    readonly pending: PendingPrivateApprovalV1;
    readonly card_binding: PrivateApprovalSlackCardBindingV1;
    readonly lookup: PrivateApprovalSlackLookupHintsForReceiptV1;
  }): PrivateApprovalAuthorizationAllowV1 | undefined;
}

export interface SqlitePrivateApprovalPersistenceV1Input {
  readonly database: Database.Database;
  readonly authority_fence: StablePrivateApprovalAuthorityFenceV1;
  readonly now: () => string;
}

export class PrivateApprovalFinalizationConflictError extends Error {
  constructor(message = "private approval finalization conflicts") {
    super(message);
    this.name = "PrivateApprovalFinalizationConflictError";
  }
}

export type PrivateApprovalFinalizationDeniedReasonV1 =
  | "authorization_denied"
  | "state_drift";

export class PrivateApprovalFinalizationDeniedError extends Error {
  constructor(
    readonly reason_code: PrivateApprovalFinalizationDeniedReasonV1,
    message = "private approval finalization is not authorized",
  ) {
    super(message);
    this.name = "PrivateApprovalFinalizationDeniedError";
  }
}

function invalid(label: string): never {
  throw new Error(`private approval persistence ${label}`);
}

function exact(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(`${label} must not have symbols`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable !== true || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) invalid(`${label} must contain data fields`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(`${label} has unexpected fields`);
  return value as UnknownRecord;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): ApprovalContractSha256 {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${label} is invalid`);
  return value as ApprovalContractSha256;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid`);
  return value as number;
}

function slack(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== "string" || !expression.test(value)) invalid(`${label} is invalid`);
  return value;
}

function time(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value) invalid(`${label} is invalid`);
  return value;
}

export function validatePrivateApprovalSlackCardBindingV1(value: unknown): PrivateApprovalSlackCardBindingV1 {
  const record = exact(value, ["schema_version", "kind", "approval_id", "assignment_version", "connection_id", "connection_contract_sha256", "connection_state_sha256", "approval_surface_binding_id", "approval_surface_binding_contract_sha256", "slack_workspace_id", "slack_enterprise_id", "slack_subject_id", "dm_channel_id", "provider_message_ts", "card_sha256"], "card binding");
  if (record.schema_version !== 1 || record.kind !== "echo-private-approval-slack-card-binding-v1") invalid("card binding schema is invalid");
  const enterprise = record.slack_enterprise_id;
  if (enterprise !== null && (typeof enterprise !== "string" || !SLACK_ENTERPRISE.test(enterprise))) invalid("card binding enterprise is invalid");
  return Object.freeze({
    schema_version: 1, kind: "echo-private-approval-slack-card-binding-v1",
    approval_id: identifier(record.approval_id, "card binding approval_id"),
    assignment_version: positive(record.assignment_version, "card binding assignment_version"),
    connection_id: identifier(record.connection_id, "card binding connection_id"),
    connection_contract_sha256: digest(record.connection_contract_sha256, "card binding connection contract"),
    connection_state_sha256: digest(record.connection_state_sha256, "card binding connection state"),
    approval_surface_binding_id: identifier(record.approval_surface_binding_id, "card binding surface id"),
    approval_surface_binding_contract_sha256: digest(record.approval_surface_binding_contract_sha256, "card binding surface digest"),
    slack_workspace_id: slack(record.slack_workspace_id, SLACK_WORKSPACE, "card binding workspace"),
    slack_enterprise_id: enterprise,
    slack_subject_id: slack(record.slack_subject_id, SLACK_SUBJECT, "card binding subject"),
    dm_channel_id: slack(record.dm_channel_id, SLACK_DM, "card binding DM"),
    provider_message_ts: slack(record.provider_message_ts, SLACK_MESSAGE_TS, "card binding message"),
    card_sha256: digest(record.card_sha256, "card binding card"),
  });
}

function validateReceipt(value: unknown): PrivateApprovalSignedTerminalActionV1 {
  const record = exact(value, ["schema_version", "kind", "provider_action_key_sha256", "request", "approval_id", "assignment_version", "action_id", "action", "selected_policy_id", "comment", "lookup", "received_at", "verified_at"], "signed action receipt");
  if (record.schema_version !== 1 || record.kind !== RECEIPT_KIND) invalid("signed action receipt schema is invalid");
  if (record.action !== "approve" && record.action !== "reject") invalid("signed action receipt action is invalid");
  const selected = record.selected_policy_id;
  if (record.action === "approve" && selected !== "organization-member-readable-person-v2" && selected !== "restricted-reviewer-person-v2") invalid("signed approval must select policy");
  if (record.action === "reject" && selected !== null) invalid("signed rejection must not select policy");
  const lookup = exact(record.lookup, ["api_app_id", "workspace_id", "enterprise_id", "slack_user_id", "channel_id", "message_ts", "message_user_id", "message_app_id", "message_bot_id"], "signed action lookup");
  const enterprise = lookup.enterprise_id;
  if (enterprise !== null && (typeof enterprise !== "string" || !SLACK_ENTERPRISE.test(enterprise))) invalid("signed action enterprise is invalid");
  const request = exact(record.request, ["request_timestamp", "signature_version", "signature_sha256", "raw_body_sha256"], "signed action request");
  if (request.signature_version !== "v0") invalid("signed action signature version is invalid");
  const key = digest(record.provider_action_key_sha256, "provider action key");
  const comment = record.comment;
  const command = validatePrivateApprovalResolutionCommandV1({ schema_version: 1, command_id: resolutionCommandId(key), approval_id: record.approval_id, assignment_version: record.assignment_version, action: record.action, selected_policy_id: selected, comment });
  return Object.freeze({
    schema_version: 1, kind: RECEIPT_KIND,
    provider_action_key_sha256: key,
    request: Object.freeze({ request_timestamp: time(request.request_timestamp, "request timestamp"), signature_version: "v0", signature_sha256: digest(request.signature_sha256, "signature digest"), raw_body_sha256: digest(request.raw_body_sha256, "raw body digest") }),
    approval_id: command.approval_id, assignment_version: command.assignment_version,
    action_id: identifier(record.action_id, "action id"), action: command.action,
    selected_policy_id: command.selected_policy_id, comment: command.comment,
    lookup: Object.freeze({
      api_app_id: identifier(lookup.api_app_id, "app id"),
      workspace_id: slack(lookup.workspace_id, SLACK_WORKSPACE, "workspace"), enterprise_id: enterprise,
      slack_user_id: slack(lookup.slack_user_id, SLACK_SUBJECT, "actor"), channel_id: slack(lookup.channel_id, SLACK_DM, "channel"),
      message_ts: slack(lookup.message_ts, SLACK_MESSAGE_TS, "message ts"), message_user_id: slack(lookup.message_user_id, SLACK_SUBJECT, "message author"), message_app_id: identifier(lookup.message_app_id, "message app"), message_bot_id: slack(lookup.message_bot_id, /^B[A-Z0-9]{2,255}$/, "message bot"),
    }),
    received_at: time(record.received_at, "received_at"), verified_at: time(record.verified_at, "verified_at"),
  });
}

function stageSemantic(input: {
  readonly authority_id: string;
  readonly candidate_id: string;
  readonly approval_surface_binding: Readonly<{
    readonly body: PrivateApprovalSurfaceBindingV1;
    readonly sha256: ApprovalContractSha256;
  }>;
  readonly pending: PendingPrivateApprovalV1;
  readonly card: PrivateApprovalSlackCardBindingV1;
}): ApprovalContractSha256 {
  return canonicalSha256({ schema_version: 1, kind: PENDING_STAGE_KIND, ...input });
}

function receiptSha(receipt: PrivateApprovalSignedTerminalActionV1): ApprovalContractSha256 {
  /*
   * A Slack retry is the same authenticated action, but it is observed by the
   * HTTP process at a new time.  `received_at` and `verified_at` are local
   * ingestion metadata, not signed provider evidence, so they must not turn a
   * byte-for-byte Slack retry into a second, conflicting command.  The stored
   * JSON retains the first observed timestamps for audit; this digest commits
   * every provider-derived and resolution-bearing field.
   */
  const { received_at: _receivedAt, verified_at: _verifiedAt, ...semantic } = receipt;
  return canonicalSha256(semantic);
}

/** The persisted receipt ID is derived, never supplied by a Slack payload. */
function providerReceiptId(providerActionKeySha256: ApprovalContractSha256): string {
  return `sar_${providerActionKeySha256.slice(7)}`;
}

function resolutionCommandId(providerActionKeySha256: ApprovalContractSha256): string {
  return `prc_${providerActionKeySha256.slice(7)}`;
}

function parseCanonical(json: string, label: string): unknown {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { invalid(`${label} is not JSON`); }
  if (canonicalJson(value) !== json) invalid(`${label} is not canonical`);
  return value;
}

function storedPending(row: { pending_json: string; pending_sha256: string }): PendingPrivateApprovalV1 {
  const value = parseCanonical(row.pending_json, "stored pending");
  if (canonicalSha256(value) !== row.pending_sha256) invalid("stored pending digest is invalid");
  return validatePendingPrivateApprovalV1(value);
}

function storedCard(row: { binding_json: string; binding_sha256: string }): PrivateApprovalSlackCardBindingV1 {
  const value = parseCanonical(row.binding_json, "stored card binding");
  if (canonicalSha256(value) !== row.binding_sha256) invalid("stored card digest is invalid");
  return validatePrivateApprovalSlackCardBindingV1(value);
}

function storedReceipt(row: { normalized_receipt_json: string; normalized_receipt_sha256: string }): QueuedPrivateApprovalSignedActionV1 {
  const value = parseCanonical(row.normalized_receipt_json, "stored signed action receipt");
  const receipt = validateReceipt(value);
  if (receiptSha(receipt) !== row.normalized_receipt_sha256) invalid("stored signed action receipt digest is invalid");
  return Object.freeze({ receipt, receipt_sha256: row.normalized_receipt_sha256 as ApprovalContractSha256 });
}

function commandFromReceipt(receipt: PrivateApprovalSignedTerminalActionV1): PrivateApprovalResolutionCommandV1 {
  return validatePrivateApprovalResolutionCommandV1({ schema_version: 1, command_id: resolutionCommandId(receipt.provider_action_key_sha256), approval_id: receipt.approval_id, assignment_version: receipt.assignment_version, action: receipt.action, selected_policy_id: receipt.selected_policy_id, comment: receipt.comment });
}

function terminalFromRow(row: Record<string, string | null>): DurablePrivateApprovalTerminalV1 {
  const resolutionValue = parseCanonical(row.resolution_json as string, "stored terminal resolution");
  if (canonicalSha256(resolutionValue) !== row.resolution_sha256) invalid("stored terminal resolution digest is invalid");
  const allowValue = parseCanonical(row.authorization_allow_json as string, "stored terminal authorization");
  if (canonicalSha256(allowValue) !== row.authorization_allow_sha256) invalid("stored terminal authorization digest is invalid");
  const auditValue = parseCanonical(row.audit_entry_json as string, "stored terminal audit");
  if (canonicalSha256(auditValue) !== row.audit_entry_sha256) invalid("stored terminal audit digest is invalid");
  const audit = validateAudit(auditValue);
  return Object.freeze({
    resolution: validatePrivateApprovalResolutionV1(resolutionValue),
    signed_action_receipt_sha256: digest(row.signed_action_receipt_sha256, "stored terminal receipt"),
    authorization_allow: validatePrivateApprovalAuthorizationAllowV1(allowValue),
    outcome: row.outcome === "approved" ? "approved" : row.outcome === "rejected" ? "rejected" : invalid("stored terminal outcome is invalid"),
    audit,
  });
}

function validateAudit(value: unknown): PrivateApprovalTerminalAuditV1 {
  const record = exact(value, ["schema_version", "kind", "audit_event_id", "audit_sequence", "approval_id", "resolution_sha256", "outcome", "predecessor_entry_sha256", "occurred_at"], "terminal audit");
  if (record.schema_version !== 1 || record.kind !== AUDIT_KIND || (record.outcome !== "approved" && record.outcome !== "rejected")) invalid("terminal audit schema is invalid");
  const predecessor =
    record.predecessor_entry_sha256 === null
      ? null
      : digest(record.predecessor_entry_sha256, "terminal audit predecessor");
  return Object.freeze({ schema_version: 1, kind: AUDIT_KIND, audit_event_id: identifier(record.audit_event_id, "audit event id"), audit_sequence: positive(record.audit_sequence, "audit sequence"), approval_id: identifier(record.approval_id, "audit approval id"), resolution_sha256: digest(record.resolution_sha256, "audit resolution"), outcome: record.outcome, predecessor_entry_sha256: predecessor, occurred_at: time(record.occurred_at, "audit occurred at") });
}

/** Immutable V2 persistence coordinator. It has no runtime/HTTP wiring. */
export class SqlitePrivateApprovalPersistenceV1 {
  constructor(private readonly input: SqlitePrivateApprovalPersistenceV1Input) {}

  stage(input: StagePrivateApprovalPendingV1): StagedPrivateApprovalPendingV1 {
    const stageCommandId = identifier(input.stage_command_id, "stage command id");
    const authorityId = identifier(input.authority_id, "authority id");
    const candidateId = identifier(input.candidate_id, "candidate id");
    const approvalSurface = Object.freeze({
      body: validatePrivateApprovalSurfaceBindingV1(input.approval_surface_binding.body, SURFACE_CODEC),
      sha256: digest(input.approval_surface_binding.sha256, "approval binding digest"),
    });
    if (canonicalSha256(approvalSurface.body) !== approvalSurface.sha256) invalid("approval binding digest is invalid");
    const pending = validatePendingPrivateApprovalV1(input.pending);
    const card = validatePrivateApprovalSlackCardBindingV1(input.card_binding);
    if (card.approval_id !== pending.approval_id || card.assignment_version !== pending.assignment.assignment_version || card.card_sha256 !== pending.frozen_card_sha256 || card.slack_subject_id !== pending.assignment.current_slack_identity_link.provider_subject_id || card.connection_id !== approvalSurface.body.connection_id || card.connection_contract_sha256 !== approvalSurface.body.connection_contract_sha256 || card.connection_state_sha256 !== approvalSurface.body.connection_state_sha256 || card.approval_surface_binding_id !== approvalSurface.body.approval_surface_binding_id || card.approval_surface_binding_contract_sha256 !== approvalSurface.sha256 || card.slack_workspace_id !== approvalSurface.body.slack_workspace_id || card.slack_enterprise_id !== approvalSurface.body.slack_enterprise_id || authorityId !== approvalSurface.body.authority_id || pending.organization_id !== approvalSurface.body.organization_id) invalid("card binding does not match pending commitments");
    const pendingSha = canonicalSha256(pending);
    const cardSha = canonicalSha256(card);
    const semantic = stageSemantic({ authority_id: authorityId, candidate_id: candidateId, approval_surface_binding: approvalSurface, pending, card });
    const database = this.input.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const priorSurface = database.prepare(`SELECT contract_json, contract_sha256 FROM organization_private_approval_surface_binding_contracts_v2 WHERE approval_binding_id = ?`).get(approvalSurface.body.approval_surface_binding_id) as { contract_json: string; contract_sha256: string } | undefined;
      if (priorSurface === undefined) {
        database.prepare(`INSERT INTO organization_private_approval_surface_binding_contracts_v2 (approval_binding_id, contract_json, contract_sha256, connection_id, connection_contract_sha256, interaction_kind, interaction_route, interaction_schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(approvalSurface.body.approval_surface_binding_id, canonicalJson(approvalSurface.body), approvalSurface.sha256, approvalSurface.body.connection_id, approvalSurface.body.connection_contract_sha256, approvalSurface.body.adapter_id, approvalSurface.body.interaction_path, approvalSurface.body.card_schema_version, this.input.now());
      } else {
        const stored = parseCanonical(priorSurface.contract_json, "stored approval surface binding");
        if (canonicalSha256(stored) !== priorSurface.contract_sha256 || priorSurface.contract_sha256 !== approvalSurface.sha256 || canonicalJson(stored) !== canonicalJson(approvalSurface.body)) throw new PrivateApprovalPendingConflictError("private approval surface binding conflicts");
        validatePrivateApprovalSurfaceBindingV1(stored, SURFACE_CODEC);
      }
      const priorCurrent = database.prepare(`SELECT contract_sha256, connection_state_sha256, current_status FROM organization_private_approval_surface_binding_current_v2 WHERE approval_binding_id = ?`).get(approvalSurface.body.approval_surface_binding_id) as { contract_sha256: string; connection_state_sha256: string; current_status: string } | undefined;
      if (priorCurrent === undefined) {
        database.prepare(`INSERT INTO organization_private_approval_surface_binding_current_v2 (approval_binding_id, contract_sha256, connection_state_sha256, current_status, updated_at) VALUES (?, ?, ?, 'active', ?)`)
          .run(approvalSurface.body.approval_surface_binding_id, approvalSurface.sha256, approvalSurface.body.connection_state_sha256, this.input.now());
      }
      const connection = database.prepare(`SELECT 1 FROM organization_tool_connection_current_state WHERE connection_id = ? AND connection_contract_sha256 = ? AND state_sha256 = ? AND current_status = 'active'`).get(card.connection_id, card.connection_contract_sha256, card.connection_state_sha256);
      const binding = database.prepare(`SELECT 1 FROM organization_private_approval_surface_binding_current_v2 WHERE approval_binding_id = ? AND contract_sha256 = ? AND connection_state_sha256 = ? AND current_status = 'active'`).get(approvalSurface.body.approval_surface_binding_id, approvalSurface.sha256, approvalSurface.body.connection_state_sha256);
      const link = database.prepare(`SELECT 1 FROM organization_external_human_link_current WHERE external_identity_link_id = ? AND contract_sha256 = ? AND current_status = 'active' AND provider_issuer = 'https://slack.com' AND provider_tenant_kind = 'workspace' AND provider_tenant_id = ? AND provider_enterprise_id IS ? AND provider_subject_id = ? AND principal_id = ? AND membership_id = ?`).get(pending.assignment.current_slack_identity_link.external_identity_link_id, pending.assignment.current_slack_identity_link.external_identity_link_contract_sha256, card.slack_workspace_id, card.slack_enterprise_id, card.slack_subject_id, pending.assignment.current_assignee.principal_id, pending.assignment.current_assignee.membership_id);
      if (connection === undefined || binding === undefined || link === undefined) invalid("stage provenance is not current");
      const prior = database.prepare(`SELECT pending_json, pending_sha256, stage_command_semantic_sha256 FROM organization_private_approval_pending_contracts_v2 WHERE stage_command_id = ?`).get(stageCommandId) as { pending_json: string; pending_sha256: string; stage_command_semantic_sha256: string } | undefined;
      if (prior !== undefined) {
        const stored = storedPending(prior);
        const storedCardRow = database.prepare(`SELECT binding_json, binding_sha256 FROM organization_private_approval_card_bindings_v2 WHERE approval_id = ?`).get(stored.approval_id) as { binding_json: string; binding_sha256: string } | undefined;
        if (storedCardRow === undefined) invalid("stored pending lacks its card binding");
        const storedCardValue = storedCard(storedCardRow);
        if (prior.stage_command_semantic_sha256 !== semantic || canonicalSha256(stored) !== pendingSha || canonicalSha256(storedCardValue) !== cardSha) throw new PrivateApprovalPendingConflictError();
        database.exec("COMMIT");
        return Object.freeze({ pending: stored, pending_sha256: pendingSha, card_binding: storedCardValue, card_binding_sha256: cardSha, stage_command_semantic_sha256: semantic, idempotent: true });
      }
      const sameApproval = database.prepare(`SELECT pending_json, pending_sha256, stage_command_semantic_sha256 FROM organization_private_approval_pending_contracts_v2 WHERE approval_id = ?`).get(pending.approval_id) as { pending_json: string; pending_sha256: string; stage_command_semantic_sha256: string } | undefined;
      if (sameApproval !== undefined) throw new PrivateApprovalPendingConflictError("private approval ID already names another stage command");
      const now = this.input.now();
      database.prepare(`INSERT INTO organization_private_approval_pending_contracts_v2 (approval_id, candidate_id, organization_id, authority_id, assignment_version, pending_json, pending_sha256, stage_command_id, stage_command_semantic_sha256, connection_id, connection_contract_sha256, connection_state_sha256, approval_binding_id, approval_binding_contract_sha256, external_identity_link_id, external_identity_link_contract_sha256, assignee_principal_id, assignee_membership_id, slack_workspace_id, slack_enterprise_id, slack_subject_id, canonical_record_policy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(pending.approval_id, candidateId, pending.organization_id, authorityId, pending.assignment.assignment_version, canonicalJson(pending), pendingSha, stageCommandId, semantic, card.connection_id, card.connection_contract_sha256, card.connection_state_sha256, approvalSurface.body.approval_surface_binding_id, approvalSurface.sha256, pending.assignment.current_slack_identity_link.external_identity_link_id, pending.assignment.current_slack_identity_link.external_identity_link_contract_sha256, pending.assignment.current_assignee.principal_id, pending.assignment.current_assignee.membership_id, card.slack_workspace_id, card.slack_enterprise_id, card.slack_subject_id, now);
      database.prepare(`INSERT INTO organization_private_approval_card_bindings_v2 (approval_id, assignment_version, binding_json, binding_sha256, connection_id, slack_workspace_id, slack_enterprise_id, slack_subject_id, dm_channel_id, provider_message_ts, card_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(card.approval_id, card.assignment_version, canonicalJson(card), cardSha, card.connection_id, card.slack_workspace_id, card.slack_enterprise_id, card.slack_subject_id, card.dm_channel_id, card.provider_message_ts, card.card_sha256, now);
      database.exec("COMMIT");
      return Object.freeze({ pending, pending_sha256: pendingSha, card_binding: card, card_binding_sha256: cardSha, stage_command_semantic_sha256: semantic, idempotent: false });
    } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }

  enqueue(input: EnqueuePrivateApprovalInteractionV1): EnqueuePrivateApprovalInteractionResultV1 {
    if (input.disposition === "presentation_change") {
      if (input.receipt !== undefined) invalid("presentation change must not have a receipt");
      return Object.freeze({ disposition: "presentation_change" });
    }
    if (input.disposition !== "resolution" || input.receipt === undefined) invalid("terminal interaction requires receipt");
    const receipt = validateReceipt(input.receipt);
    const sha = receiptSha(receipt);
    const database = this.input.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const receiptId = providerReceiptId(receipt.provider_action_key_sha256);
      const prior = database.prepare(`SELECT normalized_receipt_json, normalized_receipt_sha256 FROM organization_private_approval_signed_action_receipts_v2 WHERE provider_receipt_id = ? OR provider_action_key = ? OR raw_payload_sha256 = ?`).all(receiptId, receipt.provider_action_key_sha256, receipt.request.raw_body_sha256) as Array<{ normalized_receipt_json: string; normalized_receipt_sha256: string }>;
      if (prior.length > 0) {
        if (prior.length !== 1) throw new PrivateApprovalSignedActionConflictError("signed action receipt uniqueness is inconsistent");
        const stored = storedReceipt(prior[0]!);
        if (stored.receipt_sha256 !== sha) throw new PrivateApprovalSignedActionConflictError();
        database.exec("COMMIT");
        return Object.freeze({ disposition: "resolution", receipt: stored.receipt, receipt_sha256: sha, idempotent: true });
      }
      const pending = database.prepare(`SELECT 1 FROM organization_private_approval_pending_contracts_v2 WHERE approval_id = ?`).get(receipt.approval_id);
      if (pending === undefined) throw new PrivateApprovalSignedActionConflictError("signed action names no pending approval");
      database.prepare(`INSERT INTO organization_private_approval_signed_action_receipts_v2 (provider_receipt_id, provider_action_key, raw_payload_sha256, normalized_receipt_json, normalized_receipt_sha256, approval_id, assignment_version, action_id, action_kind, received_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receiptId, receipt.provider_action_key_sha256, receipt.request.raw_body_sha256, canonicalJson(receipt), sha, receipt.approval_id, receipt.assignment_version, receipt.action_id, receipt.action, receipt.received_at, receipt.verified_at);
      database.exec("COMMIT");
      return Object.freeze({ disposition: "resolution", receipt, receipt_sha256: sha, idempotent: false });
    } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }

  listQueued(): readonly QueuedPrivateApprovalSignedActionV1[] {
    const rows = this.input.database.prepare(`SELECT receipt.normalized_receipt_json, receipt.normalized_receipt_sha256 FROM organization_private_approval_signed_action_receipts_v2 AS receipt LEFT JOIN organization_private_approval_terminal_evidence_v2 AS terminal ON terminal.signed_action_receipt_sha256 = receipt.normalized_receipt_sha256 LEFT JOIN organization_private_approval_denied_action_receipts_v2 AS denied ON denied.signed_action_receipt_sha256 = receipt.normalized_receipt_sha256 WHERE terminal.approval_id IS NULL AND denied.provider_action_key IS NULL ORDER BY receipt.received_at ASC, receipt.provider_receipt_id ASC`).all() as Array<{ normalized_receipt_json: string; normalized_receipt_sha256: string }>;
    return Object.freeze(rows.map(storedReceipt));
  }

  /** Consume an un-actionable receipt without creating a decision terminal. */
  recordDenied(
    providerActionKeySha256: ApprovalContractSha256,
    reasonCode: PrivateApprovalDeniedReceiptReasonV1,
  ): DeniedPrivateApprovalSignedActionV1 {
    const actionKey = digest(providerActionKeySha256, "provider action key");
    if (reasonCode !== "authorization_denied" && reasonCode !== "state_drift") {
      invalid("denied receipt reason is invalid");
    }
    const database = this.input.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const receipt = database.prepare(`SELECT normalized_receipt_sha256 FROM organization_private_approval_signed_action_receipts_v2 WHERE provider_action_key = ?`).get(actionKey) as { normalized_receipt_sha256: string } | undefined;
      if (receipt === undefined) throw new PrivateApprovalDeniedReceiptConflictError("signed action receipt is absent");
      const receiptSha = digest(receipt.normalized_receipt_sha256, "signed action receipt digest");
      const prior = database.prepare(`SELECT signed_action_receipt_sha256, reason_code, denied_at FROM organization_private_approval_denied_action_receipts_v2 WHERE provider_action_key = ?`).get(actionKey) as { signed_action_receipt_sha256: string; reason_code: string; denied_at: string } | undefined;
      if (prior !== undefined) {
        if (prior.signed_action_receipt_sha256 !== receiptSha || prior.reason_code !== reasonCode) throw new PrivateApprovalDeniedReceiptConflictError();
        database.exec("COMMIT");
        return Object.freeze({ provider_action_key_sha256: actionKey, signed_action_receipt_sha256: receiptSha, reason_code: reasonCode, denied_at: time(prior.denied_at, "stored denied_at"), idempotent: true });
      }
      const terminal = database.prepare(`SELECT 1 FROM organization_private_approval_terminal_evidence_v2 WHERE signed_action_receipt_sha256 = ?`).get(receiptSha);
      if (terminal !== undefined) throw new PrivateApprovalDeniedReceiptConflictError("signed action already has terminal evidence");
      const deniedAt = this.input.now();
      database.prepare(`INSERT INTO organization_private_approval_denied_action_receipts_v2 (provider_action_key, signed_action_receipt_sha256, reason_code, denied_at) VALUES (?, ?, ?, ?)`).run(actionKey, receiptSha, reasonCode, deniedAt);
      database.exec("COMMIT");
      return Object.freeze({ provider_action_key_sha256: actionKey, signed_action_receipt_sha256: receiptSha, reason_code: reasonCode, denied_at: deniedAt, idempotent: false });
    } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }

  terminalByApprovalId(approvalId: string): DurablePrivateApprovalTerminalV1 | undefined {
    const row = this.input.database.prepare(`SELECT * FROM organization_private_approval_terminal_evidence_v2 WHERE approval_id = ?`).get(identifier(approvalId, "approval id")) as Record<string, string | null> | undefined;
    return row === undefined ? undefined : terminalFromRow(row);
  }

  /**
   * Recovery feed for Authority's D2-to-D3 worker. Terminal evidence is
   * immutable, so replaying this complete ordered feed is safe: Authority
   * records its own terminal receipt and Slack projection idempotently.
   */
  listTerminals(): readonly DurablePrivateApprovalTerminalV1[] {
    const rows = this.input.database
      .prepare(
        `SELECT *
           FROM organization_private_approval_terminal_evidence_v2
          ORDER BY audit_sequence ASC, approval_id ASC`,
      )
      .all() as Array<Record<string, string | null>>;
    return Object.freeze(rows.map(terminalFromRow));
  }

  async finalize(providerActionKeySha256: ApprovalContractSha256): Promise<DurablePrivateApprovalTerminalV1> {
    const actionKey = digest(providerActionKeySha256, "provider action key");
    return this.input.authority_fence.withStablePrivateApprovalFence((authority) => {
      const database = this.input.database;
      database.exec("BEGIN IMMEDIATE");
      try {
        const receiptRow = database.prepare(`SELECT normalized_receipt_json, normalized_receipt_sha256 FROM organization_private_approval_signed_action_receipts_v2 WHERE provider_action_key = ?`).get(actionKey) as { normalized_receipt_json: string; normalized_receipt_sha256: string } | undefined;
        if (receiptRow === undefined) throw new PrivateApprovalFinalizationDeniedError("state_drift", "signed action receipt is absent");
        const queued = storedReceipt(receiptRow);
        const command = commandFromReceipt(queued.receipt);
        const existingRow = database.prepare(`SELECT * FROM organization_private_approval_terminal_evidence_v2 WHERE approval_id = ?`).get(command.approval_id) as Record<string, string | null> | undefined;
        if (existingRow !== undefined) {
          const durable = terminalFromRow(existingRow);
          const replay = resolvePrivateApprovalPolicyV1({ command, prior_resolution: durable.resolution });
          if (durable.signed_action_receipt_sha256 !== queued.receipt_sha256 || replay.command_id !== durable.resolution.command_id) throw new PrivateApprovalFinalizationConflictError();
          database.exec("COMMIT");
          return durable;
        }
        const pendingRow = database.prepare(`SELECT pending_json, pending_sha256 FROM organization_private_approval_pending_contracts_v2 WHERE approval_id = ?`).get(command.approval_id) as { pending_json: string; pending_sha256: string } | undefined;
        const cardRow = database.prepare(`SELECT binding_json, binding_sha256 FROM organization_private_approval_card_bindings_v2 WHERE approval_id = ?`).get(command.approval_id) as { binding_json: string; binding_sha256: string } | undefined;
        if (pendingRow === undefined || cardRow === undefined) throw new PrivateApprovalFinalizationDeniedError("state_drift", "pending approval is absent");
        const pending = storedPending(pendingRow);
        const card = storedCard(cardRow);
        this.reproveControlPlaneSlackState(pending, card, queued.receipt);
        if (!authority.approvalIsCurrent({ approval_id: pending.approval_id, candidate_sha256: pending.candidate_sha256 })) throw new PrivateApprovalFinalizationDeniedError("state_drift", "approval is no longer current");
        const member = authority.currentMembership(pending.assignment.current_assignee);
        if (member === undefined || member.principal_id !== pending.assignment.current_assignee.principal_id || member.membership_id !== pending.assignment.current_assignee.membership_id) throw new PrivateApprovalFinalizationDeniedError("authorization_denied", "assignee membership is no longer current");
        const rawAllow = authority.reprovePrivateApprovalAuthorization({ pending, card_binding: card, lookup: queued.receipt.lookup });
        if (rawAllow === undefined) throw new PrivateApprovalFinalizationDeniedError("authorization_denied", "authorization cannot be reproved");
        const allow = validatePrivateApprovalAuthorizationAllowV1(rawAllow);
        const resolution = resolvePrivateApprovalPolicyV1({ pending, command, authorization_allow: allow });
        const audit = this.nextAudit(resolution);
        const outcome = resolution.action === "approve" ? "approved" as const : "rejected" as const;
        database.prepare(`INSERT INTO organization_private_approval_terminal_evidence_v2 (approval_id, resolution_command_id, resolution_command_semantic_sha256, resolution_json, resolution_sha256, signed_action_receipt_sha256, authorization_allow_json, authorization_allow_sha256, outcome, audit_event_id, audit_sequence, audit_entry_json, audit_entry_sha256, predecessor_entry_sha256, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(resolution.approval_id, resolution.command_id, canonicalSha256({ command, receipt_sha256: queued.receipt_sha256 }), canonicalJson(resolution), canonicalSha256(resolution), queued.receipt_sha256, canonicalJson(allow), canonicalSha256(allow), outcome, audit.audit_event_id, audit.audit_sequence, canonicalJson(audit), canonicalSha256(audit), audit.predecessor_entry_sha256, this.input.now());
        const terminal = Object.freeze({ resolution, signed_action_receipt_sha256: queued.receipt_sha256, authorization_allow: allow, outcome, audit });
        database.exec("COMMIT");
        return terminal;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  private reproveControlPlaneSlackState(pending: PendingPrivateApprovalV1, card: PrivateApprovalSlackCardBindingV1, receipt: PrivateApprovalSignedTerminalActionV1): void {
    if (card.approval_id !== pending.approval_id || card.assignment_version !== pending.assignment.assignment_version || card.card_sha256 !== pending.frozen_card_sha256 || card.slack_subject_id !== pending.assignment.current_slack_identity_link.provider_subject_id) throw new PrivateApprovalFinalizationDeniedError("state_drift", "card binding is stale");
    const hint = receipt.lookup;
    if (receipt.approval_id !== pending.approval_id || receipt.assignment_version !== pending.assignment.assignment_version || hint.workspace_id !== card.slack_workspace_id || hint.enterprise_id !== card.slack_enterprise_id || hint.slack_user_id !== card.slack_subject_id || hint.channel_id !== card.dm_channel_id || hint.message_ts !== card.provider_message_ts) throw new PrivateApprovalFinalizationDeniedError("state_drift", "provider hints do not name the delivered private card");
    const connection = this.input.database.prepare(`SELECT state.connection_contract_sha256, state.state_sha256, state.current_status FROM organization_tool_connection_current_state AS state WHERE state.connection_id = ?`).get(card.connection_id) as { connection_contract_sha256: string; state_sha256: string; current_status: string } | undefined;
    if (connection === undefined || connection.current_status !== "active" || connection.connection_contract_sha256 !== card.connection_contract_sha256 || connection.state_sha256 !== card.connection_state_sha256) throw new PrivateApprovalFinalizationDeniedError("state_drift", "Slack connection is not current");
    const surface = this.input.database.prepare(`SELECT current.contract_sha256, current.connection_state_sha256, current.current_status, contract.contract_json FROM organization_private_approval_surface_binding_current_v2 AS current JOIN organization_private_approval_surface_binding_contracts_v2 AS contract ON contract.approval_binding_id = current.approval_binding_id AND contract.contract_sha256 = current.contract_sha256 WHERE current.approval_binding_id = ?`).get(card.approval_surface_binding_id) as { contract_sha256: string; connection_state_sha256: string; current_status: string; contract_json: string } | undefined;
    if (surface === undefined || surface.current_status !== "active" || surface.contract_sha256 !== card.approval_surface_binding_contract_sha256 || surface.connection_state_sha256 !== card.connection_state_sha256) throw new PrivateApprovalFinalizationDeniedError("state_drift", "private approval surface is not current");
    const surfaceBody = validatePrivateApprovalSurfaceBindingV1(parseCanonical(surface.contract_json, "stored approval surface binding"), SURFACE_CODEC);
    if (canonicalSha256(surfaceBody) !== surface.contract_sha256 || surfaceBody.connection_id !== card.connection_id || surfaceBody.connection_contract_sha256 !== card.connection_contract_sha256 || surfaceBody.connection_state_sha256 !== card.connection_state_sha256 || surfaceBody.slack_workspace_id !== card.slack_workspace_id || surfaceBody.slack_enterprise_id !== card.slack_enterprise_id) throw new PrivateApprovalFinalizationDeniedError("state_drift", "private approval surface binding is inconsistent");
    if (hint.api_app_id !== surfaceBody.provider_app_id || hint.message_app_id !== surfaceBody.provider_app_id || hint.message_bot_id !== surfaceBody.provider_bot_id || hint.message_user_id !== surfaceBody.provider_bot_user_id) throw new PrivateApprovalFinalizationDeniedError("state_drift", "provider identity does not match the private approval surface");
    const link = this.input.database.prepare(`SELECT contract_sha256, current_status, provider_issuer, provider_tenant_kind, provider_tenant_id, provider_enterprise_id, provider_subject_id, principal_id, membership_id FROM organization_external_human_link_current WHERE external_identity_link_id = ?`).get(pending.assignment.current_slack_identity_link.external_identity_link_id) as Record<string, string | null> | undefined;
    if (link === undefined || link.contract_sha256 !== pending.assignment.current_slack_identity_link.external_identity_link_contract_sha256 || link.current_status !== "active" || link.provider_issuer !== "https://slack.com" || link.provider_tenant_kind !== "workspace" || link.provider_tenant_id !== card.slack_workspace_id || link.provider_enterprise_id !== card.slack_enterprise_id || link.provider_subject_id !== card.slack_subject_id || link.principal_id !== pending.assignment.current_assignee.principal_id || link.membership_id !== pending.assignment.current_assignee.membership_id) throw new PrivateApprovalFinalizationDeniedError("state_drift", "Slack identity link is not current");
  }

  private nextAudit(resolution: PrivateApprovalResolutionV1): PrivateApprovalTerminalAuditV1 {
    const head = this.input.database.prepare(`SELECT audit_sequence, audit_entry_sha256 FROM organization_private_approval_terminal_evidence_v2 ORDER BY audit_sequence DESC LIMIT 1`).get() as { audit_sequence: number; audit_entry_sha256: string } | undefined;
    const auditSequence = head === undefined ? 1 : positive(head.audit_sequence, "stored audit sequence") + 1;
    const predecessor = head === undefined ? null : digest(head.audit_entry_sha256, "stored audit digest");
    const outcome = resolution.action === "approve" ? "approved" as const : "rejected" as const;
    return Object.freeze({ schema_version: 1, kind: AUDIT_KIND, audit_event_id: `aud_${canonicalSha256({ approval_id: resolution.approval_id, command_id: resolution.command_id }).slice(7, 39)}`, audit_sequence: auditSequence, approval_id: resolution.approval_id, resolution_sha256: canonicalSha256(resolution), outcome, predecessor_entry_sha256: predecessor, occurred_at: this.input.now() });
  }
}
