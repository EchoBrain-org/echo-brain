import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_HOME_ROWS_V1,
  PERSON_OPEN_ITEMS_PAGE_V1,
  PERSON_RUNS_MAX_RESPONSE_BYTES_V1,
  PERSON_RUNS_PATH_V1,
  validatePersonRunsRequestV1,
  validatePersonRunsResultV1,
  type PersonRunsRequestV1,
  type PersonRunsResultsV1,
} from '../src/person-runs-v1.js';

const refused = (call: () => unknown, label: string) => {
  expect(call, label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};

const NOW = '2026-10-07T10:00:00.000Z';
const LATER = '2026-10-07T10:05:00.000Z';
const run = (overrides: Record<string, unknown> = {}) => ({
  run_id: 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc', trigger: 'approved_record', event_ref: 'apr_9b1d', state: 'pending', error_code: null, created_at: NOW, updated_at: NOW, ...overrides,
});

const record = {
  citation: { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' },
  kind: 'decision', label: 'Gate review: display precision', visibility: 'team',
};
const ticket = {
  citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10046', permalink: 'https://therm.example.test/browse/THERM-46', text_sha256: canonicalSha256('ticket') },
  kind: 'ticket', label: 'THERM-46: Display precision', visibility: 'only_me',
};
const card = {
  decided: [{ text: 'Show two decimals on the display.', citation_index: 0 }],
  affected: [{ citation_index: 1, says_now: 'THERM-46 formats one decimal.', relation: 'conflicts', owner: 'Mara Quinn', date_at_risk: { date: '2026-10-15', milestone: 'DVT gate' } }],
  unconfirmed: ['1 item could not be read.'],
  people: [{ name: 'Mara Quinn', items: [1] }],
  status: 'assessed',
  citations: [record, ticket],
};

// Open items: Ari approved Pilot planning; Mina Patel owns ECHO-12, which it affects.
const RUN = 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc';
const ITEM = 'itm_5b1f0c3a-8d2e-4f6a-9b7c-0123456789ab';
const RECORD = canonicalSha256('record:Pilot planning');
const PROJECT = 'prj_11111111-1111-4111-8111-111111111111';
const ARI = 'mem_2c1a0b9e-6f5d-4e3c-8b2a-1f0e9d8c7b6a';
const MINA = 'mem_7c9e6679-7425-40de-944b-e07fc1f90ae7';
const echo12 = {
  citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10012', permalink: 'https://pilot.example.test/browse/ECHO-12', text_sha256: canonicalSha256('ECHO-12') },
  kind: 'ticket', label: 'ECHO-12 · Pilot launch', visibility: 'only_me',
};
const DECISION = { approval_id: `apr_${'a'.repeat(64)}`, record_sha256: RECORD, title: 'Pilot planning', first_line: 'Launch the pilot next week.', approved_at: NOW, project_ids: [PROJECT] };
const CURRENT = { citation: echo12, says_now: 'ECHO-12 · Pilot launch: planned for the end of the month.', assignee: 'Mina Patel', status: 'In Progress', due_at: '2026-10-30' };
const APPROVER = { membership_id: ARI, name: 'Ari', active: true };
const OWNER = { membership_id: MINA, name: 'Mina Patel', active: true, match: 'jira_account' };
const CHECK = { verdict: 'changed', checked_at: LATER, checked_by: 'Mina Patel' };
/** An item the viewer opened carries what it says now; any other says why it does not. */
const openItem = (overrides: Record<string, unknown>) => ({
  item_id: ITEM, run_id: RUN, kind: 'ticket', relation: 'conflicts', expected: 'launch next week', approver: APPROVER, owner: OWNER,
  waits_on: 'owner', state: 'open', created_at: NOW, sent_at: LATER, state_set_at: null, check: CHECK, can: { set_state: true, assign: true },
  reach: Object.hasOwn(overrides, 'current') ? 'opened' : 'no_access',
  ...overrides,
});
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const sendRow = (overrides: Record<string, unknown> = {}) => ({ run_id: RUN, decision: DECISION, items: 2, kinds: ['ticket', 'page'], owners: ['Mina Patel'], finished_at: LATER, ...overrides });
const decisionCount = { record_sha256: RECORD, unsent: 1, open: 1 };
const summary = (overrides: Record<string, unknown> = {}) => ({
  unsent: 1, open: 1, done: 0, not_relevant: 0, landed: 0, changed: 1, unreadable: 0, decisions: 1, last_checked_at: LATER, by_decision: [decisionCount], ...overrides,
});
const stage = (overrides: Record<string, unknown> = {}) => ({ record_sha256: RECORD, run_id: RUN, state: 'done', error_code: null, ...overrides });

describe('runs API path', () => {
  it('is the one runs route', () => {
    expect(PERSON_RUNS_PATH_V1).toBe('/v1/person/runs');
  });
});

describe('runs API request', () => {
  const id = 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc';

  it('accepts each operation with exactly its keys', () => {
    for (const request of [
      { schema_version: 1, operation: 'list' },
      { schema_version: 1, operation: 'start', run_id: id },
      { schema_version: 1, operation: 'retry', run_id: id },
      { schema_version: 1, operation: 'view', run_id: id },
    ]) {
      expect(validatePersonRunsRequestV1(request)).toEqual(request);
      expect(Object.isFrozen(validatePersonRunsRequestV1(request))).toBe(true);
    }
  });

  it.each([
    ['wrong schema version', { schema_version: 2, operation: 'list' }],
    ['no schema version', { operation: 'list' }],
    ['string schema version', { schema_version: '1', operation: 'list' }],
    ['unknown operation', { schema_version: 1, operation: 'cancel', run_id: id }],
    ['no operation', { schema_version: 1 }],
    ['a prototype operation name', { schema_version: 1, operation: 'toString' }],
    ['list with a run id', { schema_version: 1, operation: 'list', run_id: id }],
    ['list with an extra key', { schema_version: 1, operation: 'list', limit: 5 }],
    ['start without a run id', { schema_version: 1, operation: 'start' }],
    ['start with an extra key', { schema_version: 1, operation: 'start', run_id: id, force: true }],
    ['retry with an extra key', { schema_version: 1, operation: 'retry', run_id: id, attempts: 0 }],
    ['view with an extra key', { schema_version: 1, operation: 'view', run_id: id, project_id: 'prj_x' }],
    ['a run id without the prefix', { schema_version: 1, operation: 'start', run_id: 'rr_0f6c1a2e-3b4d' }],
    ['a run id that is too short', { schema_version: 1, operation: 'start', run_id: 'run_abc' }],
    ['a run id that is too long', { schema_version: 1, operation: 'start', run_id: `run_${'a'.repeat(61)}` }],
    ['a run id with a forbidden character', { schema_version: 1, operation: 'start', run_id: 'run_abcd_efgh' }],
    ['a run id with whitespace', { schema_version: 1, operation: 'start', run_id: 'run_abcd efgh' }],
    ['a run id with a newline', { schema_version: 1, operation: 'start', run_id: 'run_abcdefgh\n' }],
    ['a numeric run id', { schema_version: 1, operation: 'start', run_id: 12345678 }],
    ['not an object', 'list'],
    ['null', null],
    ['an array', [{ schema_version: 1, operation: 'list' }]],
  ])('refuses %s', (_label, request) => {
    refused(() => validatePersonRunsRequestV1(request), _label);
  });

  it('accepts a run id at both length limits', () => {
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'view', run_id: `run_${'a'.repeat(4)}` })).not.toThrow();
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'view', run_id: `run_${'Z-9'.repeat(20)}` })).not.toThrow();
  });
});

describe('runs API list result', () => {
  const list = (value: unknown) => validatePersonRunsResultV1('list', value);

  it('accepts runs in every state with the matching error code', () => {
    const runs = [
      run(),
      run({ run_id: 'run_aaaa', state: 'running', updated_at: LATER }),
      run({ run_id: 'run_bbbb', state: 'done', updated_at: LATER }),
      ...(['no_access', 'unavailable', 'timed_out', 'research_failed'] as const).map((error_code, at) => run({ run_id: `run_f${at}f${at}`, state: 'failed', error_code, updated_at: LATER })),
    ];
    expect(list({ runs })).toEqual({ runs });
    expect(list({ runs: [] })).toEqual({ runs: [] });
    expect(Object.isFrozen(list({ runs }))).toBe(true);
  });

  it('accepts at most 100 runs', () => {
    const many = (count: number) => ({ runs: Array.from({ length: count }, (_, at) => run({ run_id: `run_${String(at).padStart(6, '0')}` })) });
    expect(list(many(100)).runs).toHaveLength(100);
    refused(() => list(many(101)), 'one run too many');
  });

  it.each([
    ['an extra key on the result', { runs: [], cursor: 'next' }],
    ['no runs key', {}],
    ['runs that are not an array', { runs: run() }],
    ['an extra key on a run', { runs: [run({ result_json: '{}' })] }],
    ['a run missing a key', { runs: [{ ...run(), error_code: undefined }] }],
    ['a trigger other than approved_record', { runs: [run({ trigger: 'sweep' })] }],
    ['a bad run id', { runs: [run({ run_id: 'rr_1234' })] }],
    ['an empty event ref', { runs: [run({ event_ref: '' })] }],
    ['an event ref over 128 characters', { runs: [run({ event_ref: 'a'.repeat(129) })] }],
    ['an event ref with a control character', { runs: [run({ event_ref: 'apr_\u0000' })] }],
    ['an unknown state', { runs: [run({ state: 'completed' })] }],
    ['an unknown error code', { runs: [run({ state: 'failed', error_code: 'boom' })] }],
    ['failed without an error code', { runs: [run({ state: 'failed', error_code: null })] }],
    ['done with an error code', { runs: [run({ state: 'done', error_code: 'unavailable' })] }],
    ['pending with an error code', { runs: [run({ state: 'pending', error_code: 'timed_out' })] }],
    ['running with an error code', { runs: [run({ state: 'running', error_code: 'no_access' })] }],
    ['an error code that is not a string or null', { runs: [run({ state: 'failed', error_code: 0 })] }],
    ['a timestamp without milliseconds', { runs: [run({ created_at: '2026-10-07T10:00:00Z' })] }],
    ['a timestamp that is not a real instant', { runs: [run({ updated_at: '2026-13-07T10:00:00.000Z' })] }],
    ['a non-string timestamp', { runs: [run({ created_at: 1790000000000 })] }],
  ])('refuses %s', (_label, value) => {
    refused(() => list(value), _label);
  });
});

describe('runs API start and retry results', () => {
  it('accepts a start state from the closed set', () => {
    for (const state of ['pending', 'running', 'busy', 'done', 'failed'] as const) expect(validatePersonRunsResultV1('start', { state })).toEqual({ state });
    for (const [label, value] of [
      ['an unknown state', { state: 'queued' }], ['an extra key', { state: 'running', run_id: 'run_abcd' }], ['no state', {}], ['a non-string state', { state: 1 }],
    ] as const) refused(() => validatePersonRunsResultV1('start', value), label);
  });

  it('accepts only pending as a retry result', () => {
    expect(validatePersonRunsResultV1('retry', { state: 'pending' })).toEqual({ state: 'pending' });
    for (const [label, value] of [
      ['running', { state: 'running' }], ['busy', { state: 'busy' }], ['failed', { state: 'failed' }], ['an extra key', { state: 'pending', attempts: 0 }], ['no state', {}],
    ] as const) refused(() => validatePersonRunsResultV1('retry', value), label);
  });
});

describe('runs API view result', () => {
  const view = (value: unknown) => validatePersonRunsResultV1('view', value);
  const valid = { card, checked_at: LATER, hidden: 2 };

  it('accepts a valid card with its check time and hidden count', () => {
    const result = view(valid);
    expect(result).toEqual(valid);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.card)).toBe(true);
    expect(view({ ...valid, hidden: 0 }).hidden).toBe(0);
  });

  it.each([
    ['an extra key', { ...valid, run_id: 'run_abcd' }],
    ['no card', { checked_at: LATER, hidden: 0 }],
    ['no check time', { card, hidden: 0 }],
    ['no hidden count', { card, checked_at: LATER }],
    ['a card with an extra key', { ...valid, card: { ...card, suggested_edits: [] } }],
    ['a card that is not valid', { ...valid, card: { ...card, citations: [record] } }],
    ['a card whose people do not match its owners', { ...valid, card: { ...card, people: [] } }],
    ['a card that is not an object', { ...valid, card: 'card' }],
    ['a bad check time', { ...valid, checked_at: '2026-10-07 10:05' }],
    ['a negative hidden count', { ...valid, hidden: -1 }],
    ['a fractional hidden count', { ...valid, hidden: 1.5 }],
    ['an unsafe hidden count', { ...valid, hidden: Number.MAX_SAFE_INTEGER + 1 }],
    ['a string hidden count', { ...valid, hidden: '1' }],
  ])('refuses %s', (_label, value) => {
    refused(() => view(value), _label);
  });
});

describe('runs API results in general', () => {
  it('refuses an operation it does not know, and a value that is not an object', () => {
    refused(() => validatePersonRunsResultV1('cancel' as keyof PersonRunsResultsV1, {}), 'unknown operation');
    refused(() => validatePersonRunsResultV1('toString' as keyof PersonRunsResultsV1, {}), 'prototype operation');
    for (const value of [null, 'done', ['done']]) refused(() => validatePersonRunsResultV1('start', value), String(value));
  });

  it('caps a response at 1 MiB', () => {
    expect(PERSON_RUNS_MAX_RESPONSE_BYTES_V1).toBe(1024 * 1024);
    // A full list of ordinary runs is far below the cap.
    const runs = Array.from({ length: 100 }, (_, at) => run({ run_id: `run_${String(at).padStart(6, '0')}`, event_ref: 'e'.repeat(120) }));
    expect(() => validatePersonRunsResultV1('list', { runs })).not.toThrow();
  });
});

describe('runs API open items', () => {
  it('accepts each new runs request and refuses a scope without its id', () => {
    expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'home' })).toEqual({ schema_version: 1, operation: 'home' });
    expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'record', id: RECORD })).toMatchObject({ scope: 'record', id: RECORD });
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'project' })).toThrow();
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'mine', id: RECORD })).toThrow();
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'send', run_id: RUN, command_id: 'c1', items: [{ item_id: ITEM, include: false, owner_membership_id: MINA }] })).toThrow();
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'unsent' })).toThrow();
  });
  it('validates an open item with and without the parts a viewer may not see', () => {
    const seen = openItem({ decision: DECISION, current: CURRENT });
    expect(validatePersonRunsResultV1('item', { item: seen }).item.current?.says_now).toBe(CURRENT.says_now);
    expect(validatePersonRunsResultV1('item', { item: openItem({}) }).item).not.toHaveProperty('current');
    expect(() => validatePersonRunsResultV1('item', { item: { ...seen, pointer: {} } })).toThrow();      // no extra key ever
    expect(() => validatePersonRunsResultV1('home', { send: [], items: Array.from({ length: 21 }, () => seen), landed: 0, waiting: 0, last_checked_at: null })).toThrow();
  });
  it('accepts summary_only only as true and never with a cursor, and requires reach', () => {
    // Counts and stages only: a line that shows how many items there are opens none of them.
    const counts = { schema_version: 1, operation: 'items', scope: 'project', id: PROJECT, summary_only: true };
    expect(validatePersonRunsRequestV1(counts)).toEqual(counts);
    expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'mine', summary_only: true })).toEqual({ schema_version: 1, operation: 'items', scope: 'mine', summary_only: true });
    expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'record', id: RECORD })).not.toHaveProperty('summary_only');
    for (const summary_only of [false, 'true', 1, null, {}]) refused(() => validatePersonRunsRequestV1({ ...counts, summary_only }), `summary_only ${JSON.stringify(summary_only)}`);
    refused(() => validatePersonRunsRequestV1({ ...counts, cursor: 'next-page_2' }), 'summary_only with a cursor');
    refused(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'home', summary_only: true }), 'summary_only on home');
    // Every item says how its live read went, and carries what it says now exactly when it was opened.
    for (const reach of ['no_access', 'unavailable', 'not_read'] as const) {
      expect(validatePersonRunsResultV1('item', { item: openItem({ reach }) }).item.reach).toBe(reach);
    }
    expect(validatePersonRunsResultV1('item', { item: openItem({ current: CURRENT }) }).item.reach).toBe('opened');
    refused(() => validatePersonRunsResultV1('item', { item: without(openItem({}), 'reach') }), 'an item without reach');
    refused(() => validatePersonRunsResultV1('item', { item: openItem({ reach: 'opened' }) }), 'opened without what it says now');
    for (const reach of ['no_access', 'unavailable', 'not_read']) {
      refused(() => validatePersonRunsResultV1('item', { item: openItem({ current: CURRENT, reach }) }), `what it says now with ${reach}`);
    }
    for (const reach of ['denied', '', null, true]) refused(() => validatePersonRunsResultV1('item', { item: openItem({ reach }) }), `reach ${JSON.stringify(reach)}`);
  });
});

describe('runs API open-item requests', () => {
  const itemsRequest = (fields: Record<string, unknown>) => ({ schema_version: 1, operation: 'items', ...fields });
  const send = (fields: Record<string, unknown> = {}) => ({ schema_version: 1, operation: 'send', run_id: RUN, command_id: 'c1', items: [{ item_id: ITEM, include: true }], ...fields });
  const numbered = (count: number, include: (at: number) => boolean) => Array.from({ length: count }, (_, at) => ({ item_id: `itm_${String(at).padStart(4, '0')}`, include: include(at) }));

  it('accepts each operation with exactly its keys', () => {
    for (const request of [
      { schema_version: 1, operation: 'home' },
      itemsRequest({ scope: 'mine' }),
      itemsRequest({ scope: 'mine', cursor: 'MjAyNi0xMC0wN3xpdG1fYWJjZA' }),
      itemsRequest({ scope: 'run', id: RUN }),
      itemsRequest({ scope: 'record', id: RECORD, cursor: 'next-page_2' }),
      itemsRequest({ scope: 'project', id: PROJECT }),
      { schema_version: 1, operation: 'item', item_id: ITEM },
      send({ items: [{ item_id: ITEM, include: true, owner_membership_id: MINA }, { item_id: 'itm_abcd', include: false }] }),
      ...['open', 'done', 'not_relevant'].map(state => ({ schema_version: 1, operation: 'set_state', item_id: ITEM, state })),
      { schema_version: 1, operation: 'assign', item_id: ITEM, owner_membership_id: MINA },
    ]) {
      const validated = validatePersonRunsRequestV1(request);
      expect(validated).toEqual(request);
      expect(Object.isFrozen(validated)).toBe(true);
    }
    const sent = validatePersonRunsRequestV1(send()) as Extract<PersonRunsRequestV1, { operation: 'send' }>;
    expect(Object.isFrozen(sent.items) && sent.items.every(entry => Object.isFrozen(entry))).toBe(true);
  });

  it('accepts ids, command ids, cursors and sends at their limits', () => {
    for (const request of [
      { schema_version: 1, operation: 'item', item_id: `itm_${'a'.repeat(4)}` },
      { schema_version: 1, operation: 'item', item_id: `itm_${'Z-9'.repeat(20)}` },
      itemsRequest({ scope: 'mine', cursor: 'c'.repeat(256) }),
      send({ command_id: `${'A_b-9'.repeat(25)}xyz` }),
      send({ items: numbered(20, at => at % 2 === 0) }),
    ]) expect(() => validatePersonRunsRequestV1(request), JSON.stringify(request).slice(0, 80)).not.toThrow();
  });

  it.each([
    ['home with an extra key', { schema_version: 1, operation: 'home', scope: 'mine' }],
    ['items without a scope', itemsRequest({})],
    ['an unknown scope', itemsRequest({ scope: 'team' })],
    ['a run scope with a record id', itemsRequest({ scope: 'run', id: RECORD })],
    ['a record scope with a short digest', itemsRequest({ scope: 'record', id: 'sha256:abc' })],
    ['a record scope with uppercase hex', itemsRequest({ scope: 'record', id: `sha256:${'A'.repeat(64)}` })],
    ['a project scope with a project id that is not canonical', itemsRequest({ scope: 'project', id: 'prj_pilot' })],
    ['a scope id that is null', itemsRequest({ scope: 'run', id: null })],
    ['an empty cursor', itemsRequest({ scope: 'mine', cursor: '' })],
    ['a cursor over 256 characters', itemsRequest({ scope: 'mine', cursor: 'c'.repeat(257) })],
    ['a cursor with a forbidden character', itemsRequest({ scope: 'mine', cursor: 'abc=' })],
    ['items with an extra key', itemsRequest({ scope: 'mine', limit: 10 })],
    ['item without an item id', { schema_version: 1, operation: 'item' }],
    ['an item id without the prefix', { schema_version: 1, operation: 'item', item_id: 'item_abcd' }],
    ['an item id that is too short', { schema_version: 1, operation: 'item', item_id: 'itm_abc' }],
    ['an item id that is too long', { schema_version: 1, operation: 'item', item_id: `itm_${'a'.repeat(61)}` }],
    ['an item id with a forbidden character', { schema_version: 1, operation: 'item', item_id: 'itm_abcd_efgh' }],
    ['a send without items', send({ items: [] })],
    ['a send of 21 items', send({ items: numbered(21, () => true) })],
    ['a send that repeats an item', send({ items: [{ item_id: ITEM, include: true }, { item_id: ITEM, include: false }] })],
    ['a send with an include that is not a boolean', send({ items: [{ item_id: ITEM, include: 'yes' }] })],
    ['a send item without include', send({ items: [{ item_id: ITEM }] })],
    ['a send with an owner that is not a membership id', send({ items: [{ item_id: ITEM, include: true, owner_membership_id: 'mem_mina' }] })],
    ['a send item with an extra key', send({ items: [{ item_id: ITEM, include: true, expected: 'launch next week' }] })],
    ['a send without a command id', without(send(), 'command_id')],
    ['an empty command id', send({ command_id: '' })],
    ['a command id over 128 characters', send({ command_id: 'c'.repeat(129) })],
    ['a command id with a space', send({ command_id: 'c 1' })],
    ['a send with a bad run id', send({ run_id: 'run_abc' })],
    ['a state other than open, done or not_relevant', { schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'closed' }],
    ['set_state without a state', { schema_version: 1, operation: 'set_state', item_id: ITEM }],
    ['assign to a membership id that is not canonical', { schema_version: 1, operation: 'assign', item_id: ITEM, owner_membership_id: 'mem_mina' }],
    ['assign without an owner', { schema_version: 1, operation: 'assign', item_id: ITEM }],
  ])('refuses %s', (_label, request) => {
    refused(() => validatePersonRunsRequestV1(request), _label);
  });
});

describe('runs API open-item results', () => {
  const seen = openItem({ decision: DECISION, current: CURRENT });
  const withItem = (fields: Record<string, unknown>) => ({ item: { ...seen, ...fields } });
  const home = (fields: Record<string, unknown> = {}) => ({ send: [sendRow()], items: [seen], landed: 1, waiting: 0, last_checked_at: LATER, ...fields });
  const page = (fields: Record<string, unknown> = {}) => ({ items: [seen], next_cursor: null, summary: summary(), stages: [stage()], ...fields });

  it('returns a fresh item, frozen with all its parts', () => {
    const { item } = validatePersonRunsResultV1('item', { item: seen });
    expect(item).toEqual(seen);
    for (const part of [item, item.decision, item.decision?.project_ids, item.current, item.current?.citation, item.approver, item.owner, item.check, item.can]) expect(Object.isFrozen(part)).toBe(true);
  });

  it('accepts an unsent item that was never assessed or checked and waits on the leads', () => {
    const orphan = openItem({
      relation: null, expected: null, state: 'unsent', sent_at: null, check: null, waits_on: 'leads', can: { set_state: false, assign: true },
      approver: { ...APPROVER, active: false }, owner: { ...APPROVER, active: false, match: 'approver' },
    });
    expect(validatePersonRunsResultV1('item', { item: orphan }).item).toEqual(orphan);
    const plain = { citation: echo12, says_now: 'ECHO-12 · Pilot launch' };
    expect(validatePersonRunsResultV1('item', { item: openItem({ current: plain }) }).item.current).toEqual(plain);
  });

  it('accepts a home and an items page up to their bounds', () => {
    expect(PERSON_HOME_ROWS_V1).toBe(20);
    expect(PERSON_OPEN_ITEMS_PAGE_V1).toBe(50);
    const fullHome = home({ send: Array.from({ length: 20 }, () => sendRow()), items: Array.from({ length: 20 }, () => seen) });
    expect(validatePersonRunsResultV1('home', fullHome)).toEqual(fullHome);
    const empty = { send: [], items: [], landed: 0, waiting: 0, last_checked_at: null };
    expect(validatePersonRunsResultV1('home', empty)).toEqual(empty);
    refused(() => validatePersonRunsResultV1('home', home({ send: Array.from({ length: 21 }, () => sendRow()) })), 'one send row too many');
    const fullPage = page({
      items: Array.from({ length: 50 }, () => seen), next_cursor: 'MjAyNi0xMC0wN3xpdG1fYWJjZA',
      summary: summary({ by_decision: Array.from({ length: 100 }, () => decisionCount) }), stages: Array.from({ length: 100 }, () => stage()),
    });
    expect(validatePersonRunsResultV1('items', fullPage)).toEqual(fullPage);
    refused(() => validatePersonRunsResultV1('items', page({ items: Array.from({ length: 51 }, () => seen) })), 'one item too many');
    refused(() => validatePersonRunsResultV1('items', page({ summary: summary({ by_decision: Array.from({ length: 101 }, () => decisionCount) }) })), 'one decision count too many');
    refused(() => validatePersonRunsResultV1('items', page({ stages: Array.from({ length: 101 }, () => stage()) })), 'one stage too many');
  });

  it('accepts the send, set_state and assign results', () => {
    expect(validatePersonRunsResultV1('send', { sent: 2, not_relevant: 1 })).toEqual({ sent: 2, not_relevant: 1 });
    for (const state of ['open', 'done', 'not_relevant'] as const) expect(validatePersonRunsResultV1('set_state', { state })).toEqual({ state });
    const assigned = validatePersonRunsResultV1('assign', { owner: APPROVER });
    expect(assigned).toEqual({ owner: APPROVER });
    expect(Object.isFrozen(assigned.owner)).toBe(true);
  });

  it.each([
    ['without its permissions', { item: without(seen, 'can') }],
    ['an item id that is a run id', withItem({ item_id: RUN })],
    ['a run id that is an item id', withItem({ run_id: ITEM })],
    ['an unknown kind', withItem({ kind: 'issue' })],
    ['a confirms relation', withItem({ relation: 'confirms' })],
    ['an expected phrase over 120 characters', withItem({ expected: 'e'.repeat(121) })],
    ['an expected phrase on two lines', withItem({ expected: 'launch\nnext week' })],
    ['an expected phrase with a trailing space', withItem({ expected: 'launch next week ' })],
    ['an empty expected phrase', withItem({ expected: '' })],
    ['an approver name over 200 characters', withItem({ approver: { ...APPROVER, name: 'A'.repeat(201) } })],
    ['an empty owner name', withItem({ owner: { ...OWNER, name: '' } })],
    ['an owner name with a line separator', withItem({ owner: { ...OWNER, name: 'Mina Patel' } })],
    ['an approver membership id that is not canonical', withItem({ approver: { ...APPROVER, membership_id: 'mem_ari' } })],
    ['an approver with an owner match', withItem({ approver: { ...APPROVER, match: 'approver' } })],
    ['an owner without a match', withItem({ owner: without(OWNER, 'match') })],
    ['an unknown owner match', withItem({ owner: { ...OWNER, match: 'guessed' } })],
    ['an active flag that is not a boolean', withItem({ owner: { ...OWNER, active: 1 } })],
    ['an unknown waits_on', withItem({ waits_on: 'team' })],
    ['an unknown state', withItem({ state: 'closed' })],
    ['a created_at that is not a timestamp', withItem({ created_at: '2026-10-07' })],
    ['a sent_at that is neither a timestamp nor null', withItem({ sent_at: '' })],
    ['a state_set_at that is not a real instant', withItem({ state_set_at: '2026-02-30T10:00:00.000Z' })],
    ['an unknown verdict', withItem({ check: { ...CHECK, verdict: 'drifted' } })],
    ['a check that keeps a sentence', withItem({ check: { ...CHECK, line: 'ECHO-12 now says next week.' } })],
    ['a check without who ran it', withItem({ check: without(CHECK, 'checked_by') })],
    ['permissions with an extra key', withItem({ can: { set_state: true, assign: true, send: true } })],
    ['a permission that is not a boolean', withItem({ can: { set_state: 'yes', assign: true } })],
    ['a decision with a bad record id', withItem({ decision: { ...DECISION, record_sha256: 'sha256:abc' } })],
    ['a decision title over 200 characters', withItem({ decision: { ...DECISION, title: 'T'.repeat(201) } })],
    ['a decision first line over 300 characters', withItem({ decision: { ...DECISION, first_line: 'f'.repeat(301) } })],
    ['a decision with an empty approval id', withItem({ decision: { ...DECISION, approval_id: '' } })],
    ['a decision with a project id that is not canonical', withItem({ decision: { ...DECISION, project_ids: ['prj_pilot'] } })],
    ['a decision that carries its card', withItem({ decision: { ...DECISION, card } })],
    ['a decision that is null', withItem({ decision: null })],
    ['a current part with an inconsistent citation', withItem({ current: { ...CURRENT, citation: { ...echo12, kind: 'page' } } })],
    ['a says_now over 300 characters', withItem({ current: { ...CURRENT, says_now: 's'.repeat(301) } })],
    ['a current part that keeps the item text', withItem({ current: { ...CURRENT, text: 'ECHO-12 full description' } })],
    ['a current part without says_now', withItem({ current: without(CURRENT, 'says_now') })],
    ['an assignee over 200 characters', withItem({ current: { ...CURRENT, assignee: 'M'.repeat(201) } })],
    ['a status on two lines', withItem({ current: { ...CURRENT, status: 'In\nProgress' } })],
    ['a due date over 128 characters', withItem({ current: { ...CURRENT, due_at: 'd'.repeat(129) } })],
    ['a current part that is null', withItem({ current: null })],
  ])('refuses an item with %s', (_label, value) => {
    refused(() => validatePersonRunsResultV1('item', value), _label);
  });

  it.each([
    ['a home with an extra count', 'home', home({ total: 3 })],
    ['a home without its waiting count', 'home', without(home(), 'waiting')],
    ['a negative landed count', 'home', home({ landed: -1 })],
    ['a fractional waiting count', 'home', home({ waiting: 0.5 })],
    ['a bad last check time', 'home', home({ last_checked_at: 'yesterday' })],
    ['a send row with an extra key', 'home', home({ send: [sendRow({ card })] })],
    ['a send row without its decision', 'home', home({ send: [without(sendRow(), 'decision')] })],
    ['a send row with an unknown kind', 'home', home({ send: [sendRow({ kinds: ['issue'] })] })],
    ['a send row that repeats a kind', 'home', home({ send: [sendRow({ kinds: ['ticket', 'ticket'] })] })],
    ['a send row that repeats an owner', 'home', home({ send: [sendRow({ owners: ['Mina Patel', 'Mina Patel'] })] })],
    ['a send row with an unsafe item count', 'home', home({ send: [sendRow({ items: Number.MAX_SAFE_INTEGER + 1 })] })],
    ['a send row with a bad finish time', 'home', home({ send: [sendRow({ finished_at: LATER.slice(0, 10) })] })],
    ['a page with a bad next cursor', 'items', page({ next_cursor: 'abc=' })],
    ['a page without its stages', 'items', without(page(), 'stages')],
    ['a summary with an extra count', 'items', page({ summary: summary({ total: 9 }) })],
    ['a negative summary count', 'items', page({ summary: summary({ open: -1 }) })],
    ['a summary count that is a string', 'items', page({ summary: summary({ decisions: '1' }) })],
    ['a bad summary check time', 'items', page({ summary: summary({ last_checked_at: '' }) })],
    ['a decision count with an extra key', 'items', page({ summary: summary({ by_decision: [{ ...decisionCount, done: 0 }] }) })],
    ['a decision count with a bad record id', 'items', page({ summary: summary({ by_decision: [{ ...decisionCount, record_sha256: RUN }] }) })],
    ['a stage with an extra key', 'items', page({ stages: [stage({ checked_at: LATER })] })],
    ['a stage in an unknown state', 'items', page({ stages: [stage({ state: 'queued' })] })],
    ['a failed stage without its reason', 'items', page({ stages: [stage({ state: 'failed' })] })],
    ['a done stage with a reason', 'items', page({ stages: [stage({ error_code: 'unavailable' })] })],
    ['a stage with a bad run id', 'items', page({ stages: [stage({ run_id: ITEM })] })],
    ['a send result with an extra count', 'send', { sent: 1, not_relevant: 0, skipped: 0 }],
    ['a negative sent count', 'send', { sent: -1, not_relevant: 0 }],
    ['a set_state result of unsent', 'set_state', { state: 'unsent' }],
    ['an assigned owner with a match', 'assign', { owner: { ...APPROVER, match: 'reassigned' } }],
    ['an assigned owner with a membership id that is not canonical', 'assign', { owner: { ...APPROVER, membership_id: 'mem_ari' } }],
  ])('refuses %s', (_label, operation, value) => {
    refused(() => validatePersonRunsResultV1(operation as keyof PersonRunsResultsV1, value), _label);
  });
});
