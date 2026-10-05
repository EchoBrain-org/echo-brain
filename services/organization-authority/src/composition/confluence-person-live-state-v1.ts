import { canonicalJson } from '@echo-brain/federation-protocol';
import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import type Database from 'better-sqlite3';
import { existsSync, lstatSync } from 'node:fs';

const CLOUD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INTEGRATION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ConfluencePersonLiveStateBindingV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-confluence-person-live-state-binding-v1';
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly cloud_id: string;
  readonly integration_id: string;
}

function invalid(message: string): never { throw new Error(`Confluence live state ${message}`); }
export function assertPrivateConfluencePersonLiveDatabaseV1(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) invalid('database is not a private regular file');
}
function expected(stateDirectory: string, cloud_id: string, integration_id: string): ConfluencePersonLiveStateBindingV1 {
  if (!CLOUD_ID.test(cloud_id) || !INTEGRATION.test(integration_id)) invalid('selection is invalid');
  const lineage = verifyAuthorityStateLineage(stateDirectory).root;
  return Object.freeze({
    schema_version: 1,
    kind: 'echo-confluence-person-live-state-binding-v1',
    authority_id: lineage.authority_id,
    organization_id: lineage.organization_id,
    state_lineage_id: lineage.state_lineage_id,
    cloud_id,
    integration_id,
  });
}
function parse(value: string): ConfluencePersonLiveStateBindingV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid('binding is invalid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('binding is invalid');
  const entry = parsed as Record<string, unknown>;
  const keys = ['authority_id', 'cloud_id', 'integration_id', 'kind', 'organization_id', 'schema_version', 'state_lineage_id'];
  if (Object.keys(entry).sort().join(',') !== keys.sort().join(',') || entry.schema_version !== 1 || entry.kind !== 'echo-confluence-person-live-state-binding-v1' ||
      typeof entry.authority_id !== 'string' || typeof entry.organization_id !== 'string' || typeof entry.state_lineage_id !== 'string' ||
      typeof entry.cloud_id !== 'string' || typeof entry.integration_id !== 'string' || !CLOUD_ID.test(entry.cloud_id) || !INTEGRATION.test(entry.integration_id)) invalid('binding is invalid');
  return Object.freeze(entry as unknown as ConfluencePersonLiveStateBindingV1);
}

/**
 * Connection references are durable Person configuration, never live page
 * content. The database carries its exact lineage and provider selection in
 * one SQLite transaction, so a copied or stale sidecar cannot gain scope.
 */
export function bindConfluencePersonLiveStateV1(input: {
  readonly database: Database.Database;
  readonly state_directory: string;
  readonly cloud_id: string;
  readonly integration_id: string;
}): void {
  const wanted = expected(input.state_directory, input.cloud_id, input.integration_id);
  input.database.transaction(() => {
    input.database.exec(`CREATE TABLE IF NOT EXISTS authority_confluence_person_live_binding_v1 (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1), binding_json TEXT NOT NULL
    ) STRICT`);
    const current = input.database.prepare('SELECT binding_json FROM authority_confluence_person_live_binding_v1 WHERE singleton=1').get() as { binding_json: string } | undefined;
    if (current === undefined) {
      input.database.prepare('INSERT INTO authority_confluence_person_live_binding_v1(singleton,binding_json) VALUES (1,?)').run(canonicalJson(wanted as never));
      return;
    }
    if (current.binding_json !== canonicalJson(wanted as never) || canonicalJson(parse(current.binding_json) as never) !== current.binding_json) invalid('does not match the selected Authority lineage and Cloud target');
  })();
}
