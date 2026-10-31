import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V7, PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  createPersonAskProgressDecoderV3, validatePersonAnswerResponseV8,
  type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
import { createAgenticAskV5 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
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

// The V8 Ask runs as it is; the spy only shows which options each request created it with.
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
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      const of = (kind: string) => prompt.evidence!.find(entry => entry.kind === kind)!.id;
      return { sentences: [{ text: 'Ari leads Project A.', evidence: [of('project')] }, { text: 'Your open follow-up is on the launch ticket.', evidence: [of('follow_up')] }], not_found: [] };
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
function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort) {
  const sessions = f.openItemsOptions.sessions;
  const projects = new SqliteProjectContextRepositoryV1(f.db);
  const options: CreatePersonLiveAnswerRouteOptionsV1 = { ...liveAskOptions(f, model), workspace: {
    projects: createProjectContextApplicationV1({ authenticate: access_token => sessions.authenticateAccess({ access_token }), repository: projects }),
    grants: personWorkspaceGrantsV1(projects), people: f.directory, tools,
  } };
  return serveAsk({ person_answer_v7: createPersonLiveAnswerRouteV1(options) });
}
const ask = askClient({ path: PERSON_ANSWER_PATH_V7, progress: PERSON_ASK_PROGRESS_HEADER_VALUE_V3, question: QUESTION });
const decode = (text: string) => decodeAll(createPersonAskProgressDecoderV3(), text);

describe('the V8 Ask streamed on /v7 (research tool contract v1)', () => {
  it('cites a project by its workspace citation and ref, streams progress V3 that names the projects source, and audits each workspace release', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    const plain = await ask(base, { progress: null });
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const json = validatePersonAnswerResponseV8(await plain.json());
    planner.reset();
    const project = { citation: { kind: 'project', project_id: f.projectA }, kind: 'project', label: 'Project A', visibility: 'project', ref: `project:${f.projectA}` };
    const followUp = { citation: { kind: 'follow_up', item_id: f.ticket.item_id }, kind: 'follow_up', label: `ECHO-12 ${f.outsideText}`, visibility: 'only_me', ref: `follow_up:${f.ticket.item_id}` };
    expect(json.schema_version).toBe(8);
    expect(json.citations).toEqual([project, followUp]);
    // The V8 catalog holds the asker's workspace beside follow-ups and their connected tool.
    expect(planner.catalogs[0]).toEqual(expect.arrayContaining(['projects', 'people', 'tools', 'follow_ups']));

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
    // The V8 answer, byte for byte the JSON route's.
    expect(terminal.response).toEqual(json);
    // Each workspace release is witnessed without content: its source, operation and each item's kind and id.
    const released = audits(f, 'echo-person-workspace-release-audit-v1');
    expect(released.length).toBeGreaterThanOrEqual(2);
    expect(released[0]).toMatchObject({ source: 'projects', operation: 'list', items: expect.arrayContaining([expect.objectContaining({ kind: 'project', item_id: f.projectA, linked: false })]) });
    expect(JSON.stringify(released)).not.toContain('Project A');
    // The streamed request's Ask record names the project by its citation commitment.
    expect(audits(f, 'echo-person-agentic-ask-audit-v1').at(-1)).toMatchObject({ outcome: 'answered', named_citation_digests: expect.arrayContaining([canonicalSha256(project.citation)]) });
  });

  it('asks the V8 Ask for its layout exactly when the client sends the layout header, streamed or not, and refuses any other value before the Ask runs', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    const created = vi.mocked(createAgenticAskV5);
    created.mockClear();
    for (const progress of [null, PERSON_ASK_PROGRESS_HEADER_VALUE_V3]) {
      for (const headers of [{ 'x-echo-answer-layout': '1' }, {}] as readonly Readonly<Record<string, string>>[]) {
        planner.reset();
        const response = await ask(base, { progress, headers });
        expect(response.status).toBe(200);
        await response.text();
      }
    }
    // ADR-0045: the header's value is yes, its absence no, for the JSON answer and the stream alike.
    expect(created.mock.calls.map(([options]) => options.answer_layout)).toEqual([true, undefined, true, undefined]);
    const asked = audits(f, 'echo-person-agentic-ask-audit-v1').length;
    const planned = planner.catalogs.length;
    for (const progress of [null, PERSON_ASK_PROGRESS_HEADER_VALUE_V3]) {
      for (const value of ['2', 'true', '1, 1']) {
        const refused = await ask(base, { progress, headers: { 'x-echo-answer-layout': value } });
        expect([refused.status, refused.headers.get('content-type')]).toEqual([400, 'application/json; charset=utf-8']);
        await expect(refused.json()).resolves.toEqual({ error: { code: 'invalid_request', message: 'request failed' } });
      }
    }
    // Refused before the Ask runs: no Ask created, nothing planned, nothing audited.
    expect(created).toHaveBeenCalledTimes(4);
    expect(planner.catalogs.length).toBe(planned);
    expect(audits(f, 'echo-person-agentic-ask-audit-v1').length).toBe(asked);
  });
});
