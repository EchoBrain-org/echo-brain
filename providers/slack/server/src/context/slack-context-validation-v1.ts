import { AuthorityOperationError, type AuthorityErrorCode } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';

export const SLACK_CONTEXT_TEAM_V1 = /^T[A-Z0-9]{2,63}$/;
export const SLACK_CONTEXT_CHANNEL_V1 = /^[CG][A-Z0-9]{2,63}$/;
export const SLACK_CONTEXT_USER_V1 = /^[UW][A-Z0-9]{2,63}$/;
export const SLACK_CONTEXT_BOT_V1 = /^B[A-Z0-9]{2,63}$/;
export const SLACK_CONTEXT_TS_V1 = /^[1-9][0-9]{0,11}\.[0-9]{6}$/;
export const SLACK_CONTEXT_MAX_PAGE_V1 = 15;
export const SLACK_CONTEXT_MAX_CURSOR_BYTES_V1 = 4096;

export function slackContextFailureV1(code: AuthorityErrorCode): never {
  throw new AuthorityOperationError(code, 'Slack context capture could not be completed');
}

/** Provider objects can add fields, but cannot supply executable properties. */
export function slackContextRecordV1(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d) || !d.enumerable)) slackContextFailureV1('invalid_output');
  return value as Record<string, unknown>;
}

export function slackContextArrayV1(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1) slackContextFailureV1('invalid_output');
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) slackContextFailureV1('invalid_output');
  }
  return value;
}

export function slackContextStringV1(value: unknown, maximum = 256, pattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum ||
      value !== value.normalize('NFC') || !pattern.test(value)) slackContextFailureV1('invalid_output');
  return value;
}

export function copySlackContextBindingV1(value: PersonConnectorReadBindingV1): PersonConnectorReadBindingV1 {
  slackContextRecordV1(value);
  for (const key of ['organization_id', 'principal_id', 'membership_id'] as const) slackContextStringV1(value[key]);
  if (value.tool_id !== 'slack' || typeof value.external_scope_id !== 'string' || !SLACK_CONTEXT_TEAM_V1.test(value.external_scope_id) ||
      !SLACK_CONTEXT_USER_V1.test(value.external_subject_id) || !/^sha256:[0-9a-f]{64}$/.test(value.read_grant_sha256)) slackContextFailureV1('unauthorized');
  return Object.freeze({ organization_id: value.organization_id, principal_id: value.principal_id, membership_id: value.membership_id,
    tool_id: 'slack', external_scope_id: value.external_scope_id, external_subject_id: value.external_subject_id, read_grant_sha256: value.read_grant_sha256 });
}

export function requireSlackContextResponseV1(value: unknown): Record<string, unknown> {
  const body = slackContextRecordV1(value);
  if (body.ok === true) return body;
  if (body.ok !== false || typeof body.error !== 'string') slackContextFailureV1('invalid_output');
  if (['not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission', 'missing_scope', 'not_allowed_token_type', 'not_in_channel', 'access_denied', 'team_access_not_granted'].includes(body.error)) slackContextFailureV1('unauthorized');
  if (['ratelimited', 'rate_limited'].includes(body.error)) slackContextFailureV1('rate_limited');
  if (['channel_not_found', 'message_not_found'].includes(body.error)) slackContextFailureV1('not_found');
  if (body.error === 'invalid_cursor') slackContextFailureV1('invalid_request');
  slackContextFailureV1('unavailable');
}

/** Slack timestamps are exact decimal coordinates, never floating point IDs. */
export function slackContextTimestampMicrosV1(value: unknown): bigint {
  const stamp = slackContextStringV1(value, 19, SLACK_CONTEXT_TS_V1);
  const [seconds, micros] = stamp.split('.');
  return BigInt(seconds!) * 1_000_000n + BigInt(micros!);
}

export function slackContextTimestampIsoV1(value: unknown): string {
  const millis = Number(slackContextTimestampMicrosV1(value) / 1000n);
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) slackContextFailureV1('invalid_output');
  return date.toISOString();
}

/** Workspace origin comes from authenticated auth.test, never message text or a model. */
export function slackContextWorkspaceOriginV1(value: unknown): string {
  const raw = slackContextStringV1(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { slackContextFailureV1('invalid_output'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com$/.test(url.hostname) ||
      url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      raw !== `${url.origin}/`) slackContextFailureV1('invalid_output');
  return url.origin;
}
