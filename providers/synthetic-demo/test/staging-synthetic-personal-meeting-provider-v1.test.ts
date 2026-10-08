import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagingSyntheticPersonalMeetingProviderV1,
  readStagingSyntheticCheckpointV1,
  readStagingSyntheticMeetingFixturesV1,
  STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
  stagingSyntheticCanaryEntryV1,
  stagingSyntheticCanaryMeetingV1,
  stagingSyntheticCanaryReleaseV1,
  writeStagingSyntheticCheckpointV1,
} from "../src/staging-synthetic-personal-meeting-provider-v1.js";

const demoMeetings = fileURLToPath(new URL("../../../demo/meetings", import.meta.url));
const person = { organization_id: "org_fixture", principal_id: "prn_fixture", membership_id: "mem_fixture" };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixtures(ids: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-synthetic-provider-"));
  directories.push(directory);
  ids.forEach((id, index) => writeFileSync(join(directory, `${String(index).padStart(2, "0")}.json`), JSON.stringify({
    schema_version: 1, id, title: `Fixture ${id}`,
    provenance: { source: { kind: "meeting-source", adapter_id: "fixture", instance_id: "fixture", version: "1.0.0" },
      external_id: id, canonical_revision: `${id}-r1`, observed_at: "2026-10-01T00:00:00.000Z", normalizer_version: "fixture-v1" },
    capture: { state: "complete", components: [] }, participants: [], content: [{ id: "note", kind: "note", text: "A fixture note." }], artifacts: [],
  })));
  return directory;
}

const cursor = (manual: readonly string[]) => writeStagingSyntheticCheckpointV1({ folder: null, baseline: false, revisions: {}, manual });

async function source(options: { readonly fixtures_directory?: string } = {}) {
  const provider = createStagingSyntheticPersonalMeetingProviderV1(options);
  const session = await provider.open(person, () => undefined);
  // A personal source stores the session's tool-account identity exactly.
  const identity = session.identity;
  return { provider, session, identity, adapter: provider.source({ source_adapter_id: identity.adapter_id, source_adapter_version: identity.version, source_adapter_instance_id: identity.instance_id }, () => undefined) };
}

describe("staging synthetic personal meeting provider", () => {
  it("serves a release's queued canary under the stored source identity and drops it from the cursor", async () => {
    const { adapter, identity } = await source();
    const entry = stagingSyntheticCanaryEntryV1("clean-v1-release-one");
    const batch = await adapter.pull({ cursor: cursor([entry]), limit: 1 });
    expect(batch.meetings).toHaveLength(1);
    expect(batch.meetings[0]).toMatchObject({ id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1,
      provenance: { source: identity, external_id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1, canonical_revision: stagingSyntheticCanaryMeetingV1("clean-v1-release-one").provenance.canonical_revision } });
    expect(batch.meetings[0]!.title).toBe("SYNTHETIC STAGING CANARY clean-v1-release-one - Release approval check");
    expect(readStagingSyntheticCheckpointV1(batch.next_cursor!).manual).toEqual([]);
    await expect(adapter.pull({ cursor: cursor([]), limit: 1 })).resolves.toEqual({ meetings: [] });
  });

  it("gives every release one canary meeting id with its own revision, and refuses anything else", async () => {
    const one = stagingSyntheticCanaryMeetingV1("clean-v1-release-one"), two = stagingSyntheticCanaryMeetingV1("clean-v1-release-two");
    expect(two.provenance.external_id).toBe(one.provenance.external_id);
    expect(two.provenance.canonical_revision).not.toBe(one.provenance.canonical_revision);
    expect(stagingSyntheticCanaryReleaseV1(stagingSyntheticCanaryEntryV1("clean-v1-release-two"))).toBe("clean-v1-release-two");
    expect(stagingSyntheticCanaryReleaseV1(STAGING_SYNTHETIC_CANARY_MEETING_ID_V1)).toBeUndefined();
    expect(() => stagingSyntheticCanaryEntryV1("release-two")).toThrow("release id is invalid");
    expect(() => cursor([`${STAGING_SYNTHETIC_CANARY_MEETING_ID_V1}@release two`])).toThrow("cursor is invalid");
    // The bare canary id names no release, so this runtime cannot serve it.
    const { adapter, session } = await source();
    await expect(adapter.pull({ cursor: cursor([STAGING_SYNTHETIC_CANARY_MEETING_ID_V1]), limit: 1 })).rejects.toThrow("not available to this runtime");
    await expect(session.preview(STAGING_SYNTHETIC_CANARY_MEETING_ID_V1)).rejects.toMatchObject({ code: "not_found" });
    await expect(session.preview(stagingSyntheticCanaryEntryV1("clean-v1-release-one"))).resolves.toMatchObject({ id: STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 });
  });

  it("serves fixture meetings by id, previews them, and fails closed for a meeting this runtime cannot serve", async () => {
    const { adapter, session } = await source({ fixtures_directory: fixtures(["fictional-planning", "fictional-retro"]) });
    const batch = await adapter.pull({ cursor: cursor(["fictional-retro", "fictional-planning"]), limit: 1 });
    expect(batch.meetings[0]?.id).toBe("fictional-retro");
    expect(readStagingSyntheticCheckpointV1(batch.next_cursor!).manual).toEqual(["fictional-planning"]);
    await expect(session.preview("fictional-planning")).resolves.toMatchObject({ id: "fictional-planning", notes: "A fixture note." });
    await expect(session.preview("fictional-unknown")).rejects.toMatchObject({ code: "not_found" });
    await expect(adapter.pull({ cursor: cursor(["fictional-unknown"]), limit: 1 })).rejects.toThrow("not available to this runtime");
    await expect((await source()).adapter.pull({ cursor: cursor(["fictional-retro"]), limit: 1 })).rejects.toThrow("not available to this runtime");
  });

  it("reads the demo meetings and refuses reserved or duplicate fixture ids", async () => {
    expect((await readStagingSyntheticMeetingFixturesV1(demoMeetings)).map(meeting => meeting.id)).toHaveLength(4);
    await expect(readStagingSyntheticMeetingFixturesV1(fixtures([STAGING_SYNTHETIC_CANARY_MEETING_ID_V1]))).rejects.toThrow("distinct lowercase ids");
    await expect(readStagingSyntheticMeetingFixturesV1(fixtures(["fictional-planning", "fictional-planning"]))).rejects.toThrow("distinct lowercase ids");
  });

  it("keeps a folder-free checkpoint and reports a linked staging tool", async () => {
    expect(() => readStagingSyntheticCheckpointV1(writeStagingSyntheticCheckpointV1({ folder: "folder", baseline: false, revisions: {}, manual: [] }))).toThrow("cursor is invalid");
    expect(() => readStagingSyntheticCheckpointV1("granola-folder-v1:{}")).toThrow("cursor is invalid");
    const { provider, session } = await source();
    expect(provider.tool("token")).toMatchObject({ tool_id: "synthetic", personal_status: "linked" });
    await expect(session.folders()).resolves.toEqual([]);
    await expect(session.browse("folder")).rejects.toMatchObject({ code: "not_found" });
  });
});
