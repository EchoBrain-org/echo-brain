import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parseJson } from '../../util/json.js';
import { assertUtcMillisecondTimestamp } from './foundation/identifiers.js';

export type FederationSchemaKind =
  | 'active-identity-bundle'
  | 'local-identity-manifest'
  | 'local-connection-registry'
  | 'publication-policy'
  | 'source-attribution'
  | 'processor-attribution'
  | 'approval-federation-metadata'
  | 'federated-record-envelope'
  | 'federated-export'
  | 'federated-recovery-report';

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
  'federated-recovery-report': 'federated-recovery-report.v1.schema.json',
});

const MAX_FEDERATION_DOCUMENT_BYTES = 4 * 1024 * 1024;
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat('utc-millisecond-timestamp', {
  type: 'string',
  validate: (value: string): boolean => {
    try {
      assertUtcMillisecondTimestamp(value, 'timestamp');
      return true;
    } catch {
      return false;
    }
  },
});
const validators = new Map<FederationSchemaKind, ValidateFunction>();

export class FederationSchemaError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'FederationSchemaError';
  }
}

function schemaUrl(kind: FederationSchemaKind): URL {
  return new URL(`../../../schemas/product/${SCHEMA_FILES[kind]}`, import.meta.url);
}

function validator(kind: FederationSchemaKind): ValidateFunction {
  const existing = validators.get(kind);
  if (existing !== undefined) return existing;
  const schema = parseJson<object>(readFileSync(schemaUrl(kind), 'utf8'));
  const compiled = ajv.compile(schema);
  validators.set(kind, compiled);
  return compiled;
}

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath === '' ? '/' : error.instancePath;
    return `${location} ${error.message ?? error.keyword}`;
  });
}

export function validateFederationDocument<T>(
  kind: FederationSchemaKind,
  value: unknown,
): T {
  const validate = validator(kind);
  if (!validate(value)) {
    const issues = formatErrors(validate.errors);
    throw new FederationSchemaError(
      `invalid ${kind} document: ${issues.join('; ')}`,
      issues,
    );
  }
  return value as T;
}

export function assertFederationDocumentSize(raw: Buffer | string, label: string): void {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (size === 0 || size > MAX_FEDERATION_DOCUMENT_BYTES) {
    throw new Error(`${label} must be between 1 and ${MAX_FEDERATION_DOCUMENT_BYTES} bytes`);
  }
}
