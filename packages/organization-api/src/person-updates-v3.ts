import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { PROJECT_CONTEXT_RESPONSE_MAX_BYTES, type ProjectIdV1 } from './project-context-v1.js';
import { validateAssociationProjectIdsV1, validatePersonUploadAudienceV3, type PersonUploadAudienceV3 as UploadAudienceV3 } from './person-upload-audience-v3.js';
import { MAX_ORGANIZATION_API_BODY_BYTES, asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, fail } from './validation.js';
import { PERSON_UPDATE_TEXT_MAX_BYTES, PERSON_UPDATE_TITLE_MAX_BYTES, validatePersonUpdateRequestId, validatePersonUploadContextId, validatePersonUploadSearchV1, type PersonUploadMetadataStateV1, type PersonUploadSearchV1 } from './person-updates.js';

export const PERSON_UPDATES_PATH_V3 = '/v3/person/updates';
export interface PersonUpdateSubmitV3 {
  readonly schema_version: 3; readonly kind: 'echo-person-update-submit-v3'; readonly request_id: string;
  readonly title: string; readonly text: string; readonly association_project_ids: readonly ProjectIdV1[]; readonly audience: UploadAudienceV3;
}
export interface PersonUpdateReceiptV3 extends Omit<PersonUpdateSubmitV3, 'kind' | 'title' | 'text'> {
  readonly kind: 'echo-person-update-receipt-v3'; readonly context_id: string; readonly received_at: string; readonly state: 'received';
}
export type PersonUpdateStatusV3 = Omit<PersonUpdateReceiptV3, 'kind' | 'state'> & { readonly kind: 'echo-person-update-status-v3'; readonly status: 'stored'; readonly metadata: PersonUploadMetadataStateV1 };
export interface PersonUploadContentV3 { readonly schema_version: 3; readonly kind: 'echo-person-upload-content-v3'; readonly context_id: string; readonly received_at: string; readonly audience: UploadAudienceV3; readonly title: string; readonly text: string; }
export type PersonUploadSearchV3 = PersonUploadSearchV1;
export interface PersonUploadSearchResultV3 { readonly schema_version: 3; readonly kind: 'echo-person-upload-search-v3'; readonly results: readonly { readonly context_id: string; readonly received_at: string; readonly audience: UploadAudienceV3; readonly title: string; readonly excerpt: string }[]; }

function object(value: unknown, label: string): Record<string, unknown> { assertOnlyEnumerableDataProperties(value, label); return asRecord(value, label); }
function text(value: unknown, label: string, maximum: number, multiline: boolean): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).reduce((bytes, point) => { const n = point.codePointAt(0)!; return bytes + (n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4); }, 0) > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) || (!multiline && /[\t\r\n]/u.test(value))) fail(`${label} is invalid`);
}
function timestamp(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Person update timestamp is invalid'); }
function requestBound(value: unknown, label: string): void { if (canonicalJsonBytes(value).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`); }
function responseBound(value: unknown, label: string): void { if (canonicalJsonBytes(value).byteLength > PROJECT_CONTEXT_RESPONSE_MAX_BYTES) fail(`${label} exceeds JSON byte bound`); }
function coordinates(record: Record<string, unknown>): { readonly association_project_ids: readonly ProjectIdV1[]; readonly audience: UploadAudienceV3 } { return { association_project_ids: validateAssociationProjectIdsV1(record.association_project_ids), audience: validatePersonUploadAudienceV3(record.audience) }; }
export function validatePersonUpdateSubmitV3(value: unknown): PersonUpdateSubmitV3 {
  const record = object(value, 'Person update'); assertExactKeys(record, ['schema_version','kind','request_id','title','text','association_project_ids','audience'], 'Person update');
  if (record.schema_version !== 3 || record.kind !== 'echo-person-update-submit-v3') fail('Person update version or kind is unsupported');
  validatePersonUpdateRequestId(record.request_id); text(record.title, 'Person update title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(record.text, 'Person update text', PERSON_UPDATE_TEXT_MAX_BYTES, true);
  const result = Object.freeze({ schema_version: 3 as const, kind: 'echo-person-update-submit-v3' as const, request_id: record.request_id as string, title: record.title as string, text: record.text as string, ...coordinates(record) }); requestBound(result, 'Person update'); return result;
}
export function validatePersonUpdateReceiptV3(value: unknown): PersonUpdateReceiptV3 {
  const record = object(value, 'Person update receipt'); assertExactKeys(record, ['schema_version','kind','request_id','context_id','received_at','association_project_ids','audience','state'], 'Person update receipt');
  if (record.schema_version !== 3 || record.kind !== 'echo-person-update-receipt-v3' || record.state !== 'received') fail('Person update receipt is invalid');
  validatePersonUpdateRequestId(record.request_id); validatePersonUploadContextId(record.context_id); timestamp(record.received_at);
  const response = Object.freeze({ schema_version: 3 as const, kind: 'echo-person-update-receipt-v3' as const, request_id: record.request_id as string, context_id: record.context_id as string, received_at: record.received_at as string, ...coordinates(record), state: 'received' as const }); responseBound(response, 'Person update receipt'); return response;
}
export function validatePersonUpdateStatusV3(value: unknown): PersonUpdateStatusV3 {
  const record = object(value, 'Person update status'); assertExactKeys(record, ['schema_version','kind','request_id','context_id','received_at','association_project_ids','audience','status','metadata'], 'Person update status');
  if (record.schema_version !== 3 || record.kind !== 'echo-person-update-status-v3' || record.status !== 'stored' || !['pending','processing','ready','unavailable'].includes(record.metadata as string)) fail('Person update status is invalid');
  validatePersonUpdateRequestId(record.request_id); validatePersonUploadContextId(record.context_id); timestamp(record.received_at);
  const response = Object.freeze({ schema_version: 3 as const, kind: 'echo-person-update-status-v3' as const, request_id: record.request_id as string, context_id: record.context_id as string, received_at: record.received_at as string, ...coordinates(record), status: 'stored' as const, metadata: record.metadata as PersonUploadMetadataStateV1 }); responseBound(response, 'Person update status'); return response;
}
export function validatePersonUploadContentV3(value: unknown): PersonUploadContentV3 {
  const record = object(value, 'Person upload content'); assertExactKeys(record, ['schema_version','kind','context_id','received_at','audience','title','text'], 'Person upload content'); if (record.schema_version !== 3 || record.kind !== 'echo-person-upload-content-v3') fail('Person upload content is invalid');
  validatePersonUploadContextId(record.context_id); timestamp(record.received_at); text(record.title, 'Person upload content title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(record.text, 'Person upload content text', PERSON_UPDATE_TEXT_MAX_BYTES, true);
  const response = Object.freeze({ schema_version: 3 as const, kind: 'echo-person-upload-content-v3' as const, context_id: record.context_id as string, received_at: record.received_at as string, audience: validatePersonUploadAudienceV3(record.audience), title: record.title as string, text: record.text as string }); responseBound(response, 'Person upload content'); return response;
}
export function validatePersonUploadSearchV3(value: unknown): PersonUploadSearchV3 { return validatePersonUploadSearchV1(value); }
export function validatePersonUploadSearchResultV3(value: unknown): PersonUploadSearchResultV3 {
  const record = object(value, 'Person upload results'); assertExactKeys(record, ['schema_version','kind','results'], 'Person upload results'); if (record.schema_version !== 3 || record.kind !== 'echo-person-upload-search-v3' || !Array.isArray(record.results) || record.results.length > 10) fail('Person upload results are invalid');
  const seen = new Set<string>(); const results = record.results.map(entry => { const item = object(entry, 'Person upload result'); assertExactKeys(item, ['context_id','received_at','audience','title','excerpt'], 'Person upload result'); const context_id = validatePersonUploadContextId(item.context_id); if (seen.has(context_id)) fail('Person upload results contain duplicate IDs'); seen.add(context_id); timestamp(item.received_at); text(item.title, 'Person upload result title', PERSON_UPDATE_TITLE_MAX_BYTES, false); text(item.excerpt, 'Person upload result excerpt', 1200, true); if ([...(item.excerpt as string)].length > 300) fail('Person upload result excerpt is invalid'); return Object.freeze({ context_id, received_at: item.received_at as string, audience: validatePersonUploadAudienceV3(item.audience), title: item.title as string, excerpt: item.excerpt as string }); });
  const response = Object.freeze({ schema_version: 3 as const, kind: 'echo-person-upload-search-v3' as const, results: Object.freeze(results) }); responseBound(response, 'Person upload results'); return response;
}
