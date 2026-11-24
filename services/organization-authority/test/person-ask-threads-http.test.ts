import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSON_ANSWER_PATH_V7, PERSON_ASK_CHECK_KIND_V1, createPersonAskProgressDecoderV3, validatePersonAnswerRequestV3,
  type PersonAnswerPreviousV1, type PersonAnswerThreadV1, type PersonAskCheckRequestV1, type PersonAskCheckV1,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { readablePreviousV1 } from '../src/composition/person-ask-previous-check-v1.js';
import { PersonRecordSearchSnapshotChangedV1 } from '../src/composition/person-record-search-route.js';
import { askClient, auditBodies, closeAskServers, decodeAll, fromOpened, leave, liveAskOptions, myOpenTasksPlanner, serveAsk, streamedAnswer, ticket, v7 } from './fixtures/ask-over-http.js';
import { sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The asker's threads over HTTP (ADR-0056, Ask threads v1 T3 and T4): `POST /v7/person/ask` takes the asker's other
 * threads and the older turns of the thread a follow-up continues. One resolver call places the question; a question
 * that belongs elsewhere is a streamed, audited `clarify` with no research. Every sentence of every carried turn is
 * checked for the caller before a model reads it, and nothing of a thread reaches the audit record.
 */

afterEach(closeAskServers);

const BLOCKED = 'ECHO-12 blocks the launch: the checklist is not done.';
const ROSTER = 'Kestrel roster: Mina Park (lead) and Rafael Ortiz.';
const LABEL = 'Kestrel launch project';
const MARA = 'Mara Lind owns the launch.';
const LAUNCH_QUESTION = 'What is blocking the launch?';
const ROSTER_QUESTION = 'Who is on the launch project?';
const QUESTION = 'what are the details on that ticket?';
const RESOLVED = 'What are the details on ECHO-12?';
const THREADS: readonly PersonAnswerThreadV1[] = [
  { questions: ['What did Halvorsen quote for the heat sink samples?', 'when does that Halvorsen quote expire?'], asked_at: '2026-11-22T19:00:00.000Z' },
  { questions: ['When is the Brightwave pre-scan booked?'], asked_at: '2026-11-19T17:30:00.000Z' },
  { questions: ['How much is the Halvorsen heat sink quote?'], asked_at: '2026-11-10T17:00:00.000Z' },
];
const THREAD_TEXT = THREADS.flatMap(thread => thread.questions);

/** The turn that names the ticket, and the turn that cites the project's roster and a person (whom no check reads). */
const launchTurn = { question: LAUNCH_QUESTION, asked_at: '2026-11-20T17:05:00.000Z', statements: [{ text: BLOCKED, citation_indexes: [0] }], citations: [ticket] };
/** The same turn asked after the roster turn, for a thread whose latest turn it is. */
const latestLaunchTurn = { ...launchTurn, asked_at: '2026-11-22T17:05:00.000Z' };
const rosterTurn = (f: OpenItemsFixtureV1, project_id: string = f.projectA) => ({
  question: ROSTER_QUESTION, asked_at: '2026-11-21T17:05:00.000Z',
  statements: [{ text: ROSTER, citation_indexes: [0] }, { text: MARA, citation_indexes: [1] }],
  citations: [
    { citation: { kind: 'project' as const, project_id: project_id as never }, kind: 'project' as const, label: LABEL, visibility: 'project' as const, ref: `project:${project_id}` as never },
    { citation: { kind: 'person' as const, membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' }, kind: 'person' as const, label: 'Mara Lind', visibility: 'team' as const },
  ],
});
/** A follow-up whose latest turn is `latest`, after the older turns `earlier`. */
const following = (latest: Omit<PersonAnswerPreviousV1, 'purpose' | 'earlier'>, earlier: PersonAnswerPreviousV1['earlier']): PersonAnswerPreviousV1 =>
  ({ purpose: 'follow_up', ...latest, ...(earlier === undefined ? {} : { earlier }) });

type Schema = Readonly<Record<string, unknown>>;
const properties = (input: StructuredGenerationInput) => input.schema.properties as Schema;
/** A thread resolver call is known by its schema's `thread`; the follow-up resolver's has `resolution` and no `thread`. */
const isThreadResolver = (input: StructuredGenerationInput) => properties(input).thread !== undefined;
const isFollowUpResolver = (input: StructuredGenerationInput) => properties(input).resolution !== undefined && properties(input).thread === undefined;

/** The thread resolver's replies in order, or one function for every reply; every other call goes to `inner`. Every call's prompts are kept in `seen`. */
function withThreadResolver(replies: unknown[] | (() => unknown), inner: StructuredGenerationPort) {
  const resolver: StructuredGenerationInput[] = [];
  const calls: StructuredGenerationInput[] = [];
  const model: StructuredGenerationPort = { async generate(input) {
    calls.push(input);
    if (!isThreadResolver(input)) return inner.generate(input);
    resolver.push(input);
    return typeof replies === 'function' ? replies() : replies.shift();
  } };
  const text = (inputs: readonly StructuredGenerationInput[]) => inputs.map(input => `${input.system_prompt}\n${input.user_prompt}`).join('\n');
  return { model, resolver, calls, seen: () => text(calls), seenAfterResolver: () => text(calls.filter(input => !isThreadResolver(input))) };
}
const noResearch: StructuredGenerationPort = { generate: async () => { throw new Error('no research expected'); } };
const ask = askClient({ path: PERSON_ANSWER_PATH_V7, question: QUESTION });
const body = (extra: { readonly previous?: unknown; readonly threads?: unknown; readonly question?: string }) =>
  ({ schema_version: 3, question: extra.question ?? QUESTION, ...(extra.previous === undefined ? {} : { previous: extra.previous }), ...(extra.threads === undefined ? {} : { threads: extra.threads }) });
/** Every column of every audit row the Authority wrote for answers, as one text. */
const auditText = (f: OpenItemsFixtureV1) => JSON.stringify(f.db.prepare("SELECT * FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all());

describe('where a question belongs, on /v7 (ADR-0056)', () => {
  it('streams a question that belongs to other threads as clarify with the threads by index, audited, with no research and no read', async () => {
    const f = await sentFixture();
    const { model, resolver, calls } = withThreadResolver([{ thread: 'other', threads: [3, 1] }], noResearch);
    const response = await ask(await v7(f, model), { body: body({ previous: following(launchTurn, undefined), threads: THREADS, question: 'when does the Halvorsen quote expire?' }) });
    const events = decodeAll(createPersonAskProgressDecoderV3(), await response.text());
    expect(events.map(event => event.type)).toEqual(['stage', 'answer']);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    expect(terminal.response).toEqual({
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'clarify', citations: [], parts: [],
      question: 'when does the Halvorsen quote expire?', thread: { kind: 'other', threads: [2, 0] },
    });
    expect(terminal.receipt).toMatchObject({ looked_through: 0, rows: [] });
    // One model call, the thread resolver's, shown the other threads from 1 with the days they were last asked in.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(resolver[0]!.user_prompt).threads).toEqual(THREADS.map((thread, index) => ({ n: index + 1, questions: thread.questions, last_asked_on: thread.asked_at.slice(0, 10) })));
    // The fixture's own setup opened items as Ari; the asker opened nothing.
    expect(f.openCitation.mock.calls.filter(([name]) => name === 'mina')).toEqual([]);
    // Nothing new in the audit's vocabulary: clarify, one answer-role call.
    expect(auditBodies(f, 'echo-person-agentic-ask-audit-v1')).toEqual([expect.objectContaining({ outcome: 'clarify', rounds: 0, model_calls: 1, citation_count: 0, receipt_digests: [], generations: [expect.objectContaining({ role: 'answer' })] })]);
  });

  it('passes a merge through: the one thread the question belongs to, and the thread plainly on its subject', async () => {
    const f = await sentFixture();
    const { model } = withThreadResolver([{ thread: 'other', threads: [1], merge: [3, 1] }], noResearch);
    // Asked from a page with no thread open: the request carries the threads only.
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: body({ threads: THREADS, question: 'when does the Halvorsen quote expire?' }) }));
    expect(answer).toMatchObject({ outcome: 'clarify', thread: { kind: 'other', threads: [0] }, merge: [2] });
  });

  it('researches a new subject as asked, and the answer says it starts a new thread', async () => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    const { model, resolver, seenAfterResolver } = withThreadResolver([{ thread: 'new' }], tasks.model);
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: body({ previous: following(launchTurn, undefined), threads: THREADS, question: 'What are my open tasks?' }) }));
    expect(answer).toMatchObject({ outcome: 'answered', question: 'What are my open tasks?', thread: { kind: 'new' } });
    expect(resolver).toHaveLength(1);
    // Research starts from nothing of the open thread (no item opened before its first step), on the question as asked,
    // and neither research nor the writer is shown the thread or the other threads.
    expect(tasks.steps[0]).toMatchObject({ question: 'What are my open tasks?', opened: [] });
    for (const text of [BLOCKED, LAUNCH_QUESTION, ...THREAD_TEXT]) expect(seenAfterResolver()).not.toContain(text);
  });

  it('lets a person start a second thread from inside their only one: an empty list of threads is still placed', async () => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    const { model, resolver } = withThreadResolver([{ thread: 'new' }], tasks.model);
    // The client keeps threads and the person has no other yet: the list goes, empty.
    const sent = body({ previous: following(launchTurn, undefined), threads: [], question: 'What are my open tasks?' });
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: sent }));
    expect(answer).toMatchObject({ outcome: 'answered', question: 'What are my open tasks?', thread: { kind: 'new' } });
    // The thread resolver ran, and was shown the open thread and no other.
    expect(resolver).toHaveLength(1);
    expect(JSON.parse(resolver[0]!.user_prompt)).toMatchObject({ threads: [], open: { turns: [{ question: LAUNCH_QUESTION }] } });
    expect(tasks.steps[0]).toMatchObject({ question: 'What are my open tasks?', opened: [] });
  });

  it('answers a new subject in its thread, saying nothing of threads, when the request carried older turns and no list', async () => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    // The same reply, to a request that is not being placed: no `threads` field at all.
    const { model, resolver } = withThreadResolver([{ thread: 'new' }], tasks.model);
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: body({ previous: following(latestLaunchTurn, [launchTurn]), question: 'What are my open tasks?' }) }));
    expect(answer).toMatchObject({ outcome: 'answered', question: 'What are my open tasks?' });
    for (const key of ['thread', 'merge']) expect(answer).not.toHaveProperty(key);
    expect(resolver).toHaveLength(1);
    expect(JSON.parse(resolver[0]!.user_prompt).threads).toEqual([]);
  });

  it('resolves a reference to something only an older turn names, and starts research from that turn\'s citation', async () => {
    const f = await sentFixture();
    const research = fromOpened();
    const { model, resolver } = withThreadResolver([{ thread: 'open', resolution: 'resolved', question: RESOLVED, about: [1], merge: [2] }], research);
    // The latest turn names no ticket: only the older one does.
    const { statements: [roster], citations: [project] } = rosterTurn(f);
    const previous = following({ question: ROSTER_QUESTION, asked_at: '2026-11-22T17:05:00.000Z', statements: [roster!], citations: [project!] }, [launchTurn]);
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: body({ previous, threads: THREADS }) }));
    expect(answer).toMatchObject({ outcome: 'answered', question: RESOLVED, merge: [1], parts: [{ question: RESOLVED }] });
    // The resolver read the thread oldest first, its sources one list: the older turn's ticket is source 1.
    const shown = JSON.parse(resolver[0]!.user_prompt) as { readonly open: { readonly turns: readonly { readonly question: string; readonly statements: readonly unknown[] }[]; readonly sources: readonly unknown[] } };
    expect(shown.open.turns).toEqual([
      { question: LAUNCH_QUESTION, asked_on: '2026-11-20', statements: [{ n: 1, text: BLOCKED, sources: [1] }] },
      { question: ROSTER_QUESTION, asked_on: '2026-11-22', statements: [{ n: 2, text: ROSTER, sources: [2] }] },
    ]);
    expect(shown.open.sources).toEqual([{ n: 1, kind: 'ticket', label: ticket.label }, { n: 2, kind: 'project', label: LABEL }]);
    // The ticket was opened through the asker's own Jira connection before research's first step, which saw the full question.
    expect(f.openCitation.mock.calls.filter(([name]) => name === 'mina')).toEqual([['mina', ticket.citation]]);
    expect(research.steps[0]).toMatchObject({ question: RESOLVED, opened: [expect.objectContaining({ id: 'E1' })] });
    const [audit] = auditBodies(f, 'echo-person-agentic-ask-audit-v1');
    expect(audit).toMatchObject({ outcome: 'answered', model_calls: 3, generations: [{ role: 'answer' }, { role: 'step' }, { role: 'answer' }] });
  });

  it('makes exactly the calls it makes today for a request with neither threads nor older turns', async () => {
    const f = await sentFixture();
    const research = fromOpened();
    const calls: StructuredGenerationInput[] = [];
    const model: StructuredGenerationPort = { async generate(input) {
      calls.push(input);
      return isFollowUpResolver(input) ? { resolution: 'resolved', question: RESOLVED, about: [1] } : research.generate(input);
    } };
    const base = await v7(f, model);
    const answer = await streamedAnswer(await ask(base, { body: body({ previous: following(launchTurn, undefined) }) }));
    expect(answer).toMatchObject({ outcome: 'answered', question: RESOLVED });
    for (const key of ['thread', 'merge']) expect(answer).not.toHaveProperty(key);
    // The follow-up resolver, with its own schema and input, then one research step and the writer: no thread resolver.
    expect(calls.map(input => isThreadResolver(input) ? 'thread' : isFollowUpResolver(input) ? 'follow_up' : properties(input).blocks !== undefined ? 'writer' : 'step')).toEqual(['follow_up', 'step', 'writer']);
    expect(Object.keys(properties(calls[0]!))).toEqual(['resolution', 'question', 'about', 'choices']);
    expect(calls[0]!.system_prompt.startsWith("You work out what a person's new question refers to, from the question they asked just before it and the answer they got.")).toBe(true);
    expect(Object.keys(JSON.parse(calls[0]!.user_prompt))).toEqual(['today', 'previous', 'question']);
    // And an Ask with no previous turn at all resolves nothing.
    calls.length = 0;
    const tasks = myOpenTasksPlanner();
    const plain = await streamedAnswer(await ask(await v7(f, { async generate(input) { calls.push(input); return tasks.model.generate(input); } }), { body: body({ question: 'What are my open tasks?' }) }));
    for (const key of ['question', 'thread', 'merge']) expect(plain).not.toHaveProperty(key);
    expect(calls.some(input => isThreadResolver(input) || isFollowUpResolver(input))).toBe(false);
  });

  it('refuses threads and older turns that are not valid before the Ask runs', async () => {
    const f = await sentFixture();
    const generate = vi.fn(async () => { throw new Error('no model call expected'); });
    const base = await v7(f, { generate });
    const invalid = [
      body({ threads: [{ questions: [], asked_at: THREADS[0]!.asked_at }] }), body({ threads: [{ ...THREADS[0]!, title: 'Halvorsen' }] }), body({ threads: {} }),
      body({ previous: following(launchTurn, []), threads: THREADS }), body({ previous: following(launchTurn, [{ ...launchTurn, purpose: 'follow_up' } as never]) }),
      // An Ask again asks one earlier question again where it was asked: it carries neither.
      body({ question: LAUNCH_QUESTION, previous: { ...following(launchTurn, undefined), purpose: 'ask_again' }, threads: THREADS }),
      body({ question: LAUNCH_QUESTION, previous: { ...following(launchTurn, [launchTurn]), purpose: 'ask_again' } }),
    ];
    for (const request of invalid) {
      const response = await ask(base, { body: request });
      expect(response.status, JSON.stringify(request)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('what a model may read of a thread, and what the audit keeps (ADR-0056, INV-PERMISSIONS-015)', () => {
  /** A resolver that says the question continues the open thread as asked, and research that lists open tasks. */
  function recording() {
    const tasks = myOpenTasksPlanner();
    const run = withThreadResolver(() => ({ thread: 'open', resolution: 'same' }), tasks.model);
    return { ...run, reset: () => { run.calls.length = 0; run.resolver.length = 0; tasks.reset(); } };
  }

  it('never shows a model a sentence of an older turn whose citation the caller cannot read when the request arrives', async () => {
    const f = await sentFixture();
    const run = recording();
    const base = await v7(f, run.model);
    // The older turn rests on the project's roster and on a person; the latest on a ticket the asker reads.
    const uncited = 'Uncited: the roster is Mina and Rafael.';
    const older = { ...rosterTurn(f), statements: [...rosterTurn(f).statements, { text: uncited, citation_indexes: [] }] };
    const send = () => ask(base, { body: body({ previous: following(latestLaunchTurn, [older]), threads: THREADS, question: 'And who leads it?' }) });
    expect((await streamedAnswer(await send())).outcome).toBe('answered');
    // A member reads the roster; a sentence resting on a person (no check reads one) or on nothing is never carried.
    expect(run.seen()).toContain(ROSTER);
    expect(run.seen()).toContain(LABEL);
    expect(run.seen()).toContain(BLOCKED);
    expect(run.seen()).not.toContain(MARA);
    expect(run.seen()).not.toContain(uncited);
    // The client's check said `same`; then Mina leaves the project, and the same request is sent again (a retry of it).
    leave(f);
    run.reset();
    expect((await streamedAnswer(await send())).outcome).toBe('answered');
    expect(run.calls.length).toBeGreaterThan(1);
    expect(run.seen()).not.toContain(ROSTER);
    expect(run.seen()).not.toContain(LABEL);
    // The older turn keeps its question, the person's own words; the latest turn keeps the sentence they can still read.
    const shown = JSON.parse(run.resolver[0]!.user_prompt) as { readonly open: { readonly turns: readonly unknown[]; readonly sources: readonly unknown[] } };
    expect(shown.open.turns).toEqual([
      { question: ROSTER_QUESTION, asked_on: '2026-11-21', statements: [] },
      { question: LAUNCH_QUESTION, asked_on: '2026-11-22', statements: [{ n: 1, text: BLOCKED, sources: [1] }] },
    ]);
    expect(shown.open.sources).toEqual([{ n: 1, kind: 'ticket', label: ticket.label }]);
  });

  it('never shows it for a project the caller was never in, or one that does not exist', async () => {
    const f = await sentFixture();
    const run = recording();
    const base = await v7(f, run.model);
    for (const [token, older] of [['okafor', rosterTurn(f)], ['mina', rosterTurn(f, 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10')]] as const) {
      run.reset();
      // Whatever the Ask then finds, it ends in an answer.
      await streamedAnswer(await ask(base, { token, body: body({ previous: following({ question: 'and then?', asked_at: '2026-11-22T17:05:00.000Z', statements: [], citations: [] }, [older]), question: 'And who leads it?' }) }));
      // Older turns alone (no other thread) still take the thread resolver, which read the older turn's question only.
      expect(run.resolver).toHaveLength(1);
      expect(run.seen()).toContain(ROSTER_QUESTION);
      for (const text of [ROSTER, LABEL, MARA]) expect(run.seen(), `${token}: ${text}`).not.toContain(text);
    }
  });

  it('writes none of a thread\'s text to the audit record, whatever the question\'s place', async () => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    const { model } = withThreadResolver([{ thread: 'other', threads: [1, 3] }, { thread: 'new' }, { thread: 'open', resolution: 'same', merge: [2] }], tasks.model);
    const base = await v7(f, model);
    const previous = following(latestLaunchTurn, [rosterTurn(f)]);
    const outcomes: string[] = [];
    for (const question of ['when does that quote expire?', 'What are my open tasks?', 'And what are my open tasks?']) {
      tasks.reset();
      outcomes.push((await streamedAnswer(await ask(base, { body: body({ previous, threads: THREADS, question }) }))).outcome);
    }
    expect(outcomes).toEqual(['clarify', 'answered', 'answered']);
    const rows = auditBodies(f, 'echo-person-agentic-ask-audit-v1');
    expect(rows.map(row => row.outcome)).toEqual(['clarify', 'answered', 'answered']);
    // Outcome, role and span vocabulary are the existing ones.
    for (const row of rows) for (const generation of row.generations as readonly { readonly role: string }[]) expect(['answer', 'step']).toContain(generation.role);
    const written = auditText(f);
    for (const text of [...THREAD_TEXT, 'Halvorsen', 'Brightwave', ROSTER_QUESTION, LAUNCH_QUESTION, ROSTER, BLOCKED, 'when does that quote expire?']) expect(written, text).not.toContain(text);
    for (const key of ['"threads"', '"merge"', '"thread"']) expect(written, key).not.toContain(key);
  });

  it.each([false, true])('checks every turn again on a snapshot restart, and reuses the paid resolution only while the checked turns are the same (access lost: %s)', async lost => {
    const f = await sentFixture();
    const tasks = myOpenTasksPlanner();
    const prompts: string[] = [];
    let restarted = false;
    // The first research step after the resolver sees the snapshot move; access to the older turn's source may be lost before the restart.
    const model: StructuredGenerationPort = { async generate(input) {
      if (isThreadResolver(input)) { prompts.push(input.user_prompt); return { thread: 'open', resolution: 'same', merge: [3] }; }
      if (!restarted) { restarted = true; if (lost) leave(f); throw new PersonRecordSearchSnapshotChangedV1(); }
      return tasks.model.generate(input);
    } };
    const answer = await streamedAnswer(await ask(await v7(f, model), { body: body({ previous: following(latestLaunchTurn, [rosterTurn(f)]), threads: THREADS, question: 'And who leads it?' }) }));
    expect(answer).toMatchObject({ outcome: 'answered', merge: [2] });
    expect(restarted).toBe(true);
    // Unchanged: the resolution is not paid for twice. Changed: resolved again, from the turns as checked now.
    expect(prompts).toHaveLength(lost ? 2 : 1);
    expect(prompts[0]).toContain(ROSTER);
    if (lost) expect(prompts[1]).not.toContain(ROSTER);
  });

  it.each([
    ['a question placed among threads', true],
    // The follow-up path as it was before threads: it reused its resolution across midnight, and still does.
    ['a follow-up with neither threads nor older turns', false],
  ])('reads one day for the whole request when the client sent no clock: a restart after midnight resolves nothing again (%s)', async (_name, placed) => {
    // Only the wall clock is faked; the server's own timers run as they are.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T23:59:40.000Z') });
    try {
      const f = await sentFixture();
      const tasks = myOpenTasksPlanner();
      const resolverDays: string[] = [];
      const laterDays: string[] = [];
      let restarted = false;
      const model: StructuredGenerationPort = { async generate(input) {
        const { today } = JSON.parse(input.user_prompt) as { readonly today: string };
        if (isThreadResolver(input)) { resolverDays.push(today); return { thread: 'open', resolution: 'same' }; }
        if (isFollowUpResolver(input)) { resolverDays.push(today); return { resolution: 'same' }; }
        laterDays.push(today);
        // The first research step sees the snapshot move, and the wall clock passes UTC midnight before the restart.
        if (!restarted) { restarted = true; vi.setSystemTime(new Date('2026-11-24T00:00:20.000Z')); throw new PersonRecordSearchSnapshotChangedV1(); }
        return tasks.model.generate(input);
      } };
      // No time headers: the server's day is the request's day.
      const sent = placed ? body({ previous: following(latestLaunchTurn, [launchTurn]), threads: THREADS, question: 'And who leads it?' })
        : body({ previous: following(launchTurn, undefined), question: 'And who leads it?' });
      const answer = await streamedAnswer(await ask(await v7(f, model), { body: sent }));
      expect(answer).toMatchObject({ outcome: 'answered', question: 'And who leads it?' });
      expect(restarted).toBe(true);
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-11-24');
      // The paid resolution was made on the day the request arrived, and the restarted attempt is shown that same day,
      // so it is the same call and is not made twice.
      expect(resolverDays).toEqual(['2026-11-23']);
      expect(laterDays.length).toBeGreaterThan(1);
      expect([...new Set(laterDays)]).toEqual(['2026-11-23']);
    } finally { vi.useRealTimers(); }
  });
});

describe('the turns of a thread as the Authority lets its model read them (ADR-0056)', () => {
  const previousOf = (f: OpenItemsFixtureV1) => following(latestLaunchTurn, [rosterTurn(f), { question: 'and then?', asked_at: '2026-11-21T18:00:00.000Z', statements: [], citations: [] }]);

  it('checks the citations of every turn in one check, each with the time its own turn was asked', async () => {
    const f = await sentFixture();
    const requests: PersonAskCheckRequestV1[] = [];
    const check = { check: vi.fn(async ({ request }: { readonly request: PersonAskCheckRequestV1 }): Promise<PersonAskCheckV1> => {
      requests.push(request);
      return { schema_version: 1, kind: PERSON_ASK_CHECK_KIND_V1, items: request.items.map(item => ({ state: item.citation.kind === 'ticket' ? 'same' as const : 'unreadable' as const })) };
    }) };
    const previous = previousOf(f);
    const readable = await readablePreviousV1(previous, { access_token: 'mina', check });
    // One check for the whole thread; a person is of a kind the check does not read, so it is not sent.
    expect(check.check).toHaveBeenCalledTimes(1);
    expect(requests[0]!.items).toEqual([
      { asked_at: '2026-11-21T17:05:00.000Z', citation: rosterTurn(f).citations[0]!.citation },
      { asked_at: '2026-11-22T17:05:00.000Z', citation: ticket.citation },
    ]);
    // Turn by turn: the older turn keeps its question only, the empty turn stays, the latest keeps its readable sentence.
    expect(readable).toEqual({
      purpose: 'follow_up', ...latestLaunchTurn,
      earlier: [{ question: ROSTER_QUESTION, asked_at: '2026-11-21T17:05:00.000Z', statements: [], citations: [] }, previous.earlier![1]],
    });
    // What it returns is still a previous turn the API takes.
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: QUESTION, previous: readable }).previous).toEqual(readable);
  });

  it('keeps and renumbers each turn\'s own citations, and keeps only the questions with no check', async () => {
    const f = await sentFixture();
    const check = liveAskOptions(f, undefined as never).previous_check!;
    const older = rosterTurn(f);
    // The older turn cites the person first, so its kept roster citation moves from 1 to 0.
    const reordered = { ...older, statements: [{ text: MARA, citation_indexes: [0] }, { text: ROSTER, citation_indexes: [1] }], citations: [older.citations[1]!, older.citations[0]!] };
    const readable = await readablePreviousV1(following(launchTurn, [reordered]), { access_token: 'mina', check });
    expect(readable.earlier).toEqual([{ question: ROSTER_QUESTION, asked_at: older.asked_at, statements: [{ text: ROSTER, citation_indexes: [0] }], citations: [older.citations[0]] }]);
    expect(readable).toMatchObject({ purpose: 'follow_up', question: LAUNCH_QUESTION, statements: launchTurn.statements, citations: [ticket] });
    const questionsOnly = { purpose: 'follow_up', question: LAUNCH_QUESTION, asked_at: launchTurn.asked_at, statements: [], citations: [],
      earlier: [{ question: ROSTER_QUESTION, asked_at: older.asked_at, statements: [], citations: [] }] };
    expect(await readablePreviousV1(following(launchTurn, [reordered]), { access_token: 'mina', check: undefined })).toEqual(questionsOnly);
    // A turn with no older turn is returned as it always was: no `earlier` appears.
    expect(await readablePreviousV1(following(launchTurn, undefined), { access_token: 'mina', check })).toEqual({ purpose: 'follow_up', ...launchTurn });
  });
});

describe('the asker\'s threads at the HTTP boundary (ADR-0056)', () => {
  it('reach the Ask as sent', async () => {
    const asked: unknown[] = [];
    const application = { askWithProgress: vi.fn(async (input: { readonly request: unknown }) => { asked.push(input.request); throw new Error('this test only reads the boundary'); }) };
    const base = await serveAsk({ person_answer_v7: application as never });
    const request = body({ previous: following(launchTurn, [launchTurn]), threads: THREADS });
    await fetch(`${base}${PERSON_ANSWER_PATH_V7}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mina' }, body: JSON.stringify(request) });
    expect(asked).toEqual([request]);
  });
});
