import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1,
  PERSON_ASK_PROGRESS_HEADER_V1,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  PERSON_ASK_PROGRESS_HEARTBEAT_V1,
  PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1,
  PERSON_ASK_PROGRESS_NAMED_MAX_V1,
  PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V3,
  createPersonAskProgressDecoderV3,
  formatPersonAskProgressEventV3,
  validatePersonAskProgressLineV3,
  validatePersonAskProgressResultLineV3,
  validatePersonAskProgressStepEventV3,
  validatePersonAskReceiptV3,
  type PersonAskProgressEventV3,
} from '../src/index.js';

const record = canonicalSha256('record');
const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' as const;
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync', visibility: 'team' as const, ref: `meeting:${record}` as const };
const ticket = { citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10048', permalink: 'https://example.atlassian.net/browse/THERM-48', text_sha256: canonicalSha256('THERM-48') }, kind: 'ticket' as const, label: 'THERM-48: Fan curve', visibility: 'only_me' as const };
const passage = (n: number) => ({ citation: { kind: 'source_revision' as const, source_id: `source:${n.toString(16).padStart(64, 'a')}`, revision_id: `rev-${n}`, source_sha256: canonicalSha256(`s${n}`), representation_sha256: canonicalSha256(`r${n}`), anchor_sha256: canonicalSha256(`a${n}`), document_id: `doc_${'b'.repeat(64)}` as const }, kind: 'document_passage' as const, label: `Spec part ${n}`, visibility: 'only_me' as const, ref: `document:doc_${'b'.repeat(64)}` as const });
const followUp = { citation: { kind: 'follow_up' as const, item_id: 'itm_launch-1' }, kind: 'follow_up' as const, label: 'Ship the launch checklist', visibility: 'team' as const, ref: 'follow_up:itm_launch-1' as const };
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const person = { citation: { kind: 'person' as const, membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' }, kind: 'person' as const, label: 'Mara Lind', visibility: 'team' as const };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' }, kind: 'tool' as const, label: 'Jira', visibility: 'only_me' as const, ref: 'tool:jira' as const };
const container = {
  citation: { kind: 'tool_container' as const, tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project' as const, container_id: '10001', permalink: 'https://example.atlassian.net/browse/THERM' },
  kind: 'tool_container' as const, label: 'Thermal', visibility: 'only_me' as const, key: 'THERM',
};
const workspace = [project, person, tool, container];
const sources = [{ kind: 'projects' as const }, { kind: 'people' as const }, { kind: 'tools' as const }, { kind: 'containers' as const, tool_id: 'jira' }];
const v8 = () => ({ schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [project, container],
  parts: [{ question: 'Where is the Jira project for Thermal recovery?', status: 'answered' as const, statements: [{ text: 'Thermal recovery uses the THERM Jira project.', citation_indexes: [0, 1], private: true }] }] });
const decided = () => ({ ...v8(), citations: [decision],
  parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] });
const receipt = () => ({ looked_through: 4, elapsed_ms: 31_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, ...sources], found: 9 },
  { type: 'read' as const, items: [...workspace] }] });
const decidedReceipt = () => ({ looked_through: 3, elapsed_ms: 48_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, { kind: 'tickets' as const, tool_id: 'jira' }], found: 22 }, { type: 'read' as const, items: [decision, ticket] }] });
/** Any value as the formatter's argument, which it checks. */
const asEvent = (value: unknown) => value as PersonAskProgressEventV3;

describe('Ask progress V3 wire contract (/v7, ADR-0039, research tool contract v1)', () => {
  it('pins the opt-in header, its value, the media type and the heartbeat', () => {
    expect({ header: PERSON_ASK_PROGRESS_HEADER_V1, value: PERSON_ASK_PROGRESS_HEADER_VALUE_V3, content_type: PERSON_ASK_PROGRESS_CONTENT_TYPE_V1, heartbeat: PERSON_ASK_PROGRESS_HEARTBEAT_V1 })
      .toEqual({ header: 'x-echo-ask-progress', value: '3', content_type: 'text/event-stream', heartbeat: ': keep-alive\n\n' });
  });

  it('accepts each step event exactly and freezes it', () => {
    const stage = validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'reading', pending: 3 });
    expect(stage).toEqual({ type: 'stage', stage: 'reading', pending: 3 });
    expect(Object.isFrozen(stage)).toBe(true);
    for (const value of ['searching', 'reading', 'checking_access', 'writing']) expect(validatePersonAskProgressStepEventV3({ type: 'stage', stage: value }).type).toBe('stage');
    expect(validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'documents' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 })).toEqual({ type: 'searched', sources: [{ kind: 'documents' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 });
    expect(validatePersonAskProgressStepEventV3({ type: 'read', items: [decision, ticket, passage(1)] }).type).toBe('read');
  });

  it('keeps the atom id and open ref a client needs to focus an item', () => {
    expect(validatePersonAskProgressStepEventV3({ type: 'read', items: [decision] })).toEqual({ type: 'read', items: [decision] });
  });

  it('rejects a reading count on any other stage, a zero count and unknown stages', () => {
    expect(() => validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'writing', pending: 2 })).toThrow('pending applies only to reading');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'reading', pending: 0 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'planning' })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'round', round: 2 })).toThrow('type is invalid');
  });

  it('never carries notes, queries, bodies, short ids, rounds or tool internals', () => {
    expect(() => validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'searching', round: 2 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'stage', stage: 'searching', notes: 'Mara owns THERM-48' })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'jira' }], found: 4, query: 'fan curve' })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'jira', jql: 'project = THERM' }], found: 4 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...decision, text: 'The body' }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...decision, id: 'E5' }] })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [decision], needs: ['N1'] })).toThrow('unexpected shape');
  });

  it('rejects malformed sources, a hidden-count shape and duplicate names', () => {
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'meetings' }], found: 1 })).toThrow('duplicates');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'tickets' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'meetings', tool_id: 'jira' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'tickets', tool_id: 'Jira' }], found: 1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'meetings' }], found: -1 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'meetings' }], found: 1.5 })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'meetings' }], found: 1, hidden: 3 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [] })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [decision, decision] })).toThrow('names an item twice');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: Array.from({ length: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 + 1 }, (_, n) => passage(n)) })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...decision, ref: `meeting:${canonicalSha256('other')}` }] })).toThrow('ref is inconsistent');
  });

  it('names follow-ups as a searched source kind, with no tool id (ADR-0040)', () => {
    const searched = { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'follow_ups' }, { kind: 'tickets', tool_id: 'jira' }], found: 9 };
    expect(validatePersonAskProgressStepEventV3(searched)).toEqual(searched);
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'follow_ups', tool_id: 'jira' }], found: 1 })).toThrow('unexpected shape');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'follow_ups' }, { kind: 'follow_ups' }], found: 1 })).toThrow('duplicates');
  });

  it('names a follow-up read as its citation, with the ref that opens its item page (ADR-0040)', () => {
    const event = validatePersonAskProgressStepEventV3({ type: 'read', items: [followUp, decision] });
    expect(event).toEqual({ type: 'read', items: [followUp, decision] });
    const { ref: _ref, ...unopened } = followUp;
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [unopened] })).toThrow('ref is missing');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...followUp, ref: 'follow_up:itm_other-1' }] })).toThrow('ref is inconsistent');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...followUp, kind: 'decision' }] })).toThrow();
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [followUp, followUp] })).toThrow('names an item twice');
  });

  it('names the workspace as plain source kinds, and a tool’s containers by its id', () => {
    const searched = { type: 'searched', sources: [{ kind: 'follow_ups' }, ...sources, { kind: 'tickets', tool_id: 'jira' }], found: 9 };
    expect(validatePersonAskProgressStepEventV3(searched)).toEqual(searched);
    for (const bad of [{ kind: 'projects', tool_id: 'jira' }, { kind: 'containers' }, { kind: 'containers', tool_id: 'Jira' }, { kind: 'channels', tool_id: 'slack' }, { kind: 'workspace' }]) {
      expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [bad], found: 1 })).toThrow();
    }
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'containers', tool_id: 'jira' }, { kind: 'containers', tool_id: 'jira' }], found: 1 })).toThrow('duplicates');
  });

  it('names up to sixteen sources in one row', () => {
    expect(PERSON_ASK_PROGRESS_SOURCES_MAX_V3).toBe(16);
    const many = ['jira', 'confluence', 'github', 'linear', 'notion'].flatMap(tool_id => [{ kind: 'containers', tool_id }, { kind: 'tickets', tool_id }]);
    const sixteen = [{ kind: 'meetings' }, { kind: 'documents' }, { kind: 'follow_ups' }, { kind: 'projects' }, { kind: 'people' }, { kind: 'tools' }, ...many];
    expect(sixteen).toHaveLength(16);
    expect(validatePersonAskProgressStepEventV3({ type: 'searched', sources: sixteen, found: 3 }).type).toBe('searched');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [...sixteen, { kind: 'pages', tool_id: 'confluence' }], found: 3 })).toThrow('sources is invalid');
  });

  it('names a workspace item read as its V8 citation: a project and a tool with their refs, a container with its key', () => {
    const event = validatePersonAskProgressStepEventV3({ type: 'read', items: workspace });
    expect(event).toEqual({ type: 'read', items: workspace });
    expect(Object.isFrozen(event)).toBe(true);
    const { ref: _ref, ...unopened } = project;
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [unopened] })).toThrow('ref is missing');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...person, ref: `project:${projectId}` }] })).toThrow('ref is inconsistent');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...tool, key: 'JIRA' }] })).toThrow('only to a tool container');
    // An item is named once, whatever its label or key.
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [container, { ...container, key: 'TH' }] })).toThrow('names an item twice');
    for (const item of workspace) expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...item, text: 'Lead: Mara' }] })).toThrow('unexpected shape');
  });

  it('checks the receipt: merged rows, items once, and a count that covers them', () => {
    expect(validatePersonAskReceiptV3(receipt())).toEqual(receipt());
    expect(validatePersonAskReceiptV3(decidedReceipt())).toEqual(decidedReceipt());
    expect(validatePersonAskReceiptV3({ looked_through: 0, elapsed_ms: 0, rows: [] }).rows).toEqual([]);
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), rows: [{ type: 'read', items: [decision] }, { type: 'read', items: [ticket] }] })).toThrow('not merged');
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), rows: [{ type: 'read', items: [decision] }, decidedReceipt().rows[0], { type: 'read', items: [decision] }] })).toThrow('names an item twice');
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), looked_through: 1 })).toThrow('less than the items');
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), elapsed_ms: -1 })).toThrow();
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), elapsed_ms: 300_001 })).toThrow();
    expect(() => validatePersonAskReceiptV3({ ...decidedReceipt(), items: [] })).toThrow('unexpected shape');
    // A merged read row may hold more than one event's items, up to the named bound.
    const many = Array.from({ length: PERSON_ASK_PROGRESS_READ_ITEMS_MAX_V1 + 5 }, (_, n) => passage(n));
    expect(validatePersonAskReceiptV3({ looked_through: many.length, elapsed_ms: 1, rows: [{ type: 'read', items: many }] }).rows[0]).toEqual({ type: 'read', items: many });
    const tooMany = Array.from({ length: PERSON_ASK_PROGRESS_NAMED_MAX_V1 + 1 }, (_, n) => passage(n));
    expect(() => validatePersonAskReceiptV3({ looked_through: tooMany.length, elapsed_ms: 1, rows: [{ type: 'read', items: tooMany }] })).toThrow();
    // Its rows may name follow-ups too.
    expect(validatePersonAskReceiptV3({ looked_through: 1, elapsed_ms: 12_000, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 4 }, { type: 'read', items: [followUp] }] }).rows).toHaveLength(2);
  });

  it('carries the V8 answer with its receipt beside it, never without one or inside it, and no other answer', () => {
    expect(createPersonAskProgressDecoderV3().push(formatPersonAskProgressEventV3({ type: 'answer', response: decided(), receipt: decidedReceipt() })))
      .toEqual([{ type: 'answer', response: decided(), receipt: decidedReceipt() }]);
    expect(() => formatPersonAskProgressEventV3(asEvent({ type: 'answer', response: decided() }))).toThrow('unexpected shape');
    expect(() => formatPersonAskProgressEventV3(asEvent({ type: 'answer', response: { ...decided(), receipt: decidedReceipt() }, receipt: decidedReceipt() }))).toThrow();
    for (const version of [5, 6, 7]) {
      const frame = `data: ${JSON.stringify({ type: 'answer', response: { ...decided(), schema_version: version, kind: `echo-clean-person-answer-v${version}` }, receipt: decidedReceipt() })}\n\n`;
      expect(() => createPersonAskProgressDecoderV3().push(frame)).toThrow();
    }
  });

  it('carries an error after the stream started with the status the JSON response would have had', () => {
    const error = { type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } } as const;
    expect(createPersonAskProgressDecoderV3().push(formatPersonAskProgressEventV3(error))).toEqual([error]);
    expect(() => formatPersonAskProgressEventV3(asEvent({ ...error, status: 200 }))).toThrow('status');
    expect(() => formatPersonAskProgressEventV3(asEvent({ ...error, error: { ...error.error, detail: 'x' } }))).toThrow();
    expect(() => formatPersonAskProgressEventV3(asEvent({ ...error, receipt: decidedReceipt() }))).toThrow('unexpected shape');
  });
});

describe('Ask progress V3 stream framing', () => {
  const events: readonly PersonAskProgressEventV3[] = [
    { type: 'stage', stage: 'searching' },
    { type: 'searched', sources, found: 3 },
    { type: 'stage', stage: 'reading', pending: 2 },
    { type: 'read', items: [project, container] },
    { type: 'stage', stage: 'writing' },
    { type: 'answer', response: v8(), receipt: { looked_through: 2, elapsed_ms: 20_000, rows: [{ type: 'searched', sources, found: 3 }, { type: 'read', items: [project, container] }] } },
  ];
  const stream = events.map((event, index) => `${index === 2 ? PERSON_ASK_PROGRESS_HEARTBEAT_V1 : ''}${formatPersonAskProgressEventV3(event)}`).join('');

  it('writes each event as one data line and reads it back across any chunking', () => {
    for (const event of events) {
      const frame = formatPersonAskProgressEventV3(event);
      expect(frame.startsWith('data: ')).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      expect(frame.slice(0, -2).includes('\n')).toBe(false);
    }
    for (const size of [1, 7, 64, stream.length]) {
      const decoder = createPersonAskProgressDecoderV3();
      const read: PersonAskProgressEventV3[] = [];
      for (let at = 0; at < stream.length; at += size) read.push(...decoder.push(stream.slice(at, at + size)));
      decoder.end();
      expect(read).toEqual(events);
    }
  });

  it('refuses to format an event that breaks the contract', () => {
    expect(() => formatPersonAskProgressEventV3({ type: 'stage', stage: 'searching', notes: 'x' } as unknown as PersonAskProgressEventV3)).toThrow();
    expect(() => formatPersonAskProgressEventV3({ type: 'read', items: [{ ...project, lead: 'Mara' }] } as unknown as PersonAskProgressEventV3)).toThrow();
  });

  it('fails closed on a stream without its result, or with anything after it', () => {
    const open = createPersonAskProgressDecoderV3();
    open.push(formatPersonAskProgressEventV3({ type: 'stage', stage: 'searching' }));
    expect(() => open.end()).toThrow('without its result');
    const cut = createPersonAskProgressDecoderV3();
    cut.push(`${formatPersonAskProgressEventV3({ type: 'error', status: 401, error: { code: 'unauthorized', message: 'request failed' } })}data: {`);
    expect(() => cut.end()).toThrow();
    const after = createPersonAskProgressDecoderV3();
    expect(() => after.push(`${stream}${PERSON_ASK_PROGRESS_HEARTBEAT_V1}`)).toThrow('after its result');
    const late = createPersonAskProgressDecoderV3();
    expect(() => late.push(`${stream}${formatPersonAskProgressEventV3({ type: 'stage', stage: 'writing' })}`)).toThrow('after its result');
  });

  it('rejects other SSE fields, a second data line, carriage returns, non-JSON and over-long lines', () => {
    expect(() => createPersonAskProgressDecoderV3().push('event: stage\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV3().push('id: 1\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV3().push('data: {"type":"stage","stage":"searching"}\ndata: {}\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV3().push('data: {"type":"stage","stage":"searching"}\r\n\r\n')).toThrow('line is invalid');
    expect(() => createPersonAskProgressDecoderV3().push('data: not json\n\n')).toThrow('not JSON');
    expect(() => createPersonAskProgressDecoderV3().push('data: {"type":"stage","stage":"thinking"}\n\n')).toThrow();
    expect(() => createPersonAskProgressDecoderV3().push(`data: "${'x'.repeat(PERSON_ASK_PROGRESS_LINE_MAX_CHARS_V1)}`)).toThrow('exceeds its bound');
  });
});

describe('person ask --progress lines', () => {
  it('prints V3 steps, and nothing else', () => {
    expect(validatePersonAskProgressLineV3({ ok: true, progress: { type: 'read', items: [person] } })).toEqual({ ok: true, progress: { type: 'read', items: [person] } });
    expect(validatePersonAskProgressLineV3({ ok: true, progress: { type: 'read', items: [followUp] } }).progress.type).toBe('read');
    expect(() => validatePersonAskProgressLineV3({ ok: true, progress: { type: 'answer', response: v8(), receipt: receipt() } })).toThrow();
    expect(() => validatePersonAskProgressLineV3({ ok: true, progress: { type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } } })).toThrow();
    expect(() => validatePersonAskProgressLineV3({ ok: false, progress: { type: 'stage', stage: 'searching' } })).toThrow();
    expect(() => validatePersonAskProgressLineV3({ ok: true, result: v8() })).toThrow();
  });

  it('ends with the V8 answer, with its receipt when the Authority streamed it', () => {
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v8(), receipt: receipt() })).toEqual({ ok: true, result: v8(), receipt: receipt() });
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v8() })).toEqual({ ok: true, result: v8() });
    for (const version of [5, 6, 7]) {
      expect(() => validatePersonAskProgressResultLineV3({ ok: true, result: { ...decided(), schema_version: version, kind: `echo-clean-person-answer-v${version}` } })).toThrow('Ask response is invalid');
    }
    expect(() => validatePersonAskProgressResultLineV3({ ok: true, result: v8(), receipt: { ...receipt(), looked_through: 1 } })).toThrow('less than the items');
    expect(() => validatePersonAskProgressResultLineV3({ ok: true, result: v8(), receipt: receipt(), progress: {} })).toThrow('unexpected shape');
  });
});
