import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  OrganizationRecordAppenderV4,
  createRecordPolicyFactProjectorRegistryV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { openAuthorityDatabase } from "../../../../packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../../../../services/organization-authority/dist/adapters/security/file-organization-authority-signer.js";
import { bootstrapOrganizationAuthorityState } from "../../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { createPersonMeetingApprovalPolicyProjectorV1 } from "../../../../services/organization-authority/dist/composition/person-meeting-approval-projection-v1.js";
import { verifyAuthorityStateLineage } from "../../../../packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js";
import { AdmittedMeetingProcessingCycleV1 } from "../../../../packages/organization-processing/dist/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../../../packages/organization-processing/dist/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import { CORE_APPROVAL_POLICIES, createCoreApproval } from "../core-approval.mjs";
import { createCoreIdentity } from "../core-identity.mjs";
import { createCoreInput, createCoreSourceIngestion } from "../core-input.mjs";

const POLICY = CORE_APPROVAL_POLICIES.restricted;

function queuedActionCount(authority) {
  return authority.prepare("SELECT count(*) FROM authority_person_meeting_approval_actions_v1").pluck().get();
}

function fixtureInput(identities) {
  const text = "Approval-port wake coverage preserves durable queue ordering.";
  const now = "2026-09-06T00:00:00.000Z";
  const meeting = {
    schema_version: 1,
    id: "core-approval-wake:meeting",
    title: "Approval wake review",
    provenance: {
      source: identities.source,
      external_id: "approval-wake-meeting",
      canonical_revision: canonicalSha256({ text }),
      observed_at: now,
      normalizer_version: identities.source.version,
    },
    capture: { state: "complete", components: [] },
    participants: [{ id: "owner", display_name: "Core Owner", identities: [{ kind: "email", value: "core-owner@example.test" }] }],
    content: [{ id: "block-1", kind: "note", text }],
    artifacts: [],
    context: { owner_participant_id: "owner" },
  };
  const decisions = {
    schema_version: 1,
    meeting_id: meeting.id,
    meeting_revision: meeting.provenance.canonical_revision,
    processor: identities.processor,
    generated_at: now,
    signals: [{ id: "decision-1", kind: "decision", status: "decided", text, subject: null, confidence: 1, evidence: [{ meeting_id: meeting.id, block_id: "block-1" }] }],
  };
  return { meeting, decisions };
}

async function createFixture(on_terminal_action_queued) {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-core-approval-wake-"));
  chmodSync(directory, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(directory, "state"),
    organization_display_name: "Core approval wake test",
    owner_display_name: "Core Owner",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "capacity-core-approval-wake-test",
  });
  let identity;
  let authority;
  let record;
  let authorityOpen = false;
  try {
    identity = await createCoreIdentity({
      state_directory: initialized.state_directory,
      owner_membership_id: initialized.owner_membership_id,
      pkce_sealing_key: randomBytes(32),
    });
    const { root } = verifyAuthorityStateLineage(initialized.state_directory);
    const coordinates = {
      authority_id: root.authority_id,
      organization_id: root.organization_id,
      state_lineage_id: root.state_lineage_id,
    };
    authority = openAuthorityDatabase(join(initialized.state_directory, "authority.sqlite"), { fileMustExist: true });
    authorityOpen = true;
    record = openOrganizationRecordDatabase(join(initialized.state_directory, "record-log.sqlite"), { fileMustExist: true });
    const input = createCoreInput({ authority, coordinates, owner: identity.owner, sessions: identity.sessions });
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      authority, input.source_cursor_policy, input.processor.identity.adapter_id, undefined, input.source_key, () => input.requireCurrent(),
    );
    const signer = FileOrganizationAuthoritySigner.openExisting({ directory: join(initialized.state_directory, "keys"), ...coordinates });
    const projectors = createRecordPolicyFactProjectorRegistryV1([createPersonMeetingApprovalPolicyProjectorV1()]);
    const approvals = await createCoreApproval({
      context: {
        state,
        authority_database: authority,
        record_append: new OrganizationRecordAppenderV4(record, coordinates, projectors),
        signer,
        coordinates,
        next_envelope_id: () => `env_${randomUUID()}`,
        on_terminal_action_queued,
      },
      input,
      owner: identity.owner,
      employee: identity.employee,
      sessions: identity.sessions,
    });
    const offered = fixtureInput({ source: input.source.identity, processor: input.processor.identity });
    input.offer(offered);
    const cycle = new AdmittedMeetingProcessingCycleV1({
      source: input.source,
      source_ingestion: createCoreSourceIngestion({ authority, setting: input.setting, state, source: input.source }),
      processor: input.processor,
      state,
      stager: approvals.stager,
      source_cursor_policy: input.source_cursor_policy,
    });
    const staged = await cycle.runOnce(new AbortController().signal);
    assert.equal(staged.kind, "staged", "the current source-custody path must stage the approval");
    assert.equal(
      authority.prepare("SELECT count(*) FROM authority_source_revisions_v1").pluck().get(),
      1,
      "the staged approval must retain its source revision in Authority custody",
    );
    const frozen = await state.readFrozenCandidateForSourceRevision({
      external_id: offered.meeting.provenance.external_id,
      canonical_revision: offered.meeting.provenance.canonical_revision,
    });
    assert.ok(frozen, "the real processing cycle must stage a durable candidate");
    const approval = (offer_id, actor = "owner") => approvals.offerApproval({
      approval_id: frozen.approval_id,
      actor,
      policy_id: POLICY,
      offer_id,
    });
    return {
      approval,
      authority,
      snapshot_sha256: () => state.readFrozenCandidateForApproval(frozen.approval_id).approved_snapshot_sha256,
      closeAuthority() {
        if (!authorityOpen) return;
        authority.close();
        authorityOpen = false;
      },
      close() {
        record.close();
        if (authorityOpen) authority.close();
        identity.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    record?.close();
    if (authorityOpen) authority?.close();
    identity?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("approval-port wake follows the persisted action", async () => {
  let observedActionCount = -1;
  let observedInTransaction;
  let fixture;
  try {
    fixture = await createFixture(() => {
      observedActionCount = queuedActionCount(fixture.authority);
      observedInTransaction = fixture.authority.inTransaction;
    });
    const result = await fixture.approval("wake-after-durable");
    assert.equal(result.status, "publishing");
    assert.equal(observedActionCount, 1);
    assert.equal(observedInTransaction, false, "the wake runs only after the action transaction commits");
    assert.equal(queuedActionCount(fixture.authority), 1);
    const action = fixture.authority.prepare("SELECT command_id, body_json FROM authority_person_meeting_approval_actions_v1").get();
    assert.equal(action.command_id, "wake-after-durable");
    const { request } = JSON.parse(action.body_json);
    assert.equal(request.snapshot_sha256, fixture.snapshot_sha256(), "the durable action binds the frozen snapshot the reviewer saw");
    assert.equal(request.action, "approve");
  } finally {
    fixture?.close();
  }
});

test("a refused reviewer does not wake publication", async () => {
  let wakes = 0;
  let fixture;
  try {
    fixture = await createFixture(() => { wakes += 1; });
    await assert.rejects(fixture.approval("wrong-reviewer", "employee"), /not available/);
    assert.equal(wakes, 0);
    assert.equal(queuedActionCount(fixture.authority), 0, "a refused action leaves no durable action");
  } finally {
    fixture?.close();
  }
});

test("a rejected persistence step does not wake publication", async () => {
  let wakes = 0;
  let fixture;
  try {
    fixture = await createFixture(() => { wakes += 1; });
    fixture.closeAuthority();
    await assert.rejects(fixture.approval("closed-authority-database"), /not open/);
    assert.equal(wakes, 0);
  } finally {
    fixture?.close();
  }
});

test("a failing wake preserves the durable approval action", async () => {
  let fixture;
  try {
    fixture = await createFixture(() => { throw new Error("observational wake failure"); });
    const result = await fixture.approval("wake-failure");
    assert.equal(result.idempotent, false);
    assert.equal(queuedActionCount(fixture.authority), 1);
  } finally {
    fixture?.close();
  }
});

test("duplicate approval retains action idempotence and re-requests the lifecycle wake", async () => {
  let wakes = 0;
  let fixture;
  try {
    fixture = await createFixture(() => { wakes += 1; });
    const first = await fixture.approval("duplicate-approval");
    const replay = await fixture.approval("duplicate-approval");
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(queuedActionCount(fixture.authority), 1);
    assert.equal(wakes, 2);
  } finally {
    fixture?.close();
  }
});
