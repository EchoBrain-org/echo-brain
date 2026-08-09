import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
  ORGANIZATION_API_ACCESS_LEASES_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  ORGANIZATION_API_RECORD_ENVELOPES_PATH,
} from '@echo-brain/organization-api';
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/http-server.js';
import { AuthorityOperationError } from '../src/domain/errors.js';
import { OrganizationRecordIngestRejectionError } from '../src/application/organization-record-ingest.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationRecordHttpApplication } from '../src/presentation/organization-record-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';
import {
  approvalId,
  createRecordIngestFixture,
} from './support/record-ingest-fixture.js';

const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    'content-type': 'application/json',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('record-client')
      .digest('base64url')}`,
  };
}

function application(): OrganizationAuthorityHttpApplication {
  const unexpected = (): never => {
    throw new Error('unexpected authority application call');
  };
  return {
    descriptor: unexpected,
    adminOverview: unexpected,
    listMemberships: unexpected,
    listInstallations: unexpected,
    listEnrollmentGrants: unexpected,
    listAudit: unexpected,
    internalLiveRolloutStatus: unexpected,
    approveInternalLiveRelease: unexpected,
    fetchInternalLiveDirective: unexpected,
    recordInternalLiveUpdateReceipt: unexpected,
    provisionMembership: unexpected,
    issueEnrollmentGrant: unexpected,
    completeEnrollment: unexpected,
    issueAccessLease: unexpected,
    checkPermissionSubject: unexpected,
    revokeMembership: unexpected,
    revokeInstallation: unexpected,
  };
}

async function withServer<T>(
  options: Partial<OrganizationAuthorityHttpServerOptions>,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server: Server = createOrganizationAuthorityHttpServer({
    application: application(),
    adminAuthenticator: { authenticate: () => true },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(origin);
  } finally {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}

function recordsApplication(
  submit: OrganizationRecordHttpApplication['submitRecordEnvelope'],
): OrganizationRecordHttpApplication {
  return { submitRecordEnvelope: submit };
}

/**
 * A body that is syntactically JSON of a chosen raw size. The route's raw cap
 * runs before parsing and before validation, so the payload never has to be a
 * real envelope to prove the limit.
 */
function bodyOfBytes(bytes: number): string {
  const wrapper = '{"record_envelope":{"filler":""}}';
  return `{"record_envelope":{"filler":"${'x'.repeat(
    Math.max(0, bytes - wrapper.length),
  )}"}}`;
}

describe('organization record ingest route', () => {
  // One real signed envelope and its real signed receipt. Route mapping is
  // only meaningful past validation, which no hand-written object survives.
  let validEnvelope: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof createRecordIngestFixture>>['approvalEnvelope']
    >
  >;
  let validReceipt: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof createRecordIngestFixture>>['runtime']['submitRecordEnvelope']
    >
  >['record_receipt'];

  beforeAll(async () => {
    const fixture = await createRecordIngestFixture();
    try {
      const id = approvalId('http-route-envelope');
      validEnvelope = await fixture.approvalEnvelope({
        approval_id: id,
        authorization: fixture.authorize({
          approval_id: id,
          action: 'approve',
        }),
      });
      validReceipt = (
        await fixture.runtime.submitRecordEnvelope({
          record_envelope: validEnvelope,
        })
      ).record_receipt;
    } finally {
      await fixture.close();
    }
  });

  it('accepts a raw body far above the shared API limit', async () => {
    const submit = vi.fn(async () => {
      throw new AuthorityOperationError('invalid_request', 'reached');
    });
    const oversizeForOtherRoutes = MAX_ORGANIZATION_API_BODY_BYTES + 4096;
    expect(oversizeForOtherRoutes).toBeLessThan(
      MAX_ORGANIZATION_RECORD_API_BODY_BYTES,
    );

    const status = await withServer(
      { records: recordsApplication(submit) },
      async (origin) => {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
          {
            method: 'POST',
            headers: proxyHeaders(),
            body: bodyOfBytes(oversizeForOtherRoutes),
          },
        );
        return response.status;
      },
    );

    // 400 from validation, not 413: the raw bytes were accepted and parsed.
    expect(status).toBe(400);
  });

  it('refuses a raw body above the record limit with the terminal code', async () => {
    const result = await withServer(
      {
        records: recordsApplication(async () => {
          throw new Error('the route must refuse before reaching ingest');
        }),
      },
      async (origin) => {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
          {
            method: 'POST',
            headers: proxyHeaders(),
            body: bodyOfBytes(MAX_ORGANIZATION_RECORD_API_BODY_BYTES + 1),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as { error: { code: string } },
        };
      },
    );

    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('record_envelope_too_large');
  });

  it('leaves the shared body limit unchanged on every other route', async () => {
    const status = await withServer({}, async (origin) => {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_ACCESS_LEASES_PATH}`,
        {
          method: 'POST',
          headers: proxyHeaders(),
          body: bodyOfBytes(MAX_ORGANIZATION_API_BODY_BYTES + 1),
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as { error: { code: string } },
      };
    });

    expect(status.status).toBe(413);
    expect(status.body.error.code).toBe('payload_too_large');
  });

  it('maps terminal ingest rejections to their exact codes', async () => {
    for (const [code, expectedStatus] of [
      ['record_envelope_invalid', 400],
      ['record_signature_invalid', 400],
      ['record_authorization_invalid', 400],
      ['record_envelope_too_large', 400],
      ['record_idempotency_conflict', 409],
    ] as const) {
      const result = await withServer(
        {
          records: recordsApplication(async () => {
            throw new OrganizationRecordIngestRejectionError(code, 'refused');
          }),
        },
        async (origin) => {
          const response = await fetch(
            `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
            {
              method: 'POST',
              headers: proxyHeaders(),
              body: JSON.stringify({ record_envelope: validEnvelope }),
            },
          );
          return {
            status: response.status,
            body: (await response.json()) as { error: { code: string } },
          };
        },
      );
      expect(result.status).toBe(expectedStatus);
      expect(result.body.error.code).toBe(code);
    }
  });

  it('keeps a lease failure retryable rather than terminal', async () => {
    const result = await withServer(
      {
        records: recordsApplication(async () => {
          throw new AuthorityOperationError(
            'unauthorized',
            'lease expired',
          );
        }),
      },
      async (origin) => {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
          {
            method: 'POST',
            headers: proxyHeaders(),
            body: JSON.stringify({ record_envelope: validEnvelope }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as { error: { code: string } },
        };
      },
    );

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('unauthorized');
  });

  it('returns the accepted receipt for a valid submission', async () => {
    const accepted = await withServer(
      {
        records: recordsApplication(async (request) => {
          expect(request.record_envelope.envelope_id).toBe(
            validEnvelope.envelope_id,
          );
          return { record_receipt: validReceipt };
        }),
      },
      async (origin) => {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
          {
            method: 'POST',
            headers: proxyHeaders(),
            body: JSON.stringify({ record_envelope: validEnvelope }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            record_receipt: { position: number; kind: string };
          },
        };
      },
    );

    expect(accepted.status).toBe(200);
    expect(accepted.body.record_receipt.kind).toBe(
      'echo-organization-record-receipt',
    );
    expect(accepted.body.record_receipt.position).toBe(1);
  });

  it('returns not found when the process hosts no record module', async () => {
    const result = await withServer({}, async (origin) => {
      const response = await fetch(
        `${origin}${ORGANIZATION_API_RECORD_ENVELOPES_PATH}`,
        {
          method: 'POST',
          headers: proxyHeaders(),
          body: JSON.stringify({ record_envelope: {} }),
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as { error: { code: string } },
      };
    });

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('not_found');
    expect(ADMIN_TOKEN.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(bodyOfBytes(64))).toBe(64);
  });
});
