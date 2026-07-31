import { validateDocumentAgainstSchema } from './schema-validator.js';

export {
  assertFederationDocumentSize,
  FederationSchemaError,
} from './schema-validator.js';

export type FederationSchemaKind =
  | 'active-identity-bundle'
  | 'local-identity-manifest'
  | 'local-connection-registry'
  | 'publication-policy'
  | 'source-attribution'
  | 'processor-attribution'
  | 'approval-federation-metadata'
  | 'federated-record-envelope'
  | 'federated-export';

const SCHEMA_FILES: Readonly<Record<FederationSchemaKind, string>> = Object.freeze({
  'active-identity-bundle': 'active-identity-bundle.v1.schema.json',
  'local-identity-manifest': 'local-identity-manifest.v1.schema.json',
  'local-connection-registry': 'local-connection-registry.v1.schema.json',
  'publication-policy': 'publication-policy.v1.schema.json',
  'source-attribution': 'source-attribution.v1.schema.json',
  'processor-attribution': 'processor-attribution.v1.schema.json',
  'approval-federation-metadata': 'approval-federation-metadata.v1.schema.json',
  'federated-record-envelope': 'federated-record-envelope.v1.schema.json',
  'federated-export': 'federated-export.v1.schema.json',
});

function schemaUrl(kind: FederationSchemaKind): URL {
  return new URL(`../../../schemas/product/${SCHEMA_FILES[kind]}`, import.meta.url);
}

export function validateFederationDocument<T>(
  kind: FederationSchemaKind,
  value: unknown,
): T {
  return validateDocumentAgainstSchema<T>(kind, schemaUrl(kind), value);
}
