import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ORGANIZATION_ADMIN_API_RESPONSE_BYTES,
  OrganizationAdminApiClient,
  OrganizationAdminApiError,
  OrganizationAdminApiTransportError,
  type OrganizationAdminApiClientOptions,
} from '../src/adapters/http/organization-admin-api-client.js';

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  identityLink: 'clm_00000000-0000-4000-8000-000000000001',
  adapterBinding: 'bnd_00000000-0000-4000-8000-000000000001',
  approveGrant: 'pgr_00000000-0000-4000-8000-000000000001',
  rejectGrant: 'pgr_00000000-0000-4000-8000-000000000002',
  command: 'adm_00000000-0000-4000-8000-000000000001',
} as const;

const DIGESTS = {
  authorityPin:
    'sha256:b237acdd2200b3d2f3816778a40994d872b44345ab4c1cc4ad370630b0f03db2',
  grant:
    'sha256:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
} as const;

const ADMIN_TOKEN = `admin-${'a'.repeat(40)}`;
const PROXY_TOKEN = `proxy-${'p'.repeat(40)}`;
const CLIENT_ID = `cid_${Buffer.alloc(32, 7).toString('base64url')}`;
const BASE_URL = 'http://127.0.0.1:39479';

const protocolFixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../packages/organization-protocol/fixtures/onboarding-access-chain.v1.json',
    ),
    'utf8',
  ),
) as { revoked_access_state: Record<string, unknown> };

const membership = {
  organization_id: IDS.organization,
  principal_id: IDS.principal,
  membership_id: IDS.membership,
  display_name: 'Example Employee',
  membership_type: 'employee' as const,
  status: 'active' as const,
  provisioned_at: '2026-07-22T00:00:00.000Z',
  revoked_at: null,
};

const revokedInstallation = {
  installation_id: IDS.installation,
  access_state: protocolFixture.revoked_access_state,
};

const revokedMembership = {
  membership: {
    ...membership,
    status: 'revoked' as const,
    revoked_at: '2026-07-22T00:02:00.000Z',
  },
  installations: [revokedInstallation],
};

const overview = {
  organization_id: IDS.organization,
  organization_display_name: 'Example Company',
  authority_id: IDS.authority,
  authority_pin_sha256: DIGESTS.authorityPin,
  created_at: '2026-07-22T00:00:00.000Z',
  last_observed_at: '2026-07-22T00:02:00.000Z',
  counts: {
    memberships: 1,
    active_memberships: 1,
    revoked_memberships: 0,
    installations: 0,
    active_installations: 0,
    revoked_installations: 0,
    enrollment_grants: 1,
    pending_enrollment_grants: 1,
    consumed_enrollment_grants: 0,
    expired_enrollment_grants: 0,
    audit_entries: 2,
  },
};

const issuedGrant = {
  authority_id: IDS.authority,
  authority_pin_sha256: DIGESTS.authorityPin,
  organization_id: IDS.organization,
  principal_id: IDS.principal,
  membership_id: IDS.membership,
  enrollment_grant_sha256: DIGESTS.grant,
  issued_at: '2026-07-22T00:00:00.000Z',
  expires_at: '2026-07-22T01:00:00.000Z',
};

const activatedSlackApproval = {
  identity_link_id: IDS.identityLink,
  adapter_binding_id: IDS.adapterBinding,
  approve_permission_grant_id: IDS.approveGrant,
  reject_permission_grant_id: IDS.rejectGrant,
  membership_id: IDS.membership,
  installation_id: IDS.installation,
  activated_at: '2026-07-22T00:03:00.000Z',
  permission_grants_created: 2 as const,
};

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function options(
  overrides: Partial<OrganizationAdminApiClientOptions> = {},
): OrganizationAdminApiClientOptions {
  return {
    base_url: BASE_URL,
    admin_token: ADMIN_TOKEN,
    trusted_proxy_token: PROXY_TOKEN,
    client_identity: CLIENT_ID,
    ...overrides,
  };
}

describe('organization administrator API client configuration', () => {
  it.each([
    'https://127.0.0.1:39479',
    'http://localhost:39479',
    'http://127.0.0.1:39479/path',
    'http://127.0.0.1:39479/?query=yes',
    'http://user@127.0.0.1:39479/',
    'http://0x7f000001:39479/',
    ' http://127.0.0.1:39479/',
  ])('rejects non-origin or non-loopback base URL %s', (baseUrl) => {
    expect(
      () => new OrganizationAdminApiClient(options({ base_url: baseUrl })),
    ).toThrow('bare loopback HTTP origin');
  });

  it('accepts canonical IPv4 and IPv6 loopback origins only', () => {
    expect(() => new OrganizationAdminApiClient(options())).not.toThrow();
    expect(
      () =>
        new OrganizationAdminApiClient(
          options({ base_url: 'http://[::1]:39479/' }),
        ),
    ).not.toThrow();
  });

  it('rejects malformed or overlapping credentials, identity, and deadlines', () => {
    expect(
      () =>
        new OrganizationAdminApiClient(options({ admin_token: 'too-short' })),
    ).toThrow('administrator token');
    expect(
      () =>
        new OrganizationAdminApiClient(
          options({ trusted_proxy_token: ADMIN_TOKEN }),
        ),
    ).toThrow('distinct credentials');
    expect(
      () =>
        new OrganizationAdminApiClient(
          options({ client_identity: `cid_${'A'.repeat(42)}B` }),
        ),
    ).toThrow('client identity');
    expect(
      () => new OrganizationAdminApiClient(options({ timeout_ms: 0 })),
    ).toThrow('timeout');
  });
});

describe('organization administrator API client requests', () => {
  it('authenticates every request and exposes every bounded admin operation', async () => {
    const captured: Array<{ url: URL; init: RequestInit }> = [];
    const cursor = Buffer.from(
      JSON.stringify({ kind: 'memberships', value: IDS.membership }),
      'utf8',
    ).toString('base64url');
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        captured.push({ url, init: init ?? {} });
        if (url.pathname === '/v1/admin/overview') {
          return jsonResponse(overview);
        }
        if (
          url.pathname === '/v1/admin/memberships' &&
          init?.method === 'GET'
        ) {
          return jsonResponse({ items: [], next_cursor: null });
        }
        if (url.pathname === '/v1/admin/installations') {
          return jsonResponse({ items: [], next_cursor: null });
        }
        if (url.pathname === '/v1/admin/enrollment-grants') {
          return jsonResponse({ items: [], next_cursor: null });
        }
        if (url.pathname === '/v1/admin/audit') {
          return jsonResponse({ items: [], next_cursor: null });
        }
        if (
          url.pathname === '/v1/admin/memberships' &&
          init?.method === 'POST'
        ) {
          return jsonResponse(membership, 201);
        }
        if (url.pathname.endsWith('/enrollment-grants')) {
          return jsonResponse(issuedGrant, 201);
        }
        if (url.pathname.endsWith('/revocations')) {
          return jsonResponse(
            url.pathname.includes('/installations/')
              ? revokedInstallation
              : revokedMembership,
          );
        }
        if (
          url.pathname ===
          '/v1/admin/integrations/slack-approval-activation'
        ) {
          return jsonResponse(activatedSlackApproval, 201);
        }
        return jsonResponse(
          { error: { code: 'not_found', message: 'route was not found' } },
          404,
        );
      },
    );
    const client = new OrganizationAdminApiClient(
      options({ fetch: fetchImpl as typeof fetch }),
    );

    await expect(client.overview()).resolves.toEqual(overview);
    await expect(
      client.listMemberships({ cursor, limit: 25 }),
    ).resolves.toEqual({ items: [], next_cursor: null });
    await expect(client.listInstallations()).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    await expect(client.listEnrollmentGrants()).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    await expect(client.listAudit()).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    await expect(
      client.provisionMembership({
        command_id: IDS.command,
        display_name: membership.display_name,
        membership_type: membership.membership_type,
      }),
    ).resolves.toEqual(membership);
    await expect(
      client.registerEnrollmentGrant(IDS.membership, {
        command_id: IDS.command,
        enrollment_grant_sha256: DIGESTS.grant,
        lifetime_seconds: 3600,
      }),
    ).resolves.toEqual(issuedGrant);
    await expect(
      client.revokeMembership(IDS.membership, { reason: 'employment ended' }),
    ).resolves.toEqual(revokedMembership);
    await expect(
      client.revokeInstallation(IDS.installation, {
        reason: 'device retired',
      }),
    ).resolves.toEqual(revokedInstallation);
    await expect(
      client.activateSlackApproval({
        command_id: IDS.command,
        administrator_membership_id: IDS.membership,
        target_membership_id: IDS.membership,
        installation_id: IDS.installation,
        identity_link_id: IDS.identityLink,
        adapter_binding_id: IDS.adapterBinding,
      }),
    ).resolves.toEqual(activatedSlackApproval);

    expect(captured).toHaveLength(10);
    for (const { init } of captured) {
      const headers = new Headers(init.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(headers.get('x-echo-proxy-authorization')).toBe(
        `Echo-Proxy ${PROXY_TOKEN}`,
      );
      expect(headers.get('x-echo-authenticated-client-id')).toBe(CLIENT_ID);
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(captured[1]!.url.searchParams.get('cursor')).toBe(cursor);
    expect(captured[1]!.url.searchParams.get('limit')).toBe('25');

    const grantRequest = captured.find(
      ({ url, init }) =>
        url.pathname.endsWith('/enrollment-grants') && init.method === 'POST',
    )!;
    expect(JSON.parse(String(grantRequest.init.body))).toEqual({
      command_id: IDS.command,
      enrollment_grant_sha256: DIGESTS.grant,
      lifetime_seconds: 3600,
    });
    expect(String(grantRequest.init.body)).not.toContain(
      'enrollment_grant_base64url',
    );
    const activationRequest = captured.find(
      ({ url }) =>
        url.pathname ===
        '/v1/admin/integrations/slack-approval-activation',
    )!;
    expect(JSON.parse(String(activationRequest.init.body))).toEqual({
      command_id: IDS.command,
      administrator_membership_id: IDS.membership,
      target_membership_id: IDS.membership,
      installation_id: IDS.installation,
      identity_link_id: IDS.identityLink,
      adapter_binding_id: IDS.adapterBinding,
    });
  });

  it('validates IDs, command bodies, cursors, and page sizes before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new OrganizationAdminApiClient(
      options({ fetch: fetchImpl }),
    );

    expect(() => client.listMemberships({ cursor: 'x' })).toThrow('cursor');
    expect(() => client.listAudit({ limit: 101 })).toThrow('page limit');
    expect(() =>
      client.registerEnrollmentGrant('../membership', {
        command_id: IDS.command,
        enrollment_grant_sha256: DIGESTS.grant,
        lifetime_seconds: 3600,
      }),
    ).toThrow('membership_id');
    expect(() =>
      client.provisionMembership({
        command_id: 'wrong-command',
        display_name: 'Example Employee',
        membership_type: 'employee',
      }),
    ).toThrow('canonical adm identifier');
    expect(() =>
      client.activateSlackApproval({
        command_id: IDS.command,
        administrator_membership_id: IDS.membership,
        target_membership_id: IDS.membership,
        installation_id: IDS.installation,
        identity_link_id: '../identity-link',
        adapter_binding_id: IDS.adapterBinding,
      }),
    ).toThrow('identity_link_id');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns only shared-validator-approved success shapes and exact statuses', async () => {
    const extraFieldClient = new OrganizationAdminApiClient(
      options({
        fetch: (async () =>
          jsonResponse({ ...overview, untrusted: true })) as typeof fetch,
      }),
    );
    await expect(extraFieldClient.overview()).rejects.toMatchObject({
      name: 'OrganizationAdminApiTransportError',
      code: 'invalid_response',
      status: 200,
    });

    const wrongStatusClient = new OrganizationAdminApiClient(
      options({
        fetch: (async () => jsonResponse(overview, 201)) as typeof fetch,
      }),
    );
    await expect(wrongStatusClient.overview()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 201,
    });

    const invalidActivationClient = new OrganizationAdminApiClient(
      options({
        fetch: (async () =>
          jsonResponse(
            { ...activatedSlackApproval, permission_grants_created: 1 },
            201,
          )) as typeof fetch,
      }),
    );
    await expect(
      invalidActivationClient.activateSlackApproval({
        command_id: IDS.command,
        administrator_membership_id: IDS.membership,
        target_membership_id: IDS.membership,
        installation_id: IDS.installation,
        identity_link_id: IDS.identityLink,
        adapter_binding_id: IDS.adapterBinding,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      status: 201,
    });
  });

  it('surfaces only validated ordinary API errors', async () => {
    const client = new OrganizationAdminApiClient(
      options({
        fetch: (async () =>
          jsonResponse(
            {
              error: { code: 'unauthorized', message: 'authorization failed' },
            },
            401,
          )) as typeof fetch,
      }),
    );

    let failure: unknown;
    try {
      await client.overview();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OrganizationAdminApiError);
    expect(failure).toMatchObject({
      code: 'unauthorized',
      status: 401,
      response: {
        error: { code: 'unauthorized', message: 'authorization failed' },
      },
    });
    expect((failure as Error).message).not.toContain(ADMIN_TOKEN);
    expect((failure as Error).message).not.toContain(PROXY_TOKEN);

    const malformed = new OrganizationAdminApiClient(
      options({
        fetch: (async () =>
          jsonResponse(
            { error: { code: 'UPPER', message: 'bad' } },
            500,
          )) as typeof fetch,
      }),
    );
    await expect(malformed.overview()).rejects.toBeInstanceOf(
      OrganizationAdminApiTransportError,
    );
  });
});

describe('organization administrator API client response bounds', () => {
  it.each([
    {
      label: 'non-JSON content type',
      response: () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      code: 'invalid_response',
    },
    {
      label: 'invalid UTF-8',
      response: () =>
        new Response(Uint8Array.of(0xc3, 0x28), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      code: 'invalid_response',
    },
    {
      label: 'oversized streamed body',
      response: () =>
        new Response(
          new Uint8Array(MAX_ORGANIZATION_ADMIN_API_RESPONSE_BYTES + 1),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      code: 'response_too_large',
    },
  ])('rejects $label', async ({ response, code }) => {
    const client = new OrganizationAdminApiClient(
      options({ fetch: (async () => response()) as typeof fetch }),
    );
    await expect(client.overview()).rejects.toMatchObject({ code });
  });

  it('passes an abort deadline and never echoes secret-bearing transport errors', async () => {
    const fetchImpl = (async (
      _input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error(`${ADMIN_TOKEN}:${PROXY_TOKEN}`);
      }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error(`${ADMIN_TOKEN}:${PROXY_TOKEN}`)),
          { once: true },
        );
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    const client = new OrganizationAdminApiClient(
      options({ fetch: fetchImpl, timeout_ms: 5 }),
    );

    let failure: unknown;
    try {
      await client.overview();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'OrganizationAdminApiTransportError',
      code: 'transport_failed',
      status: null,
    });
    expect((failure as Error).message).not.toContain(ADMIN_TOKEN);
    expect((failure as Error).message).not.toContain(PROXY_TOKEN);
  });
});
