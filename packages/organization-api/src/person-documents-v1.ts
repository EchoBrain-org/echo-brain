import { sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonUpdateRequestId } from './person-updates.js';
import { validateProjectContextAudienceV1, validateProjectIdV1, type ProjectContextAudienceV1, type ProjectIdV1 } from './project-context-v1.js';

export const PERSON_DOCUMENTS_PATH_V1 = '/v1/person/documents';
export const PERSON_DOCUMENT_MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
export const PERSON_DOCUMENT_TEXT_PAGE_MAX_BYTES = 8 * 1024;
export const PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export type PersonDocumentMediaTypeV1 = 'text/plain' | 'text/markdown' | 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type PersonDocumentExtractionStateV1 = 'extracting' | 'ready' | 'partial' | 'no_text' | 'encrypted' | 'malformed' | 'limit_exceeded' | 'timed_out' | 'unsupported' | 'unavailable';

export interface PersonDocumentUploadMetadataV1 {
  readonly schema_version: 1; readonly kind: 'echo-person-document-upload-v1'; readonly request_id: string;
  readonly filename: string; readonly title: string; readonly content_length: number; readonly sha256: `sha256:${string}`;
  readonly audience: ProjectContextAudienceV1; readonly project_id: ProjectIdV1 | null;
}
export interface PersonDocumentReceiptV1 extends Omit<PersonDocumentUploadMetadataV1, 'kind'> {
  readonly kind: 'echo-person-document-receipt-v1'; readonly document_id: `doc_${string}`;
  readonly detected_media_type: PersonDocumentMediaTypeV1; readonly received_at: string;
  readonly state: 'saved'; readonly extraction_state: PersonDocumentExtractionStateV1;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Document metadata must be an object');
  return value as Record<string, unknown>;
}
function utf8Bytes(value: string): number { return Array.from(value).reduce((total, point) => { const code = point.codePointAt(0)!; if(code>=0xd800&&code<=0xdfff)throw new Error('Document string contains an invalid Unicode scalar'); return total + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4); }, 0); }
function boundedText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.normalize('NFC') !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || utf8Bytes(value) > maximum) throw new Error(`${label} is invalid`);
}
export function validatePersonDocumentUploadMetadataV1(value: unknown): PersonDocumentUploadMetadataV1 {
  const input = plainObject(value);
  const keys = ['audience','content_length','filename','kind','project_id','request_id','schema_version','sha256','title'];
  if (Object.keys(input).sort().join() !== keys.join() || input.schema_version !== 1 || input.kind !== 'echo-person-document-upload-v1') throw new Error('Document metadata shape is invalid');
  validatePersonUpdateRequestId(input.request_id); boundedText(input.filename, 'Document filename', 255); boundedText(input.title, 'Document title', 200);
  if (/[\\/]/u.test(input.filename) || input.filename === '.' || input.filename === '..') throw new Error('Document filename must be a basename');
  if (!Number.isSafeInteger(input.content_length) || (input.content_length as number) < 1 || (input.content_length as number) > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) throw new Error('Document content length is invalid');
  if (typeof input.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.sha256)) throw new Error('Document SHA-256 is invalid');
  const audience = validateProjectContextAudienceV1(input.audience);
  const project_id = input.project_id === null ? null : validateProjectIdV1(input.project_id, 'Document associated project_id');
  return { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: input.request_id as string, filename: input.filename, title: input.title, content_length: input.content_length as number, sha256: input.sha256 as `sha256:${string}`, audience, project_id };
}

/** Detects supported content from bytes; caller-supplied filename/MIME is never authoritative. */
export function detectPersonDocumentMediaTypeV1(bytes: Uint8Array, filename: string): PersonDocumentMediaTypeV1 {
  if (bytes.byteLength < 1 || bytes.byteLength > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) throw new Error('Document original exceeds the supported size');
  const extension = filename.toLocaleLowerCase('en-US').split('.').at(-1);
  if (extension === 'doc') throw new Error('Legacy .doc is unsupported');
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) { if (extension !== 'pdf') throw new Error('PDF content requires a .pdf filename'); return 'application/pdf'; }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (extension !== 'docx') throw new Error('Word ZIP content requires a .docx filename');
    if (!isWordDocumentContainer(bytes)) throw new Error('ZIP original is not a supported Word document container');
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (!validUtf8(bytes) || bytes.includes(0)) throw new Error('Document content is unsupported');
  if (extension !== 'txt' && extension !== 'md' && extension !== 'markdown') throw new Error('Document content is unsupported');
  return extension === 'txt' ? 'text/plain' : 'text/markdown';
}

/** Bounded container identification only. The isolated parser validates XML and actual expansion. */
function isWordDocumentContainer(bytes: Uint8Array): boolean {
  const u16 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  const u32 = (at: number): number => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0) return false;
  const count = u16(end + 10), centralSize = u32(end + 12), centralOffset = u32(end + 16);
  if (count < 2 || count > 2000 || u16(end + 8) !== count || centralOffset + centralSize !== end) return false;
  let at = centralOffset; let contentTypes = false; let document = false;
  const names = new Set<string>(); const ranges: {start: number; end: number}[] = [];
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > end || u32(at) !== 0x02014b50 || u16(at + 34) !== 0) return false;
    const nameSize = u16(at + 28), extraSize = u16(at + 30), commentSize = u16(at + 32);
    const next = at + 46 + nameSize + extraSize + commentSize;
    const compressedSize = u32(at + 20), local = u32(at + 42);
    if (nameSize === 0 || nameSize > 4096 || next > end || local + 30 > centralOffset || u32(local) !== 0x04034b50) return false;
    const localNameSize = u16(local + 26), localExtraSize = u16(local + 28);
    const data = local + 30 + localNameSize + localExtraSize;
    if (localNameSize !== nameSize || data + compressedSize > centralOffset || u16(local + 6) !== u16(at + 8) || u16(local + 8) !== u16(at + 10)) return false;
    let asciiName = ''; let isAscii = true;
    for (let n = 0; n < nameSize; n++) {
      const point = bytes[at + 46 + n]!;
      if (point !== bytes[local + 30 + n]) return false;
      if (point > 127) isAscii = false;
      if (isAscii) asciiName += String.fromCharCode(point);
    }
    // Required package names are ASCII and case-sensitive. Other names are
    // checked for traversal, duplicates and decoding by the ZIP parser.
    if (isAscii) {
      if (names.has(asciiName)) return false;
      names.add(asciiName);
      if (asciiName === '[Content_Types].xml') contentTypes = true;
      if (asciiName === 'word/document.xml') document = true;
    }
    ranges.push({ start: local, end: data + compressedSize });
    at = next;
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1]!.end)) return false;
  return at === end && contentTypes && document;
}

function validUtf8(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index++]!;
    if (first <= 0x7f) continue;
    const count = first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : -1;
    if (count < 0 || index + count > bytes.length) return false;
    const second = bytes[index]!;
    if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0) || (first === 0xf0 && second < 0x90) || (first === 0xf4 && second >= 0x90)) return false;
    for (let offset = 0; offset < count; offset += 1) if ((bytes[index++]! & 0xc0) !== 0x80) return false;
  }
  return true;
}

export function assertPersonDocumentOriginalV1(metadata: PersonDocumentUploadMetadataV1, bytes: Uint8Array): PersonDocumentMediaTypeV1 {
  if (bytes.byteLength !== metadata.content_length) throw new Error('Document content length does not match metadata');
  if (sha256Digest(bytes) !== metadata.sha256) throw new Error('Document SHA-256 does not match metadata');
  return detectPersonDocumentMediaTypeV1(bytes, metadata.filename);
}

export const PERSON_DOCUMENT_JSON_MAX_BYTES = 32 * 1024;
export interface PersonDocumentMetadataV1 extends Omit<PersonDocumentReceiptV1, 'kind'> {
  readonly kind: 'echo-person-document-metadata-v1';
  readonly extraction_detail: string | null;
  readonly extractor: string | null;
  readonly extracted_text_bytes: number;
}
export interface PersonDocumentTextChunkV1 {
  readonly ordinal: number; readonly anchor_kind: 'page' | 'paragraph'; readonly anchor_start: number; readonly text: string;
}
export interface PersonDocumentTextV1 {
  readonly schema_version: 1; readonly kind: 'echo-person-document-text-v1';
  readonly document_id: string; readonly original_sha256: string; readonly extractor: string | null;
  readonly extraction_state: PersonDocumentExtractionStateV1;
  readonly chunks: readonly PersonDocumentTextChunkV1[]; readonly next_cursor: string | null;
}
export interface PersonDocumentSearchV1 {
  readonly schema_version: 1; readonly kind: 'echo-person-document-search-v1';
  readonly project_id: ProjectIdV1 | null; readonly query: string; readonly limit: number; readonly cursor: string | null;
}
export interface PersonDocumentSearchResultV1 {
  readonly schema_version: 1; readonly kind: 'echo-person-document-search-result-v1';
  readonly documents: readonly (PersonDocumentMetadataV1 & { readonly excerpt: string | null; readonly anchor: { readonly kind: 'page' | 'paragraph'; readonly start: number } | null })[];
  readonly next_cursor: string | null;
}
export function validatePersonDocumentIdV1(value: unknown): `doc_${string}` {
  if (typeof value !== 'string' || !/^doc_[a-f0-9]{64}$/.test(value)) throw new Error('Document ID is invalid');
  return value as `doc_${string}`;
}
export function validatePersonDocumentSearchV1(value: unknown): PersonDocumentSearchV1 {
  const input = plainObject(value);
  if (Object.keys(input).sort().join() !== ['cursor','kind','limit','project_id','query','schema_version'].join() || input.schema_version !== 1 || input.kind !== 'echo-person-document-search-v1') throw new Error('Document search shape is invalid');
  if (typeof input.query !== 'string' || utf8Bytes(input.query) > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.query)) throw new Error('Document query is invalid');
  if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 20) throw new Error('Document search limit is invalid');
  if (input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))) throw new Error('Document cursor is invalid');
  return { schema_version: 1, kind: 'echo-person-document-search-v1', project_id: input.project_id === null ? null : validateProjectIdV1(input.project_id, 'project_id'), query: input.query.normalize('NFC').trim(), limit: input.limit as number, cursor: input.cursor as string | null };
}

const documentReceiptKeys = ['schema_version','kind','request_id','filename','title','content_length','sha256','audience','project_id','document_id','detected_media_type','received_at','state','extraction_state'];
const documentStates = ['extracting','ready','partial','no_text','encrypted','malformed','limit_exceeded','timed_out','unsupported','unavailable'];
const documentMedia = ['text/plain','text/markdown','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
function exactDocumentKeys(value: Record<string, unknown>, keys: readonly string[]): void { if(Object.keys(value).sort().join()!==[...keys].sort().join())throw new Error('Document response shape is invalid'); }
function documentJsonBound(value: unknown, maximum = PERSON_DOCUMENT_JSON_MAX_BYTES): void { if(utf8Bytes(JSON.stringify(value))>maximum)throw new Error('Document response exceeds its wire budget'); }
function documentBase(value: Record<string,unknown>): void {
  validatePersonDocumentUploadMetadataV1({schema_version:value.schema_version,kind:'echo-person-document-upload-v1',request_id:value.request_id,filename:value.filename,title:value.title,content_length:value.content_length,sha256:value.sha256,audience:value.audience,project_id:value.project_id});
  validatePersonDocumentIdV1(value.document_id);
  if(!documentMedia.includes(value.detected_media_type as string)||!documentStates.includes(value.extraction_state as string)||value.state!=='saved'||typeof value.received_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.received_at)||!Number.isFinite(Date.parse(value.received_at)))throw new Error('Document receipt fields are invalid');
}
export function validatePersonDocumentReceiptV1(value: unknown): PersonDocumentReceiptV1 {
  const input=plainObject(value);exactDocumentKeys(input,documentReceiptKeys);if(input.kind!=='echo-person-document-receipt-v1')throw new Error('Document receipt kind is invalid');documentBase(input);documentJsonBound(input);return input as unknown as PersonDocumentReceiptV1;
}
export function validatePersonDocumentMetadataV1(value: unknown): PersonDocumentMetadataV1 {
  const input=plainObject(value);exactDocumentKeys(input,[...documentReceiptKeys,'extraction_detail','extractor','extracted_text_bytes']);if(input.kind!=='echo-person-document-metadata-v1')throw new Error('Document metadata kind is invalid');documentBase(input);
  if(input.extraction_detail!==null&&(typeof input.extraction_detail!=='string'||utf8Bytes(input.extraction_detail)>512||/[\u0000-\u001f\u007f-\u009f]/u.test(input.extraction_detail)))throw new Error('Document extraction detail is invalid');
  if(input.extractor!==null&&(typeof input.extractor!=='string'||utf8Bytes(input.extractor)<1||utf8Bytes(input.extractor)>512))throw new Error('Document extractor is invalid');
  if(!Number.isSafeInteger(input.extracted_text_bytes)||(input.extracted_text_bytes as number)<0||(input.extracted_text_bytes as number)>PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES)throw new Error('Document extraction byte count is invalid');documentJsonBound(input);return input as unknown as PersonDocumentMetadataV1;
}
export function validatePersonDocumentTextV1(value: unknown): PersonDocumentTextV1 {
  const input=plainObject(value);exactDocumentKeys(input,['schema_version','kind','document_id','original_sha256','extractor','extraction_state','chunks','next_cursor']);
  if(input.schema_version!==1||input.kind!=='echo-person-document-text-v1'||typeof input.original_sha256!=='string'||!/^sha256:[0-9a-f]{64}$/.test(input.original_sha256)||!documentStates.includes(input.extraction_state as string))throw new Error('Document text envelope is invalid');validatePersonDocumentIdV1(input.document_id);
  if(input.extractor!==null&&(typeof input.extractor!=='string'||utf8Bytes(input.extractor)<1||utf8Bytes(input.extractor)>512))throw new Error('Document extractor is invalid');
  if(!Array.isArray(input.chunks)||input.chunks.length>8)throw new Error('Document text chunks are invalid');let prior=-1;
  for(const value of input.chunks){const chunk=plainObject(value);exactDocumentKeys(chunk,['ordinal','anchor_kind','anchor_start','text']);if(!Number.isSafeInteger(chunk.ordinal)||(chunk.ordinal as number)<=prior||!['page','paragraph'].includes(chunk.anchor_kind as string)||!Number.isSafeInteger(chunk.anchor_start)||(chunk.anchor_start as number)<1||typeof chunk.text!=='string'||utf8Bytes(chunk.text)<1||utf8Bytes(chunk.text)>8192)throw new Error('Document text chunk is invalid');prior=chunk.ordinal as number;}
  documentNextCursor(input.next_cursor);documentJsonBound(input,24*1024);return input as unknown as PersonDocumentTextV1;
}
function documentNextCursor(value: unknown): void { if(value!==null&&(typeof value!=='string'||value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value)))throw new Error('Document next cursor is invalid'); }
export function validatePersonDocumentSearchResultV1(value: unknown): PersonDocumentSearchResultV1 {
  const input=plainObject(value);exactDocumentKeys(input,['schema_version','kind','documents','next_cursor']);if(input.schema_version!==1||input.kind!=='echo-person-document-search-result-v1'||!Array.isArray(input.documents)||input.documents.length>20)throw new Error('Document search result is invalid');
  for(const value of input.documents){const item=plainObject(value);const {excerpt,anchor,...metadata}=item;validatePersonDocumentMetadataV1(metadata);if(excerpt!==null&&(typeof excerpt!=='string'||Array.from(excerpt).length>240))throw new Error('Document excerpt is invalid');if(anchor!==null){const a=plainObject(anchor);exactDocumentKeys(a,['kind','start']);if(!['page','paragraph'].includes(a.kind as string)||!Number.isSafeInteger(a.start)||(a.start as number)<1)throw new Error('Document search anchor is invalid');}}
  documentNextCursor(input.next_cursor);documentJsonBound(input);return input as unknown as PersonDocumentSearchResultV1;
}
