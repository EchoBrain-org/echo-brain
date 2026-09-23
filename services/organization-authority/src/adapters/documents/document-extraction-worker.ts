import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { crc32 } from 'node:zlib';
import {
  DOCUMENT_EXTRACTOR_VERSION, type DocumentExtractionInput, type DocumentExtractionResult,
  type DocumentTextChunk, type ExtractionBudgets, type ExtractionStatus,
} from './document-extraction-types.js';

// Parser imports happen after disabling network APIs. Only in-memory documents
// enter the parsers; neither a URL nor a filesystem path is passed to them.
const noNetwork = () => { throw new Error('Document extraction cannot access the network'); };
http.request = noNetwork; http.get = noNetwork;
https.request = noNetwork; https.get = noNetwork;
net.connect = noNetwork; net.createConnection = noNetwork;
net.Socket.prototype.connect = noNetwork;
tls.connect = noNetwork;
dns.lookup = noNetwork as unknown as typeof dns.lookup;
dns.resolve = noNetwork as unknown as typeof dns.resolve;
globalThis.fetch = async () => noNetwork();
syncBuiltinESMExports();

const { input, limits } = workerData as { input: DocumentExtractionInput; limits: ExtractionBudgets };
const bytes = Buffer.from(input.bytes);
let mediaType: string | null = null;
class ExtractionFailure extends Error {
  constructor(readonly status: ExtractionStatus, message: string) { super(message); }
}
function result(status: ExtractionStatus, chunks: DocumentTextChunk[] = [], message: string | null = null): DocumentExtractionResult {
  return { status, mediaType, sourceSha256: input.sourceSha256,
    extractorVersion: DOCUMENT_EXTRACTOR_VERSION, chunks, message };
}
function malformed(message = 'The document is malformed or does not match its file type.'): never {
  throw new ExtractionFailure('malformed', message);
}
function exceeded(message: string): never { throw new ExtractionFailure('limit_exceeded', message); }

class TextCollector {
  chunks: DocumentTextChunk[] = [];
  bytes = 0;
  partial = false;
  append(text: string, anchor_kind: DocumentTextChunk['anchor_kind'], anchor_start: number): void {
    // NUL cannot be represented safely by downstream search; retain a visible
    // replacement. All other whitespace and Unicode survive extraction.
    const encoded = Buffer.from(text.replaceAll('\0', '\uFFFD'));
    let cursor = 0;
    while (cursor < encoded.length) {
      const last = this.chunks.at(-1);
      const previous = last?.anchor_kind === anchor_kind && last.anchor_start === anchor_start ? last : undefined;
      const room = previous ? limits.chunkBytes - Buffer.byteLength(previous.text) : 0;
      let merge = room >= Math.min(4, encoded.length - cursor);
      if ((!merge && this.chunks.length >= limits.chunks) || this.bytes >= limits.textBytes) { this.partial = true; return; }
      const boundedEnd = (capacity: number) => {
        let end = Math.min(encoded.length, cursor + capacity, cursor + limits.textBytes - this.bytes);
        while (end < encoded.length && end > cursor && (encoded[end]! & 0xc0) === 0x80) end--;
        return end;
      };
      let end = boundedEnd(merge ? room : limits.chunkBytes);
      // Keep ordinary search tokens whole across chunks. A token longer than a
      // complete chunk necessarily spans chunks; source bytes remain preserved.
      if (end < encoded.length) {
        let prefix = encoded.subarray(cursor, end).toString('utf8');
        let whitespace = /\s+(?=\S*$)/u.exec(prefix);
        if (!whitespace && merge) {
          merge = false;
          if (this.chunks.length >= limits.chunks) { this.partial = true; return; }
          end = boundedEnd(limits.chunkBytes);
          prefix = encoded.subarray(cursor, end).toString('utf8');
          whitespace = /\s+(?=\S*$)/u.exec(prefix);
        }
        if (end < encoded.length && whitespace) {
          end = cursor + Buffer.byteLength(prefix.slice(0, whitespace.index + whitespace[0].length));
        }
      }
      if (end === cursor) { this.partial = true; return; }
      const textPart = encoded.subarray(cursor, end).toString('utf8');
      if (merge) previous!.text += textPart;
      else this.chunks.push({ anchor_kind, anchor_start, text: textPart });
      this.bytes += end - cursor; cursor = end;
    }
  }
  finish(): DocumentExtractionResult {
    if (this.partial) return result('partial', this.chunks, 'Some text was omitted because an extraction limit was reached.');
    if (!this.chunks.some((chunk) => chunk.text.trim().length)) return result('no_text', [], 'No extractable text was found. Image-only documents require OCR.');
    return result('ready', this.chunks);
  }
}

async function preflightDocx(): Promise<void> {
  // JSZip (used by Mammoth) reads central records beyond the declared count.
  // Require one exact, non-ZIP64 central directory so both parsers see the same
  // bounded entries; small .docx files never require ZIP64 or multi-disk ZIP.
  const endOffset = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
  if (endOffset < 0 || endOffset + 22 > bytes.length) malformed();
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0
    || bytes.readUInt16LE(endOffset + 8) !== entryCount
    || endOffset + 22 + bytes.readUInt16LE(endOffset + 20) !== bytes.length
    || centralOffset + centralSize !== endOffset) malformed();
  if (entryCount > limits.zipEntries) exceeded('The Word archive has too many entries.');
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (centralCursor + 46 > endOffset || bytes.readUInt32LE(centralCursor) !== 0x02014b50) malformed();
    centralCursor += 46 + bytes.readUInt16LE(centralCursor + 28)
      + bytes.readUInt16LE(centralCursor + 30) + bytes.readUInt16LE(centralCursor + 32);
    if (centralCursor > endOffset) malformed();
  }
  if (centralCursor !== endOffset) malformed();
  const { fromBufferPromise } = await import('yauzl');
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
  try {
    if (zip.entryCount > limits.zipEntries) exceeded('The Word archive has too many entries.');
    const entries = [];
    const names = new Set<string>();
    let claimedBytes = 0;
    const ranges: { start: number; end: number }[] = [];
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= limits.zipEntries) exceeded('The Word archive has too many entries.');
      const name = entry.fileName;
      if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
        || name.split('/').some((part) => part === '..' || part === '.') || names.has(name.toLowerCase())) malformed();
      names.add(name.toLowerCase());
      if (entry.isEncrypted()) throw new ExtractionFailure('encrypted', 'Encrypted Word documents cannot be extracted.');
      if (![0, 8].includes(entry.compressionMethod)) malformed();
      const mode = entry.externalFileAttributes >>> 16;
      if ((mode & 0xf000) === 0xa000) malformed();
      claimedBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(claimedBytes) || claimedBytes > limits.zipExpandedBytes) exceeded('The expanded Word archive exceeds its size limit.');
      const header = await zip.readLocalFileHeaderPromise(entry);
      if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod
        || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) malformed();
      const end = header.fileDataStart + entry.compressedSize;
      if (end > centralOffset || entry.relativeOffsetOfLocalHeader < 0 || end < header.fileDataStart) malformed();
      ranges.push({ start: entry.relativeOffsetOfLocalHeader, end });
      entries.push(entry);
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) malformed();
    if (!names.has('[content_types].xml') || !names.has('word/document.xml')) malformed('The ZIP file is not a Word .docx document.');
    let expanded = 0;
    let contentTypes = '';
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue;
      const stream = await zip.openReadStreamPromise(entry);
      let entryBytes = 0;
      let checksum = 0;
      let tail = '';
      const xml = /\.(?:xml|rels)$/i.test(entry.fileName);
      const decoder = xml ? new TextDecoder('utf-8', { fatal: true }) : null;
      try {
        for await (const value of stream) {
          const chunk = Buffer.from(value);
          expanded += chunk.length; entryBytes += chunk.length;
          if (expanded > limits.zipExpandedBytes) exceeded('The expanded Word archive exceeds its size limit.');
          if (entryBytes > entry.uncompressedSize) malformed();
          checksum = crc32(chunk, checksum);
          if (decoder) {
            const text = decoder.decode(chunk, { stream: true });
            const scan = tail + text;
            if (scan.includes('\0') || /<!\s|<!(?:DOCTYPE|ENTITY)\b/i.test(scan)) malformed('Document XML entities and non-UTF-8 XML are unsupported.');
            tail = scan.slice(-64);
            if (entry.fileName === '[Content_Types].xml') {
              if (contentTypes.length + text.length > 1024 * 1024) exceeded('Word content type metadata exceeds its size limit.');
              contentTypes += text;
            }
          }
        }
        decoder?.decode();
      } finally { stream.destroy(); }
      if (entryBytes !== entry.uncompressedSize || checksum !== entry.crc32) malformed();
    }
    if (!contentTypes.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) malformed();
    // Raw text extraction does not evaluate macros, and macro-bearing input is
    // not silently accepted as ordinary .docx.
    if ([...names].some((name) => /(?:vbaproject\.bin|activex\/)/i.test(name))) malformed();
  } finally { zip.close(); }
}

async function extract(): Promise<DocumentExtractionResult> {
  if (createHash('sha256').update(bytes).digest('hex') !== input.sourceSha256.replace(/^sha256:/, '')) malformed('Original integrity verification failed.');
  const extension = /\.([^.]+)$/.exec(input.filename)?.[1]?.toLowerCase();
  const collector = new TextCollector();
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') {
    mediaType = extension !== 'txt' ? 'text/markdown' : 'text/plain';
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0') || /^(?:%PDF-|PK\u0003\u0004)/.test(text)) malformed();
    let paragraph = 1;
    // Preserve separators and whitespace. Anchors identify extracted paragraphs.
    for (const match of text.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
      if (!match[0]) continue;
      collector.append(match[0], 'paragraph', paragraph++);
      if (collector.partial) break;
    }
    return collector.finish();
  }
  if (extension === 'docx') {
    mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return result('encrypted', [], 'Encrypted Word containers cannot be extracted.');
    if (bytes.readUInt32LE(0) !== 0x04034b50) malformed();
    await preflightDocx();
    const mammoth = (await import('mammoth')).default;
    // extractRawText uses the default-denied externalFileAccess option and does
    // not render HTML/images, execute fields, or evaluate scripts.
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    let paragraph = 1;
    for (const part of extracted.value.split(/(?<=\n\n)/)) {
      collector.append(part, 'paragraph', paragraph++);
      if (collector.partial) break;
    }
    if (extracted.messages.some((message) => message.type === 'error')) collector.partial = true;
    return collector.finish();
  }
  if (extension === 'pdf') {
    mediaType = 'application/pdf';
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) malformed();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({
      // PDF.js 6 removed eval/JIT generation; no isEvalSupported opt-in exists.
      data: Uint8Array.from(bytes), useSystemFonts: false,
      useWorkerFetch: false, disableFontFace: true, disableAutoFetch: true,
      disableStream: true, stopAtErrors: true, verbosity: 0,
    });
    try {
      const document = await loading.promise;
      const count = Math.min(document.numPages, limits.pdfPages);
      for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
        const page = await document.getPage(pageNumber);
        try {
          const reader = page.streamTextContent().getReader();
          try {
            while (!collector.partial) {
              const read = await reader.read();
              if (read.done) break;
              for (const item of read.value.items) {
                if (!('str' in item)) continue;
                collector.append(item.str + (item.hasEOL ? '\n' : ' '), 'page', pageNumber);
                if (collector.partial) break;
              }
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
        } finally { page.cleanup(); }
        if (collector.partial) break;
      }
      if (document.numPages > count) collector.partial = true;
      return collector.finish();
    } catch (error) {
      if (error instanceof Error && error.name === 'PasswordException') return result('encrypted', [], 'Encrypted PDFs cannot be extracted without a password.');
      throw error;
    } finally { await loading.destroy(); }
  }
  return result('unsupported', [], 'Supported documents are UTF-8 .txt/.md, PDF, and Word .docx.');
}

try { parentPort!.postMessage(await extract()); }
catch (error) {
  parentPort!.postMessage(error instanceof ExtractionFailure
    ? result(error.status, [], error.message)
    : result('malformed', [], 'The document could not be safely parsed.'));
}
