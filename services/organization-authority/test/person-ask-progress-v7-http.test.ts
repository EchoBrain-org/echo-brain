import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V6, PERSON_ANSWER_PATH_V7, PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2, PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  createPersonAskProgressDecoderV3, validatePersonAnswerResponseV7, validatePersonAnswerResponseV8,
  type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
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
 * Authority state, streamed as Ask progress V3 exactly as `/v6` streams V2.
 * "Who leads Project A, and what are my open tasks?" lists the asker's
 * projects and follow-ups in one step, reads the follow-up, and cites both:
 * the project by its workspace citation and the ref that opens it.
 */

afterEach(closeAskServers);

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

/** The `/v6` and `/v7` routes as the runtime composes them, the asker's workspace beside the follow-up sources. */
function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort, mount: { readonly v7?: boolean } = {}) {
  const sessions = f.openItemsOptions.sessions;
  const projects = new SqliteProjectContextRepositoryV1(f.db);
  const options: CreatePersonLiveAnswerRouteOptionsV1 = { ...liveAskOptions(f, model), workspace: {
    projects: createProjectContextApplicationV1({ authenticate: access_token => sessions.authenticateAccess({ access_token }), repository: projects }),
    grants: personWorkspaceGrantsV1(projects), people: f.directory, tools,
  } };
  return serveAsk({ person_answer_v6: createPersonLiveAnswerRouteV1(options, 7), ...(mount.v7 === false ? {} : { person_answer_v7: createPersonLiveAnswerRouteV1(options, 8) }) });
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
    expect(plain.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('7');
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
    expect(streamed.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('7');
    const raw = await streamed.text();
    const events = decode(raw);
    const searched = events.filter(event => event.type === 'searched');
    expect(searched.flatMap(event => event.sources)).toEqual(expect.arrayContaining([{ kind: 'projects' }, { kind: 'follow_ups' }]));
    expect(events.filter(event => event.type === 'read').flatMap(event => event.items)).toContainEqual(followUp);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    // The V8 answer, byte for byte the JSON route's.
    expect(terminal.response).toEqual(json);
    // While it ran, nothing of what the planner wrote left the Authority.
    expect(raw.slice(0, raw.lastIndexOf('data: '))).not.toContain('PLANNER-CANARY');
    // Each workspace release is witnessed without content: its source, operation and each item's kind and id.
    const released = audits(f, 'echo-person-workspace-release-audit-v1');
    expect(released.length).toBeGreaterThanOrEqual(2);
    expect(released[0]).toMatchObject({ source: 'projects', operation: 'list', items: expect.arrayContaining([expect.objectContaining({ kind: 'project', item_id: f.projectA, linked: false })]) });
    expect(JSON.stringify(released)).not.toContain('Project A');
    // The streamed request's Ask record names the project by its citation commitment.
    expect(audits(f, 'echo-person-agentic-ask-audit-v1').at(-1)).toMatchObject({ outcome: 'answered', named_citation_digests: expect.arrayContaining([canonicalSha256(project.citation)]) });
  });

  it('streams /v7 only for its own header value, and leaves /v6 without the workspace', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    // A V1 or V2 client's header on /v7 gets the JSON V8 answer, never a V3 stream.
    for (const progress of [PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2, '0', '33']) {
      planner.reset();
      const response = await ask(base, { progress });
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      validatePersonAnswerResponseV8(await response.json());
    }
    // /v6's desk binds no workspace: its catalog never names projects, people or tools, and its answer cites no project.
    planner.reset();
    planner.catalogs.length = 0;
    const v6 = await ask(base, { path: PERSON_ANSWER_PATH_V6, progress: null });
    expect(v6.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('6');
    const answer = validatePersonAnswerResponseV7(await v6.json());
    expect(planner.catalogs[0]).not.toEqual(expect.arrayContaining(['projects']));
    expect(planner.catalogs.flat()).not.toContain('people');
    expect(answer.citations.map(citation => citation.kind)).not.toContain('project');
    // A failure before the stream starts is the ordinary JSON error, with the route header.
    const unauthenticated = await ask(base, { token: 'stranger' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('7');
  });

  it('never binds the workspace in Mine, which reads only what the asker added: no projects, people or tools are offered, read or audited', async () => {
    const f = await sentFixture();
    const planner = leadsAndTasks();
    const base = await origin(f, planner.model);
    const response = await ask(base, { progress: null, mine: true });
    expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV8(await response.json());
    for (const source of ['projects', 'people', 'tools', 'follow_ups']) expect(planner.catalogs.flat()).not.toContain(source);
    expect(answer.citations.map(citation => citation.kind)).not.toContain('project');
    expect(audits(f, 'echo-person-workspace-release-audit-v1')).toEqual([]);
  });

  it('answers /v7 as unavailable, still route-matched, on an Authority composed without the V8 Ask', async () => {
    const f = await sentFixture();
    const base = await origin(f, leadsAndTasks().model, { v7: false });
    const response = await ask(base);
    expect(response.status).toBe(503);
    expect(response.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('7');
    await expect(response.json()).resolves.toEqual({ error: { code: 'unavailable', message: 'request failed' } });
  });
});
