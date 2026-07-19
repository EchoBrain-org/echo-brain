import type { ProductStatePaths } from '../paths.js';
import { assertFederationId } from './identifiers.js';
import { ImmutableFederationDocumentStore } from './immutable-document-store.js';

export function publicationPolicyFilename(policyId: string, version: number): string {
  assertFederationId(policyId, 'pol', 'policy_id');
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('publication policy version must be a positive safe integer');
  }
  return `publication-policy.${policyId}.v${version}.json`;
}

export class PublicationPolicyStore extends ImmutableFederationDocumentStore {
  constructor(paths: ProductStatePaths) {
    super(paths.identityPolicies, 'publication policy');
  }
}
