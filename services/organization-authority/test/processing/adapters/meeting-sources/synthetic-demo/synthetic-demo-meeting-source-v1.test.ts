import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSyntheticDemoMeetingCorpusV1,
  SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
  SyntheticDemoMeetingSourceAdapterV1,
} from "../../../../../src/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";

const meetingsDirectory = fileURLToPath(
  new URL("../../../../../../../demo/meetings/", import.meta.url),
);

describe("synthetic demo meeting source", () => {
  it("loads the four demo meetings once in filename order with a stable digest", async () => {
    const first = await loadSyntheticDemoMeetingCorpusV1(meetingsDirectory);
    const second = await loadSyntheticDemoMeetingCorpusV1(meetingsDirectory);

    expect(first.meetings.map((meeting) => meeting.id)).toEqual([
      "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24",
      "synthetic-demo-northstar-data-handling-review-2026-08-26",
      "synthetic-demo-northstar-implementation-capacity-2026-08-28",
      "synthetic-demo-northstar-commercial-exception-2026-08-29",
    ]);
    expect(first.corpus_digest).toEqual(second.corpus_digest);
  });

  it("rejects a meeting with another source identity", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "echo-synthetic-demo-"));
    const copiedMeetings = join(temporaryRoot, "meetings");

    try {
      await cp(meetingsDirectory, copiedMeetings, { recursive: true });
      const target = join(copiedMeetings, "01-revenue-signal-calibration.json");
      const meeting = JSON.parse(await readFile(target, "utf8")) as {
        provenance: { source: { adapter_id: string } };
      };
      meeting.provenance.source.adapter_id = "another-source";
      await writeFile(target, `${JSON.stringify(meeting, null, 2)}\n`);

      await expect(loadSyntheticDemoMeetingCorpusV1(copiedMeetings)).rejects.toThrow(
        /source|identity/i,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("advances four one-item polls to an empty terminal cursor without replay", async () => {
    const corpus = await loadSyntheticDemoMeetingCorpusV1(meetingsDirectory);
    const source = new SyntheticDemoMeetingSourceAdapterV1(corpus);
    let cursor: string | undefined = SYNTHETIC_DEMO_INITIAL_CURSOR_V1;
    const received: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      const page = await source.pull({ cursor, limit: 1 });
      received.push(...page.meetings.map((meeting) => meeting.id));
      expect(page.next_cursor).toBeDefined();
      expect(page.next_cursor).not.toBe(cursor);
      cursor = page.next_cursor;
    }

    const terminal = await source.pull({ cursor, limit: 1 });
    const repeatedTerminal = await source.pull({ cursor, limit: 1 });

    expect(received).toEqual(corpus.meetings.map((meeting) => meeting.id));
    expect(terminal).toEqual({ meetings: [] });
    expect(repeatedTerminal).toEqual(terminal);
  });

  it("rejects non-canonical and out-of-range cursors", async () => {
    const corpus = await loadSyntheticDemoMeetingCorpusV1(meetingsDirectory);
    const source = new SyntheticDemoMeetingSourceAdapterV1(corpus);

    for (const cursor of [
      "synthetic-demo-source:customer-demo:1.0.0:v1:",
      "synthetic-demo-source:customer-demo:1.0.0:v1:01",
      "synthetic-demo-source:customer-demo:1.0.0:v1:1e0",
      "synthetic-demo-source:customer-demo:1.0.0:v1:5",
    ]) {
      await expect(source.pull({ cursor, limit: 1 })).rejects.toThrow(
        "synthetic-demo cursor is invalid",
      );
    }
  });
});
