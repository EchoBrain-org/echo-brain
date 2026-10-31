import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { validatePersonAnswerCitationV6, validatePersonAnswerRequestV3, validatePersonAnswerResponseV8 } from '../src/index.js';

const ticket = {
  kind: 'ticket' as const,
  tool_id: 'jira',
  external_scope_id: '11111111-1111-4111-8111-111111111111',
  ticket_id: '10001',
  permalink: 'https://fixture.atlassian.net/browse/ECHO-1',
  text_sha256: sha256Digest('ECHO-1: Launch is Tuesday.'),
};
const cited = { citation: ticket, kind: 'ticket', label: 'ECHO-1: Launch', visibility: 'only_me' };
function response() {
  return {
    schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
    citations: [cited],
    parts: [{ question: 'When is launch?', status: 'answered', statements: [{ text: 'The ticket reports launch is Tuesday.', citation_indexes: [0], private: true }] }],
  };
}

describe('Ticket citations', () => {
  it('ride on the exact V3 request shape', () => {
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'When is launch?' })).toEqual({ schema_version: 3, question: 'When is launch?' });
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'When is launch?', connection_id: 'untrusted' })).toThrow();
  });

  it('accepts a bounded direct ticket link, in an answer and on an impact card', () => {
    expect(validatePersonAnswerResponseV8(response()).citations).toEqual([cited]);
    expect(validatePersonAnswerCitationV6(cited)).toEqual(cited);
  });

  it('accepts existing approved-record citations together with tickets', () => {
    const packet = response();
    const record = { citation: { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' }, kind: 'decision', label: 'Launch approval', visibility: 'team' };
    expect(validatePersonAnswerResponseV8({ ...packet, citations: [cited, record] }).citations).toHaveLength(2);
  });

  it('rejects inconsistent kinds, ticket-open references, unsafe links, duplicate coordinates and privacy mismatches', () => {
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [{ ...cited, kind: 'decision' }] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [{ ...cited, ref: `meeting:${canonicalSha256('record')}` }] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [{ ...cited, citation: { ...ticket, permalink: 'https://fixture.atlassian.net/browse/ECHO-1?token=synthetic' } }] })).toThrow();
    expect(() => validatePersonAnswerResponseV8({ ...response(), citations: [cited, { ...cited, citation: { ...ticket, text_sha256: canonicalSha256('new revision') } }] })).toThrow('duplicate citations');
    expect(() => validatePersonAnswerResponseV8({ ...response(), parts: [{ question: 'When is launch?', status: 'answered', statements: [{ text: 'Launch is Tuesday.', citation_indexes: [0], private: false }] }] })).toThrow();
  });
});
