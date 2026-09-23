import { PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES, PERSON_DOCUMENT_MAX_ORIGINAL_BYTES, PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES } from '@echo-brain/organization-api';

export const DOCUMENT_EXTRACTION_LIMITS = Object.freeze({
  originalBytes: PERSON_DOCUMENT_MAX_ORIGINAL_BYTES,
  textBytes: PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES,
  chunkBytes: PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES,
  chunks: 4096,
  pdfPages: 500,
  zipExpandedBytes: 128 * 1024 * 1024,
  zipEntries: 2000,
  timeoutMs: 30_000,
});

export const DOCUMENT_EXTRACTOR_VERSION = 'echo-text-v1/pdfjs-6.3.289/mammoth-1.12.3/yauzl-3.4.0';
export type ExtractionStatus = 'ready' | 'partial' | 'no_text' | 'encrypted' | 'malformed'
  | 'limit_exceeded' | 'timed_out' | 'unsupported' | 'unavailable';
export interface DocumentExtractionInput {
  bytes: Uint8Array;
  filename: string;
  sourceSha256: string;
}
export interface DocumentTextChunk {
  anchor_kind: 'page' | 'paragraph';
  anchor_start: number;
  text: string;
}
export interface DocumentExtractionResult {
  status: ExtractionStatus;
  mediaType: string | null;
  sourceSha256: string;
  extractorVersion: string;
  chunks: DocumentTextChunk[];
  message: string | null;
}
export type ExtractionBudgets = { -readonly [K in keyof typeof DOCUMENT_EXTRACTION_LIMITS]: number };
