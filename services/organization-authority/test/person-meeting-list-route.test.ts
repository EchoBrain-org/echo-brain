import { performance } from "node:perf_hooks";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { clearReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonItemPositionV1, PersonListStoreScopeV1, PersonStoreMeetingRowV1 } from "../src/application/ports/person-list-v1.js";
import type { PersonRecordSearchRouteV1 } from "../src/composition/person-record-search-route.js";
import {
  EMP_A, EMP_B, EVERYONE, OWNER, PROJ_X, PROJECT_NAMES, SHARED, T, UNJOINED,
  meetingWorld, type ReaderToken,
} from "./fixtures/person-meeting-world.js";
import { failure } from "./authority-failure.js";
import { SIGNED_APPROVAL_PRIVATE_MARKER } from "./fixtures/signed-approval-decision-v1.js";

const ONLY_ME: PersonListStoreScopeV1 = { kind: "only_me" };
const inProject = (project_id: string): PersonListStoreScopeV1 => ({ kind: "project", project_id });
const ROW_KEYS = ["added_at", "association_project_ids", "id", "kind", "meeting_date", "title", "visibility"];

const worlds: { close(): void }[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

async function world(options: Parameters<typeof meetingWorld>[0] = {}) {
  const value = await meetingWorld(options);
  worlds.push(value);
  return value;
}

/** collect(limit) → commit(all) until a short page, as the list route drives one source. */
function walk(route: PersonRecordSearchRouteV1, token: ReaderToken, scope: PersonListStoreScopeV1, limit = 26, start: PersonItemPositionV1 | null = null): PersonStoreMeetingRowV1[] {
  const rows: PersonStoreMeetingRowV1[] = [];
  let after = start;
  for (let page = 0; page < 50; page += 1) {
    const collected = route.collectMeetings({ access_token: token, scope, after, limit });
    if (collected.status !== "ok") throw new Error("meetings were held");
    route.commitMeetings({ access_token: token, handle: collected.handle, count: collected.rows.length });
    rows.push(...collected.rows);
    if (collected.rows.length < limit) return rows;
    const last = collected.rows.at(-1)!;
    after = { added_at: last.added_at, id: last.id };
  }
  throw new Error("walk did not end");
}

const ids = (rows: readonly PersonStoreMeetingRowV1[]) => rows.map((row) => row.id);

describe("Person meetings list: collect and commit (ADR-0024)", () => {
  it("lists each reader's readable approved meetings newest first, as content-free rows", async () => {
    const w = await world();
    const route = w.route();
    const empA = walk(route, "emp_a", inProject(SHARED));
    expect(ids(empA)).toEqual([w.digest("r4"), w.digest("r3")]);
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual([w.digest("r4"), w.digest("r3")]);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    for (const token of ["emp_a", "emp_b", "emp_c"] as const) expect(walk(route, token, ONLY_ME)).toEqual([]);
    // EVERYONE, which every reader holds, lists the meetings shared with everyone.
    const r7 = [w.digest("r7a"), w.digest("r7b")].sort();
    for (const token of ["owner", "emp_a", "emp_b", "emp_c"] as const) expect(ids(walk(route, token, inProject(EVERYONE)))).toEqual([...r7, w.digest("r1")]);
    const everyone = walk(route, "emp_a", inProject(EVERYONE));

    const byName = (name: string) => empA.find((row) => row.id === w.digest(name));
    expect(byName("r4")).toEqual({ kind: "meeting", id: w.digest("r4"), title: "Pricing review", added_at: T(4), visibility: "project", association_project_ids: [SHARED], meeting_date: "2026-09-04" });
    // The audience also names UNJOINED; only the reader's own project leaves.
    expect(byName("r3")).toEqual({ kind: "meeting", id: w.digest("r3"), title: null, added_at: T(3), visibility: "projects", association_project_ids: [SHARED] });
    // r1, shared with EVERYONE, opens with the row EVERYONE lists: its date is the meeting's own day.
    const r1 = everyone.find((row) => row.id === w.digest("r1"));
    expect(r1).toMatchObject({ title: "Weekly sync", visibility: "project", association_project_ids: [EVERYONE], meeting_date: "2026-08-31" });
    expect(route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("r1") }).row).toEqual(r1);
    expect(walk(route, "owner", ONLY_ME).find((row) => row.id === w.digest("r2"))).toMatchObject({ visibility: "approver_only", meeting_date: "2026-09-02" });

    const everything = [...empA, ...everyone, ...walk(route, "owner", inProject(SHARED)), ...walk(route, "owner", ONLY_ME)];
    for (const row of everything) expect(Object.keys(row).every((key) => ROW_KEYS.includes(key))).toBe(true);
    const serialized = JSON.stringify(everything);
    for (const hidden of [UNJOINED, PROJ_X, PROJECT_NAMES[UNJOINED], PROJECT_NAMES[PROJ_X], "position", "envelope", "apr_", "audit", "prn_", "mem_", "audience", "count", SIGNED_APPROVAL_PRIVATE_MARKER, "source-apr"]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("lists a project only to its members, each row as its open reads it, and nothing of a left project", async () => {
    const w = await world();
    const route = w.route();
    for (const token of ["owner", "emp_a"] as const) {
      const rows = walk(route, token, inProject(SHARED));
      expect(ids(rows)).toEqual([w.digest("r4"), w.digest("r3")]);
      for (const row of rows) expect(route.openMeeting({ access_token: token, record_sha256: row.id }).row).toEqual(row);
    }
    // A project the reader does not hold, or that does not exist, is the Ask denial before any read.
    const denied = { code: "unauthorized", message: "person authentication failed" };
    for (const projectId of [UNJOINED, "prj_dddddddd-dddd-4ddd-8ddd-dddddddddddd"]) {
      expect(failure(() => route.collectMeetings({ access_token: "emp_b", scope: inProject(projectId), after: null, limit: 26 }))).toEqual(denied);
    }
    // r6 is EMP_A's, but EMP_A left its only project.
    expect(failure(() => route.collectMeetings({ access_token: "emp_a", scope: inProject(PROJ_X), after: null, limit: 26 }))).toEqual(denied);
    // r3 is listed to OWNER only while OWNER can still read it.
    w.leave(SHARED, OWNER);
    expect(failure(() => route.collectMeetings({ access_token: "owner", scope: inProject(SHARED), after: null, limit: 26 }))).toEqual(denied);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(failure(() => route.openMeeting({ access_token: "owner", record_sha256: w.digest("r3") })).code).toBe("not_found");
  });

  it("narrows only_me to the records kept for the reader alone, and holds it only for such a record (ADR-0049)", async () => {
    const w = await world({ extra: [{ name: "b_only", approval_id: "apr_b_only", projects: [], final_approver: EMP_B, issued_at: T(9) }] });
    const route = w.route();
    // r3 is the owner's approval filed for SHARED, r1 everyone's, and r4 EMP_A's own for SHARED: none is kept for one reader.
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(ids(walk(route, "emp_b", ONLY_ME))).toEqual([w.digest("b_only")]);
    expect(walk(route, "emp_a", ONLY_ME)).toEqual([]);
    expect(walk(route, "emp_c", ONLY_ME)).toEqual([]);
    for (const token of ["owner", "emp_a", "emp_b", "emp_c"] as const) {
      for (const row of walk(route, token, ONLY_ME)) {
        expect(row.visibility).toBe("approver_only");
        expect(route.openMeeting({ access_token: token, record_sha256: row.id }).row).toEqual(row);
      }
    }
    // The policy alone decides it, so it needs no approver projectors.
    expect(ids(walk(w.route({ record_approver: undefined }), "owner", ONLY_ME))).toEqual([w.digest("r2")]);

    // An approval shared with everyone holds EVERYONE for every reader, but no other project and nobody's only_me.
    await w.approve({ name: "r10", approval_id: "apr_r10", projects: [EVERYONE], final_approver: EMP_B, issued_at: T(10) });
    expect(route.collectMeetings({ access_token: "owner", scope: inProject(EVERYONE), after: null, limit: 26 })).toEqual({ status: "held" });
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual([w.digest("r4"), w.digest("r3")]);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    // Another member's Only me approval holds that member's only_me, never the owner's.
    await w.approve({ name: "r11", approval_id: "apr_r11", projects: [], final_approver: EMP_A, issued_at: T(11) });
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(route.collectMeetings({ access_token: "emp_a", scope: ONLY_ME, after: null, limit: 26 })).toEqual({ status: "held" });
    // The owner's own approval for a project holds that project, not only_me.
    await w.approve({ name: "r12", approval_id: "apr_r12", projects: [SHARED], final_approver: OWNER, issued_at: T(12) });
    expect(route.collectMeetings({ access_token: "owner", scope: inProject(SHARED), after: null, limit: 26 })).toEqual({ status: "held" });
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    w.rebuild();
    expect(ids(walk(route, "emp_a", ONLY_ME))).toEqual([w.digest("r11")]);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual([w.digest("r12"), w.digest("r4"), w.digest("r3")]);
  });

  it("pages through the same-time tie with limits 1, 2 and 26 without gaps or duplicates", async () => {
    // Two SHARED approvals and two of the owner's Only me approvals, each pair at one instant.
    const w = await world({ extra: [
      { name: "s7a", approval_id: "apr_s7a", projects: [SHARED], final_approver: EMP_A, issued_at: T(7) },
      { name: "s7b", approval_id: "apr_s7b", projects: [SHARED], final_approver: EMP_A, issued_at: T(7) },
      { name: "o7a", approval_id: "apr_o7a", projects: [], final_approver: OWNER, issued_at: T(7) },
      { name: "o7b", approval_id: "apr_o7b", projects: [], final_approver: OWNER, issued_at: T(7) },
    ] });
    const route = w.route();
    for (const token of ["owner", "emp_a"] as const) {
      for (const scope of [inProject(SHARED), ONLY_ME]) {
        const whole = ids(walk(route, token, scope, 26));
        for (const limit of [1, 2]) expect(ids(walk(route, token, scope, limit))).toEqual(whole);
      }
    }
    const [first, second] = walk(route, "emp_a", inProject(SHARED), 26);
    expect(first!.added_at).toBe(second!.added_at);
    expect(ids(walk(route, "emp_a", inProject(SHARED), 26, { added_at: first!.added_at, id: first!.id }))).toEqual([second!.id, w.digest("r4"), w.digest("r3")]);
    const [own, other] = walk(route, "owner", ONLY_ME, 26);
    expect(own!.added_at).toBe(other!.added_at);
    expect(ids(walk(route, "owner", ONLY_ME, 26, { added_at: own!.added_at, id: own!.id }))).toEqual([other!.id, w.digest("r2")]);
  });

  it("holds only for an approval this reader can read in this scope after the published head (N-12)", async () => {
    const w = await world();
    const route = w.route();
    const before = ids(walk(route, "emp_a", inProject(SHARED)));
    // Another member's Only me approval: EMP_A cannot tell it exists.
    await w.approve({ name: "r8", approval_id: "apr_r8", projects: [], final_approver: OWNER, issued_at: T(8) });
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual(before);
    expect(walk(route, "emp_a", ONLY_ME)).toEqual([]);
    // The owner's Only me approval holds the owner's only_me, never the owner's projects.
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual(before);
    // A hold collects nothing, so it has nothing to audit.
    const audits = w.audits("person_list").length;
    expect(route.collectMeetings({ access_token: "owner", scope: ONLY_ME, after: null, limit: 26 })).toEqual({ status: "held" });
    await w.approve({ name: "r10", approval_id: "apr_r10", projects: [SHARED], final_approver: OWNER, issued_at: T(10) });
    expect(route.collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: null, limit: 26 })).toEqual({ status: "held" });
    expect(w.audits("person_list")).toHaveLength(audits);
    w.rebuild();
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual([w.digest("r10"), ...before]);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r8"), w.digest("r2")]);
  });

  it("faces the owner with another member's Only me approval: never listed, held or opened", async () => {
    const w = await world();
    const route = w.route();
    // EMP_A's Only me approval: the owner can neither read it nor tell it is waiting.
    const ownerShared = ids(walk(route, "owner", inProject(SHARED)));
    await w.approve({ name: "r11", approval_id: "apr_r11", projects: [], final_approver: EMP_A, issued_at: T(11) });
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual(ownerShared);
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(route.collectMeetings({ access_token: "emp_a", scope: ONLY_ME, after: null, limit: 26 })).toEqual({ status: "held" });
    w.rebuild();
    expect(ids(walk(route, "owner", ONLY_ME))).toEqual([w.digest("r2")]);
    expect(failure(() => route.openMeeting({ access_token: "owner", record_sha256: w.digest("r11") })).code).toBe("not_found");
    expect(ids(walk(route, "emp_a", ONLY_ME))).toEqual([w.digest("r11")]);
  });

  it("keeps listing the published generation through a lag after the process handle is dropped", async () => {
    const w = await world();
    const route = w.route();
    const before = ids(walk(route, "emp_a", inProject(SHARED)));
    await w.approve({ name: "r8", approval_id: "apr_r8", projects: [], final_approver: OWNER, issued_at: T(8) });
    // A search during the lag is unavailable, but no longer drops the handle the list reads.
    expect(failure(() => route.searchBatch({ access_token: "emp_a", query: "Decision" })).code).toBe("unavailable");
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual(before);
    // A superseded rebuild or a restart drops it: the list warms the published generation again.
    clearReadableSearchActiveGenerationV1();
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual(before);
    clearReadableSearchActiveGenerationV1();
    expect(walk(route, "emp_a", ONLY_ME)).toEqual([]);
    clearReadableSearchActiveGenerationV1();
    expect(ids(walk(route, "owner", inProject(SHARED)))).toEqual([w.digest("r4"), w.digest("r3")]);
    // A reader who can read the new record in this scope is still held, cold handle or not.
    clearReadableSearchActiveGenerationV1();
    expect(route.collectMeetings({ access_token: "owner", scope: ONLY_ME, after: null, limit: 26 })).toEqual({ status: "held" });
  });

  it("completes a walk that was held mid-way once the generation is rebuilt", async () => {
    const w = await world();
    const route = w.route();
    const page = route.collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: null, limit: 1 });
    if (page.status !== "ok") throw new Error("expected a page");
    route.commitMeetings({ access_token: "emp_a", handle: page.handle, count: 1 });
    const held = { added_at: page.rows[0]!.added_at, id: page.rows[0]!.id };
    await w.approve({ name: "r0", approval_id: "apr_r0", projects: [SHARED], final_approver: OWNER, issued_at: "2026-08-31T10:00:00.000Z" });
    expect(route.collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: held, limit: 1 })).toEqual({ status: "held" });
    w.rebuild();
    expect(ids(walk(route, "emp_a", inProject(SHARED), 1, held))).toEqual([w.digest("r3"), w.digest("r0")]);
  });

  it("fails closed instead of listing global or a mismatched generation", async () => {
    const w = await world();
    const unavailable = { code: "unavailable", message: "an exact-head readable-search generation is not available" };
    expect(failure(() => w.route({ retrieval_contract_sha256: sha256Digest("other-contract") }).collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: null, limit: 26 }))).toEqual(unavailable);
    // The list needs no approver projectors: only an open names the approver.
    expect(walk(w.route({ record_approver: undefined }), "emp_a", inProject(SHARED))).toHaveLength(2);
    const route = w.route();
    for (const input of [
      { limit: 0 }, { limit: 27 }, { limit: 1.5 },
      { after: { added_at: "2026-09-01T10:00:00Z", id: w.digest("r1") } },
      { after: { added_at: T(1), id: "sha256:ABC" } },
      { scope: { kind: "everyone" } as unknown as PersonListStoreScopeV1 },
      // The retired global and mine scopes are no list scope.
      { scope: { kind: "global" } as unknown as PersonListStoreScopeV1 },
      { scope: { kind: "mine" } as unknown as PersonListStoreScopeV1 },
    ]) expect(failure(() => route.collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: null, limit: 26, ...input })).code).toBe("invalid_request");
    // A cold process handle is not an index lag.
    clearReadableSearchActiveGenerationV1();
    expect(failure(() => route.collectMeetings({ access_token: "emp_a", scope: inProject(SHARED), after: null, limit: 26 }))).toEqual(unavailable);
  });

  it("audits exactly the committed prefix after its own fence, and nothing for an empty or failed commit", async () => {
    const w = await world();
    const route = w.route();
    const collect = (token: ReaderToken = "emp_a", scope: PersonListStoreScopeV1 = inProject(SHARED)) => {
      const value = route.collectMeetings({ access_token: token, scope, after: null, limit: 26 });
      if (value.status !== "ok") throw new Error("expected rows");
      return value;
    };
    const first = collect();
    expect(w.audits("person_list")).toEqual([]);
    const release = route.commitMeetings({ access_token: "emp_a", handle: first.handle, count: 2 });
    const [audit] = w.audits("person_list");
    expect(w.audits("person_list")).toHaveLength(1);
    expect(audit).toMatchObject({ read_mode: "person_list", principal_id: EMP_A.principal_id, membership_id: EMP_A.membership_id, result_count: 2 });
    expect(audit!.response_sha256).toBe(canonicalSha256({ schema_version: 1, kind: "echo-person-list-meetings-release-v1", scope: inProject(SHARED), rows: first.rows.slice(0, 2) }));
    expect(release.receipt).toMatch(/^sha256:/);
    route.revalidateMeetingRelease({ access_token: "emp_a", release });
    // Single use, and only on the instance that collected it.
    expect(failure(() => route.commitMeetings({ access_token: "emp_a", handle: first.handle, count: 1 })).code).toBe("unauthorized");
    expect(failure(() => w.route().commitMeetings({ access_token: "emp_a", handle: collect().handle, count: 1 })).code).toBe("unauthorized");
    expect(failure(() => route.commitMeetings({ access_token: "emp_a", handle: collect().handle, count: 3 })).code).toBe("invalid_request");

    const empty = route.commitMeetings({ access_token: "emp_a", handle: collect().handle, count: 0 });
    expect(empty).toEqual({});
    route.revalidateMeetingRelease({ access_token: "emp_a", release: empty });
    expect(w.audits("person_list")).toHaveLength(1);

    // EMP_A leaves SHARED between collect and commit: nothing is released or audited.
    const beforeLeave = collect();
    w.leave(SHARED, EMP_A);
    expect(failure(() => route.commitMeetings({ access_token: "emp_a", handle: beforeLeave.handle, count: 1 })).code).toBe("unauthorized");
    expect(failure(() => route.revalidateMeetingRelease({ access_token: "emp_a", release })).code).toBe("unauthorized");
    // A session change between collect and commit is the same denial.
    const beforeRotation = collect("owner", ONLY_ME);
    w.session.state = "rotated session";
    expect(failure(() => route.commitMeetings({ access_token: "owner", handle: beforeRotation.handle, count: 1 })).code).toBe("unauthorized");
    expect(w.audits("person_list")).toHaveLength(1);
  });

  // ADR-0024's cost measurement for its 50 ms warm / 3 s cold revisit thresholds, here for a project and only me. Opt-in, as
  // seeding takes about a minute:
  // ECHO_RUN_BENCHMARKS=1 npx vitest run --config vitest.config.ts services/organization-authority/test/person-meeting-list-route.test.ts
  it.runIf(process.env.ECHO_RUN_BENCHMARKS === "1")("benchmarks page 1 over 1,024 single-atom records, cold and warm, a project and only me", { timeout: 300_000 }, async () => {
    const w = await world();
    const started = performance.now();
    for (let index = 0; index < 1_017; index += 1) {
      const at = new Date(Date.parse(T(10)) + index * 60_000).toISOString();
      // Even: EMP_A's approval decisions, alternately Only me and SHARED. Odd: EMP_B's, shared with EVERYONE, in neither list.
      await w.approve(index % 2 === 0
        ? { name: `b${index}`, approval_id: `apr_bench_${index}`, projects: index % 4 === 0 ? [] : [SHARED], final_approver: EMP_A, issued_at: at }
        : { name: `b${index}`, approval_id: `apr_bench_${index}`, projects: [EVERYONE], final_approver: EMP_B, issued_at: at });
    }
    w.rebuild();
    const seeded = performance.now() - started;
    const timed = (operation: () => unknown): number => { const at = performance.now(); operation(); return Math.round((performance.now() - at) * 10) / 10; };
    const page = (route: PersonRecordSearchRouteV1, scope: PersonListStoreScopeV1) => () => {
      const value = route.collectMeetings({ access_token: "emp_a", scope, after: null, limit: 26 });
      if (value.status !== "ok" || value.rows.length !== 26) throw new Error("expected a full page");
    };
    const projectRoute = w.route();
    const onlyMeRoute = w.route();
    const result = {
      records: (w.record.prepare("SELECT count(*) AS n FROM organization_record_log WHERE event_kind = 'approved'").get() as { n: number }).n,
      seed_ms: Math.round(seeded),
      project_cold_ms: timed(page(projectRoute, inProject(SHARED))), project_warm_ms: timed(page(projectRoute, inProject(SHARED))),
      only_me_cold_ms: timed(page(onlyMeRoute, ONLY_ME)), only_me_warm_ms: timed(page(onlyMeRoute, ONLY_ME)),
    };
    console.info(`person meetings list benchmark ${JSON.stringify(result)}`);
    expect(result.records).toBe(1_024);
  });
});
