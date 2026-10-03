import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openExtractionAttemptStoreV1 } from "@echo-brain/organization-processing/adapters/persistence/sqlite-extraction-attempt-store-v1";
import { runOrganizationAuthorityExtractionAttemptCli } from "../src/composition/organization-authority-extraction-attempt-cli.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";

const roots: string[] = [];
const key = {
  admission_sha256: `sha256:${"a".repeat(64)}`,
  review_lineage_id: `rli_${"b".repeat(64)}`,
  review_input_sha256: `sha256:${"c".repeat(64)}`,
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "echo-extraction-recovery-"));
  chmodSync(root, 0o700); roots.push(root);
  const state = join(root, "state");
  const binding = bootstrapOrganizationAuthorityState({
    state_directory: state, organization_display_name: "Private organization content",
    owner_display_name: "Private owner content", created_at: "2026-10-01T00:00:00.000Z",
    creating_artifact_revision: "extraction-recovery-test",
  });
  const ledger = join(state, "extraction-attempts.sqlite");
  const store = openExtractionAttemptStoreV1(ledger, binding);
  const claim = store.reserve(key);
  if (claim.status !== "reserved") throw new Error("test reservation failed");
  store.complete({ key, ...claim, outcome: "failed", failure_code: "invalid_output" });
  store.close();
  const invoke = (args: readonly string[]) => {
    const output: string[] = [];
    const code = runOrganizationAuthorityExtractionAttemptCli([...args, "--state-dir", state], {
      stdout: value => output.push(value), stderr: value => output.push(value),
    });
    return { code, output: output.join(""), value: JSON.parse(output.join("")) as Record<string, unknown> };
  };
  const retry = ["retry", "--admission-sha256", key.admission_sha256,
    "--review-lineage-id", key.review_lineage_id, "--review-input-sha256", key.review_input_sha256,
    "--expected-attempt", "1", "--expected-outcome", "failed", "--confirm-new-model-call"];
  return { state, ledger, binding, invoke, retry };
}

describe("extraction attempt operator recovery", () => {
  it("lists only bounded content-free summaries and explicitly authorizes one attempt", () => {
    const f = fixture();
    const status = f.invoke(["status", "--limit", "1"]);
    expect(status.code).toBe(0);
    expect(status.value.attempts).toEqual([{ ...key, attempt: 1, outcome: "failed", failure_code: "invalid_output", retry_authorized: false }]);
    expect(status.output).not.toMatch(/Private|claim_id|reserved_at|completed_at/);
    expect(f.invoke(f.retry).value.outcome).toBe("authorized");
    expect(f.invoke(f.retry).code).toBe(1);
    const store = openExtractionAttemptStoreV1(f.ledger, f.binding);
    try {
      const next = store.reserve(key);
      expect(next.status).toBe("reserved");
      expect(next.attempt).toBe(2);
      expect(store.reserve(key).status).toBe("blocked");
      expect(store.history(key)).toHaveLength(2);
    } finally { store.close(); }
  });

  it("rejects missing confirmation and stale expected state without authorizing spending", () => {
    const f = fixture();
    expect(() => f.invoke(f.retry.filter(value => value !== "--confirm-new-model-call"))).toThrow(/usage:/);
    expect(f.invoke(f.retry.map(value => value === "1" ? "2" : value)).value.outcome).toBe("conflict");
    const store = openExtractionAttemptStoreV1(f.ledger, f.binding);
    try { expect(store.reserve(key).status).toBe("blocked"); } finally { store.close(); }
    expect(() => f.invoke(["status", "--limit", "101"])).toThrow(/usage:/);
  });

  it("reports pending and successful calls without exposing claim handles or source contents", () => {
    const f = fixture();
    const store = openExtractionAttemptStoreV1(f.ledger, f.binding);
    try {
      const pendingKey = { ...key, review_input_sha256: `sha256:${"d".repeat(64)}` };
      store.reserve(pendingKey);
      const successKey = { ...key, review_input_sha256: `sha256:${"e".repeat(64)}` };
      const claim = store.reserve(successKey);
      if (claim.status !== "reserved") throw new Error("test reservation failed");
      store.complete({ key: successKey, ...claim, outcome: "succeeded" });
    } finally { store.close(); }
    const result = f.invoke(["status"]);
    const attempts = result.value.attempts as { outcome: string }[];
    expect(attempts.map(row => row.outcome).sort()).toEqual(["failed", "pending", "succeeded"]);
    expect(result.output).not.toMatch(/claim_id|Private|reserved_at|completed_at/);
    expect(f.invoke(["status", "--limit", "2"]).value.attempts).toHaveLength(2);
  });

  it("does not recreate a missing ledger during inspection or retry", () => {
    const f = fixture();
    rmSync(f.ledger);
    expect(f.invoke(["status"]).value).toMatchObject({ ledger_present: false, attempts: [] });
    expect(f.invoke(f.retry).value.outcome).toBe("ledger_missing");
    expect(() => new Database(f.ledger, { readonly: true, fileMustExist: true })).toThrow();
  });

  it("requires explicit acknowledgment to recover an interrupted pending provider call", () => {
    const f = fixture();
    expect(f.invoke(f.retry).code).toBe(0);
    const store = openExtractionAttemptStoreV1(f.ledger, f.binding);
    try { expect(store.reserve(key).status).toBe("reserved"); } finally { store.close(); }
    const args = f.retry.map(value => value === "1" ? "2" : value === "failed" ? "pending" : value);
    expect(() => f.invoke(args)).toThrow(/usage:/);
    expect(f.invoke([...args, "--recover-pending"]).value.outcome).toBe("authorized");
  });

  it("refuses another model call when the review input already has a frozen candidate", () => {
    const f = fixture();
    const db = new Database(join(f.state, "authority.sqlite"));
    try {
      // Candidate custody is checked by existence; even an incomplete frozen fixture must refuse spending.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO authority_live_source_candidates_v2 VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("cnd_fixture", key.review_input_sha256, key.admission_sha256, key.review_lineage_id,
          key.review_input_sha256, key.review_input_sha256, "policy", key.review_input_sha256,
          "Private consequence", key.review_input_sha256, "no_signals", "cursor",
          key.review_input_sha256, '{"private":"meeting"}', key.review_input_sha256,
          '{"private":"decisions"}', "2026-10-01T00:00:00.000Z");
    } finally { db.close(); }
    expect(f.invoke(f.retry).value.outcome).toBe("frozen_candidate_exists");
    const store = openExtractionAttemptStoreV1(f.ledger, f.binding);
    try { expect(store.reserve(key).status).toBe("blocked"); } finally { store.close(); }
  });

  it("verifies lineage before opening the ledger and refuses a ledger from another lineage", () => {
    const f = fixture();
    rmSync(f.ledger);
    const wrong = openExtractionAttemptStoreV1(f.ledger, { ...f.binding, state_lineage_id: "lineage-other" });
    wrong.reserve(key); wrong.close();
    expect(() => f.invoke(f.retry)).toThrow(/Extraction attempt state is invalid/);
    rmSync(join(f.state, "state-lineage-root.v2.json"));
    expect(() => f.invoke(["status"])).toThrow(/state-lineage root manifest/);
  });
});
