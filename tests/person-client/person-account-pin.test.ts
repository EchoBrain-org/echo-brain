import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolProviderV1 } from '@echo-brain/organization-api';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { signedInHome } from './signed-in-home.js';

// The account pin: paired --expected-membership-id and --expected-authority on any command that acts for one account,
// as the desktop passes them on every call. The run is that account's, or it is refused, saying whether it went out.

const NOW = '2026-10-31T10:00:00.000Z';
const AUTHORITY = 'https://authority.example.test';
const MEMBERSHIP = 'mem_00000000-0000-4000-8000-000000000001';
const OTHER = 'mem_00000000-0000-4000-8000-000000000002';
const CHANGES = {
  kind: 'echo-person-changes-v1',
  areas: { projects: canonicalSha256(['projects']), follow_ups: canonicalSha256(['follow_ups']), reviews: canonicalSha256([]) },
  check_again_after_seconds: 60,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const pin = (membership = MEMBERSHIP, authority = AUTHORITY) => [`--expected-membership-id=${membership}`, `--expected-authority=${authority}`];

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function sessionHome(): string {
  const home = signedInHome({ prefix: 'echo-person-pin-', now: NOW, authority: AUTHORITY });
  homes.push(home);
  return home;
}

async function run(home: string, argv: readonly string[], fetch: typeof globalThis.fetch, tool_providers?: readonly PersonToolProviderV1[]) {
  const output = { stdout: '', stderr: '' };
  const code = await runPersonClientCli(argv, {
    home_directory: home, now: () => NOW, fetch, ...(tool_providers === undefined ? {} : { tool_providers }),
    stdout: { write: value => { output.stdout += value; } }, stderr: { write: value => { output.stderr += value; } },
  });
  return { code, ...output, failure: output.stderr === '' ? undefined : JSON.parse(output.stderr.trim().split('\n').at(-1)!) as Record<string, unknown> };
}

/** Another person's session, installed over this one as a sign-in elsewhere does. */
function switchAccount(home: string): void {
  const store = new PersonSessionStore(home);
  const stored = store.read();
  store.install(stored.authority_origin, stored.authority_id, { ...stored.session, membership_id: OTHER });
}

describe('a run pinned to an account', () => {
  it('runs as usual for the signed-in account', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(CHANGES));
    const pinned = await run(sessionHome(), ['changes', ...pin()], fetch);
    expect(pinned).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(pinned.stdout)).toEqual(CHANGES);
  });

  it('sends nothing for another account, another organization, or no one signed in, and says which', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const [argv, code] of [[pin(OTHER), 'account_changed'], [pin(MEMBERSHIP, 'https://other.example.test'), 'account_changed']] as const) {
      const refused = await run(sessionHome(), ['changes', ...argv], fetch);
      expect(refused).toMatchObject({ code: 1, stdout: '', failure: { ok: false, action: 'changes', code, sent: false } });
    }
    const signedOut = sessionHome();
    rmSync(new PersonSessionStore(signedOut).paths.live);
    expect(await run(signedOut, ['changes', ...pin()], fetch)).toMatchObject({ code: 1, stdout: '', failure: { code: 'signed_out', sent: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names why a refresh ended the session, never that the account changed', async () => {
    const home = sessionHome();
    const store = new PersonSessionStore(home);
    // The weekly sign-in has passed: the refresh this run needs ends the session before anything is sent.
    const later = () => '2026-11-08T10:00:00.000Z';
    const fetch = vi.fn<typeof globalThis.fetch>();
    const expired = await runPersonClientCli(['changes', ...pin()], { home_directory: home, now: later, fetch,
      stdout: { write: () => undefined }, stderr: { write: () => undefined } });
    expect(expired).toBe(1);
    expect(store.readEnded()).toMatchObject({ reason: 'reauthentication_required' });
    // Every pinned run after it says so too.
    expect(await run(home, ['changes', ...pin()], fetch)).toMatchObject({ code: 1, failure: { code: 'reauthentication_required', sent: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('withholds what it read once another account signed in while it ran, saying it went out', async () => {
    const home = sessionHome();
    const switched = await run(home, ['changes', ...pin()], vi.fn<typeof globalThis.fetch>(async () => { switchAccount(home); return json(CHANGES); }));
    expect(switched).toMatchObject({ code: 1, stdout: '', failure: { ok: false, action: 'changes', code: 'account_changed', sent: true } });
    const out = sessionHome();
    const signedOut = await run(out, ['changes', ...pin()], vi.fn<typeof globalThis.fetch>(async () => {
      rmSync(new PersonSessionStore(out).paths.live);
      return json(CHANGES);
    }));
    expect(signedOut).toMatchObject({ code: 1, stdout: '', failure: { code: 'signed_out', sent: true } });
  });

  it('checks again once a command that checks no account itself has printed, so its output is not taken as the pinned account\'s', async () => {
    // A tool step prints what the tool said; the pin still decides the run.
    let signInElsewhere: string | undefined;
    const tool: PersonToolProviderV1 = { tool_id: 'fixture', verbs: { status: { description: 'Reads a step.', options: {}, run: async ({ print }) => {
      print({ ok: true, result: { status: 'pending' } });
      if (signInElsewhere !== undefined) switchAccount(signInElsewhere);
    } } } };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const pinned = await run(sessionHome(), ['tools', 'status', '--tool', 'fixture', ...pin()], fetch, [tool]);
    expect(pinned).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(pinned.stdout)).toEqual({ ok: true, result: { status: 'pending' } });
    signInElsewhere = sessionHome();
    const refused = await run(signInElsewhere, ['tools', 'status', '--tool', 'fixture', ...pin()], fetch, [tool]);
    expect(refused).toMatchObject({ code: 1, failure: { code: 'account_changed', sent: true } });
  });

  it('takes both options or neither, and never on a command about the session itself', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const lone = await run(sessionHome(), ['changes', `--expected-membership-id=${MEMBERSHIP}`], fetch);
    expect(lone).toMatchObject({ code: 2, failure: { ok: false, error: '--expected-membership-id and --expected-authority must be given together' } });
    for (const command of [['status'], ['logout'], ['session-refresh']]) {
      expect((await run(sessionHome(), [...command, ...pin()], fetch)).code, command[0]).toBe(2);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
