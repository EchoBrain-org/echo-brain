import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from '../src/presentation/http-server.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const ACCESS_TOKEN = 'A'.repeat(43);
const UNAVAILABLE_BODY =
  '{"error":{"code":"unavailable","message":"service is temporarily unavailable"}}';
const INVALID_BODY =
  '{"error":{"code":"invalid_request","message":"request is invalid"}}';

const IDENTITY = {
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  subject_principal_id: 'prn_00000000-0000-4000-8000-000000000001',
} as const;

const BEGIN = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-begin-request',
  request_id: 'psb_00000000-0000-4000-8000-000000000001',
  ...IDENTITY,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  challenge_code_sha256:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

const COMPLETE = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-complete-request',
  request_id: 'psc_00000000-0000-4000-8000-000000000001',
  ...IDENTITY,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  challenge_attempt_id: 'cat_00000000-0000-4000-8000-000000000001',
  challenge_message_ts: '1755518400.000001',
  challenge_code: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

const BEGIN_RESPONSE = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-begin-response',
  challenge_attempt_id: COMPLETE.challenge_attempt_id,
  provider: 'slack',
  provider_tenant_id: 'T123ABC',
  channel_id: 'C123ABC',
  challenge_message_ts: COMPLETE.challenge_message_ts,
  expires_at: '2026-08-18T12:15:00.000Z',
} as const;

const COMPLETE_RESPONSE = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-result',
  identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
  connection_id: 'con_00000000-0000-4000-8000-000000000001',
  organization_id: IDENTITY.organization_id,
  principal_id: IDENTITY.subject_principal_id,
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  provider: 'slack',
  provider_tenant_id: 'T123ABC',
  provider_subject_id: 'U123PERSON',
  channel_id: 'C123ABC',
  linked_at: '2026-08-18T12:02:00.000Z',
  identity_link_created: true,
} as const;

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('person-slack-link-http-test')
      .digest('base64url')}`,
  };
}

function requestHeaders(): Record<string, string> {
  return {
    ...proxyHeaders(),
    authorization: `Bearer ${ACCESS_TOKEN}`,
    'content-type': 'application/json',
  };
}

function server(
  personSlackIdentityLink?: OrganizationAuthorityHttpServerOptions['personSlackIdentityLink'],
): Server {
  return createOrganizationAuthorityHttpServer({
    application: {} as OrganizationAuthorityHttpApplication,
    ...(personSlackIdentityLink === undefined ? {} : { personSlackIdentityLink }),
    adminAuthenticator: { authenticate: () => false },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
  });
}

async function listen(http: Server): Promise<string> {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function close(http: Server): Promise<void> {
  if (!http.listening) return;
  const closed = once(http, 'close');
  http.close();
  await closed;
}

describe('Person Slack identity-link HTTP routes', () => {
  it('dispatches canonical bearer requests and returns no-store V2 responses', async () => {
    const begin = vi.fn(async () => BEGIN_RESPONSE);
    const complete = vi.fn(async () => COMPLETE_RESPONSE);
    const http = server({ begin, complete });
    const origin = await listen(http);
    try {
      const begun = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(BEGIN),
        },
      );
      expect(begun.status).toBe(201);
      expect(begun.headers.get('cache-control')).toBe('no-store');
      expect(await begun.json()).toEqual(BEGIN_RESPONSE);
      expect(begin).toHaveBeenCalledWith(BEGIN, ACCESS_TOKEN, expect.anything());

      const completed = await fetch(
        `${origin}${ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH}`,
        {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(COMPLETE),
        },
      );
      expect(completed.status).toBe(200);
      expect(completed.headers.get('cache-control')).toBe('no-store');
      expect(await completed.json()).toEqual(COMPLETE_RESPONSE);
      expect(complete).toHaveBeenCalledWith(
        COMPLETE,
        ACCESS_TOKEN,
        expect.anything(),
      );
    } finally {
      await close(http);
    }
  });

  it('returns fixed 503s when the Person integration facade is absent', async () => {
    const http = server();
    const origin = await listen(http);
    try {
      for (const [path, body] of [
        [ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH, BEGIN],
        [ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH, COMPLETE],
      ] as const) {
        const response = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: requestHeaders(),
          body: canonicalJson(body),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).toBe(UNAVAILABLE_BODY);
      }
    } finally {
      await close(http);
    }
  });

  it('rejects noncanonical bytes and queries before dispatch', async () => {
    const begin = vi.fn(async () => BEGIN_RESPONSE);
    const complete = vi.fn(async () => COMPLETE_RESPONSE);
    const http = server({ begin, complete });
    const origin = await listen(http);
    try {
      for (const response of await Promise.all([
        fetch(
          `${origin}${ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH}`,
          {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify(BEGIN, null, 2),
          },
        ),
        fetch(
          `${origin}${ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH}?subject=other`,
          {
            method: 'POST',
            headers: requestHeaders(),
            body: canonicalJson(COMPLETE),
          },
        ),
      ])) {
        expect(response.status).toBe(400);
        expect(await response.text()).toBe(INVALID_BODY);
      }
      expect(begin).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });
});
