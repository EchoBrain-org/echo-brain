import type { ProductStatePaths } from '../paths.js';
import { assertFederationId } from './identifiers.js';
import { ImmutableFederationDocumentStore } from './immutable-document-store.js';

export function identityManifestFilename(manifestId: string): string {
  assertFederationId(manifestId, 'idm', 'manifest_id');
  return `identity-manifest.${manifestId}.v1.json`;
}

export class IdentityManifestStore extends ImmutableFederationDocumentStore {
  constructor(paths: ProductStatePaths) {
    super(paths.identityManifests, 'identity manifest');
  }
}
