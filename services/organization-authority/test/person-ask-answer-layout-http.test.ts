import { afterEach, describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V7, type OrganizationPersonToolV4,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { personWorkspaceGrantsV1 } from '../src/composition/person-workspace-evidence-v1.js';
import { closeAskServers, liveAskOptions, serveAsk, streamedAnswer } from './fixtures/ask-over-http.js';
import { sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The answer layout over HTTP: `POST /v7/person/ask` answers a V8 part that
 * carries its blocks (ADR-0051), arranged by the writer from the block
 * catalog, in the progress stream. The Authority reads no
 * layout header: a desktop or CLI that still sends `x-echo-answer-layout`,
 * with retired layout v1's `1`, layout v2's `2` or a value it once refused,
 * gets the same answer as an Ask without it.
 */

afterEach(closeAskServers);

const QUESTION = 'Who leads Project A, and what are my open tasks?';
/** The layout header the Authority no longer reads, which older desktops and CLIs still send. */
const LAYOUT_HEADER = 'x-echo-answer-layout';
/** The typed-gaps opt-in the Authority no longer reads, which released desktops and CLIs still send. */
const GAP_DETAILS_HEADER = 'x-echo-ask-gap-details';
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
  it('sends typed gaps to every Ask, and answers one that still sends the retired opt-in the same', async () => {
    const f = await sentFixture();
    const original = leadAndSection();
    const model: StructuredGenerationPort = { async generate(input) {
      const reply = await original.generate(input);
      return typeof reply === 'object' && reply !== null && 'not_found' in reply ? { ...reply, not_found: ['the reviewer'] } : reply;
    } };
    const base = await origin(f, model);
    const answered = await streamedAnswer(await ask(base, {}));
    expect(answered.parts[0]!.gap_details).toEqual({ not_found: 'Not found: the reviewer.' });
    // Released clients send `1`; a value once refused before the Ask ran is read as no header at all.
    for (const value of ['1', 'true']) expect(await streamedAnswer(await ask(base, { [GAP_DETAILS_HEADER]: value }))).toEqual(answered);
  });

  it('arranges the V8 answer in the writer\'s blocks without a layout header, and answers an Ask that still sends one the same, whatever its value', async () => {
    const f = await sentFixture();
    const base = await origin(f, leadAndSection());
    const answered = await streamedAnswer(await ask(base, {}));
    const [part] = answered.parts;
    expect(part!.statements.map(statement => statement.text)).toEqual(['Ari leads Project A.', 'Your open follow-up is on the launch ticket.']);
    expect(part!.blocks).toEqual([{ kind: 'answer', statements: [0] }, { kind: 'text', title: 'Your tasks', statements: [1] }]);
    expect(part).not.toHaveProperty('layout');
    // Retired layout v1's 1, layout v2's 2, and the values once refused before the Ask ran are each read as no header at all.
    for (const headers of ['1', '2', '3', 'true', '1, 2'].map(value => ({ [LAYOUT_HEADER]: value }))) {
      expect(await streamedAnswer(await ask(base, headers))).toEqual(answered);
    }
  });
});
