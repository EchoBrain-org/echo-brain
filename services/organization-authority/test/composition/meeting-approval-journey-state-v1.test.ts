import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEETING_APPROVAL_JOURNEY_STATE_APPLICATION_ID_V1,
  MEETING_APPROVAL_JOURNEY_STATE_SCHEMA_VERSION_V1,
  openMeetingApprovalJourneyStateV1,
} from "../../src/composition/meeting-approval-journey-state-v1.js";

const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const SECOND_JOURNEY_ID = "2b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const STARTED_AT = "2026-09-02T12:34:56.000Z";
const CLOSED_AT = "2026-09-02T12:34:57.000Z";
const CARD_STAGED_AT = "2026-09-02T12:35:00.000Z";
const SEARCH_PENDING_AT = "2026-09-02T12:36:00.000Z";
const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-meeting-journey-state-"));
  roots.push(root);
  return join(root, "journey-sidecar.sqlite");
}

function source() {
  return {
    source_identity: "meeting-source-private-sentinel",
    source_revision: "meeting-revision-private-sentinel",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("meeting approval journey state v1", () => {
  it("reopens the independent sidecar with its opaque ID, sequence, and attempts intact", () => {
    const path = databasePath();
    const first = openMeetingApprovalJourneyStateV1(path, {
      create_uuid: () => JOURNEY_ID,
    });

    expect(first.beginOrResumeSource(source())).toEqual({
      journey_id: JOURNEY_ID,
      last_sequence: 0,
      created: true,
    });
    const started = first.reserveStageStart(
      JOURNEY_ID,
      "meeting_source_intake",
      STARTED_AT,
    );
    expect(started).toEqual({ sequence: 1, attempt: 1 });
    expect(
      first.reserveStageClose(
        JOURNEY_ID,
        "meeting_source_intake",
        started.attempt,
        "succeeded",
        CLOSED_AT,
      ),
    ).toEqual({ sequence: 2 });
    expect(first.stageClosed(JOURNEY_ID, "meeting_source_intake")).toBe(true);
    first.close();

    const restarted = openMeetingApprovalJourneyStateV1(path, {
      create_uuid: () => SECOND_JOURNEY_ID,
    });
    expect(restarted.beginOrResumeSource(source())).toEqual({
      journey_id: JOURNEY_ID,
      last_sequence: 2,
      created: false,
    });
    expect(
      restarted.reserveStageStart(
        JOURNEY_ID,
        "meeting_source_intake",
        CARD_STAGED_AT,
      ),
    ).toEqual({ sequence: 3, attempt: 2 });
    expect(
      restarted.reserveStageSkip(
        JOURNEY_ID,
        "meeting_extraction",
        CARD_STAGED_AT,
      ),
    ).toEqual({ sequence: 4, attempt: 1 });
    expect(restarted.readLatestStage(JOURNEY_ID, "meeting_extraction")).toEqual({
      attempt: 1,
      status: "skipped",
      result: null,
      started_at: CARD_STAGED_AT,
      closed_at: CARD_STAGED_AT,
    });
    restarted.close();
  });

  it("uses only digest joins, supports idempotent candidate mapping, and preserves card queue time", () => {
    const path = databasePath();
    const state = openMeetingApprovalJourneyStateV1(path, {
      create_uuid: () => JOURNEY_ID,
    });
    const created = state.beginOrResumeSource(source());
    state.bindCandidate(
      created.journey_id,
      "candidate-private-sentinel",
      null,
    );
    state.bindCandidate(
      created.journey_id,
      "candidate-private-sentinel",
      "approval-private-sentinel",
    );
    state.bindCandidate(
      created.journey_id,
      "candidate-private-sentinel",
      "approval-private-sentinel",
    );
    expect(state.readForApproval("approval-private-sentinel")).toEqual({
      journey_id: JOURNEY_ID,
      last_sequence: 0,
      card_staged_at: null,
      approved_record_awaiting_search_at: null,
    });
    expect(state.markCardStaged(JOURNEY_ID, CARD_STAGED_AT)).toBe(CARD_STAGED_AT);
    expect(state.markCardStaged(JOURNEY_ID, SEARCH_PENDING_AT)).toBe(CARD_STAGED_AT);
    expect(state.readCardStagedAt(JOURNEY_ID)).toBe(CARD_STAGED_AT);

    state.markApprovedRecordAwaitingSearch(JOURNEY_ID, SEARCH_PENDING_AT);
    expect(state.listApprovedRecordsAwaitingSearch()).toEqual([
      { journey_id: JOURNEY_ID, marked_at: SEARCH_PENDING_AT },
    ]);
    expect(state.readForApproval("approval-private-sentinel")).toMatchObject({
      card_staged_at: CARD_STAGED_AT,
      approved_record_awaiting_search_at: SEARCH_PENDING_AT,
    });
    expect(state.completeApprovedRecordSearch(JOURNEY_ID, CLOSED_AT)).toBe(true);
    expect(state.completeApprovedRecordSearch(JOURNEY_ID, CLOSED_AT)).toBe(false);
    expect(state.listApprovedRecordsAwaitingSearch()).toEqual([]);
    state.close();

    const encoded = readFileSync(path).toString("latin1");
    for (const rawValue of [
      "meeting-source-private-sentinel",
      "meeting-revision-private-sentinel",
      "candidate-private-sentinel",
      "approval-private-sentinel",
    ]) {
      expect(encoded).not.toContain(rawValue);
    }
  });

  it("rejects conflicting maps, malformed telemetry values, and a non-sidecar SQLite file", () => {
    const path = databasePath();
    const journeyIds = [JOURNEY_ID, SECOND_JOURNEY_ID];
    const state = openMeetingApprovalJourneyStateV1(path, {
      create_uuid: () => journeyIds.shift() as string,
    });
    const first = state.beginOrResumeSource(source());
    const second = state.beginOrResumeSource({
      source_identity: "other-source-private-sentinel",
      source_revision: "other-revision-private-sentinel",
    });
    state.bindCandidate(first.journey_id, "candidate-a-private-sentinel", "approval-a-private-sentinel");
    expect(() =>
      state.bindCandidate(second.journey_id, "candidate-a-private-sentinel", null),
    ).toThrow(/different journey/);
    expect(() =>
      state.reserveStageStart(first.journey_id, "ask_answer", STARTED_AT),
    ).toThrow(/meeting approval stage/);
    expect(() =>
      state.reserveStageStart(first.journey_id, "meeting_extraction", "not-a-timestamp"),
    ).toThrow(/canonical ISO UTC/);
    state.close();

    const nonSidecarPath = join(roots[0] as string, "not-sidecar.sqlite");
    const unrelated = new Database(nonSidecarPath);
    unrelated.exec("CREATE TABLE unrelated_business_table (id TEXT) STRICT");
    unrelated.close();
    expect(() => openMeetingApprovalJourneyStateV1(nonSidecarPath)).toThrow(/empty SQLite file/);

    const reopened = new Database(path, { readonly: true });
    expect(reopened.pragma("application_id", { simple: true })).toBe(
      MEETING_APPROVAL_JOURNEY_STATE_APPLICATION_ID_V1,
    );
    expect(reopened.pragma("user_version", { simple: true })).toBe(
      MEETING_APPROVAL_JOURNEY_STATE_SCHEMA_VERSION_V1,
    );
    reopened.close();
  });

  it("distinguishes a failed close that may retry from succeeded and skipped terminal stages", () => {
    const state = openMeetingApprovalJourneyStateV1(databasePath(), {
      create_uuid: () => JOURNEY_ID,
    });
    state.beginOrResumeSource(source());
    const first = state.reserveStageStart(JOURNEY_ID, "meeting_extraction", STARTED_AT);
    state.reserveStageClose(
      JOURNEY_ID,
      "meeting_extraction",
      first.attempt,
      "failed",
      CLOSED_AT,
    );
    expect(state.readLatestStage(JOURNEY_ID, "meeting_extraction")).toMatchObject({
      attempt: 1,
      status: "closed",
      result: "failed",
    });
    expect(state.stageClosed(JOURNEY_ID, "meeting_extraction")).toBe(false);
    expect(
      state.reserveStageStart(JOURNEY_ID, "meeting_extraction", CARD_STAGED_AT),
    ).toEqual({ sequence: 3, attempt: 2 });
    state.close();
  });

  it("lists durable open attempts so startup can reconcile an interrupted process", () => {
    const state = openMeetingApprovalJourneyStateV1(databasePath(), {
      create_uuid: () => JOURNEY_ID,
    });
    state.beginOrResumeSource(source());
    expect(
      state.reserveStageStart(JOURNEY_ID, "meeting_extraction", STARTED_AT),
    ).toEqual({ sequence: 1, attempt: 1 });
    expect(state.listOpenStages()).toEqual([
      {
        journey_id: JOURNEY_ID,
        stage: "meeting_extraction",
        attempt: 1,
        started_at: STARTED_AT,
      },
    ]);
    state.reserveStageClose(
      JOURNEY_ID,
      "meeting_extraction",
      1,
      "failed",
      CLOSED_AT,
    );
    expect(state.listOpenStages()).toEqual([]);
    state.close();
  });
});
