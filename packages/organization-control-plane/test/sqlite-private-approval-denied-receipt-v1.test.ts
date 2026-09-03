import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256 } from "../src/canonical/canonical-json.js";
import {
  PrivateApprovalDeniedReceiptConflictError,
  SqliteSlackDmApprovalPersistenceV1,
  type PrivateApprovalSignedTerminalActionV1,
} from "../src/persistence/sqlite-slack-dm-approval-persistence-v1.js";

const directories: string[] = [];
const now = () => "2026-08-28T00:00:00.000Z";
const digest = (letter: string) => `sha256:${letter.repeat(64)}` as const;

function receipt(): PrivateApprovalSignedTerminalActionV1 {
  return {
    schema_version: 1,
    kind: "echo-private-approval-signed-block-action-receipt-v1",
    provider_action_key_sha256: digest("a"),
    request: { request_timestamp: "1800000000", signature_version: "v0", signature_sha256: digest("b"), raw_body_sha256: digest("c") },
    approval_id: "apr_00000000-0000-4000-8000-000000000001",
    action_id: "echo-private-approval-v1-action",
    action: "approve",
    selected_policy_id: "restricted-reviewer-person-v2",
    comment: null,
    lookup: { api_app_id: "A01234567", workspace_id: "T01234567", enterprise_id: null, slack_user_id: "U01234567", channel_id: "D01234567", message_ts: "1712345678.123456", message_user_id: "U09876543", message_app_id: "A01234567", message_bot_id: "B01234567" },
    received_at: now(), verified_at: now(),
  };
}

function schema(database: Database.Database) {
  database.exec(`
    CREATE TABLE organization_private_approval_signed_action_receipts_v2 (provider_receipt_id TEXT PRIMARY KEY, provider_action_key TEXT UNIQUE, raw_payload_sha256 TEXT UNIQUE, normalized_receipt_json TEXT, normalized_receipt_sha256 TEXT UNIQUE, approval_id TEXT, action_id TEXT, action_kind TEXT, received_at TEXT, verified_at TEXT);
    CREATE TABLE organization_private_approval_terminal_evidence_v2 (approval_id TEXT PRIMARY KEY, signed_action_receipt_sha256 TEXT UNIQUE);
    CREATE TABLE organization_private_approval_denied_action_receipts_v2 (provider_action_key TEXT PRIMARY KEY, signed_action_receipt_sha256 TEXT UNIQUE, reason_code TEXT, denied_at TEXT);
  `);
}

function seed(
  database: Database.Database,
  value: PrivateApprovalSignedTerminalActionV1 = receipt(),
) {
  const { received_at: _receivedAt, verified_at: _verifiedAt, ...semantic } = value;
  database.prepare(`INSERT INTO organization_private_approval_signed_action_receipts_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `sar_${value.provider_action_key_sha256.slice(7, 39)}`, value.provider_action_key_sha256, value.request.raw_body_sha256, canonicalJson(value), canonicalSha256(semantic), value.approval_id, value.action_id, value.action, value.received_at, value.verified_at,
  );
  return value;
}

function persistence(database: Database.Database) {
  return new SqliteSlackDmApprovalPersistenceV1({ database, now, authority_fence: { async withStablePrivateApprovalFence(commit) { return commit({ approvalIsCurrent: () => false, currentMembership: () => undefined, revalidatePrivateApprovalAuthorization: () => undefined }); } } });
}

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("private approval denied receipt persistence", () => {
  it("treats the same signed action as an idempotent replay despite new local receipt times", () => {
    const database = new Database(":memory:");
    try {
      schema(database);
      database.exec(`CREATE TABLE organization_private_approval_pending_contracts_v2 (approval_id TEXT PRIMARY KEY);`);
      const value = receipt();
      database.prepare(`INSERT INTO organization_private_approval_pending_contracts_v2 VALUES (?)`).run(value.approval_id);
      const store = persistence(database);

      const first = store.enqueue({ disposition: "resolution", receipt: value });
      const replay = store.enqueue({
        disposition: "resolution",
        receipt: { ...value, received_at: "2026-08-28T00:01:00.000Z", verified_at: "2026-08-28T00:01:00.000Z" },
      });

      expect(first).toMatchObject({ disposition: "resolution", idempotent: false });
      expect(replay).toMatchObject({ disposition: "resolution", idempotent: true });
      expect(replay).toMatchObject({ receipt: value });
      expect(database.prepare(`SELECT count(*) AS count FROM organization_private_approval_signed_action_receipts_v2`).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("fails closed when a receipt sharing a provider key or raw payload changes signed action evidence", () => {
    const database = new Database(":memory:");
    try {
      schema(database);
      database.exec(`CREATE TABLE organization_private_approval_pending_contracts_v2 (approval_id TEXT PRIMARY KEY);`);
      const value = receipt();
      database.prepare(`INSERT INTO organization_private_approval_pending_contracts_v2 VALUES (?)`).run(value.approval_id);
      const store = persistence(database);
      store.enqueue({ disposition: "resolution", receipt: value });

      expect(() => store.enqueue({
        disposition: "resolution",
        receipt: { ...value, comment: "tampered after signing" },
      })).toThrow("private approval signed action receipt conflicts");
      expect(() => store.enqueue({
        disposition: "resolution",
        receipt: { ...value, request: { ...value.request, signature_sha256: digest("d") } },
      })).toThrow("private approval signed action receipt conflicts");
      expect(database.prepare(`SELECT count(*) AS count FROM organization_private_approval_signed_action_receipts_v2`).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("durably consumes one queued receipt without creating terminal evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-private-denied-"));
    directories.push(directory);
    const path = join(directory, "control.sqlite");
    let database = new Database(path);
    schema(database);
    const value = seed(database);
    const first = persistence(database);
    expect(first.listQueued()).toHaveLength(1);
    expect(first.recordDenied(value.provider_action_key_sha256, "state_drift")).toMatchObject({ idempotent: false, reason_code: "state_drift" });
    expect(first.listQueued()).toEqual([]);
    expect(first.listDenied()).toEqual([
      { approval_id: value.approval_id },
    ]);
    expect(database.prepare(`SELECT count(*) AS count FROM organization_private_approval_terminal_evidence_v2`).get()).toEqual({ count: 0 });
    database.close();

    database = new Database(path);
    const reopened = persistence(database);
    expect(reopened.listQueued()).toEqual([]);
    expect(reopened.listDenied()).toEqual([
      { approval_id: value.approval_id },
    ]);
    expect(reopened.recordDenied(value.provider_action_key_sha256, "state_drift")).toMatchObject({ idempotent: true });
    expect(() => reopened.recordDenied(value.provider_action_key_sha256, "authorization_denied")).toThrow(PrivateApprovalDeniedReceiptConflictError);
    expect(database.prepare(`SELECT count(*) AS count FROM organization_private_approval_terminal_evidence_v2`).get()).toEqual({ count: 0 });
    database.close();
  });

  it("excludes a late competing denial once the approval has terminal evidence", () => {
    const database = new Database(":memory:");
    try {
      schema(database);
      const approved = seed(database);
      const competing = seed(database, {
        ...approved,
        provider_action_key_sha256: digest("d"),
        request: {
          ...approved.request,
          signature_sha256: digest("e"),
          raw_body_sha256: digest("f"),
        },
      });
      const store = persistence(database);
      database
        .prepare(`INSERT INTO organization_private_approval_terminal_evidence_v2 VALUES (?, ?)`)
        .run(approved.approval_id, digest("g"));

      expect(store.recordDenied(competing.provider_action_key_sha256, "state_drift"))
        .toMatchObject({ idempotent: false, reason_code: "state_drift" });
      expect(store.listDenied()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
