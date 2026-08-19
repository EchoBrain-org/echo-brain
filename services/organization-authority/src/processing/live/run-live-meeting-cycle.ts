import {
  runCoreCycle,
  type AdapterConfig,
  type CoreCycleDependencies,
  type CoreCycleResult,
} from '../core/index.js';

export type AuthorityLiveAdapterConfig = AdapterConfig;
export type AuthorityLiveMeetingCycleResult = CoreCycleResult;

/** The one fixed live-cycle policy: serialized composition pulls one meeting. */
export async function runAuthorityLiveMeetingCycle(
  dependencies: Omit<CoreCycleDependencies, 'signal'>,
  signal: AbortSignal,
): Promise<CoreCycleResult> {
  return await runCoreCycle(
    { ...dependencies, signal },
    { limit: 1 },
  );
}
