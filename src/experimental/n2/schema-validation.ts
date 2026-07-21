import { validateDocumentAgainstSchema } from '../../product/federation/schema-validator.js';

export type N2SchemaKind =
  | 'organization-enrollment-request'
  | 'organization-enrollment-receipt'
  | 'organization-batch-receipt';

const SCHEMA_FILES: Readonly<Record<N2SchemaKind, string>> = Object.freeze({
  'organization-enrollment-request': 'organization-enrollment-request.v1.schema.json',
  'organization-enrollment-receipt': 'organization-enrollment-receipt.v1.schema.json',
  'organization-batch-receipt': 'organization-batch-receipt.v1.schema.json',
});

export function validateN2Document<T>(kind: N2SchemaKind, value: unknown): T {
  return validateDocumentAgainstSchema<T>(
    kind,
    new URL(`./schemas/${SCHEMA_FILES[kind]}`, import.meta.url),
    value,
  );
}
