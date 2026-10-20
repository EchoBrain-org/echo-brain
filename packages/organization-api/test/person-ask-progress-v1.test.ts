import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1,
  PERSON_ASK_PROGRESS_HEADER_V1,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V1,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V2,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  createPersonAskProgressDecoderV1,
  formatPersonAskProgressEventV1,
  validatePersonAskProgressStepEventV1,
  validatePersonAskReceiptV1,
  type PersonAskProgressEventV1,
} from '../src/index.js';

const record = canonicalSha256('record');
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync', visibility: 'team' as const, ref: `meeting:${record}` as const };
const ticket = { citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10048', permalink: 'https://example.atlassian.net/browse/THERM-48', text_sha256: canonicalSha256('THERM-48') }, kind: 'ticket' as const, label: 'THERM-48: Fan curve', visibility: 'only_me' as const };
const passage = (n: number) => ({ citation: { kind: 'source_revision' as const, source_id: `source:${n.toString(16).padStart(64, 'a')}`, revision_id: `rev-${n}`, source_sha256: canonicalSha256(`s${n}`), representation_sha256: canonicalSha256(`r${n}`), anchor_sha256: canonicalSha256(`a${n}`), document_id: `doc_${'b'.repeat(64)}` as const }, kind: 'document_passage' as const, label: `Spec part ${n}`, visibility: 'only_me' as const, ref: `document:doc_${'b'.repeat(64)}` as const });
const response = () => ({ schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [decision], parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] });
const receipt = () => ({ looked_through: 3, elapsed_ms: 48_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 22 }, { type: 'read' as const, items: [decision, ticket] }] });
/** Any value as the formatter's argument, which it checks. */
const asEvent = (value: unknown) => value as PersonAskProgressEventV1;

describe('Ask progress V1 wire contract', () => {
  it("pins the opt-in header, each version's value, the media type and the heartbeat", () => {
    expect({
      header: PERSON_ASK_PROGRESS_HEADER_V1, values: [PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2, PERSON_ASK_PROGRESS_HEADER_VALUE_V3],
      content_type: PERSON_ASK_PROGRESS_CONTENT_TYPE_V1, heartbeat: PERSON_ASK_PROGRESS_HEARTBEAT_V1,
    }).toEqual({ header: 'x-echo-ask-progress', values: ['1', '2', '3'], content_type: 'text/event-stream', heartbeat: ': keep-alive\n\n' });
  });

  it('accepts each step event exactly and freezes it', () => {
    const stage = validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'reading', pending: 3 });
    expect(stage).toEqual({ type: 'stage', stage: 'reading', pending: 3 });
    expect(Object.isFrozen(stage)).toBe(true);
    for (const value of ['searching', 'reading', 'checking_access', 'writing']) expect(validatePersonAskProgressStepEventV1({ type: 'stage', stage: value }).type).toBe('stage');
    expect(validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'documents' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 })).toEqual({ type: 'searched', sources: [{ kind: 'documents' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 });
    expect(validatePersonAskProgressStepEventV1({ type: 'read', items: [decision, ticket, passage(1)] }).type).toBe('read');
  });

  it('keeps the atom id and open ref a client needs to focus an item', () => {
    const event = validatePersonAskProgressStepEventV1({ type: 'read', items: [decision] });
    expect(event).toEqual({ type: 'read', items: [decision] });
  });

  it('rejects a reading count on any other stage, a zero count and unknown stages', () => {
    expect(() => validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'writing', pending: 2 })).toThrow('pending applies only to reading');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'reading', pending: 0 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'planning' })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'round', round: 2 })).toThrow('type is invalid');
  });

  it('never carries notes, queries, bodies, short ids, rounds or tool internals', () => {
    expect(() => validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'searching', round: 2 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'stage', stage: 'searching', notes: 'Mara owns THERM-48' })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'jira' }], found: 4, query: 'fan curve' })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'jira', jql: 'project = THERM' }], found: 4 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [{ ...decision, text: 'The body' }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [{ ...decision, id: 'E5' }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [decision], needs: ['N1'] })).toThrow('unexpected shape');
  });

  it('rejects malformed sources, a hidden-count shape and duplicate names', () => {
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'meetings' }], found: 1 })).toThrow('duplicates');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'tickets' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'meetings', tool_id: 'jira' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'Jira' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'meetings' }], found: -1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'meetings' }], found: 1.5 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'searched', sources: [{ kind: 'meetings' }], found: 1, hidden: 3 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [] })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [decision, decision] })).toThrow('names an item twice');
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: Array.from({ length: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 + 1 }, (_, n) => passage(n)) })).toThrow();
    expect(() => validatePersonAskProgressStepEventV1({ type: 'read', items: [{ ...decision, ref: `meeting:${canonicalSha256('other')}` }] })).toThrow('ref is inconsistent');
  });

  it('checks the receipt: merged rows, items once, and a count that covers them', () => {
    expect(validatePersonAskReceiptV1(receipt())).toEqual(receipt());
    expect(validatePersonAskReceiptV1({ looked_through: 0, elapsed_ms: 0, rows: [] }).rows).toEqual([]);
    expect(() => validatePersonAskReceiptV1({ ...receipt(), rows: [{ type: 'read', items: [decision] }, { type: 'read', items: [ticket] }] })).toThrow('not merged');
    expect(() => validatePersonAskReceiptV1({ ...receipt(), rows: [{ type: 'read', items: [decision] }, receipt().rows[0], { type: 'read', items: [decision] }] })).toThrow('names an item twice');
    expect(() => validatePersonAskReceiptV1({ ...receipt(), looked_through: 1 })).toThrow('less than the items');
    expect(() => validatePersonAskReceiptV1({ ...receipt(), elapsed_ms: -1 })).toThrow();
    expect(() => validatePersonAskReceiptV1({ ...receipt(), elapsed_ms: 300_001 })).toThrow();
    expect(() => validatePersonAskReceiptV1({ ...receipt(), items: [] })).toThrow('unexpected shape');
    // A merged read row may hold more than one event's items, up to the named bound.
    const many = Array.from({ length: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 + 5 }, (_, n) => passage(n));
    expect(validatePersonAskReceiptV1({ looked_through: many.length, elapsed_ms: 1, rows: [{ type: 'read', items: many }] }).rows[0]).toEqual({ type: 'read', items: many });
    const tooMany = Array.from({ length: PERSON_ASK_PROGRESS_NAMED_MAX_V1 + 1 }, (_, n) => passage(n));
    expect(() => validatePersonAskReceiptV1({ looked_through: tooMany.length, elapsed_ms: 1, rows: [{ type: 'read', items: tooMany }] })).toThrow();
  });

  it('carries the answer with its receipt beside it, never without one or inside it', () => {
    expect(() => formatPersonAskProgressEventV1(asEvent({ type: 'answer', response: response() }))).toThrow('unexpected shape');
    expect(() => formatPersonAskProgressEventV1(asEvent({ type: 'answer', response: { ...response(), receipt: receipt() }, receipt: receipt() }))).toThrow();
  });

  it('carries an error after the stream started with the status the JSON response would have had', () => {
    const error = { type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } } as const;
    expect(createPersonAskProgressDecoderV1().push(formatPersonAskProgressEventV1(error))).toEqual([error]);
    expect(() => formatPersonAskProgressEventV1(asEvent({ ...error, status: 200 }))).toThrow('status');
    expect(() => formatPersonAskProgressEventV1(asEvent({ ...error, error: { ...error.error, detail: 'x' } }))).toThrow();
    expect(() => formatPersonAskProgressEventV1(asEvent({ ...error, receipt: receipt() }))).toThrow('unexpected shape');
  });
});

describe('Ask progress V1 stream framing', () => {
  const events: readonly PersonAskProgressEventV1[] = [
    { type: 'stage', stage: 'searching' },
    { type: 'searched', sources: [{ kind: 'meetings' }], found: 6 },
    { type: 'stage', stage: 'reading', pending: 1 },
    { type: 'read', items: [decision] },
    { type: 'stage', stage: 'writing' },
    { type: 'answer', response: response(), receipt: receipt() },
  ];
  const stream = events.map((event, index) => `${index === 2 ? PERSON_ASK_PROGRESS_HEARTBEAT_V1 : ''}${formatPersonAskProgressEventV1(event)}`).join('');

  it('writes each event as one data line and reads it back across any chunking', () => {
    for (const event of events) {
      const frame = formatPersonAskProgressEventV1(event);
      expect(frame.startsWith('data: ')).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      expect(frame.slice(0, -2).includes('\n')).toBe(false);
    }
    for (const size of [1, 7, 64, stream.length]) {
      const decoder = createPersonAskProgressDecoderV1();
      const read: PersonAskProgressEventV1[] = [];
      for (let at = 0; at < stream.length; at += size) read.push(...decoder.push(stream.slice(at, at + size)));
      decoder.end();
      expect(read).toEqual(events);
    }
  });

  it('refuses to format an event that breaks the contract', () => {
    expect(() => formatPersonAskProgressEventV1({ type: 'stage', stage: 'searching', notes: 'x' } as unknown as PersonAskProgressEventV1)).toThrow();
  });

  it('fails closed on a stream without its result, or with anything after it', () => {
    const open = createPersonAskProgressDecoderV1();
    open.push(formatPersonAskProgressEventV1({ type: 'stage', stage: 'searching' }));
    expect(() => open.end()).toThrow('without its result');
    const cut = createPersonAskProgressDecoderV1();
    cut.push(`${formatPersonAskProgressEventV1({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'request failed' } })}data: {`);
    expect(() => cut.end()).toThrow();
    const after = createPersonAskProgressDecoderV1();
    expect(() => after.push(`${stream}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}`)).toThrow('after its result');
    const late = createPersonAskProgressDecoderV1();
    expect(() => late.push(`${stream}${formatPersonAskProgressEventV1({ type: 'stage', stage: 'writing' })}`)).toThrow('after its result');
  });

  it('rejects other SSE fields, a second data line, carriage returns, non-JSON and over-long lines', () => {
    expect(() => createPersonAskProgressDecoderV1().push('event: stage\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV1().push('id: 1\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV1().push('data: {"type":"stage","stage":"searching"}\ndata: {}\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV1().push('data: {"type":"stage","stage":"searching"}\r\n\r\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV1().push('data: not json\n\n')).toThrow('not JSON');
    expect(() => createPersonAskProgressDecoderV1().push('data: {"type":"stage","stage":"thinking"}\n\n')).toThrow();
    expect(() => createPersonAskProgressDecoderV1().push(`data: "${'x'.repeat(PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1)}`)).toThrow('exceeds its bound');
  });
});
