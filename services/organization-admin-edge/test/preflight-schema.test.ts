import { readFileSync } from 'node:fs';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import type { OrganizationAdminEdgePreflightFailure } from '../src/edge.js';

const schema = JSON.parse(
  readFileSync(
    new URL(
      '../schemas/organization-admin-edge-preflight.v1.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as AnySchema;
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

const DECLARED_PLATFORM = {
  os: 'darwin',
  architecture: 'arm64',
  node: '22.22.1',
  npm: '10.9.4',
} as const;
const SUPPORTED_PLATFORM = {
  os: 'darwin',
  architecture: 'arm64',
  node: '22.22.1',
} as const;
const UNSUPPORTED_PLATFORM = {
  os: 'darwin',
  architecture: 'x64',
  node: '22.22.1',
} as const;
const EDGE_FAILURE_CODES = [
  'server_certificate_parse',
  'server_certificate_hostname',
  'server_certificate_purpose',
  'server_certificate_not_yet_valid',
  'server_certificate_expired',
  'server_private_key_parse',
  'server_private_key_mismatch',
  'client_ca_or_tls_context',
] as const satisfies readonly OrganizationAdminEdgePreflightFailure[];
const LOCAL_FAILURE_CODES = [
  'runtime_config',
  'runtime_material',
  ...EDGE_FAILURE_CODES,
] as const;
const allEdgeFailureCodesListed: Exclude<
  OrganizationAdminEdgePreflightFailure,
  (typeof EDGE_FAILURE_CODES)[number]
> extends never
  ? true
  : never = true;

const SUCCESS = {
  schema_version: 1,
  kind: 'echo-organization-admin-edge-preflight',
  ok: true,
  release_platform_qualified: true,
  declared_platform: DECLARED_PLATFORM,
  observed_platform: SUPPORTED_PLATFORM,
  listener: { host: '0.0.0.0', port: 443 },
  public_origin: 'https://admin.edge.test',
  employee_authority_base_url: 'https://authority.edge.test',
  authority_origin: 'http://127.0.0.1:39479',
  allowed_admin_client_count: 2,
  checked_at: '2026-07-26T12:00:00.000Z',
  server_certificate_not_before: '2026-07-25T12:00:00.000Z',
  server_certificate_not_after: '2026-08-25T12:00:00.000Z',
  client_ca_certificate_count: 1,
} as const;
const RELEASE_PLATFORM_FAILURE = {
  schema_version: 1,
  kind: 'echo-organization-admin-edge-preflight',
  ok: false,
  release_platform_qualified: false,
  declared_platform: DECLARED_PLATFORM,
  observed_platform: UNSUPPORTED_PLATFORM,
  failed_check: 'release_platform',
} as const;
const LOCAL_CANDIDATE_FAILURE = {
  schema_version: 1,
  kind: 'echo-organization-admin-edge-preflight',
  ok: false,
  release_platform_qualified: true,
  declared_platform: DECLARED_PLATFORM,
  observed_platform: SUPPORTED_PLATFORM,
  failed_check: 'runtime_config',
} as const;

function expectValid(
  validator: ValidateFunction,
  value: unknown,
): void {
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
}

function expectInvalid(
  validator: ValidateFunction,
  value: unknown,
): void {
  expect(validator(value), JSON.stringify(validator.errors)).toBe(false);
}

describe('organization administrator edge preflight JSON Schema', () => {
  it('accepts representative success, release-platform, and local-candidate results', () => {
    expect(allEdgeFailureCodesListed).toBe(true);
    expectValid(validate, SUCCESS);
    expectValid(validate, RELEASE_PLATFORM_FAILURE);
    expectValid(validate, LOCAL_CANDIDATE_FAILURE);
  });

  it('accepts every fixed local-candidate failure code', () => {
    for (const failedCheck of LOCAL_FAILURE_CODES) {
      expectValid(validate, {
        ...LOCAL_CANDIDATE_FAILURE,
        failed_check: failedCheck,
      });
    }
  });

  it('rejects unknown, additional, missing, and branch-inconsistent fields', () => {
    expectInvalid(validate, { ...SUCCESS, unexpected: true });
    expectInvalid(validate, {
      ...SUCCESS,
      listener: { ...SUCCESS.listener, unexpected: true },
    });
    expectInvalid(validate, {
      ...SUCCESS,
      listener: { host: 'admin.edge.test', port: 443 },
    });
    expectInvalid(validate, {
      ...SUCCESS,
      listener: { host: '127.0.0.1', port: 0 },
    });
    expectInvalid(validate, {
      ...SUCCESS,
      public_origin: 'https://operator@admin.edge.test',
    });
    expectInvalid(validate, {
      ...SUCCESS,
      authority_origin: 'http://192.0.2.1:39479',
    });
    expectInvalid(validate, {
      ...SUCCESS,
      failed_check: 'runtime_config',
    });
    expectInvalid(validate, {
      ...SUCCESS,
      release_platform_qualified: false,
    });

    const missingTimestamp = {
      ...SUCCESS,
    } as Record<string, unknown>;
    delete missingTimestamp['checked_at'];
    expectInvalid(validate, missingTimestamp);

    expectInvalid(validate, {
      ...RELEASE_PLATFORM_FAILURE,
      release_platform_qualified: true,
    });
    expectInvalid(validate, {
      ...RELEASE_PLATFORM_FAILURE,
      failed_check: 'runtime_config',
    });
    expectInvalid(validate, {
      ...RELEASE_PLATFORM_FAILURE,
      listener: SUCCESS.listener,
    });

    expectInvalid(validate, {
      ...LOCAL_CANDIDATE_FAILURE,
      release_platform_qualified: false,
    });
    expectInvalid(validate, {
      ...LOCAL_CANDIDATE_FAILURE,
      failed_check: 'release_platform',
    });
    expectInvalid(validate, {
      ...LOCAL_CANDIDATE_FAILURE,
      failed_check: 'unknown_check',
    });
    expectInvalid(validate, {
      ...LOCAL_CANDIDATE_FAILURE,
      public_origin: SUCCESS.public_origin,
    });
    expectInvalid(validate, {
      ...LOCAL_CANDIDATE_FAILURE,
      declared_platform: {
        ...DECLARED_PLATFORM,
        architecture: 'x64',
      },
    });
  });
});
