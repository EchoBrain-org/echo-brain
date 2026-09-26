import { describe, expect, it } from 'vitest';
import { validatePersonUpdateSubmitV1 } from '../src/person-updates.js';

const request = { schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: '00000000-0000-4000-8000-000000000001', title: 'Release update', text: 'We agreed to pause the rollout.\n' };
describe('Person update wire contracts', () => {
  it('preserves accepted whitespace and UTF-8 text exactly', () => {
    expect(validatePersonUpdateSubmitV1(request)).toEqual({ ...request, visibility: 'only_me' });
    expect(validatePersonUpdateSubmitV1({ ...request, title: 'é'.repeat(100), text: '😀'.repeat(2048) }).text).toBe('😀'.repeat(2048));
  });
  it.each([
    { title: 'é'.repeat(101) }, { text: '😀'.repeat(2049) }, { text: '\0' }, { text: '\ud800' },
    { text: 'x\u0085y' }, { text: ' ' }, { title: '  ' }, { title: 'line\nbreak' }, { text: '\n'.repeat(8191) + 'a' },
    { request_id: 'not-a-uuid' }, { schema_version: 2 }, { kind: 'update' }, { organization_id: 'org_forged' }, { reviewer: 'owner@example.com' }, { visibility: 'public' }, { visibility: null }, { metadata: { visibility: 'team' } },
  ])('rejects malformed/oversized/forged input %j', (override) => {
    expect(() => validatePersonUpdateSubmitV1({ ...request, ...override })).toThrow();
  });
});
