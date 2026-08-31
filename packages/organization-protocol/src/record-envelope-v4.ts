import { Buffer } from "node:buffer";
import {
  assertP256LowS,
  canonicalJsonBytes,
  canonicalSha256,
  verifyP256LowSSignature,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  resolvePinnedOrganizationAuthority,
} from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import {
  buildHumanActRecordInputV1,
  validateHumanActRecordInputV1,
  validateHumanActResolutionRefV1,
  validateHumanActEventV1,
} from "./human-act-record-input-v1.js";
import type {
  HumanActEventV1,
  HumanActRecordInputV1,
  HumanActResolutionRefV1,
} from "./human-act-record-input-v1.js";
import {
  buildPrivateSlackBlockApprovalRecordInputV1,
  validatePrivateSlackBlockApprovalEventV1,
  validatePrivateSlackBlockApprovalRecordInputV1,
  validatePrivateSlackBlockApprovalResolutionRefV1,
  PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND,
} from "./private-slack-block-approval-record-input-v1.js";
import type {
  PrivateSlackBlockApprovalEventV1,
  PrivateSlackBlockApprovalRecordInputV1,
  PrivateSlackBlockApprovalResolutionRefV1,
} from "./private-slack-block-approval-record-input-v1.js";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "./record-payload.js";
import {
  assertDigest,
  assertPositiveSafeInteger,
  assertTimestamp,
  canonicalSnapshot,
  validateP256SigningKey,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const MEETING_SOURCE_PROVENANCE_V1_KIND =
  "echo-meeting-source-provenance-v1" as const;
export const DECISION_PROCESSOR_PROVENANCE_V1_KIND =
  "echo-decision-processor-provenance-v1" as const;
export const ORGANIZATION_RECORD_ENVELOPE_V4_KIND =
  "echo-organization-record-envelope-v4" as const;
export const ORGANIZATION_RECORD_SIGNATURE_V4_KIND =
  "echo-organization-record-signature-v4" as const;

const SOURCE_PROVENANCE_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "source_adapter_kind",
  "source_adapter_id",
  "source_adapter_instance_id",
  "source_adapter_version",
  "external_id",
  "canonical_revision",
  "normalizer_version",
  "source_revision",
] as const;

const PROCESSOR_PROVENANCE_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "processor_adapter_kind",
  "processor_adapter_id",
  "processor_adapter_instance_id",
  "processor_adapter_version",
  "processor_contract_sha256",
] as const;

const RECORD_BODY_KEYS = [
  "schema_version",
  "kind",
  "envelope_id",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "semantic_idempotency_key",
  "issued_at",
  "predecessor_position",
  "predecessor_record_sha256",
  "human_act_resolution_ref",
  "source_provenance",
  "source_provenance_sha256",
  "processor_provenance",
  "processor_provenance_sha256",
  "event",
] as const;

const SIGNATURE_INPUT_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "signing_key_id",
  "record_sha256",
] as const;

const RECORD_WRAPPER_KEYS = [
  "body",
  "record_sha256",
  "signing_key_descriptor",
  "signature",
] as const;

const CREATE_INPUT_KEYS = [
  "envelope_id",
  "issued_at",
  "predecessor_position",
  "predecessor_record_sha256",
  "human_act_record_input",
  "source_provenance",
  "processor_provenance",
] as const;

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface MeetingSourceProvenanceV1 {
  readonly schema_version: 1;
  readonly kind: typeof MEETING_SOURCE_PROVENANCE_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly source_adapter_kind: "meeting-source";
  readonly source_adapter_id: string;
  readonly source_adapter_instance_id: string;
  readonly source_adapter_version: string;
  readonly external_id: string;
  readonly canonical_revision: string;
  readonly normalizer_version: string;
  readonly source_revision: string | null;
}

export interface DecisionProcessorProvenanceV1 {
  readonly schema_version: 1;
  readonly kind: typeof DECISION_PROCESSOR_PROVENANCE_V1_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly processor_adapter_kind: "decision-processor";
  readonly processor_adapter_id: string;
  readonly processor_adapter_instance_id: string;
  /** Adapter implementation version; independent from the contract digest. */
  readonly processor_adapter_version: string;
  /**
   * Opaque frozen processor contract/config commitment. D3-2 binds but does
   * not claim to derive or revalidate its Phase-3-owned exact preimage.
   */
  readonly processor_contract_sha256: Sha256Digest;
}

export interface OrganizationRecordEnvelopeBodyV4 {
  readonly schema_version: 4;
  readonly kind: typeof ORGANIZATION_RECORD_ENVELOPE_V4_KIND;
  readonly envelope_id: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly issued_at: string;
  readonly predecessor_position: number | null;
  readonly predecessor_record_sha256: Sha256Digest | null;
  readonly human_act_resolution_ref:
    | HumanActResolutionRefV1
    | PrivateSlackBlockApprovalResolutionRefV1;
  readonly source_provenance: MeetingSourceProvenanceV1;
  readonly source_provenance_sha256: Sha256Digest;
  readonly processor_provenance: DecisionProcessorProvenanceV1;
  readonly processor_provenance_sha256: Sha256Digest;
  readonly event: HumanActEventV1 | PrivateSlackBlockApprovalEventV1;
}

export interface OrganizationRecordSignatureInputV4 {
  readonly schema_version: 4;
  readonly kind: typeof ORGANIZATION_RECORD_SIGNATURE_V4_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly signing_key_id: Sha256Digest;
  readonly record_sha256: Sha256Digest;
}

export interface OrganizationRecordEnvelopeV4 {
  readonly body: OrganizationRecordEnvelopeBodyV4;
  readonly record_sha256: Sha256Digest;
  readonly signing_key_descriptor: P256SigningKeyDescriptor;
  readonly signature: string;
}

export interface CreateOrganizationRecordEnvelopeV4Input {
  readonly envelope_id: string;
  readonly issued_at: string;
  readonly predecessor_position: number | null;
  readonly predecessor_record_sha256: Sha256Digest | null;
  readonly human_act_record_input:
    | HumanActRecordInputV1
    | PrivateSlackBlockApprovalRecordInputV1;
  readonly source_provenance: MeetingSourceProvenanceV1;
  readonly processor_provenance: DecisionProcessorProvenanceV1;
}

/** Authority-owned detached signer with explicit key selection. */
export type AuthorityDetachedSigner = (
  canonicalMessage: Buffer,
  expectedKeyId: Sha256Digest,
) => Promise<Buffer>;

function fail(message: string, cause?: unknown): never {
  return organizationProtocolValidationFailure(message, cause);
}

/** Rejects every value that cannot be represented as inert, plain JSON data. */
function assertPlainJsonData(
  value: unknown,
  label: string,
  seen: Set<object> = new Set<object>(),
): void {
  if (value === null) return;
  if (typeof value !== "object") {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      fail(`${label} must contain only finite JSON data`);
    }
    return;
  }
  if (seen.has(value)) fail(`${label} must not contain a cycle`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(`${label} must not contain symbol properties`);
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail(`${label} must be a plain array`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) {
        fail(`${label} must be a dense plain array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          fail(`${label} must contain only enumerable data properties`);
        }
        assertPlainJsonData(descriptor.value, label, seen);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(`${label} must be a plain object`);
    }
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        fail(`${label} must contain only enumerable data properties`);
      }
      assertPlainJsonData(descriptor.value, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainJsonData(value, label);
  const snapshot = canonicalSnapshot(
    value,
    label,
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  );
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    fail(`${label} must be a plain object`);
  }
  const record = snapshot as Record<string, unknown>;
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

function assertText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    fail(`${label} must be a bounded non-empty string`);
  }
}

/**
 * Provider-owned identifiers are opaque bytes carried in a JSON string. Keep
 * surrounding/control characters exactly as supplied; only NUL is forbidden.
 */
function assertOpaqueProviderText(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    fail(`${label} must be a bounded non-empty opaque string`);
  }
}

function assertNullableOpaqueProviderText(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null) assertOpaqueProviderText(value, label);
}

function assertCoordinates(
  value: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  },
  expected: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  },
  label: string,
): void {
  if (
    value.authority_id !== expected.authority_id ||
    value.organization_id !== expected.organization_id ||
    value.state_lineage_id !== expected.state_lineage_id
  ) {
    fail(`${label} does not match the record coordinates`);
  }
}

export function validateMeetingSourceProvenanceV1(
  value: unknown,
): MeetingSourceProvenanceV1 {
  const provenance = exactObject(
    value,
    SOURCE_PROVENANCE_KEYS,
    "Meeting source provenance v1",
  );
  if (
    provenance.schema_version !== 1 ||
    provenance.kind !== MEETING_SOURCE_PROVENANCE_V1_KIND
  ) {
    fail("Meeting source provenance v1 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "source_adapter_id",
    "source_adapter_instance_id",
    "source_adapter_version",
    "normalizer_version",
  ] as const) {
    assertText(provenance[key], `Meeting source provenance v1 ${key}`);
  }
  if (provenance.source_adapter_kind !== "meeting-source") {
    fail("Meeting source provenance v1 adapter kind is unsupported");
  }
  assertOpaqueProviderText(
    provenance.external_id,
    "Meeting source provenance v1 external_id",
  );
  assertOpaqueProviderText(
    provenance.canonical_revision,
    "Meeting source provenance v1 canonical_revision",
  );
  assertNullableOpaqueProviderText(
    provenance.source_revision,
    "Meeting source provenance v1 source_revision",
  );
  return provenance as unknown as MeetingSourceProvenanceV1;
}

export function meetingSourceProvenanceV1Sha256(
  value: MeetingSourceProvenanceV1,
): Sha256Digest {
  return canonicalSha256(validateMeetingSourceProvenanceV1(value));
}

export function validateDecisionProcessorProvenanceV1(
  value: unknown,
): DecisionProcessorProvenanceV1 {
  const provenance = exactObject(
    value,
    PROCESSOR_PROVENANCE_KEYS,
    "Decision processor provenance v1",
  );
  if (
    provenance.schema_version !== 1 ||
    provenance.kind !== DECISION_PROCESSOR_PROVENANCE_V1_KIND
  ) {
    fail("Decision processor provenance v1 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "processor_adapter_id",
    "processor_adapter_instance_id",
    "processor_adapter_version",
  ] as const) {
    assertText(provenance[key], `Decision processor provenance v1 ${key}`);
  }
  if (provenance.processor_adapter_kind !== "decision-processor") {
    fail("Decision processor provenance v1 adapter kind is unsupported");
  }
  assertDigest(
    provenance.processor_contract_sha256,
    "Decision processor provenance v1 processor_contract_sha256",
  );
  return provenance as unknown as DecisionProcessorProvenanceV1;
}

export function decisionProcessorProvenanceV1Sha256(
  value: DecisionProcessorProvenanceV1,
): Sha256Digest {
  return canonicalSha256(validateDecisionProcessorProvenanceV1(value));
}

function assertPredecessor(
  position: unknown,
  recordSha256: unknown,
): asserts position is number | null {
  if (position === null || recordSha256 === null) {
    if (position !== null || recordSha256 !== null) {
      fail("Record envelope v4 predecessor position and digest must both be null or both be present");
    }
    return;
  }
  assertPositiveSafeInteger(position, "Record envelope v4 predecessor_position");
  assertDigest(recordSha256, "Record envelope v4 predecessor_record_sha256");
}

function assertSourceLocatorJoin(
  source: { readonly adapter_id: string; readonly instance_id: string; readonly external_id: string },
  provenance: MeetingSourceProvenanceV1,
  label: string,
): void {
  if (
    source.adapter_id !== provenance.source_adapter_id ||
    source.instance_id !== provenance.source_adapter_instance_id ||
    source.external_id !== provenance.external_id
  ) {
    fail(`${label} does not match source provenance`);
  }
}

type HumanActResolutionRefV4 =
  | HumanActResolutionRefV1
  | PrivateSlackBlockApprovalResolutionRefV1;
type HumanActEventV4 = HumanActEventV1 | PrivateSlackBlockApprovalEventV1;

interface ValidatedHumanActRecordInputV4 {
  readonly human_act_resolution_ref: HumanActResolutionRefV4;
  readonly event: HumanActEventV4;
  readonly semantic_idempotency_key: Sha256Digest;
}

function isPrivateSlackBlockResolutionRef(
  value: HumanActResolutionRefV4,
): value is PrivateSlackBlockApprovalResolutionRefV1 {
  return value.kind === PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND;
}

function validateHumanActRecordInputV4(
  value: unknown,
): ValidatedHumanActRecordInputV4 {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "private_slack_block_approval_resolution_ref")
  ) {
    const privateInput = validatePrivateSlackBlockApprovalRecordInputV1(value);
    return {
      human_act_resolution_ref:
        privateInput.private_slack_block_approval_resolution_ref,
      event: privateInput.event,
      semantic_idempotency_key: privateInput.semantic_idempotency_key,
    };
  }
  const legacy = validateHumanActRecordInputV1(value);
  return {
    human_act_resolution_ref: legacy.human_act_resolution_ref,
    event: legacy.event,
    semantic_idempotency_key: legacy.semantic_idempotency_key,
  };
}

function buildHumanActRecordInputV4(
  reference: HumanActResolutionRefV4,
  event: HumanActEventV4,
): ValidatedHumanActRecordInputV4 {
  if (isPrivateSlackBlockResolutionRef(reference)) {
    const privateInput = buildPrivateSlackBlockApprovalRecordInputV1({
      private_slack_block_approval_resolution_ref: reference,
      event: validatePrivateSlackBlockApprovalEventV1(event),
    });
    return {
      human_act_resolution_ref:
        privateInput.private_slack_block_approval_resolution_ref,
      event: privateInput.event,
      semantic_idempotency_key: privateInput.semantic_idempotency_key,
    };
  }
  const legacy = buildHumanActRecordInputV1({
    human_act_resolution_ref: reference,
    event: validateHumanActEventV1(event),
  });
  return {
    human_act_resolution_ref: legacy.human_act_resolution_ref,
    event: legacy.event,
    semantic_idempotency_key: legacy.semantic_idempotency_key,
  };
}

function assertEventProvenanceJoins(
  event: HumanActEventV4,
  source: MeetingSourceProvenanceV1,
  processor: DecisionProcessorProvenanceV1,
): void {
  if (event.kind === "approved") {
    const payload = event.approved_snapshot.approved_payload;
    assertSourceLocatorJoin(payload.source, source, "Approved record source");
    if (payload.brief.provenance.meeting_revision !== source.canonical_revision) {
      fail("Approved record meeting revision does not match source provenance");
    }
    const actual = payload.brief.provenance.processor;
    if (
      actual.kind !== processor.processor_adapter_kind ||
      actual.adapter_id !== processor.processor_adapter_id ||
      actual.instance_id !== processor.processor_adapter_instance_id ||
      actual.version !== processor.processor_adapter_version
    ) {
      fail("Approved record processor identity does not match processor provenance");
    }
    return;
  }
  if ("rejection_payload" in event) {
    assertSourceLocatorJoin(
      event.rejection_payload.source,
      source,
      "Rejected record source",
    );
  }
}

export function validateOrganizationRecordEnvelopeBodyV4(
  value: unknown,
): OrganizationRecordEnvelopeBodyV4 {
  const body = exactObject(value, RECORD_BODY_KEYS, "Record envelope body v4");
  if (
    body.schema_version !== 4 ||
    body.kind !== ORGANIZATION_RECORD_ENVELOPE_V4_KIND
  ) {
    fail("Record envelope body v4 has an unsupported envelope");
  }
  for (const key of [
    "envelope_id",
    "authority_id",
    "organization_id",
    "state_lineage_id",
  ] as const) {
    assertText(body[key], `Record envelope body v4 ${key}`);
  }
  assertDigest(
    body.semantic_idempotency_key,
    "Record envelope body v4 semantic_idempotency_key",
  );
  assertTimestamp(body.issued_at, "Record envelope body v4 issued_at");
  assertPredecessor(body.predecessor_position, body.predecessor_record_sha256);

  const reference =
    body.human_act_resolution_ref !== null &&
    typeof body.human_act_resolution_ref === "object" &&
    !Array.isArray(body.human_act_resolution_ref) &&
    (body.human_act_resolution_ref as Record<string, unknown>).kind ===
      PRIVATE_SLACK_BLOCK_APPROVAL_RESOLUTION_REF_V1_KIND
      ? validatePrivateSlackBlockApprovalResolutionRefV1(
          body.human_act_resolution_ref,
        )
      : validateHumanActResolutionRefV1(body.human_act_resolution_ref);
  const event = isPrivateSlackBlockResolutionRef(reference)
    ? validatePrivateSlackBlockApprovalEventV1(body.event)
    : validateHumanActEventV1(body.event);
  const source = validateMeetingSourceProvenanceV1(body.source_provenance);
  const processor = validateDecisionProcessorProvenanceV1(
    body.processor_provenance,
  );
  assertDigest(
    body.source_provenance_sha256,
    "Record envelope body v4 source_provenance_sha256",
  );
  assertDigest(
    body.processor_provenance_sha256,
    "Record envelope body v4 processor_provenance_sha256",
  );
  if (body.source_provenance_sha256 !== meetingSourceProvenanceV1Sha256(source)) {
    fail("Record envelope body v4 source provenance digest does not match its body");
  }
  if (
    body.processor_provenance_sha256 !==
    decisionProcessorProvenanceV1Sha256(processor)
  ) {
    fail("Record envelope body v4 processor provenance digest does not match its body");
  }

  const coordinates = {
    authority_id: body.authority_id as string,
    organization_id: body.organization_id as string,
    state_lineage_id: body.state_lineage_id as string,
  };
  assertCoordinates(reference, coordinates, "Human act reference");
  assertCoordinates(source, coordinates, "Source provenance");
  assertCoordinates(processor, coordinates, "Processor provenance");

  const aggregate = buildHumanActRecordInputV4(reference, event);
  if (body.semantic_idempotency_key !== aggregate.semantic_idempotency_key) {
    fail("Record envelope body v4 semantic idempotency key does not match the human act");
  }
  assertEventProvenanceJoins(event, source, processor);

  return {
    schema_version: 4,
    kind: ORGANIZATION_RECORD_ENVELOPE_V4_KIND,
    envelope_id: body.envelope_id as string,
    ...coordinates,
    semantic_idempotency_key: body.semantic_idempotency_key,
    issued_at: body.issued_at as string,
    predecessor_position: body.predecessor_position,
    predecessor_record_sha256: body.predecessor_record_sha256 as Sha256Digest | null,
    human_act_resolution_ref: aggregate.human_act_resolution_ref,
    source_provenance: source,
    source_provenance_sha256: body.source_provenance_sha256,
    processor_provenance: processor,
    processor_provenance_sha256: body.processor_provenance_sha256,
    event: aggregate.event,
  };
}

export function organizationRecordEnvelopeBodyV4Sha256(
  value: OrganizationRecordEnvelopeBodyV4,
): Sha256Digest {
  return canonicalSha256(validateOrganizationRecordEnvelopeBodyV4(value));
}

export function validateOrganizationRecordSignatureInputV4(
  value: unknown,
): OrganizationRecordSignatureInputV4 {
  const input = exactObject(
    value,
    SIGNATURE_INPUT_KEYS,
    "Record signature input v4",
  );
  if (
    input.schema_version !== 4 ||
    input.kind !== ORGANIZATION_RECORD_SIGNATURE_V4_KIND
  ) {
    fail("Record signature input v4 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
  ] as const) {
    assertText(input[key], `Record signature input v4 ${key}`);
  }
  assertDigest(input.signing_key_id, "Record signature input v4 signing_key_id");
  assertDigest(input.record_sha256, "Record signature input v4 record_sha256");
  return input as unknown as OrganizationRecordSignatureInputV4;
}

export function buildOrganizationRecordSignatureInputV4(
  body: OrganizationRecordEnvelopeBodyV4,
  signingKeyId: Sha256Digest,
): OrganizationRecordSignatureInputV4 {
  const validatedBody = validateOrganizationRecordEnvelopeBodyV4(body);
  assertDigest(signingKeyId, "Record signature input v4 signing_key_id");
  return validateOrganizationRecordSignatureInputV4({
    schema_version: 4,
    kind: ORGANIZATION_RECORD_SIGNATURE_V4_KIND,
    authority_id: validatedBody.authority_id,
    organization_id: validatedBody.organization_id,
    state_lineage_id: validatedBody.state_lineage_id,
    signing_key_id: signingKeyId,
    record_sha256: organizationRecordEnvelopeBodyV4Sha256(validatedBody),
  });
}

export function organizationRecordSignatureInputV4Bytes(
  value: OrganizationRecordSignatureInputV4,
): Buffer {
  return canonicalJsonBytes(validateOrganizationRecordSignatureInputV4(value));
}

function decodeSignature(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 96 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    fail("Record envelope v4 signature must be bounded canonical base64");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.toString("base64") !== value) {
    fail("Record envelope v4 signature must be bounded canonical base64");
  }
  try {
    assertP256LowS(signature);
  } catch (error) {
    fail("Record envelope v4 signature must be strict DER low-S P-256", error);
  }
  return signature;
}

export function validateOrganizationRecordEnvelopeV4(
  value: unknown,
): OrganizationRecordEnvelopeV4 {
  const wrapper = exactObject(value, RECORD_WRAPPER_KEYS, "Record envelope v4");
  const body = validateOrganizationRecordEnvelopeBodyV4(wrapper.body);
  assertDigest(wrapper.record_sha256, "Record envelope v4 record_sha256");
  if (wrapper.record_sha256 !== organizationRecordEnvelopeBodyV4Sha256(body)) {
    fail("Record envelope v4 record digest does not match its body");
  }
  const descriptor = validateP256SigningKey(
    wrapper.signing_key_descriptor,
    "Record envelope v4 signing key descriptor",
  );
  decodeSignature(wrapper.signature);
  return {
    body,
    record_sha256: wrapper.record_sha256,
    signing_key_descriptor: descriptor,
    signature: wrapper.signature as string,
  };
}

function assertPinnedEnvelope(
  envelope: OrganizationRecordEnvelopeV4,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
): Buffer {
  assertText(expectedStateLineageId, "expected state lineage ID");
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  if (
    envelope.body.authority_id !== authority.authority_id ||
    envelope.body.organization_id !== authority.organization_id ||
    envelope.body.state_lineage_id !== expectedStateLineageId
  ) {
    fail("Record envelope v4 does not match the pinned Authority and expected lineage");
  }
  const actual = envelope.signing_key_descriptor;
  const expected = authority.signing_key;
  if (
    actual.key_id !== expected.key_id ||
    actual.algorithm !== expected.algorithm ||
    actual.public_key_spki_der_base64 !== expected.public_key_spki_der_base64
  ) {
    fail("Record envelope v4 signing key does not match the pinned Authority");
  }
  return verifyP256SigningKeyDescriptor(expected, "organization Authority");
}

export function verifyOrganizationRecordEnvelopeV4(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
): OrganizationRecordEnvelopeV4 {
  const envelope = validateOrganizationRecordEnvelopeV4(value);
  const publicKey = assertPinnedEnvelope(
    envelope,
    pinnedAuthority,
    expectedStateLineageId,
  );
  const signatureInput = buildOrganizationRecordSignatureInputV4(
    envelope.body,
    envelope.signing_key_descriptor.key_id,
  );
  const signature = decodeSignature(envelope.signature);
  let valid = false;
  try {
    valid = verifyP256LowSSignature(
      publicKey,
      organizationRecordSignatureInputV4Bytes(signatureInput),
      signature,
    );
  } catch (error) {
    fail("Record envelope v4 signature is invalid", error);
  }
  if (!valid) fail("Record envelope v4 signature is invalid");
  return envelope;
}

export async function createOrganizationRecordEnvelopeV4(
  value: CreateOrganizationRecordEnvelopeV4Input,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
  sign: AuthorityDetachedSigner,
): Promise<OrganizationRecordEnvelopeV4> {
  const input = exactObject(value, CREATE_INPUT_KEYS, "Create record envelope v4 input");
  assertText(input.envelope_id, "Create record envelope v4 envelope_id");
  assertTimestamp(input.issued_at, "Create record envelope v4 issued_at");
  assertPredecessor(input.predecessor_position, input.predecessor_record_sha256);
  const aggregate = validateHumanActRecordInputV4(input.human_act_record_input);
  const source = validateMeetingSourceProvenanceV1(input.source_provenance);
  const processor = validateDecisionProcessorProvenanceV1(input.processor_provenance);
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  assertText(expectedStateLineageId, "expected state lineage ID");

  const body = validateOrganizationRecordEnvelopeBodyV4({
    schema_version: 4,
    kind: ORGANIZATION_RECORD_ENVELOPE_V4_KIND,
    envelope_id: input.envelope_id,
    authority_id: authority.authority_id,
    organization_id: authority.organization_id,
    state_lineage_id: expectedStateLineageId,
    semantic_idempotency_key: aggregate.semantic_idempotency_key,
    issued_at: input.issued_at,
    predecessor_position: input.predecessor_position,
    predecessor_record_sha256: input.predecessor_record_sha256,
    human_act_resolution_ref: aggregate.human_act_resolution_ref,
    source_provenance: source,
    source_provenance_sha256: meetingSourceProvenanceV1Sha256(source),
    processor_provenance: processor,
    processor_provenance_sha256: decisionProcessorProvenanceV1Sha256(processor),
    event: aggregate.event,
  });
  const recordSha256 = organizationRecordEnvelopeBodyV4Sha256(body);
  const signingKeyDescriptor = canonicalSnapshot(
    authority.signing_key,
    "Record envelope v4 signing key descriptor",
  );
  const signatureInput = buildOrganizationRecordSignatureInputV4(
    body,
    signingKeyDescriptor.key_id,
  );
  // Everything returned or signed is detached from caller-owned objects before
  // the first await, so an asynchronous signer cannot race input mutation.
  const bytesToSign = Buffer.from(
    organizationRecordSignatureInputV4Bytes(signatureInput),
  );
  const signerResult = await sign(
    Buffer.from(bytesToSign),
    signingKeyDescriptor.key_id,
  );
  if (!Buffer.isBuffer(signerResult)) {
    fail("Record envelope v4 signer must return signature bytes");
  }
  const signature = Buffer.from(signerResult);
  try {
    assertP256LowS(signature);
  } catch (error) {
    fail("Record envelope v4 signer returned a non-canonical signature", error);
  }
  return verifyOrganizationRecordEnvelopeV4(
    {
      body,
      record_sha256: recordSha256,
      signing_key_descriptor: signingKeyDescriptor,
      signature: signature.toString("base64"),
    },
    pinnedAuthority,
    expectedStateLineageId,
  );
}
