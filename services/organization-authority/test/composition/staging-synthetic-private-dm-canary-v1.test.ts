import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV3 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { stageStagingSyntheticPrivateDmCanaryV1 } from "../../src/composition/staging-synthetic-private-dm-canary-v1.js";
import { CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1 } from "../../src/composition/clean-live-llm-processor-config.js";
import { createGranolaLiveOnlyCursor } from "../../src/processing/adapters/meeting-sources/granola/index.js";
import { granolaLiveSourceBoundaryV1 } from "../../src/composition/granola-live-source-boundary-v1.js";
import type {
  CleanApprovalStageInputV1,
  CleanApprovalStagerV1,
} from "../../src/processing/clean-v1/live-only-source-cycle.js";
import { SqliteCleanLiveOnlySourceStateV1 } from "../../src/processing/clean-v1/sqlite-live-only-source-state.js";
import type {
  DecisionProcessorAdapter,
  DecisionSet,
  MeetingDocument,
} from "../../src/processing/core/index.js";

const NOW = "2026-08-30T12:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;
const databases: Database.Database[] = [];

function database(): Database.Database {
  const value = new Database(":memory:");
  applyAuthorityBaselineV3(value);
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
    SHA, NOW, SHA, createGranolaLiveOnlyCursor(NOW), NOW,
    CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1, SHA, SHA, SHA, NOW,
  );
  databases.push(value);
  return value;
}

class SyntheticCanaryProcessor implements DecisionProcessorAdapter {
  readonly identity = {
    kind: "decision-processor" as const,
    adapter_id: "llm",
    instance_id: "founder-llm",
    version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
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

class RecordingStager implements CleanApprovalStagerV1 {
  readonly inputs: CleanApprovalStageInputV1[] = [];
  constructor(private readonly state: SqliteCleanLiveOnlySourceStateV1) {}
  async stage(input: CleanApprovalStageInputV1) {
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
});

describe("staging synthetic private-DM canary", () => {
  it("uses the admitted LLM and existing approval stager without advancing Granola", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      granolaLiveSourceBoundaryV1,
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

    await expect(stageStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
      kind: "staged", reused_frozen_extraction: false,
    });
    await expect(stageStagingSyntheticPrivateDmCanaryV1(input)).resolves.toMatchObject({
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
    ).toBe(createGranolaLiveOnlyCursor(NOW));
  });

  it("hard-rejects a non-staging Authority before extraction", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      granolaLiveSourceBoundaryV1,
      "llm",
      () => NOW,
    );
    const processor = new SyntheticCanaryProcessor();
    await expect(stageStagingSyntheticPrivateDmCanaryV1({
      authority_url: "https://authority.echobrain.org",
      canary: { canary_id: "private-dm", owner_email: "founder@example.com", observed_at: NOW },
      state,
      processor,
      stager: new RecordingStager(state),
    })).rejects.toThrow("staging-only");
    expect(processor.calls).toBe(0);
  });
});
