import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { createStagingSyntheticPersonalMeetingProviderV1, StagingSyntheticMeetingStoreV1 } from '@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1';
import { assertPrivatePersonProviderDatabaseV1, bindPersonProviderStateV1 } from '../person-provider-state-v1.js';

/** Open only after the Authority has verified its private state directory and lineage. */
export function openStagingSyntheticPersonalProviderV1(options: {
  readonly authority_url: string; readonly state_directory: string;
  readonly coordinates: { readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string };
  readonly fixtures_directory?: string;
}) {
  if (options.authority_url !== STAGING_AUTHORITY_ORIGIN_V1) throw new Error('Custom synthetic meetings require the staging Authority');
  const path = join(options.state_directory, 'staging-synthetic-meetings.sqlite');
  assertPrivatePersonProviderDatabaseV1(path);
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma('busy_timeout = 5000'); db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL');
    bindPersonProviderStateV1(db, 'authority_staging_synthetic_binding_v1', { schema_version: 1, ...options.coordinates }, 'Synthetic meetings differ from the Authority lineage');
    const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(db),
      ...(options.fixtures_directory === undefined ? {} : { fixtures_directory: options.fixtures_directory }) });
    return { provider, close() { db.close(); } };
  } catch (error) { db.close(); throw error; }
}
