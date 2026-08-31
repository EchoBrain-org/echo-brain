import { readFileSync } from 'node:fs';
import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  assertCanonicalMeetingDocument,
  type MeetingDocument,
} from '../../../src/processing/core/index.js';

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

const schema = JSON.parse(
  readFileSync(
    new URL('../../../../../schemas/meeting-context.v1.schema.json', import.meta.url),
    'utf8',
  ),
) as AnySchema;
const validateJsonSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe('canonical meeting-context baseline', () => {
  it('accepts a minimal document with optional source context absent', () => {
    expect(
      validateJsonSchema(minimalMeeting),
      JSON.stringify(validateJsonSchema.errors),
    ).toBe(true);
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

    expect(
      validateJsonSchema(richMeeting),
      JSON.stringify(validateJsonSchema.errors),
    ).toBe(true);
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

    expect(validateJsonSchema(removedShape)).toBe(false);
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

    expect(validateJsonSchema(invalid), JSON.stringify(validateJsonSchema.errors)).toBe(true);
    expect(() => assertCanonicalMeetingDocument(invalid, source)).toThrow(/does not resolve/);
  });

  it('requires the canonical meeting owner to resolve to exactly one canonical email', () => {
    const danglingOwner = {
      ...minimalMeeting,
      context: { owner_participant_id: 'missing-owner' },
    };
    const nonCanonicalOwnerEmail = {
      ...minimalMeeting,
      participants: [
        {
          id: 'owner',
          identities: [{ kind: 'email', value: 'OWNER@example.test' }],
        },
      ],
      context: { owner_participant_id: 'owner' },
    };
    const nonAsciiOwnerEmail = {
      ...minimalMeeting,
      participants: [
        {
          id: 'owner',
          identities: [{ kind: 'email', value: 'rené@example.test' }],
        },
      ],
      context: { owner_participant_id: 'owner' },
    };
    const ambiguousOwnerEmail = {
      ...minimalMeeting,
      participants: [
        {
          id: 'owner',
          identities: [
            { kind: 'email', value: 'owner@example.test' },
            { kind: 'email', value: 'other@example.test' },
          ],
        },
      ],
      context: { owner_participant_id: 'owner' },
    };

    expect(validateJsonSchema(danglingOwner)).toBe(true);
    expect(() => assertCanonicalMeetingDocument(danglingOwner, source)).toThrow(/does not resolve/);
    expect(validateJsonSchema(nonCanonicalOwnerEmail)).toBe(true);
    expect(() => assertCanonicalMeetingDocument(nonCanonicalOwnerEmail, source)).toThrow(
      /one canonical email identity/,
    );
    expect(validateJsonSchema(nonAsciiOwnerEmail)).toBe(true);
    expect(() => assertCanonicalMeetingDocument(nonAsciiOwnerEmail, source)).toThrow(
      /one canonical email identity/,
    );
    expect(() => assertCanonicalMeetingDocument(ambiguousOwnerEmail, source)).toThrow(
      /one canonical email identity/,
    );
  });
});
