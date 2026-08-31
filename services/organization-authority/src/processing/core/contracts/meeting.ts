import type { AdapterIdentity } from './adapter.js';
import type { JsonObject } from './json.js';

export type AdapterCursor = string;

export const MEETING_CONTEXT_SCHEMA_VERSION = 1 as const;

export type MeetingLifecycle =
  | 'scheduled'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'deleted'
  | 'unknown';

export interface MeetingTime {
  scheduled_start_at?: string;
  scheduled_end_at?: string;
  actual_start_at?: string;
  actual_end_at?: string;
  timezone?: string;
  all_day?: boolean;
}

export type MeetingCaptureStateValue =
  | 'complete'
  | 'partial'
  | 'processing'
  | 'unavailable'
  | 'deleted';

export type MeetingCaptureComponentKind =
  | 'metadata'
  | 'participants'
  | 'agenda'
  | 'summary'
  | 'notes'
  | 'transcript'
  | 'chat'
  | 'recording'
  | 'attachments'
  | 'artifacts'
  | 'other';

export type MeetingCaptureComponentState =
  | 'available'
  | 'empty'
  | 'pending'
  | 'not_provided'
  | 'forbidden'
  | 'failed';

export interface MeetingCaptureComponent {
  kind: MeetingCaptureComponentKind;
  state: MeetingCaptureComponentState;
  reason?: string;
  metadata?: Readonly<JsonObject>;
}

export interface MeetingCaptureState {
  state: MeetingCaptureStateValue;
  components: readonly MeetingCaptureComponent[];
  warnings?: readonly string[];
}

export type MeetingParticipantIdentityKind = 'source' | 'email' | 'phone' | 'other';

export interface MeetingParticipantIdentity {
  kind: MeetingParticipantIdentityKind;
  value: string;
}

export type MeetingParticipantRole =
  | 'organizer'
  | 'host'
  | 'invitee'
  | 'attendee'
  | 'speaker'
  | 'note_taker'
  | 'bot';

export interface MeetingParticipant {
  /** Stable within this meeting document and used by content-block references. */
  id: string;
  display_name?: string;
  identities?: readonly MeetingParticipantIdentity[];
  roles?: readonly MeetingParticipantRole[];
  response_status?: 'accepted' | 'declined' | 'tentative' | 'unknown';
  attendance?: 'attended' | 'no_show' | 'unknown';
  organization?: {
    name?: string;
    domain?: string;
  };
  is_external?: boolean;
  metadata?: Readonly<JsonObject>;
}

export type MeetingContentKind =
  | 'summary'
  | 'note'
  | 'agenda'
  | 'transcript'
  | 'caption'
  | 'chat_message'
  | 'chapter'
  | 'provider_action_item'
  | 'provider_decision'
  | 'artifact_text'
  | 'other';

export interface MeetingContentBlock {
  id: string;
  kind: MeetingContentKind;
  text: string;
  artifact_id?: string;
  author_participant_id?: string;
  speaker_participant_id?: string;
  sequence?: number;
  started_at?: string;
  ended_at?: string;
  start_offset_ms?: number;
  end_offset_ms?: number;
  language?: string;
  confidence?: number;
  origin?: 'human' | 'source_ai' | 'imported' | 'unknown';
  source_external_id?: string;
  metadata?: Readonly<JsonObject>;
}

export type MeetingArtifactKind =
  | 'audio'
  | 'video'
  | 'transcript'
  | 'document'
  | 'slides'
  | 'whiteboard'
  | 'chat'
  | 'image'
  | 'attachment'
  | 'link'
  | 'raw_payload'
  | 'other';

export interface MeetingArtifact {
  id: string;
  kind: MeetingArtifactKind;
  availability:
    | 'available'
    | 'pending'
    | 'forbidden'
    | 'missing'
    | 'expired'
    | 'redacted'
    | 'unknown';
  title?: string;
  mime_type?: string;
  language?: string;
  external_id?: string;
  source_url?: string;
  content_hash?: string;
  metadata?: Readonly<JsonObject>;
}

export interface MeetingContext {
  /**
   * The person responsible for this meeting, when the source can establish
   * that identity. This is deliberately separate from the calendar organizer:
   * ad-hoc meetings may have an owner without a calendar event.
   */
  owner_participant_id?: string;
  calendar?: {
    event_id?: string;
    series_id?: string;
    recurrence_id?: string;
    organizer_participant_id?: string;
  };
  location?: {
    kind?: 'virtual' | 'physical' | 'hybrid';
    name?: string;
    join_reference?: string;
  };
  scopes?: readonly {
    kind: 'domain' | 'team' | 'project' | 'customer' | 'topic';
    value: string;
    origin: 'source' | 'adapter_config';
  }[];
  labels?: readonly string[];
  language?: string;
  meeting_type?: string;
  metadata?: Readonly<JsonObject>;
}

export interface MeetingGovernance {
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  consent?: readonly {
    purpose: 'recording' | 'transcription' | 'analysis' | 'distribution';
    status: 'granted' | 'denied' | 'unknown' | 'not_required';
    recorded_at?: string;
    source_reference?: string;
  }[];
  retention_until?: string;
  deletion_requested_at?: string;
  redaction_state?: 'none' | 'partial' | 'full';
  metadata?: Readonly<JsonObject>;
}

export interface MeetingProvenance {
  source: AdapterIdentity & { kind: 'meeting-source' };
  external_id: string;
  canonical_revision: string;
  observed_at: string;
  normalizer_version: string;
  source_revision?: string;
  previous_revision?: string;
  source_created_at?: string;
  source_updated_at?: string;
  source_url?: string;
  metadata?: Readonly<JsonObject>;
}

/**
 * Canonical tool-agnostic meeting context baseline.
 *
 * Only identity, provenance, capture state, and the three evidence-bearing
 * collections are required. Adapters preserve whichever optional context their
 * source can actually provide; missing source facts remain absent.
 */
export interface MeetingDocument {
  schema_version: typeof MEETING_CONTEXT_SCHEMA_VERSION;
  id: string;
  provenance: MeetingProvenance;
  capture: MeetingCaptureState;
  participants: readonly MeetingParticipant[];
  content: readonly MeetingContentBlock[];
  artifacts: readonly MeetingArtifact[];
  title?: string;
  description?: string;
  lifecycle?: MeetingLifecycle;
  time?: MeetingTime;
  context?: MeetingContext;
  governance?: MeetingGovernance;
  extensions?: Readonly<JsonObject>;
}

export interface MeetingPullRequest {
  cursor?: AdapterCursor;
  limit?: number;
}

export interface MeetingBatch {
  meetings: readonly MeetingDocument[];
  next_cursor?: AdapterCursor;
}
