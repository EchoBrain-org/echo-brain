import type { PersonDocumentRepositoryV1 } from '../application/ports/document-v1.js';
import { extractDocument, type DocumentExtractionInput, type DocumentExtractionResult } from '../adapters/documents/document-extraction.js';
import { withoutCoreRuntimeContentV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { pullAndAdmitSourceBatchV1 } from '@echo-brain/organization-processing/core';
import { PersonSourceAdapterV1 } from '../adapters/sources/person-source-v1.js';
import type { PersonTextSourceInboxV1, PersonTextSourceFailureObservationV1 } from '../application/ports/person-text-source-v1.js';

type ExtractionRepository = Pick<PersonDocumentRepositoryV1, 'claimExtraction' | 'completeExtraction' | 'sourceAdmission'>;
type Extract = (input: DocumentExtractionInput, signal?: AbortSignal) => Promise<DocumentExtractionResult>;
export type PersonDocumentProcessingWorkStateV1 = 'idle' | 'skipped' | 'admitted' | 'busy';
export type PersonDocumentProcessingFailureObservationV1 = PersonTextSourceFailureObservationV1 | {
  readonly stage: 'source_admission'; readonly error_code: 'source_admission_failed';
} | {
  readonly stage: 'document_extraction'; readonly error_code: 'document_extraction_failed';
} | {
  readonly stage: 'document_completion'; readonly error_code: 'document_completion_failed';
};
export interface PersonDocumentProcessingOptionsV1 {
  readonly on_failure?: (event: PersonDocumentProcessingFailureObservationV1) => void;
}
type ProcessingFailureStageV1 = 'source_admission' | 'document_extraction' | 'document_completion';
function processingFailureV1(stage: ProcessingFailureStageV1): PersonDocumentProcessingFailureObservationV1 {
  switch (stage) {
    case 'source_admission': return {stage,error_code:'source_admission_failed'};
    case 'document_extraction': return {stage,error_code:'document_extraction_failed'};
    case 'document_completion': return {stage,error_code:'document_completion_failed'};
  }
}

/** Model-independent extraction; one claim and parser at a time. */
export class PersonDocumentProcessingV1 {
  private running = false;
  private readonly source: PersonSourceAdapterV1;
  constructor(private readonly repository: ExtractionRepository, private readonly extract: Extract = extractDocument, texts?:PersonTextSourceInboxV1, private readonly options:PersonDocumentProcessingOptionsV1={}) { this.source = new PersonSourceAdapterV1(repository,texts); }
  async runOnce(signal: AbortSignal): Promise<PersonDocumentProcessingWorkStateV1> {
    if (this.running) return 'busy';
    this.running = true;
    try {
      signal.throwIfAborted();
      let stage: ProcessingFailureStageV1 = 'source_admission';
      try {
        return await withoutCoreRuntimeContentV1(async () => {
          let failures: readonly PersonTextSourceFailureObservationV1[]=[];
          const batch = await (async () => {
            try { return await pullAndAdmitSourceBatchV1({ source:this.source,request:{limit:1},admission:{store:this.repository.sourceAdmission,scope:source=>this.source.scopeFor(source)},context:{signal} }); }
            finally {
              failures=this.source.takeFailureObservations();
              for(const failure of failures)this.observe(failure);
            }
          })();
          const admitted = batch.sources[0];
          if (admitted === undefined) return failures.length===0 ? 'idle' : 'skipped';
          // Editor text is already indexed and readable; it needs no file decoder.
          if (admitted.content.kind === 'person-text') return 'admitted';
          const claim = this.source.claimFor(admitted);
          stage='document_extraction';
          const result = await this.extract({ bytes: claim.bytes, filename: claim.filename, sourceSha256: claim.source_sha256 }, signal);
          // Shutdown leaves the lease recoverable; a stale parser never commits.
          signal.throwIfAborted();
          stage='document_completion';
          this.repository.completeExtraction(claim, result);
          return 'admitted';
        });
      } catch (error) {
        if (!signal.aborted) this.observe(processingFailureV1(stage));
        throw error;
      }
    } finally { this.running = false; }
  }
  private observe(event:PersonDocumentProcessingFailureObservationV1):void { try { this.options.on_failure?.(event); } catch {} }
}

/** Start with the API, including when no answer/enrichment model is configured. */
export function startPersonDocumentProcessingV1(repository: ExtractionRepository, texts?:PersonTextSourceInboxV1, options:PersonDocumentProcessingOptionsV1={}): { wake(): void; close(): Promise<void> } {
  const report=(event:PersonDocumentProcessingFailureObservationV1):void=>{try{options.on_failure?.(event);}catch{}};
  const worker = new PersonDocumentProcessingV1(repository,extractDocument,texts,{on_failure:report});
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  let active = false;
  let wakeRequested = false;
  let idleDelay = 250;
  const IDLE_MAX_MS = 5_000;
  const schedule = (delay: number): void => {
    if (abort.signal.aborted || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      active = true;
      running = worker.runOnce(abort.signal).then(state => {
        const idle=state==='idle';
        const next=idle ? idleDelay : state==='skipped' ? 250 : 0;
        idleDelay=idle ? Math.min(IDLE_MAX_MS,idleDelay*2) : 250;
        return next;
      }, () => {
        const next=idleDelay;
        idleDelay=Math.min(IDLE_MAX_MS,idleDelay*2);
        return next;
      }).then(delayAfterRun => {
        active = false;
        const next = wakeRequested ? 0 : delayAfterRun;
        wakeRequested = false;
        schedule(next);
      });
    }, delay);
    timer.unref();
  };
  schedule(0);
  return {
    wake() {
      if (abort.signal.aborted) return;
      idleDelay = 250;
      if (active) { wakeRequested = true; return; }
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      schedule(0);
    },
    async close() {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
