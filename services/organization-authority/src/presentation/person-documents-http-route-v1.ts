import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCanonicalJson } from '@echo-brain/federation-protocol';
import {
  PERSON_DOCUMENTS_PATH_V1, PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, PERSON_DOCUMENT_JSON_MAX_BYTES,
  validatePersonDocumentUploadMetadataV1, validatePersonDocumentIdV1, validatePersonUpdateRequestId,
  validateProjectIdV1, validatePersonDocumentUploadResultV1, validatePersonDocumentStatusV1, validatePersonDocumentMetadataV1,
  validatePersonDocumentTextV1, validatePersonDocumentSearchResultV1,
  type PersonDocumentUploadMetadataV1,
  validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1, validatePersonDocumentAssociationReceiptV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonDocumentApplicationV1 } from '../application/ports/document-v1.js';
import type { PersonDocumentUploadStagingV1 } from '../application/ports/document-upload-staging-v1.js';

const MAXIMUM_METADATA_HEADER_BYTES = 8192;
const MAXIMUM_CONCURRENT_UPLOADS = 2;
const MAXIMUM_CONCURRENT_DOWNLOADS = 2;
const TRANSFER_DEADLINE_MS = 120_000;

function invalid(): never { throw new AuthorityOperationError('invalid_request', 'request failed'); }
function validate<T>(operation: () => T): T {
  try { return operation(); } catch { return invalid(); }
}
function header(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name) count += 1;
  }
  if (count > 1) invalid();
  const value = request.headers[name];
  if (value !== undefined && typeof value !== 'string') invalid();
  return value;
}
function bearer(request: IncomingMessage): string {
  const value = header(request, 'authorization');
  if (value === undefined || !value.startsWith('Bearer ') || value.length === 7) {
    throw new AuthorityOperationError('unauthorized', 'request failed');
  }
  return value.slice(7);
}
function metadataHeader(request: IncomingMessage, requestId: string): PersonDocumentUploadMetadataV1 {
  const encoded = header(request, 'x-echo-document-metadata');
  if (encoded === undefined || encoded.length > MAXIMUM_METADATA_HEADER_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) invalid();
  const metadata = validate(() => validatePersonDocumentUploadMetadataV1(parseCanonicalJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  )));
  if (metadata.request_id !== requestId) invalid();
  const length = header(request, 'content-length');
  if (length !== String(metadata.content_length) || header(request, 'transfer-encoding') !== undefined ||
      header(request, 'content-encoding') !== undefined || header(request, 'content-type') !== 'application/octet-stream') invalid();
  return metadata;
}

async function smallBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) invalid();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
function output<T>(value: T, check: (value: unknown) => unknown, binding = true): T {
  try { check(value); if (!binding) throw new Error('Document response identity mismatch'); }
  catch { throw new AuthorityOperationError('invalid_output', 'request failed'); }
  return value;
}
function json(response: ServerResponse, status: number, value: unknown, check: (value: unknown) => unknown): void {
  output(value, check);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > PERSON_DOCUMENT_JSON_MAX_BYTES) throw new AuthorityOperationError('invalid_output', 'request failed');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length), 'cache-control': 'no-store' });
  response.end(bytes);
}
function jsonInput(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const input: unknown = JSON.parse(text);
  const objects: (Set<string> | undefined)[] = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"(\s*:)?|[{}[\]]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '[') objects.push(undefined);
    else if (token[0] === '}' || token[0] === ']') objects.pop();
    else if (token[1] !== undefined) {
      const key = JSON.parse(token[0].slice(0, -token[1].length)) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) invalid();
      keys.add(key);
    }
  }
  return input;
}

/** Every release follows the application's current-authorization audit without an await. */
export function createPersonDocumentsHttpHandlerV1(
  application: PersonDocumentApplicationV1,
  staging: PersonDocumentUploadStagingV1,
  options: { readonly isClosing?: () => boolean } = {},
): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  let uploading = 0;
  let downloading = 0;
  const current = (): void => {
    if (options.isClosing?.()) throw new AuthorityOperationError('unavailable', 'request failed');
  };
  return async (request, response, url) => {
    if (!url.pathname.startsWith(`${PERSON_DOCUMENTS_PATH_V1}/`)) return false;
    const path = url.pathname.slice(PERSON_DOCUMENTS_PATH_V1.length + 1).split('/');
    const method = request.method ?? 'GET';
    const upload = method === 'PUT' && path.length === 1;
    const search = method === 'POST' && path.length === 1 && path[0] === 'search';
    const association = method === 'POST' && path.length === 2 && (path[1] === 'associate' || path[1] === 'dissociate');
    const status = method === 'GET' && path.length === 2 && path[0] === 'requests';
    const read = method === 'GET' && path.length === 1;
    const original = method === 'GET' && path.length === 2 && path[1] === 'original';
    const text = method === 'GET' && path.length === 2 && path[1] === 'text';
    if (!upload && !search && !association && !status && !read && !original && !text) return false;
    const token = bearer(request);
    if ((upload || search || association || status) && url.search !== '') invalid();
    if (upload) {
      const requestId = validate(() => validatePersonUpdateRequestId(path[0]));
      const metadata = metadataHeader(request, requestId);
      application.preflight(token, metadata);
      if (uploading >= MAXIMUM_CONCURRENT_UPLOADS) throw new AuthorityOperationError('rate_limited', 'request failed');
      uploading += 1;
      try {
        const deadline = setTimeout(() => request.destroy(new Error('Document transfer deadline exceeded')), TRANSFER_DEADLINE_MS);
        deadline.unref();
        let bytes: Uint8Array;
        try { bytes = await staging.stage(request, metadata); }
        finally { clearTimeout(deadline); }
        if (!request.complete) invalid();
        current();
        const receipt = application.upload(token, metadata, bytes);
        output(receipt, validatePersonDocumentUploadResultV1, receipt.request_id === metadata.request_id && (receipt.kind === 'echo-person-document-saved-v1' || (receipt.sha256 === metadata.sha256 && receipt.content_length === metadata.content_length && receipt.filename === metadata.filename && receipt.title === metadata.title && receipt.project_id === metadata.project_id && JSON.stringify(receipt.audience) === JSON.stringify(metadata.audience))));
        json(response, 201, receipt, validatePersonDocumentUploadResultV1);
      } finally { uploading -= 1; }
      return true;
    }
    application.preflight(token);
    if (association) {
      if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json') invalid();
      const id = validate(() => validatePersonDocumentIdV1(path[0]));
      const bytes = await smallBody(request, 4096);
      const input = validate(() => jsonInput(bytes));
      const command = validate(() => path[1] === 'associate' ? validatePersonDocumentAssociateV1(input) : validatePersonDocumentDissociateV1(input));
      if (command.document_id !== id) invalid();
      current();
      const receipt = path[1] === 'associate' ? application.associate(token, command) : application.dissociate(token, command);
      output(receipt, validatePersonDocumentAssociationReceiptV1, receipt.document_id === id && receipt.project_id === command.project_id && receipt.request_id === command.request_id && receipt.operation === path[1]);
      json(response, 200, receipt, validatePersonDocumentAssociationReceiptV1);
      return true;
    }
    if (search) {
      if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json') invalid();
      const bytes = await smallBody(request, 4096);
      const input = validate(() => jsonInput(bytes));
      current();
      json(response, 200, application.search(token, input), validatePersonDocumentSearchResultV1);
      return true;
    }
    if ((await smallBody(request, 0)).length !== 0) invalid();
    current();
    if (status) {
      const id = validate(() => validatePersonUpdateRequestId(path[1]));
      const value = application.status(token, id);
      output(value, validatePersonDocumentStatusV1, value.request_id === id);
      json(response, 200, value, validatePersonDocumentStatusV1);
      return true;
    }
    const id = validate(() => validatePersonDocumentIdV1(path[0]));
    const parameters = new Map<string, string>();
    for (const [key, value] of url.searchParams) {
      if ((key !== 'project_id' && !(text && key === 'cursor')) || parameters.has(key)) invalid();
      parameters.set(key, value);
    }
    const project = parameters.get('project_id');
    const scope = project === undefined ? {} : { project_id: validate(() => validateProjectIdV1(project)) };
    if (original) {
      if (downloading >= MAXIMUM_CONCURRENT_DOWNLOADS) throw new AuthorityOperationError('rate_limited', 'request failed');
      downloading += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearTimeout(deadline);
        downloading -= 1;
        response.off('finish', release); response.off('close', release);
      };
      const deadline = setTimeout(() => response.destroy(), TRANSFER_DEADLINE_MS);
      deadline.unref();
      response.once('finish', release); response.once('close', release);
      try {
      const result = application.original(token, id, scope);
      output(result.metadata, validatePersonDocumentMetadataV1, result.metadata.document_id === id);
      if (result.bytes.length !== result.metadata.content_length || result.bytes.length > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES || `sha256:${createHash('sha256').update(result.bytes).digest('hex')}` !== result.metadata.sha256) {
        throw new AuthorityOperationError('invalid_output', 'request failed');
      }
      response.writeHead(200, {
        'content-type': result.metadata.detected_media_type,
        'content-length': String(result.bytes.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.metadata.filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'x-echo-document-sha256': result.metadata.sha256,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      response.end(result.bytes);
      } catch (error) { release(); throw error; }
    } else if (text) {
      const cursor = parameters.get('cursor');
      const value = application.text(token, id, { ...scope, ...(cursor === undefined ? {} : { cursor }) });
      output(value, validatePersonDocumentTextV1, value.document_id === id);
      json(response, 200, value, validatePersonDocumentTextV1);
    } else {
      const value = application.read(token, id, scope);
      output(value, validatePersonDocumentMetadataV1, value.document_id === id);
      json(response, 200, value, validatePersonDocumentMetadataV1);
    }
    return true;
  };
}
