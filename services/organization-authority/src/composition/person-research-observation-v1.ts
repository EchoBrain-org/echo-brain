import {
  coreRuntimeIdentityV1, coreRuntimeDiagnosticErrorKindV1, observeCoreRuntimeDiagnosticV1,
  observeCoreRuntimeRootV1, observeCoreRuntimeV1,
} from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

/** One observation boundary shared by product requests, queued runs and evaluation. */
export function observePersonResearchV1<T>(input: {
  readonly trigger: string;
  readonly run_id: string;
  readonly event_id?: string;
  readonly attempt_id?: string;
  readonly detached?: boolean;
}, operation: () => Promise<T>): Promise<T> {
  const observe = input.detached === true ? observeCoreRuntimeRootV1 : observeCoreRuntimeV1;
  const correlation = { trigger: input.trigger, run_id: coreRuntimeIdentityV1('research-run', input.run_id),
    ...(input.event_id === undefined ? {} : { event_id: coreRuntimeIdentityV1('research-event', input.event_id) }),
    ...(input.attempt_id === undefined ? {} : { attempt_id: coreRuntimeIdentityV1('research-attempt', input.attempt_id) }),
  };
  return observe('research_run', async () => {
    observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'trigger', event: 'started', data: {
      trigger: input.trigger, run_id: input.run_id,
      ...(input.event_id === undefined ? {} : { event_id: input.event_id }),
      ...(input.attempt_id === undefined ? {} : { attempt_id: input.attempt_id }),
    } });
    try {
      const result = await operation();
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'application', event: 'succeeded' });
      return result;
    } catch (error) {
      observeCoreRuntimeDiagnosticV1({ kind: 'lifecycle', stage: 'application', event: 'failed', error_kind: coreRuntimeDiagnosticErrorKindV1(error) });
      throw error;
    }
  }, { correlation });
}
