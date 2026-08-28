/** Canonical, server-authored Slack Block Kit approval-surface commitment. */
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ApprovalContractSha256,
} from "./person-slack-approval-contracts-v2.js";

const KIND = "echo-private-approval-surface-binding-v1" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE = /^T[A-Z0-9]{2,255}$/;
const ENTERPRISE = /^E[A-Z0-9]{2,255}$/;
const APP = /^A[A-Z0-9]{2,255}$/;
const BOT = /^B[A-Z0-9]{2,255}$/;
const SUBJECT = /^[UW][A-Z0-9]{2,255}$/;
type RecordValue = Record<string, unknown>;

export const PRIVATE_APPROVAL_SLACK_INTERACTION_PATH_V1 =
  "/v2/integrations/slack/interactions" as const;
export const PRIVATE_APPROVAL_BLOCK_ACTION_NAMESPACE_V1 =
  "echo-private-approval-v1" as const;

export interface PrivateApprovalSurfaceBindingV1 {
  readonly schema_version: 1;
  readonly kind: typeof KIND;
  readonly approval_surface_binding_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly provider_app_id: string;
  readonly provider_bot_id: string;
  readonly provider_bot_user_id: string;
  readonly slack_workspace_id: string;
  readonly slack_enterprise_id: string | null;
  readonly adapter_id: "slack-block-actions";
  readonly adapter_version: "v1";
  readonly interaction_path: typeof PRIVATE_APPROVAL_SLACK_INTERACTION_PATH_V1;
  readonly card_schema_version: 1;
  readonly action_namespace: typeof PRIVATE_APPROVAL_BLOCK_ACTION_NAMESPACE_V1;
  readonly supported_policy_ids: readonly [
    typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  ];
}

export type BuildPrivateApprovalSurfaceBindingV1Input = Omit<
  PrivateApprovalSurfaceBindingV1,
  "approval_surface_binding_id" | "schema_version" | "kind"
>;

/** The application contract stays pure by receiving the deterministic codec. */
export interface PrivateApprovalSurfaceBindingCodecV1 {
  sha256(value: unknown): ApprovalContractSha256;
}

function invalid(detail: string): never {
  throw new Error(`private approval surface binding ${detail}`);
}

function exact(value: unknown, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) invalid("must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid("has unexpected fields");
  return value as RecordValue;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): ApprovalContractSha256 {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${label} is invalid`);
  return value as ApprovalContractSha256;
}

function tagged(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== "string" || !expression.test(value)) invalid(`${label} is invalid`);
  return value;
}

type BindingFields = Omit<
  PrivateApprovalSurfaceBindingV1,
  "schema_version" | "kind" | "approval_surface_binding_id"
>;

function body(value: unknown, withId: boolean): BindingFields & { approval_surface_binding_id?: string } {
  const keys = ["authority_id", "organization_id", "state_lineage_id", "connection_id", "connection_contract_sha256", "connection_state_sha256", "provider_app_id", "provider_bot_id", "provider_bot_user_id", "slack_workspace_id", "slack_enterprise_id", "adapter_id", "adapter_version", "interaction_path", "card_schema_version", "action_namespace", "supported_policy_ids"];
  const record = exact(value, withId ? ["schema_version", "kind", "approval_surface_binding_id", ...keys] : keys);
  if (withId && (record.schema_version !== 1 || record.kind !== KIND)) invalid("schema is invalid");
  const enterprise = record.slack_enterprise_id;
  if (enterprise !== null && (typeof enterprise !== "string" || !ENTERPRISE.test(enterprise))) invalid("enterprise is invalid");
  if (record.adapter_id !== "slack-block-actions" || record.adapter_version !== "v1" || record.interaction_path !== PRIVATE_APPROVAL_SLACK_INTERACTION_PATH_V1 || record.card_schema_version !== 1 || record.action_namespace !== PRIVATE_APPROVAL_BLOCK_ACTION_NAMESPACE_V1) invalid("surface configuration is invalid");
  if (!Array.isArray(record.supported_policy_ids) || record.supported_policy_ids.length !== 2 || record.supported_policy_ids[0] !== RESTRICTED_REVIEWER_PERSON_POLICY_ID || record.supported_policy_ids[1] !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) invalid("supported policies are invalid");
  return Object.freeze({
    authority_id: identifier(record.authority_id, "authority"), organization_id: identifier(record.organization_id, "organization"), state_lineage_id: identifier(record.state_lineage_id, "lineage"), connection_id: identifier(record.connection_id, "connection"),
    connection_contract_sha256: digest(record.connection_contract_sha256, "connection contract"), connection_state_sha256: digest(record.connection_state_sha256, "connection state"),
    provider_app_id: tagged(record.provider_app_id, APP, "app"), provider_bot_id: tagged(record.provider_bot_id, BOT, "bot"), provider_bot_user_id: tagged(record.provider_bot_user_id, SUBJECT, "bot user"),
    slack_workspace_id: tagged(record.slack_workspace_id, WORKSPACE, "workspace"), slack_enterprise_id: enterprise,
    adapter_id: "slack-block-actions", adapter_version: "v1", interaction_path: PRIVATE_APPROVAL_SLACK_INTERACTION_PATH_V1, card_schema_version: 1, action_namespace: PRIVATE_APPROVAL_BLOCK_ACTION_NAMESPACE_V1,
    supported_policy_ids: Object.freeze([RESTRICTED_REVIEWER_PERSON_POLICY_ID, ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID]) as PrivateApprovalSurfaceBindingV1["supported_policy_ids"],
    ...(withId ? { approval_surface_binding_id: identifier(record.approval_surface_binding_id, "binding id") } : {}),
  });
}

function idFor(
  value: BindingFields,
  codec: PrivateApprovalSurfaceBindingCodecV1,
): string {
  return `bnd_${codec.sha256(value).slice(7, 39)}`;
}

export function buildPrivateApprovalSurfaceBindingV1(
  input: BuildPrivateApprovalSurfaceBindingV1Input,
  codec: PrivateApprovalSurfaceBindingCodecV1,
): Readonly<{ readonly body: PrivateApprovalSurfaceBindingV1; readonly sha256: ApprovalContractSha256 }> {
  const parsed = body(input, false) as BindingFields;
  const binding = Object.freeze({ schema_version: 1 as const, kind: KIND, approval_surface_binding_id: idFor(parsed, codec), ...parsed }) as PrivateApprovalSurfaceBindingV1;
  return Object.freeze({ body: binding, sha256: codec.sha256(binding) });
}

export function validatePrivateApprovalSurfaceBindingV1(
  value: unknown,
  codec: PrivateApprovalSurfaceBindingCodecV1,
): PrivateApprovalSurfaceBindingV1 {
  const parsed = body(value, true) as BindingFields & {
    approval_surface_binding_id: string;
  };
  const withoutId = { ...parsed } as Record<string, unknown>;
  delete withoutId.approval_surface_binding_id;
  if (parsed.approval_surface_binding_id !== idFor(withoutId as BindingFields, codec)) invalid("binding id is not deterministic");
  return Object.freeze({ schema_version: 1, kind: KIND, ...parsed }) as PrivateApprovalSurfaceBindingV1;
}
