import { canonicalJson, canonicalSha256 } from '../foundation/canonical-json.js';
import type { FederatedEventV1 } from '../contracts.js';

type ApprovalGroupEvent = Omit<
  FederatedEventV1,
  'sequence' | 'previous_event_hash' | 'integrity'
>;
type SignalKind = ApprovalGroupEvent['record']['kind'];
type SignalOrder = readonly [number, number];
type ManifestViolation =
  | 'duplicate-signal-id'
  | 'non-contiguous-position'
  | 'non-canonical-order';

function kindOrder(kind: SignalKind): number {
  return kind === 'decision' ? 0 : kind === 'action' ? 1 : 2;
}

function follows(previous: SignalOrder | undefined, current: SignalOrder) {
  return (
    previous === undefined ||
    current[0] > previous[0] ||
    (current[0] === previous[0] && current[1] > previous[1])
  );
}

export function analyzeApprovalSignal(event: ApprovalGroupEvent) {
  const seen = new Set<string>();
  const next = new Map<SignalKind, number>([
    ['decision', 0],
    ['action', 0],
    ['rationale', 0],
  ]);
  let previous: SignalOrder | undefined;
  let first: ManifestViolation | null = null;
  let ordering: Exclude<ManifestViolation, 'duplicate-signal-id'> | null = null;
  for (const entry of event.record.approval_group.signal_manifest) {
    const expected = next.get(entry.kind)!;
    const order = [kindOrder(entry.kind), entry.position_within_kind] as const;
    const violation: ManifestViolation | null = seen.has(entry.signal_id)
      ? 'duplicate-signal-id'
      : entry.position_within_kind !== expected
        ? 'non-contiguous-position'
        : !follows(previous, order)
          ? 'non-canonical-order'
          : null;
    first ??= violation;
    if (entry.position_within_kind !== expected)
      ordering ??= 'non-contiguous-position';
    else if (!follows(previous, order)) ordering ??= 'non-canonical-order';
    seen.add(entry.signal_id);
    next.set(entry.kind, expected + 1);
    previous = order;
  }
  const own = event.record.approval_group.signal_manifest.filter(
    (entry) => entry.signal_id === event.record.signal_id,
  );
  const entry = own[0];
  const ownKindMatches = own.length === 1 && entry?.kind === event.record.kind;
  return {
    has_duplicate_signal_ids:
      seen.size !== event.record.approval_group.signal_manifest.length,
    first_manifest_violation: first,
    first_ordering_violation: ordering,
    own_entry_kind_matches: ownKindMatches,
    own_entry_digest_matches:
      entry !== undefined && canonicalSha256(event.record.signal) === entry.sha256,
    order: ownKindMatches
      ? ([kindOrder(entry.kind), entry.position_within_kind] as const)
      : null,
  };
}

function siblingFacts(event: ApprovalGroupEvent) {
  const { signal_id: _signalId, ...localReference } = event.local_reference;
  return canonicalJson({
    schema_version: event.schema_version,
    kind: event.kind,
    event_type: event.event_type,
    organization_id: event.organization_id,
    occurred_at: event.occurred_at,
    producer: event.producer,
    source: event.source,
    processor: event.processor,
    local_reference: localReference,
    meeting_context: event.record.meeting_context,
    approval: event.approval,
    publication: event.publication,
    classification: event.classification,
    identity_manifest_sha256: event.identity_manifest_sha256,
  });
}

export function analyzeApprovalGroup(events: readonly ApprovalGroupEvent[]) {
  const first = events[0]!;
  const approvalId = first.local_reference.approval_id;
  const group = canonicalJson(first.record.approval_group);
  const shared = siblingFacts(first);
  const expected = new Set(
    first.record.approval_group.signal_manifest.map((entry) => entry.signal_id),
  );
  const seen = new Set<string>();
  let previous: SignalOrder | undefined;
  const items = events.map((event) => {
    const signal = analyzeApprovalSignal(event);
    const repeated = seen.has(event.record.signal_id);
    seen.add(event.record.signal_id);
    const ordered = signal.order !== null && follows(previous, signal.order);
    if (signal.order !== null) previous = signal.order;
    return {
      signal,
      approval_id_matches: event.local_reference.approval_id === approvalId,
      approval_group_matches:
        canonicalJson(event.record.approval_group) === group,
      shared_facts_match: siblingFacts(event) === shared,
      signal_identity_consistent:
        event.record.signal_id === event.local_reference.signal_id &&
        event.record.signal.id === event.record.signal_id &&
        event.record.signal.kind === event.record.kind,
      signal_expected: expected.has(event.record.signal_id),
      signal_repeated: repeated,
      references_consistent:
        event.approval.approved_brief_sha256 ===
          event.record.approval_group.approved_brief_sha256 &&
        event.record.meeting_context.id === event.local_reference.meeting_id,
      order_is_canonical: ordered,
    };
  });
  return {
    event_count_matches_manifest: expected.size === events.length,
    present_signals_match_manifest:
      expected.size === seen.size &&
      [...expected].every((signalId) => seen.has(signalId)),
    items,
  };
}
