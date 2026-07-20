import type { DeliveryEnvelope } from "../../../core/contracts/delivery.js";
import { approvedBriefDigest } from "../../../core/delivery/envelope.js";
import type { DecisionNodeState } from "../../approval/decision-node.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../foundation/canonical-json.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";
import {
  bytewiseCompare,
  isStructurallyLegacy,
  MalformedDeliveryReceiptRowError,
  rawDigest,
  rawString,
  readDeliveryReceiptRows,
  rowEvidenceDigest,
  validateDeliveryReceiptRow,
  type ClassifyLegacyRecordsInput,
  type LegacyBoundaryViolationCode,
  type LegacyBoundaryViolationV1,
  type LegacyClassificationReportV1,
  type LegacyDeliveryReceiptEvidenceV1,
  type LegacyDeliveryReceiptRowEvidenceV1,
  type LegacyRecordClassificationV1,
  type ValidatedDeliveryReceiptRow,
} from "./legacy-cutover-evidence.js";

type LegacyClassificationReportPayloadV1 = Omit<
  LegacyClassificationReportV1,
  "report_sha256"
>;

function compareReceiptEvidence(
  left: LegacyDeliveryReceiptEvidenceV1,
  right: LegacyDeliveryReceiptEvidenceV1,
): number {
  return (
    bytewiseCompare(left.idempotency_key, right.idempotency_key) ||
    bytewiseCompare(left.envelope_id, right.envelope_id)
  );
}

function compareViolations(
  left: LegacyBoundaryViolationV1,
  right: LegacyBoundaryViolationV1,
): number {
  return (
    bytewiseCompare(left.code, right.code) ||
    bytewiseCompare(left.subject_kind, right.subject_kind) ||
    bytewiseCompare(left.subject_id, right.subject_id) ||
    bytewiseCompare(left.evidence_sha256, right.evidence_sha256)
  );
}

function deliveryIdempotencyKeyForLegacyNode(
  node: DecisionNodeState,
  envelope: DeliveryEnvelope,
): string {
  return `delivery:v1:${JSON.stringify([
    node.processing_key,
    approvedBriefDigest(node.brief),
    envelope.destination.adapter_id,
    envelope.destination.instance_id,
    envelope.destination.external_id,
  ])}`;
}

function receiptMatchesNode(
  row: ValidatedDeliveryReceiptRow,
  node: DecisionNodeState,
): boolean {
  return (
    node.status === "approved" &&
    node.reviewed_at === row.envelope.approved_at &&
    canonicalJson(node.brief) === canonicalJson(row.envelope.brief) &&
    row.idempotencyKey ===
      deliveryIdempotencyKeyForLegacyNode(node, row.envelope)
  );
}

function createViolation(
  code: LegacyBoundaryViolationCode,
  subjectKind: LegacyBoundaryViolationV1["subject_kind"],
  subjectId: string,
  reason: string,
  evidence: unknown,
): LegacyBoundaryViolationV1 {
  const evidenceSha256 = canonicalSha256(evidence);
  return {
    violation_id: canonicalSha256({
      code,
      subject_kind: subjectKind,
      subject_id: subjectId,
      evidence_sha256: evidenceSha256,
    }),
    code,
    subject_kind: subjectKind,
    subject_id: subjectId,
    evidence_sha256: evidenceSha256,
    reason,
  };
}

function lateNodeEvidence(
  node: DecisionNodeState,
  cutoverAt: string,
): readonly { event: string; occurred_at: string }[] {
  return [
    { event: "requested", occurred_at: node.requested_at },
    ...node.published.map((event) => ({
      event: `published:${event.surface}`,
      occurred_at: event.posted_at,
    })),
    ...(node.reviewed_at === null
      ? []
      : [{ event: "resolved", occurred_at: node.reviewed_at }]),
  ]
    .filter((event) => event.occurred_at > cutoverAt)
    .sort(
      (left, right) =>
        bytewiseCompare(left.occurred_at, right.occurred_at) ||
        bytewiseCompare(left.event, right.event),
    );
}

function reportPayload(
  cutoverAt: string,
  nodesSeen: number,
  federatedNodesExcluded: number,
  deliveryReceiptsSeen: number,
  deliveredReceiptsSeen: number,
  federatedDeliveryReceiptsExcluded: number,
  records: readonly LegacyRecordClassificationV1[],
  receiptRows: readonly LegacyDeliveryReceiptRowEvidenceV1[],
  violations: readonly LegacyBoundaryViolationV1[],
): LegacyClassificationReportPayloadV1 {
  const matchedDeliveredReceipts = receiptRows.filter(
    (row) => row.disposition === "matched-delivered",
  ).length;
  return {
    schema_version: 1,
    kind: "echo-legacy-classification-report",
    cutover_at: cutoverAt,
    ok: violations.length === 0,
    counts: {
      decision_nodes_seen: nodesSeen,
      legacy_nodes: records.length,
      federated_nodes_excluded: federatedNodesExcluded,
      disposable_test: records.filter(
        (record) => record.classification === "disposable_test",
      ).length,
      legacy_imported_unverified: records.filter(
        (record) => record.classification === "legacy_imported_unverified",
      ).length,
      delivery_receipts_seen: deliveryReceiptsSeen,
      delivered_receipts_seen: deliveredReceiptsSeen,
      federated_delivery_receipts_excluded: federatedDeliveryReceiptsExcluded,
      matched_delivered_receipts: matchedDeliveredReceipts,
      violations: violations.length,
    },
    records_sha256: canonicalSha256(records),
    delivery_receipts_sha256: canonicalSha256(receiptRows),
    records,
    delivery_receipts: receiptRows,
    violations,
  };
}

/**
 * Produce an in-memory, deterministic cutover report without altering any
 * decision node, core row, identifier, or federated outbox event. The only
 * initialization write this function can cause is DecisionNodeStore's
 * pre-existing one-time legacy manual-approval import, which deliberately
 * runs before the caller installs the irreversible identity fence.
 */
export async function classifyLegacyRecords(
  input: ClassifyLegacyRecordsInput,
): Promise<LegacyClassificationReportV1> {
  assertUtcMillisecondTimestamp(input.cutover_at, "legacy cutover");
  await input.decision_nodes.initialize();
  const allNodes = await input.decision_nodes.list();
  const legacyNodes = allNodes
    .filter(isStructurallyLegacy)
    .sort((left, right) =>
      bytewiseCompare(left.approval_id, right.approval_id),
    );
  const federatedNodes = allNodes
    .filter((node) => !isStructurallyLegacy(node))
    .sort((left, right) =>
      bytewiseCompare(left.approval_id, right.approval_id),
    );
  const deliveredByApproval = new Map<
    string,
    LegacyDeliveryReceiptEvidenceV1[]
  >();
  const violations: LegacyBoundaryViolationV1[] = [];
  for (const node of legacyNodes) {
    const lateEvents = lateNodeEvidence(node, input.cutover_at);
    if (lateEvents.length > 0) {
      violations.push(
        createViolation(
          "late-legacy-node-event",
          "decision-node",
          node.approval_id,
          "structurally legacy decision node contains an event after cutover",
          {
            approval_id: node.approval_id,
            decision_node_sha256: canonicalSha256(node),
            cutover_at: input.cutover_at,
            late_events: lateEvents,
          },
        ),
      );
    }
  }

  const receiptEvidence: LegacyDeliveryReceiptRowEvidenceV1[] = [];
  const rawReceiptRows = readDeliveryReceiptRows(input.core_database_path);
  const deliveredReceiptsSeen = rawReceiptRows.filter(
    (row) => rawString(row.status) === "delivered",
  ).length;
  let federatedDeliveryReceiptsExcluded = 0;
  for (const rawRow of rawReceiptRows) {
    const rowSha256 = rowEvidenceDigest(rawRow);
    const rawIdempotencyKey = rawString(rawRow.idempotency_key);
    const rawEnvelopeId = rawString(rawRow.envelope_id);
    const rawStatus = rawString(rawRow.status);
    const rowId = rawIdempotencyKey ?? rowSha256;
    const baseEvidence = {
      row_id: rowId,
      idempotency_key: rawIdempotencyKey,
      envelope_id: rawEnvelopeId,
      status: rawStatus,
      row_sha256: rowSha256,
      envelope_sha256: rawDigest(rawRow.envelope_json),
      receipt_sha256: rawDigest(rawRow.receipt_json),
    };
    let row: ValidatedDeliveryReceiptRow;
    try {
      row = validateDeliveryReceiptRow(rawRow);
    } catch (error) {
      const reason =
        error instanceof MalformedDeliveryReceiptRowError
          ? error.reason
          : "unexpected-validation-failure";
      receiptEvidence.push({
        ...baseEvidence,
        disposition: "malformed",
        matched_approval_id: null,
      });
      violations.push(
        createViolation(
          "malformed-delivery-receipt",
          "delivery-receipt",
          rowId,
          reason,
          { ...baseEvidence, reason },
        ),
      );
      continue;
    }

    const legacyMatches = legacyNodes.filter((node) =>
      receiptMatchesNode(row, node),
    );
    const federatedMatches = federatedNodes.filter((node) =>
      receiptMatchesNode(row, node),
    );
    if (legacyMatches.length === 0 && federatedMatches.length === 1) {
      federatedDeliveryReceiptsExcluded += 1;
      continue;
    }
    const allMatches = [...legacyMatches, ...federatedMatches];
    if (allMatches.length > 1) {
      const approvalIds = allMatches
        .map((node) => node.approval_id)
        .sort(bytewiseCompare);
      receiptEvidence.push({
        ...baseEvidence,
        envelope_sha256: row.envelopeSha256,
        receipt_sha256: row.receiptSha256,
        disposition: "ambiguous",
        matched_approval_id: null,
      });
      violations.push(
        createViolation(
          "ambiguous-delivery-receipt",
          "delivery-receipt",
          row.idempotencyKey,
          "delivery receipt resolves to more than one decision node",
          {
            idempotency_key: row.idempotencyKey,
            envelope_id: row.envelopeId,
            approval_ids: approvalIds,
          },
        ),
      );
      continue;
    }

    const isLate =
      row.envelope.approved_at > input.cutover_at ||
      row.receipt.recorded_at > input.cutover_at ||
      row.savedAt > input.cutover_at;
    if (isLate) {
      receiptEvidence.push({
        ...baseEvidence,
        envelope_sha256: row.envelopeSha256,
        receipt_sha256: row.receiptSha256,
        disposition: "late",
        matched_approval_id: null,
      });
      violations.push(
        createViolation(
          "late-delivery-receipt",
          "delivery-receipt",
          row.idempotencyKey,
          "delivery receipt contains approval, provider, or persistence time after cutover",
          {
            idempotency_key: row.idempotencyKey,
            envelope_id: row.envelopeId,
            envelope_sha256: row.envelopeSha256,
            receipt_sha256: row.receiptSha256,
            approved_at: row.envelope.approved_at,
            recorded_at: row.receipt.recorded_at,
            saved_at: row.savedAt,
            cutover_at: input.cutover_at,
          },
        ),
      );
      continue;
    }
    if (row.status !== "delivered") {
      receiptEvidence.push({
        ...baseEvidence,
        envelope_sha256: row.envelopeSha256,
        receipt_sha256: row.receiptSha256,
        disposition: "non-delivered",
        matched_approval_id: null,
      });
      continue;
    }

    if (legacyMatches.length === 0) {
      receiptEvidence.push({
        ...baseEvidence,
        envelope_sha256: row.envelopeSha256,
        receipt_sha256: row.receiptSha256,
        disposition: "unmatched",
        matched_approval_id: null,
      });
      violations.push(
        createViolation(
          "unmatched-delivery-receipt",
          "delivery-receipt",
          row.idempotencyKey,
          "delivered receipt does not resolve to one structurally legacy decision node",
          {
            idempotency_key: row.idempotencyKey,
            envelope_id: row.envelopeId,
            envelope_sha256: row.envelopeSha256,
            receipt_sha256: row.receiptSha256,
          },
        ),
      );
      continue;
    }
    const approvalId = legacyMatches[0]!.approval_id;
    const matchedEvidence: LegacyDeliveryReceiptEvidenceV1 = {
      idempotency_key: row.idempotencyKey,
      envelope_id: row.envelopeId,
      envelope_sha256: row.envelopeSha256,
      receipt_sha256: row.receiptSha256,
      recorded_at: row.receipt.recorded_at,
      saved_at: row.savedAt,
    };
    const current = deliveredByApproval.get(approvalId) ?? [];
    current.push(matchedEvidence);
    deliveredByApproval.set(approvalId, current);
    receiptEvidence.push({
      ...baseEvidence,
      envelope_sha256: row.envelopeSha256,
      receipt_sha256: row.receiptSha256,
      disposition: "matched-delivered",
      matched_approval_id: approvalId,
    });
  }

  const records = legacyNodes.map((node): LegacyRecordClassificationV1 => {
    const deliveredReceipts = (deliveredByApproval.get(node.approval_id) ?? [])
      .slice()
      .sort(compareReceiptEvidence);
    return {
      approval_id: node.approval_id,
      node_id: node.node_id,
      processing_key_sha256: sha256Digest(node.processing_key),
      decision_node_sha256: canonicalSha256(node),
      classification:
        deliveredReceipts.length === 0
          ? "disposable_test"
          : "legacy_imported_unverified",
      delivered_receipts: deliveredReceipts,
    };
  });
  receiptEvidence.sort(
    (left, right) =>
      bytewiseCompare(left.row_id, right.row_id) ||
      bytewiseCompare(left.row_sha256, right.row_sha256),
  );
  violations.sort(compareViolations);
  const payload = reportPayload(
    input.cutover_at,
    allNodes.length,
    federatedNodes.length,
    rawReceiptRows.length,
    deliveredReceiptsSeen,
    federatedDeliveryReceiptsExcluded,
    records,
    receiptEvidence,
    violations,
  );
  return { ...payload, report_sha256: canonicalSha256(payload) };
}
