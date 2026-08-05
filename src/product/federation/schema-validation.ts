import { validateDocumentAgainstSchema } from './schema-validator.js';

export {
  assertFederationDocumentSize,
  FederationSchemaError,
} from './schema-validator.js';

export type FederationSchemaKind =
  | 'active-identity-bundle'
  | 'local-identity-manifest'
  | 'local-connection-registry'
  | 'publication-policy';

const SCHEMA_FILES: Readonly<Record<FederationSchemaKind, string>> = Object.freeze({
  'active-identity-bundle': 'active-identity-bundle.v1.schema.json',
  'local-identity-manifest': 'local-identity-manifest.v1.schema.json',
  'local-connection-registry': 'local-connection-registry.v1.schema.json',
  'publication-policy': 'publication-policy.v1.schema.json',
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
