import { describe, expect, it } from 'vitest';
import { PersonDocumentProcessingV1 } from '../src/composition/person-document-processing-v1.js';
import type { DocumentExtractionClaimV1, DocumentExtractionResultV1 } from '../src/application/ports/document-v1.js';

const claim: DocumentExtractionClaimV1 = { document_id: `doc_${'a'.repeat(64)}`, lease_token: 'lease', filename: 'requirements.md', source_sha256: `sha256:${'b'.repeat(64)}`, authorization_sha256: `sha256:${'c'.repeat(64)}`, bytes: new TextEncoder().encode('requirements') };
const result = { status: 'ready' as const, mediaType: 'text/markdown', sourceSha256: claim.source_sha256, extractorVersion: 'fixture-v1', chunks: [{ anchor_kind: 'paragraph' as const, anchor_start: 1, text: 'requirements' }], message: null };

describe('document extraction runtime', () => {
  it('serializes claims and commits the same lease and source provenance', async () => {
    let claims = 0;
    const commits: [DocumentExtractionClaimV1, DocumentExtractionResultV1][] = [];
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const worker = new PersonDocumentProcessingV1({ claimExtraction: () => { claims++; return claim; }, completeExtraction: (c, r) => { commits.push([c, r]); return true; } }, async input => {
      expect(input.bytes).toBe(claim.bytes); expect(input.sourceSha256).toBe(claim.source_sha256);
      await paused; return result;
    });
    const abort = new AbortController();
    const first = worker.runOnce(abort.signal);
    await worker.runOnce(abort.signal);
    expect(claims).toBe(1); expect(commits).toEqual([]);
    release(); await first;
    expect(commits).toEqual([[claim, result]]);
  });
  it('does not commit a parser result after shutdown and leaves the lease recoverable', async () => {
    let commits = 0;
    const abort = new AbortController();
    const worker = new PersonDocumentProcessingV1({ claimExtraction: () => claim, completeExtraction: () => { commits++; return true; } }, async (_input, signal) => {
      expect(signal).toBe(abort.signal); abort.abort(); return result;
    });
    await expect(worker.runOnce(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(commits).toBe(0);
  });
  it('continues after an attempt fails without committing invented output', async () => {
    let attempts = 0; let commits = 0;
    const worker = new PersonDocumentProcessingV1({ claimExtraction: () => claim, completeExtraction: () => { commits++; return true; } }, async () => {
      if (++attempts === 1) throw new Error('fixture parser failure');
      return result;
    });
    const abort = new AbortController();
    await expect(worker.runOnce(abort.signal)).rejects.toThrow('fixture parser failure');
    expect(commits).toBe(0);
    await worker.runOnce(abort.signal);
    expect(commits).toBe(1);
  });
});
