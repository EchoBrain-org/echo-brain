import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { validatePersonAnswerResponseV7, type PersonAnswerRequestV3 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SqlitePersonAgenticAskAuditV1 } from '../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { JIRA_LIVE_CONNECTOR_V1 } from '../src/composition/person-live-connector-registry-v1.js';
import { bindPersonLiveEvidenceDeskV1, createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

type Prompt = { readonly question?: string; readonly step?: number; readonly source_catalog?: readonly { readonly source: string }[] };
type Step = { readonly actions: readonly unknown[]; readonly found?: boolean };
const empty = Object.freeze({ items: Object.freeze([]), truncated: false, receipt_digests: Object.freeze([]) });

/**
 * A scripted research model: each step's actions in turn, then a writer that
 * states one sentence from the first evidence item. `onAnswer` runs inside
 * the writer call, after the check before it.
 */
function scripted(steps: readonly Step[], options: { readonly onAnswer?: () => void } = {}) {
  const prompts: string[] = [];
  const queue = [...steps];
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    prompts.push(input.user_prompt);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      options.onAnswer?.();
      return { sentences: [{ text: 'The launch follow-up on the pilot decision is still open.', evidence: ['E1'] }], not_found: [] };
    }
    const step = queue.shift() ?? { actions: [{ tool: 'finish', args: {} }], found: true };
    return { parts: [{ question: prompt.question!, notes: '', needs: [{ need: 'Open follow-ups', status: step.found === true ? 'found' : 'open', evidence: step.found === true ? ['E1'] : [] }] }], actions: step.actions };
  } };
  return { model, prompts, catalog: () => (JSON.parse(prompts[0]!) as Prompt).source_catalog!.map(entry => entry.source) };
}

/** The Ask route over the open-items fixture's Authority: Jira through a reader that opens what the fixture's desk opens for that person. */
function routeOf(f: OpenItemsFixtureV1, model: StructuredGenerationPort, version: 5 | 6 | 7 = 7) {
  const sessions = f.openItemsOptions.sessions;
  const jira = (name: FixturePerson): PersonLiveEvidenceSourceV1 => ({
    tool_id: 'jira', search: vi.fn(async () => empty as never), open: vi.fn(async () => empty as never), list: vi.fn(async () => empty as never),
    openCitation: vi.fn(async ({ citation }) => f.openCitation(name, citation as never) as never), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}),
  });
  const options: CreatePersonLiveAnswerRouteOptionsV1 = {
    authority_id: 'authority', organization_id: f.person.organization_id, state_lineage_id: 'lineage',
    sessions: sessions as never, originals: new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, f.person.organization_id),
    records: { initializeDesk() { throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1_000 },
    audit: new SqlitePersonAgenticAskAuditV1(f.db),
    live_sources: [{ ...JIRA_LIVE_CONNECTOR_V1, application: { source: async ({ access_token }) => jira(access_token as FixturePerson) } }],
    follow_ups: { runs: f.runs, items: f.items, people: f.directory, records: f.records, on_live_failure: () => {} },
  };
  const route = version === 7 ? createPersonLiveAnswerRouteV1(options, 7) : version === 6 ? createPersonLiveAnswerRouteV1(options, 6) : createPersonLiveAnswerRouteV1(options, 5);
  return { route, options };
}
const ask = (route: ReturnType<typeof routeOf>['route'], access_token: FixturePerson, request: Partial<PersonAnswerRequestV3> = {}) =>
  route.ask({ access_token, request: { schema_version: 3, question: 'What are my open tasks?', ...request } });
const auditBodies = (f: OpenItemsFixtureV1) => (f.db.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all() as { body_json: string }[])
  .map(row => JSON.parse(row.body_json) as Record<string, unknown>);
function leaveProject(f: OpenItemsFixtureV1, name: FixturePerson) {
  f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'")
    .run(f.clock().toISOString(), f.projectA, f.membership(name));
}

describe('Ask V7 with follow-ups as evidence (ADR-0040)', () => {
  it('answers from a follow-up, cites it with the ref that opens its item page, and audits every release', async () => {
    const f = await sentFixture();
    const { model, prompts, catalog } = scripted([
      { actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'launch' } }] },
      { actions: [{ tool: 'list', args: { source: 'follow_ups' } }] },
    ]);
    const answer = await ask(routeOf(f, model).route, 'mina');
    expect(catalog()).toContain('follow_ups');
    expect(validatePersonAnswerResponseV7(answer)).toEqual(answer);
    expect(answer).toMatchObject({ schema_version: 7, kind: 'echo-clean-person-answer-v7', outcome: 'answered' });
    // The follow-up the search found first: the ticket, titled from Mina's own Jira read.
    expect(answer.citations).toEqual([{
      citation: { kind: 'follow_up', item_id: f.ticket.item_id }, kind: 'follow_up', label: `ECHO-12 ${f.outsideText}`, visibility: 'only_me', ref: `follow_up:${f.ticket.item_id}`,
    }]);
    // That title is private to her, as the ticket itself would be.
    expect(answer.parts.flatMap(part => part.statements)).toEqual([expect.objectContaining({ citation_indexes: [0], private: true })]);
    // What the model read: owner, status, check and decision as text; never the item's id, ref, pointer or the decision's ref.
    const research = prompts.join('\n');
    expect(research).toContain('Pilot planning');
    expect(research).not.toMatch(/itm_|follow_up:|meeting:sha256|browse\/ECHO-12/);
    const bodies = auditBodies(f);
    const releases = bodies.filter(body => body.kind === 'echo-person-follow-up-release-audit-v1');
    expect(releases.map(body => body.operation)).toEqual(expect.arrayContaining(['list', 'search']));
    const terminal = bodies.find(body => body.kind === 'echo-person-agentic-ask-audit-v1')!;
    expect(terminal).toMatchObject({ outcome: 'answered', request_id: releases[0]!.request_id });
    expect(JSON.stringify(releases)).not.toMatch(/Pilot planning|launch next week|Mina Patel|Kestrel|ECHO-12/);
  });

  it("never shows a follow-up's tool words to an asker who cannot open the tool item", async () => {
    const f = await sentFixture();
    const { model, prompts } = scripted([
      { actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'ECHO-12' } }] },
      { actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'launch' } }] },
    ]);
    const answer = await ask(routeOf(f, model).route, 'rafael');
    expect(answer.outcome).toBe('answered');
    expect(answer.citations).toEqual([expect.objectContaining({ kind: 'follow_up', label: 'launch next week', visibility: 'project' })]);
    expect(answer.parts.flatMap(part => part.statements)[0]!.private).toBe(false);
    const seen = prompts.join('\n') + JSON.stringify(answer);
    expect(seen).not.toContain(f.outsideText);
    expect(seen).not.toContain('2026-10-30');
  });

  it('refuses the answer when a cited follow-up stops being visible before release', async () => {
    const control = await sentFixture();
    const steps = [{ actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'rollout pilot planning' } }] }];
    expect((await ask(routeOf(control, scripted(steps).model).route, 'rafael')).outcome).toBe('answered');
    const f = await sentFixture();
    const { model } = scripted([{ actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'rollout pilot planning' } }] }], {
      // Rafael leaves project A while the answer is written: he reads neither the decision nor its items any more.
      onAnswer: () => leaveProject(f, 'rafael'),
    });
    await expect(ask(routeOf(f, model).route, 'rafael')).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(auditBodies(f).filter(body => body.kind === 'echo-person-agentic-ask-audit-v1' && body.outcome === 'answered')).toEqual([]);
  });

  it('binds follow-ups only for a V7 answer outside Mine, and never for trigger research or open items', async () => {
    const f = await sentFixture();
    const finish = [{ actions: [{ tool: 'finish', args: {} }] }];
    for (const [version, request, expected] of [
      [7, {}, true], [7, { project_id: f.projectA }, true], [7, { mine: true }, false], [6, {}, false], [5, {}, false],
    ] as const) {
      const { model, catalog } = scripted(finish);
      await ask(routeOf(f, model, version).route, 'mina', request as Partial<PersonAnswerRequestV3>).catch(() => undefined);
      expect([version, request, catalog().includes('follow_ups')]).toEqual([version, request, expected]);
    }
    // The desks trigger research and open items bind name no answer version, so they never bind follow-ups.
    const { options } = routeOf(f, scripted([]).model);
    const context = { authority_id: 'authority', organization_id: f.person.organization_id, state_lineage_id: 'lineage', principal_id: f.people.mina.principal_id,
      membership_id: f.people.mina.membership_id, session_family_id: 'psf_mina', request_id: `trigger_run_${randomUUID()}` };
    const background = await bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'mina', scope: { kind: 'global' } }, context);
    expect(background.live_sources).toEqual([]);
    const ask7 = await bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'mina', scope: { kind: 'global' }, response_version: 7 }, context);
    expect(ask7.live_sources).toEqual([expect.objectContaining({ source_id: 'follow_ups' })]);
    // A desk bound for one person never reads follow-ups as another.
    await expect(bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'rafael', scope: { kind: 'global' }, response_version: 7 }, context)).rejects.toMatchObject({ code: 'stale_access_state' });
  });
});
