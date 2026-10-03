import {
  asRecord,
  asEnumerableRecord,
  assertExactKeys,
  assertId,
  assertTimestamp,
  fail,
} from "@echo-brain/organization-api/validation";

export const ORGANIZATION_API_SLACK_SETUP_PATH_V1 = '/v2/organization/tools/slack/setup';
export const ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1 = '/v2/organization/tools/slack/install/begin';
export const ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1 = '/v2/organization/tools/slack/install/status';
export const ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1 = '/v2/organization/tools/slack/install/cancel';

/** Credentials supplied for the explicitly selected Slack app, never echoed. */
export interface OrganizationSlackExistingAppV1 {
  readonly app_id: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly signing_secret: string;
}

/** Owner only. The configuration token is used once in memory and never stored or echoed. */
export interface OrganizationSlackSetupRequestV1 {
  request_id: string;
  configuration_token: string;
  existing_app?: OrganizationSlackExistingAppV1;
}

export interface OrganizationSlackSetupResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-setup-v1';
  app_id: string;
  organization_setup: 'app_created' | 'connected';
}

export interface OrganizationSlackInstallBeginRequestV1 {
  request_id: string;
}

export interface OrganizationSlackInstallBeginResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-install-v1';
  attempt_id: string;
  connect_link: string;
  expires_at: string;
}

export interface OrganizationSlackInstallAttemptRequestV1 {
  attempt_id: string;
}

export type OrganizationSlackInstallFailureReasonV1 =
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'permissions_missing'
  | 'workspace_mismatch'
  | 'already_connected';

export interface OrganizationSlackInstallResultV1 {
  kind: 'created' | 'reconnected';
  workspace_id: string;
}

/** An install is committed only by an authenticated status read from the session that began it. */
export interface OrganizationSlackInstallStatusResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-install-status-v1';
  attempt_id: string;
  status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  failure_reason: OrganizationSlackInstallFailureReasonV1 | null;
  result: OrganizationSlackInstallResultV1 | null;
}

const FAILURE_REASONS: readonly string[] = [
  'provider_rejected', 'provider_unavailable', 'permissions_missing', 'workspace_mismatch', 'already_connected',
];
const STATUSES: readonly string[] = ['pending', 'complete', 'cancelled', 'expired', 'failed'];
const RESULT_KINDS: readonly string[] = ['created', 'reconnected'];
// Bounded, visible, printable ASCII: no whitespace and no control bytes.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const APP_ID = /^A[A-Z0-9]{2,63}$/;
const CLIENT_ID = /^[0-9]{1,32}\.[0-9]{1,32}$/;
const WORKSPACE_ID = /^T[A-Z0-9]{2,}$/;
const HTTPS_LINK = /^https:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:[/?#]|$)/;

/** Never puts the candidate value in the message: these fields carry secrets. */
function assertVisibleAscii(value: unknown, minimum: number, maximum: number, label: string): void {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || !VISIBLE_ASCII.test(value)) {
    fail(`${label} is invalid`);
  }
}

function assertMatch(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) fail(`${label} is invalid`);
}

export function validateOrganizationSlackSetupRequestV1(value: unknown): OrganizationSlackSetupRequestV1 {
  const label = 'Slack setup request';
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ['request_id', 'configuration_token', ...(Object.hasOwn(record, 'existing_app') ? ['existing_app'] : [])], label);
  assertId(record.request_id, 'oss', `${label} request_id`);
  assertVisibleAscii(record.configuration_token, 16, 512, `${label} configuration_token`);
  if (Object.hasOwn(record, 'existing_app')) {
    return { request_id: record.request_id as string, configuration_token: record.configuration_token as string,
      existing_app: validateOrganizationSlackExistingAppV1(record.existing_app) };
  }
  return record as unknown as OrganizationSlackSetupRequestV1;
}

export function validateOrganizationSlackExistingAppV1(value: unknown): OrganizationSlackExistingAppV1 {
  const label = 'Slack existing app';
  const record = asEnumerableRecord(value, label);
  assertExactKeys(record, ['app_id', 'client_id', 'client_secret', 'signing_secret'], label);
  assertMatch(record.app_id, APP_ID, `${label} app_id`);
  assertMatch(record.client_id, CLIENT_ID, `${label} client_id`);
  assertVisibleAscii(record.client_secret, 8, 255, `${label} client_secret`);
  assertVisibleAscii(record.signing_secret, 8, 255, `${label} signing_secret`);
  return Object.freeze({ app_id: record.app_id as string, client_id: record.client_id as string,
    client_secret: record.client_secret as string, signing_secret: record.signing_secret as string });
}

export function validateOrganizationSlackSetupResponseV1(value: unknown): OrganizationSlackSetupResponseV1 {
  const label = 'Slack setup response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'app_id', 'organization_setup'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-organization-slack-setup-v1') fail(`${label} version or kind is unsupported`);
  assertMatch(record.app_id, APP_ID, `${label} app_id`);
  if (record.organization_setup !== 'app_created' && record.organization_setup !== 'connected') fail(`${label} organization_setup is invalid`);
  return record as unknown as OrganizationSlackSetupResponseV1;
}

export function validateOrganizationSlackInstallBeginRequestV1(value: unknown): OrganizationSlackInstallBeginRequestV1 {
  const label = 'Slack install begin request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id'], label);
  assertId(record.request_id, 'osi', `${label} request_id`);
  return record as unknown as OrganizationSlackInstallBeginRequestV1;
}

/** Only https is checked here; a client may also hold the link's origin to an allowlist. */
export function validateOrganizationSlackInstallBeginResponseV1(value: unknown): OrganizationSlackInstallBeginResponseV1 {
  const label = 'Slack install begin response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'attempt_id', 'connect_link', 'expires_at'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-organization-slack-install-v1') fail(`${label} version or kind is unsupported`);
  assertId(record.attempt_id, 'ssi', `${label} attempt_id`);
  if (typeof record.connect_link !== 'string' || record.connect_link.length > 4096 || !HTTPS_LINK.test(record.connect_link)) {
    fail(`${label} connect_link is invalid`);
  }
  assertTimestamp(record.expires_at, `${label} expires_at`);
  return record as unknown as OrganizationSlackInstallBeginResponseV1;
}

export function validateOrganizationSlackInstallAttemptRequestV1(value: unknown): OrganizationSlackInstallAttemptRequestV1 {
  const label = 'Slack install attempt request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['attempt_id'], label);
  assertId(record.attempt_id, 'ssi', `${label} attempt_id`);
  return record as unknown as OrganizationSlackInstallAttemptRequestV1;
}

export function validateOrganizationSlackInstallStatusResponseV1(value: unknown): OrganizationSlackInstallStatusResponseV1 {
  const label = 'Slack install status response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'attempt_id', 'status', 'failure_reason', 'result'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-organization-slack-install-status-v1') fail(`${label} version or kind is unsupported`);
  assertId(record.attempt_id, 'ssi', `${label} attempt_id`);
  if (!STATUSES.includes(record.status as string)) fail(`${label} status is invalid`);
  if (record.failure_reason !== null && !FAILURE_REASONS.includes(record.failure_reason as string)) fail(`${label} failure_reason is invalid`);
  if ((record.status === 'failed') !== (record.failure_reason !== null)) fail(`${label} failure_reason must be present only for failed attempts`);
  if (record.status !== 'complete') {
    if (record.result !== null) fail(`${label} result must be present only for complete attempts`);
  } else {
    const result = asRecord(record.result, `${label} result`);
    assertExactKeys(result, ['kind', 'workspace_id'], `${label} result`);
    if (!RESULT_KINDS.includes(result.kind as string)) fail(`${label} result kind is invalid`);
    assertMatch(result.workspace_id, WORKSPACE_ID, `${label} result workspace_id`);
  }
  return record as unknown as OrganizationSlackInstallStatusResponseV1;
}
