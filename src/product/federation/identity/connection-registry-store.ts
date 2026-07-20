import type { ProductStatePaths } from '../../paths.js';
import { assertFederationId } from '../foundation/identifiers.js';
import { ImmutableFederationDocumentStore } from '../foundation/immutable-document-store.js';

export function connectionRegistryFilename(registryId: string, revision: number): string {
  assertFederationId(registryId, 'reg', 'registry_id');
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('connection registry revision must be a positive safe integer');
  }
  return `connection-registry.${registryId}.r${revision}.v1.json`;
}

export class ConnectionRegistryStore extends ImmutableFederationDocumentStore {
  constructor(paths: ProductStatePaths) {
    super(paths.identityRegistries, 'connection registry');
  }
}
