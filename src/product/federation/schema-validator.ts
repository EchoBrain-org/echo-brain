import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parseJson } from '../../util/json.js';
import { assertUtcMillisecondTimestamp } from './foundation/identifiers.js';

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
const validators = new Map<string, ValidateFunction>();

export class FederationSchemaError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'FederationSchemaError';
  }
}

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath === '' ? '/' : error.instancePath;
    return `${location} ${error.message ?? error.keyword}`;
  });
}

export function validateDocumentAgainstSchema<T>(
  kind: string,
  schemaUrl: URL,
  value: unknown,
): T {
  let validate = validators.get(schemaUrl.href);
  if (validate === undefined) {
    const schema = parseJson<object>(readFileSync(schemaUrl, 'utf8'));
    validate = ajv.compile(schema);
    validators.set(schemaUrl.href, validate);
  }
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
