import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import {
  PERSON_ANSWER_PATH_V6, PERSON_ANSWER_ROUTE_HEADER_V5, PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2,
  createPersonAskProgressDecoderV2, validatePersonAnswerResponseV7,
} from '@echo-brain/organization-api';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createPersonLiveAnswerRouteV1 } from '../src/composition/person-live-answer-route-v1.js';
import { askClient, auditBodies, closeAskServers, decodeAll, expectAskRouteUnavailable, expectJsonAskFallbacks, liveAskOptions, myOpenTasksPlanner, serveAsk } from './fixtures/ask-over-http.js';
import { sentFixture, type OpenItemsFixtureV1 } from './fixtures/open-items.js';

/**
 * The V7 Ask over HTTP (ADR-0039, ADR-0040): `POST /v6/person/ask` behind the
 * real server, over the real open-items Authority state, streamed as Ask
 * progress V2 exactly as `/v5` streams V1. "What are my open tasks?" lists the
 * asker's follow-ups, reads one, and cites it: its name reaches the stream
 * only after the access check before the call that reads it, and its owner,
 * decision and check never do.
 */

afterEach(closeAskServers);

/** The `/v5` and `/v6` routes as the runtime composes them. */
function origin(f: OpenItemsFixtureV1, model: StructuredGenerationPort, mount: { readonly v6?: boolean } = {}) {
  const options = liveAskOptions(f, model);
  return serveAsk({ person_answer_v5: createPersonLiveAnswerRouteV1(options, 6), ...(mount.v6 === false ? {} : { person_answer_v6: createPersonLiveAnswerRouteV1(options, 7) }) });
}
const ask = askClient({ path: PERSON_ANSWER_PATH_V6, progress: PERSON_ASK_PROGRESS_HEADER_VALUE_V2, question: 'What are my open tasks?' });
const decode = (text: string) => decodeAll(createPersonAskProgressDecoderV2(), text);
const askAudits = (f: OpenItemsFixtureV1) => auditBodies(f, 'echo-person-agentic-ask-audit-v1');

describe('the V7 Ask streamed on /v6 (ADR-0039, ADR-0040)', () => {
  it('streams progress V2: searches name follow-ups, the follow-up it read is named and cited, and the receipt lists it', async () => {
    const f = await sentFixture();
    const planner = myOpenTasksPlanner();
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
    const planner = myOpenTasksPlanner();
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

  it('streams /v6 only for its own header value: a V1 client gets the JSON V7 answer, never a V2 stream', async () => {
    const planner = myOpenTasksPlanner();
    const base = await origin(await sentFixture(), planner.model);
    await expectJsonAskFallbacks(ask, base, { header: '6', others: [PERSON_ASK_PROGRESS_HEADER_VALUE_V1, '0', '22'], validate: validatePersonAnswerResponseV7, reset: planner.reset });
  });

  it('answers /v6 as unavailable, still route-matched, on an Authority composed without the V7 Ask', async () => {
    await expectAskRouteUnavailable(ask, await origin(await sentFixture(), myOpenTasksPlanner().model, { v6: false }), '6');
  });
});
