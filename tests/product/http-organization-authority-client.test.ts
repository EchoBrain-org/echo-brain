import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  createOrganizationReviewerPermissionCheckRequest,
  createOrganizationInternalLiveDirectiveRequest,
  createOrganizationInternalLiveUpdateReceipt,
  createOrganizationPermissionCheckRequest,
  createOrganizationRecentDecisionsRequest,
  createOrganizationSlackLinkBeginRequest,
  createOrganizationSlackLinkCompleteRequest,
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
} from '@echo-brain/organization-api';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
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

  it('sends reviewer permission as exact canonical bytes without changing schema-v1 wire behavior', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const request = await createOrganizationReviewerPermissionCheckRequest(
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
        approval_id: 'f'.repeat(64),
        channel_id: 'C123CHANNEL',
        message_ts: '1753822800.000001',
        reaction_name: 'white_check_mark',
        approve_reaction: 'white_check_mark',
        reject_reaction: 'x',
        reviewer_release_draft_sha256: `sha256:${'d'.repeat(64)}`,
        approval_presentation_sha256: `sha256:${'e'.repeat(64)}`,
        requested_at: NOW,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const decision = {
      schema_version: 2 as const,
      kind: 'echo-organization-permission-check-decision' as const,
      request_sha256: canonicalSha256(request),
      provider_event_sha256: request.provider_event_sha256,
      allowed: true,
      reason_code: 'active_reviewer_restricted_notice_v1',
      principal_id: ORGANIZATION_IDS.principal,
      membership_id: ORGANIZATION_IDS.membership,
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
      evaluated_at: NOW,
      authorization_audit_event_id:
        'aud_00000000-0000-4000-8000-000000000001',
      authorization_audit_entry_sha256: `sha256:${'a'.repeat(64)}`,
      reviewer_release_draft_sha256:
        request.reviewer_release_draft_sha256,
      approval_presentation_sha256: request.approval_presentation_sha256,
      semantic_intent_sha256: `sha256:${'b'.repeat(64)}`,
      message_presentation_sha256: `sha256:${'c'.repeat(64)}`,
    };
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          'https://authority.example/v1/permission-checks',
        );
        expect(String(init?.body)).toBe(canonicalJson(request));
        return new Response(canonicalJson(decision), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(client.checkReviewerPermission(request)).resolves.toEqual(
      decision,
    );
  });

  it('posts the exact signed recent-decisions request and accepts only its closed bounded response', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const request = await createOrganizationRecentDecisionsRequest(
      {
        request_id: 'rdr_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        installation_signing_key: signingKey,
        requested_at: NOW,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const response = {
      schema_version: 1 as const,
      policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
      witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
      items: [
        {
          atom_id: `sha256:${'a'.repeat(64)}` as const,
          kind: 'decision' as const,
          text: 'Adopt the two-member pilot.',
          record_hash: `sha256:${'b'.repeat(64)}` as const,
        },
      ],
    };
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          'https://authority.example/v1/recent-decisions',
        );
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return Response.json(response);
      },
    });

    await expect(client.readRecentDecisions(request)).resolves.toEqual(
      response,
    );

    const malformedClient = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        Response.json({
          ...response,
          items: [{ ...response.items[0]!, log_position: 7 }],
        }),
    });
    await expect(
      malformedClient.readRecentDecisions(request),
    ).rejects.toMatchObject({ code: 'invalid_response', status: 200 });

    const oversizedClient = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async () =>
        Response.json({
          ...response,
          items: [{ ...response.items[0]!, text: 'x'.repeat(61 * 1024) }],
        }),
    });
    await expect(
      oversizedClient.readRecentDecisions(request),
    ).rejects.toMatchObject({ code: 'response_too_large', status: 200 });
  });

  it('uses only signed installation requests for Slack linking and strictly validates both responses', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const challengeCode = Buffer.alloc(32, 0xa5).toString('base64url');
    const beginRequest = await createOrganizationSlackLinkBeginRequest(
      {
        request_id: 'slb_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        installation_signing_key: signingKey,
        challenge_code_sha256: `sha256:${'a'.repeat(64)}`,
        requested_at: NOW,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const completeRequest = await createOrganizationSlackLinkCompleteRequest(
      {
        request_id: 'slc_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        installation_signing_key: signingKey,
        challenge_attempt_id:
          'cat_00000000-0000-4000-8000-000000000001',
        challenge_message_ts: '1753891200.123456',
        challenge_code: challengeCode,
        expected_provider_subject_id: 'U123ZHEN',
        adapter_id: 'slack-reactions',
        adapter_instance_id: 'founder-approvals',
        adapter_version: '1.0.0',
        requested_at: NOW,
      },
      (bytes) =>
        signer.sign(
          ORGANIZATION_IDS.installation,
          bytes,
          signingKey.key_id,
        ),
    );
    const beginResponse = {
      schema_version: 1 as const,
      kind: 'echo-organization-slack-link-begin-response' as const,
      challenge_attempt_id:
        'cat_00000000-0000-4000-8000-000000000001',
      provider: 'slack' as const,
      provider_tenant_id: 'T123TEAM',
      channel_id: 'C123CHANNEL',
      challenge_message_ts: '1753891200.123456',
      expires_at: '2026-07-22T00:07:00.000Z',
    };
    const result = {
      schema_version: 1 as const,
      kind: 'echo-organization-slack-link-result' as const,
      identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
      connection_id: 'con_00000000-0000-4000-8000-000000000001',
      adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      organization_id: ORGANIZATION_IDS.organization,
      principal_id: ORGANIZATION_IDS.principal,
      membership_id: ORGANIZATION_IDS.membership,
      installation_id: ORGANIZATION_IDS.installation,
      provider: 'slack' as const,
      provider_tenant_id: 'T123TEAM',
      provider_subject_id: 'U123ZHEN',
      channel_id: 'C123CHANNEL',
      linked_at: NOW,
      identity_link_created: true,
      adapter_binding_created: true,
      permission_grants_created: 0 as const,
    };
    const expected = new Map<
      string,
      typeof beginRequest | typeof completeRequest
    >([
      ['/v1/integration-links/slack/challenges', beginRequest],
      ['/v1/integration-links/slack/completions', completeRequest],
    ]);
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const request = expected.get(url.pathname);
        expect(request).toBeDefined();
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return Response.json(
          url.pathname.endsWith('/challenges') ? beginResponse : result,
        );
      },
    });

    await expect(client.beginSlackLink(beginRequest)).resolves.toEqual(
      beginResponse,
    );
    await expect(client.completeSlackLink(completeRequest)).resolves.toEqual(
      result,
    );

    const malformedCases = [
      {
        invoke: (malformedClient: HttpOrganizationAuthorityClient) =>
          malformedClient.beginSlackLink(beginRequest),
        body: { ...beginResponse, bot_token: 'must-not-be-accepted' },
      },
      {
        invoke: (malformedClient: HttpOrganizationAuthorityClient) =>
          malformedClient.completeSlackLink(completeRequest),
        body: { ...result, permission_grants_created: 1 },
      },
    ];
    for (const testCase of malformedCases) {
      const malformedClient = new HttpOrganizationAuthorityClient({
        baseUrl: 'https://authority.example',
        fetch: async () => Response.json(testCase.body),
      });
      await expect(testCase.invoke(malformedClient)).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      });
    }
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

  it('uses signed internal-live requests and accepts only a 204 receipt acknowledgement', async () => {
    const authority = new TestAuthority();
    const signer = new TestInstallationSigner();
    const signingKey = protocolInstallationKey(signer);
    const sign = (bytes: Buffer) =>
      signer.sign(
        ORGANIZATION_IDS.installation,
        bytes,
        signingKey.key_id,
      );
    const directiveRequest =
      await createOrganizationInternalLiveDirectiveRequest(
        {
          request_id: 'udr_00000000-0000-4000-8000-000000000001',
          authority_id: ORGANIZATION_IDS.authority,
          authority_key_id: authority.descriptor.signing_key.key_id,
          organization_id: ORGANIZATION_IDS.organization,
          enrollment_id: ORGANIZATION_IDS.enrollment,
          installation_id: ORGANIZATION_IDS.installation,
          installation_signing_key: signingKey,
          requested_at: NOW,
        },
        sign,
      );
    const receipt = await createOrganizationInternalLiveUpdateReceipt(
      {
        transaction_id: 'upd_00000000-0000-4000-8000-000000000001',
        authority_id: ORGANIZATION_IDS.authority,
        authority_key_id: authority.descriptor.signing_key.key_id,
        organization_id: ORGANIZATION_IDS.organization,
        enrollment_id: ORGANIZATION_IDS.enrollment,
        installation_id: ORGANIZATION_IDS.installation,
        directive_sequence: 1,
        release_version: '0.1.0-internal.2',
        manifest_sha256: 'a'.repeat(64),
        artifact_sha256: 'b'.repeat(64),
        source_sha: 'c'.repeat(40),
        outcome: 'healthy',
        doctor: { ok: true, passed: 11, total: 11 },
        failure: null,
        finished_at: NOW,
        installation_signing_key: signingKey,
      },
      sign,
    );
    const directive = {
      schema_version: 1,
      kind: 'echo-internal-live-update-directive',
      channel: 'internal-live',
      directive_sequence: 1,
      manifest_url:
        'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.2/internal-live-release-manifest.v1.json',
      manifest_sha256: 'a'.repeat(64),
      approved_at: NOW,
      evaluated_at: NOW,
    } as const;
    let call = 0;
    const client = new HttpOrganizationAuthorityClient({
      baseUrl: 'https://authority.example',
      fetch: async (input, init) => {
        call += 1;
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        if (call === 1) {
          expect(String(input)).toBe(
            'https://authority.example/v1/internal-live/directives',
          );
          expect(JSON.parse(String(init?.body))).toEqual(directiveRequest);
          return new Response(JSON.stringify(directive), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        expect(String(input)).toBe(
          'https://authority.example/v1/internal-live/receipts',
        );
        expect(JSON.parse(String(init?.body))).toEqual(receipt);
        return new Response(null, { status: 204 });
      },
    });

    await expect(
      client.fetchInternalLiveDirective(directiveRequest),
    ).resolves.toEqual(directive);
    await expect(
      client.recordInternalLiveUpdateReceipt(receipt),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);
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
