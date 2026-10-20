import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { validatePersonAnswerResponseV7, type PersonAnswerRequestV3 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SqlitePersonAgenticAskAuditV1 } from '../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonSessionRepository } from '../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { JIRA_LIVE_CONNECTOR_V1 } from '../src/composition/person-live-connector-registry-v1.js';
import { bindPersonLiveEvidenceDeskV1, createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { assign, sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

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

type StepPrompt = Prompt & { readonly asked_by?: string; readonly last_results?: readonly { readonly tool: string; readonly args?: { readonly owner?: string }; readonly items?: readonly string[]; readonly results?: readonly string[] }[] };
/**
 * A planner that does what "my open tasks" asks: it lists follow-ups owned by
 * the asker (`asked_by`, as the route names them) that are open, runs any
 * `probes` steps, opens the first follow-up the owner list returned, and
 * finishes on it. The writer states one sentence from it.
 */
function myOpenTasks(probes: readonly (readonly unknown[])[] = [], options: { readonly onAnswer?: () => void } = {}) {
  const steps: StepPrompt[] = [];
  const writer: string[] = [];
  let mine: string | undefined;
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as StepPrompt & { readonly evidence?: readonly { readonly id: string }[] };
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      writer.push(input.user_prompt);
      options.onAnswer?.();
      return { sentences: [{ text: 'Your open follow-up is on the launch ticket.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    steps.push(prompt);
    mine ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.owner !== undefined)?.items?.[0];
    const index = steps.length - 1;
    const actions = index === 0 ? [{ tool: 'list', args: { source: 'follow_ups', owner: prompt.asked_by, status: 'open' } }]
      : index <= probes.length ? probes[index - 1]!
        : index === probes.length + 1 && mine !== undefined ? [{ tool: 'open', args: { id: mine } }]
          : [{ tool: 'finish', args: {} }];
    const found = actions[0] !== undefined && (actions[0] as { readonly tool: string }).tool === 'finish' && mine !== undefined;
    return { parts: [{ question: prompt.question!, notes: '', needs: [{ need: 'Open follow-ups', status: found ? 'found' : 'open', evidence: found ? [mine] : [] }] }], actions };
  } };
  return { model, steps, writer, seen: () => [...steps.map(step => JSON.stringify(step)), ...writer].join('\n') };
}
/** The V7 route as the runtime builds it, with the asker's own directory entry, so the loop reads "my" as their name. */
function myTasksRoute(f: OpenItemsFixtureV1, model: StructuredGenerationPort) {
  const repository = new SqlitePersonSessionRepository(f.db);
  const memberships = { membership: (id: string) => repository.read(transaction => transaction.membership(id)) };
  return createPersonLiveAnswerRouteV1({ ...routeOf(f, model).options, memberships }, 7);
}
const followUpReleases = (f: OpenItemsFixtureV1) => auditBodies(f).filter(body => body.kind === 'echo-person-follow-up-release-audit-v1') as
  { readonly operation: string; readonly principal_id: string; readonly items: readonly { readonly item_id: string }[] }[];

describe('"What are my open tasks?" through the real Authority composition (ADR-0040)', () => {
  it("lists the asker's open follow-ups by owner at the desk, opens one, and cites it with the follow-up kind and ref", async () => {
    const f = await sentFixture();
    // Mina owns the ticket's follow-up; Ari, the approver ECHO fell back to, owns the action's. Mina sees both.
    expect([f.ticket.state, f.action.state]).toEqual(['open', 'open']);
    const planner = myOpenTasks();
    const answer = await myTasksRoute(f, planner.model).ask({ access_token: 'mina', request: { schema_version: 3, question: 'What are my open tasks?' } });

    expect(validatePersonAnswerResponseV7(answer)).toEqual(answer);
    expect(answer).toMatchObject({ schema_version: 7, kind: 'echo-clean-person-answer-v7', outcome: 'answered' });
    // Research read "my" as her name, and the desk applied owner and status, as the result says: only her follow-up came
    // back, with its decision beside it (research tool contract v1).
    expect(planner.steps[0]!.asked_by).toBe('Mina Patel');
    expect(planner.steps[1]!.last_results).toEqual([{
      tool: 'list', args: { source: 'follow_ups', owner: 'Mina Patel', status: 'open' }, filters: { owner: 'applied', status: 'applied' }, list: 'L1', items: ['E1'], linked: ['E2'], more: false,
    }]);
    expect(planner.steps[2]!.last_results).toEqual([expect.objectContaining({ tool: 'open', opened: ['E1'] })]);
    // The answer cites it as a follow-up, with the open ref that names its item for the desktop.
    expect(answer.citations).toEqual([{
      citation: { kind: 'follow_up', item_id: f.ticket.item_id }, kind: 'follow_up', label: `ECHO-12 ${f.outsideText}`, visibility: 'only_me', ref: `follow_up:${f.ticket.item_id}`,
    }]);
    expect(answer.parts.flatMap(part => part.statements)).toEqual([expect.objectContaining({ citation_indexes: [0], private: true })]);
    // The writer read what the follow-up is: its owner, status and due date, and its decision; and beside it the ticket it
    // follows, as Mina's own Jira read gave it (research tool contract v1).
    const evidence = (JSON.parse(planner.writer[0]!) as { evidence: unknown[] }).evidence;
    expect(evidence).toEqual([expect.objectContaining({
      id: 'E1', source: 'follow_ups', kind: 'follow_up', title: `ECHO-12 ${f.outsideText}`, provenance: { kind: 'follow_up' },
      attributes: { owner: 'Mina Patel', status: 'open', due_at: '2026-10-30' }, text: expect.stringContaining('Decision: Pilot planning'),
    }), expect.objectContaining({ id: 'E2', source: 'tickets', kind: 'ticket', title: `ECHO-12 ${f.outsideText}`, provenance: { kind: 'ticket' } })]);
    // Ari's follow-up never left the desk, and the list and the open were each audited, as Mina, before release.
    expect(planner.seen()).not.toContain(f.action.item_id);
    expect(planner.seen()).not.toContain('Thermostat rollout plan');
    const releases = followUpReleases(f);
    expect(releases.map(release => [release.operation, release.items.map(item => item.item_id)])).toEqual([['list', [f.ticket.item_id]], ['open', [f.ticket.item_id]]]);
    expect(new Set(releases.map(release => release.principal_id))).toEqual(new Set([f.people.mina.principal_id]));
    expect(auditBodies(f).find(body => body.kind === 'echo-person-agentic-ask-audit-v1')).toMatchObject({ outcome: 'answered' });
  });

  it('reads "my" as the asker alone, though another member\'s name holds theirs', async () => {
    const f = await sentFixture();
    // Rafael, renamed "Ari Moreno", takes the ticket; Ari still owns the action.
    f.db.prepare('UPDATE authority_principals SET display_name=? WHERE principal_id=?').run('Ari Moreno', f.people.rafael.principal_id);
    await assign(f, 'ari', f.ticket.item_id, 'rafael');
    const planner = myOpenTasks();
    const answer = await myTasksRoute(f, planner.model).ask({ access_token: 'ari', request: { schema_version: 3, question: 'What are my open tasks?' } });
    expect(planner.steps[0]!.asked_by).toBe('Ari');
    expect(planner.steps[1]!.last_results).toEqual([{ tool: 'list', args: { source: 'follow_ups', owner: 'Ari', status: 'open' }, filters: { owner: 'applied', status: 'applied' }, list: 'L1', items: ['E1'], more: false }]);
    expect(answer.citations).toEqual([expect.objectContaining({ kind: 'follow_up', citation: { kind: 'follow_up', item_id: f.action.item_id } })]);
    expect(new Set(followUpReleases(f).flatMap(release => release.items.map(item => item.item_id)))).toEqual(new Set([f.action.item_id]));
  });

  it('refuses the answer when the asker stops reading the decision their own follow-up carried', async () => {
    const f = await sentFixture();
    // Mina leaves project A while the answer is written: the ticket is still hers, but the decision released with it is not.
    const planner = myOpenTasks([], { onAnswer: () => leaveProject(f, 'mina') });
    await expect(myTasksRoute(f, planner.model).ask({ access_token: 'mina', request: { schema_version: 3, question: 'What are my open tasks?' } }))
      .rejects.toMatchObject({ code: 'stale_access_state' });
    // Only her own follow-up was released, each time with its decision.
    expect(new Set(followUpReleases(f).flatMap(release => release.items.map(item => item.item_id)))).toEqual(new Set([f.ticket.item_id]));
    expect((JSON.parse(planner.writer[0]!) as { evidence: { text: string }[] }).evidence[0]!.text).toContain('Decision: Pilot planning');
    expect(auditBodies(f).filter(body => body.kind === 'echo-person-agentic-ask-audit-v1' && body.outcome === 'answered')).toEqual([]);
  });

  it('never shows the asker a follow-up they cannot see: not by owner, by an unfiltered list, or by its words', async () => {
    // S. Okafor owns the ticket's follow-up but is not in project A. Ari's follow-up on the action is in project A only.
    const f = await sentFixture({ ticketOwner: 'okafor' });
    const hidden = f.action.item_id;
    // The control: Ari, who owns it, finds it by the same question.
    const control = myOpenTasks();
    const ari = await myTasksRoute(f, control.model).ask({ access_token: 'ari', request: { schema_version: 3, question: 'What are my open tasks?' } });
    expect(ari.citations).toEqual([expect.objectContaining({ kind: 'follow_up', citation: { kind: 'follow_up', item_id: hidden }, ref: `follow_up:${hidden}` })]);

    const before = followUpReleases(f).length;
    // One step of probes: a step that finds nothing new is idle, and two idle steps end research.
    const planner = myOpenTasks([[
      { tool: 'list', args: { source: 'follow_ups' } },
      { tool: 'list', args: { source: 'follow_ups', owner: 'Ari', status: 'open' } },
      { tool: 'search', args: { source: 'follow_ups', query: 'Ari pilot planning rollout' } },
      { tool: 'search', args: { query: 'pilot starts next week' } },
    ]]);
    const answer = await myTasksRoute(f, planner.model).ask({ access_token: 'okafor', request: { schema_version: 3, question: 'What are my open tasks?' } });

    expect(answer.outcome).toBe('answered');
    // His own follow-up only, without the decision he does not read.
    expect(answer.citations).toEqual([expect.objectContaining({ kind: 'follow_up', citation: { kind: 'follow_up', item_id: f.ticket.item_id }, ref: `follow_up:${f.ticket.item_id}` })]);
    // Every list and search returned his follow-up or nothing (the search across sources finds his by "next week"):
    // Ari's never appears, nor its owner, decision or words.
    const returned = planner.steps.flatMap(step => step.last_results ?? []).filter(result => result.tool !== 'open').map(result => result.items ?? result.results ?? []);
    expect(returned).toEqual([['E1'], ['E1'], [], [], ['E1']]);
    const seen = planner.seen() + JSON.stringify(answer);
    for (const word of [hidden, 'Pilot planning', 'The pilot starts next week', 'Thermostat rollout plan', '"attributes":{"owner":"Ari"', 'meeting:sha256']) expect(seen).not.toContain(word);
    // Nothing released to him names it, in any audit row.
    const releases = followUpReleases(f).slice(before);
    expect(releases.length).toBeGreaterThan(0);
    expect(new Set(releases.map(release => release.principal_id))).toEqual(new Set([f.people.okafor.principal_id]));
    expect(new Set(releases.flatMap(release => release.items.map(item => item.item_id)))).toEqual(new Set([f.ticket.item_id]));
  });
});
