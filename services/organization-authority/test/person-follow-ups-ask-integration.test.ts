import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validatePersonAnswerResponseV8, type PersonAnswerRequestV3 } from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { bindPersonLiveEvidenceDeskV1, createPersonLiveAnswerRouteV1 } from '../src/composition/person-live-answer-route-v1.js';
import { auditBodies, liveAskOptions, myOpenTasksPlanner } from './fixtures/ask-over-http.js';
import { sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

type Prompt = { readonly question?: string; readonly step?: number; readonly source_catalog?: readonly { readonly source: string }[] };
type Step = { readonly actions: readonly unknown[]; readonly found?: boolean };

/** A scripted research model: each step's actions in turn, then a writer that states one sentence from the first evidence item. */
function scripted(steps: readonly Step[]) {
  const prompts: string[] = [];
  const queue = [...steps];
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    prompts.push(input.user_prompt);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      return { sentences: [{ text: 'The launch follow-up on the pilot decision is still open.', evidence: ['E1'] }], not_found: [] };
    }
    const step = queue.shift() ?? { actions: [{ tool: 'finish', args: {} }], found: true };
    return { parts: [{ question: prompt.question!, notes: '', needs: [{ need: 'Open follow-ups', status: step.found === true ? 'found' : 'open', evidence: step.found === true ? ['E1'] : [] }] }], actions: step.actions };
  } };
  return { model, prompts, catalog: () => (JSON.parse(prompts[0]!) as Prompt).source_catalog!.map(entry => entry.source) };
}

/** The Ask route as the runtime composes it over the open-items fixture's Authority, with the asker's own directory entry. */
function routeOf(f: OpenItemsFixtureV1, model: StructuredGenerationPort) {
  const options = liveAskOptions(f, model);
  return { route: createPersonLiveAnswerRouteV1(options), options };
}
const ask = (route: ReturnType<typeof routeOf>['route'], access_token: FixturePerson, request: Partial<PersonAnswerRequestV3> = {}) =>
  route.ask({ access_token, request: { schema_version: 3, question: 'What are my open tasks?', ...request } });
function leaveProject(f: OpenItemsFixtureV1, name: FixturePerson) {
  f.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'")
    .run(f.clock().toISOString(), f.projectA, f.membership(name));
}

describe('Ask with follow-ups as evidence (ADR-0040)', () => {
  it('answers from a follow-up, cites it with the ref that opens its item page, and audits every release', async () => {
    const f = await sentFixture();
    const { model, prompts, catalog } = scripted([
      { actions: [{ tool: 'search', args: { source: 'follow_ups', query: 'launch' } }] },
      { actions: [{ tool: 'list', args: { source: 'follow_ups' } }] },
    ]);
    const answer = await ask(routeOf(f, model).route, 'mina');
    expect(catalog()).toContain('follow_ups');
    expect(validatePersonAnswerResponseV8(answer)).toEqual(answer);
    expect(answer).toMatchObject({ schema_version: 8, kind: 'echo-clean-person-answer-v8', outcome: 'answered' });
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
    const releases = auditBodies(f, 'echo-person-follow-up-release-audit-v1');
    expect(releases.map(body => body.operation)).toEqual(expect.arrayContaining(['list', 'search']));
    const terminal = auditBodies(f, 'echo-person-agentic-ask-audit-v1')[0]!;
    expect(terminal).toMatchObject({ outcome: 'answered', request_id: releases[0]!.request_id });
    expect(JSON.stringify(releases)).not.toMatch(/Pilot planning|launch next week|Mina Patel|Kestrel|ECHO-12/);
  });

  it('binds follow-ups for an Ask, global or in a project, and never for trigger research or open items', async () => {
    const f = await sentFixture();
    const finish = [{ actions: [{ tool: 'finish', args: {} }] }];
    for (const [request, expected] of [[{}, true], [{ project_id: f.projectA }, true]] as const) {
      const { model, catalog } = scripted(finish);
      await ask(routeOf(f, model).route, 'mina', request as Partial<PersonAnswerRequestV3>).catch(() => undefined);
      expect([request, catalog().includes('follow_ups')]).toEqual([request, expected]);
    }
    // The desks trigger research and open items bind serve no Ask, so they never bind follow-ups.
    const { options } = routeOf(f, scripted([]).model);
    const context = { authority_id: 'authority', organization_id: f.person.organization_id, state_lineage_id: 'lineage', principal_id: f.people.mina.principal_id,
      membership_id: f.people.mina.membership_id, session_family_id: 'psf_mina', request_id: `trigger_run_${randomUUID()}` };
    const background = await bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'mina', scope: { kind: 'global' } }, context);
    expect(background.live_sources).toEqual([]);
    const asked = await bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'mina', scope: { kind: 'global' }, ask: true }, context);
    expect(asked.live_sources).toEqual([expect.objectContaining({ source_id: 'follow_ups' })]);
    // A desk bound for one person never reads follow-ups as another.
    await expect(bindPersonLiveEvidenceDeskV1(options, [], { access_token: 'rafael', scope: { kind: 'global' }, ask: true }, context)).rejects.toMatchObject({ code: 'stale_access_state' });
  });
});

/** The Ask route as the runtime builds it, with the asker's own directory entry, so the loop reads "my" as their name. */
function myTasksRoute(f: OpenItemsFixtureV1, model: StructuredGenerationPort) {
  return createPersonLiveAnswerRouteV1(liveAskOptions(f, model));
}
const followUpReleases = (f: OpenItemsFixtureV1) => auditBodies(f, 'echo-person-follow-up-release-audit-v1') as
  { readonly operation: string; readonly principal_id: string; readonly items: readonly { readonly item_id: string }[] }[];

describe('"What are my open tasks?" through the real Authority composition (ADR-0040)', () => {
  it("lists the asker's open follow-ups by owner at the desk, opens one, and cites it with the follow-up kind and ref", async () => {
    const f = await sentFixture();
    // Mina owns the ticket's follow-up; Ari, the approver ECHO fell back to, owns the action's. Mina sees both.
    expect([f.ticket.state, f.action.state]).toEqual(['open', 'open']);
    const planner = myOpenTasksPlanner();
    const answer = await myTasksRoute(f, planner.model).ask({ access_token: 'mina', request: { schema_version: 3, question: 'What are my open tasks?' } });

    expect(validatePersonAnswerResponseV8(answer)).toEqual(answer);
    expect(answer).toMatchObject({ schema_version: 8, kind: 'echo-clean-person-answer-v8', outcome: 'answered' });
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
    expect(auditBodies(f, 'echo-person-agentic-ask-audit-v1')[0]).toMatchObject({ outcome: 'answered' });
  });

  it('refuses the answer when the asker stops reading the decision their own follow-up carried', async () => {
    const f = await sentFixture();
    // Mina leaves project A while the answer is written: the ticket is still hers, but the decision released with it is not.
    const planner = myOpenTasksPlanner([], { on_answer: () => leaveProject(f, 'mina') });
    await expect(myTasksRoute(f, planner.model).ask({ access_token: 'mina', request: { schema_version: 3, question: 'What are my open tasks?' } }))
      .rejects.toMatchObject({ code: 'stale_access_state' });
    // Only her own follow-up was released, each time with its decision.
    expect(new Set(followUpReleases(f).flatMap(release => release.items.map(item => item.item_id)))).toEqual(new Set([f.ticket.item_id]));
    expect((JSON.parse(planner.writer[0]!) as { evidence: { text: string }[] }).evidence[0]!.text).toContain('Decision: Pilot planning');
    expect(auditBodies(f, 'echo-person-agentic-ask-audit-v1').filter(body => body.outcome === 'answered')).toEqual([]);
  });

  it('never shows the asker a follow-up they cannot see: not by owner, by an unfiltered list, or by its words', async () => {
    // S. Okafor owns the ticket's follow-up but is not in project A. Ari's follow-up on the action is in project A only.
    const f = await sentFixture({ ticketOwner: 'okafor' });
    const hidden = f.action.item_id;
    // The control: Ari, who owns it, finds it by the same question.
    const control = myOpenTasksPlanner();
    const ari = await myTasksRoute(f, control.model).ask({ access_token: 'ari', request: { schema_version: 3, question: 'What are my open tasks?' } });
    expect(ari.citations).toEqual([expect.objectContaining({ kind: 'follow_up', citation: { kind: 'follow_up', item_id: hidden }, ref: `follow_up:${hidden}` })]);

    const before = followUpReleases(f).length;
    // One step of probes: a step that finds nothing new is idle, and two idle steps end research.
    const planner = myOpenTasksPlanner([[
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
