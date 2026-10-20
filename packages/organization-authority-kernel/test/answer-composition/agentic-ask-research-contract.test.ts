import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV8, validatePersonFollowUpEvidenceV1, type PersonAskProgressStepEventV3 } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV4, createAgenticAskV5 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '../../src/shared/core-runtime-observation-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from '../../src/shared/follow-up-evidence-v1.js';
import { PEOPLE_SOURCE_DESCRIPTOR_V1, PROJECTS_SOURCE_DESCRIPTOR_V1 } from '../../src/shared/workspace-evidence-v1.js';
import { agenticListMembersNounV1, agenticListNounV1 } from '../../src/answer-composition/agentic-list-evidence-v1.js';
import { generation, listed, result } from './fixtures/agentic-scenarios.js';

/**
 * The research tool contract v1 in Ask's research loop: each read checked against its source's capabilities, a refused
 * read never sent again, a window with no date field read on any date, a short look with limit, items linked by id, the
 * items a date filter could not test, and several sources looked at in one step.
 */

const checked = { checked_at: '2026-10-19T00:00:00.000Z' };
const question = 'What happened yesterday?';
/** An approved decision, as a list releases it: metadata only, with the dates the contract gives it. */
const decision = (id: string, dates: EvidenceDeskItemV2['dates']): EvidenceDeskItemV2 => Object.freeze({ ...listed(id), dates, attributes: { participants: 'Mara Lind, Jules Park', approved_by: 'Mara Lind' } });
function followUp(n: number, links?: EvidenceDeskItemV2['links']): EvidenceDeskItemV2 {
  const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a1${n}`, kind: 'ticket', title: `THERM-4${n} follow-up`, owner: 'Mara Lind', status: 'open' }));
  return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: 'team', receipt_sha256: canonicalSha256(`follow-up-${n}`), dates: { created: '2026-10-14T09:00:00.000Z' }, ...(links === undefined ? {} : { links }) });
}
const step = (actions: readonly unknown[], status: 'open' | 'found' | 'not_found' = 'open', evidence: readonly string[] = []) =>
  ({ parts: [{ question, notes: '', needs: [{ need: 'what happened', kind: 'which_items', status, evidence }] }], actions });
const finish = (evidence: readonly string[] = ['L1']) => step([{ tool: 'finish', args: {} }], 'found', evidence);
function scripted(replies: unknown[]) {
  const inputs: StructuredGenerationInput[] = [];
  return {
    steps: () => inputs.filter(input => input.system_prompt.startsWith("You are Echo's research agent")),
    model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift() ?? { lists: [], sentences: [], not_found: [] }; } },
  };
}
type Prompt = Record<string, unknown> & { last_results: Record<string, unknown>[]; seen: Record<string, unknown>[]; lists: Record<string, unknown>[] };
const userOf = (input: StructuredGenerationInput) => JSON.parse(input.user_prompt) as Prompt;
function desk(overrides: Partial<EvidenceDeskPortV2> = {}) {
  return {
    scope: { kind: 'global' as const }, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
    search: vi.fn(async (_input: Parameters<EvidenceDeskPortV2['search']>[0]) => result([])),
    list: vi.fn(async (_input: Parameters<EvidenceDeskPortV2['list']>[0]) => result([])),
    open: vi.fn(async () => result([])),
    revalidate: vi.fn(async () => checked),
    ...overrides,
  } satisfies EvidenceDeskPortV2;
}
const ask = (port: EvidenceDeskPortV2, model: ReturnType<typeof scripted>['model']) =>
  createAgenticAskV4({ desk: port, model, audit: { append: () => undefined }, generation, asker: { display_name: 'Mara Lind' }, today: () => '2026-10-19' });

describe('Ask research tool contract v1', () => {
  it('refuses a read its source cannot take before the desk, and answers it again from memory, unsent', async () => {
    const refused = { tool: 'list', args: { source: 'meetings', date_field: 'sent', since: '2026-10-18', until: '2026-10-18' } };
    const document = Object.freeze({ ...listed('note'), kind: 'document_passage' as const, text: 'A note.' }) as EvidenceDeskItemV2;
    const list = vi.fn(async (input: Parameters<EvidenceDeskPortV2['list']>[0]) => input.source === 'document' ? result([document]) : result([]));
    const port = desk({ list });
    // The second step sends the refused read again beside one that makes progress, so research goes on to a third step.
    const run = scripted([step([refused]), step([refused, { tool: 'list', args: { source: 'documents' } }]), step([{ tool: 'finish', args: {} }], 'not_found')]);
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1('ask_request', () => ask(port, run.model).answer({ question }), { observer: event => { events.push(event); } }).catch(() => undefined);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ source: 'document' }));
    const [first, again] = [userOf(run.steps()[1]!).last_results[0]!, userOf(run.steps()[2]!).last_results[0]!];
    expect(first).toEqual({ tool: 'list', args: refused.args, filters: { date_field: 'refused' }, supports: { filters: { kind: ['decision', 'action', 'rationale'], status: ['open', 'done'], owner: 'name' }, dates: ['occurred', 'approved', 'received', 'due'], any_date: true }, note: 'refused: meetings: date_field must be occurred, approved, received, due' });
    expect(again.note).toBe(`${String(first.note)}; refused again: this exact request was already refused in this Ask, so it was not sent; change the source, the filter or the approach`);
    expect(first).not.toHaveProperty('error');
    const counts = events.find(event => event.root && event.counts?.refused_read_count !== undefined)?.counts;
    expect(counts).toMatchObject({ refused_read_count: 1, repeated_refusal_count: 1, sources_looked_at: 1, most_reads_in_a_step: 2 });
  });

  it('reads a window with no date field on any of an item\'s dates where its source declares that, and shows which matched', async () => {
    const approvedYesterday = decision('canary', { approved: '2026-10-18T21:05:00.000Z' });
    const port = desk({ list: vi.fn(async () => result([approvedYesterday])) });
    const run = scripted([step([{ tool: 'list', args: { source: 'meetings', since: '2026-10-18', until: '2026-10-18' } }]), finish()]);
    await ask(port, run.model).answer({ question }).catch(() => undefined);
    expect(port.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'meeting', since: '2026-10-18', until: '2026-10-18', date_field: 'any' }));
    const seen = userOf(run.steps()[1]!).seen;
    expect(seen[0]).toMatchObject({ id: 'E1', attributes: { participants: 'Mara Lind, Jules Park', approved_by: 'Mara Lind' }, matched: ['approved'] });
  });

  it('pages out a short look with limit, and the same arguments continue the same list', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(id => listed(id) as EvidenceDeskItemV2);
    const port = desk({ list: vi.fn(async () => result(rows)) });
    const look = { tool: 'list', args: { source: 'meetings', kind: 'decision', limit: 2 } };
    const run = scripted([step([look]), step([look]), finish()]);
    await ask(port, run.model).answer({ question }).catch(() => undefined);
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(userOf(run.steps()[1]!).last_results[0]).toMatchObject({ list: 'L1', items: ['E1', 'E2'], more: true });
    expect(userOf(run.steps()[2]!).last_results[0]).toMatchObject({ list: 'L1', items: ['E3', 'E4'], more: true });
  });

  it('shows an item\'s links by id, and keeps linked items out of the list that released them', async () => {
    const linkedDecision = Object.freeze({ ...decision('fan-curve', { occurred: '2026-10-13T16:00:00.000Z', approved: '2026-10-14T08:00:00.000Z' }) });
    const followUps = [followUp(1, { decision: [linkedDecision.id] }), followUp(2)];
    const port = desk({ list: vi.fn(async (input: Parameters<EvidenceDeskPortV2['list']>[0]) => input.source === 'follow_ups' ? result(followUps, { linked: [linkedDecision] }) : result([])) });
    const run = scripted([step([{ tool: 'list', args: { source: 'follow_ups', status: 'open' } }]), finish()]);
    await ask(port, run.model).answer({ question: 'What are the open items, and which meeting is each from?' }).catch(() => undefined);
    const prompt = userOf(run.steps()[1]!);
    expect(prompt.last_results[0]).toMatchObject({ list: 'L1', items: ['E1', 'E2'], linked: ['E3'] });
    expect(prompt.lists[0]).toMatchObject({ id: 'L1', members: ['E1', 'E2'] });
    expect(prompt.seen.find(value => value.id === 'E1')).toMatchObject({ links: { decision: ['E3'] }, dates: { created: expect.any(String) } });
    expect(prompt.seen.find(value => value.id === 'E3')).toMatchObject({ kind: 'decision', attributes: { participants: 'Mara Lind, Jules Park' } });
  });

  it('tells research and the person how many items a date filter could not test, only through a list the answer uses', async () => {
    const port = desk({ list: vi.fn(async () => result([], { unchecked: { count: 3, dates: ['approved'] } })) });
    const run = scripted([
      step([{ tool: 'list', args: { source: 'meetings', kind: 'decision', date_field: 'occurred', since: '2026-10-18', until: '2026-10-18' } }]),
      finish(),
      { lists: [{ id: 'L1' }], sentences: [], not_found: [] },
    ]);
    const answer = await ask(port, run.model).answer({ question: 'Which decisions were made at meetings yesterday?' });
    const prompt = userOf(run.steps()[1]!);
    expect(prompt.last_results[0]).toMatchObject({ list: 'L1', unchecked: { count: 3, dates: ['approved'] } });
    expect(prompt.lists[0]).toMatchObject({ id: 'L1', unchecked: { count: 3, dates: ['approved'] } });
    // An empty list with items it could not check is never "nothing found": the part is partial and says how many.
    expect(answer.outcome).toBe('partial');
    expect(answer.parts[0]!.gap).toBe('None of the items that record the date asked for matched. 3 decisions have no recorded time, so they were not checked against these dates. They have an approval date.');
  });

  it('lets one Ask step look at up to ten sources and queries at once', async () => {
    const port = desk();
    const queries = Array.from({ length: 10 }, (_, index) => ({ tool: 'search', args: { query: `topic ${index + 1}` } }));
    const run = scripted([step(queries), step([{ tool: 'finish', args: {} }], 'not_found')]);
    await ask(port, run.model).answer({ question }).catch(() => undefined);
    expect(port.search).toHaveBeenCalledTimes(10);
    const schema = run.steps()[0]!.schema as { properties: { actions: { maxItems: number } } };
    expect(schema.properties.actions.maxItems).toBe(10);
  });

  it('answers V8 with a cited project and its leads, and streams progress V3 that names the projects source', async () => {
    const project: EvidenceDeskItemV2 = Object.freeze({
      id: 'project-therm', kind: 'project', citation: { kind: 'project' as const, project_id: 'prj_00000000-0000-4000-8000-000000000001' as const }, label: 'THERM', visibility: 'project',
      attributes: { status: 'active', role: 'member', leads: 'Mara Lind' }, text: 'THERM. Leads: Mara Lind. Members: Jules Park (member).', receipt_sha256: canonicalSha256('project-therm'),
    });
    const port = desk({ live_sources: [PROJECTS_SOURCE_DESCRIPTOR_V1], list: vi.fn(async () => result([project])) });
    const run = scripted([step([{ tool: 'list', args: { source: 'projects', status: 'active' } }]), finish(), { lists: [{ id: 'L1' }], sentences: [], not_found: [] }]);
    const events: PersonAskProgressStepEventV3[] = [];
    const { response, receipt } = await createAgenticAskV5({ desk: port, model: run.model, audit: { append: () => undefined }, generation, today: () => '2026-10-19' })
      .answerWithReceipt({ question: 'What are the current projects, and who leads them?', on_progress: event => { events.push(event); } });
    expect(port.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'projects', status: 'active' }));
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response.citations).toEqual([{ citation: project.citation, kind: 'project', label: 'THERM', visibility: 'project', ref: 'project:prj_00000000-0000-4000-8000-000000000001' }]);
    expect(events).toContainEqual({ type: 'searched', sources: [{ kind: 'projects' }], found: 1 });
    expect(receipt.rows).toContainEqual({ type: 'searched', sources: [{ kind: 'projects' }], found: 1 });
  });
});

describe('Ask research tool contract v1: review fixes', () => {
  const project = (n: number, role: 'lead' | 'member', links?: EvidenceDeskItemV2['links']): EvidenceDeskItemV2 => Object.freeze({
    id: `project-${n}`, kind: 'project', citation: { kind: 'project' as const, project_id: `prj_00000000-0000-4000-8000-00000000000${n}` as const }, label: `Project ${n}`, visibility: 'project',
    attributes: { status: 'active', role }, text: `Project ${n}.`, receipt_sha256: canonicalSha256(`project-${n}`), ...(links === undefined ? {} : { links }),
  });
  const person = (n: number, links?: EvidenceDeskItemV2['links']): EvidenceDeskItemV2 => Object.freeze({
    id: `person-${n}`, kind: 'person', citation: { kind: 'person' as const, membership_id: `mem_00000000-0000-4000-8000-00000000000${n}` }, label: `Person ${n}`, visibility: 'team',
    text: `Person ${n}.`, receipt_sha256: canonicalSha256(`person-${n}`), ...(links === undefined ? {} : { links }),
  });
  const askV8 = (port: EvidenceDeskPortV2, model: ReturnType<typeof scripted>['model']) =>
    createAgenticAskV5({ desk: port, model, audit: { append: () => undefined }, generation, asker: { display_name: 'Mara Lind' }, today: () => '2026-10-19' });

  it('never shows research the internal any-date selection in a list\'s args, and reads an "any" it sends as no date_field', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => decision(`d${index}`, { approved: '2026-10-18T09:00:00.000Z' }));
    const port = desk({ list: vi.fn(async () => result(rows)) });
    const look = { tool: 'list', args: { source: 'meetings', since: '2026-10-18', until: '2026-10-18', limit: 5 } };
    const again = { tool: 'list', args: { ...look.args, date_field: 'any' } };
    const run = scripted([step([look]), step([again]), finish()]);
    await ask(port, run.model).answer({ question }).catch(() => undefined);
    const second = userOf(run.steps()[1]!);
    expect(second.lists[0]).toMatchObject({ id: 'L1', args: { source: 'meetings', since: '2026-10-18', until: '2026-10-18' } });
    expect(second.lists[0]!.args).not.toHaveProperty('date_field');
    // The same list, continued: "any" is no new selection and never refused.
    const third = userOf(run.steps()[2]!);
    expect(third.last_results[0]).toMatchObject({ list: 'L1', items: ['E6', 'E7', 'E8', 'E9', 'E10'] });
    expect(third.last_results[0]).not.toHaveProperty('supports');
    expect(port.list).toHaveBeenCalledTimes(1);
  });

  it('searches every source on any date across sources, and replaces which dates matched with each dated read', async () => {
    const both = decision('both', { occurred: '2026-10-10T09:00:00.000Z', approved: '2026-10-18T09:00:00.000Z' });
    const search = vi.fn(async (_input: Parameters<EvidenceDeskPortV2['search']>[0]) => result([both]));
    const port = desk({ search });
    const run = scripted([
      step([{ tool: 'search', args: { query: 'launch', since: '2026-10-18', until: '2026-10-18' } }]),
      step([{ tool: 'search', args: { query: 'launch plan', since: '2026-10-10', until: '2026-10-10' } }]),
      finish(),
    ]);
    await ask(port, run.model).answer({ question }).catch(() => undefined);
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({ since: '2026-10-18', until: '2026-10-18', date_field: 'any' }));
    expect(search.mock.calls[0]![0]).not.toHaveProperty('source');
    expect(userOf(run.steps()[1]!).seen[0]).toMatchObject({ id: 'E1', matched: ['approved'] });
    expect(userOf(run.steps()[2]!).seen[0]).toMatchObject({ id: 'E1', matched: ['occurred'] });
  });

  it('sends the same read twice in one step only once: its copy is answered from the refusal it got', async () => {
    const refused = { tool: 'list', args: { source: 'meetings', date_field: 'sent', since: '2026-10-18' } };
    const port = desk();
    const run = scripted([step([refused, refused]), step([{ tool: 'finish', args: {} }], 'not_found')]);
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1('ask_request', () => ask(port, run.model).answer({ question }), { observer: event => { events.push(event); } }).catch(() => undefined);
    const results = userOf(run.steps()[1]!).last_results;
    expect(results[1]!.note).toMatch(/refused again/u);
    expect(events.find(event => event.root && event.counts?.refused_read_count !== undefined)?.counts).toMatchObject({ refused_read_count: 1, repeated_refusal_count: 1 });
  });

  it('shows a short page\'s linked items only, and keeps the rest for the page whose members link to them', async () => {
    const decisions = [1, 2, 3].map(n => decision(`dec-${n}`, { approved: '2026-10-14T08:00:00.000Z' }));
    const rows = [1, 2, 3].map(n => followUp(n, { decision: [decisions[n - 1]!.id] }));
    const port = desk({ list: vi.fn(async () => result(rows, { linked: decisions })) });
    const look = { tool: 'list', args: { source: 'follow_ups', status: 'open', limit: 1 } };
    const run = scripted([step([look]), step([look]), finish()]);
    await ask(port, run.model).answer({ question: 'What are the open items?' }).catch(() => undefined);
    expect(userOf(run.steps()[1]!).last_results[0]).toMatchObject({ items: ['E1'], linked: ['E2'] });
    expect(userOf(run.steps()[2]!).last_results[0]).toMatchObject({ items: ['E3'], linked: ['E4'] });
    expect(port.list).toHaveBeenCalledTimes(1);
  });

  it('keeps the links a later copy carries for an item first released beside another\'s row', async () => {
    const lists = vi.fn(async (input: Parameters<EvidenceDeskPortV2['list']>[0]) => input.source === 'projects'
      ? result([project(1, 'lead', { members: ['person-1'] })], { linked: [person(1)] })
      : result([person(1, { projects: ['project-1'] })], { linked: [project(1, 'lead')] }));
    const port = desk({ live_sources: [PROJECTS_SOURCE_DESCRIPTOR_V1, PEOPLE_SOURCE_DESCRIPTOR_V1], list: lists });
    const run = scripted([step([{ tool: 'list', args: { source: 'projects' } }]), step([{ tool: 'list', args: { source: 'people' } }]), finish()]);
    await askV8(port, run.model).answer({ question: 'Who is on my projects?' }).catch(() => undefined);
    const seen = userOf(run.steps()[2]!).seen;
    expect(seen.find(value => value.id === 'E1')).toMatchObject({ links: { members: ['E2'] } });
    expect(seen.find(value => value.id === 'E2')).toMatchObject({ links: { projects: ['E1'] } });
  });

  it('says a role filter in the list statement, and names the workspace and a tool\'s containers by what they are', async () => {
    const port = desk({ live_sources: [PROJECTS_SOURCE_DESCRIPTOR_V1], list: vi.fn(async () => result([project(1, 'lead'), project(2, 'lead')])) });
    const run = scripted([step([{ tool: 'list', args: { source: 'projects', role: 'lead' } }]), finish(), { lists: [{ id: 'L1' }], sentences: [], not_found: [] }]);
    const answer = await askV8(port, run.model).answer({ question: 'Which projects do I lead?' });
    expect(answer.parts[0]!.statements[0]!.text).toMatch(/^2 projects with your role lead: Project 1; Project 2\.?$/u);
    expect(agenticListNounV1({ selector: 'jira_projects', tool_id: 'jira' })).toBe('Jira projects');
    expect(agenticListNounV1({ selector: 'confluence_spaces', tool_id: 'confluence' })).toBe('Confluence spaces');
    expect(agenticListMembersNounV1({ selector: 'people' }, ['person'])).toMatchObject({ plural: 'people', singular: 'person' });
    expect(agenticListMembersNounV1({ selector: 'jira_projects', tool_id: 'jira' }, ['tool_container'])).toMatchObject({ plural: 'Jira projects', singular: 'Jira project' });
  });

  it('says an unchecked count taken before ECHO\'s own owner filter covers every owner', async () => {
    const due = Object.freeze({ ...decision('a1', { due: '2026-10-21T00:00:00.000Z' }), kind: 'action' as const, attributes: { owner: 'Dana Lee', due_at: '2026-10-21' } }) as EvidenceDeskItemV2;
    const port = desk({ list: vi.fn(async () => result([due], { unchecked: { count: 7, dates: ['approved'] } })) });
    const run = scripted([
      step([{ tool: 'list', args: { source: 'meetings', kind: 'action', owner: 'Dana Lee', date_field: 'due', since: '2026-10-19', until: '2026-10-25' } }]),
      finish(),
      { lists: [{ id: 'L1' }], sentences: [], not_found: [] },
    ]);
    const answer = await ask(port, run.model).answer({ question: 'What is Dana due to do this week?' });
    expect(port.list).toHaveBeenCalledWith(expect.not.objectContaining({ owner: expect.anything() }));
    expect(userOf(run.steps()[1]!).lists[0]).toMatchObject({ unchecked: { count: 7, any_of: ['owner'] } });
    expect(answer.parts[0]!.gap).toContain('7 actions have no due date, so they were not checked against these dates. They have an approval date. This count is of actions with any owner.');
  });
});
