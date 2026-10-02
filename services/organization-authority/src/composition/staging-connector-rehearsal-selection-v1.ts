import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { validateStagingConnectorRehearsalProfileV1 } from './staging-connector-rehearsal-protocol-v1.js';

/** Only the prepared, host-owned profile can opt the staging service into rehearsal. */
export function readStagingConnectorRehearsalSelectionV1(input: {
  readonly state_directory: string;
  readonly authority_url: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const requested = input.environment.ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE;
  if (requested === undefined || requested === '') return undefined;
  const release_id = input.environment.ECHO_CLEAN_RELEASE_ID ?? '';
  const authority_host = input.environment.ECHO_CLEAN_AUTHORITY_HOST ?? '';
  const expected = join(dirname(input.state_directory), 'private', 'staging-connector-rehearsal.json');
  if (input.authority_url !== STAGING_AUTHORITY_ORIGIN_V1 ||
      authority_host !== new URL(STAGING_AUTHORITY_ORIGIN_V1).hostname ||
      !/^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/.test(release_id) ||
      !isAbsolute(input.state_directory) || resolve(input.state_directory) !== input.state_directory ||
      requested !== expected || realpathSync(requested) !== expected) {
    throw new Error('Staging connector rehearsal selection is invalid');
  }
  const file = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o777) !== 0o600 ||
        state.size < 1 || state.size > 8192) throw new Error('Staging connector rehearsal profile file is invalid');
    const bytes = Buffer.alloc(8193);
    const length = readSync(file, bytes, 0, bytes.length, 0);
    const after = fstatSync(file);
    if (length !== state.size || length > 8192 || state.size !== after.size || state.mtimeMs !== after.mtimeMs ||
        state.ctimeMs !== after.ctimeMs) throw new Error('Staging connector rehearsal profile changed while reading');
    const profile = validateStagingConnectorRehearsalProfileV1(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
    return Object.freeze({ profile, release_id, authority_host });
  } finally { closeSync(file); }
}
