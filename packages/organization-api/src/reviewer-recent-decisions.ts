import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  MAX_REVIEWER_ITEM_TEXT_SCALARS,
  RESTRICTED_REVIEWER_POLICY_ID,
  assertReviewerPresentableText,
  isOrganizationProtocolValidationError,
  type CanonicalPayloadSigner,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationReviewerRecentDecisionItemV1,
  OrganizationReviewerRecentDecisionsRequestPayloadV1,
  OrganizationReviewerRecentDecisionsRequestV1,
  OrganizationReviewerRecentDecisionsResponseV1,
} from './contracts.js';
import { ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH } from './http.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertOnlyEnumerableDataProperties,
  assertTimestamp,
  fail,
  validateIntegrity,
} from './validation.js';

export const MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS = 10;
export const MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_REQUEST_BYTES =
  16 * 1024;
export const MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES =
  60 * 1024;

/** The one deterministic witness, using only caller-knowable reviewer facts. */
export const ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS =
  'Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active.';

export function validateOrganizationReviewerRecentDecisionsRequest(
  value: unknown,
): OrganizationReviewerRecentDecisionsRequestV1 {
  const label = 'reviewer recent decisions request';
  assertOnlyEnumerableDataProperties(value, label);
  let canonical: Uint8Array;
  let snapshot: unknown;
  try {
    canonical = canonicalJsonBytes(value);
    if (
      canonical.byteLength >
      MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_REQUEST_BYTES
    ) {
      fail(`${label} exceeds its canonical byte bound`);
    }
    snapshot = JSON.parse(canonicalJson(value)) as unknown;
  } catch (error) {
    if (isOrganizationProtocolValidationError(error)) throw error;
    fail(`${label} is not canonicalizable`);
  }
  const record = asRecord(snapshot, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'request_id',
      'authority_id',
      'authority_key_id',
      'organization_id',
      'enrollment_id',
      'installation_id',
      'installation_key_id',
      'http_method',
      'http_path',
      'requested_at',
      'integrity',
    ],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-reviewer-recent-decisions-request'
  ) {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.request_id, 'rrd', `${label} request_id`);
  assertId(record.authority_id, 'oau', `${label} authority_id`);
  assertDigest(record.authority_key_id, `${label} authority_key_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.enrollment_id, 'enr', `${label} enrollment_id`);
  assertId(record.installation_id, 'ins', `${label} installation_id`);
  assertDigest(record.installation_key_id, `${label} installation_key_id`);
  if (
    record.http_method !== 'POST' ||
    record.http_path !== ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH
  ) {
    fail(`${label} HTTP operation is unsupported`);
  }
  assertTimestamp(record.requested_at, `${label} requested_at`);
  const integrity = validateIntegrity(record.integrity, label);
  if (integrity.key_id !== record.installation_key_id) {
    fail(`${label} signature key does not match installation key`);
  }
  return {
    ...record,
    integrity,
  } as unknown as OrganizationReviewerRecentDecisionsRequestV1;
}

export function verifyOrganizationReviewerRecentDecisionsRequest(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationReviewerRecentDecisionsRequestV1 {
  const request = validateOrganizationReviewerRecentDecisionsRequest(value);
  const publicKey = verifyP256SigningKeyDescriptor(installationSigningKey);
  if (
    request.installation_key_id !== installationSigningKey.key_id ||
    request.integrity.key_id !== installationSigningKey.key_id
  ) {
    throw new Error(
      'organization API: reviewer recent decisions request does not match the installation key',
    );
  }
  verifySignedDocument(request, publicKey, installationSigningKey.key_id);
  return request;
}

export function organizationReviewerRecentDecisionsRequestSha256(
  value: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationReviewerRecentDecisionsRequest(
      value,
      installationSigningKey,
    ),
  );
}

export interface CreateOrganizationReviewerRecentDecisionsRequestInput {
  request_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  requested_at: string;
}

export async function createOrganizationReviewerRecentDecisionsRequest(
  input: CreateOrganizationReviewerRecentDecisionsRequestInput,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationReviewerRecentDecisionsRequestV1> {
  verifyP256SigningKeyDescriptor(input.installation_signing_key);
  const payload: OrganizationReviewerRecentDecisionsRequestPayloadV1 = {
    schema_version: 1,
    kind: 'echo-organization-reviewer-recent-decisions-request',
    request_id: input.request_id,
    authority_id: input.authority_id,
    authority_key_id: input.authority_key_id,
    organization_id: input.organization_id,
    enrollment_id: input.enrollment_id,
    installation_id: input.installation_id,
    installation_key_id: input.installation_signing_key.key_id,
    http_method: 'POST',
    http_path: ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH,
    requested_at: input.requested_at,
  };
  const document = await createSignedDocumentWithKey(
    payload,
    input.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationReviewerRecentDecisionsRequest(
    document,
    input.installation_signing_key,
  );
}

function validateReviewerItem(
  value: unknown,
  index: number,
): OrganizationReviewerRecentDecisionItemV1 {
  const label = `reviewer recent decisions response items[${index}]`;
  const record = asRecord(value, label);
  assertExactKeys(record, ['kind', 'text'], label);
  if (
    record.kind !== 'decision' &&
    record.kind !== 'action' &&
    record.kind !== 'rationale'
  ) {
    fail(`${label} kind is unsupported`);
  }
  try {
    assertReviewerPresentableText(
      record.text,
      `${label} text`,
      MAX_REVIEWER_ITEM_TEXT_SCALARS,
    );
  } catch (error) {
    if (isOrganizationProtocolValidationError(error)) {
      fail(`${label} text is invalid`, error);
    }
    throw error;
  }
  return record as unknown as OrganizationReviewerRecentDecisionItemV1;
}

/**
 * The closed reviewer response. Only `schema_version`, `items`, `policy_id`,
 * and `witness` exist; equal kind/text pairs from distinct facts are allowed,
 * and there is no total, hidden count, cursor, or scan depth to leak.
 */
export function validateOrganizationReviewerRecentDecisionsResponse(
  value: unknown,
): OrganizationReviewerRecentDecisionsResponseV1 {
  const label = 'reviewer recent decisions response';
  assertOnlyEnumerableDataProperties(value, label);
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    ['schema_version', 'items', 'policy_id', 'witness'],
    label,
  );
  if (
    record.schema_version !== 1 ||
    record.policy_id !== RESTRICTED_REVIEWER_POLICY_ID ||
    record.witness !== ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS
  ) {
    fail(`${label} version, policy, or witness is unsupported`);
  }
  if (!Array.isArray(record.items)) {
    fail(`${label} items must be an array`);
  }
  if (record.items.length > MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS) {
    fail(`${label} exceeds the maximum item count`);
  }
  if (
    Object.getOwnPropertySymbols(record.items).length !== 0 ||
    Object.keys(record.items).length !== record.items.length
  ) {
    fail(`${label} items must be a dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.items);
  const items: OrganizationReviewerRecentDecisionItemV1[] = [];
  for (let index = 0; index < record.items.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${label} items must be a dense array`);
    }
    items.push(validateReviewerItem(descriptor.value, index));
  }
  const result: OrganizationReviewerRecentDecisionsResponseV1 = {
    schema_version: 1,
    items,
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  };
  let canonicalBytes: number;
  try {
    canonicalBytes = canonicalJsonBytes(result).byteLength;
  } catch (error) {
    fail(`${label} is not canonicalizable`, error);
  }
  if (
    canonicalBytes > MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES
  ) {
    fail(`${label} exceeds its canonical byte limit`);
  }
  return result;
}
