import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConfig } from "@echo-brain/organization-processing/core";
import type {
  GranolaApiClient,
  GranolaListParams,
  GranolaNoteDetail,
} from "../../../providers/granola/src/source/granola-api-client.js";
import { GranolaMeetingSourceAdapter } from "../../../providers/granola/src/source/meeting-source-adapter.js";
import { SqliteContextCaptureReaderV1 } from "../src/adapters/persistence/sqlite/context-capture-reader-v1.js";
import { createGranolaContextIntakeV1 } from "../src/composition/provider-context-intakes-v1.js";
import type { ContextSourceIntakeV1 } from "../src/composition/context-source-intake-v1.js";
import type {
  ContextIntakeAuthorityV1,
  ContextIntakePolicyV1,
} from "../src/application/context-intake-v1.js";
import {
  OWNER,
  projectContextDatabase,
} from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const granolaConfig: AdapterConfig = {
  adapter_id: "granola",
  instance_id: "primary",
  settings: { page_size: 1 },
};

const initialDetail: GranolaNoteDetail = {
  id: "note-1",
  title: "Granola context intake",
  created_at: "2026-09-30T16:00:00.000Z",
  updated_at: "2026-09-30T17:00:00.000Z",
  summary_markdown: "## Decision\nRetain the source observation.",
  attendees: [{ id: "person-1", email: "owner@example.test" }],
  calendar_event: {
    start: { dateTime: "2026-09-30T09:30:00-07:00" },
  },
  web_url: "https://app.granola.ai/notes/note-1",
  transcript: [{ text: "The integration reads the configured source once." }],
};

class FakeGranolaClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  constructor(public detail: GranolaNoteDetail) {}

  async listNotes(params: GranolaListParams) {
    this.listCalls.push(params);
    return {
      notes: [
        {
          id: this.detail.id,
          created_at: this.detail.created_at,
          updated_at: this.detail.updated_at,
        },
      ],
      hasMore: false,
      cursor: null,
    };
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    this.detailCalls.push(noteId);
    return this.detail;
  }
}

const scope = {
  organization_id: OWNER.organization_id,
  custody_ref: "granola:primary",
  access_policy_ref: "granola-context-capture",
  analysis_policy: "on_request" as const,
};

function retainedPolicy(
  disposition: ContextIntakePolicyV1["disposition"] = "retained",
): ContextIntakePolicyV1 {
  return {
    disposition,
    scope,
    permitted_representations: ["full_snapshot", "pointer"],
  };
}

function database(path?: string): Database.Database {
  const value = projectContextDatabase(path);
  databases.push(value);
  return value;
}

function source(detail: GranolaNoteDetail, captureAt: () => string) {
  const client = new FakeGranolaClient(detail);
  const meetingSource = new GranolaMeetingSourceAdapter(granolaConfig, {
    client,
    now: () => "2026-10-01T00:00:00.000Z",
  });
  return {
    client,
    meetingSource,
    captureAt,
  };
}

function intake(input: {
  readonly source: ReturnType<typeof source>;
  readonly database: Database.Database;
  readonly authority: ContextIntakeAuthorityV1;
  readonly disposition?: ContextIntakePolicyV1["disposition"];
  readonly requireReadCurrent?: () => void;
  readonly sourceInstanceId?: string;
}): ContextSourceIntakeV1 {
  const disposition = input.disposition ?? "retained";
  return createGranolaContextIntakeV1({
    source: input.source.meetingSource,
    source_instance_id: input.sourceInstanceId ?? "primary",
    organization_id: OWNER.organization_id,
    authority: input.authority,
    require_read_current: input.requireReadCurrent ?? (() => undefined),
    now: input.source.captureAt,
    retention:
      disposition === "retained"
        ? { disposition, database: input.database }
        : { disposition },
  });
}

function countContents(value: Database.Database): number {
  return (
    value
      .prepare("SELECT count(*) AS n FROM authority_source_contents_v1")
      .get() as { n: number }
  ).n;
}

describe("Granola context source intake V1", () => {
  it("pulls the configured Granola adapter once, retains immutable bytes, deduplicates replay, and persists a changed revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-granola-context-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    const value = database(path);
    let capturedAt = "2026-10-01T01:00:00.000Z";
    const configured = source({ ...initialDetail }, () => capturedAt);
    const authority: ContextIntakeAuthorityV1 = {
      select: () => retainedPolicy(),
      requireCurrent: () => undefined,
    };
    const configuredIntake = intake({
      source: configured,
      database: value,
      authority,
    });

    const first = await configuredIntake.pull();
    const firstCapture = first.captures[0]!.source;
    expect(first.next_cursor).toBeDefined();
    expect(first.captures).toMatchObject([{ admission: "admitted" }]);
    expect(configured.client.listCalls).toEqual([{ page_size: 1 }]);
    expect(configured.client.detailCalls).toEqual(["note-1"]);
    expect(new SqliteContextCaptureReaderV1(value).list({
      organization_id: OWNER.organization_id,
    })).toEqual([
      expect.objectContaining({ source: firstCapture, scope }),
    ]);

    capturedAt = "2026-10-01T01:05:00.000Z";
    const replay = await configuredIntake.pull({ cursor: first.next_cursor });
    expect(replay.captures).toMatchObject([{ admission: "duplicate" }]);
    expect(replay.captures[0]!.source.revision.revision_id).toBe(
      firstCapture.revision.revision_id,
    );

    capturedAt = "2026-10-01T01:10:00.000Z";
    configured.client.detail = {
      ...configured.client.detail,
      updated_at: "2026-09-30T18:00:00.000Z",
      summary_markdown: "## Decision\nRetain the revised source observation.",
    };
    const changed = await configuredIntake.pull({ cursor: replay.next_cursor });
    expect(changed.captures).toMatchObject([{ admission: "admitted" }]);
    expect(changed.captures[0]!.source.revision.revision_id).not.toBe(
      firstCapture.revision.revision_id,
    );
    expect(countContents(value)).toBe(2);

    value.close();
    databases.splice(databases.indexOf(value), 1);
    const reopened = new Database(path);
    reopened.pragma("foreign_keys = ON");
    databases.push(reopened);
    const retained = new SqliteContextCaptureReaderV1(reopened).list({
      organization_id: OWNER.organization_id,
    });
    expect(retained.map((entry) => entry.source)).toContainEqual(firstCapture);
    expect(retained.map((entry) => entry.source)).toContainEqual(
      changed.captures[0]!.source,
    );
  });

  it("rechecks the retention fence after a real source pull and returns neither custody nor a cursor on revocation", async () => {
    const value = database();
    const configured = source({ ...initialDetail }, () => "2026-10-01T01:00:00.000Z");
    let selectedInTransaction = false;
    const authority: ContextIntakeAuthorityV1 = {
      select: () => {
        if (value.inTransaction) selectedInTransaction = true;
        return retainedPolicy();
      },
      requireCurrent: () => {
        if (value.inTransaction) throw new Error("Granola retention revoked");
      },
    };
    const configuredIntake = intake({
      source: configured,
      database: value,
      authority,
    });

    await expect(configuredIntake.pull()).rejects.toThrow("Granola retention revoked");
    expect(configured.client.detailCalls).toEqual(["note-1"]);
    expect(selectedInTransaction).toBe(true);
    expect(countContents(value)).toBe(0);
  });

  it("keeps request-only Granola observations out of Authority custody", async () => {
    const value = database();
    const configured = source({ ...initialDetail }, () => "2026-10-01T01:00:00.000Z");
    const authority: ContextIntakeAuthorityV1 = {
      select: () => retainedPolicy("request_only"),
      requireCurrent: () => undefined,
    };
    const configuredIntake = intake({
      source: configured,
      database: value,
      authority,
      disposition: "request_only",
    });

    const pulled = await configuredIntake.pull();

    expect(pulled.captures).toMatchObject([{ admission: "request_only" }]);
    expect(pulled.next_cursor).toBeDefined();
    expect(configured.client.detailCalls).toEqual(["note-1"]);
    expect(countContents(value)).toBe(0);
  });

  it("refuses a Granola source whose instance does not match the configured binding before transport", () => {
    const value = database();
    const configured = source(
      { ...initialDetail },
      () => "2026-10-01T01:00:00.000Z",
    );
    const authority: ContextIntakeAuthorityV1 = {
      select: () => retainedPolicy(),
      requireCurrent: () => undefined,
    };

    expect(() =>
      intake({
        source: configured,
        database: value,
        authority,
        sourceInstanceId: "wrong-instance",
      }),
    ).toThrow("configured binding");
    expect(configured.client.listCalls).toEqual([]);
    expect(configured.client.detailCalls).toEqual([]);
  });
});
