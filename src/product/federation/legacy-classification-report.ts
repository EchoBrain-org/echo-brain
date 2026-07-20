import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProductStatePaths } from "../paths.js";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from "./canonical-json.js";
import { assertUtcMillisecondTimestamp } from "./identifiers.js";
import { ImmutableFederationDocumentStore } from "./immutable-document-store.js";
import type {
  CommitLegacyClassificationReportInput,
  CommittedLegacyClassificationReport,
  DurableLegacyClassificationReportV1,
  LegacyClassificationReportV1,
  RecoverLegacyClassificationCutoverInput,
  VerifiedLegacyClassificationReport,
  VerifyLegacyClassificationReportInput,
} from "./legacy-cutover-evidence.js";
import { classifyLegacyRecords } from "./legacy-record-classifier.js";

const BOOTSTRAP_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_REPORT_DIRECTORY = "legacy-classification";

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
