import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V4,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV4,
  validatePersonAnswerResponseV5,
  validatePersonEvidenceDeskResponseV1,
  validatePersonEvidenceDeskResponseV2,
} from '../src/index.js';

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
    schema_version: 5, kind: 'echo-clean-person-answer-v5', scope: { kind: 'global' }, outcome: 'answered',
    citations: [cited],
    parts: [{ question: 'When is launch?', status: 'answered', statements: [{ text: 'The ticket reports launch is Tuesday.', citation_indexes: [0], private: true }] }],
  };
}

describe('Ticket-capable answer and evidence contracts', () => {
  it('adds an explicit route while retaining the exact V3 request shape', () => {
    expect(PERSON_ANSWER_PATH_V4).toBe('/v4/person/ask');
    expect(validatePersonAnswerRequestV3({ schema_version: 3, question: 'When is launch?' })).toEqual({ schema_version: 3, question: 'When is launch?' });
    expect(() => validatePersonAnswerRequestV3({ schema_version: 3, question: 'When is launch?', connection_id: 'untrusted' })).toThrow();
  });

  it('accepts a bounded direct ticket link and preserves strict V4 compatibility', () => {
    expect(validatePersonAnswerResponseV5(response()).citations).toEqual([cited]);
    const v4 = { ...response(), schema_version: 4, kind: 'echo-clean-person-answer-v4' };
    expect(() => validatePersonAnswerResponseV4(v4)).toThrow();
    expect(() => validatePersonAnswerResponseV4(response())).toThrow();
    expect(() => validatePersonAnswerResponseV5(v4)).toThrow();
  });

  it('accepts existing approved-record and Slack citations together with tickets in V5', () => {
    const packet = response();
    const record = { citation: { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' }, kind: 'decision', label: 'Launch approval', visibility: 'team' };
    const slack = { citation: { kind: 'slack_message', team_id: 'T001', channel_id: 'C001', message_ts: '1759276800.000001', permalink: 'https://fixture.slack.com/archives/C001/p1759276800000001', text_sha256: canonicalSha256({ text: 'Launch is Tuesday.' }) }, kind: 'slack_message', label: 'Launch discussion', visibility: 'team' };
    expect(validatePersonAnswerResponseV5({ ...packet, citations: [cited, record, slack] }).citations).toHaveLength(3);
    expect(validatePersonAnswerResponseV4({ ...packet, schema_version: 4, kind: 'echo-clean-person-answer-v4', citations: [record, slack], parts: [{ question: 'When is launch?', status: 'answered', statements: [{ text: 'Launch is Tuesday.', citation_indexes: [0, 1], private: false }] }] }).citations).toHaveLength(2);
  });

  it('rejects inconsistent kinds, ticket-open references, unsafe links, duplicate coordinates and privacy mismatches', () => {
    expect(() => validatePersonAnswerResponseV5({ ...response(), citations: [{ ...cited, kind: 'decision' }] })).toThrow();
    expect(() => validatePersonAnswerResponseV5({ ...response(), citations: [{ ...cited, ref: `meeting:${canonicalSha256('record')}` }] })).toThrow();
    expect(() => validatePersonAnswerResponseV5({ ...response(), citations: [{ ...cited, citation: { ...ticket, permalink: 'https://fixture.atlassian.net/browse/ECHO-1?token=synthetic' } }] })).toThrow();
    expect(() => validatePersonAnswerResponseV5({ ...response(), citations: [cited, { ...cited, citation: { ...ticket, text_sha256: canonicalSha256('new revision') } }] })).toThrow('duplicate citations');
    expect(() => validatePersonAnswerResponseV5({ ...response(), parts: [{ question: 'When is launch?', status: 'answered', statements: [{ text: 'Launch is Tuesday.', citation_indexes: [0], private: false }] }] })).toThrow();
  });

  it('extends evidence packets for inventory metadata and released ticket bodies without widening V1', () => {
    const item = { id: 'request-owned-ticket-1', citation: { ...ticket, text_sha256: sha256Digest('') }, kind: 'ticket', label: 'ECHO-1: Launch', visibility: 'only_me', attributes: { status: 'Open', owner: 'Fixture Person' }, receipt_sha256: canonicalSha256('inventory receipt') };
    const packet = { schema_version: 2, kind: 'echo-person-evidence-desk-v2', scope: { kind: 'global' }, items: [item], truncated: false };
    expect(validatePersonEvidenceDeskResponseV2(packet).items[0]).not.toHaveProperty('text');
    expect(validatePersonEvidenceDeskResponseV2({ ...packet, items: [{ ...item, citation: ticket, text: 'ECHO-1: Launch is Tuesday.' }] }).items[0]).toHaveProperty('text');
    expect(() => validatePersonEvidenceDeskResponseV1({ ...packet, schema_version: 1, kind: 'echo-person-evidence-desk-v1' })).toThrow();
    expect(() => validatePersonEvidenceDeskResponseV2({ ...packet, items: [{ ...item, kind: 'note' }] })).toThrow();
    expect(() => validatePersonEvidenceDeskResponseV2({ ...packet, items: [{ ...item, citation: ticket, text: 'Altered ticket text.' }] })).toThrow('text digest');
    expect(() => validatePersonEvidenceDeskResponseV2({ ...packet, items: [{ ...item, citation: ticket }] })).toThrow('text digest');
  });
});
