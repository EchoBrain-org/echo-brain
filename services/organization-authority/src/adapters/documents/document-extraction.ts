import { Worker } from 'node:worker_threads';
import {
  DOCUMENT_EXTRACTION_LIMITS, DOCUMENT_EXTRACTOR_VERSION,
  type DocumentExtractionInput, type DocumentExtractionResult, type ExtractionBudgets,
} from './document-extraction-types.js';

export * from './document-extraction-types.js';

// One parser per Authority process, including across extractor instances. The
// runtime normally claims one job at a time; bound accidental queued callers too.
let preceding: Promise<void> = Promise.resolve();
let waiting = 0;

function failed(input: DocumentExtractionInput, status: DocumentExtractionResult['status'], message: string): DocumentExtractionResult {
  return { status, mediaType: null, sourceSha256: input.sourceSha256,
    extractorVersion: DOCUMENT_EXTRACTOR_VERSION, chunks: [], message };
}

/** Lower budgets are useful for hermetic boundary proofs; callers cannot raise production limits. */
export function createDocumentExtractor(overrides: Partial<ExtractionBudgets> = {}) {
  const limits: ExtractionBudgets = { ...DOCUMENT_EXTRACTION_LIMITS };
  for (const name of Object.keys(limits) as (keyof ExtractionBudgets)[]) {
    const value = overrides[name];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new Error('Invalid extraction budget');
      limits[name] = value;
    }
  }
  return async (input: DocumentExtractionInput, signal?: AbortSignal): Promise<DocumentExtractionResult> => {
    if (input.bytes.byteLength > limits.originalBytes) return failed(input, 'limit_exceeded', 'Original exceeds the document size limit.');
    if (waiting >= 2) return failed(input, 'unavailable', 'The document extraction worker is busy; retry is required.');
    waiting++;
    const previous = preceding;
    let release!: () => void;
    preceding = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) return failed(input, 'unavailable', 'Text extraction was cancelled.');
      return await new Promise<DocumentExtractionResult>((resolve) => {
        const bytes = Uint8Array.from(input.bytes);
        // Source-level Vitest imports still execute the exact built worker.
        const workerSourceUrl = new URL('./document-extraction-worker.js', import.meta.url);
        const workerUrl = import.meta.url.endsWith('.ts')
          ? new URL(workerSourceUrl.href.replace('/src/adapters/documents/', '/dist/adapters/documents/'))
          : workerSourceUrl;
        const worker = new Worker(workerUrl, {
          workerData: { input: { ...input, bytes }, limits },
          transferList: [bytes.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          // Do not propagate operator flags/loaders or parser output to service logs.
          execArgv: [], stdout: true, stderr: true,
        });
        worker.stdout.resume(); worker.stderr.resume();
        let finished = false;
        const finish = async (result: DocumentExtractionResult) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          // Await termination before admitting the next job, even on timeout.
          await worker.terminate();
          resolve(result);
        };
        const timer = setTimeout(() => {
          void finish(failed(input, 'timed_out', 'Text extraction exceeded its time limit.'));
        }, limits.timeoutMs);
        const abort = () => { void finish(failed(input, 'unavailable', 'Text extraction was cancelled.')); };
        signal?.addEventListener('abort', abort, { once: true });
        worker.once('message', (result: DocumentExtractionResult) => { void finish(result); });
        worker.once('error', (error: NodeJS.ErrnoException) => {
          void finish(failed(input, error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'limit_exceeded' : 'unavailable',
            error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Text extraction exceeded its memory limit.' : 'The text extraction worker failed.'));
        });
        worker.once('exit', () => { if (!finished) void finish(failed(input, 'unavailable', 'The text extraction worker exited before completion.')); });
      });
    } finally { waiting--; release(); }
  };
}

export const extractDocument = createDocumentExtractor();
