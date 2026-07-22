import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../../src/core/index.js";
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from "../../../src/core/contracts/delivery.js";
import { createDeliveryEnvelope } from "../../../src/core/delivery/envelope.js";
import type { DeliverySurfaceAdapter } from "../../../src/core/ports/adapters.js";
import {
  DecisionNodeStore,
  type DecisionNodeFederationCapture,
} from "../../../src/product/approval/decision-node-store.js";
import { decisionApprovalId } from "../../../src/product/approval/decision-node.js";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../../../src/product/federation/foundation/canonical-json.js";
import {
  assertLegacyProcessingBoundaryReady,
  classifyLegacyRecords,
  commitLegacyClassificationReport,
  legacyClassificationReportPath,
  verifyLegacyClassificationReport,
} from "../../../src/product/federation/legacy-classification.js";
import { SqliteCoreStateStore } from "../../../src/product/storage/sqlite-core-state-store.js";

const CUTOVER_AT = "2026-07-20T00:00:00.000Z";
const BEFORE_CUTOVER = "2026-07-19T23:00:00.000Z";
const AFTER_CUTOVER = "2026-07-20T01:00:00.000Z";
const BOOTSTRAP_SESSION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_BOOTSTRAP_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const roots: string[] = [];

function newRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-legacy-classification-")),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function approvalRequest(
  processingKey: string,
  requestedAt: string = BEFORE_CUTOVER,
): ApprovalRequest {
  const suffix = sha256Digest(processingKey).slice(-8);
  return {
    processing_key: processingKey,
    requested_at: requestedAt,
    meeting: {
      schema_version: 1,
      id: `meeting-${suffix}`,
      title: `Planning ${suffix}`,
      time: { actual_start_at: "2026-07-19T20:00:00.000Z" },
      capture: { state: "complete", components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: "meeting-source",
          adapter_id: "granola",
          instance_id: "primary",
          version: "2.2.0",
        },
        external_id: `note-${suffix}`,
        canonical_revision: "revision-1",
        observed_at: "2026-07-19T22:00:00.000Z",
        normalizer_version: "1",
        source_updated_at: "2026-07-19T22:00:00.000Z",
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: `meeting-${suffix}`,
      meeting_revision: "revision-1",
      processor: {
        kind: "decision-processor",
        adapter_id: "llm",
        instance_id: "ollama",
        version: "1.0.0",
      },
      generated_at: "2026-07-19T22:30:00.000Z",
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: `brief-${suffix}`,
      meeting: {
        id: `meeting-${suffix}`,
        title: `Planning ${suffix}`,
        time: { actual_start_at: "2026-07-19T20:00:00.000Z" },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: "revision-1",
        processor: {
          kind: "decision-processor",
          adapter_id: "llm",
          instance_id: "ollama",
          version: "1.0.0",
        },
        generated_at: "2026-07-19T22:30:00.000Z",
      },
    },
  };
}

function deliverySurface(
  instanceId: string,
  externalId: string,
): DeliverySurfaceAdapter {
  return {
    identity: {
      kind: "delivery-surface",
      adapter_id: "slack",
      instance_id: instanceId,
      version: "1.0.0",
    },
    destination: {
      adapter_id: "slack",
      instance_id: instanceId,
      external_id: externalId,
    },
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({
      status: "healthy",
      checked_at: BEFORE_CUTOVER,
    }),
    publish: async (envelope) => ({
      schema_version: 1,
      envelope_id: envelope.id,
      status: "delivered",
      external_id: "provider-message",
      recorded_at: BEFORE_CUTOVER,
      retryable: false,
    }),
  };
}

function initializeDatabase(databasePath: string): void {
  new SqliteCoreStateStore(databasePath).close();
}

function insertReceiptRow(
  databasePath: string,
  input: {
    envelope: DeliveryEnvelope;
    receipt: DeliveryReceipt | Record<string, unknown>;
    status?: string;
    savedAt?: string;
  },
): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO core_delivery_receipts (
           idempotency_key, envelope_id, status,
           envelope_json, receipt_json, saved_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.envelope.idempotency_key,
        input.envelope.id,
        input.status ?? input.receipt.status,
        JSON.stringify(input.envelope),
        JSON.stringify(input.receipt),
        input.savedAt ?? BEFORE_CUTOVER,
      );
  } finally {
    database.close();
  }
}

function insertOutboxSentinel(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO federated_chain_heads (
           installation_id, last_sequence, last_event_hash, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run("ins_sentinel", 1, "sha256:sentinel", BEFORE_CUTOVER);
    database
      .prepare(
        `INSERT INTO federated_outbox_events (
           event_id, installation_id, sequence, event_type, local_subject_key,
           previous_event_hash, event_hash, envelope_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_sentinel",
        "ins_sentinel",
        1,
        "decision-approved",
        "approval:sentinel",
        null,
        "sha256:sentinel",
        "{}",
        BEFORE_CUTOVER,
      );
  } finally {
    database.close();
  }
}

function snapshotCoreAndOutbox(databasePath: string): string {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND (name LIKE 'core_%' OR name LIKE 'federated_%')
         ORDER BY name`,
      )
      .all() as { name: string }[];
    return canonicalSha256(
      tables.map(({ name }) => ({
        name,
        rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      })),
    );
  } finally {
    database.close();
  }
}

function snapshotFiles(root: string): readonly {
  path: string;
  sha256: `sha256:${string}`;
}[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files
    .map((path) => ({
      path: relative(root, path),
      sha256: sha256Digest(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function deliveredReceipt(
  envelope: DeliveryEnvelope,
  recordedAt: string = BEFORE_CUTOVER,
): DeliveryReceipt {
  return {
    schema_version: 1,
    envelope_id: envelope.id,
    status: "delivered",
    external_id: `message-${envelope.id}`,
    recorded_at: recordedAt,
    retryable: false,
  };
}

describe("legacy cutover classification", () => {
  it("deterministically classifies only contract-valid delivered legacy records without mutating state", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    insertOutboxSentinel(databasePath);
    let now = BEFORE_CUTOVER;
    let nodeNumber = 0;
    const store = new DecisionNodeStore(root, {
      now: () => now,
      createId: () => `legacy-node-${++nodeNumber}`,
    });

    const deliveredRequest = approvalRequest("processing:delivered");
    const delivered = await store.ensureRequested(deliveredRequest);
    await store.resolve({
      approvalId: delivered.approval_id,
      status: "approved",
      reviewedBy: "founder",
      surface: "slack",
    });
    const deliveredEnvelope = createDeliveryEnvelope(
      "envelope-delivered",
      delivered.processing_key,
      deliverySurface("team-decisions", "C123"),
      delivered.brief,
      BEFORE_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: deliveredEnvelope,
      receipt: deliveredReceipt(deliveredEnvelope),
    });

    const failedRequest = approvalRequest("processing:failed");
    const failed = await store.ensureRequested(failedRequest);
    await store.resolve({
      approvalId: failed.approval_id,
      status: "approved",
      reviewedBy: "founder",
      surface: "slack",
    });
    const failedEnvelope = createDeliveryEnvelope(
      "envelope-failed",
      failed.processing_key,
      deliverySurface("team-decisions", "C123"),
      failed.brief,
      BEFORE_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: failedEnvelope,
      receipt: {
        schema_version: 1,
        envelope_id: failedEnvelope.id,
        status: "failed",
        external_id: null,
        recorded_at: BEFORE_CUTOVER,
        retryable: true,
        message: "temporary failure",
      },
    });

    await store.ensureRequested(approvalRequest("processing:pending"));
    await store.initialize();
    const databaseBefore = snapshotCoreAndOutbox(databasePath);
    const decisionsBefore = snapshotFiles(join(root, "decisions"));

    const first = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });
    const second = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });

    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    expect(first.counts).toEqual({
      decision_nodes_seen: 3,
      legacy_nodes: 3,
      federated_nodes_excluded: 0,
      disposable_test: 2,
      legacy_imported_unverified: 1,
      delivery_receipts_seen: 2,
      delivered_receipts_seen: 1,
      federated_delivery_receipts_excluded: 0,
      matched_delivered_receipts: 1,
      violations: 0,
    });
    const classified = new Map(
      first.records.map((record) => [record.approval_id, record]),
    );
    expect(classified.get(delivered.approval_id)).toMatchObject({
      node_id: delivered.node_id,
      processing_key_sha256: sha256Digest(delivered.processing_key),
      classification: "legacy_imported_unverified",
      delivered_receipts: [
        {
          idempotency_key: deliveredEnvelope.idempotency_key,
          envelope_id: deliveredEnvelope.id,
          recorded_at: BEFORE_CUTOVER,
          saved_at: BEFORE_CUTOVER,
        },
      ],
    });
    expect(classified.get(failed.approval_id)?.classification).toBe(
      "disposable_test",
    );
    expect(
      first.records.find(
        (record) =>
          record.approval_id === decisionApprovalId("processing:pending"),
      )?.classification,
    ).toBe("disposable_test");
    expect(
      first.delivery_receipts.map((row) => row.disposition).sort(),
    ).toEqual(["matched-delivered", "non-delivered"]);
    for (const digest of [
      first.records_sha256,
      first.delivery_receipts_sha256,
      first.report_sha256,
      ...first.records.flatMap((record) => [
        record.processing_key_sha256,
        record.decision_node_sha256,
      ]),
    ]) {
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    const { report_sha256: _reportSha256, ...payload } = first;
    expect(first.report_sha256).toBe(canonicalSha256(payload));
    expect(snapshotCoreAndOutbox(databasePath)).toBe(databaseBefore);
    expect(snapshotFiles(join(root, "decisions"))).toEqual(decisionsBefore);
    expect(now).toBe(BEFORE_CUTOVER);
  });

  it("runs the existing one-time manual approval import before classification and adds no classifier backfill", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    insertOutboxSentinel(databasePath);
    const request = approvalRequest("processing:manual-import");
    const approvalId = decisionApprovalId(request.processing_key);
    const legacyDirectory = join(root, "approvals");
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(legacyDirectory, `${approvalId}.json`),
      `${JSON.stringify({
        schema_version: 1,
        approval_id: approvalId,
        processing_key: request.processing_key,
        status: "approved",
        requested_at: BEFORE_CUTOVER,
        reviewed_at: BEFORE_CUTOVER,
        reviewed_by: "founder",
        reason: null,
        brief: request.brief,
      })}\n`,
      { mode: 0o600 },
    );
    const store = new DecisionNodeStore(root, { now: () => CUTOVER_AT });
    const databaseBefore = snapshotCoreAndOutbox(databasePath);

    const first = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });
    expect(first.ok).toBe(true);
    expect(first.records).toMatchObject([
      {
        approval_id: approvalId,
        classification: "disposable_test",
      },
    ]);
    expect(
      existsSync(join(root, "decisions", ".legacy-approvals-imported-v1")),
    ).toBe(true);
    expect(
      statSync(join(root, "decisions", approvalId, "requested.json")).mode &
        0o777,
    ).toBe(0o600);
    const filesAfterImport = snapshotFiles(join(root, "decisions"));

    expect(
      await classifyLegacyRecords({
        decision_nodes: store,
        core_database_path: databasePath,
        cutover_at: CUTOVER_AT,
      }),
    ).toEqual(first);
    expect(snapshotFiles(join(root, "decisions"))).toEqual(filesAfterImport);
    expect(snapshotCoreAndOutbox(databasePath)).toBe(databaseBefore);
  });

  it("detects late, malformed, and unmatched receipts without promoting them", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    let now = AFTER_CUTOVER;
    const store = new DecisionNodeStore(root, {
      now: () => now,
      createId: () => "late-node",
    });
    const lateRequest = approvalRequest("processing:late", AFTER_CUTOVER);
    const late = await store.ensureRequested(lateRequest);
    await store.resolve({
      approvalId: late.approval_id,
      status: "approved",
      reviewedBy: "founder",
      surface: "slack",
    });
    const lateEnvelope = createDeliveryEnvelope(
      "envelope-late",
      late.processing_key,
      deliverySurface("team-decisions", "C123"),
      late.brief,
      AFTER_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: lateEnvelope,
      receipt: deliveredReceipt(lateEnvelope, AFTER_CUTOVER),
      savedAt: AFTER_CUTOVER,
    });

    const malformedRequest = approvalRequest("processing:malformed");
    const malformedEnvelope = createDeliveryEnvelope(
      "envelope-malformed",
      malformedRequest.processing_key,
      deliverySurface("team-decisions-malformed", "C456"),
      malformedRequest.brief,
      BEFORE_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: malformedEnvelope,
      receipt: {
        schema_version: 1,
        envelope_id: "wrong-envelope",
        status: "delivered",
        external_id: "provider-message",
        recorded_at: BEFORE_CUTOVER,
        retryable: false,
      },
    });

    const unmatchedRequest = approvalRequest("processing:unmatched");
    const unmatchedEnvelope = createDeliveryEnvelope(
      "envelope-unmatched",
      unmatchedRequest.processing_key,
      deliverySurface("team-decisions-unmatched", "C789"),
      unmatchedRequest.brief,
      BEFORE_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: unmatchedEnvelope,
      receipt: deliveredReceipt(unmatchedEnvelope),
    });
    await store.initialize();
    const databaseBefore = snapshotCoreAndOutbox(databasePath);
    const decisionsBefore = snapshotFiles(join(root, "decisions"));

    const report = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.code).sort()).toEqual(
      [
        "late-delivery-receipt",
        "late-legacy-node-event",
        "malformed-delivery-receipt",
        "unmatched-delivery-receipt",
      ],
    );
    expect(report.violations.map((item) => item.violation_id)).toEqual(
      [...report.violations]
        .sort(
          (left, right) =>
            left.code.localeCompare(right.code) ||
            left.subject_kind.localeCompare(right.subject_kind) ||
            left.subject_id.localeCompare(right.subject_id) ||
            left.evidence_sha256.localeCompare(right.evidence_sha256),
        )
        .map((item) => item.violation_id),
    );
    expect(
      report.delivery_receipts.map((row) => row.disposition).sort(),
    ).toEqual(["late", "malformed", "unmatched"]);
    expect(report.records).toMatchObject([
      {
        approval_id: late.approval_id,
        classification: "disposable_test",
        delivered_receipts: [],
      },
    ]);
    expect(report.counts).toMatchObject({
      decision_nodes_seen: 1,
      legacy_nodes: 1,
      disposable_test: 1,
      legacy_imported_unverified: 0,
      delivery_receipts_seen: 3,
      delivered_receipts_seen: 3,
      matched_delivered_receipts: 0,
      violations: 4,
    });
    expect(snapshotCoreAndOutbox(databasePath)).toBe(databaseBefore);
    expect(snapshotFiles(join(root, "decisions"))).toEqual(decisionsBefore);
    expect(now).toBe(AFTER_CUTOVER);
  });

  it("excludes structurally federated nodes from the legacy record set", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    const capture: DecisionNodeFederationCapture = {
      captureRequested: async () => ({ federation: { native: true } }),
      validateRequested: async () => undefined,
      capturePublished: async ({ reference }) => reference,
      validatePublished: async () => undefined,
      captureResolved: async ({ legacyMetadata }) => legacyMetadata,
      validateResolved: async () => undefined,
    };
    const store = new DecisionNodeStore(root, {
      federationCapture: capture,
      createId: () => "native-node",
    });
    await store.ensureRequested(approvalRequest("processing:native"));

    const report = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });

    expect(report.ok).toBe(true);
    expect(report.records).toEqual([]);
    expect(report.counts).toMatchObject({
      decision_nodes_seen: 1,
      legacy_nodes: 0,
      federated_nodes_excluded: 1,
    });
  });

  it("treats a missing core database as an empty fresh-cutover receipt set", async () => {
    const root = newRoot();
    const databasePath = join(root, "never-opened.sqlite");
    const store = new DecisionNodeStore(root, {
      now: () => BEFORE_CUTOVER,
      createId: () => "fresh-node",
    });

    const report = await classifyLegacyRecords({
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });

    expect(report.ok).toBe(true);
    expect(report.delivery_receipts).toEqual([]);
    expect(report.counts).toMatchObject({
      legacy_nodes: 0,
      disposable_test: 0,
      legacy_imported_unverified: 0,
      delivery_receipts_seen: 0,
    });
    expect(report.records).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);

    const input = {
      state_directory: root,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    };
    const committed = await commitLegacyClassificationReport(input);
    expect(committed.document.classification.delivery_receipts).toEqual([]);
    await expect(
      verifyLegacyClassificationReport(input),
    ).resolves.toMatchObject({
      document: {
        bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      },
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it("blocks cutover until every legacy decision node is terminal and processed", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    const store = new DecisionNodeStore(root, {
      now: () => BEFORE_CUTOVER,
      createId: () => "pending-cutover-node",
    });
    const pending = await store.ensureRequested(
      approvalRequest("processing:pending-cutover"),
    );
    const readiness = {
      decision_nodes: store,
      core_database_path: databasePath,
    };

    await expect(
      assertLegacyProcessingBoundaryReady(readiness),
    ).rejects.toThrow(/unresolved or unprocessed decision node/);
    await store.resolve({
      approvalId: pending.approval_id,
      status: "rejected",
      reviewedBy: "founder",
      surface: "cli",
    });
    await expect(
      assertLegacyProcessingBoundaryReady(readiness),
    ).rejects.toThrow(/unresolved or unprocessed decision node/);

    const database = new Database(databasePath);
    try {
      database
        .prepare(
          "INSERT INTO core_processed_markers (processing_key) VALUES (?)",
        )
        .run(pending.processing_key);
    } finally {
      database.close();
    }
    await expect(
      assertLegacyProcessingBoundaryReady(readiness),
    ).resolves.toEqual({ legacy_records: 1, processed_records: 1 });
  });

  it("commits one canonical private immutable report per validated bootstrap session", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    insertOutboxSentinel(databasePath);
    const store = new DecisionNodeStore(root, {
      now: () => BEFORE_CUTOVER,
      createId: () => "durable-node",
    });
    await store.ensureRequested(approvalRequest("processing:durable-report"));
    await store.initialize();
    const databaseBefore = snapshotCoreAndOutbox(databasePath);
    const decisionsBefore = snapshotFiles(join(root, "decisions"));
    const input = {
      state_directory: root,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    };

    const committed = await commitLegacyClassificationReport(input);
    const reportPath = legacyClassificationReportPath(
      root,
      BOOTSTRAP_SESSION_ID,
    );
    expect(relative(root, reportPath)).toBe(
      join(
        "bootstrap",
        "legacy-classification",
        `report.${BOOTSTRAP_SESSION_ID}.v1.json`,
      ),
    );
    expect(committed).toMatchObject({
      created: true,
      path: reportPath,
      document: {
        schema_version: 1,
        kind: "echo-founder-legacy-classification-report",
        bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      },
    });
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(reportPath, "utf8")).toBe(committed.canonical_json);
    expect(committed.canonical_json).toBe(canonicalJson(committed.document));

    const repeated = await commitLegacyClassificationReport(input);
    expect(repeated).toEqual({ ...committed, created: false });
    const verified = await verifyLegacyClassificationReport(input);
    expect(verified).toEqual({
      path: committed.path,
      canonical_json: committed.canonical_json,
      document: committed.document,
      current_classification: committed.document.classification,
    });
    expect(snapshotCoreAndOutbox(databasePath)).toBe(databaseBefore);
    expect(snapshotFiles(join(root, "decisions"))).toEqual(decisionsBefore);

    await expect(
      commitLegacyClassificationReport({
        ...input,
        bootstrap_session_id: "../../not-a-session",
      }),
    ).rejects.toThrow(/canonical UUIDv4/);
    expect(
      existsSync(
        join(root, "bootstrap", "legacy-classification", "not-a-session"),
      ),
    ).toBe(false);
  });

  it("keeps frozen legacy verification stable across legitimate native activity but rejects late legacy nodes", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    let legacyNumber = 0;
    const legacyStore = new DecisionNodeStore(root, {
      now: () => BEFORE_CUTOVER,
      createId: () => `legacy-boundary-node-${++legacyNumber}`,
    });
    await legacyStore.initialize();
    const committed = await commitLegacyClassificationReport({
      state_directory: root,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: legacyStore,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });
    const capture: DecisionNodeFederationCapture = {
      captureRequested: async () => ({ federation: { native: true } }),
      validateRequested: async () => undefined,
      capturePublished: async ({ reference }) => reference,
      validatePublished: async () => undefined,
      captureResolved: async ({ legacyMetadata }) => legacyMetadata,
      validateResolved: async () => undefined,
    };
    const nativeStore = new DecisionNodeStore(root, {
      federationCapture: capture,
      now: () => AFTER_CUTOVER,
      createId: () => "native-after-cutover-node",
    });
    const native = await nativeStore.ensureRequested(
      approvalRequest("processing:native-after-cutover", AFTER_CUTOVER),
    );
    await nativeStore.resolve({
      approvalId: native.approval_id,
      status: "approved",
      reviewedBy: "founder",
      surface: "slack",
    });
    const nativeEnvelope = createDeliveryEnvelope(
      "envelope-native-after-cutover",
      native.processing_key,
      deliverySurface("native-decisions", "CNATIVE"),
      native.brief,
      AFTER_CUTOVER,
    );
    insertReceiptRow(databasePath, {
      envelope: nativeEnvelope,
      receipt: deliveredReceipt(nativeEnvelope, AFTER_CUTOVER),
      savedAt: AFTER_CUTOVER,
    });

    const verified = await verifyLegacyClassificationReport({
      state_directory: root,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: nativeStore,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    });
    expect(verified.document).toEqual(committed.document);
    expect(verified.current_classification.records_sha256).toBe(
      committed.document.classification.records_sha256,
    );
    expect(verified.current_classification.delivery_receipts_sha256).toBe(
      committed.document.classification.delivery_receipts_sha256,
    );
    expect(verified.current_classification.report_sha256).not.toBe(
      committed.document.classification.report_sha256,
    );
    expect(verified.current_classification.counts).toMatchObject({
      decision_nodes_seen: 1,
      legacy_nodes: 0,
      federated_nodes_excluded: 1,
      delivery_receipts_seen: 1,
      federated_delivery_receipts_excluded: 1,
      violations: 0,
    });
    expect(verified.current_classification.delivery_receipts).toEqual([]);

    await legacyStore.ensureRequested(
      approvalRequest("processing:late-legacy-after-cutover", AFTER_CUTOVER),
    );
    await expect(
      verifyLegacyClassificationReport({
        state_directory: root,
        bootstrap_session_id: BOOTSTRAP_SESSION_ID,
        decision_nodes: nativeStore,
        core_database_path: databasePath,
        cutover_at: CUTOVER_AT,
      }),
    ).rejects.toThrow(/current boundary contains violations/);
  });

  it("fails closed when the durable report is missing, corrupt, or diverges from recomputation", async () => {
    const root = newRoot();
    const databasePath = join(root, "echo-brain.sqlite");
    initializeDatabase(databasePath);
    const store = new DecisionNodeStore(root, {
      now: () => BEFORE_CUTOVER,
      createId: (() => {
        let next = 0;
        return () => `verification-node-${++next}`;
      })(),
    });
    await store.ensureRequested(approvalRequest("processing:verification-one"));
    const input = {
      state_directory: root,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: store,
      core_database_path: databasePath,
      cutover_at: CUTOVER_AT,
    };
    const committed = await commitLegacyClassificationReport(input);

    await expect(
      verifyLegacyClassificationReport({
        ...input,
        bootstrap_session_id: OTHER_BOOTSTRAP_SESSION_ID,
      }),
    ).rejects.toThrow(/verification failed/);

    await store.ensureRequested(approvalRequest("processing:verification-two"));
    await expect(verifyLegacyClassificationReport(input)).rejects.toThrow(
      /frozen legacy evidence diverges/,
    );
    await expect(commitLegacyClassificationReport(input)).rejects.toThrow(
      /different immutable bytes/,
    );
    expect(readFileSync(committed.path, "utf8")).toBe(committed.canonical_json);

    const corruptRoot = newRoot();
    const corruptDatabasePath = join(corruptRoot, "echo-brain.sqlite");
    initializeDatabase(corruptDatabasePath);
    const corruptStore = new DecisionNodeStore(corruptRoot, {
      now: () => BEFORE_CUTOVER,
    });
    await corruptStore.initialize();
    const corruptInput = {
      state_directory: corruptRoot,
      bootstrap_session_id: BOOTSTRAP_SESSION_ID,
      decision_nodes: corruptStore,
      core_database_path: corruptDatabasePath,
      cutover_at: CUTOVER_AT,
    };
    const corruptCommitted =
      await commitLegacyClassificationReport(corruptInput);
    chmodSync(corruptCommitted.path, 0o644);
    await expect(
      verifyLegacyClassificationReport(corruptInput),
    ).rejects.toThrow(/mode 0600/);
    chmodSync(corruptCommitted.path, 0o600);
    writeFileSync(corruptCommitted.path, "{}", { mode: 0o600 });
    await expect(
      verifyLegacyClassificationReport(corruptInput),
    ).rejects.toThrow(/stored report identity or shape is invalid/);
  });
});
