import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV4 } from "../../../../src/adapters/persistence/sqlite/baseline.js";
import { runStagingSyntheticPrivateDmCanaryV1 } from "../../../../src/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-v1.js";
import { OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1 } from "../../../../src/composition/providers/openrouter/openrouter-decision-processor-config-v1.js";
import { createGranolaPostCutoffCursor } from "../../../../src/processing/adapters/meeting-sources/granola/index.js";
import {
  assertStagingSyntheticMeetingCanaryV1,
  createStagingSyntheticMeetingCanaryV1,
} from "../../../../src/processing/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.js";
import { granolaAdmittedMeetingSourceCursorPolicyV1 } from "../../../../src/composition/providers/granola/granola-admitted-meeting-source-cursor-policy-v1.js";
import type {
  ApprovalWorkflowStageInputV1,
  ApprovalWorkflowStagerV1,
} from "../../../../src/processing/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { SqliteAuthorityMeetingProcessingStateV1 } from "../../../../src/processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import { openMeetingApprovalJourneyStateV1 } from "../../../../src/composition/meeting-approval-journey-state-v1.js";
import { openMeetingApprovalJourneyTelemetryV1 } from "../../../../src/composition/meeting-approval-journey-telemetry-v1.js";
import type { JourneyTelemetryEventV1 } from "../../../../src/shared/journey-telemetry-v1.js";
import type {
  DecisionProcessorAdapter,
  DecisionSet,
  MeetingDocument,
} from "../../../../src/processing/core/index.js";

const NOW = "2026-08-30T12:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const databases: Database.Database[] = [];
const telemetryRoots: string[] = [];

function database(): Database.Database {
  const value = new Database(":memory:");
  applyAuthorityBaselineV4(value);
  value.prepare(
    `INSERT INTO authority_metadata VALUES (1, 'oau_test', 'org_test', 'Test', '{}', ?, ?)`,
  ).run(NOW, NOW);
  value.prepare(
    `INSERT INTO authority_principals VALUES ('prn_test', 'org_test', 'Founder', ?)`,
  ).run(NOW);
  value.prepare(
    `INSERT INTO authority_memberships (
       membership_id, organization_id, principal_id, membership_type, status,
       provisioned_at, revoked_at, revocation_reason, employee_email_sha256
     ) VALUES ('mem_test', 'org_test', 'prn_test', 'owner', 'active', ?, NULL, NULL, NULL)`,
  ).run(NOW);
  value.prepare(
    `INSERT INTO authority_live_source_admission_v2 (
       singleton, organization_id, principal_id, membership_id, membership_type,
       source_adapter_id, source_adapter_version, source_adapter_instance_id,
       normalizer_version, source_custodian_sha256, source_custodian_assurance,
       source_custodian_observed_at, source_credential_reference_sha256,
       initial_cursor, cutoff_at, processor_adapter_id, processor_instance_id,
       processor_adapter_version, processor_configuration_sha256,
       processor_credential_reference_sha256, semantic_input_sha256, admitted_at
     ) VALUES (1, 'org_test', 'prn_test', 'mem_test', 'owner',
       'granola', '2.2.0', 'founder-granola', '2.2.0', ?,
       'provider_record_owner_observed', ?, ?, ?, ?, 'llm', 'founder-llm', ?,
       ?, ?, ?, ?)`,
  ).run(
    SHA, NOW, SHA, createGranolaPostCutoffCursor(NOW), NOW,
    OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1, SHA, SHA, SHA, NOW,
  );
  databases.push(value);
  return value;
}

class SyntheticCanaryProcessor implements DecisionProcessorAdapter {
  readonly identity = {
    kind: "decision-processor" as const,
    adapter_id: "llm",
    instance_id: "founder-llm",
    version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1,
  };
  calls = 0;
  validateConfig() { return { ok: true, errors: [] }; }
  async healthCheck() { return { status: "healthy" as const, checked_at: NOW }; }
  async extract(meeting: MeetingDocument): Promise<DecisionSet> {
    this.calls += 1;
    return {
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: this.identity,
      generated_at: NOW,
      signals: [{
        id: "synthetic-decision",
        kind: "decision",
        status: "decided",
        text: "verify private owner approval delivery",
        subject: "staging-canary",
        confidence: 1,
        evidence: [{ meeting_id: meeting.id, block_id: "synthetic-decision" }],
      }],
    };
  }
}

class RecordingStager implements ApprovalWorkflowStagerV1 {
  readonly inputs: ApprovalWorkflowStageInputV1[] = [];
  constructor(private readonly state: SqliteAuthorityMeetingProcessingStateV1) {}
  async stage(input: ApprovalWorkflowStageInputV1) {
    this.inputs.push(input);
    const approved_snapshot = Object.freeze({ schema_version: 1 });
    const prepared = this.state.prepareApprovalPost({
      candidate_id: input.candidate.candidate_id,
      frozen_card_sha256: SHA,
      approved_snapshot,
    });
    this.state.recordPostedApprovalCard({
      candidate_id: input.candidate.candidate_id,
      post_started_at: prepared.outbox.post_started_at!,
      presentation_external_id: "1.000001",
      frozen_card_sha256: SHA,
      approved_snapshot,
    });
    this.state.markControlPlaneStaged({
      candidate_id: input.candidate.candidate_id,
      control_approval_sha256: `sha256:${"b".repeat(64)}`,
    });
    return { kind: "staged" as const, stage_id: "stage_synthetic" };
  }
  async reconcilePendingDeliveries() {}
  async reconcileSuperseded() {}
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
  for (const root of telemetryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function journeyTelemetry(now = NOW) {
  const root = mkdtempSync(join(tmpdir(), "echo-synthetic-canary-journey-"));
  telemetryRoots.push(root);
  const state = openMeetingApprovalJourneyStateV1(join(root, "journey.sqlite"), {
    create_uuid: () => "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012",
  });
  const events: JourneyTelemetryEventV1[] = [];
  const telemetry = openMeetingApprovalJourneyTelemetryV1(
    {
      state_directory: root,
      observer: (event) => {
        events.push(event);
      },
      release_sha: "c".repeat(40),
      build_number: 42,
      extraction_provider: "openrouter",
      extraction_model: "deepseek/deepseek-v3.2",
    },
    {
      state,
      now: () => now,
      now_ms: () => 10,
    },
  );
  return { telemetry, events };
}

describe("staging synthetic private-DM canary", () => {
  const canaryInput = {
    canary_id: "private-dm",
    owner_email: "founder@example.com",
    observed_at: NOW,
  } as const;

  function canary(): MeetingDocument {
    return createStagingSyntheticMeetingCanaryV1(canaryInput);
  }

  it("rejects altered content, ownership context, and provenance", () => {
    const content = structuredClone(canary());
    content.content[0]!.text = "Synthetic staging canary only. Decision: altered.";
    const context = structuredClone(canary());
    context.context!.owner_participant_id = "someone-else";
    const provenance = structuredClone(canary());
    provenance.provenance.normalizer_version = "altered-normalizer-v1";

    for (const tampered of [content, context, provenance]) {
      expect(() =>
        assertStagingSyntheticMeetingCanaryV1(tampered, canaryInput),
      ).toThrow("fixed staging synthetic canary");
    }
  });

  it("rejects an otherwise canonical canary with different fixed inputs", () => {
    const anotherOwner = createStagingSyntheticMeetingCanaryV1({
      ...canaryInput,
      owner_email: "other@example.com",
    });

    expect(() =>
      assertStagingSyntheticMeetingCanaryV1(anotherOwner, canaryInput),
    ).toThrow("fixed staging synthetic canary");
  });

  it("uses the admitted LLM and existing approval stager without advancing Granola", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    const stager = new RecordingStager(state);
    const input = {
      authority_url: "https://authority-staging.echobrain.org",
      canary: {
        canary_id: "private-dm",
        owner_email: "founder@example.com",
        observed_at: NOW,
      },
      state,
      processor,
      stager,
    } as const;

    await expect(runStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "staged", reused_frozen_extraction: false,
    });
    await expect(runStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "staged", reused_frozen_extraction: true,
    });

    expect(processor.calls).toBe(1);
    expect(stager.inputs).toHaveLength(1);
    expect(stager.inputs[0]!.meeting.title).toContain("SYNTHETIC STAGING CANARY");
    expect(stager.inputs[0]!.meeting.title).toContain("private-dm");
    expect(stager.inputs[0]!.meeting.content[0]!.text).toContain("private-dm");
    expect(stager.inputs[0]!.meeting.provenance.source.adapter_id).toBe(
      "synthetic-staging-canary",
    );
    expect(stager.inputs[0]!.admission.source.adapter_id).toBe(
      "synthetic-staging-canary",
    );
    expect(
      value.prepare("SELECT cursor FROM authority_live_source_progress_v2").pluck().get(),
    ).toBe(createGranolaPostCutoffCursor(NOW));
  });

  it("correlates the synthetic path and repairs staged human-wait telemetry from the durable outbox", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    const stager = new RecordingStager(state);
    const { telemetry, events } = journeyTelemetry();
    const input = {
      authority_url: "https://authority-staging.echobrain.org",
      canary: canaryInput,
      state,
      processor,
      stager,
      journey_telemetry: telemetry,
    } as const;

    await expect(runStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "staged",
      reused_frozen_extraction: false,
    });
    await expect(runStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "staged",
      reused_frozen_extraction: true,
    });
    await Promise.resolve();

    expect(events.map((event) => `${event.stage}:${event.event}`)).toEqual([
      "meeting_source_intake:started",
      "meeting_source_intake:succeeded",
      "meeting_extraction:started",
      "meeting_extraction:succeeded",
      "meeting_candidate_persist:started",
      "meeting_candidate_persist:succeeded",
      "meeting_source_intake:started",
      "meeting_source_intake:succeeded",
      "meeting_approval_staging:started",
      "meeting_approval_staging:succeeded",
    ]);
    const approval = value
      .prepare("SELECT approval_id FROM authority_live_approval_outbox_v2")
      .pluck()
      .get() as string;
    expect(telemetry.queueAgeMs(approval, NOW)).toBe(0);
    telemetry.close();
  });

  it("uses the durable canary staged timestamp when recovery starts later", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    const stager = new RecordingStager(state);
    const base = {
      authority_url: "https://authority-staging.echobrain.org",
      canary: canaryInput,
      state,
      processor,
      stager,
    } as const;
    await expect(runStagingSyntheticPrivateDmCanaryV1(base)).resolves.toMatchObject({
      kind: "staged",
      reused_frozen_extraction: false,
    });
    const recoveryNow = "2026-08-30T13:00:00.000Z";
    const { telemetry } = journeyTelemetry(recoveryNow);
    await expect(runStagingSyntheticPrivateDmCanaryV1({
      ...base,
      journey_telemetry: telemetry,
    })).resolves.toMatchObject({ kind: "staged", reused_frozen_extraction: true });
    const approval = value
      .prepare("SELECT approval_id FROM authority_live_approval_outbox_v2")
      .pluck()
      .get() as string;
    expect(telemetry.queueAgeMs(approval, recoveryNow)).toBe(3_600_000);
    telemetry.close();
  });

  it("does not invent a recovery-time canary wait anchor from an invalid durable timestamp", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    const stager = new RecordingStager(state);
    const base = {
      authority_url: "https://authority-staging.echobrain.org",
      canary: canaryInput,
      state,
      processor,
      stager,
    } as const;
    await expect(runStagingSyntheticPrivateDmCanaryV1(base)).resolves.toMatchObject({
      kind: "staged",
      reused_frozen_extraction: false,
    });
    value.exec("DROP TRIGGER authority_live_approval_outbox_v2_ordered_transition");
    value
      .prepare("UPDATE authority_live_approval_outbox_v2 SET updated_at = '2026-08-30 12:00:00'")
      .run();
    const recoveryNow = "2026-08-30T13:00:00.000Z";
    const { telemetry } = journeyTelemetry(recoveryNow);

    await expect(runStagingSyntheticPrivateDmCanaryV1({
      ...base,
      journey_telemetry: telemetry,
    })).resolves.toMatchObject({ kind: "staged", reused_frozen_extraction: true });
    const approval = value
      .prepare("SELECT approval_id FROM authority_live_approval_outbox_v2")
      .pluck()
      .get() as string;
    expect(telemetry.queueAgeMs(approval, recoveryNow)).toBeNull();
    telemetry.close();
  });

  it("hard-rejects a non-staging Authority before extraction", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    await expect(runStagingSyntheticPrivateDmCanaryV1({
      authority_url: "https://authority.echobrain.org",
      canary: { canary_id: "private-dm", owner_email: "founder@example.com", observed_at: NOW },
      state,
      processor,
      stager: new RecordingStager(state),
    })).rejects.toThrow("staging-only");
    expect(processor.calls).toBe(0);
  });

  it("does not invoke the stager for an already-aborted frozen candidate", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      granolaAdmittedMeetingSourceCursorPolicyV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    let stageCalls = 0;
    const stager: ApprovalWorkflowStagerV1 = {
      async stage() {
        stageCalls += 1;
        return { kind: "revoked" };
      },
      async reconcilePendingDeliveries() {},
      async reconcileSuperseded() {},
    };
    const input = {
      authority_url: "https://authority-staging.echobrain.org",
      canary: canaryInput,
      state,
      processor,
      stager,
    } as const;

    await expect(runStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "not_staged",
    });
    stageCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error("queued canary deadline exceeded"));

    await expect(
      runStagingSyntheticPrivateDmCanaryV1({ ...input, signal: controller.signal }),
    ).rejects.toThrow("queued canary deadline exceeded");
    expect(stageCalls).toBe(0);
  });
});
