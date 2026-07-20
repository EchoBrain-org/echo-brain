import { createHash } from 'node:crypto';
import {
  assertCanonicalDecisionBrief,
  isCanonicalTimestamp,
  type ApprovalDecision,
  type DecisionBrief,
  type JsonObject,
} from '../../core/index.js';

/**
 * A decision node is one link in the decision chain: what was decided, by
 * whom, when, why, which alternatives were considered, and how it relates to
 * other nodes. V1 records carry the full shape but leave `alternatives` empty
 * and `links` null; later revisit/branch features append new linked nodes
 * instead of rewriting existing ones.
 */
export interface DecisionNodeLinks {
  parent: string | null;
  supersedes: string | null;
}

export interface DecisionRequestedEvent {
  schema_version: 1;
  event_type: 'requested';
  node_id: string;
  processing_key: string;
  requested_at: string;
  brief: DecisionBrief;
  alternatives: readonly JsonObject[];
  links: DecisionNodeLinks;
  metadata: JsonObject;
}

export interface DecisionPublishedEvent {
  schema_version: 1;
  event_type: 'published';
  node_id: string;
  surface: string;
  posted_at: string;
  reference: JsonObject;
}

export interface DecisionResolvedEvent {
  schema_version: 1;
  event_type: 'resolved';
  node_id: string;
  status: 'approved' | 'rejected';
  reviewed_at: string;
  reviewed_by: string;
  reason: string | null;
  surface: string;
  metadata: JsonObject;
}

export interface DecisionNodeState {
  approval_id: string;
  node_id: string;
  processing_key: string;
  requested_at: string;
  requested_metadata: JsonObject;
  brief: DecisionBrief;
  alternatives: readonly JsonObject[];
  links: DecisionNodeLinks;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_at: string | null;
  reviewed_by: string | null;
  reason: string | null;
  resolved_surface: string | null;
  resolved_metadata: JsonObject | null;
  published: readonly DecisionPublishedEvent[];
}

const SURFACE_RE = /^[a-z][a-z0-9-]*$/;
const APPROVAL_ID_RE = /^[a-f0-9]{64}$/;

export function decisionApprovalId(processingKey: string): string {
  return createHash('sha256').update(processingKey).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

function invalid(file: string, detail: string): Error {
  return new Error(`invalid decision node event (${detail}): ${file}`);
}

function assertEventEnvelope(
  value: unknown,
  eventType: string,
  file: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(file, 'not an object');
  if (value['schema_version'] !== 1) throw invalid(file, 'schema_version');
  if (value['event_type'] !== eventType) throw invalid(file, 'event_type');
  if (!isNonEmptyString(value['node_id'])) throw invalid(file, 'node_id');
  return value;
}

function assertLinks(value: unknown, file: string): DecisionNodeLinks {
  if (!isPlainObject(value)) throw invalid(file, 'links');
  const parent = value['parent'];
  const supersedes = value['supersedes'];
  if (parent !== null && !isNonEmptyString(parent))
    throw invalid(file, 'links.parent');
  if (supersedes !== null && !isNonEmptyString(supersedes)) {
    throw invalid(file, 'links.supersedes');
  }
  return {
    parent: parent as string | null,
    supersedes: supersedes as string | null,
  };
}

export function assertDecisionRequestedEvent(
  value: unknown,
  file: string,
): DecisionRequestedEvent {
  const record = assertEventEnvelope(value, 'requested', file);
  if (!isNonEmptyString(record['processing_key'])) {
    throw invalid(file, 'processing_key');
  }
  if (!isCanonicalTimestamp(record['requested_at'])) {
    throw invalid(file, 'requested_at');
  }
  if (
    !Array.isArray(record['alternatives']) ||
    !record['alternatives'].every(isJsonObjectValue)
  ) {
    throw invalid(file, 'alternatives');
  }
  assertLinks(record['links'], file);
  if (!isJsonObjectValue(record['metadata'])) throw invalid(file, 'metadata');
  try {
    assertCanonicalDecisionBrief(record['brief']);
  } catch {
    throw invalid(file, 'brief');
  }
  return record as unknown as DecisionRequestedEvent;
}

export function assertDecisionPublishedEvent(
  value: unknown,
  file: string,
): DecisionPublishedEvent {
  const record = assertEventEnvelope(value, 'published', file);
  if (
    typeof record['surface'] !== 'string' ||
    !SURFACE_RE.test(record['surface'])
  ) {
    throw invalid(file, 'surface');
  }
  if (!isCanonicalTimestamp(record['posted_at']))
    throw invalid(file, 'posted_at');
  if (!isJsonObjectValue(record['reference'])) throw invalid(file, 'reference');
  return record as unknown as DecisionPublishedEvent;
}

export function assertDecisionResolvedEvent(
  value: unknown,
  file: string,
): DecisionResolvedEvent {
  const record = assertEventEnvelope(value, 'resolved', file);
  if (record['status'] !== 'approved' && record['status'] !== 'rejected') {
    throw invalid(file, 'status');
  }
  if (!isCanonicalTimestamp(record['reviewed_at']))
    throw invalid(file, 'reviewed_at');
  if (!isNonEmptyString(record['reviewed_by']))
    throw invalid(file, 'reviewed_by');
  if (record['reason'] !== null && typeof record['reason'] !== 'string') {
    throw invalid(file, 'reason');
  }
  if (
    typeof record['surface'] !== 'string' ||
    !SURFACE_RE.test(record['surface'])
  ) {
    throw invalid(file, 'surface');
  }
  if (!isJsonObjectValue(record['metadata'])) throw invalid(file, 'metadata');
  return record as unknown as DecisionResolvedEvent;
}

export interface DecisionNodeEvents {
  approval_id: string;
  requested: DecisionRequestedEvent;
  published: readonly DecisionPublishedEvent[];
  resolved?: DecisionResolvedEvent | undefined;
}

/**
 * Fold a node's immutable event slots into its current state. Slot files are
 * not chronological: a CLI resolution may exist without (or before) any
 * publication, and publications never gate resolution.
 */
export function foldDecisionNode(
  events: DecisionNodeEvents,
): DecisionNodeState {
  const { approval_id: approvalId, requested, published, resolved } = events;
  if (!APPROVAL_ID_RE.test(approvalId)) {
    throw new Error(
      'decision node approval id must be a 64-character hex digest',
    );
  }
  if (decisionApprovalId(requested.processing_key) !== approvalId) {
    throw new Error(
      `decision node identity mismatch: approval id does not match processing key digest (${approvalId})`,
    );
  }
  for (const event of [
    ...published,
    ...(resolved === undefined ? [] : [resolved]),
  ]) {
    if (event.node_id !== requested.node_id) {
      throw new Error(
        `decision node identity mismatch: event node_id diverges (${approvalId})`,
      );
    }
  }
  return {
    approval_id: approvalId,
    node_id: requested.node_id,
    processing_key: requested.processing_key,
    requested_at: requested.requested_at,
    requested_metadata: requested.metadata,
    brief: requested.brief,
    alternatives: requested.alternatives,
    links: requested.links,
    status: resolved?.status ?? 'pending',
    reviewed_at: resolved?.reviewed_at ?? null,
    reviewed_by: resolved?.reviewed_by ?? null,
    reason: resolved?.reason ?? null,
    resolved_surface: resolved?.surface ?? null,
    resolved_metadata: resolved?.metadata ?? null,
    published,
  };
}

/**
 * Project a node state onto the core `ApprovalDecision` contract. Approved
 * projections always use the brief stored on the requested event: the core
 * cycle recompiles briefs with fresh ids on every retry, and the reviewer
 * approved the stored snapshot, not a recompilation.
 */
export function toApprovalDecision(state: DecisionNodeState): ApprovalDecision {
  if (state.status === 'approved') {
    return {
      status: 'approved',
      reviewed_at: state.reviewed_at as string,
      reviewed_by: state.reviewed_by as string,
      reason: state.reason,
      approved_brief: state.brief,
    };
  }
  if (state.status === 'rejected') {
    return {
      status: 'rejected',
      reviewed_at: state.reviewed_at as string,
      reviewed_by: state.reviewed_by as string,
      reason: state.reason,
      approved_brief: null,
    };
  }
  return {
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    reason: null,
    approved_brief: null,
  };
}
