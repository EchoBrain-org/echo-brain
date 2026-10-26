import { canonicalJsonBytes, canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_CHECK_CITATION_KINDS_V1,
  PERSON_ASK_CHECK_KIND_V1,
  PERSON_ASK_CHECK_LIMITS_V1,
  PERSON_ASK_CHECK_PATH_V1,
  PERSON_ASK_CHECK_REQUEST_KIND_V1,
  validatePersonAnswerEvidenceCitationV8,
  validatePersonAskCheckRequestV1,
  validatePersonAskCheckV1,
} from '../src/index.js';

const refused = (call: () => unknown, label: string) => {
  expect(call, label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const ASKED = '2026-10-20T09:30:00.000Z';
const MARKER = canonicalSha256({ summary: 'Ship on Friday' });
const citations = {
  approved_record: { kind: 'approved_record', atom_id: digest('a'), record_sha256: digest('b'), policy_id: 'project-members-readable-person-v1' },
  source_revision: { kind: 'source_revision', source_id: `source:${'c'.repeat(64)}`, revision_id: 'r1', source_sha256: digest('d'), representation_sha256: digest('e'), anchor_sha256: digest('f'), label: 'Pilot notes' },
  follow_up: { kind: 'follow_up', item_id: 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' },
  ticket: { kind: 'ticket', tool_id: 'jira', external_scope_id: '00000000-0000-4000-8000-000000000007', ticket_id: '10012', permalink: 'https://echo.atlassian.net/browse/ECHO-12', text_sha256: digest('1') },
  page: { kind: 'page', tool_id: 'confluence', external_scope_id: '00000000-0000-4000-8000-000000000007', page_id: '200', section_id: 's2', version: '3', permalink: 'https://echo.atlassian.net/wiki/pages/viewpage.action?pageId=200', text_sha256: digest('2') },
} as const;
const item = (citation: unknown, fields: Record<string, unknown> = {}) => ({ asked_at: ASKED, citation, ...fields });
const request = (items: readonly unknown[] = Object.values(citations).map(citation => item(citation)), fields: Record<string, unknown> = {}) =>
  ({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1, items, ...fields });
const answer = (items: readonly unknown[], fields: Record<string, unknown> = {}) => ({ schema_version: 1, kind: PERSON_ASK_CHECK_KIND_V1, items, ...fields });

describe('Ask source check request (Ask timeline v1, C1)', () => {
  it('serves one path and freezes its bounds and kinds', () => {
    expect(PERSON_ASK_CHECK_PATH_V1).toBe('/v1/person/ask/check');
    expect(PERSON_ASK_CHECK_LIMITS_V1).toEqual({ items_min: 1, items_max: 100, body_bytes: 64 * 1024 });
    expect(Object.isFrozen(PERSON_ASK_CHECK_LIMITS_V1)).toBe(true);
    expect([...PERSON_ASK_CHECK_CITATION_KINDS_V1]).toEqual(['approved_record', 'source_revision', 'follow_up', 'ticket', 'page']);
  });

  it('accepts each checkable kind exactly as an answer cited it, with a marker on a ticket only, and returns a frozen copy', () => {
    const value = request([...Object.values(citations).map(citation => item(citation)), item(citations.ticket, { marker: MARKER })]);
    const validated = validatePersonAskCheckRequestV1(value);
    expect(validated).toEqual(value);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.items)).toBe(true);
    expect(Object.isFrozen(validated.items[5])).toBe(true);
    // The citations are the V8 answer's own, validated by the same rules.
    for (const citation of Object.values(citations)) expect(validatePersonAnswerEvidenceCitationV8(citation)).toEqual(citation);
    // The same source may be asked about for several turns.
    expect(validatePersonAskCheckRequestV1(request([item(citations.page), item(citations.page, { asked_at: '2026-10-21T09:30:00.000Z' })])).items).toHaveLength(2);
  });

  it('takes 1 to 100 items within 64 KiB', () => {
    expect(validatePersonAskCheckRequestV1(request(Array.from({ length: 100 }, () => item(citations.follow_up)))).items).toHaveLength(100);
    refused(() => validatePersonAskCheckRequestV1(request([])), 'no items');
    refused(() => validatePersonAskCheckRequestV1(request(Array.from({ length: 101 }, () => item(citations.follow_up)))), '101 items');
    // A hundred long source citations pass the item bound but not the byte bound.
    const long = { ...citations.source_revision, revision_id: 'r'.repeat(512), label: 'L'.repeat(200) };
    const heavy = request(Array.from({ length: 100 }, () => item(long)));
    expect(canonicalJsonBytes(heavy).byteLength).toBeGreaterThan(PERSON_ASK_CHECK_LIMITS_V1.body_bytes);
    refused(() => validatePersonAskCheckRequestV1(heavy), 'over 64 KiB');
  });

  it.each([
    ['a project', { kind: 'project', project_id: 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' }],
    ['a person', { kind: 'person', membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' }],
    ['a tool', { kind: 'tool', tool_id: 'jira' }],
    ['a tool container', { kind: 'tool_container', tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project', container_id: '10001', permalink: 'https://example.atlassian.net/browse/THERM' }],
    ['an unknown kind', { kind: 'slack_message', id: '1' }],
    ['no kind', { item_id: citations.follow_up.item_id }],
    ['a ticket with an extra key', { ...citations.ticket, title: 'ECHO-12' }],
    ['a page without its version', (({ version: _version, ...rest }) => rest)(citations.page)],
    ['a record with another policy', { ...citations.approved_record, policy_id: 'everyone' }],
    ['a follow-up with a bad id', { kind: 'follow_up', item_id: 'item-1' }],
    ['a source revision with a bad source id', { ...citations.source_revision, source_id: 'source:xyz' }],
    ['a citation that is a list', [citations.ticket]],
  ])('refuses %s as the cited source', (label, citation) => {
    refused(() => validatePersonAskCheckRequestV1(request([item(citation)])), label);
  });

  it.each([
    ['another schema version', request(undefined, { schema_version: 2 })],
    ['another kind', request(undefined, { kind: PERSON_ASK_CHECK_KIND_V1 })],
    ['an extra key', request(undefined, { scope: { kind: 'global' } })],
    ['no items', (({ items: _items, ...rest }) => rest)(request())],
    ['items that are not a list', request(undefined, { items: { 0: item(citations.ticket) } })],
    ['an item with an extra key', request([item(citations.ticket, { label: 'ECHO-12' })])],
    ['an item without its time', request([{ citation: citations.ticket }])],
    ['an item without its citation', request([{ asked_at: ASKED }])],
    ['a time without milliseconds', request([item(citations.ticket, { asked_at: '2026-10-20T09:30:00Z' })])],
    ['a time with an offset', request([item(citations.ticket, { asked_at: '2026-10-20T09:30:00.000+02:00' })])],
    ['a time that does not exist', request([item(citations.ticket, { asked_at: '2026-02-30T09:30:00.000Z' })])],
    ['a time that is a number', request([item(citations.ticket, { asked_at: Date.parse(ASKED) })])],
    ['a marker on a page', request([item(citations.page, { marker: MARKER })])],
    ['a marker on a follow-up', request([item(citations.follow_up, { marker: MARKER })])],
    ['a marker on a record', request([item(citations.approved_record, { marker: MARKER })])],
    ['a marker without its prefix', request([item(citations.ticket, { marker: MARKER.slice(7) })])],
    ['a marker in upper case', request([item(citations.ticket, { marker: MARKER.toUpperCase() })])],
    ['a short marker', request([item(citations.ticket, { marker: MARKER.slice(0, -1) })])],
    ['a null marker', request([item(citations.ticket, { marker: null })])],
  ])('refuses a request with %s', (label, value) => {
    refused(() => validatePersonAskCheckRequestV1(value), label);
  });

  it('refuses anything but a plain object', () => {
    for (const value of [null, undefined, 'check', 7, [request()]]) refused(() => validatePersonAskCheckRequestV1(value), JSON.stringify(value) ?? 'undefined');
  });
});

describe('Ask source check answer (Ask timeline v1, C1)', () => {
  const asked = validatePersonAskCheckRequestV1(request([item(citations.ticket), item(citations.page), item(citations.ticket, { marker: MARKER }), item(citations.follow_up)]));

  it('answers each item in order, with a marker exactly on a readable ticket, and returns a frozen copy', () => {
    const value = answer([{ state: 'same', marker: MARKER }, { state: 'changed' }, { state: 'changed', marker: canonicalSha256('later') }, { state: 'unreadable' }]);
    const validated = validatePersonAskCheckV1(value, asked);
    expect(validated).toEqual(value);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.items[0])).toBe(true);
    // Unreadable and unknown tickets carry no marker.
    expect(validatePersonAskCheckV1(answer([{ state: 'unreadable' }, { state: 'unknown' }, { state: 'unknown' }, { state: 'same' }]), asked).items)
      .toEqual([{ state: 'unreadable' }, { state: 'unknown' }, { state: 'unknown' }, { state: 'same' }]);
    // Without its request, only the shape is checked.
    expect(validatePersonAskCheckV1(answer([{ state: 'same' }, { state: 'unknown' }])).items).toHaveLength(2);
  });

  it.each([
    ['fewer items than asked', answer([{ state: 'same', marker: MARKER }, { state: 'same' }, { state: 'same', marker: MARKER }])],
    ['more items than asked', answer([{ state: 'same', marker: MARKER }, { state: 'same' }, { state: 'same', marker: MARKER }, { state: 'same' }, { state: 'same' }])],
    ['a readable ticket without its marker', answer([{ state: 'same' }, { state: 'same' }, { state: 'same', marker: MARKER }, { state: 'same' }])],
    ['a marker on a page', answer([{ state: 'same', marker: MARKER }, { state: 'same', marker: MARKER }, { state: 'same', marker: MARKER }, { state: 'same' }])],
    ['a marker on an unreadable ticket', answer([{ state: 'unreadable', marker: MARKER }, { state: 'same' }, { state: 'same', marker: MARKER }, { state: 'same' }])],
    ['a marker on an unknown ticket', answer([{ state: 'same', marker: MARKER }, { state: 'same' }, { state: 'unknown', marker: MARKER }, { state: 'same' }])],
  ])('refuses an answer with %s', (label, value) => {
    refused(() => validatePersonAskCheckV1(value, asked), label);
  });

  it.each([
    ['another schema version', answer([{ state: 'same' }], { schema_version: 2 })],
    ['the request kind', answer([{ state: 'same' }], { kind: PERSON_ASK_CHECK_REQUEST_KIND_V1 })],
    ['an extra key', answer([{ state: 'same' }], { checked_at: ASKED })],
    ['no items', answer([])],
    ['101 items', answer(Array.from({ length: 101 }, () => ({ state: 'same' })))],
    ['another state', answer([{ state: 'stale' }])],
    ['no state', answer([{}])],
    ['a reason', answer([{ state: 'unreadable', reason: 'deleted' }])],
    ['a label', answer([{ state: 'changed', label: 'ECHO-12' }])],
    ['a count', answer([{ state: 'changed', changed: 2 }])],
    ['a marker on an unreadable item', answer([{ state: 'unreadable', marker: MARKER }])],
    ['a marker that is not a digest', answer([{ state: 'same', marker: 'ECHO-12' }])],
  ])('refuses an answer with %s', (label, value) => {
    refused(() => validatePersonAskCheckV1(value), label);
  });
});
