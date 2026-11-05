import { afterEach, describe, expect, it } from 'vitest';
import {
  PERSON_ASK_GAP_DETAILS_HEADER_V1, PERSON_ANSWER_PATH_V7, PERSON_ASK_PROGRESS_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
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
 * The answer layout over HTTP: `POST /v7/person/ask` answers a V8 part that
 * carries its blocks (ADR-0051), arranged by the writer from the block
 * catalog, in JSON and in the progress stream alike. The Authority reads no
 * layout header: a desktop or CLI that still sends `x-echo-answer-layout`,
 * with retired layout v1's `1`, layout v2's `2` or a value it once refused,
 * gets the same answer as an Ask without it.
 */

afterEach(closeAskServers);

const QUESTION = 'Who leads Project A, and what are my open tasks?';
/** The layout header the Authority no longer reads, which older desktops and CLIs still send. */
const LAYOUT_HEADER = 'x-echo-answer-layout';
type StepPrompt = { readonly question?: string; readonly asked_by?: string;
  readonly last_results?: readonly { readonly tool: string; readonly args?: { readonly source?: string; readonly owner?: string }; readonly items?: readonly string[] }[] };

/** Lists the asker's projects and open follow-ups, opens the follow-up, finishes; the writer answers with the project and puts the task under a title. */
function leadAndSection(): StructuredGenerationPort {
  let steps = 0;
  let project: string | undefined;
  let mine: string | undefined;
  return { async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as StepPrompt & { readonly evidence?: readonly { readonly id: string; readonly kind: string }[] };
    const properties = input.schema.properties as Readonly<Record<string, unknown>>;
    if (properties.blocks !== undefined) {
      const of = (kind: string) => prompt.evidence!.find(entry => entry.kind === kind)!.id;
      steps = 0; project = undefined; mine = undefined;
      const lead = { text: 'Ari leads Project A.', evidence: [of('project')] };
      const task = { text: 'Your open follow-up is on the launch ticket.', evidence: [of('follow_up')] };
      return { lists: [], blocks: [{ block: 'answer', sentences: [lead] }, { block: 'text', title: 'Your tasks', sentences: [task] }], not_found: [] };
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
  return serveAsk({ person_answer_v7: createPersonLiveAnswerRouteV1(options) });
}

function ask(base: string, headers: Readonly<Record<string, string>>) {
  return fetch(`${base}${PERSON_ANSWER_PATH_V7}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mina', ...headers },
    body: JSON.stringify({ schema_version: 3, question: QUESTION }),
  });
}

describe('the answer layout on /v7 (ADR-0051)', () => {
  it('sends typed gaps only to opted-in JSON and streaming clients, preserving the old exact part shape', async () => {
    const f = await sentFixture();
    const original = leadAndSection();
    const model: StructuredGenerationPort = { async generate(input) {
      const reply = await original.generate(input);
      return typeof reply === 'object' && reply !== null && 'not_found' in reply ? { ...reply, not_found: ['the reviewer'] } : reply;
    } };
    const base = await origin(f, model);
    for (const progress of [false, true]) {
      const headers: Readonly<Record<string, string>> = progress ? { [PERSON_ASK_PROGRESS_HEADER_V1]: PERSON_ASK_PROGRESS_HEADER_VALUE_V3 } : {};
      const read = async (extra: Record<string, string>) => {
        const response = await ask(base, { ...headers, ...extra });
        expect(response.status).toBe(200);
        if (!progress) return validatePersonAnswerResponseV8(await response.json());
        const terminal = decodeAll(createPersonAskProgressDecoderV3(), await response.text()).at(-1)!;
        if (terminal.type !== 'answer') throw new Error('expected an answer');
        return terminal.response;
      };
      const old = await read({});
      const current = await read({ [PERSON_ASK_GAP_DETAILS_HEADER_V1]: '1' });
      expect(Object.keys(old.parts[0]!).sort()).toEqual(['blocks', 'gap', 'question', 'statements', 'status']);
      const { gap_details, ...plain } = current.parts[0]!;
      expect(gap_details).toEqual({ not_found: 'Not found: the reviewer.' });
      expect(plain).toEqual(old.parts[0]);
      for (const value of ['true', '2', '1, 1']) expect((await ask(base, { ...headers, [PERSON_ASK_GAP_DETAILS_HEADER_V1]: value })).status).toBe(400);
    }
  });

  it('arranges the V8 answer in the writer\'s blocks without a layout header, and answers an Ask that still sends one the same, whatever its value, in JSON and in the progress stream', async () => {
    const f = await sentFixture();
    const base = await origin(f, leadAndSection());
    const answered = validatePersonAnswerResponseV8(await (await ask(base, {})).json());
    const [part] = answered.parts;
    expect(part!.statements.map(statement => statement.text)).toEqual(['Ari leads Project A.', 'Your open follow-up is on the launch ticket.']);
    expect(part!.blocks).toEqual([{ kind: 'answer', statements: [0] }, { kind: 'text', title: 'Your tasks', statements: [1] }]);
    expect(part).not.toHaveProperty('layout');
    // Retired layout v1's 1, layout v2's 2, and the values once refused before the Ask ran are each read as no header at all.
    for (const headers of [{}, ...['1', '2', '3', 'true', '1, 2'].map(value => ({ [LAYOUT_HEADER]: value }))]) {
      const plain = await ask(base, headers);
      expect(plain.status).toBe(200);
      expect(validatePersonAnswerResponseV8(await plain.json())).toEqual(answered);
      const streamed = await ask(base, { ...headers, [PERSON_ASK_PROGRESS_HEADER_V1]: PERSON_ASK_PROGRESS_HEADER_VALUE_V3 });
      expect(streamed.status).toBe(200);
      const terminal = decodeAll(createPersonAskProgressDecoderV3(), await streamed.text()).at(-1)!;
      if (terminal.type !== 'answer') throw new Error('expected the answer event');
      expect(terminal.response).toEqual(answered);
    }
  });
});
