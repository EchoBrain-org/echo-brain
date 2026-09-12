import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { bindApprovalWorkflowStateV1 } from "../../src/admitted-meeting-processing/approval-workflow-state-v1.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import { ADVANCED_AT, assertActionable, database, databases, decisions, fixtureCursorPolicy, meeting, REVIEW_POLICY } from "./fixtures/sqlite-meeting-state.js";

it("serializes the two same-file authority handles and refuses cross-port calls inside either transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "echo-approval-order-"));
  const seed = database();
  const path = join(root, "authority.sqlite");
  await seed.backup(path);
  seed.close(); databases.splice(databases.indexOf(seed), 1);
  const owner = openAuthorityDatabase(path, { fileMustExist: true });
  const provider = openAuthorityDatabase(path, { fileMustExist: true });
  // Do not spend five seconds reproducing the lock if a guard regresses.
  owner.pragma("busy_timeout = 0"); provider.pragma("busy_timeout = 0");
  try {
    const source = new SqliteAuthorityMeetingProcessingStateV1(owner, fixtureCursorPolicy, "llm", () => ADVANCED_AT);
    const candidate = await source.stageCandidate({ admission: await source.readAdmission(), meeting, decisions, review_policy: REVIEW_POLICY });
    assertActionable(candidate);
    const state = bindApprovalWorkflowStateV1(bindApprovalWorkflowStateV1(source, () => {
      if (owner.inTransaction) throw new Error("owner transaction must be idle");
    }), () => {
      if (provider.inTransaction) throw new Error("provider transaction must be idle");
    });
    const input = { candidate_id: candidate.candidate_id, reason_code: "approval_package_unrepresentable" as const };
    provider.exec("BEGIN IMMEDIATE");
    expect(() => source.quarantineApprovalDelivery(input)).toThrow(/locked/);
    provider.exec("ROLLBACK");
    for (const [connection, label] of [[owner, "owner"], [provider, "provider"]] as const) {
      connection.exec("BEGIN IMMEDIATE");
      try {
        for (const operation of Object.values(state)) {
          expect(() => (operation as () => unknown)()).toThrow(`${label} transaction must be idle`);
        }
        expect(() => state.quarantineApprovalDelivery(input)).toThrow(`${label} transaction must be idle`);
      } finally { connection.exec("ROLLBACK"); }
    }
    expect(state.readApprovalDeliveryQuarantine(candidate.candidate_id)).toBeUndefined();
    state.quarantineApprovalDelivery(input);
    // The provider's next transaction observes the committed state on its own handle.
    provider.exec("BEGIN IMMEDIATE");
    expect(provider.prepare("SELECT candidate_id FROM authority_live_approval_delivery_quarantines_v1").pluck().get()).toBe(candidate.candidate_id);
    provider.exec("COMMIT");
    expect(state.readApprovalDeliveryQuarantine(candidate.candidate_id)?.reason_code).toBe(input.reason_code);
    expect(Object.isFrozen(state)).toBe(true);
  } finally {
    if (owner.inTransaction) owner.exec("ROLLBACK");
    if (provider.inTransaction) provider.exec("ROLLBACK");
    provider.close(); owner.close(); rmSync(root, { recursive: true, force: true });
  }
});
