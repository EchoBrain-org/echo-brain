import { readStagingConnectorRehearsalSelectionV1 } from './staging-connector-rehearsal-selection-v1.js';
import { readStagingConnectorRehearsalSelectionV2, STAGING_CONNECTOR_REHEARSAL_PROFILE_PATH_V2 } from './staging-connector-rehearsal-selection-v2.js';

export type StagingConnectorRehearsalSelectionInput = {
  readonly state_directory: string;
  readonly authority_url: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

/** The fixed host-owned file name selects the parser; request bodies never select a version. */
export function readStagingConnectorRehearsalSelection(input: StagingConnectorRehearsalSelectionInput) {
  const requested = input.environment.ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE;
  if (requested !== undefined && requested.endsWith(`/${STAGING_CONNECTOR_REHEARSAL_PROFILE_PATH_V2}`)) {
    return readStagingConnectorRehearsalSelectionV2(input);
  }
  return readStagingConnectorRehearsalSelectionV1(input);
}
