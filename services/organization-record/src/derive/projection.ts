import { canonicalJson } from '@echo-brain/federation-protocol';
import type {
  DerivedAtomRow,
  DerivedEdgeRow,
  DerivedMeetingSnapshotRow,
  DerivedParticipantObservationRow,
  DerivedRejectionRow,
  JsonObject,
  JsonValue,
  OrganizationRecordLogRow,
  OrganizationRecordProjection,
} from '../application/contracts.js';
import { OrganizationRecordDeriveError } from '../application/errors.js';
import { parseOrganizationRecordEnvelope } from '../application/record-frame.js';
import {
  readReviewerRestrictedEnvelope,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';
import {
  derivedApprovalGroupId,
  derivedAtomId,
  derivedMeetingSnapshotId,
  derivedParticipantObservationId,
  derivedRejectionId,
} from './identity.js';

/**
 * The log-content reader derive projects from.
 *
 * It reads only what the derived graph records, from the stored canonical
 * envelope bytes and nothing else — never the verified view the append path
 * held, never authority state. That is what makes a rebuild reproducible.
 *
 * It is a *reader*, not a validator: `packages/organization-protocol` owns the
 * envelope and payload schemas, and ingest rejects an invalid payload before
 * append. What is left here is fail-closed shape reading, so a record that
 * somehow reached the log without being derivable halts the follower instead
 * of being silently skipped.
 */

const SIGNAL_GROUPS = [
  ['decisions', 'decision'],
  ['actions', 'action'],
  ['rationales', 'rationale'],
] as const;

type AtomKind = (typeof SIGNAL_GROUPS)[number][1];

function fail(position: number, detail: string): never {
  throw new OrganizationRecordDeriveError(position, detail);
}

/**
 * Collapses edges that repeat their whole identity, first occurrence winning.
 *
 * A rationale may legitimately name the same sibling twice in
 * `supports_signal_ids`, which yields the same `supports` edge twice. That is
 * valid log content, so it is resolved here — deterministically, in the pure
 * projector, over a deterministic input order — rather than by a lenient
 * insert that would also swallow a genuine conflict at the storage layer.
 */
function deduplicateEdges(edges: readonly DerivedEdgeRow[]): DerivedEdgeRow[] {
  const seen = new Set<string>();
  const unique: DerivedEdgeRow[] = [];
  for (const edge of edges) {
    const identity = `${edge.edge_type}\u0000${edge.from_id}\u0000${edge.to_id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(edge);
  }
  return unique;
}

function object(value: JsonValue | undefined, position: number, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(position, `${path} is not an object`);
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, position: number, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) fail(position, `${path} is not an array`);
  return value;
}

function text(value: JsonValue | undefined, position: number, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(position, `${path} is not a non-empty string`);
  }
  return value;
}

function optionalText(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sourceLocator(
  value: JsonValue | undefined,
  position: number,
  path: string,
): { adapter_id: string; instance_id: string; external_id: string } {
  const source = object(value, position, path);
  return {
    adapter_id: text(source['adapter_id'], position, `${path}.adapter_id`),
    instance_id: text(source['instance_id'], position, `${path}.instance_id`),
    external_id: text(source['external_id'], position, `${path}.external_id`),
  };
}

function participantObservation(
  participant: JsonValue,
  snapshotId: string,
  position: number,
  index: number,
): DerivedParticipantObservationRow {
  const path = `payload.brief.meeting.participants[${index}]`;
  const record = object(participant, position, path);
  const identities = record['identities'];
  const roles = record['roles'];
  return {
    // The whole approved participant value is the identity input, so any
    // captured fact that differs makes a different observation. Two identical
    // entries are not valid input — the organization-record protocol requires
    // meeting participant ids to be unique — so they are left to conflict at
    // the strict insert and halt the follower instead of being deduplicated.
    observation_id: derivedParticipantObservationId(snapshotId, participant),
    snapshot_id: snapshotId as DerivedParticipantObservationRow['snapshot_id'],
    participant_id: text(record['id'], position, `${path}.id`),
    display_name: optionalText(record['display_name']),
    identities: canonicalJson(identities === undefined ? [] : identities),
    roles: canonicalJson(roles === undefined ? [] : roles),
    response_status: optionalText(record['response_status']),
    attendance: optionalText(record['attendance']),
  };
}

function approvalProjection(
  row: OrganizationRecordLogRow,
  envelope: JsonObject,
): OrganizationRecordProjection {
  const position = row.position;
  const payload = object(envelope['payload'], position, 'payload');
  const reviewer = object(envelope['reviewer'], position, 'reviewer');
  const intent = object(envelope['intent'], position, 'intent');
  const brief = object(payload['brief'], position, 'payload.brief');
  const meeting = object(brief['meeting'], position, 'payload.brief.meeting');
  const provenance = object(brief['provenance'], position, 'payload.brief.provenance');
  const source = sourceLocator(payload['source'], position, 'payload.source');

  const reviewerPrincipalId = text(reviewer['principal_id'], position, 'reviewer.principal_id');
  const reviewerDisplayName = optionalText(reviewer['reviewed_by']);
  const reviewedAt = text(payload['reviewed_at'], position, 'payload.reviewed_at');
  const restricted = intent['restricted'] === true ? 1 : 0;
  const approvalGroup = derivedApprovalGroupId(row.installation_id, row.idempotency_key);

  const meetingId = text(meeting['id'], position, 'payload.brief.meeting.id');
  const meetingRevision = text(
    provenance['meeting_revision'],
    position,
    'payload.brief.provenance.meeting_revision',
  );
  const snapshotId = derivedMeetingSnapshotId(row.record_hash, meetingId, meetingRevision);
  const meetingTime = meeting['time'];
  const snapshot: DerivedMeetingSnapshotRow = {
    snapshot_id: snapshotId,
    log_position: position,
    record_hash: row.record_hash,
    meeting_id: meetingId,
    meeting_revision: meetingRevision,
    source_adapter_id: source.adapter_id,
    source_instance_id: source.instance_id,
    source_external_id: source.external_id,
    title: optionalText(meeting['title']),
    meeting_time: meetingTime === undefined ? null : canonicalJson(meetingTime),
  };

  const observations = array(
    meeting['participants'],
    position,
    'payload.brief.meeting.participants',
  ).map((participant, index) =>
    participantObservation(participant, snapshotId, position, index),
  );

  const atoms: DerivedAtomRow[] = [];
  const atomIdBySignalId = new Map<string, string>();
  const rationaleLinks: { atom_id: string; supports: readonly JsonValue[] }[] = [];

  for (const [field, kind] of SIGNAL_GROUPS) {
    const signals = array(brief[field], position, `payload.brief.${field}`);
    for (const [index, value] of signals.entries()) {
      const path = `payload.brief.${field}[${index}]`;
      const signal = object(value, position, path);
      if (signal['kind'] !== kind) fail(position, `${path}.kind is not '${kind}'`);
      const signalId = text(signal['id'], position, `${path}.id`);
      if (atomIdBySignalId.has(signalId)) {
        fail(position, `${path}.id repeats signal id ${signalId}`);
      }
      const atomId = derivedAtomId(row.record_hash, signalId);
      atomIdBySignalId.set(signalId, atomId);
      const evidence = signal['evidence'];
      atoms.push({
        atom_id: atomId,
        log_position: position,
        record_hash: row.record_hash,
        approval_group: approvalGroup,
        signal_id: signalId,
        kind: kind as AtomKind,
        text: text(signal['text'], position, `${path}.text`),
        subject: optionalText(signal['subject']),
        status: kind === 'decision' ? optionalText(signal['status']) : null,
        owner: kind === 'action' ? optionalText(signal['owner']) : null,
        due_at: kind === 'action' ? optionalText(signal['due_at']) : null,
        confidence: optionalNumber(signal['confidence']),
        evidence: canonicalJson(evidence === undefined ? [] : evidence),
        restricted: restricted as 0 | 1,
        reviewer_principal_id: reviewerPrincipalId,
        reviewer_display_name: reviewerDisplayName,
        reviewed_at: reviewedAt,
      });
      if (kind === 'rationale') {
        rationaleLinks.push({
          atom_id: atomId,
          supports: array(signal['supports_signal_ids'], position, `${path}.supports_signal_ids`),
        });
      }
    }
  }

  const edges: DerivedEdgeRow[] = [];
  for (const atom of atoms) {
    edges.push({
      edge_type: 'derived-from',
      from_id: atom.atom_id,
      to_id: row.record_hash,
      log_position: position,
    });
    edges.push({
      edge_type: 'from-meeting',
      from_id: atom.atom_id,
      to_id: snapshotId,
      log_position: position,
    });
  }
  for (const observation of observations) {
    edges.push({
      edge_type: 'listed-participant',
      from_id: snapshotId,
      to_id: observation.observation_id,
      log_position: position,
    });
    // Only an explicit approved 'attended' fact makes an attendance edge.
    if (observation.attendance === 'attended') {
      edges.push({
        edge_type: 'attended-by',
        from_id: snapshotId,
        to_id: observation.observation_id,
        log_position: position,
      });
    }
  }
  for (const link of rationaleLinks) {
    for (const supported of link.supports) {
      const supportedId = typeof supported === 'string' ? supported : '';
      const target = atomIdBySignalId.get(supportedId);
      // A rationale may only support a sibling of the same approval, which is
      // what keeps derive v1's one cross-atom edge inside a single audience.
      if (target === undefined) {
        fail(position, `rationale supports unknown sibling signal ${supportedId}`);
      }
      edges.push({
        edge_type: 'supports',
        from_id: link.atom_id,
        to_id: target,
        log_position: position,
      });
    }
  }

  return {
    log_position: position,
    record_hash: row.record_hash,
    atoms,
    meeting_snapshots: [snapshot],
    participant_observations: observations,
    rejections: [],
    edges: deduplicateEdges(edges),
    reviewer_policy_exclusions: [],
  };
}

function rejectionProjection(
  row: OrganizationRecordLogRow,
  envelope: JsonObject,
): OrganizationRecordProjection {
  const position = row.position;
  const payload = object(envelope['payload'], position, 'payload');
  const reviewer = object(envelope['reviewer'], position, 'reviewer');
  const source = sourceLocator(payload['source'], position, 'payload.source');
  const rejection: DerivedRejectionRow = {
    rejection_id: derivedRejectionId(row.record_hash),
    log_position: position,
    record_hash: row.record_hash,
    meeting_id: text(payload['meeting_id'], position, 'payload.meeting_id'),
    source_adapter_id: source.adapter_id,
    source_instance_id: source.instance_id,
    source_external_id: source.external_id,
    reviewer_principal_id: text(reviewer['principal_id'], position, 'reviewer.principal_id'),
    reviewer_display_name: optionalText(reviewer['reviewed_by']),
    rejected_at: text(payload['rejected_at'], position, 'payload.rejected_at'),
    reason: optionalText(payload['reason']),
    reconsider_after: optionalText(payload['reconsider_after']),
  };
  return {
    log_position: position,
    record_hash: row.record_hash,
    atoms: [],
    meeting_snapshots: [],
    participant_observations: [],
    rejections: [rejection],
    edges: deduplicateEdges([
      {
        edge_type: 'derived-from',
        from_id: rejection.rejection_id,
        to_id: row.record_hash,
        log_position: position,
      },
    ]),
    reviewer_policy_exclusions: [],
  };
}

/**
 * The one text-free outcome a valid reviewer-v2 approval produces. Its broad
 * v1 collections are all empty, so no reviewer-v2 content can reach the tables
 * the landed follower serves from.
 *
 * Validity is decided by exactly the same injected closed validator the append
 * path uses; derive owns no second, looser reading of a durable v2 document.
 * Anything it rejects halts the follower with the cursor unchanged.
 */
function reviewerExclusionProjection(
  row: OrganizationRecordLogRow,
  envelope: JsonObject,
  validate: ReviewerRestrictedEnvelopeValidator | undefined,
): OrganizationRecordProjection {
  const position = row.position;
  // The indexed event type and the frame's own event type must be the same
  // fact. A row whose column says `rejection` cannot derive as the approval
  // its bytes claim, and a v2 frame admits approval only.
  if (envelope['event_type'] !== row.event_type) {
    return fail(
      position,
      'envelope event type does not match its indexed event type',
    );
  }
  if (row.event_type !== 'approval') {
    return fail(position, 'envelope schema version 2 admits approval only');
  }
  if (validate === undefined) {
    return fail(
      position,
      'reviewer-v2 derive requires the injected closed reviewer validator',
    );
  }
  try {
    readReviewerRestrictedEnvelope(envelope, validate);
  } catch (error) {
    return fail(
      position,
      error instanceof Error
        ? error.message
        : 'reviewer envelope failed closed reviewer-v2 validation',
    );
  }
  return {
    log_position: position,
    record_hash: row.record_hash,
    atoms: [],
    meeting_snapshots: [],
    participant_observations: [],
    rejections: [],
    edges: [],
    reviewer_policy_exclusions: [
      {
        log_position: position,
        record_hash: row.record_hash,
        envelope_version: 2,
        policy_id: 'restricted-reviewer-v1',
        outcome: 'deferred-to-permission-aware-retrieval',
      },
    ],
  };
}

/**
 * Strict envelope dispatch.
 *
 * The exact `(kind, schema_version)` pair selects one closed family before any
 * event, intent, or payload field is interpreted. Version 1 keeps its landed
 * behavior byte for byte. Version 2 produces exactly one exclusion row.
 * Everything else halts the follower rather than being skipped: visible
 * staleness is the designed behavior.
 */
export function projectOrganizationRecord(
  row: OrganizationRecordLogRow,
  reviewerValidator?: ReviewerRestrictedEnvelopeValidator,
): OrganizationRecordProjection {
  let envelope: JsonObject;
  try {
    envelope = parseOrganizationRecordEnvelope(row.canonical_envelope);
  } catch (error) {
    return fail(
      row.position,
      `stored envelope bytes are not canonical JSON: ${(error as Error).message}`,
    );
  }
  const kind = envelope['kind'];
  if (kind !== undefined && kind !== 'echo-organization-record-envelope') {
    return fail(row.position, `unsupported envelope kind ${String(kind)}`);
  }
  const schemaVersion = envelope['schema_version'];
  if (schemaVersion === 2) {
    return reviewerExclusionProjection(row, envelope, reviewerValidator);
  }
  if (schemaVersion !== 1) {
    return fail(
      row.position,
      `unsupported envelope schema version ${String(schemaVersion)}`,
    );
  }
  if (row.event_type === 'approval') return approvalProjection(row, envelope);
  if (row.event_type === 'rejection') return rejectionProjection(row, envelope);
  return fail(row.position, `unsupported event type ${String(row.event_type)}`);
}
