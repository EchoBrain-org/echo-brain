import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import { addMembership, authorization, revokeMembership } from '../fixtures/project-context-sqlite.js';
import { SyntheticProjectHarness, PEOPLE, SCENARIO, missingContext } from './synthetic-harness.js';

let h: SyntheticProjectHarness;
beforeEach(() => { h = new SyntheticProjectHarness(); });
afterEach(() => h.close());

const ids = (items: readonly { context_id: string }[]) => items.map(item => item.context_id).sort();
const denied = (run: () => unknown, code = 'not_found') => expect(run).toThrow(expect.objectContaining({ code }));

describe('PC-06 synthetic seams with real V7 custody (not cross-layer qualification)', () => {
  it('keeps two-project discovery and overlapping/disjoint memberships separate from audiences', () => {
    const s = h.seed();
    const discover = (person: typeof PEOPLE.alice) => h.read(person, { operation: 'project_list' }, (tx, scope) => tx.listProjects(scope, { limit: 10 })).items.map(item => item.project_id).sort();
    expect(discover(PEOPLE.alice)).toEqual([s.alpha, s.beta].sort());
    expect(discover(PEOPLE.bob)).toEqual([s.alpha]);
    expect(discover(PEOPLE.carol)).toEqual([s.beta]);
    expect(discover(PEOPLE.dana)).toEqual([]);
    expect(ids(h.feed(PEOPLE.alice, s.alpha).items)).toEqual([s.privateNote.context_id, s.team.context_id, s.project.context_id].sort());
    expect(ids(h.feed(PEOPLE.bob, s.alpha).items)).toEqual([s.team.context_id, s.project.context_id].sort());
    expect(h.feed(PEOPLE.carol, s.beta).items).toEqual([]);
    expect(h.search(PEOPLE.carol, s.beta).items).toEqual([]);
    expect(ids(h.feed(PEOPLE.alice, s.beta).items)).toEqual([s.cross.context_id]);
    denied(() => h.feed(PEOPLE.bob, s.beta));
    denied(() => h.original(PEOPLE.carol, s.cross.context_id, s.beta));
    // Generic audience-authorized read does not disclose the association.
    expect(h.original(PEOPLE.bob, s.cross.context_id)).toMatchObject({ text: SCENARIO.originals.cross.text });
    expect(h.original(PEOPLE.bob, s.cross.context_id)).not.toHaveProperty('project_id');
    expect(h.original(PEOPLE.dana, s.team.context_id)).toMatchObject({ audience: { kind: 'team' } });
    for (const person of [PEOPLE.bob, PEOPLE.carol, PEOPLE.dana]) {
      denied(() => h.original(person, s.privateNote.context_id));
    }
    h.member(s.alpha, PEOPLE.dana); // A new grant can read permitted history.
    expect(ids(h.search(PEOPLE.dana, s.alpha).items)).toEqual([s.team.context_id, s.project.context_id].sort());
    denied(() => h.original(PEOPLE.dana, s.privateNote.context_id, s.alpha));
  });

  it('does not grant private reads to a lead or change audience when association moves', () => {
    const s = h.seed();
    h.member(s.alpha, PEOPLE.bob, 'lead');
    denied(() => h.original(PEOPLE.bob, s.privateNote.context_id, s.alpha));
    const request = { schema_version: 1 as const, kind: 'echo-project-context-dissociate-v1' as const, request_id: h.requestId(), project_id: s.alpha, context_id: s.privateNote.context_id };
    const dissociate = (actor: typeof PEOPLE.alice) => h.repository.withWriteTransaction(tx => tx.dissociateContext(tx.captureAuthorization(authorization(actor), { operation: 'dissociate', request }), request));
    denied(() => dissociate(PEOPLE.bob));
    dissociate(PEOPLE.alice);
    const association = { ...request, request_id: h.requestId(), kind: 'echo-project-context-associate-v1' as const, project_id: s.beta };
    h.repository.withWriteTransaction(tx => tx.associateContext(tx.captureAuthorization(authorization(PEOPLE.alice), { operation: 'associate', request: association }), association));
    expect(h.original(PEOPLE.alice, s.privateNote.context_id, s.beta)).toMatchObject({ audience: { kind: 'only_me' }, text: SCENARIO.originals.private.text });
    expect(h.status(s.privateNote.request_id)).toMatchObject({ project_id: s.alpha, audience: { kind: 'only_me' } });
    expect(h.feed(PEOPLE.carol, s.beta).items).toEqual([]);
    denied(() => h.original(PEOPLE.carol, s.privateNote.context_id, s.beta));
  });

  it('rejects cursor reuse across project, operation, query, limit and requester', () => {
    const s = h.seed();
    const page = h.feed(PEOPLE.alice, s.alpha, 1);
    expect(page.next_cursor).toEqual(expect.any(String));
    const cursor = page.next_cursor!;
    denied(() => h.feed(PEOPLE.alice, s.beta, 1, cursor), 'invalid_request');
    denied(() => h.feed(PEOPLE.bob, s.alpha, 1, cursor), 'invalid_request');
    denied(() => h.feed(PEOPLE.alice, s.alpha, 2, cursor), 'invalid_request');
    denied(() => h.search(PEOPLE.alice, s.alpha, 'meridian', 1, cursor), 'invalid_request');
    const searchCursor = h.search(PEOPLE.alice, s.alpha, 'meridian', 1).next_cursor!;
    denied(() => h.search(PEOPLE.alice, s.alpha, 'private', 1, searchCursor), 'invalid_request');
    const next = h.feed(PEOPLE.alice, s.alpha, 1, cursor);
    expect(next.items).toHaveLength(1);
    expect(ids(next.items)).not.toEqual(ids(page.items));
    // Both IDs are readable independently; the wrong association still denies.
    denied(() => h.original(PEOPLE.alice, s.cross.context_id, s.alpha));
    denied(() => h.original(PEOPLE.alice, missingContext, s.alpha));
    h.remove(s.alpha, PEOPLE.bob);
    denied(() => h.feed(PEOPLE.bob, s.alpha, 1, cursor));
    expect(h.original(PEOPLE.bob, s.team.context_id).text).toBe(SCENARIO.originals.team.text);
  });

  it.each(['project', 'organization', 'session'] as const)('releases zero bytes and no audit after synthetic %s revocation at the final fence', kind => {
    const s = h.seed();
    const before = h.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get();
    const delivered: unknown[] = [];
    const run = () => {
      const response = h.read(PEOPLE.bob, { operation: 'context_read', project_id: s.alpha, context_id: s.project.context_id },
        (tx, scope) => tx.readContext(scope, s.alpha, s.project.context_id),
        () => {
          // Same-transaction fault injection tests the repository fence only.
          if (kind === 'project') h.database.prepare("UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = '2026-09-21T22:01:00.000Z' WHERE project_id = ? AND membership_id = ?").run(s.alpha, PEOPLE.bob.membership_id);
          if (kind === 'organization') revokeMembership(h.database, PEOPLE.bob);
        },
        () => authorization(PEOPLE.bob, kind === 'session' ? { session_state_sha256: canonicalSha256('changed synthetic session') } : {}),
      );
      delivered.push(response);
    };
    expect(run).toThrow();
    expect(delivered).toEqual([]);
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get()).toEqual(before);
  });

  it('commits only the exact released response digest and releases nothing on audit failure', () => {
    const s = h.seed();
    const response = h.feed(PEOPLE.bob, s.alpha);
    const audit = h.database.prepare('SELECT body_json FROM authority_project_read_audit_v1 ORDER BY rowid DESC LIMIT 1').get() as { body_json: string };
    expect(JSON.parse(audit.body_json)).toMatchObject({ response_sha256: canonicalSha256(response), released_count: 2 });
    expect(Object.isFrozen(response)).toBe(true);
    expect(audit.body_json).not.toContain(SCENARIO.originals.team.text);
    h.database.exec("CREATE TRIGGER pc06_fail_audit BEFORE INSERT ON authority_project_read_audit_v1 BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    const delivered: unknown[] = [];
    expect(() => delivered.push(h.original(PEOPLE.bob, s.project.context_id))).toThrow('synthetic audit failure');
    expect(delivered).toEqual([]);
  });

  it.each(['ready', 'unavailable'] as const)('keeps original read/search usable before, during and after optional hints become %s', async outcome => {
    const s = h.seed();
    const before = h.original(PEOPLE.bob, s.project.context_id);
    const proveOriginal = () => {
      expect(h.original(PEOPLE.bob, s.project.context_id)).toEqual(before);
      expect(ids(h.search(PEOPLE.bob, s.alpha).items)).toContain(s.project.context_id);
      const generic = h.read(PEOPLE.bob, { operation: 'upload_search' }, (tx, scope) => tx.searchUploads(scope, { query: 'meridian', limit: 10 }));
      expect(ids(generic.results)).toContain(s.project.context_id);
    };
    expect(h.status(s.project.request_id).metadata).toBe('pending');
    proveOriginal();
    const model = vi.fn(async (source: { title: string; text: string }) => {
      expect(source).toEqual(SCENARIO.originals.alpha);
      expect(h.status(s.project.request_id).metadata).toBe('processing');
      proveOriginal();
      if (outcome === 'unavailable') throw new Error('synthetic model failure');
      return 'zenith';
    });
    expect(await h.enrich(s.project.context_id, model)).toBe(outcome);
    expect(model).toHaveBeenCalledTimes(1);
    expect(h.status(s.project.request_id).metadata).toBe(outcome);
    proveOriginal();
    expect(ids(h.search(PEOPLE.bob, s.alpha, 'zenith').items)).toEqual(outcome === 'ready' ? [s.project.context_id] : []);
    denied(() => h.original(PEOPLE.carol, s.project.context_id));
  });

  it.each(['before', 'during', 'remove-rejoin', 'organization'] as const)('uses current uploader eligibility: %s model handoff', async point => {
    const s = h.seed();
    h.member(s.alpha, PEOPLE.bob, 'lead');
    const revoke = () => point === 'organization' ? revokeMembership(h.database, PEOPLE.alice) : h.remove(s.alpha, PEOPLE.alice, PEOPLE.bob);
    if (point === 'before') revoke();
    const model = vi.fn(async () => {
      revoke();
      if (point === 'remove-rejoin') h.member(s.alpha, PEOPLE.alice, 'member', PEOPLE.bob);
      return 'mustneverpersist';
    });
    expect(await h.enrich(s.cross.context_id, model)).toBe(point === 'before' ? 'ineligible' : 'unavailable');
    expect(model).toHaveBeenCalledTimes(point === 'before' ? 0 : 1);
    expect(h.database.prepare('SELECT search_hints, enrichment_sha256 FROM authority_person_update_work_v2 WHERE context_id = ?').get(s.cross.context_id)).toEqual({ search_hints: '', enrichment_sha256: null });
    expect(h.original(PEOPLE.bob, s.cross.context_id).text).toBe(SCENARIO.originals.cross.text);
    if (point !== 'remove-rejoin') denied(() => h.original(PEOPLE.alice, s.cross.context_id), point === 'organization' ? 'unauthorized' : 'not_found');
  });

  it('ignores association-project removal for enrichment and never widens the original audience', async () => {
    const s = h.seed();
    h.member(s.beta, PEOPLE.carol, 'lead');
    const result = await h.enrich(s.cross.context_id, async () => {
      h.remove(s.beta, PEOPLE.alice, PEOPLE.carol);
      return 'zenith';
    });
    expect(result).toBe('ready');
    expect(h.original(PEOPLE.bob, s.cross.context_id)).toMatchObject({ audience: { kind: 'project', project_id: s.alpha }, text: SCENARIO.originals.cross.text });
    expect(h.feed(PEOPLE.carol, s.beta).items).toEqual([]);
    denied(() => h.original(PEOPLE.carol, s.cross.context_id));
  });

  it('retains one immutable upload and one work row after a lost reply, restart and exact replay', () => {
    const s = h.seed();
    const draft = h.draft(s.beta, { kind: 'project', project_id: s.alpha });
    let committed: ReturnType<typeof h.submit> | undefined;
    const delivered: unknown[] = [];
    expect(() => {
      committed = h.submit(draft);
      throw new Error('synthetic response timeout after commit');
    }).toThrow('synthetic response timeout');
    expect(delivered).toEqual([]);
    h.restart();
    expect(h.database.pragma('user_version', { simple: true })).toBe(7);
    expect(h.status(draft.request_id)).toMatchObject({ context_id: committed!.context_id, metadata: 'pending', audience: draft.audience, project_id: s.beta });
    expect(h.submit(draft)).toEqual(committed);
    for (const changed of [{ audience: { kind: 'team' } }, { project_id: s.alpha }, { text: 'Changed source' }]) {
      denied(() => h.submit({ ...draft, ...changed }), 'conflict');
    }
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_update_work_v2 WHERE context_id = ?').get(committed!.context_id)).toEqual({ n: 1 });
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2 WHERE request_id = ?').get(draft.request_id)).toEqual({ n: 1 });
    expect(h.original(PEOPLE.bob, committed!.context_id).text).toBe(draft.text);
    denied(() => h.original(PEOPLE.carol, committed!.context_id));
  });

  it('does not inherit a revoked organization tenure after restart', () => {
    const s = h.seed();
    revokeMembership(h.database, PEOPLE.bob);
    const rejoined = { ...PEOPLE.bob, membership_id: 'mem_00000000-0000-4000-8000-000000000999' };
    addMembership(h.database, rejoined, 'bob', 'bob@example.test');
    h.restart();
    denied(() => h.original(rejoined, s.project.context_id));
    expect(h.original(rejoined, s.team.context_id).audience).toEqual({ kind: 'team' });
    h.member(s.alpha, rejoined);
    expect(h.original(rejoined, s.project.context_id).text).toBe(SCENARIO.originals.alpha.text);
  });

  it('keeps unsupported versions explicit at the frozen codec/fixture seam', () => {
    const alpha = h.create('Synthetic Alpha');
    const draft = h.draft(alpha, { kind: 'project', project_id: alpha });
    expect(() => validatePersonUpdateSubmitV1(draft)).toThrow();
    expect(() => validatePersonUpdateSubmitV2({ ...draft, schema_version: 3 })).toThrow();
    expect(() => h.submit({ ...draft, audience: { kind: 'team', project_id: alpha } })).toThrow();
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2').get()).toEqual({ n: 0 });
    // These are frozen expected client outcomes, not evidence of a real client.
    const fixtures = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/project-context-v1/invalid.json', import.meta.url), 'utf8'));
    const error = (id: string) => fixtures.errors.find((entry: { id: string }) => entry.id === id);
    expect(error('unavailable-project-capability')).toMatchObject({ cli: { action: 'projects-list', code: 'not_found' }, ui: 'not_live_yet' });
    expect(error('individual-project-non-disclosure')).toMatchObject({ cli: { action: 'projects-read', code: 'not_found' }, ui: 'not_found' });
    expect(error('v2-submit-unknown-outcome').cli).toMatchObject({ mutation_outcome: 'unknown', request_id: expect.any(String) });
  });

  it('adds only original custody/work/receipt/association/audit rows, with no meeting, approval or second queue', async () => {
    const counts = () => {
      const tables = h.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      return Object.fromEntries(tables.map(({ name }) => [name, (h.database.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n]));
    };
    const alpha = h.create('Synthetic Alpha');
    const before = counts();
    const receipt = h.submit(h.draft(alpha, { kind: 'project', project_id: alpha }));
    await h.enrich(receipt.context_id, async () => 'zenith');
    const after = counts();
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const changed = Object.keys(after).filter(name => after[name] !== before[name]);
    expect(changed.sort()).toEqual([
      'authority_person_updates_v2', 'authority_person_update_work_v2',
      'authority_project_command_receipts_v1', 'authority_project_context_associations_v1',
      'authority_project_read_audit_v1',
    ].sort());
    const operations = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/project-context-v1/operations.json', import.meta.url), 'utf8'));
    expect(JSON.stringify(operations)).not.toMatch(/\/ask|MeetingDocument|\/approval|\/records/);
  });
});
