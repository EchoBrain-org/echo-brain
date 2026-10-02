import { describe, expect, it } from 'vitest';
import { validatePersonTicketCitationV1 } from '../src/person-ticket-citation-v1.js';
import { validatePersonEvidenceDeskResponseV1, validatePersonSlackMessageCitationV1 } from '../src/person-answer-v4.js';

const citation = { kind: 'ticket', tool_id: 'tickets', external_scope_id: 'tenant-1', ticket_id: 'ECHO-42', permalink: 'https://tickets.example.test/browse/ECHO-42', text_sha256: `sha256:${'a'.repeat(64)}` };

describe('Live ticket citation V1', () => {
  it('validates opaque coordinates without imposing a particular ticket provider', () => {
    expect(validatePersonTicketCitationV1(citation)).toEqual(citation);
    expect(Object.isFrozen(validatePersonTicketCitationV1(citation))).toBe(true);
    expect(validatePersonTicketCitationV1({ ...citation, tool_id: 'another-ticket-tool', ticket_id: 'issue/42' }).ticket_id).toBe('issue/42');
  });

  it('rejects credential links, malformed URLs, raw response extensions and noncanonical coordinates', () => {
    for (const permalink of ['http://tickets.example.test/42', 'https://user:pass@tickets.example.test/42', 'https://tickets.example.test/42?token=secret', 'https://tickets.example.test/42#secret', 'https://tickets.example.test:99999/42', 'https://tickets.example.test/\n42']) {
      expect(() => validatePersonTicketCitationV1({ ...citation, permalink })).toThrow();
    }
    for (const value of [{ ...citation, kind: 'issue' }, { ...citation, body: 'raw ticket content' }, { ...citation, ticket_id: '' }, { ...citation, ticket_id: 'e\u0301' }, { ...citation, text_sha256: 'sha256:invalid' }]) {
      expect(() => validatePersonTicketCitationV1(value)).toThrow();
    }
  });

  it('keeps the released evidence schema closed until a separate version admits tickets', () => {
    expect(() => validatePersonEvidenceDeskResponseV1({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false,
      items: [{ id: 'desk_ticket', kind: 'ticket', citation, label: 'ECHO-42', visibility: 'only_me', receipt_sha256: citation.text_sha256 }],
    })).toThrow();
    expect(() => validatePersonSlackMessageCitationV1(citation)).toThrow();
  });
});
