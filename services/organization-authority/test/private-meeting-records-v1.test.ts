// A meeting item kept for its approver alone inside a project (ADR-0049): every Person read of approved records, for the
// approver and for another member of the same project.
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { approvalRecordIdV2 } from "@echo-brain/organization-protocol";
import { PersonRecordReaderV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createRecordProjectAuthorizationV1 } from "../src/composition/person-record-project-scope-v1.js";
import type { PersonItemPositionV1, PersonStoreMeetingRowV1 } from "../src/application/ports/person-list-v1.js";
import type { PersonAskScopeV2 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import type { PersonRecordSearchRouteV1 } from "../src/composition/person-record-search-route.js";
import { failure } from "./authority-failure.js";
import { EMP_A, OWNER, SHARED, T, meetingWorld, type MeetingWorldV1, type ReaderToken } from "./fixtures/person-meeting-world.js";

const worlds: MeetingWorldV1[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

const GLOBAL: PersonAskScopeV2 = { kind: "global" };
const IN_SHARED: PersonAskScopeV2 = { kind: "project", project_id: SHARED };

/** OWNER and EMP_A both hold SHARED. OWNER keeps "kept" for themself inside SHARED and shares "open" with it. */
async function world() {
  const w = await meetingWorld({ extra: [
    { name: "kept", approval_id: "apr_kept", projects: [SHARED], private: true, final_approver: OWNER, issued_at: T(10),
      brief: (brief) => ({ ...brief, meeting: { ...brief.meeting, title: "Supplier reserve" }, decisions: brief.decisions.map((signal) => ({ ...signal, text: "Keep the reserve VIOLET-62" })) }) },
    { name: "open", approval_id: "apr_open", projects: [SHARED], final_approver: OWNER, issued_at: T(11),
      brief: (brief) => ({ ...brief, decisions: brief.decisions.map((signal) => ({ ...signal, text: "Ship the reserve plan" })) }) },
  ] });
  worlds.push(w);
  return w;
}

/** collect(limit) → commit(all) until a short page, as the list route drives one source. */
function walk(route: PersonRecordSearchRouteV1, token: ReaderToken, scope: PersonAskScopeV2): PersonStoreMeetingRowV1[] {
  const rows: PersonStoreMeetingRowV1[] = [];
  let after: PersonItemPositionV1 | null = null;
  for (let page = 0; page < 50; page += 1) {
    const collected = route.collectMeetings({ access_token: token, scope, after, limit: 26 });
    if (collected.status !== "ok") throw new Error("meetings were held");
    route.commitMeetings({ access_token: token, handle: collected.handle, count: collected.rows.length });
    rows.push(...collected.rows);
    if (collected.rows.length < 26) return rows;
    const last = collected.rows.at(-1)!;
    after = { added_at: last.added_at, id: last.id };
  }
  throw new Error("walk did not end");
}

const records = (result: { readonly response: { readonly items: readonly { readonly record_sha256: Sha256Digest }[] } }) =>
  [...new Set(result.response.items.map((item) => item.record_sha256))];

describe("a meeting item kept private inside a project (ADR-0049)", () => {
  it("shows in its project to its approver alone: list, search, Ask's desk and open", async () => {
    const w = await world();
    const route = w.route();
    const kept = w.digest("kept"), open = w.digest("open");
    // The person list: filed in SHARED, read only by its approver, who sees it there and everywhere.
    for (const scope of [GLOBAL, IN_SHARED]) {
      expect(walk(route, "owner", scope).find((row) => row.id === kept)).toEqual({ kind: "meeting", id: kept, title: "Supplier reserve", added_at: T(10),
        visibility: "approver_only", association_project_ids: [SHARED] });
    }
    // Search, and the record desk Ask reads, in the project and globally.
    for (const project_id of [undefined, SHARED]) {
      const scoped = project_id === undefined ? {} : { project_id };
      expect(records(route.searchBatch({ access_token: "owner", query: "reserve", desk: true, ...scoped })).sort()).toEqual([kept, open].sort());
      expect(records(route.listDeskBatch({ access_token: "owner", ...scoped }))).toContain(kept);
    }
    // Open, and what the open items and a project's follow-ups read.
    expect(route.openMeeting({ access_token: "owner", record_sha256: kept }).row).toMatchObject({ visibility: "approver_only", association_project_ids: [SHARED] });
    expect(route.readableDecisions({ access_token: "owner", record_sha256s: [kept] }).get(kept))
      .toMatchObject({ approval_id: approvalRecordIdV2("apr_kept", [SHARED], true), project_ids: [SHARED], visibility: "approver_only" });
    expect(route.projectRecords({ access_token: "owner", project_id: SHARED, limit: 500 })).toContain(kept);
  });

  it("never lets another member of the project read, list, search, count or open it", async () => {
    const w = await world();
    const route = w.route();
    const kept = w.digest("kept"), open = w.digest("open");
    // EMP_A holds SHARED and reads the record OWNER shared with it there: the private one is simply absent.
    for (const scope of [GLOBAL, IN_SHARED]) {
      const rows = walk(route, "emp_a", scope);
      expect(rows.map((row) => row.id)).toContain(open);
      expect(rows.map((row) => row.id)).not.toContain(kept);
    }
    for (const project_id of [undefined, SHARED]) {
      const scoped = project_id === undefined ? {} : { project_id };
      const searched = route.searchBatch({ access_token: "emp_a", query: "reserve", desk: true, ...scoped });
      expect(records(searched)).toEqual([open]);
      expect(JSON.stringify(searched)).not.toContain("VIOLET-62");
      expect(records(route.listDeskBatch({ access_token: "emp_a", ...scoped }))).not.toContain(kept);
    }
    // A guessed digest opens nothing and names nothing, as a record that does not exist.
    expect(failure(() => route.openMeeting({ access_token: "emp_a", record_sha256: kept }))).toEqual({ code: "not_found", message: "item is not available" });
    expect(route.readableDecisions({ access_token: "emp_a", record_sha256s: [kept] }).size).toBe(0);
    expect(route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 500 })).not.toContain(kept);
    expect(() => route.recordProjects({ access_token: "emp_a", record_sha256: kept })).toThrow(expect.objectContaining({ code: "not_found" }));
    // Nothing audited of EMP_A's reads names it.
    const audits = [...w.audits("person_list"), ...w.audits("layer2")].filter((body) => body.membership_id === EMP_A.membership_id);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(kept);
  });

  it("leaves another member's project activity and project records as they were, however many records an approver keeps private there", async () => {
    // The standard world: SHARED holds r4 (EMP_A's) and r3 (OWNER's). Then OWNER keeps 500 more in SHARED for himself.
    const w = await meetingWorld();
    worlds.push(w);
    for (let index = 0; index < 500; index += 1) {
      await w.approve({ name: `kept-${index}`, approval_id: `apr_kept_${index}`, projects: [SHARED], private: true, final_approver: OWNER, issued_at: T(8) });
    }
    const route = w.route();
    const projectsOf = (access_token: ReaderToken) => createRecordProjectAuthorizationV1(new SqliteProjectContextRepositoryV1(w.authority))(w.sessions.authenticateAccess({ access_token }));
    const activity = (access_token: ReaderToken) => route.projectRecordActivity({ access_token, projects: projectsOf(access_token), project_ids: [SHARED], own: new Set() }).get(SHARED);
    const arrival = (name: string) => w.record.prepare("SELECT receipt_issued_at FROM organization_record_log WHERE record_sha256 = ?").pluck().get(w.digest(name)) as string;
    const kept = Array.from({ length: 500 }, (_, index) => w.digest(`kept-${499 - index}`));
    // To EMP_A they are not filed in SHARED at all: OWNER's r3 is still the news, past none of them.
    expect(activity("emp_a")).toEqual({ meeting_at: arrival("r3"), filed: [w.digest("r4"), w.digest("r3")] });
    // OWNER finds them, newest first: his own, so no meeting time among his newest 500.
    expect(activity("owner")).toEqual({ meeting_at: null, filed: kept });
    // EMP_A's project records cost one exact read each, none for OWNER's private ones; OWNER's are his newest.
    const reads = vi.spyOn(PersonRecordReaderV1.prototype, "list");
    try {
      expect(route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 500 })).toEqual([w.digest("r4"), w.digest("r3")]);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally { reads.mockRestore(); }
    expect(route.projectRecords({ access_token: "owner", project_id: SHARED, limit: 500 })).toEqual(kept);
  });

  it("follows its approver's current grants: out of the project scope once they leave it, still theirs alone", async () => {
    const w = await world();
    const route = w.route();
    const kept = w.digest("kept");
    w.leave(SHARED, OWNER);
    // A project the reader left is the Ask denial before any read; the record is still the approver's, and names no project they hold.
    expect(failure(() => route.collectMeetings({ access_token: "owner", scope: IN_SHARED, after: null, limit: 26 }))).toEqual({ code: "unauthorized", message: "person authentication failed" });
    expect(walk(route, "owner", GLOBAL).find((row) => row.id === kept)).toMatchObject({ visibility: "approver_only", association_project_ids: [] });
    expect(walk(route, "emp_a", IN_SHARED).map((row) => row.id)).not.toContain(kept);
  });
});
