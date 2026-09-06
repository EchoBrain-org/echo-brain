/**
 * Pure, closed D2 contracts for one organization-owned Slack tool connection
 * and one Person-to-Slack external identity link.
 *
 * This module owns no persistence and performs no hashing. A boundary that
 * owns canonical JSON must persist each validated body and independently
 * compute every digest supplied to the builders below.
 */

import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "./slack-integration-contracts.js";
import type { ApprovalContractSha256 } from "./record-visibility-policy-contracts-v1.js";

export type PersonMembershipType = "employee" | "owner";

export const ORGANIZATION_TOOL_CONNECTION_KIND =
  "echo-organization-tool-connection-v2" as const;
export const ORGANIZATION_TOOL_CONNECTION_STATE_KIND =
  "echo-organization-tool-connection-state-v2" as const;
export const EXTERNAL_HUMAN_LINK_CONTRACT_KIND =
  "echo-external-human-link-contract-v2" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function expectMembershipType(
  value: unknown,
  label: string,
): asserts value is PersonMembershipType {
  if (value !== "employee" && value !== "owner") {
    invalid(label, "must be employee or owner");
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

function immutable<T>(record: UnknownRecord): T {
  return Object.freeze({ ...record }) as T;
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
    scopes.length !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.length ||
    scopes.some(
      (scope, index) => scope !== SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES[index],
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
