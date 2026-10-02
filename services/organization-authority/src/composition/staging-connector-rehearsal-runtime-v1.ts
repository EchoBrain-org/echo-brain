import type { OrganizationAuthorityServiceConfig } from './organization-authority-composition-root.js';
import { openStagingConnectorRehearsalService, type StagingConnectorRehearsalSelectionV1, type StagingConnectorRehearsalRuntimeDependenciesV1 } from './staging-connector-rehearsal-runtime.js';
export type { StagingConnectorRehearsalSelectionV1, StagingConnectorRehearsalRuntimeDependenciesV1 } from './staging-connector-rehearsal-runtime.js';

/** Existing callers retain the closed V1 profile and wire contract. */
export function openStagingConnectorRehearsalServiceV1(
  config: OrganizationAuthorityServiceConfig,
  selection: StagingConnectorRehearsalSelectionV1,
  dependencies: StagingConnectorRehearsalRuntimeDependenciesV1 = {},
) {
  if (selection.profile.schema_version !== 1) throw new Error('Staging connector rehearsal V1 selection is invalid');
  return openStagingConnectorRehearsalService(config, selection, dependencies);
}
