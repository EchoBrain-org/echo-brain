import {
  asRecord,
  assertExactKeys,
  assertId,
  assertTimestamp,
  fail,
} from "@echo-brain/organization-api/validation";

export const ORGANIZATION_API_SLACK_SETUP_PATH_V1 = '/v2/organization/tools/slack/setup';
export const ORGANIZATION_API_SLACK_APP_CREDENTIALS_PATH_V1 = '/v2/organization/tools/slack/app-credentials';
export const ORGANIZATION_API_SLACK_RECIPE_PATH_V1 = '/v2/organization/tools/slack/recipe';
export const ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1 = '/v2/organization/tools/slack/install/begin';
export const ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1 = '/v2/organization/tools/slack/install/status';
export const ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1 = '/v2/organization/tools/slack/install/cancel';

/** Owner only. The configuration token is used once in memory and never stored or echoed. */
export interface OrganizationSlackSetupRequestV1 {
  request_id: string;
  configuration_token: string;
}

/** Owner only. The fallback for an app created by hand from the recipe. */
export interface OrganizationSlackAppCredentialsRequestV1 {
  request_id: string;
  app_id: string;
  client_id: string;
  client_secret: string;
  signing_secret: string;
}

export interface OrganizationSlackSetupResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-setup-v1';
  app_id: string;
  organization_setup: 'app_created' | 'connected';
}

export interface OrganizationSlackRecipeResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-recipe-v1';
  manifest: Record<string, unknown>;
}

export interface OrganizationSlackInstallBeginRequestV1 {
  request_id: string;
  confirm_replacement: boolean;
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
  | 'confirmation_required'
  | 'approvals_outstanding';

export interface OrganizationSlackInstallResultV1 {
  kind: 'created' | 'reconnected' | 'replaced';
  workspace_id: string;
  person_links_revoked: number;
}

/** An install is committed only by an authenticated status read from the session that began it. */
export interface OrganizationSlackInstallStatusResponseV1 {
  schema_version: 1;
  kind: 'echo-organization-slack-install-status-v1';
  attempt_id: string;
  status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  failure_reason: OrganizationSlackInstallFailureReasonV1 | null;
  /** Waiting approval cards; set only with `approvals_outstanding`. */
  outstanding_approvals: number | null;
  result: OrganizationSlackInstallResultV1 | null;
}

const FAILURE_REASONS: readonly string[] = [
  'provider_rejected', 'provider_unavailable', 'permissions_missing',
  'workspace_mismatch', 'confirmation_required', 'approvals_outstanding',
];
const STATUSES: readonly string[] = ['pending', 'complete', 'cancelled', 'expired', 'failed'];
const RESULT_KINDS: readonly string[] = ['created', 'reconnected', 'replaced'];
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

function assertCount(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
}

export function validateOrganizationSlackSetupRequestV1(value: unknown): OrganizationSlackSetupRequestV1 {
  const label = 'Slack setup request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id', 'configuration_token'], label);
  assertId(record.request_id, 'oss', `${label} request_id`);
  assertVisibleAscii(record.configuration_token, 16, 512, `${label} configuration_token`);
  return record as unknown as OrganizationSlackSetupRequestV1;
}

export function validateOrganizationSlackAppCredentialsRequestV1(value: unknown): OrganizationSlackAppCredentialsRequestV1 {
  const label = 'Slack app credentials request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id', 'app_id', 'client_id', 'client_secret', 'signing_secret'], label);
  assertId(record.request_id, 'osc', `${label} request_id`);
  assertMatch(record.app_id, APP_ID, `${label} app_id`);
  assertMatch(record.client_id, CLIENT_ID, `${label} client_id`);
  assertVisibleAscii(record.client_secret, 8, 255, `${label} client_secret`);
  assertVisibleAscii(record.signing_secret, 8, 255, `${label} signing_secret`);
  return record as unknown as OrganizationSlackAppCredentialsRequestV1;
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

export function validateOrganizationSlackRecipeResponseV1(value: unknown): OrganizationSlackRecipeResponseV1 {
  const label = 'Slack recipe response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['schema_version', 'kind', 'manifest'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-organization-slack-recipe-v1') fail(`${label} version or kind is unsupported`);
  asRecord(record.manifest, `${label} manifest`);
  return record as unknown as OrganizationSlackRecipeResponseV1;
}

export function validateOrganizationSlackInstallBeginRequestV1(value: unknown): OrganizationSlackInstallBeginRequestV1 {
  const label = 'Slack install begin request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['request_id', 'confirm_replacement'], label);
  assertId(record.request_id, 'osi', `${label} request_id`);
  if (typeof record.confirm_replacement !== 'boolean') fail(`${label} confirm_replacement is invalid`);
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
  assertExactKeys(record, ['schema_version', 'kind', 'attempt_id', 'status', 'failure_reason', 'outstanding_approvals', 'result'], label);
  if (record.schema_version !== 1 || record.kind !== 'echo-organization-slack-install-status-v1') fail(`${label} version or kind is unsupported`);
  assertId(record.attempt_id, 'ssi', `${label} attempt_id`);
  if (!STATUSES.includes(record.status as string)) fail(`${label} status is invalid`);
  if (record.failure_reason !== null && !FAILURE_REASONS.includes(record.failure_reason as string)) fail(`${label} failure_reason is invalid`);
  if ((record.status === 'failed') !== (record.failure_reason !== null)) fail(`${label} failure_reason must be present only for failed attempts`);
  if (record.failure_reason === 'approvals_outstanding') assertCount(record.outstanding_approvals, `${label} outstanding_approvals`);
  else if (record.outstanding_approvals !== null) fail(`${label} outstanding_approvals must be present only for outstanding approvals`);
  if (record.status !== 'complete') {
    if (record.result !== null) fail(`${label} result must be present only for complete attempts`);
  } else {
    const result = asRecord(record.result, `${label} result`);
    assertExactKeys(result, ['kind', 'workspace_id', 'person_links_revoked'], `${label} result`);
    if (!RESULT_KINDS.includes(result.kind as string)) fail(`${label} result kind is invalid`);
    assertMatch(result.workspace_id, WORKSPACE_ID, `${label} result workspace_id`);
    assertCount(result.person_links_revoked, `${label} result person_links_revoked`);
  }
  return record as unknown as OrganizationSlackInstallStatusResponseV1;
}
