import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_ANSWER_PATH_V3, PERSON_ANSWER_PATH_V4, PERSON_ANSWER_PATH_V5, PERSON_ANSWER_PATH_V6, PERSON_ANSWER_PATH_V7,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V2, PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  createPersonAskProgressDecoderV3, validatePersonAnswerResponseV8,
  type PersonAnswerPreviousV1,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createPersonLiveAnswerRouteV1 } from '../src/composition/person-live-answer-route-v1.js';
import { askClient, auditBodies, closeAskServers, decodeAll, liveAskOptions, myOpenTasksPlanner, serveAsk } from './fixtures/ask-over-http.js';
import { CLOUD, sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The asker's previous turn over HTTP (ADR-0047): `POST /v7/person/ask` takes
 * it, plain and streamed, and hands it to the V8 Ask, which resolves a
 * follow-up before research or asks which one, audited as `clarify`. Every
 * older route refuses a request that carries it before its Ask runs.
 */

afterEach(closeAskServers);

const ticket = {
  citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: CLOUD, ticket_id: '10012', permalink: 'https://echo-fixture.atlassian.net/browse/ECHO-12', text_sha256: canonicalSha256('ECHO-12 text') },
  kind: 'ticket' as const, label: 'ECHO-12: Launch checklist', visibility: 'only_me' as const,
};
const PREVIOUS: PersonAnswerPreviousV1 = {
  purpose: 'follow_up', question: 'What is blocking the launch?', asked_at: '2026-10-24T17:05:00.000Z',
  statements: [{ text: 'ECHO-12 blocks the launch: the checklist is not done.', citation_indexes: [0] }], citations: [ticket],
};
const QUESTION = 'what are the details on that ticket?';
const RESOLVED = 'What are the details on ECHO-12?';
const CHOICES = [{ label: 'ECHO-12', question: RESOLVED }, { label: 'ECHO-14', question: 'What are the details on ECHO-14?' }];

/** The resolver's replies in order, a resolver call known by its schema's `resolution`; every other call goes to `inner`. */
function withResolver(replies: unknown[], inner: StructuredGenerationPort) {
  const resolver: StructuredGenerationInput[] = [];
  const model: StructuredGenerationPort = { async generate(input) {
    if ((input.schema.properties as Readonly<Record<string, unknown>>).resolution === undefined) return inner.generate(input);
    resolver.push(input);
    return replies.shift();
  } };
  return { model, resolver };
}
/** Research that finishes on what it was given opened; the writer states one sentence from it. */
function fromOpened(): StructuredGenerationPort & { readonly steps: Record<string, unknown>[] } {
  const steps: Record<string, unknown>[] = [];
  return { steps, async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as { readonly question?: string; readonly opened?: readonly { readonly id: string }[]; readonly evidence?: readonly { readonly id: string }[] };
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      return { lists: [], sentences: [{ text: 'ECHO-12 ships on Oct 30.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    steps.push(prompt);
    const [opened] = prompt.opened ?? [];
    return { parts: [{ question: prompt.question!, notes: '', needs: [{ need: 'the ticket', status: opened === undefined ? 'open' : 'found', evidence: opened === undefined ? [] : [opened.id] }] }],
      actions: [opened === undefined ? { tool: 'search', args: { query: 'ECHO-12' } } : { tool: 'finish', args: {} }] };
  } };
}
const v7 = (f: OpenItemsFixtureV1, model: StructuredGenerationPort) => serveAsk({ person_answer_v7: createPersonLiveAnswerRouteV1(liveAskOptions(f, model), 8) });
const ask = askClient({ path: PERSON_ANSWER_PATH_V7, progress: PERSON_ASK_PROGRESS_HEADER_VALUE_V3, question: QUESTION });
const body = (previous: unknown = PREVIOUS, question = QUESTION) => ({ schema_version: 3, question, previous });

describe('the previous turn on /v7 (ADR-0047)', () => {
  it('resolves a follow-up before research, starts from the ticket it points to, and names the question it answered', async () => {
    const f = await sentFixture();
    const research = fromOpened();
    const { model, resolver } = withResolver([{ resolution: 'resolved', question: RESOLVED, about: [1] }], research);
    const response = await ask(await v7(f, model), { progress: null, body: body() });
    expect(response.status).toBe(200);
    const answer = validatePersonAnswerResponseV8(await response.json());
    expect(answer).toMatchObject({ outcome: 'answered', question: RESOLVED, parts: [{ question: RESOLVED }] });
    expect(resolver).toHaveLength(1);
    // The ticket was opened through the asker's own Jira connection before research's first step, which saw the full question.
    expect(f.openCitation.mock.calls.filter(([name]) => name === 'mina')).toEqual([['mina', ticket.citation]]);
    expect(research.steps[0]).toMatchObject({ question: RESOLVED, opened: [expect.objectContaining({ id: 'E1' })] });
    const [audit] = auditBodies(f, 'echo-person-agentic-ask-audit-v1');
    expect(audit).toMatchObject({ outcome: 'answered', model_calls: 3, generations: [{ role: 'answer' }, { role: 'step' }, { role: 'answer' }] });
  });

  it('streams a follow-up that asks which one, and audits it as clarify, with no read', async () => {
    const f = await sentFixture();
    const { model } = withResolver([{ resolution: 'clarify', choices: CHOICES }], { generate: async () => { throw new Error('no research expected'); } });
    const response = await ask(await v7(f, model), { body: body() });
    const events = decodeAll(createPersonAskProgressDecoderV3(), await response.text());
    expect(events.map(event => event.type)).toEqual(['stage', 'answer']);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    expect(terminal.response).toEqual({ schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'clarify', citations: [], parts: [], question: QUESTION, choices: CHOICES });
    expect(terminal.receipt).toMatchObject({ looked_through: 0, rows: [] });
    // The fixture's own setup opened items as Ari; the asker opened nothing.
    expect(f.openCitation.mock.calls.filter(([name]) => name === 'mina')).toEqual([]);
    expect(auditBodies(f, 'echo-person-agentic-ask-audit-v1')).toEqual([expect.objectContaining({ outcome: 'clarify', rounds: 0, model_calls: 1, citation_count: 0, receipt_digests: [] })]);
  });

  it('answers a question that stands alone as asked, naming it, and never resolves an Ask without the previous turn', async () => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    const { model, resolver } = withResolver([{ resolution: 'same' }], tasks.model);
    const base = await v7(f, model);
    const followed = validatePersonAnswerResponseV8(await (await ask(base, { progress: null, body: body(PREVIOUS, 'What are my open tasks?') })).json());
    expect(followed).toMatchObject({ outcome: 'answered', question: 'What are my open tasks?' });
    tasks.reset();
    const plain = validatePersonAnswerResponseV8(await (await ask(base, { progress: null, body: { schema_version: 3, question: 'What are my open tasks?' } })).json());
    expect(plain).not.toHaveProperty('question');
    expect(plain.parts).toEqual(followed.parts);
    expect(resolver).toHaveLength(1);
  });

  it('refuses a previous turn that is not valid before the Ask runs', async () => {
    const f = await sentFixture();
    const generate = vi.fn(async () => { throw new Error('no model call expected'); });
    const base = await v7(f, { generate });
    for (const previous of [{ ...PREVIOUS, purpose: 'guess' }, { ...PREVIOUS, statements: [{ text: 'x'.repeat(401), citation_indexes: [] }] }, { ...PREVIOUS, extra: true }]) {
      const response = await ask(base, { progress: null, body: body(previous) });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('every route before /v7 refuses the previous turn (ADR-0047)', () => {
  it('answers invalid_request before its Ask runs, plain and streamed, and still answers the same request without it', async () => {
    const asked: unknown[] = [];
    const application = { ask: vi.fn(async (input: { readonly request: unknown }) => { asked.push(input.request); throw new Error('this test only reads the boundary'); }), askWithProgress: vi.fn() };
    const base = await serveAsk({ person_answer_v3: application as never, person_answer_v4: application as never, person_answer_v5: application as never, person_answer_v6: application as never, person_answer_v7: application as never });
    const post = (path: string, request: unknown, progress?: string) => fetch(`${base}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer mina', ...(progress === undefined ? {} : { 'x-echo-ask-progress': progress }) }, body: JSON.stringify(request) });
    for (const [path, progress] of [[PERSON_ANSWER_PATH_V3], [PERSON_ANSWER_PATH_V4], [PERSON_ANSWER_PATH_V5], [PERSON_ANSWER_PATH_V6], [PERSON_ANSWER_PATH_V6, PERSON_ASK_PROGRESS_HEADER_VALUE_V2]] as const) {
      const refused = await post(path, body(), progress);
      expect([path, refused.status]).toEqual([path, 400]);
      await expect(refused.json()).resolves.toEqual({ error: { code: 'invalid_request', message: 'request failed' } });
    }
    expect(application.ask).not.toHaveBeenCalled();
    expect(application.askWithProgress).not.toHaveBeenCalled();
    // Without it, the same request reaches the older route's Ask; with it, /v7 hands it on as sent.
    await post(PERSON_ANSWER_PATH_V6, { schema_version: 3, question: QUESTION });
    await post(PERSON_ANSWER_PATH_V7, body());
    expect(asked).toEqual([{ schema_version: 3, question: QUESTION }, body()]);
  });
});
