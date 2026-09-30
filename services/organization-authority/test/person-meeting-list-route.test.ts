import { performance } from "node:perf_hooks";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { clearReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonItemPositionV1, PersonStoreMeetingRowV1 } from "../src/application/ports/person-list-v1.js";
import type { PersonAskScopeV2 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import type { PersonRecordSearchRouteV1 } from "../src/composition/person-record-search-route.js";
import {
  EMP_A, EMP_B, OWNER, PROJ_X, PROJECT_NAMES, SHARED, T, UNJOINED,
  meetingWorld, type ReaderToken,
} from "./fixtures/person-meeting-world.js";
import { SIGNED_APPROVAL_SLACK_SUBJECT } from "./fixtures/signed-slack-approval-v2.js";

const GLOBAL: PersonAskScopeV2 = { kind: "global" };
const MINE: PersonAskScopeV2 = { kind: "mine" };
const inProject = (project_id: string): PersonAskScopeV2 => ({ kind: "project", project_id });
const ROW_KEYS = ["added_at", "association_project_ids", "id", "kind", "meeting_date", "title", "visibility"];

const worlds: { close(): void }[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

async function world() {
  const value = await meetingWorld();
  worlds.push(value);
  return value;
}

function failure(operation: () => unknown): { readonly code: string; readonly message: string } {
  try { operation(); } catch (error) {
    if (error instanceof AuthorityOperationError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected an Authority failure");
}

/** collect(limit) → commit(all) until a short page, as the list route drives one source. */
function walk(route: PersonRecordSearchRouteV1, token: ReaderToken, scope: PersonAskScopeV2, limit = 26, start: PersonItemPositionV1 | null = null): PersonStoreMeetingRowV1[] {
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
    const r7 = [w.digest("r7a"), w.digest("r7b")].sort();
    const empA = walk(route, "emp_a", GLOBAL);
    expect(ids(empA)).toEqual([...r7, w.digest("r4"), w.digest("r3"), w.digest("r1")]);
    expect(ids(walk(route, "owner", GLOBAL))).toEqual([...r7, w.digest("r4"), w.digest("r3"), w.digest("r2"), w.digest("r1")]);
    for (const token of ["emp_b", "emp_c"] as const) expect(ids(walk(route, token, GLOBAL))).toEqual([...r7, w.digest("r1")]);

    const byName = (name: string) => empA.find((row) => row.id === w.digest(name));
    expect(byName("r4")).toEqual({ kind: "meeting", id: w.digest("r4"), title: "Pricing review", added_at: T(4), visibility: "project", association_project_ids: [SHARED], meeting_date: "2026-09-04" });
    // The audience also names UNJOINED; only the reader's own project leaves.
    expect(byName("r3")).toEqual({ kind: "meeting", id: w.digest("r3"), title: null, added_at: T(3), visibility: "projects", association_project_ids: [SHARED] });
    expect(byName("r1")).toMatchObject({ title: "Weekly sync", visibility: "team", association_project_ids: [], meeting_date: "2026-08-31" });
    expect(walk(route, "owner", GLOBAL).find((row) => row.id === w.digest("r2"))).toMatchObject({ visibility: "approver_only", meeting_date: "2026-09-02" });

    const everything = [...empA, ...walk(route, "owner", GLOBAL), ...walk(route, "emp_b", MINE), ...walk(route, "emp_a", inProject(SHARED))];
    for (const row of everything) expect(Object.keys(row).every((key) => ROW_KEYS.includes(key))).toBe(true);
    const serialized = JSON.stringify(everything);
    for (const hidden of [UNJOINED, PROJ_X, PROJECT_NAMES[UNJOINED], PROJECT_NAMES[PROJ_X], "position", "envelope", "apr_", "audit", "prn_", "mem_", "audience", "count", SIGNED_APPROVAL_SLACK_SUBJECT, "source-apr"]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("narrows mine to the reader's own final approvals, and keeps mine and project inside global", async () => {
    const w = await world();
    const route = w.route();
    expect(ids(walk(route, "emp_b", MINE))).toEqual([w.digest("r1")]);
    // r6 is EMP_A's too, but EMP_A left its only project.
    expect(ids(walk(route, "emp_a", MINE))).toEqual([w.digest("r4")]);
    expect(ids(walk(route, "owner", MINE))).toEqual([w.digest("r3"), w.digest("r2")]);
    expect(walk(route, "emp_c", MINE)).toEqual([]);
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual([w.digest("r4"), w.digest("r3")]);
    for (const token of ["owner", "emp_a", "emp_b", "emp_c"] as const) {
      const global = new Set(ids(walk(route, token, GLOBAL)));
      for (const row of walk(route, token, MINE)) expect(global.has(row.id)).toBe(true);
      if (token === "owner" || token === "emp_a") for (const row of walk(route, token, inProject(SHARED))) expect(global.has(row.id)).toBe(true);
    }
    // A project the reader does not hold, or that does not exist, is the Ask denial before any read.
    const denied = { code: "unauthorized", message: "person authentication failed" };
    for (const projectId of [UNJOINED, "prj_dddddddd-dddd-4ddd-8ddd-dddddddddddd"]) {
      expect(failure(() => route.collectMeetings({ access_token: "emp_b", scope: inProject(projectId), after: null, limit: 26 }))).toEqual(denied);
    }
    // r3 is OWNER's only while OWNER can still read it.
    w.leave(SHARED, OWNER);
    expect(ids(walk(route, "owner", MINE))).toEqual([w.digest("r2")]);
    expect(ids(walk(route, "owner", GLOBAL))).not.toContain(w.digest("r3"));
  });

  it("pages through the same-time tie with limits 1, 2 and 26 without gaps or duplicates", async () => {
    const w = await world();
    const route = w.route();
    for (const token of ["owner", "emp_a"] as const) {
      for (const scope of [GLOBAL, MINE]) {
        const whole = ids(walk(route, token, scope, 26));
        for (const limit of [1, 2]) expect(ids(walk(route, token, scope, limit))).toEqual(whole);
      }
    }
    const [first, second] = walk(route, "emp_b", GLOBAL, 26);
    expect(first!.added_at).toBe(second!.added_at);
    expect(ids(walk(route, "emp_b", GLOBAL, 26, { added_at: first!.added_at, id: first!.id }))).toEqual([second!.id, w.digest("r1")]);
  });

  it("holds only for an approval this reader can read after the published head (N-12)", async () => {
    const w = await world();
    const route = w.route();
    const before = ids(walk(route, "emp_a", GLOBAL));
    // Another member's Only me approval and a rejection: EMP_A cannot tell they exist.
    await w.approve({ name: "r8", approval_id: "apr_r8", projects: [], final_approver: OWNER, issued_at: T(8) });
    await w.approve({ name: "r9", approval_id: "apr_r9", projects: "team", final_approver: EMP_B, issued_at: T(9), action: "reject" });
    expect(ids(walk(route, "emp_a", GLOBAL))).toEqual(before);
    expect(ids(walk(route, "emp_a", MINE))).toEqual([w.digest("r4")]);
    // A hold collects nothing, so it has nothing to audit.
    const audits = w.audits("person_list").length;
    expect(route.collectMeetings({ access_token: "owner", scope: GLOBAL, after: null, limit: 26 })).toEqual({ status: "held" });
    expect(route.collectMeetings({ access_token: "owner", scope: MINE, after: null, limit: 26 })).toEqual({ status: "held" });
    await w.approve({ name: "r10", approval_id: "apr_r10", projects: "team", final_approver: EMP_B, issued_at: T(10) });
    expect(route.collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: null, limit: 26 })).toEqual({ status: "held" });
    expect(w.audits("person_list")).toHaveLength(audits);
    w.rebuild();
    expect(ids(walk(route, "emp_a", GLOBAL))).toEqual([w.digest("r10"), ...before]);
    expect(ids(walk(route, "owner", MINE))).toEqual([w.digest("r8"), w.digest("r3"), w.digest("r2")]);
  });

  it("keeps listing the published generation through a lag after the process handle is dropped", async () => {
    const w = await world();
    const route = w.route();
    const before = ids(walk(route, "emp_a", GLOBAL));
    const mine = ids(walk(route, "emp_a", MINE));
    await w.approve({ name: "r8", approval_id: "apr_r8", projects: [], final_approver: OWNER, issued_at: T(8) });
    // A search during the lag is unavailable, but no longer drops the handle the list reads.
    expect(failure(() => route.searchBatch({ access_token: "emp_a", queries: ["Decision"] })).code).toBe("unavailable");
    expect(ids(walk(route, "emp_a", GLOBAL))).toEqual(before);
    // A superseded rebuild or a restart drops it: the list warms the published generation again.
    clearReadableSearchActiveGenerationV1();
    expect(ids(walk(route, "emp_a", GLOBAL))).toEqual(before);
    clearReadableSearchActiveGenerationV1();
    expect(ids(walk(route, "emp_a", MINE))).toEqual(mine);
    clearReadableSearchActiveGenerationV1();
    expect(ids(walk(route, "emp_a", inProject(SHARED)))).toEqual([w.digest("r4"), w.digest("r3")]);
    // A reader who can read the new record is still held, cold handle or not.
    clearReadableSearchActiveGenerationV1();
    expect(route.collectMeetings({ access_token: "owner", scope: GLOBAL, after: null, limit: 26 })).toEqual({ status: "held" });
  });

  it("completes a walk that was held mid-way once the generation is rebuilt", async () => {
    const w = await world();
    const route = w.route();
    const page = route.collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: null, limit: 2 });
    if (page.status !== "ok") throw new Error("expected a page");
    route.commitMeetings({ access_token: "emp_a", handle: page.handle, count: 2 });
    const held = { added_at: page.rows[1]!.added_at, id: page.rows[1]!.id };
    await w.approve({ name: "r0", approval_id: "apr_r0", projects: "team", final_approver: EMP_B, issued_at: "2026-08-31T10:00:00.000Z" });
    expect(route.collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: held, limit: 2 })).toEqual({ status: "held" });
    w.rebuild();
    expect(ids(walk(route, "emp_a", GLOBAL, 2, held))).toEqual([w.digest("r4"), w.digest("r3"), w.digest("r1"), w.digest("r0")]);
  });

  it("fails closed instead of listing global or a mismatched generation", async () => {
    const w = await world();
    const unavailable = { code: "unavailable", message: "an exact-head readable-search generation is not available" };
    expect(failure(() => w.route({ retrieval_contract_sha256: sha256Digest("other-contract") }).collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: null, limit: 26 }))).toEqual(unavailable);
    // Mine without the approver projectors is unavailable; it never becomes global.
    const withoutApprover = w.route({ record_approver: undefined });
    expect(failure(() => withoutApprover.collectMeetings({ access_token: "emp_a", scope: MINE, after: null, limit: 26 }))).toEqual(unavailable);
    expect(walk(withoutApprover, "emp_a", GLOBAL)).toHaveLength(5);
    const route = w.route();
    for (const input of [
      { limit: 0 }, { limit: 27 }, { limit: 1.5 },
      { after: { added_at: "2026-09-01T10:00:00Z", id: w.digest("r1") } },
      { after: { added_at: T(1), id: "sha256:ABC" } },
      { scope: { kind: "everyone" } as unknown as PersonAskScopeV2 },
    ]) expect(failure(() => route.collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: null, limit: 26, ...input })).code).toBe("invalid_request");
    // A cold process handle is not an index lag.
    clearReadableSearchActiveGenerationV1();
    expect(failure(() => route.collectMeetings({ access_token: "emp_a", scope: GLOBAL, after: null, limit: 26 }))).toEqual(unavailable);
  });

  it("audits exactly the committed prefix after its own fence, and nothing for an empty or failed commit", async () => {
    const w = await world();
    const route = w.route();
    const collect = (token: ReaderToken = "emp_a") => {
      const value = route.collectMeetings({ access_token: token, scope: GLOBAL, after: null, limit: 26 });
      if (value.status !== "ok") throw new Error("expected rows");
      return value;
    };
    const first = collect();
    expect(w.audits("person_list")).toEqual([]);
    const release = route.commitMeetings({ access_token: "emp_a", handle: first.handle, count: 2 });
    const [audit] = w.audits("person_list");
    expect(w.audits("person_list")).toHaveLength(1);
    expect(audit).toMatchObject({ read_mode: "person_list", principal_id: EMP_A.principal_id, membership_id: EMP_A.membership_id, result_count: 2 });
    expect(audit!.response_sha256).toBe(canonicalSha256({ schema_version: 1, kind: "echo-person-list-meetings-release-v1", scope: GLOBAL, rows: first.rows.slice(0, 2) }));
    expect(release.receipt).toMatch(/^sha256:/);
    route.revalidateMeetingRelease({ access_token: "emp_a", release });
    // Single use, and only on the instance that collected it.
    expect(failure(() => route.commitMeetings({ access_token: "emp_a", handle: first.handle, count: 1 })).code).toBe("unauthorized");
    expect(failure(() => w.route().commitMeetings({ access_token: "emp_a", handle: collect().handle, count: 1 })).code).toBe("unauthorized");
    expect(failure(() => route.commitMeetings({ access_token: "emp_a", handle: collect().handle, count: 6 })).code).toBe("invalid_request");

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
    const beforeRotation = collect("emp_b");
    w.session.state = "rotated session";
    expect(failure(() => route.commitMeetings({ access_token: "emp_b", handle: beforeRotation.handle, count: 1 })).code).toBe("unauthorized");
    expect(w.audits("person_list")).toHaveLength(1);
  });

  it("benchmarks page 1 over 1,024 single-atom records, cold and warm, global and mine", { timeout: 300_000 }, async () => {
    const w = await world();
    const started = performance.now();
    for (let index = 0; index < 1_017; index += 1) {
      await w.approve({ name: `b${index}`, approval_id: `apr_bench_${index}`, projects: "team", final_approver: index % 2 === 0 ? EMP_A : EMP_B, issued_at: new Date(Date.parse(T(10)) + index * 60_000).toISOString() });
    }
    w.rebuild();
    const seeded = performance.now() - started;
    const timed = (operation: () => unknown): number => { const at = performance.now(); operation(); return Math.round((performance.now() - at) * 10) / 10; };
    const page = (route: PersonRecordSearchRouteV1, scope: PersonAskScopeV2) => () => {
      const value = route.collectMeetings({ access_token: "emp_a", scope, after: null, limit: 26 });
      if (value.status !== "ok" || value.rows.length !== 26) throw new Error("expected a full page");
    };
    const globalRoute = w.route();
    const mineRoute = w.route();
    const result = {
      records: (w.record.prepare("SELECT count(*) AS n FROM organization_record_log WHERE event_kind = 'approved'").get() as { n: number }).n,
      seed_ms: Math.round(seeded),
      global_cold_ms: timed(page(globalRoute, GLOBAL)), global_warm_ms: timed(page(globalRoute, GLOBAL)),
      mine_cold_ms: timed(page(mineRoute, MINE)), mine_warm_ms: timed(page(mineRoute, MINE)),
    };
    console.info(`person meetings list benchmark ${JSON.stringify(result)}`);
    expect(result.records).toBe(1_024);
  });
});
