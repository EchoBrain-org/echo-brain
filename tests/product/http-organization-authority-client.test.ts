import { describe, expect, it, vi } from 'vitest';
import { createOrganizationPermissionCheckRequest } from '@echo-brain/organization-api';
import { OrganizationAuthorityConflictError } from '../../src/product/organization/client/authority-client.js';
import {
  HttpOrganizationAuthorityClient,
  OrganizationAuthorityTransportError,
} from '../../src/product/organization/client/http-organization-authority-client.js';
import {
  GRANT,
  NOW,
  ORGANIZATION_IDS,
  allowedPermissionDecision,
  protocolInstallationKey,
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

  it('posts the exact signed permission request and validates its decision', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const request = await createOrganizationPermissionCheckRequest(
      {
        request_id: 'pcr_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        installation_signing_key: signingKey,
        provider: 'slack',
        provider_issuer: 'https://slack.com',
        provider_tenant_kind: 'workspace',
        provider_tenant_id: 'T123TEAM',
        provider_enterprise_id: null,
        provider_connection_subject_id: 'U123BOT',
        provider_connection_bot_id: 'B123BOT',
        provider_connection_app_id: 'A123APP',
        provider_subject_kind: 'human_user',
        provider_subject_id: 'U123ZHEN',
        adapter_kind: 'approval-surface',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'primary',
        adapter_version: '1.0.0',
        action: 'approve',
        approval_id: 'f'.repeat(64),
        channel_id: 'C123CHANNEL',
        message_ts: '1753822800.000001',
        reaction_name: 'white_check_mark',
        requested_at: NOW,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          'https://authority.example/v1/permission-checks',
        );
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return new Response(
          JSON.stringify(allowedPermissionDecision(request)),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    await expect(client.checkPermission(request)).resolves.toMatchObject({
      allowed: true,
      membership_id: ORGANIZATION_IDS.membership,
    });

    const cancellation = new AbortController();
    let combinedSignal: AbortSignal | undefined;
    const cancelledClient = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          combinedSignal = init?.signal as AbortSignal;
          combinedSignal.addEventListener(
            'abort',
            () => reject(combinedSignal?.reason),
            { once: true },
          );
        }),
    });
    const pending = cancelledClient.checkPermission(
      request,
      cancellation.signal,
    );
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ code: 'transport_failed' });
    expect(combinedSignal?.aborted).toBe(true);
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
