import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSyntheticDemoMeetingCorpusV1 } from "../../src/source/synthetic-demo-meeting-source-v1.js";

const meetingsDirectory = fileURLToPath(
  new URL("../../../../demo/meetings", import.meta.url),
);

async function withCopiedMeetings(
  run: (copiedMeetings: string, temporaryRoot: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "echo-synthetic-demo-"));
  try {
    const copiedMeetings = join(temporaryRoot, "meetings");
    await cp(meetingsDirectory, copiedMeetings, { recursive: true });
    await run(copiedMeetings, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

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

  it("rejects a meeting with another source identity", () =>
    withCopiedMeetings(async (copiedMeetings) => {
      const target = join(copiedMeetings, "01-revenue-signal-calibration.json");
      const meeting = JSON.parse(await readFile(target, "utf8")) as {
        provenance: { source: { adapter_id: string } };
      };
      meeting.provenance.source.adapter_id = "another-source";
      await writeFile(target, `${JSON.stringify(meeting, null, 2)}\n`);

      await expect(loadSyntheticDemoMeetingCorpusV1(copiedMeetings)).rejects.toThrow(
        /source|identity/i,
      );
    }));

  it("rejects extra entries and symlinked corpus files", () =>
    withCopiedMeetings(async (copiedMeetings, temporaryRoot) => {
      await writeFile(join(copiedMeetings, "unexpected.json"), "{}\n");
      await expect(loadSyntheticDemoMeetingCorpusV1(copiedMeetings)).rejects.toThrow(
        "only the four declared",
      );
      await rm(join(copiedMeetings, "unexpected.json"));
      const target = join(copiedMeetings, "01-revenue-signal-calibration.json");
      const replacement = join(temporaryRoot, "replacement.json");
      await cp(target, replacement);
      await rm(target);
      await symlink(replacement, target);
      await expect(loadSyntheticDemoMeetingCorpusV1(copiedMeetings)).rejects.toThrow(
        "bounded regular files",
      );
    }));

  it("binds each declared filename to its distinct fixture revision", () =>
    withCopiedMeetings(async (copiedMeetings) => {
      await cp(
        join(copiedMeetings, "01-revenue-signal-calibration.json"),
        join(copiedMeetings, "02-data-handling-review.json"),
      );
      await expect(loadSyntheticDemoMeetingCorpusV1(copiedMeetings)).rejects.toThrow(
        "unexpected fixture meeting",
      );
    }));
});
