import { verifyAuthorityStateLineage } from '@echo-brain/organization-authority-kernel/composition/verify-authority-state-lineage';
import type Database from 'better-sqlite3';
import { assertPrivatePersonProviderDatabaseV1, bindPersonProviderStateV1 } from './person-provider-state-v1.js';

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
export const assertPrivateConfluencePersonLiveDatabaseV1 = assertPrivatePersonProviderDatabaseV1;
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
  bindPersonProviderStateV1(input.database, 'authority_confluence_person_live_binding_v1', wanted,
    'Confluence live state does not match the selected Authority lineage and Cloud target');
}
