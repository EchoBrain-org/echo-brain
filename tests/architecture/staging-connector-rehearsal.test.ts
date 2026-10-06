import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { canonicalSha256, p256KeyId } from '@echo-brain/federation-protocol';
import type { OrganizationPersonSessionV2 } from '@echo-brain/organization-api';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { runStagingConnectorRehearsal } from '../../tools/staging-connector-rehearsal.mjs';

const STAGING = 'https://authority-staging.echobrain.org';
const AUTHORITY = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION = 'org_00000000-0000-4000-8000-000000000002';
const MEMBER = 'mem_00000000-0000-4000-8000-000000000003';
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'echo-staging-connector-rehearsal-'));
  chmodSync(value, 0o700);
  roots.push(value);
  return value;
}

function profile(path: string) {
  const value = {
    schema_version: 2,
    kind: 'echo-staging-connector-rehearsal-profile-v2',
    capture_policy: 'initial-owner-granola-retained-jira-pointer-slack-pointer-v2',
    jira: { cloud_id: '12345678-1234-1234-1234-123456789abc', integration_key: 'jira', project: 'ECHO' },
    slack: { channel_id: 'CTEST123' },
  } as const;
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

function descriptor() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const bytes = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(bytes)) throw new Error('fixture key is invalid');
  return {
    authority_descriptor: {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: AUTHORITY,
      organization_id: ORGANIZATION,
      signing_key: {
        key_id: p256KeyId(bytes),
        algorithm: 'ecdsa-p256-sha256-der-low-s',
        public_key_spki_der_base64: bytes.toString('base64'),
      },
    },
  } as const;
}

function session(membership: 'owner' | 'employee' = 'owner'): OrganizationPersonSessionV2 {
  return {
    organization_id: ORGANIZATION,
    principal_id: 'prn_00000000-0000-4000-8000-000000000004',
    membership_id: MEMBER,
    display_name: 'Fixture Owner',
    membership_type: membership,
    identity_binding_id: 'oib_00000000-0000-4000-8000-000000000005',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000006',
    access_token: 'a'.repeat(43),
    refresh_token: 'b'.repeat(43),
    access_expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-01-02T00:00:00.000Z',
    hard_reauthentication_at: '2099-01-02T00:00:00.000Z',
  };
}

function install(
  home: string,
  origin = STAGING,
  membership: 'owner' | 'employee' = 'owner',
  overrides: Partial<ReturnType<typeof session>> = {},
) {
  const value = { ...session(membership), ...overrides };
  new PersonSessionStore(home).install(origin, AUTHORITY, value);
  return value;
}

function url(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function response(profileValue: ReturnType<typeof profile>, action: 'status' | 'verify-read') {
  const common = {
    schema_version: 2,
    kind: 'echo-staging-connector-rehearsal-receipt-v2',
    release_id: 'clean-v1-fixture-release',
    profile_sha256: canonicalSha256(profileValue),
    action,
    qualified: false,
  } as const;
  return action === 'status'
    ? { ...common, processing: 'active' as const, granola_available: true }
    : { ...common, tool: 'jira', result: { status: 'verified',
      source_coordinate_sha256: canonicalSha256('source'), text_sha256: canonicalSha256('content'), text_bytes: 42 } };
}

describe('staging connector rehearsal wrapper', () => {
  it('requests one fixed-scope read and validates content-free success or refusal without retrying', async () => {
    const directory = root(); const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json'); const configured = profile(profilePath);
    install(home);
    const accepted = { schema_version: 2, kind: 'echo-staging-connector-rehearsal-receipt-v2',
      release_id: 'clean-v1-fixture-release', profile_sha256: canonicalSha256(configured), action: 'verify-read', qualified: false,
      tool: 'jira', result: { status: 'verified', source_coordinate_sha256: canonicalSha256('coordinate'), text_sha256: canonicalSha256('text'), text_bytes: 42 } };
    const input = { action: 'verify-read' as const, release_id: accepted.release_id, profile_path: profilePath, person_home: home, tool: 'jira' as const };
    for (const remote of [accepted, { ...accepted, result: { status: 'refused', phase: 'inventory', reason: 'empty' } }]) {
      let reads = 0;
      assert.deepEqual(await runStagingConnectorRehearsal(input, { fetch: async (target, init) => {
        if (url(target).pathname === '/v1/authority-descriptor') return Response.json(descriptor());
        reads += 1;
        assert.deepEqual(JSON.parse(String(init?.body)), { schema_version: 2, release_id: accepted.release_id,
          profile_sha256: accepted.profile_sha256, action: 'verify-read', tool: 'jira' });
        return Response.json(remote);
      } }), remote);
      assert.equal(reads, 1);
    }
    for (const remote of [
      { ...accepted, release_id: 'clean-v1-other-release' },
      { ...accepted, profile_sha256: canonicalSha256('other') },
      { ...accepted, tool: 'slack' },
      { ...accepted, result: { ...accepted.result, text: 'private provider body' } },
      undefined,
    ]) {
      let reads = 0;
      await assert.rejects(runStagingConnectorRehearsal(input, { fetch: async target => {
        if (url(target).pathname === '/v1/authority-descriptor') return Response.json(descriptor());
        reads += 1;
        if (remote === undefined) throw new Error('private lost-response details');
        return Response.json(remote);
      } }), error => error instanceof Error && error.message === 'Staging connector rehearsal failed');
      assert.equal(reads, 1);
    }
  });

  it('rejects all retired capture commands before any request', async () => {
    for (const tool of ['granola', 'jira', 'slack']) {
      let calls = 0;
      await assert.rejects(runStagingConnectorRehearsal({ action: 'capture', release_id: 'clean-v1-fixture-release',
        profile_path: '/no-profile-needed', tool, limit: 1 } as never, {
        fetch: async () => { calls += 1; return Response.json({}); },
      }), /Staging connector rehearsal failed/);
      assert.equal(calls, 0);
    }
  });

  it('refuses a legacy receipt or content-bearing read receipt', async () => {
    const directory = root(); const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json'); const configured = profile(profilePath);
    install(home);
    const accepted = response(configured, 'verify-read');
    for (const receipt of [
      { ...accepted, schema_version: 1, kind: 'echo-staging-connector-rehearsal-receipt-v1' },
      { ...accepted, receipt: { source_text: 'private content' } },
    ]) {
      let reads = 0;
      await assert.rejects(runStagingConnectorRehearsal({ action: 'verify-read', release_id: 'clean-v1-fixture-release',
        profile_path: profilePath, person_home: home, tool: 'jira' }, {
        fetch: async input => {
          if (url(input).pathname === '/v1/authority-descriptor') return Response.json(descriptor());
          reads += 1; return Response.json(receipt);
        },
      }), /Staging connector rehearsal failed/);
      assert.equal(reads, 1);
    }
  });

  it('uses the installed owner session only against staging and prints no credential through its result', async () => {
    const directory = root();
    const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json');
    const configured = profile(profilePath);
    install(home);
    const calls: { readonly url: URL; readonly init?: RequestInit }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const target = url(input); calls.push({ url: target, init });
      assert.equal(target.origin, STAGING);
      if (target.pathname === '/v1/authority-descriptor') {
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        return Response.json(descriptor());
      }
      assert.equal(target.pathname, '/v1/staging/connector-rehearsal');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${'a'.repeat(43)}`);
      assert.equal(init?.redirect, 'error');
      return Response.json(response(configured, 'status'));
    };

    const result = await runStagingConnectorRehearsal({ action: 'status', release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: home }, { fetch });
    assert.deepEqual(result, response(configured, 'status'));
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(result).includes('a'.repeat(43)));
  });

  it('makes one read request and never retries a lost or refused response', async () => {
    const directory = root();
    const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json');
    profile(profilePath);
    install(home);
    let readCalls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const target = url(input);
      if (target.pathname === '/v1/authority-descriptor') return Response.json(descriptor());
      readCalls += 1;
      return new Response(JSON.stringify({ error: { code: 'internal', message: 'private source text must not escape' } }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    };
    await assert.rejects(
      runStagingConnectorRehearsal({ action: 'verify-read', release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: home, tool: 'jira' }, { fetch }),
      /Staging connector rehearsal failed/,
    );
    assert.equal(readCalls, 1);
  });

  it('rejects capture-only inputs and retired profiles before bearer traffic', async () => {
    const directory = root(); const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json'); const configured = profile(profilePath);
    install(home); let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls += 1; return Response.json({}); };
    const input = { action: 'verify-read' as const, release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: home, tool: 'jira' as const };
    await assert.rejects(runStagingConnectorRehearsal({ ...input, limit: 1 } as never, { fetch }));
    writeFileSync(profilePath, JSON.stringify({ ...configured, schema_version: 1, kind: 'echo-staging-connector-rehearsal-profile-v1' }));
    await assert.rejects(runStagingConnectorRehearsal(input, { fetch }));
    assert.equal(calls, 0);
  });

  it('refreshes an expired access session only through staging before the request', async () => {
    const directory = root();
    const home = join(directory, 'person-home');
    const profilePath = join(directory, 'profile.json');
    const configured = profile(profilePath);
    const initial = install(home, STAGING, 'owner', { access_expires_at: '2020-01-01T00:00:00.000Z' });
    const refreshed = {
      ...initial,
      access_token: 'c'.repeat(43),
      refresh_token: 'd'.repeat(43),
      access_expires_at: '2099-01-01T00:00:00.000Z',
    };
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const target = url(input);
      paths.push(target.pathname);
      assert.equal(target.origin, STAGING);
      assert.equal(init?.redirect, 'error');
      if (target.pathname === '/v1/authority-descriptor') return Response.json(descriptor());
      if (target.pathname === '/v2/session/refresh') return Response.json(refreshed);
      assert.equal(target.pathname, '/v1/staging/connector-rehearsal');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${'c'.repeat(43)}`);
      return Response.json(response(configured, 'status'));
    };
    const result = await runStagingConnectorRehearsal({ action: 'status', release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: home }, { fetch });
    assert.deepEqual(result, response(configured, 'status'));
    assert.deepEqual(paths, ['/v1/authority-descriptor', '/v2/session/refresh', '/v1/staging/connector-rehearsal']);
  });

  it('refuses a foreign or non-owner stored session before descriptor or bearer traffic', async () => {
    const directory = root();
    const profilePath = join(directory, 'profile.json');
    profile(profilePath);
    const foreignHome = join(directory, 'foreign');
    install(foreignHome, 'https://authority.example.test');
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls += 1; return Response.json({}); };
    await assert.rejects(
      runStagingConnectorRehearsal({ action: 'status', release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: foreignHome }, { fetch }),
      /Staging connector rehearsal failed/,
    );
    const employeeHome = join(directory, 'employee');
    install(employeeHome, STAGING, 'employee');
    await assert.rejects(
      runStagingConnectorRehearsal({ action: 'status', release_id: 'clean-v1-fixture-release', profile_path: profilePath, person_home: employeeHome }, { fetch }),
      /Staging connector rehearsal failed/,
    );
    assert.equal(calls, 0);
  });
});
