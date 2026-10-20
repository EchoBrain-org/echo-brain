import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfluencePersonLiveRuntimeV1 } from '../src/composition/confluence-person-live-runtime-v1.js';
import { openJiraPersonLiveRuntimeV1 } from '../src/composition/jira-person-live-runtime-v1.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function stateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-provider-state-'));
  roots.push(root);
  return bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'),
    organization_display_name: 'Fixture',
    owner_display_name: 'Founder',
    created_at: '2026-10-05T00:00:00.000Z',
    creating_artifact_revision: 'provider-state-fixture',
  }).state_directory;
}

const sessions = { authenticateAccess: () => { throw new Error('not used'); } } as never;
const fetch = async () => { throw new Error('no network'); };
const RUNTIMES = {
  jira: {
    file: 'jira-person-connections.sqlite',
    open: (state_directory: string, database?: Database.Database) => openJiraPersonLiveRuntimeV1({ state_directory, sessions,
      configuration: { enabled: true, cloud_id: '00000000-0000-4000-8000-000000000007', integration_id: 'jira', nango_authorization: () => 'not used' },
      seams: { fetch, ...(database === undefined ? {} : { database }) } }),
  },
  confluence: {
    file: 'confluence-person-connections.sqlite',
    open: (state_directory: string, database?: Database.Database) => openConfluencePersonLiveRuntimeV1({ state_directory, sessions,
      configuration: { enabled: true, cloud_id: '11111111-1111-4111-8111-111111111111', integration_id: 'confluence', nango_authorization: () => 'not used' },
      seams: { fetch, ...(database === undefined ? {} : { database }) } }),
  },
} as const;
const mode = (path: string) => statSync(path).mode & 0o777;

describe.each(Object.keys(RUNTIMES) as (keyof typeof RUNTIMES)[])('the %s connection database', (tool) => {
  const runtime = RUNTIMES[tool];

  it('is created private', () => {
    const state = stateDirectory(), path = join(state, runtime.file);
    runtime.open(state).close();
    expect(mode(path)).toBe(0o600);
  });

  it('refuses a file other users can read, as one an earlier release left, and opens it once it is private', () => {
    const state = stateDirectory(), path = join(state, runtime.file);
    runtime.open(state).close();
    // Releases before this check opened Jira's file with the process umask: 0644 under the default 022.
    chmodSync(path, 0o644);
    expect(() => runtime.open(state)).toThrow(`Connector database is not a private regular file: ${runtime.file}`);
    // Refused before it is opened, never repaired: the operator makes it private.
    expect(mode(path)).toBe(0o644);
    chmodSync(path, 0o600);
    runtime.open(state).close();
    expect(mode(path)).toBe(0o600);
  });

  it('uses a supplied database as given, without file checks', () => {
    const database = new Database(':memory:');
    try {
      runtime.open('/never-used', database).close();
      expect(database.open).toBe(true);
      expect(existsSync(join('/never-used', runtime.file))).toBe(false);
    } finally { database.close(); }
  });
});
