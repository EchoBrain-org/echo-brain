import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import {
  PERSON_ANSWER_PATH_V5, PERSON_ANSWER_PATH_V6, PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_ASK_PROGRESS_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2,
  createPersonAskProgressDecoderV1, createPersonAskProgressDecoderV2, validatePersonAnswerResponseV6, validatePersonAnswerResponseV7,
  type PersonAskProgressEventV2,
} from '@echo-brain/organization-api';
import type { StructuredGenerationInput, StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SqlitePersonAgenticAskAuditV1 } from '../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonSessionRepository } from '../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { JIRA_LIVE_CONNECTOR_V1 } from '../src/composition/person-live-connector-registry-v1.js';
import { createPersonLiveAnswerRouteV1, type CreatePersonLiveAnswerRouteOptionsV1 } from '../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { sentFixture, type FixturePerson, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The V7 Ask over HTTP (ADR-0039, ADR-0040): `POST /v6/person/ask` behind the
 * real server, over the real open-items Authority state, streamed as Ask
 * progress V2 exactly as `/v5` streams V1. "What are my open tasks?" lists the
 * asker's follow-ups, reads one, and cites it: its name reaches the stream
 * only after the access check before the call that reads it, and its owner,
 * decision and check never do.
 */

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
});

const empty = Object.freeze({ items: Object.freeze([]), truncated: false, receipt_digests: Object.freeze([]) });
type StepPrompt = { readonly question?: string; readonly asked_by?: string; readonly source_catalog?: readonly { readonly source: string }[];
  readonly last_results?: readonly { readonly tool: string; readonly args?: { readonly owner?: string }; readonly items?: readonly string[] }[] };

/** Lists the asker's open follow-ups, opens the first, finishes on it; the writer states one sentence from it. */
function myOpenTasks() {
  const catalogs: string[][] = [];
  let steps = 0;
  let mine: string | undefined;
  const model: StructuredGenerationPort = { async generate(input: StructuredGenerationInput) {
    const prompt = JSON.parse(input.user_prompt) as StepPrompt & { readonly evidence?: readonly { readonly id: string }[] };
    if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
      return { sentences: [{ text: 'Your open follow-up is on the launch ticket.', evidence: [prompt.evidence![0]!.id] }], not_found: [] };
    }
    if (prompt.source_catalog !== undefined) catalogs.push(prompt.source_catalog.map(entry => entry.source));
    mine ??= prompt.last_results?.find(result => result.tool === 'list' && result.args?.owner !== undefined)?.items?.[0];
    const step = steps++;
    const actions = step === 0 ? [{ tool: 'list', args: { source: 'follow_ups', owner: prompt.asked_by, status: 'open' } }]
      : step === 1 && mine !== undefined ? [{ tool: 'open', args: { id: mine } }] : [{ tool: 'finish', args: {} }];
    const found = actions[0]!.tool === 'finish' && mine !== undefined;
    return { parts: [{ question: prompt.question!, notes: 'PLANNER-CANARY', needs: [{ need: 'Open follow-ups', status: found ? 'found' : 'open', evidence: found ? [mine] : [] }] }], actions };
  } };
  return { model, catalogs, reset() { steps = 0; mine = undefined; } };
}

/** The `/v5` and `/v6` routes as the runtime composes them: Jira opened as the fixture's desk opens it, and the follow-up sources. */
async function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort, mount: { readonly v6?: boolean } = {}) {
  const sessions = f.openItemsOptions.sessions;
  const jira = (name: FixturePerson): PersonLiveEvidenceSourceV1 => ({
    tool_id: 'jira', search: vi.fn(async () => empty as never), open: vi.fn(async () => empty as never), list: vi.fn(async () => empty as never),
    openCitation: vi.fn(async ({ citation }) => f.openCitation(name, citation as never) as never), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}),
  });
  const repository = new SqlitePersonSessionRepository(f.db);
  const options: CreatePersonLiveAnswerRouteOptionsV1 = {
    authority_id: 'authority', organization_id: f.person.organization_id, state_lineage_id: 'lineage',
    sessions: sessions as never, originals: new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, f.person.organization_id),
    records: { initializeDesk() { throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1_000 },
    audit: new SqlitePersonAgenticAskAuditV1(f.db),
    memberships: { membership: (id: string) => repository.read(transaction => transaction.membership(id)) },
    live_sources: [{ ...JIRA_LIVE_CONNECTOR_V1, application: { source: async ({ access_token }) => jira(access_token as FixturePerson) } }],
    follow_ups: { runs: f.runs, items: f.items, people: f.directory, records: f.records, on_live_failure: () => {} },
  };
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example',
    person_answer_v5: createPersonLiveAnswerRouteV1(options, 6), ...(mount.v6 === false ? {} : { person_answer_v6: createPersonLiveAnswerRouteV1(options, 7) }) });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
  return `http://127.0.0.1:${address.port}`;
}
const ask = (base: string, input: { readonly path?: string; readonly progress?: string | null; readonly token?: FixturePerson | 'stranger' } = {}) => fetch(`${base}${input.path ?? PERSON_ANSWER_PATH_V6}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token ?? 'mina'}`,
    ...(input.progress === null ? {} : { [PERSON_ASK_PROGRESS_HEADER_V1]: input.progress ?? PERSON_ASK_PROGRESS_HEADER_VALUE_V2 }) },
  body: JSON.stringify({ schema_version: 3, question: 'What are my open tasks?' }),
});
function decode(text: string): readonly PersonAskProgressEventV2[] {
  const decoder = createPersonAskProgressDecoderV2();
  const events = [...decoder.push(text)];
  decoder.end();
  return events;
}
const askAudits = (f: OpenItemsFixtureV1) => (f.db.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all() as { body_json: string }[])
  .map(row => JSON.parse(row.body_json) as Record<string, unknown>).filter(body => body.kind === 'echo-person-agentic-ask-audit-v1');

describe('the V7 Ask streamed on /v6 (ADR-0039, ADR-0040)', () => {
  it('streams progress V2: searches name follow-ups, the follow-up it read is named and cited, and the receipt lists it', async () => {
    const f = await sentFixture();
    const planner = myOpenTasks();
    const base = await origin(f, planner.model);
    const plain = await ask(base, { progress: null });
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(plain.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('6');
    const json = validatePersonAnswerResponseV7(await plain.json());
    planner.reset();
    const followUp = { citation: { kind: 'follow_up', item_id: f.ticket.item_id }, kind: 'follow_up', label: `ECHO-12 ${f.outsideText}`, visibility: 'only_me', ref: `follow_up:${f.ticket.item_id}` };
    expect(json.citations).toEqual([followUp]);

    const streamed = await ask(base);
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(streamed.headers.get('cache-control')).toBe('no-store');
    expect(streamed.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('6');
    const raw = await streamed.text();
    for (const line of raw.split('\n')) expect(line === '' || line.startsWith('data: ') || line.startsWith(':')).toBe(true);
    const events = decode(raw);
    expect(planner.catalogs[0]).toContain('follow_ups');
    expect(events.filter(event => event.type === 'searched')).toEqual([{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 1 }]);
    // Named once, as the answer cites it: the label Mina's own Jira read gave, and the ref that opens its item page.
    expect(events.filter(event => event.type === 'read')).toEqual([{ type: 'read', items: [followUp] }]);
    expect(events.find(event => event.type === 'stage' && event.stage === 'reading')).toEqual({ type: 'stage', stage: 'reading', pending: 1 });
    expect(events.slice(-3, -1)).toEqual([{ type: 'stage', stage: 'writing' }, { type: 'stage', stage: 'checking_access' }]);
    const terminal = events.at(-1)!;
    if (terminal.type !== 'answer') throw new Error('expected the answer event');
    // The V7 answer, byte for byte the JSON route's, and a receipt that names the follow-up it read.
    expect(terminal.response).toEqual(json);
    expect(terminal.receipt).toMatchObject({ looked_through: 1, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 1 }, { type: 'read', items: [followUp] }] });
    // While it ran, nothing of what the follow-up says left the Authority: not its owner, decision, due date or the planner's words.
    const progress = raw.slice(0, raw.lastIndexOf('data: '));
    for (const secret of ['Mina Patel', 'Pilot planning', '2026-10-30', 'launch next week', 'PLANNER-CANARY', '"E1"']) expect(progress).not.toContain(secret);
    // The streamed request's record names the follow-up by its citation commitment; the JSON one names nothing.
    const audits = askAudits(f);
    expect(audits).toHaveLength(2);
    expect(audits[0]).not.toHaveProperty('named_citation_digests');
    expect(audits[1]).toMatchObject({ outcome: 'answered', named_citation_digests: [canonicalSha256(followUp.citation)] });
  });

  it('names a follow-up nothing was read live for by its title, the expected phrase ECHO holds, and still never its owner, decision or check', async () => {
    // Mina's Jira read fails, so the follow-up's title is the ECHO-held expected phrase, as its citation label is.
    const f = await sentFixture({ openFails: { ticket: new AuthorityOperationError('unavailable', 'Jira is down') } });
    f.check(f.ticket.item_id, 'still_open');
    const planner = myOpenTasks();
    const base = await origin(f, planner.model);
    const json = validatePersonAnswerResponseV7(await (await ask(base, { progress: null })).json());
    planner.reset();
    expect(json.citations).toEqual([expect.objectContaining({ kind: 'follow_up', label: 'launch next week', ref: `follow_up:${f.ticket.item_id}` })]);
    const raw = await (await ask(base)).text();
    const events = decode(raw);
    expect(events.filter(event => event.type === 'read')).toEqual([{ type: 'read', items: json.citations }]);
    const progress = raw.slice(0, raw.lastIndexOf('data: '));
    expect(progress).toContain('launch next week');
    // The citation projection alone: no owner, status, check, due date, decision or tool words.
    for (const secret of ['Mina Patel', 'Pilot planning', '2026-10-30', 'still_open', 'checked_at', '"status"', '"owner"', f.outsideText, 'PLANNER-CANARY']) {
      expect(progress).not.toContain(secret);
    }
  });

  it('streams /v6 only for its own header value, and leaves /v5 streaming V1, which never names a follow-up', async () => {
    const f = await sentFixture();
    const planner = myOpenTasks();
    const base = await origin(f, planner.model);
    // A V1 client's header on /v6 gets the JSON V7 answer, never a V2 stream.
    for (const progress of [PERSON_ASK_PROGRESS_HEADER_VALUE_V1, '0', '22']) {
      planner.reset();
      const response = await ask(base, { progress });
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      validatePersonAnswerResponseV7(await response.json());
    }
    // /v5 with V2's value is JSON, and with its own streams V1: its desk binds no follow-ups, so none is searched or named.
    planner.reset();
    const v5Json = await ask(base, { path: PERSON_ANSWER_PATH_V5 });
    expect(v5Json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(validatePersonAnswerResponseV6(await v5Json.json()).citations).toEqual([]);
    planner.reset();
    const v5 = await ask(base, { path: PERSON_ANSWER_PATH_V5, progress: PERSON_ASK_PROGRESS_HEADER_VALUE_V1 });
    expect(v5.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(v5.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('5');
    const raw = await v5.text();
    const decoder = createPersonAskProgressDecoderV1();
    expect(decoder.push(raw).length).toBeGreaterThan(0);
    decoder.end();
    expect(raw).not.toContain('follow_up');
    // A failure before the stream starts is the ordinary JSON error, with the route header, so a client never falls back on it.
    const unauthenticated = await ask(base, { token: 'stranger' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(unauthenticated.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('6');
  });

  it('answers /v6 as unavailable, still route-matched, on an Authority composed without the V7 Ask', async () => {
    const f = await sentFixture();
    const base = await origin(f, myOpenTasks().model, { v6: false });
    const response = await ask(base);
    expect(response.status).toBe(503);
    expect(response.headers.get(PERSON_ANSWER_ROUTE_HEADER_V5)).toBe('6');
    await expect(response.json()).resolves.toEqual({ error: { code: 'unavailable', message: 'request failed' } });
  });
});
