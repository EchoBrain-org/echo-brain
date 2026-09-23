import type { PersonDocumentRepositoryV1 } from '../application/ports/document-v1.js';
import { extractDocument, type DocumentExtractionInput, type DocumentExtractionResult } from '../adapters/documents/document-extraction.js';
import { withoutCoreRuntimeContentV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { pullAndAdmitSourceBatchV1 } from '@echo-brain/organization-processing/core';
import { PersonSourceAdapterV1 } from '../adapters/sources/person-source-v1.js';
import type { PersonTextSourceInboxV1 } from '../application/ports/person-text-source-v1.js';

type ExtractionRepository = Pick<PersonDocumentRepositoryV1, 'claimExtraction' | 'completeExtraction' | 'sourceAdmission'>;
type Extract = (input: DocumentExtractionInput, signal?: AbortSignal) => Promise<DocumentExtractionResult>;

/** Model-independent extraction; one claim and parser at a time. */
export class PersonDocumentProcessingV1 {
  private running = false;
  private readonly source: PersonSourceAdapterV1;
  constructor(private readonly repository: ExtractionRepository, private readonly extract: Extract = extractDocument, texts?:PersonTextSourceInboxV1) { this.source = new PersonSourceAdapterV1(repository,texts); }
  async runOnce(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.running) return;
    this.running = true;
    try {
      await withoutCoreRuntimeContentV1(async () => {
        const batch = await pullAndAdmitSourceBatchV1({ source:this.source,request:{limit:1},admission:{store:this.repository.sourceAdmission,scope:source=>this.source.scopeFor(source)},context:{signal} });
        const admitted = batch.sources[0];
        if (admitted === undefined) return;
        // Editor text is already indexed and readable; it needs no file decoder.
        if (admitted.content.kind === 'person-text') return;
        const claim = this.source.claimFor(admitted);
        const result = await this.extract({ bytes: claim.bytes, filename: claim.filename, sourceSha256: claim.source_sha256 }, signal);
        // Shutdown leaves the lease recoverable; a stale parser never commits.
        signal.throwIfAborted();
        this.repository.completeExtraction(claim, result);
      });
    } finally { this.running = false; }
  }
}

/** Start with the API, including when no answer/enrichment model is configured. */
export function startPersonDocumentProcessingV1(repository: ExtractionRepository, texts?:PersonTextSourceInboxV1): { close(): Promise<void> } {
  const worker = new PersonDocumentProcessingV1(repository,extractDocument,texts);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const schedule = (delay: number): void => {
    if (abort.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      // A failed attempt is retried through its persisted lease. Never log content.
      running = worker.runOnce(abort.signal).catch(() => undefined).then(() => schedule(250));
    }, delay);
    timer.unref();
  };
  schedule(0);
  return {
    async close() {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
