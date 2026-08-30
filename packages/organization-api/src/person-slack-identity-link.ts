import {
  canonicalJsonBytes,
  sha256Digest,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationPersonSlackIdentityLinkBeginRequestV2,
  OrganizationPersonSlackIdentityLinkBeginResponseV2,
  OrganizationPersonSlackIdentityLinkCompleteRequestV2,
  OrganizationPersonSlackIdentityLinkResultV2,
} from './contracts.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertPatternString,
  assertTimestamp,
  fail,
} from './validation.js';

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CANONICAL_32_BYTE_BASE64URL_PATTERN =
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function isCanonicalChallengeCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_32_BYTE_BASE64URL_PATTERN.test(value)
  );
}

/** Hashes the decoded 32-byte Person Slack identity-link challenge. */
export function organizationPersonSlackIdentityLinkChallengeCodeSha256(
  code: string,
): Sha256Digest {
  if (!isCanonicalChallengeCode(code)) {
    fail('Person Slack identity link challenge_code must be canonical unpadded base64url for exactly 32 bytes');
  }
  const output = new Uint8Array(32);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const character of code) {
    accumulator = (accumulator << 6) | BASE64URL_ALPHABET.indexOf(character);
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      output[outputIndex] = (accumulator >>> bitCount) & 0xff;
      outputIndex += 1;
    }
  }
  if (outputIndex !== output.byteLength) {
    output.fill(0);
    fail('Person Slack identity link challenge_code must be canonical unpadded base64url for exactly 32 bytes');
  }
  try {
    return sha256Digest(output as unknown as Parameters<typeof sha256Digest>[0]);
  } finally {
    output.fill(0);
  }
}

export function validateOrganizationPersonSlackIdentityLinkBeginRequest(
  value: unknown,
): OrganizationPersonSlackIdentityLinkBeginRequestV2 {
  const label = 'Person Slack identity link begin request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id', 'challenge_code_sha256'], label);
  assertId(record.request_id, 'psb', `${label} request_id`);
  assertDigest(record.challenge_code_sha256, `${label} challenge_code_sha256`);
  return record as unknown as OrganizationPersonSlackIdentityLinkBeginRequestV2;
}

export function validateOrganizationPersonSlackIdentityLinkCompleteRequest(
  value: unknown,
): OrganizationPersonSlackIdentityLinkCompleteRequestV2 {
  const label = 'Person Slack identity link complete request';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'request_id',
      'challenge_attempt_id',
      'challenge_message_ts',
      'challenge_code',
    ],
    label,
  );
  assertId(record.request_id, 'psc', `${label} request_id`);
  assertId(record.challenge_attempt_id, 'cat', `${label} challenge_attempt_id`);
  assertPatternString(
    record.challenge_message_ts,
    `${label} challenge_message_ts`,
    64,
    /^\d{1,16}\.\d{1,16}$/,
  );
  if (!isCanonicalChallengeCode(record.challenge_code)) {
    fail(`${label} challenge_code must be canonical unpadded base64url for exactly 32 bytes`);
  }
  return record as unknown as OrganizationPersonSlackIdentityLinkCompleteRequestV2;
}

export function validateOrganizationPersonSlackIdentityLinkBeginResponse(
  value: unknown,
): OrganizationPersonSlackIdentityLinkBeginResponseV2 {
  const label = 'Person Slack identity link begin response';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'challenge_attempt_id',
      'provider',
      'provider_tenant_id',
      'channel_id',
      'challenge_message_ts',
      'expires_at',
    ],
    label,
  );
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-begin-response' ||
    record.provider !== 'slack'
  ) {
    fail(`${label} version, kind, or provider is unsupported`);
  }
  assertId(record.challenge_attempt_id, 'cat', `${label} challenge_attempt_id`);
  assertPatternString(record.provider_tenant_id, `${label} provider_tenant_id`, 128, /^T[A-Z0-9]{2,}$/);
  assertPatternString(record.channel_id, `${label} channel_id`, 128, /^C[A-Z0-9]{2,}$/);
  assertPatternString(record.challenge_message_ts, `${label} challenge_message_ts`, 64, /^\d{1,16}\.\d{1,16}$/);
  assertTimestamp(record.expires_at, `${label} expires_at`);
  return record as unknown as OrganizationPersonSlackIdentityLinkBeginResponseV2;
}

export function validateOrganizationPersonSlackIdentityLinkResult(
  value: unknown,
): OrganizationPersonSlackIdentityLinkResultV2 {
  const label = 'Person Slack identity link result';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'schema_version',
      'kind',
      'identity_link_id',
      'connection_id',
      'organization_id',
      'principal_id',
      'membership_id',
      'provider',
      'provider_tenant_id',
      'provider_subject_id',
      'channel_id',
      'linked_at',
      'identity_link_created',
    ],
    label,
  );
  if (
    record.schema_version !== 2 ||
    record.kind !== 'echo-organization-person-slack-link-result' ||
    record.provider !== 'slack'
  ) {
    fail(`${label} version, kind, or provider is unsupported`);
  }
  assertId(record.identity_link_id, 'clm', `${label} identity_link_id`);
  assertId(record.connection_id, 'con', `${label} connection_id`);
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.principal_id, 'prn', `${label} principal_id`);
  assertId(record.membership_id, 'mem', `${label} membership_id`);
  assertPatternString(record.provider_tenant_id, `${label} provider_tenant_id`, 128, /^T[A-Z0-9]{2,}$/);
  assertPatternString(record.provider_subject_id, `${label} provider_subject_id`, 128, /^[UW][A-Z0-9]{2,}$/);
  assertPatternString(record.channel_id, `${label} channel_id`, 128, /^C[A-Z0-9]{2,}$/);
  assertTimestamp(record.linked_at, `${label} linked_at`);
  if (typeof record.identity_link_created !== 'boolean') {
    fail(`${label} identity_link_created must be a boolean`);
  }
  return record as unknown as OrganizationPersonSlackIdentityLinkResultV2;
}

export function canonicalOrganizationPersonSlackIdentityLinkBeginRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonSlackIdentityLinkBeginRequest(value),
  );
}

export function canonicalOrganizationPersonSlackIdentityLinkCompleteRequestBytes(
  value: unknown,
): Uint8Array {
  return canonicalJsonBytes(
    validateOrganizationPersonSlackIdentityLinkCompleteRequest(value),
  );
}
