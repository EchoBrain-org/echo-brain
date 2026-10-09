import { describe, expect, it } from 'vitest';
import {
  assertCanonicalMeetingDocument,
  type MeetingDocument,
} from "../../src/core/index.js";

const source = {
  kind: 'meeting-source' as const,
  adapter_id: 'fixture-source',
  instance_id: 'primary',
  version: '2.0.0',
};

const minimalMeeting: MeetingDocument = {
  schema_version: 1,
  id: 'fixture-source:primary:meeting-1',
  provenance: {
    source,
    external_id: 'meeting-1',
    canonical_revision: 'sha256:fixture-revision',
    observed_at: '2026-07-16T20:00:00.000Z',
    normalizer_version: '2.0.0',
  },
  capture: {
    state: 'partial',
    components: [
      { kind: 'metadata', state: 'available' },
      { kind: 'transcript', state: 'not_provided' },
    ],
  },
  participants: [],
  content: [],
  artifacts: [],
};

describe('canonical meeting document validator', () => {
  it('accepts a minimal document with optional source context absent', () => {
    expect(() => assertCanonicalMeetingDocument(minimalMeeting, source)).not.toThrow();
  });

  it('accepts heterogeneous tool-agnostic context and validates its references', () => {
    const richMeeting: MeetingDocument = {
      ...minimalMeeting,
      title: 'Architecture review',
      description: 'Review the context adapter boundary.',
      lifecycle: 'completed',
      time: {
        scheduled_start_at: '2026-07-16T18:00:00.000Z',
        scheduled_end_at: '2026-07-16T19:00:00.000Z',
        timezone: 'America/Los_Angeles',
      },
      participants: [
        {
          id: 'participant-1',
          display_name: 'Operator',
          identities: [{ kind: 'email', value: 'operator@example.test' }],
          roles: ['organizer', 'speaker'],
        },
      ],
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'document',
          availability: 'available',
          mime_type: 'text/markdown',
        },
      ],
      content: [
        {
          id: 'agenda-1',
          kind: 'agenda',
          text: 'Confirm the normalized boundary.',
          author_participant_id: 'participant-1',
          artifact_id: 'artifact-1',
          origin: 'human',
        },
        {
          id: 'chat-1',
          kind: 'chat_message',
          text: 'Decision: use a stable envelope.',
          speaker_participant_id: 'participant-1',
          sequence: 0,
        },
      ],
      context: {
        owner_participant_id: 'participant-1',
        calendar: {
          event_id: 'calendar-event-1',
          organizer_participant_id: 'participant-1',
        },
        scopes: [{ kind: 'team', value: 'brain', origin: 'source' }],
        language: 'en',
      },
      governance: {
        sensitivity: 'internal',
        consent: [{ purpose: 'analysis', status: 'unknown' }],
      },
      extensions: {
        provider_specific: { retained: true },
      },
    };

    expect(() => assertCanonicalMeetingDocument(richMeeting, source)).not.toThrow();
  });

  it('rejects the removed narrow meeting shape even when it says schema version 1', () => {
    const removedShape = {
      schema_version: 1,
      id: 'legacy-meeting',
      title: 'Legacy meeting',
      occurred_at: '2026-07-16T18:00:00.000Z',
      updated_at: '2026-07-16T19:00:00.000Z',
      participants: [],
      content: [],
      provenance: {
        adapter_id: 'fixture-source',
        instance_id: 'primary',
        external_id: 'legacy-meeting',
        revision: 'legacy-revision',
        observed_at: '2026-07-16T20:00:00.000Z',
      },
    };

    expect(() => assertCanonicalMeetingDocument(removedShape, source)).toThrow();
  });

  it('rejects dangling participant and artifact references at runtime', () => {
    const invalid = {
      ...minimalMeeting,
      content: [
        {
          id: 'block-1',
          kind: 'other',
          text: 'Unresolved references are not evidence-safe.',
          speaker_participant_id: 'missing-participant',
          artifact_id: 'missing-artifact',
        },
      ],
    };

    expect(() => assertCanonicalMeetingDocument(invalid, source)).toThrow(/does not resolve/);
  });

  it('requires the canonical meeting owner to resolve', () => {
    const danglingOwner = {
      ...minimalMeeting,
      context: { owner_participant_id: 'missing-owner' },
    };

    expect(() => assertCanonicalMeetingDocument(danglingOwner, source)).toThrow(/does not resolve/);
  });

  const ownedBy = (identities: readonly { kind: string; value: string }[]) => ({
    ...minimalMeeting,
    participants: [{ id: 'owner', identities }],
    context: { owner_participant_id: 'owner' },
  });
  it.each([
    ['non-canonical', [{ kind: 'email', value: 'OWNER@example.test' }]],
    ['non-ASCII', [{ kind: 'email', value: 'rené@example.test' }]],
    ['ambiguous', [{ kind: 'email', value: 'owner@example.test' }, { kind: 'email', value: 'other@example.test' }]],
  ])('requires the canonical meeting owner to have exactly one canonical email, not a %s one', (_label, identities) => {
    expect(() => assertCanonicalMeetingDocument(ownedBy(identities), source)).toThrow(
      /one canonical email identity/,
    );
  });
});
