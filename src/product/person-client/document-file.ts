import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { closeSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, validatePersonDocumentUploadMetadataV1, validatePersonUpdateRequestId, type PersonDocumentUploadMetadataV1, type PersonDocumentStatusV1, type ProjectContextAudienceV1 } from '@echo-brain/organization-api';
import { personSessionStorePaths } from './session-store.js';

export interface DocumentFileUpload {
  readonly file: string;
  readonly request_id: string;
  readonly title: string;
  readonly audience: ProjectContextAudienceV1;
  readonly project_id: PersonDocumentUploadMetadataV1['project_id'];
  readonly expected_membership_id?: string;
  readonly expected_authority?: string;
}

export class DocumentFileError extends Error {
  constructor(readonly code: 'invalid_file' | 'snapshot_conflict' | 'snapshot_limit' | 'snapshot_not_found' | 'invalid_download', message: string) {
    super(message); this.name = 'DocumentFileError';
  }
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new DocumentFileError('invalid_file', 'Document snapshot directory is not private.');
  }
}

function regularFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) {
      throw new DocumentFileError('invalid_file', 'Document must be a readable regular file of 1 byte to 25 MiB.');
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

/** One bounded pass copies and hashes the original; no binary is buffered in full. */
function copyAndHash(source: number, destination?: number): { content_length: number; sha256: `sha256:${string}` } {
  const buffer = Buffer.alloc(64 * 1024);
  const hash = createHash('sha256');
  let size = 0;
  for (;;) {
    const count = readSync(source, buffer, 0, buffer.length, null);
    if (count === 0) break;
    size += count;
    if (size > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) throw new DocumentFileError('invalid_file', 'Document exceeds 25 MiB.');
    const bytes = buffer.subarray(0, count);
    hash.update(bytes);
    if (destination !== undefined) writeAll(destination, bytes);
  }
  if (size === 0) throw new DocumentFileError('invalid_file', 'Document is empty.');
  return { content_length: size, sha256: `sha256:${hash.digest('hex')}` };
}

export interface DocumentSnapshot {
  readonly metadata: PersonDocumentUploadMetadataV1;
  readonly reused: boolean;
  open(): ReturnType<typeof createReadStream>;
  remove(): void;
}

const snapshotRequestPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function snapshotAccount(homeDirectory: string, accountBinding: string): string {
  const root = join(personSessionStorePaths(homeDirectory).directory, 'document-snapshots');
  privateDirectory(root);
  const account = join(root, createHash('sha256').update(accountBinding).digest('hex'));
  privateDirectory(account);
  return account;
}
function snapshotManifest(directory: string, requestId: string): PersonDocumentUploadMetadataV1 {
  privateDirectory(directory);
  const path = join(directory, 'metadata.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) throw new DocumentFileError('invalid_file', 'Document snapshot metadata is invalid.');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { metadata: unknown };
  const metadata = validatePersonDocumentUploadMetadataV1(saved.metadata);
  if (metadata.request_id !== requestId) throw new DocumentFileError('invalid_file', 'Document snapshot metadata is inconsistent.');
  return metadata;
}
function snapshot(directory: string, requestId: string, reused: boolean): DocumentSnapshot {
  const metadata = snapshotManifest(directory, requestId);
  const originalPath = join(directory, 'original');
  const descriptor = regularFile(originalPath);
  try {
    const proof = copyAndHash(descriptor);
    if (proof.content_length !== metadata.content_length || proof.sha256 !== metadata.sha256) throw new DocumentFileError('invalid_file', 'Document snapshot integrity check failed.');
  } finally { closeSync(descriptor); }
  return {
    metadata, reused,
    open: () => createReadStream(originalPath, { fd: regularFile(originalPath), autoClose: true, highWaterMark: 64 * 1024 }),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
/** Crash leftovers are neither upload receipts nor slots. Only old, private preparation directories are collected. */
function cleanPreparationDirectories(account: string): void {
  for (const name of readdirSync(account)) {
    if (!name.startsWith('.preparing-')) continue;
    const path = join(account, name);
    const stat = lstatSync(path);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
    privateDirectory(path);
    rmSync(path, { recursive: true, force: true });
  }
}

/** Uncertain submissions retain a private byte snapshot, scoped to the exact membership tenure. */
export function prepareDocumentSnapshot(homeDirectory: string, accountBinding: string, input: DocumentFileUpload): DocumentSnapshot {
  validatePersonUpdateRequestId(input.request_id);
  const sourcePath = resolve(input.file);
  const filename = basename(sourcePath);
  if (!/\.(?:txt|md|markdown|pdf|docx)$/i.test(filename)) throw new DocumentFileError('invalid_file', 'Choose a .txt, .md, .pdf, or .docx document. Legacy .doc is unsupported.');
  validatePersonDocumentUploadMetadataV1({ schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: input.request_id,
    filename, title: input.title, audience: input.audience, project_id: input.project_id, content_length: 1, sha256: `sha256:${'0'.repeat(64)}` });
  const account = snapshotAccount(homeDirectory, accountBinding);
  const directory = join(account, input.request_id);
  const reused = existsSync(directory);
  if (!reused) {
    cleanPreparationDirectories(account);
    if (readdirSync(account).filter(name => snapshotRequestPattern.test(name)).length >= 10) throw new DocumentFileError('snapshot_limit', 'Ten document snapshots await reconciliation. Run documents pending, then status, retry, or explicitly abandon a retained snapshot.');
    let temporary: string | undefined;
    let source: number | undefined;
    let destination: number | undefined;
    try {
      source = regularFile(sourcePath);
      temporary = mkdtempSync(join(account, '.preparing-'));
      destination = openSync(join(temporary, 'original'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const proof = copyAndHash(source, destination);
      fsyncSync(destination);
      closeSync(destination); destination = undefined;
      const metadata = validatePersonDocumentUploadMetadataV1({ schema_version: 1, kind: 'echo-person-document-upload-v1',
        request_id: input.request_id, filename, title: input.title, audience: input.audience, project_id: input.project_id, ...proof });
      writeFileSync(join(temporary, 'metadata.json'), canonicalJson({ metadata }), { mode: 0o600, flag: 'wx' });
      try { renameSync(temporary, directory); temporary = undefined; }
      catch (error) { if (!existsSync(directory)) throw error; }
    } catch (error) {
      if (error instanceof DocumentFileError) throw error;
      throw new DocumentFileError('invalid_file', 'Document snapshot could not be prepared. Choose a readable regular file of at most 25 MiB.');
    } finally {
      if (source !== undefined) closeSync(source);
      if (destination !== undefined) closeSync(destination);
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
    }
  }
  const result = snapshot(directory, input.request_id, reused);
  if (result.metadata.filename !== filename || result.metadata.title !== input.title ||
      canonicalJson(result.metadata.audience) !== canonicalJson(input.audience) || result.metadata.project_id !== input.project_id) {
    throw new DocumentFileError('snapshot_conflict', 'This request ID has different retained upload coordinates. Use documents retry with its request ID to resend the exact original.');
  }
  return result;
}

/** Resume uses only the membership-scoped retained bytes; no original pathname is needed. */
export function resumeDocumentSnapshot(homeDirectory: string, accountBinding: string, requestId: string): DocumentSnapshot {
  validatePersonUpdateRequestId(requestId);
  const directory = join(snapshotAccount(homeDirectory, accountBinding), requestId);
  if (!existsSync(directory)) throw new DocumentFileError('snapshot_not_found', 'No retained document snapshot exists for this request in the current account. Check its Authority status before making a new upload.');
  try { return snapshot(directory, requestId, true); }
  catch (error) {
    if (error instanceof DocumentFileError) throw error;
    throw new DocumentFileError('invalid_file', 'The retained document snapshot is unavailable or damaged. Check its Authority status before abandoning it or making a new upload.');
  }
}

export function listDocumentSnapshots(homeDirectory: string, accountBinding: string) {
  const account = snapshotAccount(homeDirectory, accountBinding);
  cleanPreparationDirectories(account);
  return readdirSync(account).filter(name => snapshotRequestPattern.test(name)).sort().map(requestId => {
    try { return { ...snapshotManifest(join(account, requestId), requestId), local_state: 'retained' as const }; }
    catch { return { request_id: requestId, local_state: 'unreadable' as const }; }
  });
}

/** Explicit local abandonment never deletes or cancels an Authority original. */
export function abandonDocumentSnapshot(homeDirectory: string, accountBinding: string, requestId: string): boolean {
  validatePersonUpdateRequestId(requestId);
  const directory = join(snapshotAccount(homeDirectory, accountBinding), requestId);
  if (!existsSync(directory)) return false;
  privateDirectory(directory);
  rmSync(directory, { recursive: true, force: true });
  return true;
}

/** Publishes a new file only after exact byte/hash verification and the current-account fence. */
export async function saveDocumentDownload(response: Response, outputPath: string, expected: { content_length: number; sha256: string; detected_media_type: string }, beforePublish: () => void): Promise<string> {
  if (response.headers.get('content-length') !== String(expected.content_length) || response.headers.get('x-echo-document-sha256') !== expected.sha256 ||
      response.headers.get('content-type') !== expected.detected_media_type || response.body === null || expected.content_length > PERSON_DOCUMENT_MAX_ORIGINAL_BYTES) {
    await response.body?.cancel();
    throw new DocumentFileError('invalid_download', 'Document download proof did not match its metadata.');
  }
  let parent: string;
  let target: string;
  try {
    const output = resolve(outputPath);
    parent = realpathSync(dirname(output)); target = join(parent, basename(output));
  } catch { await response.body.cancel(); throw new DocumentFileError('invalid_download', 'Download output directory is unavailable.'); }
  if (existsSync(target)) { await response.body.cancel(); throw new DocumentFileError('invalid_download', 'Download output already exists. Choose a new file.'); }
  const temporary = join(parent, `.echo-document-${randomUUID()}.tmp`);
  let fd: number | undefined;
  const reader = response.body.getReader();
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > expected.content_length) throw new DocumentFileError('invalid_download', 'Document download exceeded its declared length.');
      hash.update(part.value); writeAll(fd, part.value);
    }
    if (size !== expected.content_length || `sha256:${hash.digest('hex')}` !== expected.sha256) throw new DocumentFileError('invalid_download', 'Document download integrity check failed.');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    beforePublish();
    // A hard link atomically installs the checked file without replacing any existing destination.
    linkSync(temporary, target);
    return target;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** A current, exact server status settles a retained uncertain upload without rereading its source. */
export function reconcileDocumentSnapshot(homeDirectory: string, accountBinding: string, receipt: PersonDocumentStatusV1): void {
  validatePersonUpdateRequestId(receipt.request_id);
  // The authenticated status reader validates the exact account and request. A minimal
  // saved receipt deliberately exposes no original metadata after content access loss.
  if (receipt.kind !== 'echo-person-document-saved-v1') {
    const directory = join(snapshotAccount(homeDirectory, accountBinding), receipt.request_id);
    if (!existsSync(directory)) return;
    const metadata = snapshotManifest(directory, receipt.request_id);
    for (const key of ['request_id', 'sha256', 'content_length', 'filename', 'title'] as const) if (metadata[key] !== receipt[key]) return;
    if (canonicalJson(metadata.audience) !== canonicalJson(receipt.audience)) return;
  }
  abandonDocumentSnapshot(homeDirectory, accountBinding, receipt.request_id);
}
