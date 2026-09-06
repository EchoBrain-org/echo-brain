import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import {
  OrganizationRecordAppenderV4,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
  createRecordPolicyFactProjectorRegistryV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { openAuthorityDatabase } from "../../../../services/organization-authority/dist/adapters/persistence/sqlite/open-authority-database.js";
import { FileOrganizationAuthoritySigner } from "../../../../services/organization-authority/dist/adapters/security/file-organization-authority-signer.js";
import { bootstrapOrganizationAuthorityState } from "../../../../services/organization-authority/dist/composition/organization-authority-state-bootstrap.js";
import { verifyAuthorityStateLineage } from "../../../../services/organization-authority/dist/composition/verify-authority-state-lineage.js";
import { AdmittedMeetingProcessingCycleV1 } from "../../../../services/organization-authority/dist/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../../../services/organization-authority/dist/processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import { createCoreApproval } from "../core-approval.mjs";
import { createCoreIdentity } from "../core-identity.mjs";
import { createCoreInput } from "../core-input.mjs";

const POLICY = "organization-member-readable-person-v2";

function queuedReceiptCount(control) {
  return control.prepare("SELECT count(*) FROM organization_private_approval_signed_action_receipts_v2").pluck().get();
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
  let control;
  let record;
  let controlOpen = false;
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
    control = openOrganizationControlDatabase(join(initialized.state_directory, "integrations.sqlite"), { fileMustExist: true });
    controlOpen = true;
    record = openOrganizationRecordDatabase(join(initialized.state_directory, "record-log.sqlite"), { fileMustExist: true });
    const input = createCoreInput({ authority, coordinates, owner: identity.owner, sessions: identity.sessions });
    const state = new SqliteAuthorityMeetingProcessingStateV1(authority, input.source_cursor_policy, input.processor.identity.adapter_id);
    const signer = FileOrganizationAuthoritySigner.openExisting({ directory: join(initialized.state_directory, "keys"), ...coordinates });
    const projectors = createRecordPolicyFactProjectorRegistryV1([createPrivateSlackBlockApprovalPolicyProjectorV1()]);
    const approvals = await createCoreApproval({
      context: {
        state,
        authority_database: authority,
        control_plane_database: control,
        record_append: new OrganizationRecordAppenderV4(record, coordinates, projectors),
        signer,
        coordinates,
        next_envelope_id: () => `env_${randomUUID()}`,
        on_terminal_action_queued,
      },
      owner: identity.owner,
      employee: identity.employee,
      sessions: identity.sessions,
    });
    const offered = fixtureInput({ source: input.source.identity, processor: input.processor.identity });
    input.offer(offered);
    const cycle = new AdmittedMeetingProcessingCycleV1({
      source: input.source,
      processor: input.processor,
      state,
      stager: approvals.stager,
      source_cursor_policy: input.source_cursor_policy,
    });
    await cycle.runOnce(new AbortController().signal);
    const frozen = await state.readFrozenCandidateForSourceRevision({
      external_id: offered.meeting.provenance.external_id,
      canonical_revision: offered.meeting.provenance.canonical_revision,
    });
    assert.ok(frozen, "the real processing cycle must stage a durable candidate");
    const approval = (offer_id) => approvals.offerApproval({
      approval_id: frozen.approval_id,
      actor: "owner",
      policy_id: POLICY,
      offer_id,
    });
    return {
      approval,
      control,
      closeControl() {
        if (!controlOpen) return;
        control.close();
        controlOpen = false;
      },
      close() {
        if (controlOpen) control.close();
        record.close();
        authority.close();
        identity.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (controlOpen) control?.close();
    record?.close();
    authority?.close();
    identity?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("approval-port wake follows the persisted receipt", async () => {
  let observedReceiptCount = -1;
  let fixture;
  try {
    fixture = await createFixture(() => { observedReceiptCount = queuedReceiptCount(fixture.control); });
    await fixture.approval("wake-after-durable");
    assert.equal(observedReceiptCount, 1);
    assert.equal(queuedReceiptCount(fixture.control), 1);
  } finally {
    fixture?.close();
  }
});

test("a rejected persistence enqueue does not wake publication", async () => {
  let wakes = 0;
  let fixture;
  try {
    fixture = await createFixture(() => { wakes += 1; });
    fixture.closeControl();
    await assert.rejects(fixture.approval("closed-control-database"));
    assert.equal(wakes, 0);
  } finally {
    fixture?.close();
  }
});

test("a failing wake preserves the durable approval receipt", async () => {
  let fixture;
  try {
    fixture = await createFixture(() => { throw new Error("observational wake failure"); });
    const result = await fixture.approval("wake-failure");
    assert.equal(result.idempotent, false);
    assert.equal(queuedReceiptCount(fixture.control), 1);
  } finally {
    fixture?.close();
  }
});

test("duplicate approval retains receipt idempotence and re-requests the lifecycle wake", async () => {
  let wakes = 0;
  let fixture;
  try {
    fixture = await createFixture(() => { wakes += 1; });
    const first = await fixture.approval("duplicate-approval");
    const replay = await fixture.approval("duplicate-approval");
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(queuedReceiptCount(fixture.control), 1);
    assert.equal(wakes, 2);
  } finally {
    fixture?.close();
  }
});
