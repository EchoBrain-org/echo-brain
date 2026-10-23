import { afterEach, describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V7, PERSON_ASK_ANSWER_LAYOUT_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  createPersonAskProgressDecoderV3, validatePersonAnswerResponseV8,
  type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { personWorkspaceGrantsV1 } from '../src/composition/person-workspace-evidence-v1.js';
import { closeAskServers, decodeAll, liveAskOptions, serveAsk } from './fixtures/ask-over-http.js';
import { sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * Answer layout v1 over HTTP (ADR-0045): `POST /v7/person/ask` with
 * `x-echo-answer-layout: 1` answers a V8 part that carries its layout, built
 * from the writer's forms; without the header the same Ask has none, and a
 * header with another value is refused before the Ask runs.
 */

afterEach(closeAskServers);

const QUESTION = 'Who leads Project A, and what are my open tasks?';
type StepPrompt = { readonly question?: string; readonly asked_by?: string;
  readonly last_results?: readonly { readonly tool: string; readonly args?: { readonly source?: string; readonly owner?: string }; readonly items?: readonly string[] }[] };

/** Lists the asker's projects and open follow-ups, opens the follow-up, finishes; the writer leads with the project and puts the task in a section. */
function leadAndSection(): StructuredGenerationPort {
  let steps = 0;
  let project: string | undefined;
  let mine: string | undefined;
  return { async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as StepPrompt & { readonly evidence?: readonly { readonly id: string; readonly kind: string }[] };
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      const of = (kind: string) => prompt.evidence!.find(entry => entry.kind === kind)!.id;
      steps = 0; project = undefined; mine = undefined;
      return { lists: [], sentences: [
        { text: 'Ari leads Project A.', evidence: [of('project')], form: 'lead' },
        { text: 'Your open follow-up is on the launch ticket.', evidence: [of('follow_up')], section: 'Your tasks' },
      ], not_found: [] };
    }
    project ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.source === 'projects')?.items?.[0];
    mine ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.owner !== undefined)?.items?.[0];
    const step = steps++;
    const actions = step === 0 ? [{ tool: 'list', args: { source: 'projects' } }, { tool: 'list', args: { source: 'follow_ups', owner: prompt.asked_by, status: 'open' } }]
      : step === 1 && mine !== undefined ? [{ tool: 'open', args: { id: mine } }] : [{ tool: 'finish', args: {} }];
    const found = actions[0]!.tool === 'finish' && mine !== undefined && project !== undefined;
    return { parts: [{ question: prompt.question!, notes: '', needs: [
      { need: 'Who leads Project A', status: found ? 'found' : 'open', evidence: found ? [project] : [] },
      { need: 'Open follow-ups', status: found ? 'found' : 'open', evidence: found ? [mine] : [] },
    ] }], actions };
  } };
}

const tools = async (access_token: string): Promise<readonly OrganizationPersonToolV4[]> => [{
  tool_id: 'jira', display_name: 'Jira', availability: 'enabled', personal_status: 'linked',
  external_scope_id: '00000000-0000-4000-8000-0000000000c1', external_subject_id: `acct-${access_token}`, organization_setup: null,
}];

function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort) {
  const sessions = f.openItemsOptions.sessions;
  const projects = new SqliteProjectContextRepositoryV1(f.db);
  const options: CreatePersonLiveAnswerRouteOptionsV1 = { ...liveAskOptions(f, model), workspace: {
    projects: createProjectContextApplicationV1({ authenticate: access_token => sessions.authenticateAccess({ access_token }), repository: projects }),
    grants: personWorkspaceGrantsV1(projects), people: f.directory, tools,
  } };
  return serveAsk({ person_answer_v7: createPersonLiveAnswerRouteV1(options, 8) });
}

function ask(base: string, headers: Readonly<Record<string, string>>) {
  return fetch(`${base}${PERSON_ANSWER_PATH_V7}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mina', ...headers },
    body: JSON.stringify({ schema_version: 3, question: QUESTION }),
  });
}

describe('answer layout v1 on /v7 (ADR-0045)', () => {
  it('lays out the V8 answer only when asked, the same in JSON and in the progress stream', async () => {
    const f = await sentFixture();
    const base = await origin(f, leadAndSection());
    const laid = validatePersonAnswerResponseV8(await (await ask(base, { [PERSON_ASK_ANSWER_LAYOUT_HEADER_V1]: '1' })).json());
    const [part] = laid.parts;
    expect(part!.statements.map(statement => statement.text)).toEqual(['Ari leads Project A.', 'Your open follow-up is on the launch ticket.']);
    expect(part!.layout).toEqual([{ kind: 'lead', statements: [0] }, { kind: 'heading', text: 'Your tasks' }, { kind: 'paragraph', statements: [1] }]);

    const plain = validatePersonAnswerResponseV8(await (await ask(base, {})).json());
    expect(plain.parts[0]).not.toHaveProperty('layout');
    expect(plain.parts[0]!.statements).toEqual(part!.statements);

    const streamed = await ask(base, { [PERSON_ASK_ANSWER_LAYOUT_HEADER_V1]: '1', [PERSON_ASK_PROGRESS_HEADER_V1]: PERSON_ASK_PROGRESS_HEADER_VALUE_V3 });
    const terminal = decodeAll(createPersonAskProgressDecoderV3(), await streamed.text()).at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    expect(terminal.response).toEqual(laid);
  });

  it('refuses a layout header with another value before the Ask runs', async () => {
    const f = await sentFixture();
    let calls = 0;
    const model: StructuredGenerationPort = { async generate() { calls += 1; throw new Error('no model call expected'); } };
    const base = await origin(f, model);
    const response = await ask(base, { [PERSON_ASK_ANSWER_LAYOUT_HEADER_V1]: 'yes' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(calls).toBe(0);
  });
});
