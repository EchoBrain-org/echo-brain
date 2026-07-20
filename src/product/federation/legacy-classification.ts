import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from "../../core/contracts/delivery.js";
import { assertCanonicalDeliveryEnvelope } from "../../core/contracts/validation.js";
import {
  approvedBriefDigest,
  assertDeliveryReceipt,
} from "../../core/delivery/envelope.js";
import type { DecisionNodeState } from "../approval/decision-node.js";
import type { DecisionNodeStore } from "../approval/decision-node-store.js";
import { parseJson } from "../../util/json.js";
import { resolveProductStatePaths } from "../paths.js";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from "./canonical-json.js";
import { assertUtcMillisecondTimestamp } from "./identifiers.js";
import { ImmutableFederationDocumentStore } from "./immutable-document-store.js";

const BOOTSTRAP_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_REPORT_DIRECTORY = "legacy-classification";

export type LegacyRecordClassification =
  "disposable_test" | "legacy_imported_unverified";

export type LegacyBoundaryViolationCode =
  | "late-legacy-node-event"
  | "malformed-delivery-receipt"
  | "late-delivery-receipt"
  | "unmatched-delivery-receipt"
  | "ambiguous-delivery-receipt";

export interface LegacyDecisionNodeReader {
  initialize(): Promise<void>;
  list(): Promise<readonly DecisionNodeState[]>;
}

export interface LegacyDeliveryReceiptEvidenceV1 {
  idempotency_key: string;
  envelope_id: string;
  envelope_sha256: `sha256:${string}`;
  receipt_sha256: `sha256:${string}`;
  recorded_at: string;
  saved_at: string;
}

export interface LegacyRecordClassificationV1 {
  approval_id: string;
  node_id: string;
  processing_key_sha256: `sha256:${string}`;
  decision_node_sha256: `sha256:${string}`;
  classification: LegacyRecordClassification;
  delivered_receipts: readonly LegacyDeliveryReceiptEvidenceV1[];
}

export type LegacyDeliveryReceiptDisposition =
  | "matched-delivered"
  | "non-delivered"
  | "late"
  | "malformed"
  | "unmatched"
  | "ambiguous";

export interface LegacyDeliveryReceiptRowEvidenceV1 {
  row_id: string;
  idempotency_key: string | null;
  envelope_id: string | null;
  status: string | null;
  row_sha256: `sha256:${string}`;
  envelope_sha256: `sha256:${string}`;
  receipt_sha256: `sha256:${string}`;
  disposition: LegacyDeliveryReceiptDisposition;
  matched_approval_id: string | null;
}

export interface LegacyBoundaryViolationV1 {
  violation_id: `sha256:${string}`;
  code: LegacyBoundaryViolationCode;
  subject_kind: "decision-node" | "delivery-receipt";
  subject_id: string;
  evidence_sha256: `sha256:${string}`;
  reason: string;
}

export interface LegacyClassificationCountsV1 {
  decision_nodes_seen: number;
  legacy_nodes: number;
  federated_nodes_excluded: number;
  disposable_test: number;
  legacy_imported_unverified: number;
  delivery_receipts_seen: number;
  delivered_receipts_seen: number;
  federated_delivery_receipts_excluded: number;
  matched_delivered_receipts: number;
  violations: number;
}

interface LegacyClassificationReportPayloadV1 {
  schema_version: 1;
  kind: "echo-legacy-classification-report";
  cutover_at: string;
  ok: boolean;
  counts: LegacyClassificationCountsV1;
  records_sha256: `sha256:${string}`;
  delivery_receipts_sha256: `sha256:${string}`;
  records: readonly LegacyRecordClassificationV1[];
  delivery_receipts: readonly LegacyDeliveryReceiptRowEvidenceV1[];
  violations: readonly LegacyBoundaryViolationV1[];
}

export interface LegacyClassificationReportV1 extends LegacyClassificationReportPayloadV1 {
  report_sha256: `sha256:${string}`;
}

export interface DurableLegacyClassificationReportV1 {
  schema_version: 1;
  kind: "echo-founder-legacy-classification-report";
  bootstrap_session_id: string;
  classification: LegacyClassificationReportV1;
}

export interface ClassifyLegacyRecordsInput {
  /**
   * The store must be initialized while legacy mode is still permitted. This
   * method calls initialize first so its existing one-time import contract is
   * complete before the caller installs an irreversible identity fence.
   */
  decision_nodes: LegacyDecisionNodeReader | DecisionNodeStore;
  core_database_path: string;
  cutover_at: string;
}

export interface CommitLegacyClassificationReportInput extends ClassifyLegacyRecordsInput {
  state_directory: string;
  bootstrap_session_id: string;
}

export type VerifyLegacyClassificationReportInput =
  CommitLegacyClassificationReportInput;

export interface CommittedLegacyClassificationReport {
  created: boolean;
  path: string;
  canonical_json: string;
  document: DurableLegacyClassificationReportV1;
}

export interface VerifiedLegacyClassificationReport {
  path: string;
  canonical_json: string;
  document: DurableLegacyClassificationReportV1;
  current_classification: LegacyClassificationReportV1;
}

export interface RecoverLegacyClassificationCutoverInput {
  state_directory: string;
  bootstrap_session_id: string;
}

export interface LegacyProcessingBoundaryReadiness {
  legacy_records: number;
  processed_records: number;
}

interface DeliveryReceiptRow {
  idempotency_key: unknown;
  envelope_id: unknown;
  status: unknown;
  envelope_json: unknown;
  receipt_json: unknown;
  saved_at: unknown;
}

interface ValidatedDeliveryReceiptRow {
  idempotencyKey: string;
  envelopeId: string;
  status: DeliveryReceipt["status"];
  envelope: DeliveryEnvelope;
  receipt: DeliveryReceipt;
  envelopeSha256: `sha256:${string}`;
  receiptSha256: `sha256:${string}`;
  savedAt: string;
}

class MalformedDeliveryReceiptRowError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

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

function isStructurallyLegacy(node: DecisionNodeState): boolean {
  return !Object.hasOwn(node.requested_metadata, "federation");
}

function rawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rawDigest(value: unknown): `sha256:${string}` {
  return typeof value === "string"
    ? sha256Digest(value)
    : canonicalSha256(value);
}

function rowEvidenceDigest(row: DeliveryReceiptRow): `sha256:${string}` {
  return canonicalSha256({
    idempotency_key: row.idempotency_key,
    envelope_id: row.envelope_id,
    status: row.status,
    envelope_sha256: rawDigest(row.envelope_json),
    receipt_sha256: rawDigest(row.receipt_json),
    saved_at: row.saved_at,
  });
}

function malformed(reason: string): never {
  throw new MalformedDeliveryReceiptRowError(reason);
}

function validateDeliveryReceiptRow(
  row: DeliveryReceiptRow,
): ValidatedDeliveryReceiptRow {
  const idempotencyKey = rawString(row.idempotency_key);
  const envelopeId = rawString(row.envelope_id);
  const status = rawString(row.status);
  const envelopeJson = rawString(row.envelope_json);
  const receiptJson = rawString(row.receipt_json);
  const savedAt = rawString(row.saved_at);
  if (
    idempotencyKey === null ||
    envelopeId === null ||
    status === null ||
    envelopeJson === null ||
    receiptJson === null ||
    savedAt === null
  ) {
    malformed("row-shape");
  }
  if (!["delivered", "rejected", "failed", "unknown"].includes(status)) {
    malformed("row-status");
  }
  try {
    assertUtcMillisecondTimestamp(savedAt, "delivery receipt saved_at");
  } catch {
    malformed("row-saved-at");
  }
  let envelope: unknown;
  try {
    envelope = parseJson(envelopeJson);
  } catch {
    malformed("envelope-json");
  }
  try {
    assertCanonicalDeliveryEnvelope(envelope);
  } catch {
    malformed("envelope-contract");
  }
  let receipt: unknown;
  try {
    receipt = parseJson(receiptJson);
  } catch {
    malformed("receipt-json");
  }
  try {
    assertDeliveryReceipt(
      envelope as DeliveryEnvelope,
      receipt as DeliveryReceipt,
    );
  } catch {
    malformed("receipt-contract");
  }
  const validEnvelope = envelope as DeliveryEnvelope;
  const validReceipt = receipt as DeliveryReceipt;
  if (validEnvelope.idempotency_key !== idempotencyKey) {
    malformed("row-idempotency-key-mismatch");
  }
  if (validEnvelope.id !== envelopeId) {
    malformed("row-envelope-id-mismatch");
  }
  if (validReceipt.status !== status) {
    malformed("row-receipt-status-mismatch");
  }
  return {
    idempotencyKey,
    envelopeId,
    status: status as DeliveryReceipt["status"],
    envelope: validEnvelope,
    receipt: validReceipt,
    envelopeSha256: canonicalSha256(validEnvelope),
    receiptSha256: canonicalSha256(validReceipt),
    savedAt,
  };
}

function readDeliveryReceiptRows(databasePath: string): DeliveryReceiptRow[] {
  const canonicalPath = resolve(databasePath);
  if (!existsSync(canonicalPath)) {
    // A genuinely fresh installation may not have opened the core store yet.
    // Missing and present-with-zero-receipts are the same logical input.
    return [];
  }
  const state = lstatSync(canonicalPath);
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error(
      "legacy classification core state database must be a direct regular file",
    );
  }
  const database = new Database(canonicalPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    const rows = database
      .prepare(
        `SELECT idempotency_key, envelope_id, status,
                envelope_json, receipt_json, saved_at
         FROM core_delivery_receipts`,
      )
      .all() as DeliveryReceiptRow[];
    database.exec("COMMIT");
    return rows.sort((left, right) => {
      const leftKey =
        rawString(left.idempotency_key) ?? rowEvidenceDigest(left);
      const rightKey =
        rawString(right.idempotency_key) ?? rowEvidenceDigest(right);
      return (
        bytewiseCompare(leftKey, rightKey) ||
        bytewiseCompare(rowEvidenceDigest(left), rowEvidenceDigest(right))
      );
    });
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function readProcessedMarkerKeys(databasePath: string): ReadonlySet<string> {
  const canonicalPath = resolve(databasePath);
  if (!existsSync(canonicalPath)) return new Set();
  const state = lstatSync(canonicalPath);
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error(
      "legacy processing boundary database must be a direct regular file",
    );
  }
  const database = new Database(canonicalPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    const rows = database
      .prepare(
        "SELECT processing_key FROM core_processed_markers ORDER BY processing_key ASC",
      )
      .all() as { processing_key: unknown }[];
    if (rows.some((row) => typeof row.processing_key !== "string")) {
      throw new Error("processed marker contains an invalid processing key");
    }
    return new Set(rows.map((row) => row.processing_key as string));
  } finally {
    database.close();
  }
}

/**
 * Seed cutover cannot strand a legacy approval behind the source cursor.
 * Every structurally legacy decision node must already be non-pending and
 * have the core's durable processed marker before identity activation.
 */
export async function assertLegacyProcessingBoundaryReady(
  input: Pick<
    ClassifyLegacyRecordsInput,
    "decision_nodes" | "core_database_path"
  >,
): Promise<LegacyProcessingBoundaryReadiness> {
  await input.decision_nodes.initialize();
  const legacy = (await input.decision_nodes.list()).filter(
    isStructurallyLegacy,
  );
  const processed = readProcessedMarkerKeys(input.core_database_path);
  const blocked = legacy.filter(
    (node) => node.status === "pending" || !processed.has(node.processing_key),
  );
  if (blocked.length > 0) {
    const approvalIds = blocked
      .map((node) => node.approval_id)
      .sort(bytewiseCompare);
    throw new Error(
      `legacy processing boundary has ${blocked.length} unresolved or unprocessed decision node${blocked.length === 1 ? "" : "s"}: ${approvalIds.join(", ")}`,
    );
  }
  return {
    legacy_records: legacy.length,
    processed_records: legacy.length,
  };
}

function deliveryIdempotencyKeyForLegacyNode(
  node: DecisionNodeState,
  envelope: DeliveryEnvelope,
): string {
  // V1 is a persisted historical identity contract. Keep this reconstruction
  // frozen even if a later core delivery-key version is introduced.
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
      // Native delivery rows are dynamic post-cutover state. Their decision
      // node has already passed identity-enabled capture validation, so they
      // are outside the frozen legacy evidence set and its digest.
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

function assertBootstrapSessionId(sessionId: string): void {
  if (!BOOTSTRAP_SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      "legacy classification bootstrap session ID must be a canonical UUIDv4",
    );
  }
}

export function legacyClassificationReportFilename(sessionId: string): string {
  assertBootstrapSessionId(sessionId);
  return `report.${sessionId}.v1.json`;
}

export function legacyClassificationReportPath(
  stateDirectory: string,
  sessionId: string,
): string {
  return join(
    resolveProductStatePaths(stateDirectory).bootstrapRoot,
    LEGACY_REPORT_DIRECTORY,
    legacyClassificationReportFilename(sessionId),
  );
}

function durableReportStore(
  stateDirectory: string,
): ImmutableFederationDocumentStore {
  return new ImmutableFederationDocumentStore(
    join(
      resolveProductStatePaths(stateDirectory).bootstrapRoot,
      LEGACY_REPORT_DIRECTORY,
    ),
    "legacy classification report",
  );
}

function assertClassificationReportDigest(
  report: LegacyClassificationReportV1,
): void {
  const { report_sha256: reportSha256, ...payload } = report;
  if (reportSha256 !== canonicalSha256(payload)) {
    throw new Error("legacy classification report digest is invalid");
  }
}

function durableReportDocument(
  sessionId: string,
  classification: LegacyClassificationReportV1,
): DurableLegacyClassificationReportV1 {
  assertBootstrapSessionId(sessionId);
  assertClassificationReportDigest(classification);
  return {
    schema_version: 1,
    kind: "echo-founder-legacy-classification-report",
    bootstrap_session_id: sessionId,
    classification,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function validateStoredDurableReport(
  value: unknown,
  expectedSessionId: string,
  expectedCutoverAt: string,
): DurableLegacyClassificationReportV1 {
  if (!isPlainObject(value)) {
    throw new Error("stored report is not an object");
  }
  if (
    !hasExactKeys(value, [
      "schema_version",
      "kind",
      "bootstrap_session_id",
      "classification",
    ]) ||
    value["schema_version"] !== 1 ||
    value["kind"] !== "echo-founder-legacy-classification-report" ||
    value["bootstrap_session_id"] !== expectedSessionId ||
    !isPlainObject(value["classification"])
  ) {
    throw new Error("stored report identity or shape is invalid");
  }
  const classification = value[
    "classification"
  ] as unknown as LegacyClassificationReportV1;
  const classificationRecord = value["classification"];
  if (
    !hasExactKeys(classificationRecord, [
      "schema_version",
      "kind",
      "cutover_at",
      "ok",
      "counts",
      "records_sha256",
      "delivery_receipts_sha256",
      "records",
      "delivery_receipts",
      "violations",
      "report_sha256",
    ]) ||
    !isPlainObject(classificationRecord["counts"]) ||
    !hasExactKeys(classificationRecord["counts"], [
      "decision_nodes_seen",
      "legacy_nodes",
      "federated_nodes_excluded",
      "disposable_test",
      "legacy_imported_unverified",
      "delivery_receipts_seen",
      "delivered_receipts_seen",
      "federated_delivery_receipts_excluded",
      "matched_delivered_receipts",
      "violations",
    ])
  ) {
    throw new Error("stored report contains missing or unexpected fields");
  }
  try {
    assertClassificationReportDigest(classification);
  } catch {
    throw new Error("stored report integrity digest is invalid");
  }
  if (
    classification.schema_version !== 1 ||
    classification.kind !== "echo-legacy-classification-report" ||
    classification.cutover_at !== expectedCutoverAt ||
    classification.ok !== true ||
    !Array.isArray(classification.records) ||
    !Array.isArray(classification.delivery_receipts) ||
    !Array.isArray(classification.violations) ||
    classification.violations.length !== 0 ||
    classification.records_sha256 !== canonicalSha256(classification.records) ||
    classification.delivery_receipts_sha256 !==
      canonicalSha256(classification.delivery_receipts)
  ) {
    throw new Error("stored report cutover or legacy evidence is invalid");
  }
  return value as unknown as DurableLegacyClassificationReportV1;
}

/**
 * Recover the activation timestamp frozen by an already-committed report.
 * This is the pre-commit crash-recovery anchor for the bootstrap ceremony:
 * absence means no authorization side effect exists yet; a present artifact
 * must validate completely before its timestamp can be reused.
 */
export function recoverLegacyClassificationCutoverAt(
  input: RecoverLegacyClassificationCutoverInput,
): string | null {
  assertBootstrapSessionId(input.bootstrap_session_id);
  const path = legacyClassificationReportPath(
    input.state_directory,
    input.bootstrap_session_id,
  );
  if (!existsSync(path)) return null;
  const filename = legacyClassificationReportFilename(
    input.bootstrap_session_id,
  );
  try {
    const stored = durableReportStore(input.state_directory).read(filename);
    const value = parseCanonicalJson(stored);
    if (
      !isPlainObject(value) ||
      !isPlainObject(value["classification"]) ||
      typeof value["classification"]["cutover_at"] !== "string"
    ) {
      throw new Error("stored report cutover timestamp is missing");
    }
    const cutoverAt = value["classification"]["cutover_at"];
    assertUtcMillisecondTimestamp(cutoverAt, "legacy cutover");
    return validateStoredDurableReport(
      value,
      input.bootstrap_session_id,
      cutoverAt,
    ).classification.cutover_at;
  } catch (error) {
    throw new Error(
      `legacy classification cutover recovery failed: ${(error as Error).message}`,
    );
  }
}

/**
 * Commit one immutable canonical classification artifact for a bootstrap
 * session. Repeating the same operation is idempotent; the same session ID
 * can never be rebound to different report bytes.
 */
export async function commitLegacyClassificationReport(
  input: CommitLegacyClassificationReportInput,
): Promise<CommittedLegacyClassificationReport> {
  assertBootstrapSessionId(input.bootstrap_session_id);
  const classification = await classifyLegacyRecords(input);
  if (!classification.ok) {
    throw new Error(
      "legacy classification contains boundary violations and cannot be committed",
    );
  }
  const document = durableReportDocument(
    input.bootstrap_session_id,
    classification,
  );
  const canonicalJsonValue = canonicalJson(document);
  const filename = legacyClassificationReportFilename(
    input.bootstrap_session_id,
  );
  const store = durableReportStore(input.state_directory);
  const result = store.create(filename, canonicalJsonValue);
  if (store.read(filename) !== canonicalJsonValue) {
    throw new Error(
      "legacy classification report read-back differs from committed canonical bytes",
    );
  }
  return {
    created: result.created,
    path: result.path,
    canonical_json: canonicalJsonValue,
    document,
  };
}

/**
 * Recompute the complete read-only classification. Native post-cutover nodes
 * may change dynamic totals, but the frozen legacy node and receipt digests
 * must still match the immutable canonical artifact exactly.
 */
export async function verifyLegacyClassificationReport(
  input: VerifyLegacyClassificationReportInput,
): Promise<VerifiedLegacyClassificationReport> {
  assertBootstrapSessionId(input.bootstrap_session_id);
  const classification = await classifyLegacyRecords(input);
  if (!classification.ok) {
    throw new Error(
      "legacy classification report verification failed: current boundary contains violations",
    );
  }
  const filename = legacyClassificationReportFilename(
    input.bootstrap_session_id,
  );
  let stored: string;
  try {
    stored = durableReportStore(input.state_directory).read(filename);
  } catch (error) {
    throw new Error(
      `legacy classification report verification failed: ${(error as Error).message}`,
    );
  }
  let parsed: DurableLegacyClassificationReportV1;
  try {
    parsed = validateStoredDurableReport(
      parseCanonicalJson(stored),
      input.bootstrap_session_id,
      input.cutover_at,
    );
  } catch (error) {
    throw new Error(
      `legacy classification report verification failed: ${(error as Error).message}`,
    );
  }
  if (
    parsed.classification.records_sha256 !== classification.records_sha256 ||
    parsed.classification.delivery_receipts_sha256 !==
      classification.delivery_receipts_sha256
  ) {
    throw new Error(
      "legacy classification report verification failed: frozen legacy evidence diverges from the stored report",
    );
  }
  return {
    path: legacyClassificationReportPath(
      input.state_directory,
      input.bootstrap_session_id,
    ),
    canonical_json: stored,
    document: parsed,
    current_classification: classification,
  };
}
