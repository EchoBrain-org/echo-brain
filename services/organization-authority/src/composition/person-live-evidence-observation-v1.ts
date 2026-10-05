import { annotateCoreRuntimeV1, observeCoreRuntimeV1, withoutCoreRuntimeContentV1, type CoreRuntimeDetailV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

function failureResult(error: unknown): CoreRuntimeDetailV1['result'] {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (code === 'timeout' || (error instanceof Error && error.name === 'TimeoutError')) return 'timeout';
  if (code === 'unauthorized' || code === 'stale_access_state') return 'authorization';
  if (code === 'rate_limited' || code === 'invalid_output' || code === 'not_found') return code;
  return 'unavailable';
}

/** Source categories and counts only: provider failures must not enter content capture. */
export function observePersonLiveEvidenceV1<T>(phase: 'evidence_connection' | 'evidence_search' | 'evidence_list' | 'evidence_open', source: NonNullable<CoreRuntimeDetailV1['evidence_source']>, operation: () => Promise<T>): Promise<T> {
  return withoutCoreRuntimeContentV1(() => observeCoreRuntimeV1(phase, async () => {
    annotateCoreRuntimeV1({ evidence_source: source });
    try { return await operation(); }
    catch (error) {
      try { annotateCoreRuntimeV1({ result: failureResult(error) }); }
      catch { /* Observation cannot replace the provider's error. */ }
      throw error;
    }
  }));
}
