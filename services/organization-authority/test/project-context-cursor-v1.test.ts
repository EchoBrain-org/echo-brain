import { describe, expect, it } from 'vitest';
import { validateProjectPageRequestV1 } from '@echo-brain/organization-api';
import {
  decodeProjectCursorV1, encodeProjectCursorV1, projectSearchTermsV1,
  type ProjectCursorScopeV1,
} from '../src/adapters/persistence/sqlite/project-context-cursor-v1.js';

const id = '00000000-0000-4000-8000-000000000001';
const scope: ProjectCursorScopeV1 = {
  operation: 'members', project_id: `prj_${id}`, limit: 10,
  organization_id: `org_${id}`, membership_id: `mem_${id}`,
};
const member = `mem_${id}`;
const time = '2026-09-21T22:01:00.000Z';

describe('project untrusted keyset cursors', () => {
  it('fits maximum public display names even when JSON escaping would double their size', () => {
    for (const name of ['"'.repeat(200), '\\'.repeat(200), 'é'.repeat(100), '🧠'.repeat(50)]) {
      const encoded = encodeProjectCursorV1(scope, [name, member]);
      expect(encoded.length).toBeLessThanOrEqual(512);
      expect(validateProjectPageRequestV1({ cursor: encoded }).cursor).toBe(encoded);
      expect(decodeProjectCursorV1(encoded, scope)).toEqual([name, member]);
      expect(Buffer.from(encoded, 'base64url').subarray(33).toString('utf8')).toBe(`${name}\0${member}`);
    }
  });

  it('binds each operation, project, query, limit, organization and tenure without binding a session or revision', () => {
    const encoded = encodeProjectCursorV1(scope, ['Ari', member]);
    for (const change of [
      { operation: 'directory' as const }, { project_id: `prj_${id.slice(0, -1)}2` },
      { canonical_query: 'ari' }, { limit: 1 }, { organization_id: 'other' }, { membership_id: 'rejoined' },
    ]) expect(() => decodeProjectCursorV1(encoded, { ...scope, ...change })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(decodeProjectCursorV1(undefined, scope)).toBeUndefined();
    expect(decodeProjectCursorV1(encoded, scope)).toEqual(['Ari', member]);
  });

  it('keeps an unfiltered directory continuation distinct from a searched one', () => {
    const directory = { ...scope, operation: 'directory' as const };
    const unfiltered = encodeProjectCursorV1(directory, ['Ari', member]);
    expect(decodeProjectCursorV1(unfiltered, directory)).toEqual(['Ari', member]);
    expect(() => decodeProjectCursorV1(unfiltered, { ...directory, canonical_query: 'ari' }))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('rejects noncanonical encodings, malformed UTF-8 and invalid ordering coordinates', () => {
    const encoded = encodeProjectCursorV1(scope, ['Ari', member]);
    const raw = Buffer.from(encoded, 'base64url');
    const withPosition = (text: string) => Buffer.concat([raw.subarray(0, 33), Buffer.from(text)]).toString('base64url');
    const invalidUtf8 = Buffer.concat([raw.subarray(0, 33), Buffer.from([0xff, 0]), Buffer.from(member)]).toString('base64url');
    for (const value of ['', 'a', encoded + '=', encoded + '\n', 'a'.repeat(513), invalidUtf8,
      withPosition(`Ari\0bad`), withPosition(`\0${member}`), withPosition(`Ari\n\0${member}`), withPosition(`Ari\0${member}\0extra`)]) {
      expect(() => decodeProjectCursorV1(value, scope)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    }
  });

  it('carries only public time/id/score ordering coordinates for projects, feeds and search', () => {
    for (const operation of ['project_list', 'feed', 'search'] as const) {
      const scoped = { ...scope, operation };
      const key = operation === 'project_list' ? `prj_${id}` : `ctx_${'a'.repeat(64)}`;
      const position = operation === 'search' ? [4, time, key] as const : [time, key] as const;
      expect(decodeProjectCursorV1(encodeProjectCursorV1(scoped, position), scoped)).toEqual(position);
      expect(() => encodeProjectCursorV1(scoped, ['2026-02-30T00:00:00.000Z', key])).toThrow();
    }
    expect(() => encodeProjectCursorV1({ ...scope, operation: 'search' }, [-1, time, `ctx_${'a'.repeat(64)}`])).toThrow();
  });

  it('preserves the existing lexical normalization and unique term semantics', () => {
    expect(projectSearchTermsV1('Cafe\u0301 CAFÉ, plan 123 plan')).toEqual(['café', 'plan', '123']);
  });
});
