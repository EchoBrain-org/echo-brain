import { describe, expect, it } from 'vitest';
import {
  PERSON_PROJECT_ACTIVITY_KIND_V1,
  PERSON_PROJECT_ACTIVITY_LIMITS_V1,
  PERSON_PROJECT_ACTIVITY_PATH_V1,
  validatePersonProjectActivityV1,
} from '../src/index.js';

const refused = (call: () => unknown, label: string) => {
  expect(call, label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};
const project = (index: number) => `prj_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const items = [
  { project_id: project(1), latest_at: '2026-10-25T09:30:00.000Z' },
  { project_id: project(2), latest_at: null },
];
const activity = (fields: Record<string, unknown> = {}) => ({ schema_version: 1, kind: PERSON_PROJECT_ACTIVITY_KIND_V1, items, ...fields });

describe('Person project activity (Ask timeline v1, C2)', () => {
  it('names its route and kind, and bounds its items', () => {
    expect(PERSON_PROJECT_ACTIVITY_PATH_V1).toBe('/v1/person/project-activity');
    expect(PERSON_PROJECT_ACTIVITY_KIND_V1).toBe('echo-person-project-activity-v1');
    expect(PERSON_PROJECT_ACTIVITY_LIMITS_V1).toEqual({ items: 500 });
    expect(Object.isFrozen(PERSON_PROJECT_ACTIVITY_LIMITS_V1)).toBe(true);
  });

  it('accepts exactly its keys and returns a frozen copy', () => {
    const validated = validatePersonProjectActivityV1(activity());
    expect(validated).toEqual(activity());
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.items)).toBe(true);
    expect(validated.items.every(item => Object.isFrozen(item))).toBe(true);
    // No project at all, and as many as the bound allows.
    expect(validatePersonProjectActivityV1(activity({ items: [] })).items).toEqual([]);
    const most = Array.from({ length: PERSON_PROJECT_ACTIVITY_LIMITS_V1.items }, (_, index) => ({ project_id: project(index + 1), latest_at: null }));
    expect(validatePersonProjectActivityV1(activity({ items: most })).items).toHaveLength(500);
  });

  it.each([
    ['a missing schema version', (() => { const { schema_version: _version, ...rest } = activity(); return rest; })()],
    ['another schema version', activity({ schema_version: 2 })],
    ['a missing kind', (() => { const { kind: _kind, ...rest } = activity(); return rest; })()],
    ['another kind', activity({ kind: 'echo-person-changes-v1' })],
    ['an extra key', activity({ check_again_after_seconds: 60 })],
    ['missing items', (() => { const { items: _items, ...rest } = activity(); return rest; })()],
    ['items that are not a list', activity({ items: { [project(1)]: null } })],
    ['items that are null', activity({ items: null })],
    ['more than 500 items', activity({ items: Array.from({ length: 501 }, (_, index) => ({ project_id: project(index + 1), latest_at: null })) })],
    ['a project twice', activity({ items: [items[0], { ...items[0], latest_at: null }] })],
    ['an item with an extra key', activity({ items: [{ ...items[0], name: 'Pilot' }] })],
    ['an item without latest_at', activity({ items: [{ project_id: project(1) }] })],
    ['an item without project_id', activity({ items: [{ latest_at: null }] })],
    ['an item that is a string', activity({ items: [project(1)] })],
    ['an item that is null', activity({ items: [null] })],
    ['a project id that is not a project id', activity({ items: [{ project_id: 'prj_pilot', latest_at: null }] })],
    ['a project id in upper case', activity({ items: [{ project_id: project(1).toUpperCase(), latest_at: null }] })],
    ['another kind of id', activity({ items: [{ project_id: project(1).replace('prj_', 'mem_'), latest_at: null }] })],
    ['a time without milliseconds', activity({ items: [{ project_id: project(1), latest_at: '2026-10-25T09:30:00Z' }] })],
    ['a time with an offset', activity({ items: [{ project_id: project(1), latest_at: '2026-10-25T09:30:00.000+00:00' }] })],
    ['a date alone', activity({ items: [{ project_id: project(1), latest_at: '2026-10-25' }] })],
    ['a time that does not exist', activity({ items: [{ project_id: project(1), latest_at: '2026-02-30T09:30:00.000Z' }] })],
    ['a time as a number', activity({ items: [{ project_id: project(1), latest_at: 1792058400000 }] })],
    ['an empty time', activity({ items: [{ project_id: project(1), latest_at: '' }] })],
  ])('refuses project activity with %s', (label, value) => {
    refused(() => validatePersonProjectActivityV1(value), label);
  });

  it('refuses anything but a plain object, and accessors', () => {
    for (const value of [null, undefined, 'activity', 1, [activity()]]) refused(() => validatePersonProjectActivityV1(value), JSON.stringify(value) ?? 'undefined');
    const withGetter = Object.defineProperty({ schema_version: 1, kind: PERSON_PROJECT_ACTIVITY_KIND_V1 }, 'items', { get: () => items, enumerable: true });
    refused(() => validatePersonProjectActivityV1(withGetter), 'an accessor');
  });
});
