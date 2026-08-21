import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, p256KeyId } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  organizationSlackLinkChallengeCodeSha256,
} from '@echo-brain/organization-api';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { describe, expect, it } from 'vitest';
import {
  PersonClient,
  runPersonClientCli,
} from '../../src/product/person-client/index.js';

function fixtureId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

const ORGANIZATION_IDS = {
  authority: fixtureId('oau', 1),
  organization: fixtureId('org', 1),
  principal: fixtureId('prn', 1),
  membership: fixtureId('mem', 1),
} as const;

function authorityDescriptor(): OrganizationAuthorityDescriptorV1 {
  const { publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(publicKeyDer)) {
    throw new Error('unexpected authority public-key export');
  }
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: ORGANIZATION_IDS.authority,
    organization_id: ORGANIZATION_IDS.organization,
    signing_key: {
      key_id: p256KeyId(publicKeyDer),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKeyDer.toString('base64'),
    },
  };
}

const NOW = '2026-08-18T00:02:00.000Z';
const SESSION = {
  organization_id: ORGANIZATION_IDS.organization,
  principal_id: ORGANIZATION_IDS.principal,
  membership_id: ORGANIZATION_IDS.membership,
  membership_type: 'employee',
  identity_binding_id: fixtureId('oib', 1),
  session_family_id: fixtureId('psf', 1),
  access_token: 'A'.repeat(43),
  refresh_token: 'R'.repeat(43),
  access_expires_at: '2026-08-18T00:01:00.000Z',
  refresh_expires_at: '2026-08-25T00:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
} as const;

const ROTATED_SESSION = {
  ...SESSION,
  access_token: 'B'.repeat(43),
  refresh_token: 'S'.repeat(43),
  access_expires_at: '2026-08-18T00:12:00.000Z',
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(canonicalJson(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-person-')));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Person client', () => {
  it('limits development HTTP origins to numeric loopback', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        allow_insecure_loopback: true,
        fetch: async () =>
          json({ authority_descriptor: authority }),
      });

      await expect(
        client.installSession('http://127.0.0.1:39478', ROTATED_SESSION),
      ).resolves.toMatchObject({
        authority_origin: 'http://127.0.0.1:39478',
      });
      await expect(
        client.beginLogin('http://localhost:39478'),
      ).rejects.toThrow(/HTTPS origin/);
    });
  });

  it('rotates one expired access session before a bearer read', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const paths: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === '/v1/authority-descriptor') {
          expect(init?.method).toBe('GET');
          return json({ authority_descriptor: authority });
        }
        if (path === '/v2/session/refresh') {
          expect(new Headers(init?.headers).get('authorization')).toBeNull();
          expect(JSON.parse(String(init?.body))).toEqual({
            refresh_token: SESSION.refresh_token,
          });
          return json(ROTATED_SESSION);
        }
        expect(path).toBe('/v2/recent-decisions');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        expect(request).toMatchObject({
          authority_id: authority.authority_id,
          organization_id: SESSION.organization_id,
          subject_principal_id: SESSION.principal_id,
          http_path: '/v2/recent-decisions',
        });
        expect(JSON.stringify(request)).not.toContain(ROTATED_SESSION.access_token);
        return json({
          schema_version: 1,
          policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
          witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
          items: [],
        });
      };
      const client = new PersonClient({
        home_directory: home,
        fetch: fetchImpl,
        now: () => NOW,
        random_uuid: () => '00000000-0000-4000-8000-000000000111',
      });

      await client.installSession('https://authority.example', SESSION);
      await expect(client.recentDecisions()).resolves.toMatchObject({
        items: [],
      });
      expect(paths).toEqual([
        '/v1/authority-descriptor',
        '/v2/session/refresh',
        '/v2/recent-decisions',
      ]);
      expect(client.sessionSummary().access_expires_at).toBe(
        ROTATED_SESSION.access_expires_at,
      );
    });
  });

  it('sends semantic-only reviewer-recent and readable-search bodies', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const observed: Array<{ path: string; body: unknown }> = [];
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === '/v1/authority-descriptor') {
            return json({ authority_descriptor: authority });
          }
          const body = JSON.parse(String(init?.body)) as unknown;
          observed.push({ path, body });
          expect(new Headers(init?.headers).get('authorization')).toBe(
            `Bearer ${ROTATED_SESSION.access_token}`,
          );
          if (path === '/v2/reviewer-recent-decisions') {
            return json({
              schema_version: 1,
              items: [],
              policy_id: 'restricted-reviewer-v1',
              witness:
                'Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active.',
            });
          }
          expect(path).toBe('/v2/readable-search');
          return json({
            schema_version: 1,
            contract_id: 'permission-aware-readable-search-v1',
            items: [],
          });
        },
      });

      await client.installSession('https://authority.example', ROTATED_SESSION);
      await client.reviewerRecentDecisions();
      await client.readableSearch('pricing');

      expect(observed).toEqual([
        {
          path: '/v2/reviewer-recent-decisions',
          body: { subject_principal_id: SESSION.principal_id },
        },
        {
          path: '/v2/readable-search',
          body: {
            query: 'pricing',
            subject_principal_id: SESSION.principal_id,
          },
        },
      ]);
      for (const request of observed) {
        expect(request.body).not.toHaveProperty('schema_version');
        expect(request.body).not.toHaveProperty('request_id');
        expect(request.body).not.toHaveProperty('authority_id');
        expect(request.body).not.toHaveProperty('organization_id');
        expect(request.body).not.toHaveProperty('http_method');
        expect(request.body).not.toHaveProperty('http_path');
      }
    });
  });

  it('sends Slack link replay input without caller or route assertions', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const challengeCode = 'A'.repeat(43);
      const challengeAttemptId = fixtureId('cat', 1);
      const challengeMessageTs = '1755518400.000001';
      const observed: Array<{ path: string; body: Record<string, unknown> }> = [];
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        random_bytes: (size) => new Uint8Array(size),
        random_uuid: () => '00000000-0000-4000-8000-000000000113',
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === '/v1/authority-descriptor') {
            return json({ authority_descriptor: authority });
          }
          expect(new Headers(init?.headers).get('authorization')).toBe(
            `Bearer ${ROTATED_SESSION.access_token}`,
          );
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          observed.push({ path, body });
          if (path === '/v2/integration-links/slack/challenges') {
            return json(
              {
                schema_version: 2,
                kind: 'echo-organization-person-slack-link-begin-response',
                challenge_attempt_id: challengeAttemptId,
                provider: 'slack',
                provider_tenant_id: 'T123ABC',
                channel_id: 'C123ABC',
                challenge_message_ts: challengeMessageTs,
                expires_at: '2026-08-18T00:17:00.000Z',
              },
              201,
            );
          }
          expect(path).toBe('/v2/integration-links/slack/completions');
          return json({
            schema_version: 2,
            kind: 'echo-organization-person-slack-link-result',
            identity_link_id: fixtureId('clm', 1),
            connection_id: fixtureId('con', 1),
            organization_id: SESSION.organization_id,
            principal_id: SESSION.principal_id,
            membership_id: SESSION.membership_id,
            provider: 'slack',
            provider_tenant_id: 'T123ABC',
            provider_subject_id: 'U123PERSON',
            channel_id: 'C123ABC',
            linked_at: NOW,
            identity_link_created: true,
          });
        },
      });

      await client.installSession('https://authority.example', ROTATED_SESSION);
      const begun = await client.beginSlackLink();
      expect(begun.challenge_code).toBe(challengeCode);
      await client.completeSlackLink({
        challenge_attempt_id: begun.challenge_attempt_id,
        challenge_message_ts: begun.challenge_message_ts,
        challenge_code: begun.challenge_code,
      });

      expect(observed).toEqual([
        {
          path: '/v2/integration-links/slack/challenges',
          body: {
            challenge_code_sha256:
              organizationSlackLinkChallengeCodeSha256(challengeCode),
            request_id: 'psb_00000000-0000-4000-8000-000000000113',
          },
        },
        {
          path: '/v2/integration-links/slack/completions',
          body: {
            challenge_attempt_id: challengeAttemptId,
            challenge_code: challengeCode,
            challenge_message_ts: challengeMessageTs,
            request_id: 'psc_00000000-0000-4000-8000-000000000113',
          },
        },
      ]);
      for (const { body } of observed) {
        expect(body).not.toHaveProperty('schema_version');
        expect(body).not.toHaveProperty('kind');
        expect(body).not.toHaveProperty('authority_id');
        expect(body).not.toHaveProperty('organization_id');
        expect(body).not.toHaveProperty('subject_principal_id');
        expect(body).not.toHaveProperty('http_method');
        expect(body).not.toHaveProperty('http_path');
      }
    });
  });

  it('dispatches session install without a product config and never prints tokens', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let stdout = '';
      let stderr = '';
      const status = await runPersonClientCli(
        [
          'session-install',
          '--authority-url',
          'https://authority.example',
        ],
        {
          stdout: {
            write: (value: string | Uint8Array) => (
              (stdout += value.toString()), true
            ),
          },
          stderr: {
            write: (value: string | Uint8Array) => (
              (stderr += value.toString()), true
            ),
          },
          home_directory: home,
          now: () => NOW,
          read_input: () => JSON.stringify(SESSION),
          fetch: async () => json({ authority_descriptor: authority }),
        },
      );

      expect(status).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        authority_id: authority.authority_id,
        organization_id: SESSION.organization_id,
      });
      expect(stdout).not.toContain(SESSION.access_token);
      expect(stdout).not.toContain(SESSION.refresh_token);
    });
  });

  it('lists only the signed-in Person\'s exclusions for one exact source', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      const fetchImpl: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/authority-descriptor') {
          return json({ authority_descriptor: authority });
        }
        expect(path).toBe('/v2/member-exclusions/list');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${ROTATED_SESSION.access_token}`,
        );
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        expect(request).toMatchObject({
          subject_principal_id: SESSION.principal_id,
          source_adapter_id: 'granola',
          source_instance_id: 'founder-feed',
        });
        expect(request).not.toHaveProperty('target_principal_id');
        expect(request).not.toHaveProperty('target_membership_id');
        return json({
          schema_version: 2,
          kind: 'echo-organization-member-exclusion-list-response',
          authority_id: authority.authority_id,
          organization_id: SESSION.organization_id,
          subject_principal_id: SESSION.principal_id,
          membership_id: SESSION.membership_id,
          source_adapter_id: 'granola',
          source_instance_id: 'founder-feed',
          exclusions: [
            {
              scope: 'source',
              source_adapter_id: 'granola',
              source_instance_id: 'founder-feed',
            },
          ],
        });
      };
      const client = new PersonClient({
        home_directory: home,
        fetch: fetchImpl,
        now: () => NOW,
        random_uuid: () => '00000000-0000-4000-8000-000000000112',
      });

      await client.installSession(
        'https://authority.example',
        ROTATED_SESSION,
      );
      await expect(
        client.exclusions('granola', 'founder-feed'),
      ).resolves.toMatchObject({
        subject_principal_id: SESSION.principal_id,
        exclusions: [{ scope: 'source' }],
      });
    });
  });

  it('never replays a refresh credential after an ambiguous transport failure', async () => {
    await withHome(async (home) => {
      const authority = authorityDescriptor();
      let refreshCalls = 0;
      const client = new PersonClient({
        home_directory: home,
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === '/v1/authority-descriptor') {
            return json({ authority_descriptor: authority });
          }
          expect(path).toBe('/v2/session/refresh');
          refreshCalls += 1;
          throw new Error('connection outcome is unknown');
        },
      });
      await client.installSession('https://authority.example', SESSION);

      await expect(client.recentDecisions()).rejects.toThrow(/request failed/);
      await expect(client.recentDecisions()).rejects.toThrow(/sign in again/);
      expect(refreshCalls).toBe(1);
    });
  });
});
