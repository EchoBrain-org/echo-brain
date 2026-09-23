import { describe, expect, it, vi } from 'vitest';
import { sourceContentSha256V1, sourceItemIdV1 } from '@echo-brain/organization-processing/core';
import { PersonSourceAdapterV1 } from '../src/adapters/sources/person-source-v1.js';
import { PersonDocumentProcessingV1, startPersonDocumentProcessingV1 } from '../src/composition/person-document-processing-v1.js';
import type { DocumentExtractionClaimV1, DocumentExtractionResultV1 } from '../src/application/ports/document-v1.js';
import { PERSON_SOURCE_IDENTITY_V1 } from '../src/application/person-document-source-v1.js';

const claim: DocumentExtractionClaimV1 = { document_id: `doc_${'a'.repeat(64)}`, lease_token: 'lease', filename: 'requirements.md', source_sha256: `sha256:${'b'.repeat(64)}`, authorization_sha256: `sha256:${'c'.repeat(64)}`, source_scope:{organization_id:'org_fixture',custody_ref:'organization:org_fixture',access_policy_ref:'document-audience:fixture',analysis_policy:'on_request'}, received_at:'2026-09-23T00:00:00.000Z', contributor:{principal_id:'prn_fixture',membership_id:'mem_fixture'}, media_type:'text/markdown', bytes: new TextEncoder().encode('requirements') };
const result = { status: 'ready' as const, mediaType: 'text/markdown', sourceSha256: claim.source_sha256, extractorVersion: 'fixture-v1', chunks: [{ anchor_kind: 'paragraph' as const, anchor_start: 1, text: 'requirements' }], message: null };

describe('document extraction runtime', () => {
  it('serializes claims and commits the same lease and source provenance', async () => {
    let claims = 0;
    const commits: [DocumentExtractionClaimV1, DocumentExtractionResultV1][] = [];
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const worker = new PersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=> 'admitted' as const}, claimExtraction: () => { claims++; return claim; }, completeExtraction: (c, r) => { commits.push([c, r]); return true; } }, async input => {
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
    const worker = new PersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=> 'admitted' as const}, claimExtraction: () => claim, completeExtraction: () => { commits++; return true; } }, async (_input, signal) => {
      expect(signal).toBe(abort.signal); abort.abort(); return result;
    });
    await expect(worker.runOnce(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(commits).toBe(0);
  });
  it('tries documents on the next cycle after a failing text inbox instead of starving file work', async () => {
    let documentClaims = 0;
    const source = new PersonSourceAdapterV1({ claimExtraction: () => { documentClaims++; return claim; } }, {
      next: () => { throw new Error('Person text source integrity failed'); },
    });
    expect((await source.pull({ limit: 1 })).sources).toHaveLength(1);
    await expect(source.pull({ limit: 1 })).rejects.toThrow('Person text source integrity failed');
    expect((await source.pull({ limit: 1 })).sources).toHaveLength(1);
    expect(documentClaims).toBe(2);
  });

  it('continues after an attempt fails without committing invented output', async () => {
    let attempts = 0; let commits = 0;
    const observed: unknown[] = [];
    const worker = new PersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=> 'admitted' as const}, claimExtraction: () => claim, completeExtraction: () => { commits++; return true; } }, async () => {
      if (++attempts === 1) throw new Error('fixture parser failure');
      return result;
    },undefined,{on_failure:event=>observed.push(event)});
    const abort = new AbortController();
    await expect(worker.runOnce(abort.signal)).rejects.toThrow('fixture parser failure');
    expect(commits).toBe(0);
    expect(observed).toEqual([{stage:'document_extraction',error_code:'document_extraction_failed'}]);
    await worker.runOnce(abort.signal);
    expect(commits).toBe(1);
  });

  it('backs off idle polling, wakes an idle worker immediately, and close cancels its timer', async () => {
    vi.useFakeTimers();
    let claims = 0;
    const worker = startPersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=> 'admitted' as const}, claimExtraction: () => { claims++; return undefined; }, completeExtraction: () => true });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(claims).toBe(1);
      worker.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(claims).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(claims).toBe(3);
      await vi.advanceTimersByTimeAsync(499);
      expect(claims).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(claims).toBe(4);
      await worker.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(claims).toBe(4);
    } finally { vi.useRealTimers(); }
  });

  it('backs off failed source admission attempts instead of retrying every 250ms', async () => {
    vi.useFakeTimers();
    let claims = 0;
    const worker = startPersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=>{ throw new Error('admission failed'); }}, claimExtraction: () => { claims++; return claim; }, completeExtraction: () => true });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(claims).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claims).toBe(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(claims).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(claims).toBe(3);
      await worker.close();
    } finally { vi.useRealTimers(); }
  });

  it('wakes once after active work finishes without overlapping source claims', async () => {
    vi.useFakeTimers();
    let claims = 0;
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { release = resolve; });
    const content = { schema_version:1 as const, kind:'person-text' as const, original_api_version:1 as const, context_id:'ctx_fixture', title:'fixture', text:'fixture' };
    const sourceId=sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1,content.context_id);
    const text = {
      source: {
        item: { schema_version:1, source_id:sourceId, adapter:PERSON_SOURCE_IDENTITY_V1, external_id:content.context_id },
        revision: { schema_version:1, source_id:sourceId, revision_id:`sha256:${'d'.repeat(64)}`, captured_at:'2026-09-23T00:00:00.000Z', content_sha256:sourceContentSha256V1(content), contributor:{principal_id:'prn_fixture',membership_id:'mem_fixture'},artifact_refs:[{artifact_id:content.context_id,media_type:'text/plain',sha256:'d'.repeat(64),byte_length:7}],representation_refs:[] },
        content,
      },
      scope: { organization_id:'org_fixture',custody_ref:'organization:org_fixture',access_policy_ref:'person-text-audience:ctx_fixture',analysis_policy:'on_request' as const },
    } as const;
    const worker = startPersonDocumentProcessingV1({ sourceAdmission:{admitSourceRevision:async()=>{ await admitted; return 'admitted' as const; }}, claimExtraction: () => undefined, completeExtraction: () => true },{ next: () => { claims++; return claims === 1 ? text : undefined; } });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(1);
      worker.wake();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(claims).toBe(1);
      release();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(2);
      await worker.close();
    } finally { vi.useRealTimers(); }
  });
});
