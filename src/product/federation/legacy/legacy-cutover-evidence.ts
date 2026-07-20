import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from "../../../core/contracts/delivery.js";
import { assertCanonicalDeliveryEnvelope } from "../../../core/contracts/validation.js";
import { assertDeliveryReceipt } from "../../../core/delivery/envelope.js";
import { parseJson } from "../../../util/json.js";
import type { DecisionNodeState } from "../../approval/decision-node.js";
import type { DecisionNodeStore } from "../../approval/decision-node-store.js";
import { canonicalSha256, sha256Digest } from "../foundation/canonical-json.js";
import { assertUtcMillisecondTimestamp } from "../foundation/identifiers.js";

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

export interface LegacyClassificationReportV1 {
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

export interface DeliveryReceiptRow {
  idempotency_key: unknown;
  envelope_id: unknown;
  status: unknown;
  envelope_json: unknown;
  receipt_json: unknown;
  saved_at: unknown;
}

export interface ValidatedDeliveryReceiptRow {
  idempotencyKey: string;
  envelopeId: string;
  status: DeliveryReceipt["status"];
  envelope: DeliveryEnvelope;
  receipt: DeliveryReceipt;
  envelopeSha256: `sha256:${string}`;
  receiptSha256: `sha256:${string}`;
  savedAt: string;
}

export class MalformedDeliveryReceiptRowError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function isStructurallyLegacy(node: DecisionNodeState): boolean {
  return !Object.hasOwn(node.requested_metadata, "federation");
}

export function rawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function rawDigest(value: unknown): `sha256:${string}` {
  return typeof value === "string"
    ? sha256Digest(value)
    : canonicalSha256(value);
}

export function rowEvidenceDigest(row: DeliveryReceiptRow): `sha256:${string}` {
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

export function validateDeliveryReceiptRow(
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

export function readDeliveryReceiptRows(
  databasePath: string,
): DeliveryReceiptRow[] {
  const canonicalPath = resolve(databasePath);
  if (!existsSync(canonicalPath)) {
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
