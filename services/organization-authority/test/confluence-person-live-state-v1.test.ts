import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertPrivateConfluencePersonLiveDatabaseV1,
  bindConfluencePersonLiveStateV1,
} from '../src/composition/confluence-person-live-state-v1.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';

const roots: string[] = [];
const CLOUD_ID = '11111111-1111-4111-8111-111111111111';

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(): { readonly state_directory: string; readonly database_path: string } {
  const root = mkdtempSync(join(tmpdir(), 'echo-confluence-state-'));
  roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'),
    organization_display_name: 'Fixture',
    owner_display_name: 'Founder',
    created_at: '2026-10-05T00:00:00.000Z',
    creating_artifact_revision: 'confluence-state-fixture',
  });
  return Object.freeze({
    state_directory: initialized.state_directory,
    database_path: join(initialized.state_directory, 'confluence-person-connections.sqlite'),
  });
}

it('binds the durable person connection state to the current Authority lineage and Cloud selection across restart', () => {
  const state = fixture();
  const first = new Database(state.database_path);
  chmodSync(state.database_path, 0o600);
  bindConfluencePersonLiveStateV1({ database: first, state_directory: state.state_directory, cloud_id: CLOUD_ID, integration_id: 'confluence' });
  first.close();

  assertPrivateConfluencePersonLiveDatabaseV1(state.database_path);
  const restarted = new Database(state.database_path);
  expect(() => bindConfluencePersonLiveStateV1({ database: restarted, state_directory: state.state_directory, cloud_id: CLOUD_ID, integration_id: 'confluence' })).not.toThrow();
  expect(() => bindConfluencePersonLiveStateV1({ database: restarted, state_directory: state.state_directory, cloud_id: CLOUD_ID, integration_id: 'another-confluence' })).toThrow('does not match the selected Authority lineage and Cloud target');
  restarted.close();
});

it('refuses a durable connection database that is readable by group or other users', () => {
  const state = fixture();
  const database = new Database(state.database_path);
  database.close();
  chmodSync(state.database_path, 0o644);
  expect(() => assertPrivateConfluencePersonLiveDatabaseV1(state.database_path)).toThrow('database is not a private regular file');
});
