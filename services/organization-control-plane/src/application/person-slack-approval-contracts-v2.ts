/**
 * Pure, closed D2 contracts for one Person-bound Slack approval action.
 *
 * This module owns no persistence and performs no hashing. A boundary that
 * owns canonical JSON must persist each validated body and independently
 * compute every digest supplied to the aggregate builders below.
 */

export type ApprovalContractSha256 = `sha256:${string}`;
export type PersonApprovalAction = "approve" | "reject";
export type PersonMembershipType = "employee" | "owner";
export type PersonApprovalPolicyId =
  "organization-member-readable-person-v2" | "restricted-reviewer-person-v2";

export const ORGANIZATION_TOOL_CONNECTION_KIND =
  "echo-organization-tool-connection-v2" as const;
export const ORGANIZATION_TOOL_CONNECTION_STATE_KIND =
  "echo-organization-tool-connection-state-v2" as const;
export const EXTERNAL_HUMAN_LINK_CONTRACT_KIND =
  "echo-external-human-link-contract-v2" as const;
export const APPROVAL_BINDING_CONTRACT_KIND =
  "echo-approval-binding-contract-v2" as const;
export const APPROVAL_ACTION_CAPABILITY_KIND =
  "echo-approval-action-capability-v2" as const;
export const PROVIDER_OBSERVATION_KIND =
  "echo-provider-observation-v2" as const;
export const PROVIDER_APPROVAL_MESSAGE_KIND =
  "echo-provider-approval-message-v2" as const;
export const PROVIDER_HUMAN_ACTION_KIND =
  "echo-provider-human-action-v2" as const;
export const PROVIDER_HUMAN_AUTHORIZATION_KIND =
  "provider-human-approval-authorization-v2" as const;
export const INTEGRATION_AUDIT_ENTRY_KIND =
  "echo-integration-audit-entry-v2" as const;
export const PROVIDER_HUMAN_SEMANTIC_ACTION_INPUT_KIND =
  "echo-provider-human-semantic-action-input-v1" as const;

export const PERSON_CONTENT_POLICY_CONTRACT_KIND =
  "echo-person-content-policy-contract-v2" as const;
export const PERSON_CONTENT_POLICY_READER_AUTHENTICATION =
  "current-authority-person-session-v2" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
  "organization-member-readable-person-v2" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_ID =
  "restricted-reviewer-person-v2" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under organization-member-readable-person-v2. Any person authenticated by a current Authority Person session with a current active owner or employee membership in this organization, including a person who joins later, may search and read its decisions, actions, and rationales while that membership remains active.";
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT =
  "Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.";
export const PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS = Object.freeze([
  "decision",
  "action",
  "rationale",
] as const);
export const SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES = Object.freeze([
  "channels:history",
  "channels:read",
  "chat:write",
  "reactions:read",
  "users:read",
] as const);
export const ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3" as const;
export const ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256 =
  "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf" as const;
export const RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256 =
  "sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043" as const;
export const RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256 =
  "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594" as const;

export interface RestrictedReviewerPersonPolicyContractV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly reader_authentication: typeof PERSON_CONTENT_POLICY_READER_AUTHENTICATION;
  readonly reader_selector: {
    readonly kind: "exact-frozen-approver-tenure-v1";
    readonly membership_state: "active";
    readonly membership_scope: "same-organization-as-record";
    readonly frozen_tuple: "approval-principal-id-and-membership-id";
  };
  readonly readable_item_kinds: typeof PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS;
}

export interface OrganizationMemberReadablePersonPolicyContractV2 {
  readonly schema_version: 2;
  readonly kind: typeof PERSON_CONTENT_POLICY_CONTRACT_KIND;
  readonly policy_id: typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly reader_authentication: typeof PERSON_CONTENT_POLICY_READER_AUTHENTICATION;
  readonly reader_selector: {
    readonly kind: "current-active-organization-members-v1";
    readonly membership_state: "active";
    readonly membership_scope: "same-organization-as-record";
    readonly eligible_membership_types: readonly ["employee", "owner"];
    readonly later_members: "included";
  };
  readonly readable_item_kinds: typeof PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS;
}

export function buildRestrictedReviewerPersonPolicyContractV2(): RestrictedReviewerPersonPolicyContractV2 {
  return Object.freeze({
    schema_version: 2,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
    reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
    reader_selector: Object.freeze({
      kind: "exact-frozen-approver-tenure-v1",
      membership_state: "active",
      membership_scope: "same-organization-as-record",
      frozen_tuple: "approval-principal-id-and-membership-id",
    }),
    readable_item_kinds: PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS,
  });
}

export function buildOrganizationMemberReadablePersonPolicyContractV2(): OrganizationMemberReadablePersonPolicyContractV2 {
  return Object.freeze({
    schema_version: 2,
    kind: PERSON_CONTENT_POLICY_CONTRACT_KIND,
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_consequence_sha256:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
    reader_authentication: PERSON_CONTENT_POLICY_READER_AUTHENTICATION,
    reader_selector: Object.freeze({
      kind: "current-active-organization-members-v1",
      membership_state: "active",
      membership_scope: "same-organization-as-record",
      eligible_membership_types: Object.freeze(["employee", "owner"] as const),
      later_members: "included",
    }),
    readable_item_kinds: PERSON_CONTENT_POLICY_READABLE_ITEM_KINDS,
  });
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SLACK_REACTION = /^[a-z0-9_+-]{1,64}$/;

type UnknownRecord = Record<string, unknown>;

function invalid(label: string, detail: string): never {
  throw new Error(`${label} ${detail}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(label, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(label, "must not contain symbol keys");
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
      invalid(label, `field ${key} must be an enumerable data property`);
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(label, "has an unexpected shape");
  }
  return value as UnknownRecord;
}

function expectLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) invalid(label, `must be ${String(expected)}`);
}

function expectText(value: unknown, label: string, maximum = 256): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    invalid(label, "must be a bounded nonempty string");
  }
}

function expectNullableText(value: unknown, label: string): void {
  if (value !== null) expectText(value, label, 128);
}

function expectDigest(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(label, "must be a lowercase SHA-256 digest");
  }
}

function expectTimestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !UTC_INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid(label, "must be a canonical UTC instant");
  }
}

function expectPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(label, "must be a positive safe integer");
  }
}

function expectAction(
  value: unknown,
  label: string,
): asserts value is PersonApprovalAction {
  if (value !== "approve" && value !== "reject") {
    invalid(label, "must be approve or reject");
  }
}

function expectMembershipType(
  value: unknown,
  label: string,
): asserts value is PersonMembershipType {
  if (value !== "employee" && value !== "owner") {
    invalid(label, "must be employee or owner");
  }
}

function expectReaction(value: unknown, label: string): void {
  if (typeof value !== "string" || !SLACK_REACTION.test(value)) {
    invalid(label, "must be a canonical Slack reaction name");
  }
}

function orderedUniqueText(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) invalid(label, "must be an array");
  const result = value.map((entry, index) => {
    expectText(entry, `${label} ${index}`, 128);
    return entry as string;
  });
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]! >= result[index]!) {
      invalid(label, "must be unique and lexicographically ordered");
    }
  }
  return Object.freeze(result);
}

function expectEnvelope(
  record: UnknownRecord,
  version: 1 | 2,
  kind: string,
  label: string,
): void {
  expectLiteral(record.schema_version, version, `${label} schema_version`);
  expectLiteral(record.kind, kind, `${label} kind`);
}

function expectCoordinates(record: UnknownRecord, label: string): void {
  expectText(record.authority_id, `${label} authority_id`, 128);
  expectText(record.organization_id, `${label} organization_id`, 128);
  expectText(record.state_lineage_id, `${label} state_lineage_id`, 128);
}

function expectProviderTenant(
  record: UnknownRecord,
  label: string,
  includeTool: boolean,
): void {
  expectLiteral(
    record.provider_issuer,
    "https://slack.com",
    `${label} provider_issuer`,
  );
  expectLiteral(
    record.provider_tenant_kind,
    "workspace",
    `${label} provider_tenant_kind`,
  );
  expectText(record.provider_tenant_id, `${label} provider_tenant_id`, 128);
  expectNullableText(
    record.provider_enterprise_id,
    `${label} provider_enterprise_id`,
  );
  if (includeTool) {
    expectLiteral(record.tool_kind, "slack", `${label} tool_kind`);
  }
}

function expectAdapterIdentity(record: UnknownRecord, label: string): void {
  expectLiteral(
    record.approval_adapter_kind,
    "approval-surface",
    `${label} approval_adapter_kind`,
  );
  expectText(record.approval_adapter_id, `${label} approval_adapter_id`, 128);
  expectText(
    record.approval_adapter_instance_id,
    `${label} approval_adapter_instance_id`,
    128,
  );
  expectText(
    record.approval_adapter_version,
    `${label} approval_adapter_version`,
    64,
  );
}

function policyCommitment(
  policyId: unknown,
  label: string,
): {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
} {
  if (policyId === "organization-member-readable-person-v2") {
    return {
      policy_id: policyId,
      policy_contract_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256:
        ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_SHA256,
    };
  }
  if (policyId === "restricted-reviewer-person-v2") {
    return {
      policy_id: policyId,
      policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
      policy_consequence_sha256: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_SHA256,
    };
  }
  invalid(label, "must be an accepted Person policy ID");
}

function expectPolicyCommitment(
  record: UnknownRecord,
  label: string,
  includeConsequence: boolean,
): void {
  const expected = policyCommitment(record.policy_id, `${label} policy_id`);
  expectLiteral(
    record.policy_contract_sha256,
    expected.policy_contract_sha256,
    `${label} policy_contract_sha256`,
  );
  if (includeConsequence) {
    expectLiteral(
      record.policy_consequence_sha256,
      expected.policy_consequence_sha256,
      `${label} policy_consequence_sha256`,
    );
  }
}

function immutable<T>(record: UnknownRecord): T {
  return Object.freeze({ ...record }) as T;
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) invalid(label, "does not match the identity chain");
}

function sameFields(
  actual: UnknownRecord,
  expected: UnknownRecord,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields)
    same(actual[field], expected[field], `${label} ${field}`);
}

const ENVELOPE_KEYS = ["schema_version", "kind"] as const;
const COORDINATE_KEYS = [
  "authority_id",
  "organization_id",
  "state_lineage_id",
] as const;
const PROVIDER_TENANT_KEYS = [
  "provider_issuer",
  "provider_tenant_kind",
  "provider_tenant_id",
  "provider_enterprise_id",
] as const;
const PROVIDER_TOOL_KEYS = [...PROVIDER_TENANT_KEYS, "tool_kind"] as const;
const ADAPTER_KEYS = [
  "approval_adapter_kind",
  "approval_adapter_id",
  "approval_adapter_instance_id",
  "approval_adapter_version",
] as const;

interface ContractEnvelopeV2<K extends string> {
  readonly schema_version: 2;
  readonly kind: K;
}

interface AuthorityCoordinates {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}

interface SlackProviderTenant {
  readonly provider_issuer: "https://slack.com";
  readonly provider_tenant_kind: "workspace";
  readonly provider_tenant_id: string;
  readonly provider_enterprise_id: string | null;
}

interface SlackProviderTool extends SlackProviderTenant {
  readonly tool_kind: "slack";
}

interface ApprovalAdapterIdentity {
  readonly approval_adapter_kind: "approval-surface";
  readonly approval_adapter_id: string;
  readonly approval_adapter_instance_id: string;
  readonly approval_adapter_version: string;
}

export interface OrganizationToolConnectionContractV2
  extends
    ContractEnvelopeV2<typeof ORGANIZATION_TOOL_CONNECTION_KIND>,
    AuthorityCoordinates,
    SlackProviderTool {
  readonly connection_id: string;
  readonly provider_app_id: string;
  readonly provider_bot_id: string;
  readonly provider_bot_user_id: string;
  readonly required_provider_scopes: readonly string[];
  readonly public_connection_configuration_sha256: ApprovalContractSha256;
}

export type OrganizationToolConnectionContractInputV2 = Omit<
  OrganizationToolConnectionContractV2,
  "kind" | "schema_version"
>;

const CONNECTION_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "connection_id",
  ...PROVIDER_TOOL_KEYS,
  "provider_app_id",
  "provider_bot_id",
  "provider_bot_user_id",
  "required_provider_scopes",
  "public_connection_configuration_sha256",
] as const;

export function validateOrganizationToolConnectionContractV2(
  value: unknown,
): OrganizationToolConnectionContractV2 {
  const label = "organization tool connection contract v2";
  const record = exactRecord(value, CONNECTION_KEYS, label);
  expectEnvelope(record, 2, ORGANIZATION_TOOL_CONNECTION_KIND, label);
  expectCoordinates(record, label);
  expectProviderTenant(record, label, true);
  for (const field of [
    "connection_id",
    "provider_app_id",
    "provider_bot_id",
    "provider_bot_user_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 128);
  }
  const scopes = orderedUniqueText(
    record.required_provider_scopes,
    `${label} required_provider_scopes`,
  );
  if (
    scopes.length !== SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES.length ||
    scopes.some(
      (scope, index) =>
        scope !== SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES[index],
    )
  ) {
    invalid(
      `${label} required_provider_scopes`,
      "must be the exact Slack approval scope set",
    );
  }
  expectDigest(
    record.public_connection_configuration_sha256,
    `${label} public_connection_configuration_sha256`,
  );
  return immutable({ ...record, required_provider_scopes: scopes });
}

export function buildOrganizationToolConnectionContractV2(
  input: OrganizationToolConnectionContractInputV2,
): OrganizationToolConnectionContractV2 {
  return validateOrganizationToolConnectionContractV2({
    ...input,
    schema_version: 2,
    kind: ORGANIZATION_TOOL_CONNECTION_KIND,
  });
}

export interface OrganizationToolConnectionStateV2 extends ContractEnvelopeV2<
  typeof ORGANIZATION_TOOL_CONNECTION_STATE_KIND
> {
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_status: "active" | "revoked";
  readonly credential_reference_sha256: ApprovalContractSha256;
  readonly observed_granted_scopes: readonly string[];
  readonly verification_event_id: string;
  readonly verification_evidence_sha256: ApprovalContractSha256;
  readonly verification_revision: number;
  readonly verified_at: string;
}

export type OrganizationToolConnectionStateInputV2 = Omit<
  OrganizationToolConnectionStateV2,
  "kind" | "schema_version"
>;

const CONNECTION_STATE_KEYS = [
  ...ENVELOPE_KEYS,
  "connection_id",
  "connection_contract_sha256",
  "connection_status",
  "credential_reference_sha256",
  "observed_granted_scopes",
  "verification_event_id",
  "verification_evidence_sha256",
  "verification_revision",
  "verified_at",
] as const;

export function validateOrganizationToolConnectionStateV2(
  value: unknown,
): OrganizationToolConnectionStateV2 {
  const label = "organization tool connection state v2";
  const record = exactRecord(value, CONNECTION_STATE_KEYS, label);
  expectEnvelope(record, 2, ORGANIZATION_TOOL_CONNECTION_STATE_KIND, label);
  expectText(record.connection_id, `${label} connection_id`, 128);
  expectDigest(
    record.connection_contract_sha256,
    `${label} connection_contract_sha256`,
  );
  if (
    record.connection_status !== "active" &&
    record.connection_status !== "revoked"
  ) {
    invalid(`${label} connection_status`, "must be active or revoked");
  }
  expectDigest(
    record.credential_reference_sha256,
    `${label} credential_reference_sha256`,
  );
  const scopes = orderedUniqueText(
    record.observed_granted_scopes,
    `${label} observed_granted_scopes`,
  );
  expectText(
    record.verification_event_id,
    `${label} verification_event_id`,
    128,
  );
  expectDigest(
    record.verification_evidence_sha256,
    `${label} verification_evidence_sha256`,
  );
  expectPositiveInteger(
    record.verification_revision,
    `${label} verification_revision`,
  );
  expectTimestamp(record.verified_at, `${label} verified_at`);
  return immutable({ ...record, observed_granted_scopes: scopes });
}

export function buildOrganizationToolConnectionStateV2(
  input: OrganizationToolConnectionStateInputV2,
): OrganizationToolConnectionStateV2 {
  return validateOrganizationToolConnectionStateV2({
    ...input,
    schema_version: 2,
    kind: ORGANIZATION_TOOL_CONNECTION_STATE_KIND,
  });
}

export interface ExternalHumanIdentityLinkContractV2
  extends
    ContractEnvelopeV2<typeof EXTERNAL_HUMAN_LINK_CONTRACT_KIND>,
    AuthorityCoordinates,
    SlackProviderTenant {
  readonly external_identity_link_id: string;
  readonly provider_subject_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
  readonly verification_event_id: string;
  readonly verification_evidence_sha256: ApprovalContractSha256;
  readonly verified_at: string;
}

export type ExternalHumanIdentityLinkContractInputV2 = Omit<
  ExternalHumanIdentityLinkContractV2,
  "kind" | "schema_version"
>;

const EXTERNAL_LINK_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "external_identity_link_id",
  ...PROVIDER_TENANT_KEYS,
  "provider_subject_id",
  "principal_id",
  "membership_id",
  "membership_type",
  "verification_event_id",
  "verification_evidence_sha256",
  "verified_at",
] as const;

export function validateExternalHumanIdentityLinkContractV2(
  value: unknown,
): ExternalHumanIdentityLinkContractV2 {
  const label = "external human link contract v2";
  const record = exactRecord(value, EXTERNAL_LINK_KEYS, label);
  expectEnvelope(record, 2, EXTERNAL_HUMAN_LINK_CONTRACT_KIND, label);
  expectCoordinates(record, label);
  expectProviderTenant(record, label, false);
  for (const field of [
    "external_identity_link_id",
    "provider_subject_id",
    "principal_id",
    "membership_id",
    "verification_event_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 128);
  }
  expectMembershipType(record.membership_type, `${label} membership_type`);
  expectDigest(
    record.verification_evidence_sha256,
    `${label} verification_evidence_sha256`,
  );
  expectTimestamp(record.verified_at, `${label} verified_at`);
  return immutable(record);
}

export function buildExternalHumanIdentityLinkContractV2(
  input: ExternalHumanIdentityLinkContractInputV2,
): ExternalHumanIdentityLinkContractV2 {
  return validateExternalHumanIdentityLinkContractV2({
    ...input,
    schema_version: 2,
    kind: EXTERNAL_HUMAN_LINK_CONTRACT_KIND,
  });
}

export interface ApprovalBindingPolicyActionV2 {
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly actions: readonly ["approve", "reject"];
}

export interface PersonSlackApprovalBindingContractV2
  extends
    ContractEnvelopeV2<typeof APPROVAL_BINDING_CONTRACT_KIND>,
    AuthorityCoordinates,
    ApprovalAdapterIdentity {
  readonly approval_binding_id: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly approval_channel_id: string;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly supported_policy_actions: readonly [
    ApprovalBindingPolicyActionV2,
    ApprovalBindingPolicyActionV2,
  ];
}

export type PersonSlackApprovalBindingContractInputV2 = Omit<
  PersonSlackApprovalBindingContractV2,
  "kind" | "schema_version"
>;

const BINDING_POLICY_KEYS = [
  "policy_id",
  "policy_contract_sha256",
  "actions",
] as const;
const APPROVAL_BINDING_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "approval_binding_id",
  "connection_id",
  "connection_contract_sha256",
  ...ADAPTER_KEYS,
  "approval_channel_id",
  "approve_reaction",
  "reject_reaction",
  "supported_policy_actions",
] as const;

function validateBindingPolicyAction(
  value: unknown,
  expectedPolicy: PersonApprovalPolicyId,
  label: string,
): ApprovalBindingPolicyActionV2 {
  const record = exactRecord(value, BINDING_POLICY_KEYS, label);
  expectLiteral(record.policy_id, expectedPolicy, `${label} policy_id`);
  expectPolicyCommitment(record, label, false);
  if (
    !Array.isArray(record.actions) ||
    record.actions.length !== 2 ||
    record.actions[0] !== "approve" ||
    record.actions[1] !== "reject"
  ) {
    invalid(`${label} actions`, "must be exactly approve then reject");
  }
  return Object.freeze({
    policy_id: expectedPolicy,
    policy_contract_sha256:
      record.policy_contract_sha256 as ApprovalContractSha256,
    actions: Object.freeze(["approve", "reject"] as const),
  });
}

export function validatePersonSlackApprovalBindingContractV2(
  value: unknown,
): PersonSlackApprovalBindingContractV2 {
  const label = "Person Slack approval binding contract v2";
  const record = exactRecord(value, APPROVAL_BINDING_KEYS, label);
  expectEnvelope(record, 2, APPROVAL_BINDING_CONTRACT_KIND, label);
  expectCoordinates(record, label);
  expectAdapterIdentity(record, label);
  expectText(record.approval_binding_id, `${label} approval_binding_id`, 128);
  expectText(record.connection_id, `${label} connection_id`, 128);
  expectDigest(
    record.connection_contract_sha256,
    `${label} connection_contract_sha256`,
  );
  expectText(record.approval_channel_id, `${label} approval_channel_id`, 128);
  expectReaction(record.approve_reaction, `${label} approve_reaction`);
  expectReaction(record.reject_reaction, `${label} reject_reaction`);
  if (record.approve_reaction === record.reject_reaction) {
    invalid(label, "must use distinct approve and reject reactions");
  }
  if (
    !Array.isArray(record.supported_policy_actions) ||
    record.supported_policy_actions.length !== 2
  ) {
    invalid(
      `${label} supported_policy_actions`,
      "must contain exactly both accepted policies",
    );
  }
  const policies = Object.freeze([
    validateBindingPolicyAction(
      record.supported_policy_actions[0],
      "organization-member-readable-person-v2",
      `${label} policy 0`,
    ),
    validateBindingPolicyAction(
      record.supported_policy_actions[1],
      "restricted-reviewer-person-v2",
      `${label} policy 1`,
    ),
  ] as const);
  return immutable({ ...record, supported_policy_actions: policies });
}

export function buildPersonSlackApprovalBindingContractV2(
  input: PersonSlackApprovalBindingContractInputV2,
): PersonSlackApprovalBindingContractV2 {
  return validatePersonSlackApprovalBindingContractV2({
    ...input,
    schema_version: 2,
    kind: APPROVAL_BINDING_CONTRACT_KIND,
  });
}

export interface PersonSlackApprovalActionCapabilityV2
  extends
    ContractEnvelopeV2<typeof APPROVAL_ACTION_CAPABILITY_KIND>,
    AuthorityCoordinates {
  readonly action_capability_id: string;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly external_identity_link_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly action: PersonApprovalAction;
}

export type PersonSlackApprovalActionCapabilityInputV2 = Omit<
  PersonSlackApprovalActionCapabilityV2,
  "kind" | "schema_version"
>;

const ACTION_CAPABILITY_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "action_capability_id",
  "approval_binding_id",
  "approval_binding_contract_sha256",
  "external_identity_link_id",
  "principal_id",
  "membership_id",
  "membership_type",
  "policy_id",
  "policy_contract_sha256",
  "action",
] as const;

export function validatePersonSlackApprovalActionCapabilityV2(
  value: unknown,
): PersonSlackApprovalActionCapabilityV2 {
  const label = "Person Slack approval action capability v2";
  const record = exactRecord(value, ACTION_CAPABILITY_KEYS, label);
  expectEnvelope(record, 2, APPROVAL_ACTION_CAPABILITY_KIND, label);
  expectCoordinates(record, label);
  for (const field of [
    "action_capability_id",
    "approval_binding_id",
    "external_identity_link_id",
    "principal_id",
    "membership_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 128);
  }
  expectDigest(
    record.approval_binding_contract_sha256,
    `${label} approval_binding_contract_sha256`,
  );
  expectMembershipType(record.membership_type, `${label} membership_type`);
  expectPolicyCommitment(record, label, false);
  expectAction(record.action, `${label} action`);
  return immutable(record);
}

export function buildPersonSlackApprovalActionCapabilityV2(
  input: PersonSlackApprovalActionCapabilityInputV2,
): PersonSlackApprovalActionCapabilityV2 {
  return validatePersonSlackApprovalActionCapabilityV2({
    ...input,
    schema_version: 2,
    kind: APPROVAL_ACTION_CAPABILITY_KIND,
  });
}

export interface SlackProviderObservationV2
  extends
    ContractEnvelopeV2<typeof PROVIDER_OBSERVATION_KIND>,
    AuthorityCoordinates,
    SlackProviderTool,
    ApprovalAdapterIdentity {
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly provider_object_kind: "slack_message_reaction";
  readonly approval_channel_id: string;
  readonly provider_message_ts: string;
  readonly provider_actor_subject: string;
  readonly observed_reaction: string;
  readonly observed_action: PersonApprovalAction;
  readonly provider_response_evidence_sha256: ApprovalContractSha256;
  readonly observed_at: string;
}

export type SlackProviderObservationInputV2 = Omit<
  SlackProviderObservationV2,
  "kind" | "schema_version"
>;

const PROVIDER_OBSERVATION_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  ...PROVIDER_TOOL_KEYS,
  "connection_id",
  "connection_contract_sha256",
  "connection_state_sha256",
  ...ADAPTER_KEYS,
  "provider_object_kind",
  "approval_channel_id",
  "provider_message_ts",
  "provider_actor_subject",
  "observed_reaction",
  "observed_action",
  "provider_response_evidence_sha256",
  "observed_at",
] as const;

export function validateSlackProviderObservationV2(
  value: unknown,
): SlackProviderObservationV2 {
  const label = "Slack provider observation v2";
  const record = exactRecord(value, PROVIDER_OBSERVATION_KEYS, label);
  expectEnvelope(record, 2, PROVIDER_OBSERVATION_KIND, label);
  expectCoordinates(record, label);
  expectProviderTenant(record, label, true);
  expectAdapterIdentity(record, label);
  expectText(record.connection_id, `${label} connection_id`, 128);
  expectDigest(
    record.connection_contract_sha256,
    `${label} connection_contract_sha256`,
  );
  expectDigest(
    record.connection_state_sha256,
    `${label} connection_state_sha256`,
  );
  expectLiteral(
    record.provider_object_kind,
    "slack_message_reaction",
    `${label} provider_object_kind`,
  );
  for (const field of [
    "approval_channel_id",
    "provider_message_ts",
    "provider_actor_subject",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 128);
  }
  expectReaction(record.observed_reaction, `${label} observed_reaction`);
  expectAction(record.observed_action, `${label} observed_action`);
  expectDigest(
    record.provider_response_evidence_sha256,
    `${label} provider_response_evidence_sha256`,
  );
  expectTimestamp(record.observed_at, `${label} observed_at`);
  return immutable(record);
}

export function buildSlackProviderObservationV2(
  input: SlackProviderObservationInputV2,
): SlackProviderObservationV2 {
  return validateSlackProviderObservationV2({
    ...input,
    schema_version: 2,
    kind: PROVIDER_OBSERVATION_KIND,
  });
}

export interface SlackProviderApprovalMessageV2
  extends
    ContractEnvelopeV2<typeof PROVIDER_APPROVAL_MESSAGE_KIND>,
    AuthorityCoordinates,
    SlackProviderTool,
    ApprovalAdapterIdentity {
  readonly audit_event_id: string;
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly provider_app_id: string;
  readonly provider_bot_id: string;
  readonly provider_bot_user_id: string;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly approval_channel_id: string;
  readonly provider_message_ts: string;
  readonly provider_actor_subject: string;
  readonly observed_reaction: string;
  readonly approval_id: string;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly approve_reaction: string;
  readonly reject_reaction: string;
  readonly observed_at: string;
  readonly provider_observation_sha256: ApprovalContractSha256;
}

export type SlackProviderApprovalMessageInputV2 = Omit<
  SlackProviderApprovalMessageV2,
  "kind" | "schema_version"
>;

const PROVIDER_MESSAGE_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "audit_event_id",
  ...PROVIDER_TOOL_KEYS,
  "connection_id",
  "connection_contract_sha256",
  "connection_state_sha256",
  "provider_app_id",
  "provider_bot_id",
  "provider_bot_user_id",
  "approval_binding_id",
  "approval_binding_contract_sha256",
  ...ADAPTER_KEYS,
  "approval_channel_id",
  "provider_message_ts",
  "provider_actor_subject",
  "observed_reaction",
  "approval_id",
  "policy_id",
  "policy_contract_sha256",
  "frozen_card_sha256",
  "approved_snapshot_sha256",
  "policy_consequence_sha256",
  "approve_reaction",
  "reject_reaction",
  "observed_at",
  "provider_observation_sha256",
] as const;

export function validateSlackProviderApprovalMessageV2(
  value: unknown,
): SlackProviderApprovalMessageV2 {
  const label = "Slack provider approval message v2";
  const record = exactRecord(value, PROVIDER_MESSAGE_KEYS, label);
  expectEnvelope(record, 2, PROVIDER_APPROVAL_MESSAGE_KIND, label);
  expectCoordinates(record, label);
  expectProviderTenant(record, label, true);
  expectAdapterIdentity(record, label);
  for (const field of [
    "audit_event_id",
    "connection_id",
    "provider_app_id",
    "provider_bot_id",
    "provider_bot_user_id",
    "approval_binding_id",
    "approval_channel_id",
    "provider_message_ts",
    "provider_actor_subject",
    "approval_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 256);
  }
  for (const field of [
    "connection_contract_sha256",
    "connection_state_sha256",
    "approval_binding_contract_sha256",
    "frozen_card_sha256",
    "approved_snapshot_sha256",
    "provider_observation_sha256",
  ] as const) {
    expectDigest(record[field], `${label} ${field}`);
  }
  expectPolicyCommitment(record, label, true);
  expectReaction(record.observed_reaction, `${label} observed_reaction`);
  expectReaction(record.approve_reaction, `${label} approve_reaction`);
  expectReaction(record.reject_reaction, `${label} reject_reaction`);
  if (record.approve_reaction === record.reject_reaction) {
    invalid(label, "must use distinct approve and reject reactions");
  }
  expectTimestamp(record.observed_at, `${label} observed_at`);
  return immutable(record);
}

export function buildSlackProviderApprovalMessageV2(
  input: SlackProviderApprovalMessageInputV2,
): SlackProviderApprovalMessageV2 {
  return validateSlackProviderApprovalMessageV2({
    ...input,
    schema_version: 2,
    kind: PROVIDER_APPROVAL_MESSAGE_KIND,
  });
}

export interface SlackProviderHumanActionV2
  extends
    ContractEnvelopeV2<typeof PROVIDER_HUMAN_ACTION_KIND>,
    AuthorityCoordinates,
    SlackProviderTool,
    ApprovalAdapterIdentity {
  readonly connection_id: string;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly approval_binding_id: string;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly external_identity_link_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
  readonly action_capability_id: string;
  readonly action_capability_contract_sha256: ApprovalContractSha256;
  readonly provider_object_kind: "slack_message_reaction";
  readonly approval_channel_id: string;
  readonly provider_message_ts: string;
  readonly provider_actor_subject: string;
  readonly action: PersonApprovalAction;
  readonly approval_id: string;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly policy_consequence_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly approved_snapshot_sha256: ApprovalContractSha256;
  readonly provider_message_sha256: ApprovalContractSha256;
  readonly provider_observation_sha256: ApprovalContractSha256;
  readonly observed_at: string;
}

export type SlackProviderHumanActionInputV2 = Omit<
  SlackProviderHumanActionV2,
  "kind" | "schema_version"
>;

const PROVIDER_HUMAN_ACTION_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  ...PROVIDER_TOOL_KEYS,
  "connection_id",
  "connection_contract_sha256",
  "connection_state_sha256",
  "approval_binding_id",
  "approval_binding_contract_sha256",
  ...ADAPTER_KEYS,
  "external_identity_link_id",
  "principal_id",
  "membership_id",
  "membership_type",
  "action_capability_id",
  "action_capability_contract_sha256",
  "provider_object_kind",
  "approval_channel_id",
  "provider_message_ts",
  "provider_actor_subject",
  "action",
  "approval_id",
  "policy_id",
  "policy_contract_sha256",
  "policy_consequence_sha256",
  "frozen_card_sha256",
  "approved_snapshot_sha256",
  "provider_message_sha256",
  "provider_observation_sha256",
  "observed_at",
] as const;

export function validateSlackProviderHumanActionV2(
  value: unknown,
): SlackProviderHumanActionV2 {
  const label = "Slack provider human action v2";
  const record = exactRecord(value, PROVIDER_HUMAN_ACTION_KEYS, label);
  expectEnvelope(record, 2, PROVIDER_HUMAN_ACTION_KIND, label);
  expectCoordinates(record, label);
  expectProviderTenant(record, label, true);
  expectAdapterIdentity(record, label);
  for (const field of [
    "connection_id",
    "approval_binding_id",
    "external_identity_link_id",
    "principal_id",
    "membership_id",
    "action_capability_id",
    "approval_channel_id",
    "provider_message_ts",
    "provider_actor_subject",
    "approval_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 256);
  }
  for (const field of [
    "connection_contract_sha256",
    "connection_state_sha256",
    "approval_binding_contract_sha256",
    "action_capability_contract_sha256",
    "frozen_card_sha256",
    "approved_snapshot_sha256",
    "provider_message_sha256",
    "provider_observation_sha256",
  ] as const) {
    expectDigest(record[field], `${label} ${field}`);
  }
  expectMembershipType(record.membership_type, `${label} membership_type`);
  expectLiteral(
    record.provider_object_kind,
    "slack_message_reaction",
    `${label} provider_object_kind`,
  );
  expectAction(record.action, `${label} action`);
  expectPolicyCommitment(record, label, true);
  expectTimestamp(record.observed_at, `${label} observed_at`);
  return immutable(record);
}

export function buildSlackProviderHumanActionV2(
  input: SlackProviderHumanActionInputV2,
): SlackProviderHumanActionV2 {
  return validateSlackProviderHumanActionV2({
    ...input,
    schema_version: 2,
    kind: PROVIDER_HUMAN_ACTION_KIND,
  });
}

export interface ProviderHumanAuthorizationAllowV2
  extends
    ContractEnvelopeV2<typeof PROVIDER_HUMAN_AUTHORIZATION_KIND>,
    AuthorityCoordinates {
  readonly approval_id: string;
  readonly action: PersonApprovalAction;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: PersonMembershipType;
  readonly action_capability_id: string;
  readonly action_capability_contract_sha256: ApprovalContractSha256;
  readonly provider_observation_sha256: ApprovalContractSha256;
  readonly provider_message_sha256: ApprovalContractSha256;
  readonly provider_action_sha256: ApprovalContractSha256;
  readonly frozen_card_sha256: ApprovalContractSha256;
  readonly decision: "allow";
  readonly evaluated_at: string;
}

export type ProviderHumanAuthorizationAllowInputV2 = Omit<
  ProviderHumanAuthorizationAllowV2,
  "kind" | "schema_version"
>;

const AUTHORIZATION_ALLOW_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "approval_id",
  "action",
  "policy_id",
  "policy_contract_sha256",
  "principal_id",
  "membership_id",
  "membership_type",
  "action_capability_id",
  "action_capability_contract_sha256",
  "provider_observation_sha256",
  "provider_message_sha256",
  "provider_action_sha256",
  "frozen_card_sha256",
  "decision",
  "evaluated_at",
] as const;

export function validateProviderHumanAuthorizationAllowV2(
  value: unknown,
): ProviderHumanAuthorizationAllowV2 {
  const label = "provider human approval authorization v2";
  const record = exactRecord(value, AUTHORIZATION_ALLOW_KEYS, label);
  expectEnvelope(record, 2, PROVIDER_HUMAN_AUTHORIZATION_KIND, label);
  expectCoordinates(record, label);
  for (const field of [
    "approval_id",
    "principal_id",
    "membership_id",
    "action_capability_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 256);
  }
  expectAction(record.action, `${label} action`);
  expectPolicyCommitment(record, label, false);
  expectMembershipType(record.membership_type, `${label} membership_type`);
  for (const field of [
    "action_capability_contract_sha256",
    "provider_observation_sha256",
    "provider_message_sha256",
    "provider_action_sha256",
    "frozen_card_sha256",
  ] as const) {
    expectDigest(record[field], `${label} ${field}`);
  }
  expectLiteral(record.decision, "allow", `${label} decision`);
  expectTimestamp(record.evaluated_at, `${label} evaluated_at`);
  return immutable(record);
}

export function buildProviderHumanAuthorizationAllowV2(
  input: ProviderHumanAuthorizationAllowInputV2,
): ProviderHumanAuthorizationAllowV2 {
  return validateProviderHumanAuthorizationAllowV2({
    ...input,
    schema_version: 2,
    kind: PROVIDER_HUMAN_AUTHORIZATION_KIND,
  });
}

export interface ProviderHumanIntegrationAuditEntryV2
  extends
    ContractEnvelopeV2<typeof INTEGRATION_AUDIT_ENTRY_KIND>,
    AuthorityCoordinates {
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly actor_class: "provider_human";
  readonly external_identity_link_id: string;
  readonly connection_id: string;
  readonly approval_binding_id: string;
  readonly action_capability_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly action: PersonApprovalAction;
  readonly subject_kind: "approval";
  readonly subject_id: string;
  readonly event_digest: ApprovalContractSha256;
  readonly detail_digest: ApprovalContractSha256;
  readonly provider_message_sha256: ApprovalContractSha256;
  readonly provider_action_sha256: ApprovalContractSha256;
  readonly correlation_id: string;
  readonly occurred_at: string;
  readonly predecessor_entry_sha256: ApprovalContractSha256 | null;
}

export type ProviderHumanIntegrationAuditEntryInputV2 = Omit<
  ProviderHumanIntegrationAuditEntryV2,
  "kind" | "schema_version"
>;

const INTEGRATION_AUDIT_ENTRY_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "audit_event_id",
  "audit_sequence",
  "actor_class",
  "external_identity_link_id",
  "connection_id",
  "approval_binding_id",
  "action_capability_id",
  "principal_id",
  "membership_id",
  "action",
  "subject_kind",
  "subject_id",
  "event_digest",
  "detail_digest",
  "provider_message_sha256",
  "provider_action_sha256",
  "correlation_id",
  "occurred_at",
  "predecessor_entry_sha256",
] as const;

export function validateProviderHumanIntegrationAuditEntryV2(
  value: unknown,
): ProviderHumanIntegrationAuditEntryV2 {
  const label = "provider human integration audit entry v2";
  const record = exactRecord(value, INTEGRATION_AUDIT_ENTRY_KEYS, label);
  expectEnvelope(record, 2, INTEGRATION_AUDIT_ENTRY_KIND, label);
  expectCoordinates(record, label);
  for (const field of [
    "audit_event_id",
    "external_identity_link_id",
    "connection_id",
    "approval_binding_id",
    "action_capability_id",
    "principal_id",
    "membership_id",
    "subject_id",
    "correlation_id",
  ] as const) {
    expectText(record[field], `${label} ${field}`, 256);
  }
  expectPositiveInteger(record.audit_sequence, `${label} audit_sequence`);
  expectLiteral(record.actor_class, "provider_human", `${label} actor_class`);
  expectAction(record.action, `${label} action`);
  expectLiteral(record.subject_kind, "approval", `${label} subject_kind`);
  for (const field of [
    "event_digest",
    "detail_digest",
    "provider_message_sha256",
    "provider_action_sha256",
  ] as const) {
    expectDigest(record[field], `${label} ${field}`);
  }
  expectTimestamp(record.occurred_at, `${label} occurred_at`);
  if (record.predecessor_entry_sha256 === null) {
    if (record.audit_sequence !== 1) {
      invalid(label, "may omit predecessor only at lineage genesis");
    }
  } else {
    expectDigest(
      record.predecessor_entry_sha256,
      `${label} predecessor_entry_sha256`,
    );
    if (record.audit_sequence === 1) {
      invalid(label, "lineage genesis must have a null predecessor");
    }
  }
  return immutable(record);
}

export function buildProviderHumanIntegrationAuditEntryV2(
  input: ProviderHumanIntegrationAuditEntryInputV2,
): ProviderHumanIntegrationAuditEntryV2 {
  return validateProviderHumanIntegrationAuditEntryV2({
    ...input,
    schema_version: 2,
    kind: INTEGRATION_AUDIT_ENTRY_KIND,
  });
}

/** Minimal domain-separated input for D2 semantic replay/conflict handling. */
export interface ProviderHumanSemanticActionInputV1 extends AuthorityCoordinates {
  readonly schema_version: 1;
  readonly kind: typeof PROVIDER_HUMAN_SEMANTIC_ACTION_INPUT_KIND;
  readonly approval_id: string;
  readonly action: PersonApprovalAction;
  readonly provider_action_sha256: ApprovalContractSha256;
}

const SEMANTIC_ACTION_INPUT_KEYS = [
  ...ENVELOPE_KEYS,
  ...COORDINATE_KEYS,
  "approval_id",
  "action",
  "provider_action_sha256",
] as const;

export function validateProviderHumanSemanticActionInputV1(
  value: unknown,
): ProviderHumanSemanticActionInputV1 {
  const label = "provider human semantic action input v1";
  const record = exactRecord(value, SEMANTIC_ACTION_INPUT_KEYS, label);
  expectEnvelope(record, 1, PROVIDER_HUMAN_SEMANTIC_ACTION_INPUT_KIND, label);
  expectCoordinates(record, label);
  expectText(record.approval_id, `${label} approval_id`, 256);
  expectAction(record.action, `${label} action`);
  expectDigest(
    record.provider_action_sha256,
    `${label} provider_action_sha256`,
  );
  return immutable(record);
}

/**
 * Plain D2 durable locator. D3 may later wrap and reprove this information in
 * its own accepted contract; this value deliberately has no kind or version.
 */
export interface ProviderHumanActionRecoveryKey {
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: ApprovalContractSha256;
  readonly provider_action_sha256: ApprovalContractSha256;
  readonly authorization_proof_sha256: ApprovalContractSha256;
}

const RECOVERY_KEY_FIELDS = [
  "audit_event_id",
  "audit_sequence",
  "audit_entry_sha256",
  "provider_action_sha256",
  "authorization_proof_sha256",
] as const;

export function validateProviderHumanActionRecoveryKey(
  value: unknown,
): ProviderHumanActionRecoveryKey {
  const label = "provider human action recovery key";
  const record = exactRecord(value, RECOVERY_KEY_FIELDS, label);
  expectText(record.audit_event_id, `${label} audit_event_id`, 128);
  expectPositiveInteger(record.audit_sequence, `${label} audit_sequence`);
  for (const field of [
    "audit_entry_sha256",
    "provider_action_sha256",
    "authorization_proof_sha256",
  ] as const) {
    expectDigest(record[field], `${label} ${field}`);
  }
  return immutable(record);
}

/** Plain D2 result handed to a later, separately accepted record writer. */
export interface ProviderHumanActionDurableResult {
  readonly approval_id: string;
  readonly action: PersonApprovalAction;
  readonly policy_id: PersonApprovalPolicyId;
  readonly policy_contract_sha256: ApprovalContractSha256;
  readonly authorization_proof_sha256: ApprovalContractSha256;
  readonly locator: ProviderHumanActionRecoveryKey;
}

const DURABLE_RESULT_FIELDS = [
  "approval_id",
  "action",
  "policy_id",
  "policy_contract_sha256",
  "authorization_proof_sha256",
  "locator",
] as const;

export function validateProviderHumanActionDurableResult(
  value: unknown,
): ProviderHumanActionDurableResult {
  const label = "provider human action durable result";
  const record = exactRecord(value, DURABLE_RESULT_FIELDS, label);
  expectText(record.approval_id, `${label} approval_id`, 256);
  expectAction(record.action, `${label} action`);
  expectPolicyCommitment(record, label, false);
  expectDigest(
    record.authorization_proof_sha256,
    `${label} authorization_proof_sha256`,
  );
  const locator = validateProviderHumanActionRecoveryKey(record.locator);
  return immutable({ ...record, locator });
}

export interface ProviderHumanActionContractSetV2 {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly connection_contract_sha256: ApprovalContractSha256;
  readonly connection_state: OrganizationToolConnectionStateV2;
  readonly connection_state_sha256: ApprovalContractSha256;
  readonly external_human_link: ExternalHumanIdentityLinkContractV2;
  readonly approval_binding: PersonSlackApprovalBindingContractV2;
  readonly approval_binding_contract_sha256: ApprovalContractSha256;
  readonly action_capability: PersonSlackApprovalActionCapabilityV2;
  readonly action_capability_contract_sha256: ApprovalContractSha256;
  readonly provider_observation: SlackProviderObservationV2;
  readonly provider_observation_sha256: ApprovalContractSha256;
  readonly provider_message: SlackProviderApprovalMessageV2;
  readonly provider_message_sha256: ApprovalContractSha256;
  readonly provider_action: SlackProviderHumanActionV2;
  readonly provider_action_sha256: ApprovalContractSha256;
  readonly authorization_allow: ProviderHumanAuthorizationAllowV2;
  readonly authorization_proof_sha256: ApprovalContractSha256;
  readonly audit_entry: ProviderHumanIntegrationAuditEntryV2;
  readonly audit_entry_sha256: ApprovalContractSha256;
}

interface ValidatedContractSet {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly connectionState: OrganizationToolConnectionStateV2;
  readonly link: ExternalHumanIdentityLinkContractV2;
  readonly binding: PersonSlackApprovalBindingContractV2;
  readonly capability: PersonSlackApprovalActionCapabilityV2;
  readonly observation: SlackProviderObservationV2;
  readonly message: SlackProviderApprovalMessageV2;
  readonly action: SlackProviderHumanActionV2;
  readonly authorization: ProviderHumanAuthorizationAllowV2;
  readonly audit: ProviderHumanIntegrationAuditEntryV2;
}

function asUnknownRecord(value: object): UnknownRecord {
  return value as unknown as UnknownRecord;
}

function validateContractSet(
  input: ProviderHumanActionContractSetV2,
): ValidatedContractSet {
  const connection = validateOrganizationToolConnectionContractV2(
    input.connection,
  );
  const connectionState = validateOrganizationToolConnectionStateV2(
    input.connection_state,
  );
  const link = validateExternalHumanIdentityLinkContractV2(
    input.external_human_link,
  );
  const binding = validatePersonSlackApprovalBindingContractV2(
    input.approval_binding,
  );
  const capability = validatePersonSlackApprovalActionCapabilityV2(
    input.action_capability,
  );
  const observation = validateSlackProviderObservationV2(
    input.provider_observation,
  );
  const message = validateSlackProviderApprovalMessageV2(
    input.provider_message,
  );
  const actionBody = validateSlackProviderHumanActionV2(input.provider_action);
  const authorization = validateProviderHumanAuthorizationAllowV2(
    input.authorization_allow,
  );
  const audit = validateProviderHumanIntegrationAuditEntryV2(input.audit_entry);

  for (const [name, body] of [
    ["external link", link],
    ["approval binding", binding],
    ["action capability", capability],
    ["provider observation", observation],
    ["provider message", message],
    ["provider action", actionBody],
    ["authorization", authorization],
    ["audit entry", audit],
  ] as const) {
    sameFields(
      asUnknownRecord(body),
      asUnknownRecord(connection),
      COORDINATE_KEYS,
      name,
    );
  }

  same(
    connectionState.connection_id,
    connection.connection_id,
    "connection state ID",
  );
  same(
    connectionState.connection_contract_sha256,
    input.connection_contract_sha256,
    "connection state contract digest",
  );
  if (connectionState.connection_status !== "active") {
    invalid("connection state", "must be active at action time");
  }
  for (const scope of connection.required_provider_scopes) {
    if (!connectionState.observed_granted_scopes.includes(scope)) {
      invalid("connection state", `is missing required scope ${scope}`);
    }
  }

  sameFields(
    asUnknownRecord(link),
    asUnknownRecord(connection),
    PROVIDER_TENANT_KEYS,
    "external link provider tenant",
  );
  for (const [name, body] of [
    ["observation", observation],
    ["message", message],
    ["action", actionBody],
  ] as const) {
    sameFields(
      asUnknownRecord(body),
      asUnknownRecord(connection),
      PROVIDER_TOOL_KEYS,
      `${name} provider connection`,
    );
    same(body.connection_id, connection.connection_id, `${name} connection_id`);
    same(
      body.connection_contract_sha256,
      input.connection_contract_sha256,
      `${name} connection contract digest`,
    );
    same(
      body.connection_state_sha256,
      input.connection_state_sha256,
      `${name} connection state digest`,
    );
    same(
      body.provider_actor_subject,
      link.provider_subject_id,
      `${name} linked provider actor`,
    );
  }

  sameFields(
    asUnknownRecord(message),
    asUnknownRecord(connection),
    ["provider_app_id", "provider_bot_id", "provider_bot_user_id"],
    "message provider application",
  );

  same(
    binding.connection_id,
    connection.connection_id,
    "binding connection_id",
  );
  same(
    binding.connection_contract_sha256,
    input.connection_contract_sha256,
    "binding connection contract digest",
  );
  for (const [name, body] of [
    ["observation", observation],
    ["message", message],
    ["action", actionBody],
  ] as const) {
    sameFields(
      asUnknownRecord(body),
      asUnknownRecord(binding),
      ADAPTER_KEYS,
      `${name} approval adapter`,
    );
  }

  same(
    capability.approval_binding_id,
    binding.approval_binding_id,
    "capability binding",
  );
  same(
    capability.approval_binding_contract_sha256,
    input.approval_binding_contract_sha256,
    "capability binding digest",
  );
  same(
    capability.external_identity_link_id,
    link.external_identity_link_id,
    "capability external link",
  );
  sameFields(
    asUnknownRecord(capability),
    asUnknownRecord(link),
    ["principal_id", "membership_id", "membership_type"],
    "capability Person identity",
  );

  for (const [name, body] of [
    ["message", message],
    ["action", actionBody],
  ] as const) {
    same(
      body.approval_binding_id,
      binding.approval_binding_id,
      `${name} binding`,
    );
    same(
      body.approval_binding_contract_sha256,
      input.approval_binding_contract_sha256,
      `${name} binding digest`,
    );
    same(
      body.approval_channel_id,
      binding.approval_channel_id,
      `${name} channel`,
    );
  }
  same(
    observation.approval_channel_id,
    binding.approval_channel_id,
    "observation channel",
  );

  const expectedReaction =
    capability.action === "approve"
      ? binding.approve_reaction
      : binding.reject_reaction;
  same(observation.observed_action, capability.action, "observation action");
  same(
    observation.observed_reaction,
    expectedReaction,
    "observation reaction mapping",
  );
  same(message.observed_reaction, expectedReaction, "message reaction mapping");
  same(
    message.approve_reaction,
    binding.approve_reaction,
    "message approve reaction",
  );
  same(
    message.reject_reaction,
    binding.reject_reaction,
    "message reject reaction",
  );

  sameFields(
    asUnknownRecord(message),
    asUnknownRecord(observation),
    [
      "approval_channel_id",
      "provider_message_ts",
      "provider_actor_subject",
      "observed_reaction",
      "observed_at",
    ],
    "message observation",
  );
  same(
    message.provider_observation_sha256,
    input.provider_observation_sha256,
    "message observation digest",
  );

  sameFields(
    asUnknownRecord(actionBody),
    asUnknownRecord(observation),
    [
      "provider_object_kind",
      "approval_channel_id",
      "provider_message_ts",
      "provider_actor_subject",
      "observed_at",
    ],
    "action observation",
  );
  same(
    actionBody.provider_observation_sha256,
    input.provider_observation_sha256,
    "action observation digest",
  );
  same(
    actionBody.provider_message_sha256,
    input.provider_message_sha256,
    "action message digest",
  );
  same(
    actionBody.external_identity_link_id,
    link.external_identity_link_id,
    "action link",
  );
  sameFields(
    asUnknownRecord(actionBody),
    asUnknownRecord(link),
    ["principal_id", "membership_id", "membership_type"],
    "action Person identity",
  );
  same(
    actionBody.action_capability_id,
    capability.action_capability_id,
    "action capability",
  );
  same(
    actionBody.action_capability_contract_sha256,
    input.action_capability_contract_sha256,
    "action capability digest",
  );
  sameFields(
    asUnknownRecord(actionBody),
    asUnknownRecord(capability),
    ["action", "policy_id", "policy_contract_sha256"],
    "action capability policy",
  );
  sameFields(
    asUnknownRecord(actionBody),
    asUnknownRecord(message),
    [
      "approval_id",
      "policy_id",
      "policy_contract_sha256",
      "policy_consequence_sha256",
      "frozen_card_sha256",
      "approved_snapshot_sha256",
    ],
    "action frozen approval",
  );
  sameFields(
    asUnknownRecord(message),
    asUnknownRecord(capability),
    ["policy_id", "policy_contract_sha256"],
    "message capability policy",
  );

  sameFields(
    asUnknownRecord(authorization),
    asUnknownRecord(actionBody),
    [
      "approval_id",
      "action",
      "policy_id",
      "policy_contract_sha256",
      "principal_id",
      "membership_id",
      "membership_type",
      "action_capability_id",
      "action_capability_contract_sha256",
      "frozen_card_sha256",
    ],
    "authorization action",
  );
  same(
    authorization.provider_observation_sha256,
    input.provider_observation_sha256,
    "authorization observation digest",
  );
  same(
    authorization.provider_message_sha256,
    input.provider_message_sha256,
    "authorization message digest",
  );
  same(
    authorization.provider_action_sha256,
    input.provider_action_sha256,
    "authorization action digest",
  );

  same(audit.audit_event_id, message.audit_event_id, "audit event ID");
  same(
    audit.external_identity_link_id,
    link.external_identity_link_id,
    "audit link",
  );
  same(audit.connection_id, connection.connection_id, "audit connection");
  same(audit.approval_binding_id, binding.approval_binding_id, "audit binding");
  same(
    audit.action_capability_id,
    capability.action_capability_id,
    "audit capability",
  );
  sameFields(
    asUnknownRecord(audit),
    asUnknownRecord(actionBody),
    ["principal_id", "membership_id", "action"],
    "audit actor/action",
  );
  same(audit.subject_id, actionBody.approval_id, "audit approval subject");
  same(
    audit.event_digest,
    input.provider_observation_sha256,
    "audit event digest",
  );
  same(
    audit.detail_digest,
    input.authorization_proof_sha256,
    "audit detail digest",
  );
  same(
    audit.provider_message_sha256,
    input.provider_message_sha256,
    "audit message digest",
  );
  same(
    audit.provider_action_sha256,
    input.provider_action_sha256,
    "audit action digest",
  );

  if (
    Date.parse(connectionState.verified_at) >
      Date.parse(observation.observed_at) ||
    Date.parse(link.verified_at) > Date.parse(observation.observed_at) ||
    Date.parse(observation.observed_at) >
      Date.parse(authorization.evaluated_at) ||
    Date.parse(authorization.evaluated_at) > Date.parse(audit.occurred_at)
  ) {
    invalid("provider human action timestamps", "must be monotonic");
  }

  for (const [digestValue, label] of [
    [input.connection_contract_sha256, "connection_contract_sha256"],
    [input.connection_state_sha256, "connection_state_sha256"],
    [
      input.approval_binding_contract_sha256,
      "approval_binding_contract_sha256",
    ],
    [
      input.action_capability_contract_sha256,
      "action_capability_contract_sha256",
    ],
    [input.provider_observation_sha256, "provider_observation_sha256"],
    [input.provider_message_sha256, "provider_message_sha256"],
    [input.provider_action_sha256, "provider_action_sha256"],
    [input.authorization_proof_sha256, "authorization_proof_sha256"],
    [input.audit_entry_sha256, "audit_entry_sha256"],
  ] as const) {
    expectDigest(digestValue, `contract set ${label}`);
  }

  return {
    connection,
    connectionState,
    link,
    binding,
    capability,
    observation,
    message,
    action: actionBody,
    authorization,
    audit,
  };
}

export function buildProviderHumanSemanticActionInputV1(
  input: ProviderHumanActionContractSetV2,
): ProviderHumanSemanticActionInputV1 {
  const validated = validateContractSet(input);
  return validateProviderHumanSemanticActionInputV1({
    schema_version: 1,
    kind: PROVIDER_HUMAN_SEMANTIC_ACTION_INPUT_KIND,
    authority_id: validated.action.authority_id,
    organization_id: validated.action.organization_id,
    state_lineage_id: validated.action.state_lineage_id,
    approval_id: validated.action.approval_id,
    action: validated.action.action,
    provider_action_sha256: input.provider_action_sha256,
  });
}

export function buildProviderHumanActionRecoveryKey(
  input: ProviderHumanActionContractSetV2,
): ProviderHumanActionRecoveryKey {
  const validated = validateContractSet(input);
  return validateProviderHumanActionRecoveryKey({
    audit_event_id: validated.audit.audit_event_id,
    audit_sequence: validated.audit.audit_sequence,
    audit_entry_sha256: input.audit_entry_sha256,
    provider_action_sha256: input.provider_action_sha256,
    authorization_proof_sha256: input.authorization_proof_sha256,
  });
}

export function buildProviderHumanActionDurableResult(
  input: ProviderHumanActionContractSetV2,
): ProviderHumanActionDurableResult {
  const validated = validateContractSet(input);
  return validateProviderHumanActionDurableResult({
    approval_id: validated.action.approval_id,
    action: validated.action.action,
    policy_id: validated.action.policy_id,
    policy_contract_sha256: validated.action.policy_contract_sha256,
    authorization_proof_sha256: input.authorization_proof_sha256,
    locator: {
      audit_event_id: validated.audit.audit_event_id,
      audit_sequence: validated.audit.audit_sequence,
      audit_entry_sha256: input.audit_entry_sha256,
      provider_action_sha256: input.provider_action_sha256,
      authorization_proof_sha256: input.authorization_proof_sha256,
    },
  });
}
