import { annotateCoreRuntimeV1, currentCoreRuntimeDetailV1, observeCoreRuntimeDiagnosticV1, observeCoreRuntimeV1, type CoreRuntimePhaseV1 } from '../shared/core-runtime-observation-v1.js';
import { coreRuntimeDiagnosticErrorKindV1, type CoreRuntimeDiagnosticEventV1 } from '../shared/core-runtime-diagnostics-v1.js';

type Lifecycle = Extract<CoreRuntimeDiagnosticEventV1, { readonly kind: 'lifecycle' }>;

/** One shared lifecycle for every trigger. Callers project released content; diagnostics never receive server objects. */
export async function observeAgenticLifecycleV1<T>(
  stage: Lifecycle['stage'], phase: CoreRuntimePhaseV1 | undefined, data: Readonly<Record<string, unknown>>,
  operation: () => Promise<T>, completed: (value: T) => Readonly<Record<string, unknown>> = () => ({}),
): Promise<T> {
  // Service entries own the run span. Direct callers with a selected sink still get one correlated root.
  const effectivePhase = phase ?? (stage === 'run' && currentCoreRuntimeDetailV1() === null ? 'research_run' : undefined);
  const run = async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage, event: 'started', data });
    try {
      const result = await operation();
      try { observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage, event: 'succeeded', data: completed(result) }); }
      catch { observeCoreRuntimeDiagnosticV1({ kind: 'capture_error', error_kind: 'snapshot_failed' }); }
      if (effectivePhase !== undefined && currentCoreRuntimeDetailV1()?.result === null) annotateCoreRuntimeV1({ result: 'completed' });
      return result;
    } catch (error) {
      const errorKind = coreRuntimeDiagnosticErrorKindV1(error);
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage, event: 'failed', error_kind: errorKind });
      if (effectivePhase !== undefined) annotateCoreRuntimeV1({ result: errorKind === 'aborted' ? 'cancelled' : errorKind === 'deadline' ? 'timeout' : 'failed' });
      throw error;
    }
  };
  return effectivePhase === undefined ? run() : observeCoreRuntimeV1(effectivePhase, run);
}
