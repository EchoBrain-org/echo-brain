import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_CHANGES_KIND_V1,
  validatePersonChangesV1,
} from '../src/person-changes-v1.js';
import { validatePersonRunsRequestV1 } from '../src/person-runs-v1.js';

const refused = (call: () => unknown, label: string) => {
  expect(call, label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};
const areas = { projects: canonicalSha256(['projects']), follow_ups: canonicalSha256(['follow_ups']), reviews: canonicalSha256([]) };
const changes = (fields: Record<string, unknown> = {}) => ({ kind: PERSON_CHANGES_KIND_V1, areas, check_again_after_seconds: 60, ...fields });

describe('Person change check (ADR-0036)', () => {
  it('accepts exactly its keys and returns a frozen copy', () => {
    const validated = validatePersonChangesV1(changes());
    expect(validated).toEqual(changes());
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.areas)).toBe(true);
    for (const seconds of [15, 60, 3600]) expect(validatePersonChangesV1(changes({ check_again_after_seconds: seconds })).check_again_after_seconds).toBe(seconds);
  });

  it.each([
    ['a missing kind', (() => { const { kind: _kind, ...rest } = changes(); return rest; })()],
    ['another kind', changes({ kind: 'echo-person-changes-v2' })],
    ['an extra key', changes({ position: 7 })],
    ['missing areas', (() => { const { areas: _areas, ...rest } = changes(); return rest; })()],
    ['a missing wait', (() => { const { check_again_after_seconds: _wait, ...rest } = changes(); return rest; })()],
    ['an extra area', changes({ areas: { ...areas, account: canonicalSha256('account') } })],
    ['a missing area', changes({ areas: { projects: areas.projects, follow_ups: areas.follow_ups } })],
    ['areas that are a list', changes({ areas: [areas.projects, areas.follow_ups, areas.reviews] })],
    ['areas that are null', changes({ areas: null })],
    ['a digest in upper case', changes({ areas: { ...areas, projects: areas.projects.toUpperCase() } })],
    ['a digest without its prefix', changes({ areas: { ...areas, projects: areas.projects.slice(7) } })],
    ['a short digest', changes({ areas: { ...areas, follow_ups: areas.follow_ups.slice(0, -1) } })],
    ['a long digest', changes({ areas: { ...areas, follow_ups: `${areas.follow_ups}0` } })],
    ['a digest that is not hex', changes({ areas: { ...areas, reviews: `sha256:${'g'.repeat(64)}` } })],
    ['a digest that is a number', changes({ areas: { ...areas, reviews: 7 } })],
    ['a wait below 15 seconds', changes({ check_again_after_seconds: 14 })],
    ['a wait above an hour', changes({ check_again_after_seconds: 3601 })],
    ['a wait of zero', changes({ check_again_after_seconds: 0 })],
    ['a fractional wait', changes({ check_again_after_seconds: 60.5 })],
    ['a wait as text', changes({ check_again_after_seconds: '60' })],
    ['an infinite wait', changes({ check_again_after_seconds: Number.POSITIVE_INFINITY })],
    ['a null wait', changes({ check_again_after_seconds: null })],
  ])('refuses a change check with %s', (label, value) => {
    refused(() => validatePersonChangesV1(value), label);
  });

  it('refuses anything but a plain object', () => {
    for (const value of [null, undefined, 'changes', 60, [changes()]]) refused(() => validatePersonChangesV1(value), JSON.stringify(value) ?? 'undefined');
  });
});

describe('runs items scope involved (ADR-0036)', () => {
  const items = (fields: Record<string, unknown>) => ({ schema_version: 1, operation: 'items', ...fields });

  it('takes no id, like mine, and pages, reads rows and filters states as mine does', () => {
    for (const request of [
      items({ scope: 'involved' }),
      items({ scope: 'involved', read: 'rows' }),
      items({ scope: 'involved', read: 'counts' }),
      items({ scope: 'involved', cursor: 'MjAyNi0xMC0wN3xpdG1fYWJjZA', read: 'rows' }),
      items({ scope: 'involved', states: ['open', 'done', 'not_relevant'], read: 'rows' }),
    ]) {
      const validated = validatePersonRunsRequestV1(request);
      expect(validated).toEqual(request);
      expect(Object.isFrozen(validated)).toBe(true);
    }
  });

  it.each([
    ['an id', items({ scope: 'involved', id: canonicalSha256('record') })],
    ['an empty id', items({ scope: 'involved', id: '' })],
    ['counts with a cursor', items({ scope: 'involved', read: 'counts', cursor: 'next-page_2' })],
    ['counts with states', items({ scope: 'involved', read: 'counts', states: ['open'] })],
    ['an extra key', items({ scope: 'involved', handed_on: true })],
  ])('refuses involved with %s', (label, request) => {
    refused(() => validatePersonRunsRequestV1(request), label);
  });

  it('is not a sweep scope', () => {
    refused(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'sweep', scope: 'involved' }), 'a sweep of involved');
  });
});

describe('runs items changed_since (ADR-0036)', () => {
  const items = (fields: Record<string, unknown>) => ({ schema_version: 1, operation: 'items', ...fields });
  const since = '2026-10-15T23:04:13.000Z';

  it('narrows a mine or involved list, with rows, states and a cursor', () => {
    for (const request of [
      items({ scope: 'involved', changed_since: since }),
      items({ scope: 'mine', changed_since: since }),
      items({ scope: 'involved', changed_since: since, read: 'rows', states: ['done', 'not_relevant'] }),
      items({ scope: 'involved', changed_since: since, read: 'rows', states: ['done', 'not_relevant'], cursor: 'MjAyNi0xMC0wN3xpdG1fYWJjZA' }),
    ]) {
      const validated = validatePersonRunsRequestV1(request);
      expect(validated).toEqual(request);
      expect(Object.isFrozen(validated)).toBe(true);
    }
    expect(validatePersonRunsRequestV1(items({ scope: 'involved' }))).not.toHaveProperty('changed_since');
  });

  it.each([
    ['a run scope', items({ scope: 'run', id: 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc', changed_since: since })],
    ['a record scope', items({ scope: 'record', id: canonicalSha256('record'), changed_since: since })],
    ['a project scope', items({ scope: 'project', id: 'prj_00000000-0000-4000-8000-000000000003', changed_since: since })],
    ['counts', items({ scope: 'involved', changed_since: since, read: 'counts' })],
    ['a time without milliseconds', items({ scope: 'involved', changed_since: '2026-10-15T23:04:13Z' })],
    ['a time with an offset', items({ scope: 'involved', changed_since: '2026-10-15T23:04:13.000+00:00' })],
    ['a date alone', items({ scope: 'involved', changed_since: '2026-10-15' })],
    ['a time that does not exist', items({ scope: 'involved', changed_since: '2026-02-30T00:00:00.000Z' })],
    ['a number', items({ scope: 'involved', changed_since: 1792058400000 })],
    ['null', items({ scope: 'involved', changed_since: null })],
  ])('refuses changed_since with %s', (label, request) => {
    refused(() => validatePersonRunsRequestV1(request), label);
  });

  it('is not a home, item or sweep field', () => {
    refused(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'home', changed_since: since }), 'home');
    refused(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'item', item_id: 'itm_abcd', changed_since: since }), 'item');
    refused(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'sweep', scope: 'mine', changed_since: since }), 'sweep');
  });
});
