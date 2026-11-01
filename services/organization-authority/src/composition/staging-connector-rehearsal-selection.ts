import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { CLEAN_V1_RELEASE_ID } from './clean-v1-release-id.js';

const STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE = 'staging-connector-rehearsal.json';
const STAGING_CONNECTOR_REHEARSAL_POLICY_V3 = 'initial-owner-jira-pointer-v3';

/** The host-prepared staging connector profile. Its Atlassian site and Jira integration select live Ask sources. */
interface StagingConnectorRehearsalProfileV3 {
  readonly schema_version: 3;
  readonly kind: 'echo-staging-connector-rehearsal-profile-v3';
  readonly read_policy: typeof STAGING_CONNECTOR_REHEARSAL_POLICY_V3;
  readonly jira: {
    readonly cloud_id: string;
    readonly integration_key: string;
    /** Validated with the onboarding manifest; the Authority no longer reads it. */
    readonly project: string;
  };
}

function invalid(): never {
  throw new Error('Staging connector rehearsal value is invalid');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid();
}

function stringMatches(value: unknown, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
}

function validateStagingConnectorRehearsalProfileV3(value: unknown): StagingConnectorRehearsalProfileV3 {
  const profile = record(value);
  keys(profile, ['schema_version', 'kind', 'read_policy', 'jira']);
  if (profile.schema_version !== 3 ||
      profile.kind !== 'echo-staging-connector-rehearsal-profile-v3' ||
      profile.read_policy !== STAGING_CONNECTOR_REHEARSAL_POLICY_V3) invalid();
  const jira = record(profile.jira);
  keys(jira, ['cloud_id', 'integration_key', 'project']);
  stringMatches(jira.cloud_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  stringMatches(jira.integration_key, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  stringMatches(jira.project, /^[A-Z][A-Z0-9_]{1,31}$/);
  return Object.freeze({
    schema_version: 3,
    kind: 'echo-staging-connector-rehearsal-profile-v3',
    read_policy: STAGING_CONNECTOR_REHEARSAL_POLICY_V3,
    jira: Object.freeze({
      cloud_id: jira.cloud_id as string,
      integration_key: jira.integration_key as string,
      project: jira.project as string,
    }),
  });
}

type StagingConnectorRehearsalSelectionInput = {
  readonly state_directory: string;
  readonly authority_url: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

/**
 * Only the prepared, host-owned profile at its fixed path, under the staging
 * Authority's own release identity, selects the staging connectors. It is an
 * input to the ordinary composition root, never a separate one.
 */
export function readStagingConnectorRehearsalSelection(input: StagingConnectorRehearsalSelectionInput): StagingConnectorRehearsalProfileV3 | undefined {
  const requested = input.environment.ECHO_STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE;
  if (requested === undefined || requested === '') return undefined;
  const release_id = input.environment.ECHO_CLEAN_RELEASE_ID ?? '';
  const authority_host = input.environment.ECHO_CLEAN_AUTHORITY_HOST ?? '';
  const expected = join(dirname(input.state_directory), 'private', STAGING_CONNECTOR_REHEARSAL_PROFILE_FILE);
  if (input.authority_url !== STAGING_AUTHORITY_ORIGIN_V1 ||
      authority_host !== new URL(STAGING_AUTHORITY_ORIGIN_V1).hostname ||
      !CLEAN_V1_RELEASE_ID.test(release_id) ||
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
    return validateStagingConnectorRehearsalProfileV3(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
  } finally { closeSync(file); }
}
