import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_CONSOLE_JAVASCRIPT,
  ADMIN_CONSOLE_SCRIPT_PATH,
  ADMIN_CONSOLE_STYLESHEET_PATH,
} from '../src/presentation/admin-console/assets.js';
import { handleAdminConsoleRequest } from '../src/presentation/admin-console/routes.js';
import { InMemoryAdminConsoleSessionStore } from '../src/presentation/admin-console/sessions.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationIntegrationsHttpApplication } from '../src/presentation/organization-integrations-http-application.js';

const ADMIN_CREDENTIAL = 'correct-test-administrator-credential';
const CLIENT_A = `cid_${createHash('sha256').update('client-a').digest('base64url')}`;
const CLIENT_B = `cid_${createHash('sha256').update('client-b').digest('base64url')}`;
const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  enrollment: 'enr_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  command: 'adm_00000000-0000-4000-8000-000000000001',
} as const;
const DIGESTS = {
  pin: `sha256:${'a'.repeat(64)}`,
  grant: `sha256:${'b'.repeat(64)}`,
  key: `sha256:${'c'.repeat(64)}`,
} as const;
const TIMES = {
  created: '2026-07-22T10:00:00.000Z',
  issued: '2026-07-22T11:00:00.000Z',
  expires: '2026-07-23T11:00:00.000Z',
} as const;

function membership(displayName = '<img src=x onerror=alert(1)>') {
  return {
    organization_id: IDS.organization,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    display_name: displayName,
    membership_type: 'employee' as const,
    status: 'active' as const,
    provisioned_at: TIMES.issued,
    revoked_at: null,
    revocation_reason: null,
  };
}

function testApplication() {
  const unexpected = (): never => {
    throw new Error('unexpected authority application call');
  };
  const application = {
    descriptor: unexpected,
    checkPermissionSubject: unexpected,
    checkReviewerPermissionSubject: unexpected,
    internalLiveRolloutStatus: unexpected,
    approveInternalLiveRelease: unexpected,
    fetchInternalLiveDirective: unexpected,
    recordInternalLiveUpdateReceipt: unexpected,
    adminOverview: vi.fn(() => ({
      organization_id: IDS.organization,
      organization_display_name: '<script>alert("organization")</script>',
      authority_id: IDS.authority,
      authority_pin_sha256: DIGESTS.pin,
      created_at: TIMES.created,
      last_observed_at: TIMES.issued,
      counts: {
        memberships: 1,
        active_memberships: 1,
        revoked_memberships: 0,
        installations: 1,
        active_installations: 1,
        revoked_installations: 0,
        enrollment_grants: 1,
        pending_enrollment_grants: 1,
        consumed_enrollment_grants: 0,
        expired_enrollment_grants: 0,
        audit_entries: 1,
      },
    })),
    listMemberships: vi.fn(() => ({
      items: [membership()],
      next_cursor: null,
    })),
    listInstallations: vi.fn(() => ({
      items: [
        {
          organization_id: IDS.organization,
          principal_id: IDS.principal,
          membership_id: IDS.membership,
          enrollment_id: IDS.enrollment,
          installation_id: IDS.installation,
          installation_key_id: DIGESTS.key,
          status: 'active' as const,
          enrolled_at: TIMES.issued,
          revoked_at: null,
          revocation_kind: null,
          revocation_reason: null,
          current_access_sequence: 1,
          current_access_status: 'active' as const,
          current_access_valid_until: TIMES.expires,
        },
      ],
      next_cursor: null,
    })),
    listEnrollmentGrants: vi.fn(() => ({
      items: [
        {
          organization_id: IDS.organization,
          principal_id: IDS.principal,
          membership_id: IDS.membership,
          enrollment_grant_sha256: DIGESTS.grant,
          issued_at: TIMES.issued,
          expires_at: TIMES.expires,
          consumed_at: null,
          status: 'pending' as const,
        },
      ],
      next_cursor: null,
    })),
    listAudit: vi.fn(() => ({
      items: [
        {
          audit_sequence: 1,
          occurred_at: TIMES.issued,
          actor_kind: 'admin' as const,
          action: '<script>audit</script>',
          subject_id: IDS.membership,
          detail: { safe: '<img src=x>' },
        },
      ],
      next_cursor: null,
    })),
    provisionMembership: vi.fn(() => membership('New Employee')),
    issueEnrollmentGrant: vi.fn(() => ({
      authority_id: IDS.authority,
      authority_pin_sha256: DIGESTS.pin,
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      enrollment_grant_sha256: DIGESTS.grant,
      issued_at: TIMES.issued,
      expires_at: TIMES.expires,
    })),
    completeEnrollment: unexpected,
    issueAccessLease: unexpected,
    revokeMembership: vi.fn(async () => ({
      membership: membership('Revoked Employee'),
      installations: [],
    })),
    revokeInstallation: vi.fn(async () => ({}) as never),
    recoverInstallationAccess: unexpected,
  } as OrganizationAuthorityHttpApplication;
  return application;
}

function testSessions(): InMemoryAdminConsoleSessionStore {
  let randomValue = 1;
  return new InMemoryAdminConsoleSessionStore({
    session_ttl_ms: 60_000,
    maximum_sessions: 10,
    now: () => 1_000,
    random_bytes: (length) => new Uint8Array(length).fill(randomValue++),
  });
}

async function listen(
  application: OrganizationAuthorityHttpApplication,
  sessions: InMemoryAdminConsoleSessionStore,
  authenticateCredential: (credential: string) => boolean | Promise<boolean>,
  integrations?: OrganizationIntegrationsHttpApplication,
): Promise<{ server: Server; origin: string }> {
  const signal = new AbortController().signal;
  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? 'authority.invalid';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const headerIdentity = request.headers['x-test-client-identity'];
    const handled = await handleAdminConsoleRequest({
      application,
      integrations,
      sessions,
      authenticateCredential,
      clientIdentity:
        typeof headerIdentity === 'string' ? headerIdentity : CLIENT_A,
      request,
      response,
      url,
      signal,
    });
    if (!handled) {
      response.writeHead(418, { 'Content-Type': 'text/plain' });
      response.end('outside admin namespace');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

function secureOrigin(origin: string): string {
  return origin.replace(/^http:/, 'https:');
}

function cookies(response: Response): {
  readonly header: string;
  readonly set: string[];
  readonly session: string;
  readonly csrf: string;
} {
  const set = response.headers.getSetCookie();
  const pairs = set.map((value) => value.slice(0, value.indexOf(';')));
  const session = pairs.find((value) =>
    value.startsWith('echo_admin_session='),
  );
  const csrf = pairs.find((value) => value.startsWith('echo_admin_csrf='));
  if (session === undefined || csrf === undefined) {
    throw new Error('administrator cookies were unavailable');
  }
  return {
    header: pairs.join('; '),
    set,
    session: session.slice('echo_admin_session='.length),
    csrf: csrf.slice('echo_admin_csrf='.length),
  };
}

async function login(origin: string): Promise<{
  readonly response: Response;
  readonly cookies: ReturnType<typeof cookies>;
}> {
  const response = await fetch(`${origin}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      connection: 'close',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      origin: secureOrigin(origin),
    },
    body: new URLSearchParams({ credential: ADMIN_CREDENTIAL }),
  });
  return { response, cookies: cookies(response) };
}

function formHeaders(
  origin: string,
  cookieHeader: string,
): Record<string, string> {
  return {
    connection: 'close',
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    cookie: cookieHeader,
    origin: secureOrigin(origin),
  };
}

describe('administrator console presentation', () => {
  it('keeps Slack inactive until organization verification succeeds', async () => {
    const application = testApplication();
    vi.spyOn(application, 'listMemberships').mockReturnValue({
      items: [
        {
          ...membership('Zhenye Owner'),
          membership_type: 'owner',
        },
      ],
      next_cursor: null,
    });
    let currentConnection: Readonly<Record<string, unknown>>;
    const slackBotToken = 'xoxb-browser-secret-token-12345678';
    const requiredScopes = [
      'channels:history',
      'channels:read',
      'chat:write',
      'reactions:read',
      'users:read',
    ] as const;
    const baseConnection = {
      connection_id: 'con_00000000-0000-4000-8000-000000000099',
      provider: 'slack',
      owner_kind: 'organization',
      provider_tenant_id: 'T123ABC',
      provider_subject_id: 'U123BOT',
      status: 'active',
      granted_scopes_json: JSON.stringify(requiredScopes),
      secret_backend_id: 'authority-file-v1',
      secret_handle_id: 'sch_must-never-render',
      activated_at: TIMES.issued,
      revoked_at: null,
    } as const;
    const readyConfiguration = {
      schema_version: 1,
      organization_tool_profile: 'slack-organization-tool-v1',
      channel_id: 'C123CHANNEL',
      slack_app_id: 'A123APP',
      slack_bot_id: 'B123BOT',
      slack_bot_user_id: 'U123BOT',
      slack_enterprise_id: null,
    } as const;
    const configuredConnection = (
      configuration: Readonly<Record<string, unknown>>,
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      ...baseConnection,
      ...overrides,
      public_configuration_json: JSON.stringify(configuration),
    });
    const inactiveConnections = [
      configuredConnection({
        ...readyConfiguration,
        organization_tool_profile: undefined,
      }),
      configuredConnection(readyConfiguration, {
        granted_scopes_json: JSON.stringify(
          requiredScopes.filter((scope) => scope !== 'channels:history'),
        ),
      }),
      configuredConnection({ ...readyConfiguration, schema_version: 2 }),
      configuredConnection({
        ...readyConfiguration,
        organization_tool_profile: 'legacy-slack-bootstrap',
      }),
      configuredConnection({
        ...readyConfiguration,
        slack_bot_user_id: 'UOTHERBOT',
      }),
      configuredConnection({ ...readyConfiguration, channel_id: 'GPRIVATE' }),
    ];
    const verifiedConnection = configuredConnection(readyConfiguration, {
      connection_id: 'con_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    currentConnection = inactiveConnections[0]!;
    const onboardSlackOrganizationTool = vi.fn(async () => {
      currentConnection = verifiedConnection;
      return {
        connection_attempt_id: 'cat_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        connection_id: verifiedConnection.connection_id,
        organization_id: IDS.organization,
        provider: 'slack' as const,
        status: 'active' as const,
        slack_team_id: 'T123ABC',
        slack_bot_user_id: 'U123BOT',
        channel_id: 'C123CHANNEL',
        granted_scopes: requiredScopes,
        activated_at: TIMES.issued,
      };
    });
    const integrations = {
      overview: vi.fn(() => ({
        identity_links: [],
        tool_connections: [currentConnection],
        adapter_bindings: [],
        permission_grants: [],
        recent_audit: [],
      })),
      onboardSlackOrganizationTool,
      activateSlackApproval: vi.fn(),
      checkPermission: vi.fn(),
    } as unknown as OrganizationIntegrationsHttpApplication;
    const { server, origin } = await listen(
      application,
      testSessions(),
      (credential) => credential === ADMIN_CREDENTIAL,
      integrations,
    );
    try {
      const authenticated = await login(origin);
      for (const candidate of inactiveConnections) {
        currentConnection = candidate;
        const inactiveDashboard = await fetch(`${origin}/admin`, {
          headers: {
            connection: 'close',
            cookie: authenticated.cookies.header,
          },
        });
        const inactiveHtml = await inactiveDashboard.text();
        expect(inactiveDashboard.status).toBe(200);
        for (const expected of [
          'Slack inactive',
          'action="/admin/integrations/slack"',
          'type="password"',
          'Authorized public Slack channel ID',
          'pattern="C[A-Z0-9]{2,}"',
          'JavaScript is required to generate the one-time administrator command ID',
          'Zhenye Owner',
        ]) {
          expect(inactiveHtml).toContain(expected);
        }
        for (const secretMetadata of [
          'sch_must-never-render',
          'authority-file-v1',
        ]) {
          expect(inactiveHtml).not.toContain(secretMetadata);
        }
      }

      const rejected = await fetch(`${origin}/admin/integrations/slack`, {
        method: 'POST',
        redirect: 'manual',
        headers: formHeaders(origin, authenticated.cookies.header),
        body: new URLSearchParams({
          _csrf: Buffer.alloc(32, 99).toString('base64url'),
          command_id: IDS.command,
          administrator_membership_id: IDS.membership,
          channel_id: 'C123CHANNEL',
          slack_bot_token: slackBotToken,
        }),
      });
      expect(rejected.status).toBe(403);
      expect(onboardSlackOrganizationTool).not.toHaveBeenCalled();
      expect(await rejected.text()).not.toContain(slackBotToken);

      const activated = await fetch(`${origin}/admin/integrations/slack`, {
        method: 'POST',
        redirect: 'manual',
        headers: formHeaders(origin, authenticated.cookies.header),
        body: new URLSearchParams({
          _csrf: authenticated.cookies.csrf,
          command_id: IDS.command,
          administrator_membership_id: IDS.membership,
          channel_id: 'C123CHANNEL',
          slack_bot_token: slackBotToken,
        }),
      });
      expect(activated.status).toBe(303);
      expect(activated.headers.get('location')).toBe('/admin');
      expect(await activated.text()).not.toContain(slackBotToken);
      expect(onboardSlackOrganizationTool).toHaveBeenCalledWith(
        {
          command_id: IDS.command,
          administrator_membership_id: IDS.membership,
          channel_id: 'C123CHANNEL',
          slack_bot_token: slackBotToken,
        },
        expect.any(AbortSignal),
      );

      const activeDashboard = await fetch(`${origin}/admin`, {
        headers: {
          connection: 'close',
          cookie: authenticated.cookies.header,
        },
      });
      const activeHtml = await activeDashboard.text();
      expect(activeDashboard.status).toBe(200);
      expect(activeHtml).toContain('Slack active');
      expect(activeHtml).toContain('T123ABC');
      expect(activeHtml).toContain('U123BOT');
      expect(activeHtml).toContain('C123CHANNEL');
      expect(activeHtml).toContain('channels:history');
      expect(activeHtml).toContain('channels:read, chat:write');
      expect(activeHtml).toContain('users:read');
      expect(activeHtml).not.toContain(
        'action="/admin/integrations/slack"',
      );
      expect(activeHtml).not.toContain(slackBotToken);
      expect(activeHtml).not.toContain('sch_must-never-render');
      expect(activeHtml).not.toContain('authority-file-v1');
    } finally {
      await close(server);
    }
  });

  it('owns only /admin and serves a CSP-safe login plus static assets', async () => {
    const application = testApplication();
    const auth = vi.fn(() => false);
    const { server, origin } = await listen(application, testSessions(), auth);
    try {
      const outside = await fetch(`${origin}/v1/admin/overview`, {
        headers: { connection: 'close' },
      });
      expect(outside.status).toBe(418);

      const loginPage = await fetch(`${origin}/admin/login`, {
        headers: { connection: 'close' },
      });
      expect(loginPage.status).toBe(200);
      expect(loginPage.headers.get('cache-control')).toBe('no-store');
      expect(loginPage.headers.get('x-frame-options')).toBe('DENY');
      expect(loginPage.headers.get('x-content-type-options')).toBe('nosniff');
      expect(loginPage.headers.get('referrer-policy')).toBe('same-origin');
      const csp = loginPage.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("'unsafe-inline'");
      const loginHtml = await loginPage.text();
      expect(loginHtml).not.toContain('<style');
      expect(loginHtml).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(loginHtml).not.toContain(ADMIN_CREDENTIAL);

      const stylesheet = await fetch(
        `${origin}${ADMIN_CONSOLE_STYLESHEET_PATH}`,
        { headers: { connection: 'close' } },
      );
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get('content-type')).toBe(
        'text/css; charset=utf-8',
      );
      expect(await stylesheet.text()).toContain('.panel');

      const script = await fetch(`${origin}${ADMIN_CONSOLE_SCRIPT_PATH}`, {
        headers: { connection: 'close' },
      });
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );
      const source = await script.text();
      expect(source).toContain('crypto.randomUUID()');
      expect(source).toContain('crypto.getRandomValues(secretBytes)');
      expect(source).toContain("crypto.subtle.digest('SHA-256', secretBytes)");
      expect(source).toContain('invitationStates.get(form)');
      expect(source).toContain('Retry to reuse the same command ID');
      expect(source).toContain('mismatched invitation lifetime');
      expect(source).toContain('navigator.clipboard.writeText');
      expect(source).toContain('URL.createObjectURL');
      expect(source).toContain(
        "kind: 'echo-organization-enrollment-invitation'",
      );
      expect(source).toContain("status: 'issued'");
      expect(source).toContain('window.location.origin');
      expect(source).toContain('authority_base_url: state.authority_base_url');
      expect(source).not.toContain('/admin/edge-config');
      expect(source).toContain('command_id: state.command_id');
      expect(source).toContain('lifetime_seconds: state.lifetime_seconds');
      expect(source).toContain('lastInvitationText = canonicalJson(envelope)');
      expect(source).not.toContain('localStorage');
      expect(source).not.toContain('sessionStorage');
      expect(source).not.toContain('Authorization');
      expect(() => new Function(source)).not.toThrow();
      expect(source).toBe(ADMIN_CONSOLE_JAVASCRIPT);
    } finally {
      await close(server);
    }
  });

  it('consumes the credential once, sets hardened cookies, and renders escaped bounded pages', async () => {
    const application = testApplication();
    const auth = vi.fn((credential: string) => credential === ADMIN_CREDENTIAL);
    const { server, origin } = await listen(application, testSessions(), auth);
    try {
      const anonymous = await fetch(`${origin}/admin`, {
        redirect: 'manual',
        headers: { connection: 'close' },
      });
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toBe('/admin/login');

      const authenticated = await login(origin);
      expect(authenticated.response.status).toBe(303);
      expect(authenticated.response.headers.get('location')).toBe('/admin');
      expect(auth).toHaveBeenCalledWith(ADMIN_CREDENTIAL);
      for (const setCookie of authenticated.cookies.set) {
        expect(setCookie).toContain('Secure');
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('SameSite=Strict');
        expect(setCookie).toContain('Path=/admin');
        expect(setCookie).not.toContain(ADMIN_CREDENTIAL);
      }
      expect(authenticated.cookies.session).not.toBe(
        authenticated.cookies.csrf,
      );

      const dashboard = await fetch(`${origin}/admin`, {
        headers: {
          connection: 'close',
          cookie: authenticated.cookies.header,
        },
      });
      expect(dashboard.status).toBe(200);
      const html = await dashboard.text();
      expect(html).not.toContain('<script>alert("organization")</script>');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).not.toContain('<script>audit</script>');
      expect(html).toContain(
        '&lt;script&gt;alert(&quot;organization&quot;)&lt;/script&gt;',
      );
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain(authenticated.cookies.session);
      expect(html).toContain(authenticated.cookies.csrf);
      expect(html).toContain('complete transport envelope');
      expect(html).toContain('separate trusted channel');
      expect(application.listMemberships).toHaveBeenCalledWith({ limit: 25 });
      expect(application.listInstallations).toHaveBeenCalledWith({ limit: 25 });
      expect(application.listEnrollmentGrants).toHaveBeenCalledWith({
        limit: 25,
      });
      expect(application.listAudit).toHaveBeenCalledWith({ limit: 25 });

      const otherClient = await fetch(`${origin}/admin`, {
        redirect: 'manual',
        headers: {
          connection: 'close',
          cookie: authenticated.cookies.header,
          'x-test-client-identity': CLIENT_B,
        },
      });
      expect(otherClient.status).toBe(303);
      expect(otherClient.headers.get('location')).toBe('/admin/login');
    } finally {
      await close(server);
    }
  });

  it('retries one browser invitation with the same secret and emits the exact canonical envelope', async () => {
    class Element {
      className = '';
      content = '';
      hidden = true;
      textContent = '';
      scrollIntoView(): void {}
    }
    class MetaElement extends Element {}
    class InputElement extends Element {
      value = '3600';
    }
    class ButtonElement extends Element {
      disabled = false;
      readonly listeners = new Map<string, () => void | Promise<void>>();
      addEventListener(
        name: string,
        listener: () => void | Promise<void>,
      ): void {
        this.listeners.set(name, listener);
      }
    }

    const status = new Element();
    const output = new Element();
    const material = new Element();
    const meta = new MetaElement();
    meta.content = Buffer.alloc(32, 5).toString('base64url');
    const lifetime = new InputElement();
    const submitButton = new ButtonElement();
    const copyButton = new ButtonElement();
    const downloadButton = new ButtonElement();
    let submit:
      ((event: { preventDefault(): void }) => Promise<void>) | undefined;
    const form = {
      action: `https://authority.example/admin/memberships/${IDS.membership}/enrollment-grants`,
      elements: {
        namedItem: (name: string) =>
          name === 'lifetime_seconds' ? lifetime : null,
      },
      querySelector: (selector: string) =>
        selector === 'button[type="submit"]' ? submitButton : null,
      addEventListener: (
        name: string,
        listener: (event: { preventDefault(): void }) => Promise<void>,
      ) => {
        if (name === 'submit') submit = listener;
      },
    };
    const requestBodies: string[] = [];
    let copied = '';

    runInNewContext(ADMIN_CONSOLE_JAVASCRIPT, {
      Blob,
      Error,
      HTMLButtonElement: ButtonElement,
      HTMLElement: Element,
      HTMLInputElement: InputElement,
      HTMLMetaElement: MetaElement,
      URL,
      window: { location: { origin: 'https://authority.example' } },
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
      crypto: {
        randomUUID: () => '00000000-0000-4000-8000-000000000099',
        getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
        subtle: {
          digest: async (_algorithm: string, bytes: Uint8Array) => {
            const digest = createHash('sha256').update(bytes).digest();
            return digest.buffer.slice(
              digest.byteOffset,
              digest.byteOffset + digest.byteLength,
            );
          },
        },
      },
      document: {
        body: { append: () => undefined },
        createElement: () => new Element(),
        querySelector: (selector: string) => {
          if (selector === 'meta[name="echo-admin-csrf"]') return meta;
          if (selector === '[data-invitation-status]') return status;
          if (selector === '[data-invitation-output]') return output;
          if (selector === '[data-invitation-material]') return material;
          if (selector === '[data-copy-invitation]') return copyButton;
          if (selector === '[data-download-invitation]') return downloadButton;
          return null;
        },
        querySelectorAll: (selector: string) =>
          selector === 'form[data-invitation-form]' ? [form] : [],
      },
      fetch: async (
        _url: string,
        init?: { body?: string },
      ): Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }> => {
        if (typeof init?.body !== 'string') {
          throw new Error('unexpected bodyless administrator request');
        }
        requestBodies.push(init.body);
        if (requestBodies.length === 1) {
          throw new Error('connection closed after delivery');
        }
        const request = JSON.parse(init.body) as {
          enrollment_grant_sha256: string;
        };
        return {
          ok: true,
          status: 201,
          json: async () => ({
            invitation: {
              authority_id: IDS.authority,
              authority_pin_sha256: DIGESTS.pin,
              organization_id: IDS.organization,
              principal_id: IDS.principal,
              membership_id: IDS.membership,
              enrollment_grant_sha256: request.enrollment_grant_sha256,
              issued_at: TIMES.issued,
              expires_at: '2026-07-22T12:00:00.000Z',
            },
          }),
        };
      },
      navigator: {
        clipboard: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      },
      setTimeout,
    });

    expect(submit).toBeTypeOf('function');
    await submit!({ preventDefault: () => undefined });
    expect(requestBodies).toHaveLength(1);
    expect(status.textContent).toContain('ambiguous');
    await submit!({ preventDefault: () => undefined });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);

    const request = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      'command_id',
      'enrollment_grant_sha256',
      'lifetime_seconds',
    ]);
    expect(request).toEqual({
      command_id: 'adm_00000000-0000-4000-8000-000000000099',
      enrollment_grant_sha256: `sha256:${createHash('sha256')
        .update(Buffer.alloc(32, 7))
        .digest('hex')}`,
      lifetime_seconds: 3600,
    });

    const envelope = JSON.parse(material.textContent) as Record<
      string,
      unknown
    >;
    expect(Object.keys(envelope).sort()).toEqual(
      [
        'schema_version',
        'kind',
        'status',
        'authority_base_url',
        'authority_id',
        'authority_pin_sha256',
        'authority_pin_verification',
        'organization_id',
        'membership_id',
        'command_id',
        'enrollment_grant_sha256',
        'enrollment_grant_base64url',
        'lifetime_seconds',
        'issued',
      ].sort(),
    );
    expect(envelope).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-enrollment-invitation',
      status: 'issued',
      authority_base_url: 'https://authority.example',
      authority_id: IDS.authority,
      authority_pin_sha256: DIGESTS.pin,
      authority_pin_verification: 'independent_pin_required',
      organization_id: IDS.organization,
      membership_id: IDS.membership,
      command_id: request.command_id,
      enrollment_grant_sha256: request.enrollment_grant_sha256,
      lifetime_seconds: 3600,
    });
    const grant = Buffer.from(
      envelope.enrollment_grant_base64url as string,
      'base64url',
    );
    expect(grant).toEqual(Buffer.alloc(32, 7));
    expect(requestBodies[0]).not.toContain(
      envelope.enrollment_grant_base64url as string,
    );

    await copyButton.listeners.get('click')!();
    expect(copied).toBe(`${canonicalJson(envelope)}\n`);
  });

  it('requires a strict HTTPS Origin/Host match and bounded fatal body decoding', async () => {
    const application = testApplication();
    const auth = vi.fn((credential: string) => credential === ADMIN_CREDENTIAL);
    const { server, origin } = await listen(application, testSessions(), auth);
    try {
      const crossOrigin = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://attacker.example',
        },
        body: `credential=${encodeURIComponent(ADMIN_CREDENTIAL)}`,
      });
      expect(crossOrigin.status).toBe(403);
      expect(auth).not.toHaveBeenCalled();

      const insecureOrigin = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/x-www-form-urlencoded',
          origin,
        },
        body: `credential=${encodeURIComponent(ADMIN_CREDENTIAL)}`,
      });
      expect(insecureOrigin.status).toBe(403);
      expect(auth).not.toHaveBeenCalled();

      const invalidUtf8 = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/x-www-form-urlencoded',
          origin: secureOrigin(origin),
        },
        body: Buffer.from([0xc3, 0x28]),
      });
      expect(invalidUtf8.status).toBe(400);

      const invalidEscaping = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/x-www-form-urlencoded',
          origin: secureOrigin(origin),
        },
        body: 'credential=%E0%A4%A',
      });
      expect(invalidEscaping.status).toBe(400);

      const oversized = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/json',
          origin: secureOrigin(origin),
        },
        body: JSON.stringify({ credential: 'x'.repeat(17_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(auth).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('gates every mutation and sends only invitation digests to the application', async () => {
    const application = testApplication();
    const { server, origin } = await listen(
      application,
      testSessions(),
      (credential) => credential === ADMIN_CREDENTIAL,
    );
    try {
      const authenticated = await login(origin);
      const memberBody = new URLSearchParams({
        _csrf: authenticated.cookies.csrf,
        command_id: IDS.command,
        display_name: 'New Employee',
        membership_type: 'employee',
      });

      const wrongOrigin = await fetch(`${origin}/admin/memberships`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...formHeaders(origin, authenticated.cookies.header),
          origin: 'https://attacker.example',
        },
        body: memberBody,
      });
      expect(wrongOrigin.status).toBe(403);
      expect(application.provisionMembership).not.toHaveBeenCalled();

      const wrongCsrf = await fetch(`${origin}/admin/memberships`, {
        method: 'POST',
        redirect: 'manual',
        headers: formHeaders(origin, authenticated.cookies.header),
        body: new URLSearchParams({
          ...Object.fromEntries(memberBody),
          _csrf: Buffer.alloc(32, 99).toString('base64url'),
        }),
      });
      expect(wrongCsrf.status).toBe(403);
      expect(application.provisionMembership).not.toHaveBeenCalled();

      const created = await fetch(`${origin}/admin/memberships`, {
        method: 'POST',
        redirect: 'manual',
        headers: formHeaders(origin, authenticated.cookies.header),
        body: memberBody,
      });
      expect(created.status).toBe(303);
      expect(created.headers.get('location')).toBe('/admin');
      expect(application.provisionMembership).toHaveBeenCalledWith({
        command_id: IDS.command,
        display_name: 'New Employee',
        membership_type: 'employee',
      });

      const oneTimeSecret = Buffer.alloc(32, 7).toString('base64url');
      const rejectedSecret = await fetch(
        `${origin}/admin/memberships/${IDS.membership}/enrollment-grants`,
        {
          method: 'POST',
          headers: {
            connection: 'close',
            'content-type': 'application/json; charset=utf-8',
            cookie: authenticated.cookies.header,
            origin: secureOrigin(origin),
            'x-echo-admin-csrf': authenticated.cookies.csrf,
          },
          body: JSON.stringify({
            command_id: IDS.command,
            enrollment_grant_sha256: DIGESTS.grant,
            enrollment_grant_base64url: oneTimeSecret,
            lifetime_seconds: 3600,
          }),
        },
      );
      expect(rejectedSecret.status).toBe(400);
      expect(await rejectedSecret.text()).not.toContain(oneTimeSecret);
      expect(application.issueEnrollmentGrant).not.toHaveBeenCalled();

      const invitation = await fetch(
        `${origin}/admin/memberships/${IDS.membership}/enrollment-grants`,
        {
          method: 'POST',
          headers: {
            connection: 'close',
            'content-type': 'application/json; charset=utf-8',
            cookie: authenticated.cookies.header,
            origin: secureOrigin(origin),
            'x-echo-admin-csrf': authenticated.cookies.csrf,
          },
          body: JSON.stringify({
            command_id: IDS.command,
            enrollment_grant_sha256: DIGESTS.grant,
            lifetime_seconds: 3600,
          }),
        },
      );
      expect(invitation.status).toBe(201);
      expect(application.issueEnrollmentGrant).toHaveBeenCalledWith(
        IDS.membership,
        {
          command_id: IDS.command,
          enrollment_grant_sha256: DIGESTS.grant,
          lifetime_seconds: 3600,
        },
      );
      const invitationText = await invitation.text();
      expect(invitationText).not.toContain(oneTimeSecret);
      expect(JSON.parse(invitationText)).toEqual({
        invitation: {
          authority_id: IDS.authority,
          authority_pin_sha256: DIGESTS.pin,
          organization_id: IDS.organization,
          principal_id: IDS.principal,
          membership_id: IDS.membership,
          enrollment_grant_sha256: DIGESTS.grant,
          issued_at: TIMES.issued,
          expires_at: TIMES.expires,
        },
        authority_pin_delivery: 'separate_secure_channel_required',
      });

      const revokeMember = await fetch(
        `${origin}/admin/memberships/${IDS.membership}/revocations`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: formHeaders(origin, authenticated.cookies.header),
          body: new URLSearchParams({
            _csrf: authenticated.cookies.csrf,
            reason: 'employment ended',
          }),
        },
      );
      expect(revokeMember.status).toBe(303);
      expect(application.revokeMembership).toHaveBeenCalledWith(
        IDS.membership,
        'employment ended',
      );

      const revokeInstallation = await fetch(
        `${origin}/admin/installations/${IDS.installation}/revocations`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: formHeaders(origin, authenticated.cookies.header),
          body: new URLSearchParams({
            _csrf: authenticated.cookies.csrf,
            reason: 'device retired',
          }),
        },
      );
      expect(revokeInstallation.status).toBe(303);
      expect(application.revokeInstallation).toHaveBeenCalledWith(
        IDS.installation,
        'device retired',
      );

      const logout = await fetch(`${origin}/admin/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: formHeaders(origin, authenticated.cookies.header),
        body: new URLSearchParams({ _csrf: authenticated.cookies.csrf }),
      });
      expect(logout.status).toBe(303);
      expect(logout.headers.get('location')).toBe('/admin/login');
      expect(logout.headers.getSetCookie().join('\n')).toContain('Max-Age=0');

      const afterLogout = await fetch(`${origin}/admin`, {
        redirect: 'manual',
        headers: {
          connection: 'close',
          cookie: authenticated.cookies.header,
        },
      });
      expect(afterLogout.status).toBe(303);
      expect(afterLogout.headers.get('location')).toBe('/admin/login');
    } finally {
      await close(server);
    }
  });
});
