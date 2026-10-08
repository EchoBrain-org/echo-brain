import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { isApprovalOwnerTextV1, isApprovalSignalIdV1 } from '@echo-brain/organization-protocol';
import { slackApprovalActionIdV4, slackApprovalOwnerActionIdV4 } from './slack-approval-card-v4.js';

/** The largest Slack interactivity request this pure boundary will retain. */
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES = 64 * 1024;
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS = 5 * 60;
export type PrivateSlackApprovalInteractionRejectionStageV1 = 'unclassified' | 'form' | 'envelope' | 'lookup' | 'action' | 'card' | 'state';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const USER = /^[UW][A-Z0-9]{2,255}$/;
const TEAM = /^T[A-Z0-9]{2,255}$/;
const APP = /^A[A-Z0-9]{2,255}$/;
const BOT = /^B[A-Z0-9]{2,255}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,255}$/;
const TS = /^[0-9]{1,16}\.[0-9]{1,9}$/;
const TRIGGER = /^[A-Za-z0-9._-]{16,512}$/;
const PROJECT = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type RecordValue = Record<string, unknown>;
interface VerifiedEvidence { readonly body: Uint8Array; readonly request_timestamp: string; readonly signature_sha256: `sha256:${string}`; readonly raw_body_sha256: `sha256:${string}`; }
const evidence = new WeakMap<VerifiedPrivateSlackApprovalRequestV1, VerifiedEvidence>();

export class VerifiedPrivateSlackApprovalRequestV1 { private constructor() {} static create() { return Object.freeze(new VerifiedPrivateSlackApprovalRequestV1()); } }
export class PrivateSlackApprovalInteractionError extends Error {
  constructor(readonly rejection_stage: PrivateSlackApprovalInteractionRejectionStageV1 = 'unclassified') { super('private approval Slack interaction is invalid'); this.name = 'PrivateSlackApprovalInteractionError'; }
}
export interface VerifyPrivateSlackApprovalRequestInputV1 { readonly raw_body: Uint8Array; readonly signing_secret: string; readonly headers: { readonly 'x-slack-request-timestamp': string | undefined; readonly 'x-slack-signature': string | undefined }; readonly now_unix_seconds?: number; }
export interface PrivateSlackApprovalLookupHintsV1 { readonly api_app_id: string; readonly workspace_id: string; readonly slack_user_id: string; readonly channel_id: string; readonly message_ts: string; readonly message_user_id: string; readonly message_app_id: string; readonly message_bot_id: string; }
export interface VerifiedSlackApprovalClickV1 { readonly schema_version: 4; readonly disposition: 'resolution'; readonly action: 'approve' | 'reject'; readonly approval_id: string; readonly snapshot_sha256: `sha256:${string}`; readonly audience: 'only-me' | 'projects'; readonly project_ids: readonly string[]; readonly share_transcript: boolean; readonly owners: readonly { readonly signal_id: string; readonly owner: string }[]; readonly provider_action_key_sha256: `sha256:${string}`; readonly lookup: PrivateSlackApprovalLookupHintsV1; }
export interface PrivateSlackApprovalPresentationChangeV1 { readonly schema_version: 4; readonly disposition: 'presentation_change'; readonly lookup: PrivateSlackApprovalLookupHintsV1; }
export type PrivateSlackApprovalInteractionV1 = VerifiedSlackApprovalClickV1 | PrivateSlackApprovalPresentationChangeV1;
function invalid(stage: PrivateSlackApprovalInteractionRejectionStageV1 = 'unclassified'): never { throw new PrivateSlackApprovalInteractionError(stage); }
function record(value: unknown, stage: PrivateSlackApprovalInteractionRejectionStageV1): RecordValue { if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(stage); return value as RecordValue; }
function exact(value: unknown, required: readonly string[], allowed: readonly string[], stage: PrivateSlackApprovalInteractionRejectionStageV1): RecordValue { const found = record(value, stage), keys = Object.keys(found); if (required.some(key => !Object.hasOwn(found, key)) || keys.some(key => !allowed.includes(key))) invalid(stage); return found; }
function string(value: unknown, pattern: RegExp, stage: PrivateSlackApprovalInteractionRejectionStageV1, maximum = 256): string { if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) invalid(stage); return value; }
function form(body: Uint8Array): unknown { let source: string; try { source = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return invalid('form'); } const fields = [...new URLSearchParams(source).entries()]; if (fields.length !== 1 || fields[0]?.[0] !== 'payload') invalid('form'); try { return JSON.parse(fields[0]![1]) as unknown; } catch { return invalid('form'); } }

/** Verifies Slack's v0 HMAC over original bytes before a parser can see the payload. */
export function verifyPrivateSlackApprovalRequestV1(input: VerifyPrivateSlackApprovalRequestInputV1): VerifiedPrivateSlackApprovalRequestV1 {
  if (!(input.raw_body instanceof Uint8Array) || input.raw_body.byteLength > PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES || typeof input.signing_secret !== 'string' || input.signing_secret.length === 0) invalid();
  const timestamp = input.headers['x-slack-request-timestamp']; const signature = input.headers['x-slack-signature'];
  if (typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp) || typeof signature !== 'string' || !/^v0=[0-9a-f]{64}$/.test(signature)) invalid();
  const current = input.now_unix_seconds ?? Math.floor(Date.now() / 1000), seconds = Number(timestamp);
  if (!Number.isSafeInteger(current) || Math.abs(current - seconds) > PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS) invalid();
  const expected = createHmac('sha256', input.signing_secret).update(`v0:${timestamp}:`).update(input.raw_body).digest('hex');
  if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(signature.slice(3)))) invalid();
  const verified = VerifiedPrivateSlackApprovalRequestV1.create();
  evidence.set(verified, Object.freeze({ body: Uint8Array.from(input.raw_body), request_timestamp: timestamp, signature_sha256: sha256Digest(signature), raw_body_sha256: sha256Digest(input.raw_body) }));
  return verified;
}
function lookup(payload: RecordValue): PrivateSlackApprovalLookupHintsV1 {
  const user = exact(payload.user, ['id'], ['id', 'team_id'], 'lookup'), team = exact(payload.team, ['id'], ['id', 'domain'], 'lookup'), channel = exact(payload.channel, ['id'], ['id', 'name'], 'lookup');
  const container = exact(payload.container, ['type', 'channel_id', 'message_ts'], ['type', 'channel_id', 'message_ts', 'is_ephemeral'], 'lookup');
  const message = exact(payload.message, ['type', 'user', 'ts', 'app_id', 'bot_id'], ['type', 'user', 'ts', 'app_id', 'bot_id', 'blocks'], 'lookup');
  const workspace_id = string(team.id, TEAM, 'lookup'), channel_id = string(channel.id, CHANNEL, 'lookup'), message_ts = string(message.ts, TS, 'lookup', 32);
  if (payload.type !== 'block_actions' || container.type !== 'message' || message.type !== 'message' || string(user.id, USER, 'lookup') !== string(user.id, USER, 'lookup') || string(container.channel_id, CHANNEL, 'lookup') !== channel_id || string(container.message_ts, TS, 'lookup', 32) !== message_ts || (user.team_id !== undefined && string(user.team_id, TEAM, 'lookup') !== workspace_id)) invalid('lookup');
  return Object.freeze({ api_app_id: string(payload.api_app_id, APP, 'lookup'), workspace_id, slack_user_id: string(user.id, USER, 'lookup'), channel_id, message_ts, message_user_id: string(message.user, USER, 'lookup'), message_app_id: string(message.app_id, APP, 'lookup'), message_bot_id: string(message.bot_id, BOT, 'lookup') });
}
function value(action: RecordValue): { readonly approval_id: string; readonly snapshot_sha256: `sha256:${string}` } { if (typeof action.value !== 'string' || action.value.length > 1024) invalid('card'); let parsed: unknown; try { parsed = JSON.parse(action.value); } catch { return invalid('card'); } const button = exact(parsed, ['schema_version', 'approval_id', 'snapshot_sha256'], ['schema_version', 'approval_id', 'snapshot_sha256'], 'card'); if (button.schema_version !== 2) invalid('card'); const snapshot = string(button.snapshot_sha256, DIGEST, 'card', 80); return Object.freeze({ approval_id: string(button.approval_id, IDENTIFIER, 'card'), snapshot_sha256: snapshot as `sha256:${string}` }); }
function state(payload: RecordValue, approval_id: string, action: 'approve' | 'reject') {
  const values = record(exact(payload.state, ['values'], ['values'], 'state').values, 'state');
  const ids = { audience: slackApprovalActionIdV4(approval_id, 'audience-select'), projects: slackApprovalActionIdV4(approval_id, 'projects-select'), transcript: slackApprovalActionIdV4(approval_id, 'transcript-checkbox') };
  let audience: 'only-me' | 'projects' | undefined, project_ids: string[] = [], share_transcript: boolean | undefined; const owners: { signal_id: string; owner: string }[] = [];
  for (const block of Object.values(values)) { const entry = record(block, 'state'), keys = Object.keys(entry); if (keys.length !== 1) invalid('state'); const key = keys[0]!; const control = record(entry[key], 'state');
    if (key === ids.audience) { if (control.type !== 'static_select') invalid('state'); const option = exact(control.selected_option, ['text', 'value'], ['text', 'value'], 'state'); if (option.value !== 'only-me' && option.value !== 'projects') invalid('state'); audience = option.value; continue; }
    if (key === ids.projects) { if (control.type !== 'multi_static_select' || !Array.isArray(control.selected_options) || control.selected_options.length > 20) invalid('state'); project_ids = control.selected_options.map(option => { const item = exact(option, ['text', 'value'], ['text', 'value'], 'state'); return string(item.value, PROJECT, 'state'); }).sort(); if (project_ids.some((id, index) => index > 0 && project_ids[index - 1] === id)) invalid('state'); continue; }
    if (key === ids.transcript) { if (control.type !== 'checkboxes' || !Array.isArray(control.selected_options) || control.selected_options.length > 1) invalid('state'); share_transcript = control.selected_options.length === 1 && exact(control.selected_options[0], ['text', 'value'], ['text', 'value'], 'state').value === 'share-transcript-v1'; if (share_transcript === false && control.selected_options.length === 1) invalid('state'); continue; }
    const prefix = slackApprovalOwnerActionIdV4(approval_id, ''); if (!key.startsWith(prefix)) invalid('state'); const signal_id = key.slice(prefix.length); if (!isApprovalSignalIdV1(signal_id) || control.type !== 'plain_text_input' || (control.value !== null && !isApprovalOwnerTextV1(control.value))) invalid('state'); if (control.value !== null) owners.push({ signal_id, owner: control.value });
  }
  if (audience === undefined || share_transcript === undefined || owners.length > 40 || new Set(owners.map(owner => owner.signal_id)).size !== owners.length) invalid('state');
  if (action === 'reject') return Object.freeze({ audience: 'only-me' as const, project_ids: Object.freeze([]), share_transcript: false, owners: Object.freeze([]) });
  if ((audience === 'projects') !== (project_ids.length > 0)) invalid('state');
  return Object.freeze({ audience, project_ids: Object.freeze(project_ids), share_transcript, owners: Object.freeze(owners) });
}
function providerKey(input: { readonly lookup: PrivateSlackApprovalLookupHintsV1; readonly trigger_id: string; readonly action_ts: string; readonly action_id: string }): `sha256:${string}` { const { lookup } = input; return sha256Digest(['echo-private-slack-provider-action-key-v1', lookup.api_app_id, lookup.workspace_id, lookup.slack_user_id, lookup.channel_id, lookup.message_ts, input.trigger_id, input.action_ts, input.action_id].join('\0')); }

/** Parses only V4 controls after verification. Provider fields remain lookup hints for the durable click boundary. */
export function parseVerifiedPrivateSlackApprovalInteractionV1(verified: VerifiedPrivateSlackApprovalRequestV1): PrivateSlackApprovalInteractionV1 {
  try { const retained = evidence.get(verified); if (!retained) invalid(); const payload = exact(form(retained.body), ['type', 'user', 'api_app_id', 'container', 'trigger_id', 'team', 'channel', 'message', 'state', 'actions'], ['type', 'user', 'api_app_id', 'container', 'trigger_id', 'team', 'channel', 'message', 'state', 'actions', 'enterprise', 'is_enterprise_install', 'response_url'], 'envelope'); const hints = lookup(payload); const actions = payload.actions; if (!Array.isArray(actions) || actions.length !== 1) invalid('action'); const selected = exact(actions[0], ['type', 'action_id'], ['type', 'action_id', 'block_id', 'value', 'action_ts', 'style'], 'action'); const action_id = string(selected.action_id, IDENTIFIER, 'action');
    const knownInput = ['audience-select', 'projects-select', 'transcript-checkbox'] as const; if (knownInput.some(name => action_id === slackApprovalActionIdV4('placeholder', name).replace(/-[0-9a-f]{32}-/, '-'))) { /* unreachable guard retained only for type narrowing */ }
    const trigger_id = string(payload.trigger_id, TRIGGER, 'action', 512);
    if (selected.type !== 'button') { if (!knownInput.some(name => action_id.endsWith(`-${name}`))) invalid('action'); return Object.freeze({ schema_version: 4, disposition: 'presentation_change', lookup: hints }); }
    const button = value(selected); const expected = selected.action_id === slackApprovalActionIdV4(button.approval_id, 'approve') ? 'approve' : selected.action_id === slackApprovalActionIdV4(button.approval_id, 'reject') ? 'reject' : undefined; if (!expected || typeof selected.action_ts !== 'string' || !TS.test(selected.action_ts)) invalid('action'); const choices = state(payload, button.approval_id, expected);
    return Object.freeze({ schema_version: 4, disposition: 'resolution', action: expected, approval_id: button.approval_id, snapshot_sha256: button.snapshot_sha256, ...choices, provider_action_key_sha256: providerKey({ lookup: hints, trigger_id, action_ts: selected.action_ts, action_id }), lookup: hints });
  } catch (error) { if (error instanceof PrivateSlackApprovalInteractionError) throw error; throw new PrivateSlackApprovalInteractionError(); }
}

/** Extracted only on the verified, request-local handler path. It is never part of a parsed click or durable record. */
export function verifiedSlackResponseUrlV1(verified: VerifiedPrivateSlackApprovalRequestV1): string | undefined {
  const retained = evidence.get(verified); if (!retained) return undefined; try { const source = new TextDecoder('utf-8', { fatal: true }).decode(retained.body), fields = new URLSearchParams(source); if ([...fields.keys()].length !== 1 || !fields.has('payload')) return undefined; const payload = JSON.parse(fields.get('payload')!) as { readonly response_url?: unknown }; const value = payload.response_url; if (typeof value !== 'string') return undefined; const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.username === '' && url.password === '' && url.port === '' && url.pathname.startsWith('/actions/') && url.search === '' && url.hash === '' ? url.href : undefined; } catch { return undefined; }
}
