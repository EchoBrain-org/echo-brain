import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V7, createPersonAskProgressDecoderV3, type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
import { askFollowUpItemIdV1, createAgenticAskV5, type AskFollowUpDraftV1, type AskFollowUpSinkV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createAskFollowUpSinksV1 } from '../src/composition/ask-follow-up-sink-v1.js';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { personWorkspaceGrantsV1 } from '../src/composition/person-workspace-evidence-v1.js';
import { askClient, auditBodies as audits, closeAskServers, decodeAll, liveAskOptions, serveAsk } from './fixtures/ask-over-http.js';
import { sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The V8 Ask over HTTP (research tool contract v1): `POST /v7/person/ask`
 * behind the real server, over the real project context and open-items
 * Authority state, streamed as Ask progress V3.
 * "Who leads Project A, and what are my open tasks?" lists the asker's
 * projects and follow-ups in one step, reads the follow-up, and cites both:
 * the project by its workspace citation and the ref that opens it.
 */

afterEach(closeAskServers);

// The V8 Ask runs as it is; the spy only counts the Asks the requests created.
vi.mock('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1')>();
  return { ...actual, createAgenticAskV5: vi.fn(actual.createAgenticAskV5) };
});

const QUESTION = 'Who leads Project A, and what are my open tasks?';
type StepPrompt = { readonly question?: string; readonly asked_by?: string; readonly source_catalog?: readonly { readonly source: string }[];
  readonly last_results?: readonly { readonly tool: string; readonly args?: { readonly source?: string; readonly owner?: string }; readonly items?: readonly string[] }[] };

/** Lists the asker's projects and open follow-ups in one step, opens the follow-up, finishes on both; the writer cites each. */
function leadsAndTasks() {
  const catalogs: string[][] = [];
  let steps = 0;
  let project: string | undefined;
  let mine: string | undefined;
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as StepPrompt & { readonly evidence?: readonly { readonly id: string; readonly kind: string }[] };
    if ((input.schema.properties as Readonly<Record<string, unknown>>).blocks !== undefined) {
      const of = (kind: string) => prompt.evidence!.find(entry => entry.kind === kind)!.id;
      return { blocks: [{ block: 'answer', sentences: [{ text: 'Ari leads Project A.', evidence: [of('project')] }] }, { block: 'text', sentences: [{ text: 'Your open follow-up is on the launch ticket.', evidence: [of('follow_up')] }] }], not_found: [] };
    }
    if (prompt.source_catalog !== undefined) catalogs.push(prompt.source_catalog.map(entry => entry.source));
    project ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.source === 'projects')?.items?.[0];
    mine ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.owner !== undefined)?.items?.[0];
    const step = steps++;
    const actions = step === 0 ? [{ tool: 'list', args: { source: 'projects' } }, { tool: 'list', args: { source: 'follow_ups', owner: prompt.asked_by, status: 'open' } }]
      : step === 1 && mine !== undefined ? [{ tool: 'open', args: { id: mine } }] : [{ tool: 'finish', args: {} }];
    const found = actions[0]!.tool === 'finish' && mine !== undefined && project !== undefined;
    return { parts: [{ question: prompt.question!, notes: 'PLANNER-CANARY', needs: [
      { need: 'Who leads Project A', status: found ? 'found' : 'open', evidence: found ? [project] : [] },
      { need: 'Open follow-ups', status: found ? 'found' : 'open', evidence: found ? [mine] : [] },
    ] }], actions };
  } };
  return { model, catalogs, reset() { steps = 0; project = undefined; mine = undefined; } };
}

/** The asker's tools as the person tools list (V4) carries them: Jira, linked. */
const tools = async (access_token: string): Promise<readonly OrganizationPersonToolV4[]> => [{
  tool_id: 'jira', display_name: 'Jira', availability: 'enabled', personal_status: 'linked',
  external_scope_id: '00000000-0000-4000-8000-0000000000c1', external_subject_id: `acct-${access_token}`, organization_setup: null,
}];

/** The `/v7` route as the runtime composes it, the asker's workspace beside the follow-up sources. */
function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort, extra: Partial<CreatePersonLiveAnswerRouteOptionsV1> = {}) {
  const sessions = f.openItemsOptions.sessions;
  const projects = new SqliteProjectContextRepositoryV1(f.db);
  const options: CreatePersonLiveAnswerRouteOptionsV1 = { ...liveAskOptions(f, model), workspace: {
    projects: createProjectContextApplicationV1({ authenticate: access_token => sessions.authenticateAccess({ access_token }), repository: projects }),
    grants: personWorkspaceGrantsV1(projects), people: f.directory, tools,
  }, ...extra };
  return serveAsk({ person_answer_v7: createPersonLiveAnswerRouteV1(options) });
}
const ask = askClient({ path: PERSON_ANSWER_PATH_V7, question: QUESTION });
const decode = (text: string) => decodeAll(createPersonAskProgressDecoderV3(), text);

describe('the V8 Ask streamed on /v7 (research tool contract v1)', () => {
  it('cites a project by its workspace citation and ref, streams progress V3 that names the projects source, and audits each workspace release', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    const project = { citation: { kind: 'project', project_id: f.projectA }, kind: 'project', label: 'Project A', visibility: 'project', ref: `project:${f.projectA}` };
    const followUp = { citation: { kind: 'follow_up', item_id: f.ticket.item_id }, kind: 'follow_up', label: `ECHO-12 ${f.outsideText}`, visibility: 'only_me', ref: `follow_up:${f.ticket.item_id}` };
    const streamed = await ask(base);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const raw = await streamed.text();
    const events = decode(raw);
    const searched = events.filter(event => event.type === 'searched');
    expect(searched.flatMap(event => event.sources)).toEqual(expect.arrayContaining([{ kind: 'projects' }, { kind: 'follow_ups' }]));
    expect(events.filter(event => event.type === 'read').flatMap(event => event.items)).toContainEqual(followUp);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    // The V8 answer.
    expect(terminal.response.schema_version).toBe(8);
    expect(terminal.response.citations).toEqual([project, followUp]);
    // The V8 catalog holds the asker's workspace beside follow-ups and their connected tool.
    expect(planner.catalogs[0]).toEqual(expect.arrayContaining(['projects', 'people', 'tools', 'follow_ups']));
    // Each workspace release is witnessed without content: its source, operation and each item's kind and id.
    const released = audits(f, 'echo-person-workspace-release-audit-v1');
    expect(released.length).toBeGreaterThanOrEqual(1);
    expect(released[0]).toMatchObject({ source: 'projects', operation: 'list', items: expect.arrayContaining([expect.objectContaining({ kind: 'project', item_id: f.projectA, linked: false })]) });
    expect(JSON.stringify(released)).not.toContain('Project A');
    // The streamed request's Ask record names the project by its citation commitment.
    expect(audits(f, 'echo-person-agentic-ask-audit-v1').at(-1)).toMatchObject({ outcome: 'answered', named_citation_digests: expect.arrayContaining([canonicalSha256(project.citation)]) });
  });

  it('runs the V8 Ask whatever layout header an older client still sends, and refuses none of its values (ADR-0051)', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    const created = vi.mocked(createAgenticAskV5);
    created.mockClear();
    // Retired layout v1's 1, layout v2's 2, and the values the Authority once refused before the Ask ran.
    for (const headers of [...['1', '2', '3', 'true', '1, 2'].map(value => ({ 'x-echo-answer-layout': value })), {}] as readonly Readonly<Record<string, string>>[]) {
      planner.reset();
      const response = await ask(base, { headers });
      expect(response.status).toBe(200);
      await response.text();
    }
    // Each request created its Ask.
    expect(created).toHaveBeenCalledTimes(6);
  });

  it('binds the follow-ups an answer drafts to the asker and the request, saves them once released, and lists their ids (ADR-0053)', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    // The writer of a request that saves follow-ups drafts one beside its answer.
    const model: StructuredGenerationPort = { async generate(input) {
      const value = await planner.model.generate(input) as Record<string, unknown>;
      return (input.schema.properties as Readonly<Record<string, unknown>>).follow_ups === undefined ? value : { ...value, follow_ups: [{ task: 'Call the vendor', owner: 'Ari' }] };
    } };
    const saved: { readonly principal_id: string; readonly drafts: readonly AskFollowUpDraftV1[] }[] = [];
    const bound = vi.fn((authorization: PersonAccessAuthorization): AskFollowUpSinkV1 => ({ save: drafts => { saved.push({ principal_id: authorization.principal_id, drafts }); } }));
    const created = vi.mocked(createAgenticAskV5);
    created.mockClear();
    const base = await origin(f, model, { follow_up_drafts: bound });
    const streamed = await ask(base);
    const terminal = decode(await streamed.text()).at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    const request = created.mock.calls[0]![0].follow_ups!.request_id;
    expect(request).toMatch(/^ask_[0-9a-f-]{36}$/u);
    const id = askFollowUpItemIdV1(request, 0);
    expect(terminal.response.follow_ups).toEqual([id]);
    expect(bound).toHaveBeenCalledTimes(1);
    // Bound to the asker the request authenticated ("mina", the client's default token).
    expect(saved).toEqual([{ principal_id: f.openItemsOptions.sessions.authenticateAccess({ access_token: 'mina' }).principal_id, drafts: [{ item_id: id, task: 'Call the vendor', owner_name: 'Ari' }] }]);
  });

  it('saves a drafted follow-up through the real sink as the asker\'s own unsent open item, seen by nobody else until it is sent (ADR-0053)', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const model: StructuredGenerationPort = { async generate(input) {
      const value = await planner.model.generate(input) as Record<string, unknown>;
      return (input.schema.properties as Readonly<Record<string, unknown>>).follow_ups === undefined ? value
        : { ...value, follow_ups: [{ task: 'Call the vendor', owner: 'Rafael Moreno', due_on: '2026-11-20' }] };
    } };
    // The wiring the API runtime gives the Ask route: the open items' own store and member directory.
    const base = await origin(f, model, { follow_up_drafts: createAskFollowUpSinksV1({ items: f.items, people: f.directory }) });
    const terminal = decode(await (await ask(base)).text()).at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    expect(terminal.response.follow_ups).toHaveLength(1);
    const item_id = terminal.response.follow_ups![0]!;
    const read = (access_token: 'mina' | 'rafael' | 'okafor') => f.openItemsApp.item({ access_token, request: { schema_version: 1, operation: 'item', item_id, read: 'rows' } });

    // The asker ("mina", the client's default token) has it as a draft, with the owner the writer named.
    const { item } = await read('mina');
    expect(item).toMatchObject({
      item_id, run_id: null, kind: 'action', relation: 'needs_updating', expected: 'Call the vendor', due_on: '2026-11-20', state: 'unsent',
      approver: { name: 'Mina Patel' }, owner: { name: 'Rafael Moreno', match: 'name' }, can: { set_state: false, assign: true, edit: true, send: true },
    });
    expect(item).not.toHaveProperty('decision');
    const home = await f.openItemsApp.home({ access_token: 'mina', request: { schema_version: 1, operation: 'home', read: 'rows' } });
    expect(home.drafts.map(draft => draft.item_id)).toEqual([item_id]);

    // Its owner and everyone else see nothing before it is sent.
    await expect(read('rafael')).rejects.toMatchObject({ code: 'not_found' });
    await expect(read('okafor')).rejects.toMatchObject({ code: 'not_found' });

    // Sent, its owner has it and may close it; a stranger still sees nothing.
    expect(await f.openItemsApp.send_item({ access_token: 'mina', request: { schema_version: 1, operation: 'send_item', item_id, command_id: 'send-chat-1', include: true } })).toEqual({ state: 'open' });
    expect((await read('rafael')).item).toMatchObject({ state: 'open', can: { set_state: true, edit: false, send: false } });
    await expect(read('okafor')).rejects.toMatchObject({ code: 'not_found' });
  });
});
