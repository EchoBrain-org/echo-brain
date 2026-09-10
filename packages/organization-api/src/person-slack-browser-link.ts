import type {
  OrganizationPersonSlackBrowserLinkAttemptRequestV1,
  OrganizationPersonSlackBrowserLinkBeginRequestV1,
  OrganizationPersonSlackBrowserLinkBeginResponseV1,
  OrganizationPersonSlackBrowserLinkStatusResponseV1,
} from './contracts.js';
import {
  asRecord,
  assertExactKeys,
  assertId,
  assertTimestamp,
  fail,
} from './validation.js';

const FAILURE_REASONS = new Set([
  'provider_rejected',
  'provider_unavailable',
  'identity_conflict',
  'tool_unavailable',
]);

function attemptRequest(
  value: unknown,
  label: string,
): OrganizationPersonSlackBrowserLinkAttemptRequestV1 {
  const record = asRecord(value, label);
  assertExactKeys(record, ['attempt_id'], label);
  assertId(record.attempt_id, 'sbl', `${label} attempt_id`);
  return record as unknown as OrganizationPersonSlackBrowserLinkAttemptRequestV1;
}

export function validateOrganizationPersonSlackBrowserLinkBeginRequest(
  value: unknown,
): OrganizationPersonSlackBrowserLinkBeginRequestV1 {
  const label = 'Person Slack browser link begin request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id'], label);
  assertId(record.request_id, 'psb', `${label} request_id`);
  return record as unknown as OrganizationPersonSlackBrowserLinkBeginRequestV1;
}

export function validateOrganizationPersonSlackBrowserLinkAttemptRequest(
  value: unknown,
): OrganizationPersonSlackBrowserLinkAttemptRequestV1 {
  return attemptRequest(value, 'Person Slack browser link attempt request');
}

export function validateOrganizationPersonSlackBrowserLinkBeginResponse(
  value: unknown,
): OrganizationPersonSlackBrowserLinkBeginResponseV1 {
  const label = 'Person Slack browser link begin response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'attempt_id', 'authorization_url', 'expires_at'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-person-slack-browser-link-v1') {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.attempt_id, 'sbl', `${label} attempt_id`);
  if (typeof record.authorization_url !== 'string' || record.authorization_url.length > 4096) {
    fail(`${label} authorization_url is invalid`);
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:[/?#]|$)/.test(record.authorization_url)) {
    fail(`${label} authorization_url is invalid`);
  }
  assertTimestamp(record.expires_at, `${label} expires_at`);
  return record as unknown as OrganizationPersonSlackBrowserLinkBeginResponseV1;
}

export function validateOrganizationPersonSlackBrowserLinkStatusResponse(
  value: unknown,
): OrganizationPersonSlackBrowserLinkStatusResponseV1 {
  const label = 'Person Slack browser link status response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'attempt_id', 'status', 'failure_reason'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-person-slack-browser-link-status-v1') {
    fail(`${label} version or kind is unsupported`);
  }
  assertId(record.attempt_id, 'sbl', `${label} attempt_id`);
  if (!['pending', 'complete', 'cancelled', 'expired', 'failed'].includes(record.status as string)) {
    fail(`${label} status is invalid`);
  }
  if (record.failure_reason !== null &&
    (typeof record.failure_reason !== 'string' || !FAILURE_REASONS.has(record.failure_reason))) {
    fail(`${label} failure_reason is invalid`);
  }
  if ((record.status === 'failed') !== (record.failure_reason !== null)) {
    fail(`${label} failure_reason must be present only for failed attempts`);
  }
  return record as unknown as OrganizationPersonSlackBrowserLinkStatusResponseV1;
}
