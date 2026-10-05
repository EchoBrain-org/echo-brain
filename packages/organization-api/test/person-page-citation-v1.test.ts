import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { validatePersonPageCitationV1 } from '../src/person-page-citation-v1.js';

const citation = {
  kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-123', page_id: 'page-456', section_id: 's2', version: '42',
  permalink: 'https://knowledge.example.test/wiki/pages/viewpage.action?pageId=456', text_sha256: canonicalSha256('A bounded live section.'),
};

describe('Live page citation V1', () => {
  it('uses a stable provider-neutral page and section coordinate', () => {
    expect(validatePersonPageCitationV1(citation)).toEqual(citation);
    expect(Object.isFrozen(validatePersonPageCitationV1(citation))).toBe(true);
    expect(validatePersonPageCitationV1({ ...citation, section_id: 'inventory', text_sha256: canonicalSha256('') }).section_id).toBe('inventory');
  });

  it('rejects noncanonical coordinates, unsafe links and raw provider fields', () => {
    for (const value of [
      { ...citation, permalink: 'http://knowledge.example.test/pages/456' },
      { ...citation, permalink: 'https://person:secret@knowledge.example.test/pages/456' },
      { ...citation, permalink: 'https://knowledge.example.test/pages/456#section-2' },
      { ...citation, page_id: '' }, { ...citation, section_id: 's\n2' }, { ...citation, version: 'e\u0301' },
      { ...citation, body: 'live page text' },
    ]) expect(() => validatePersonPageCitationV1(value)).toThrow();
  });
});
