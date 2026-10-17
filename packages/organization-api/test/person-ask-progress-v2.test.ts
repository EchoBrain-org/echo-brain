import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_PROGRESS_HEADER_VALUE_V1,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V2,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  createPersonAskProgressDecoderV1,
  createPersonAskProgressDecoderV2,
  formatPersonAskProgressEventV1,
  formatPersonAskProgressEventV2,
  validatePersonAskProgressEventV1,
  validatePersonAskProgressEventV2,
  validatePersonAskProgressLineV1,
  validatePersonAskProgressLineV2,
  validatePersonAskProgressResultLineV1,
  validatePersonAskProgressResultLineV2,
  validatePersonAskProgressStepEventV1,
  validatePersonAskProgressStepEventV2,
  validatePersonAskReceiptV1,
  validatePersonAskReceiptV2,
  type PersonAskProgressEventV2,
} from '../src/index.js';

const record = canonicalSha256('record');
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync', visibility: 'team' as const, ref: `meeting:${record}` as const };
const followUp = { citation: { kind: 'follow_up' as const, item_id: 'itm_launch-1' }, kind: 'follow_up' as const, label: 'Ship the launch checklist', visibility: 'team' as const, ref: 'follow_up:itm_launch-1' as const };
const v7 = () => ({ schema_version: 7 as const, kind: 'echo-clean-person-answer-v7' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [followUp, decision],
  parts: [{ question: 'What is still open?', status: 'answered' as const, statements: [{ text: 'The launch checklist is still open.', citation_indexes: [0], private: false }] }] });
const v6 = () => ({ ...v7(), schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, citations: [decision],
  parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] });
const receipt = () => ({ looked_through: 2, elapsed_ms: 31_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'follow_ups' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 9 },
  { type: 'read' as const, items: [followUp, decision] }] });
const v1Receipt = () => ({ looked_through: 1, elapsed_ms: 12_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }], found: 4 }, { type: 'read' as const, items: [decision] }] });

describe('Ask progress V2 wire contract (/v6, ADR-0040)', () => {
  it('opts in with its own header value, beside V1', () => {
    expect(PERSON_ASK_PROGRESS_HEADER_VALUE_V2).toBe('2');
    expect(PERSON_ASK_PROGRESS_HEADER_VALUE_V2).not.toBe(PERSON_ASK_PROGRESS_HEADER_VALUE_V1);
  });

  it('names follow-ups as a searched source kind, with no tool id', () => {
    const searched = { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'follow_ups' }, { kind: 'tickets', tool_id: 'jira' }], found: 9 };
    expect(validatePersonAskProgressStepEventV2(searched)).toEqual(searched);
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups', tool_id: 'jira' }], found: 1 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups' }, { kind: 'follow_ups' }], found: 1 })).toThrow('duplicates');
    // A V1 client never meets one.
    expect(() => validatePersonAskProgressStepEventV1(searched)).toThrow('kind is invalid');
  });

  it('names a follow-up read as its V7 citation, with the ref that opens its item page', () => {
    const event = validatePersonAskProgressStepEventV2({ type: 'read', items: [followUp, decision] });
    expect(event).toEqual({ type: 'read', items: [followUp, decision] });
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, ref: undefined }] })).toThrow();
    const { ref: _ref, ...unopened } = followUp;
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [unopened] })).toThrow('ref is missing');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, ref: 'follow_up:itm_other-1' }] })).toThrow('ref is inconsistent');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, kind: 'decision' }] })).toThrow();
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [followUp, followUp] })).toThrow('names an item twice');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [followUp] })).toThrow();
  });

  it('keeps every V1 rule: exact keys, stages, counts and no content', () => {
    expect(() => validatePersonAskProgressStepEventV2({ type: 'stage', stage: 'writing', pending: 2 })).toThrow('pending applies only to reading');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'stage', stage: 'planning' })).toThrow();
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, text: 'Owner: Mara' }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [{ ...followUp, citation: { ...followUp.citation, owner: 'Mara' } }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 1, query: 'my open tasks' })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV2({ type: 'searched', sources: [{ kind: 'follow_ups' }], found: -1 })).toThrow();
  });

  it('accepts every V1 step and receipt as V2, so a /v5 stream reads as V2', () => {
    for (const step of [{ type: 'stage', stage: 'reading', pending: 2 }, { type: 'searched', sources: [{ kind: 'documents' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 }, { type: 'read', items: [decision] }]) {
      expect(validatePersonAskProgressStepEventV2(step)).toEqual(validatePersonAskProgressStepEventV1(step));
    }
    expect(validatePersonAskReceiptV2(v1Receipt())).toEqual(validatePersonAskReceiptV1(v1Receipt()));
  });

  it('builds a receipt whose rows may name follow-ups, with V1 merge and coverage rules', () => {
    expect(validatePersonAskReceiptV2(receipt())).toEqual(receipt());
    expect(() => validatePersonAskReceiptV1(receipt())).toThrow();
    expect(() => validatePersonAskReceiptV2({ ...receipt(), looked_through: 1 })).toThrow('less than the items');
    expect(() => validatePersonAskReceiptV2({ ...receipt(), rows: [{ type: 'read', items: [followUp] }, { type: 'read', items: [decision] }] })).toThrow('not merged');
    expect(() => validatePersonAskReceiptV2({ ...receipt(), rows: [{ type: 'read', items: [followUp] }, receipt().rows[0], { type: 'read', items: [followUp] }] })).toThrow('names an item twice');
  });

  it('carries the released V7 answer as the terminal event, and only V7', () => {
    expect(validatePersonAskProgressEventV2({ type: 'answer', response: v7(), receipt: receipt() })).toEqual({ type: 'answer', response: v7(), receipt: receipt() });
    expect(() => validatePersonAskProgressEventV2({ type: 'answer', response: v6(), receipt: v1Receipt() })).toThrow();
    expect(() => validatePersonAskProgressEventV1({ type: 'answer', response: v7(), receipt: v1Receipt() })).toThrow();
    expect(validatePersonAskProgressEventV2({ type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } }).type).toBe('error');
    expect(() => validatePersonAskProgressEventV2({ type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' }, receipt: receipt() })).toThrow('unexpected shape');
  });
});

describe('Ask progress V2 stream framing', () => {
  const events: readonly PersonAskProgressEventV2[] = [
    { type: 'stage', stage: 'searching' },
    { type: 'searched', sources: [{ kind: 'follow_ups' }], found: 3 },
    { type: 'stage', stage: 'reading', pending: 1 },
    { type: 'read', items: [followUp] },
    { type: 'stage', stage: 'writing' },
    { type: 'answer', response: v7(), receipt: receipt() },
  ];
  const stream = events.map((event, index) => `${index === 2 ? PERSON_ASK_PROGRESS_HEARTBEAT_V1 : ''}${formatPersonAskProgressEventV2(event)}`).join('');

  it('frames and decodes exactly as V1, across any chunking', () => {
    for (const size of [1, 13, stream.length]) {
      const decoder = createPersonAskProgressDecoderV2();
      const read: PersonAskProgressEventV2[] = [];
      for (let at = 0; at < stream.length; at += size) read.push(...decoder.push(stream.slice(at, at + size)));
      decoder.end();
      expect(read).toEqual(events);
    }
    // A V1 decoder refuses a follow-up stream; a V2 decoder reads a V1 stream's steps.
    expect(() => createPersonAskProgressDecoderV1().push(stream)).toThrow();
    expect(createPersonAskProgressDecoderV2().push(formatPersonAskProgressEventV1({ type: 'read', items: [decision] }))).toEqual([{ type: 'read', items: [decision] }]);
  });

  it('fails closed after its result, and refuses to format an event that breaks the contract', () => {
    expect(() => createPersonAskProgressDecoderV2().push(`${stream}${formatPersonAskProgressEventV2({ type: 'stage', stage: 'writing' })}`)).toThrow('after its result');
    const open = createPersonAskProgressDecoderV2();
    open.push(formatPersonAskProgressEventV2({ type: 'stage', stage: 'searching' }));
    expect(() => open.end()).toThrow('without its result');
    expect(() => formatPersonAskProgressEventV2({ type: 'read', items: [{ ...followUp, owner: 'Mara' }] } as unknown as PersonAskProgressEventV2)).toThrow();
  });
});

describe('person ask --progress lines from a /v6 client', () => {
  it('prints V2 steps, which include every V1 step', () => {
    expect(validatePersonAskProgressLineV2({ ok: true, progress: { type: 'read', items: [followUp] } })).toEqual({ ok: true, progress: { type: 'read', items: [followUp] } });
    expect(validatePersonAskProgressLineV2({ ok: true, progress: { type: 'searched', sources: [{ kind: 'meetings' }], found: 1 } }).progress.type).toBe('searched');
    expect(() => validatePersonAskProgressLineV1({ ok: true, progress: { type: 'read', items: [followUp] } })).toThrow();
    expect(() => validatePersonAskProgressLineV2({ ok: true, progress: { type: 'answer', response: v7(), receipt: receipt() } })).toThrow();
  });

  it('pairs each streamed answer with its own receipt: V7 with V2, V6 with V1, and none for V5', () => {
    expect(validatePersonAskProgressResultLineV2({ ok: true, result: v7(), receipt: receipt() })).toEqual({ ok: true, result: v7(), receipt: receipt() });
    expect(validatePersonAskProgressResultLineV2({ ok: true, result: v7() })).toEqual({ ok: true, result: v7() });
    expect(validatePersonAskProgressResultLineV2({ ok: true, result: v6(), receipt: v1Receipt() })).toEqual({ ok: true, result: v6(), receipt: v1Receipt() });
    // A V6 answer from /v5 never has a follow-up in its receipt.
    expect(() => validatePersonAskProgressResultLineV2({ ok: true, result: v6(), receipt: receipt() })).toThrow();
    const v5 = { ...v6(), schema_version: 5 as const, kind: 'echo-clean-person-answer-v5' as const };
    expect(validatePersonAskProgressResultLineV2({ ok: true, result: v5 }).result.schema_version).toBe(5);
    expect(() => validatePersonAskProgressResultLineV2({ ok: true, result: v5, receipt: v1Receipt() })).toThrow('needs a streamed answer');
    // V1's final line never carries a V7 answer.
    expect(() => validatePersonAskProgressResultLineV1({ ok: true, result: v7(), receipt: receipt() })).toThrow();
  });
});
