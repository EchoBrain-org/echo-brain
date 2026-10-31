import { describe, expect, it } from 'vitest';
import { meetingSourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import { granolaMcpMeetingContentV1, type GranolaMeetingV1 } from '../src/granola-mcp-v1.js';
import { normalizeGranolaMeetingV1 } from '../src/granola-meeting-normalizer-v1.js';

// Golden values from the 2.4.0 mapping: a changed revision would import every watched meeting again.
const id = '00000000-0000-4000-8000-000000000001';
const url = `https://notes.granola.ai/d/${id}`;
const source = { kind: 'meeting-source' as const, adapter_id: 'granola-person-mcp', instance_id: 'granola-fixture', version: '1.0.0' };
const known = 'Zhen Ye (note creator) from Acme <zhen@acme.com>, Pat Lee <pat@y.com>, pat lee, Dana';
const meeting: GranolaMeetingV1 = { id, title: 'Beta launch', date: 'Oct 2, 2026 8:08 PM PDT', url, known_participants: known,
  private_notes: '- Ship beta Friday', summary: '### Decisions\n- Ship the beta on Friday' };
const transcript = { text: 'Microphone: We ship Friday.\n\nSystem audio: Agreed.', created_at: '2026-10-03T03:40:00.000Z' };
type Transcript = Parameters<typeof granolaMcpMeetingContentV1>[1];
const normalize = (value: GranolaMeetingV1 = meeting, text: Transcript = transcript, observedAt = '2026-10-06T00:00:00.000Z') =>
  normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(value, text), source, observedAt);
/** The revision, and the digest of the whole document but its observation time. */
function digests(value: GranolaMeetingV1, text: Transcript, observedAt?: string): string[] {
  const document = normalize(value, text, observedAt);
  return [document.provenance.canonical_revision, meetingSourceEnvelopeV1(document).revision.content_sha256];
}

describe('Granola meeting normalization of MCP content', () => {
  it('maps an MCP meeting to its exact document and revision', () => {
    const state = (kind: string, value: string) => ({ kind, state: value });
    expect(normalize()).toEqual({
      schema_version: 1, id: `granola:granola-fixture:${id}`, title: 'Beta launch',
      time: { actual_start_at: '2026-10-03T03:08:00.000Z', timezone: 'America/Los_Angeles' },
      // Reported people get no role, and a repeated name joins its first entry.
      participants: [
        { id: 'email:zhen@acme.com', display_name: 'Zhen Ye', identities: [{ kind: 'email', value: 'zhen@acme.com' }] },
        { id: 'email:pat@y.com', display_name: 'Pat Lee', identities: [{ kind: 'email', value: 'pat@y.com' }] },
        { id: 'name:sha256:2c9e0a2585dc7406589a3724f0027811506e0f133726303a15d6779d532a2573', display_name: 'Dana' },
      ],
      content: [
        { id: `${id}:notes`, kind: 'note', text: '- Ship beta Friday', origin: 'human', metadata: { format: 'markdown' } },
        { id: `${id}:summary`, kind: 'summary', text: '### Decisions\n- Ship the beta on Friday', origin: 'source_ai', metadata: { format: 'markdown' } },
        { id: `${id}:transcript:0`, kind: 'transcript', text: transcript.text, sequence: 0, origin: 'imported',
          metadata: { source_index: 0, granola: { speaker_resolution: 'unresolved' } } },
      ],
      artifacts: [],
      capture: {
        state: 'complete',
        components: [
          state('metadata', 'available'), state('participants', 'available'), state('summary', 'available'),
          state('transcript', 'available'), state('agenda', 'not_provided'), state('notes', 'available'),
          state('chat', 'not_provided'), state('recording', 'not_provided'), state('attachments', 'not_provided'),
          state('artifacts', 'empty'),
        ],
        warnings: ['Some Granola transcript turns did not include usable speaker metadata.'],
      },
      provenance: {
        source, external_id: id, canonical_revision: 'sha256:b8bd78084927ceb61fa53f6f079388e2e28c6289c88df2559a6f6398150d97d9',
        observed_at: '2026-10-06T00:00:00.000Z', normalizer_version: '2.4.0', source_created_at: '2026-10-03T03:40:00.000Z', source_url: url,
      },
      extensions: { granola: { provider_fields: { mcp_date_label: meeting.date, mcp_known_participants: known } } },
    });
  });
  it.each([
    ['an untitled meeting without a transcript', { ...meeting, title: null }, null,
      'sha256:c94c1903e0a28bdf358da6473a9332736f1735e6fd5c7603e256b9025ec829a4', '881d5c118db4be6e746e315e7fe7c5bdf5e4e86f0db3ca423f79e94c99267eff'],
    ['empty notes, summary and transcript', { ...meeting, private_notes: '', summary: '' }, { ...transcript, text: ' ' },
      'sha256:cbdaa01f603dbe03a931b873b1cfa6a945f6ea0b45b850ab6c3a59d9af667903', 'c6f09d4a8f0fd799a476033224474273cd11ee54bad6e70ff5f66de7af359cd6'],
    ['a list row with an unreadable date label', { id, title: 'Standup', date: 'Oct 6, 2026', url, known_participants: '' }, undefined,
      'sha256:f5a42b954387b6c01bed9aaf83a3aa3c243355159784a97f28a27ebcd11abd99', '6b61f99ea694f33053dd6a46175f8cdcfc9b613997002ccfd3e04b4287e8484a'],
  ] as const)('keeps the revision and document digest of %s', (_name, value, text, revision, content) => {
    expect(digests(value, text)).toEqual([revision, content]);
  });
  it('keeps both digests across observations, and changes the revision with each mapped field', () => {
    const [revision] = digests(meeting, transcript);
    expect(digests(meeting, transcript, '2026-10-07T00:00:00.000Z')).toEqual(digests(meeting, transcript));
    for (const [value, text] of [
      [{ ...meeting, title: 'Beta' }, transcript], [{ ...meeting, date: 'Oct 2, 2026 8:09 PM PDT' }, transcript],
      [{ ...meeting, known_participants: 'Dana' }, transcript], [meeting, { ...transcript, text: 'Microphone: We ship Monday.' }], [meeting, null],
    ] as const) expect(normalize(value, text).provenance.canonical_revision).not.toBe(revision);
  });
});
