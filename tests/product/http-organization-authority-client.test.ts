import { describe, expect, it, vi } from 'vitest';
import { OrganizationAuthorityConflictError } from '../../src/product/organization/client/authority-client.js';
import {
  HttpOrganizationAuthorityClient,
  OrganizationAuthorityTransportError,
} from '../../src/product/organization/client/http-organization-authority-client.js';
import {
  GRANT,
  signedAccessLeaseRequest,
  signedEnrollmentRequest,
  TestAuthority,
  TestInstallationSigner,
} from '../support/local-organization-fixtures.js';

describe('HTTP organization authority client', () => {
  it('puts the enrollment grant only in the authorization header', async () => {
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    const request = await signedEnrollmentRequest(
      authority,
      installationSigner,
    );
    let observed = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      observed = true;
      expect(String(input)).toBe('https://authority.example/v1/enrollments');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(
        `Echo-Enrollment ${GRANT.toString('base64url')}`,
      );
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual({ enrollment_request: request });
      expect(body).not.toContain(GRANT.toString('utf8'));
      expect(body).not.toContain(GRANT.toString('base64url'));
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify(await authority.complete(request)), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: fetchImpl,
    });

    await expect(
      client.completeEnrollment({
        enrollmentGrant: Uint8Array.from(GRANT),
        enrollmentRequest: request,
      }),
    ).resolves.toMatchObject({
      enrollment_receipt: { kind: 'echo-organization-enrollment-receipt' },
      access_state: {
        kind: 'echo-organization-installation-access-state',
      },
    });
    expect(observed).toBe(true);
  });

  it('classifies a valid access-state 409 as a stale-state conflict', async () => {
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    const enrollmentRequest = await signedEnrollmentRequest(
      authority,
      installationSigner,
    );
    const completion = await authority.complete(enrollmentRequest);
    const currentState = await authority.nextActiveState(
      enrollmentRequest,
      completion.enrollment_receipt,
      completion.access_state,
    );
    const accessRequest = await signedAccessLeaseRequest(
      authority,
      installationSigner,
    );
    let postedBody: unknown = null;
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          'https://authority.example/v1/access-leases',
        );
        expect(init?.method).toBe('POST');
        postedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ access_state: currentState }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    try {
      await client.issueAccessLease(accessRequest);
      throw new Error('expected stale-state conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationAuthorityConflictError);
      expect(error).toMatchObject({
        conflict: {
          status: 409,
          response: { access_state: currentState },
        },
      });
    }
    expect(postedBody).toEqual(accessRequest);
  });

  it('does not classify a non-access 409 as a stale access-state conflict', async () => {
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    const request = await signedEnrollmentRequest(
      authority,
      installationSigner,
    );
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'enrollment_conflict',
              message: 'enrollment was rejected',
            },
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });

    try {
      await client.completeEnrollment({
        enrollmentGrant: Uint8Array.from(GRANT),
        enrollmentRequest: request,
      });
      throw new Error('expected enrollment conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(OrganizationAuthorityTransportError);
      expect(error).not.toBeInstanceOf(OrganizationAuthorityConflictError);
      expect(error).toMatchObject({
        code: 'enrollment_conflict',
        status: 409,
      });
    }
  });

  it('rejects malformed success, conflict, and error envelopes as transport failures', async () => {
    const authority = new TestAuthority();
    const installationSigner = new TestInstallationSigner();
    const accessRequest = await signedAccessLeaseRequest(
      authority,
      installationSigner,
    );
    const cases: Array<{
      status: number;
      body: unknown;
      invoke(client: HttpOrganizationAuthorityClient): Promise<unknown>;
    }> = [
      {
        status: 200,
        body: { authority_descriptor: { malformed: true } },
        invoke: (client) => client.readAuthorityDescriptor(),
      },
      {
        status: 409,
        body: { access_state: { malformed: true } },
        invoke: (client) => client.issueAccessLease(accessRequest),
      },
      {
        status: 503,
        body: { error: { code: 'unavailable' } },
        invoke: (client) => client.readAuthorityDescriptor(),
      },
    ];

    for (const testCase of cases) {
      const client = new HttpOrganizationAuthorityClient({
        baseUrl: 'https://authority.example',
        fetch: async () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: { 'content-type': 'application/json' },
          }),
      });
      try {
        await testCase.invoke(client);
        throw new Error('expected malformed response rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(OrganizationAuthorityTransportError);
        expect(error).not.toBeInstanceOf(OrganizationAuthorityConflictError);
        expect(error).toMatchObject({
          code: 'invalid_response',
          status: testCase.status,
        });
      }
    }
  });

  it('stops reading an oversized chunked response before buffering it all', async () => {
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(client.readAuthorityDescriptor()).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });

  it('propagates an unexpected nested validator fault to the caller', async () => {
    const fault = new TypeError('nested protocol validator fault');
    const descriptor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(descriptor, 'schema_version', {
      enumerable: true,
      get() {
        throw fault;
      },
    });
    const parse = vi.spyOn(JSON, 'parse').mockReturnValue({
      authority_descriptor: descriptor,
    });
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json' },
        }),
    });
    try {
      await expect(client.readAuthorityDescriptor()).rejects.toBe(fault);
    } finally {
      parse.mockRestore();
    }
  });
});
