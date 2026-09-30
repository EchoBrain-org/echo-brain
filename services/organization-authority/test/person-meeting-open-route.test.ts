import { sha256Digest, type Sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import {
  organizationMemberReadablePersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
  type OrganizationRecordDecisionBriefV1,
} from "@echo-brain/organization-protocol";
import { ApprovedMeetingTranscriptGrantReaderV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import type { PersonMeetingPartPositionV1, PersonStoreMeetingRowV1 } from "../src/application/ports/person-list-v1.js";
import type { PersonRecordSearchRouteV1 } from "../src/composition/person-record-search-route.js";
import { releasableBodyV1 } from "../src/composition/person-item-text-v1.js";
import { validatePersonOpenResponseV1 } from "@echo-brain/organization-api";
import { COORDINATES } from "../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { EMP_A, EMP_B, OWNER, SHARED, T, UNJOINED, admittedTranscriptV1, meetingWorld, type ReaderToken } from "./fixtures/person-meeting-world.js";
import { SIGNED_APPROVAL_SLACK_SUBJECT } from "./fixtures/signed-slack-approval-v2.js";

type World = Awaited<ReturnType<typeof meetingWorld>>;
const worlds: World[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

/** A shared transcript long enough to take two pages. */
const TRANSCRIPT = Array.from({ length: 700 }, (_, index) => `word${index}`).join(" ");
const QUOTE = "QUOTE-SECRET-EVIDENCE";
/** 2 + 3,499 × 2 bytes: parts of 3,072, 3,072 and 856 bytes. */
const LONG_ACTION = `ab${"é".repeat(3_499)}`;
const CONTROLS = "Ship\fit\u0092s plan\r\n\tnow\u007f";

const withMeeting = (change: (brief: OrganizationRecordDecisionBriefV1) => Partial<OrganizationRecordDecisionBriefV1>) =>
  (brief: OrganizationRecordDecisionBriefV1): OrganizationRecordDecisionBriefV1 => ({ ...brief, ...change(brief) });
const quoted = <T extends { readonly evidence: readonly { readonly meeting_id: string; readonly block_id: string }[] }>(signal: T): T =>
  ({ ...signal, evidence: signal.evidence.map((span) => ({ ...span, quote: `${QUOTE} ${span.block_id}` })) });

/** The standard world, plus the meetings open needs. `long` exceeds the generation's atom bound, so it is appended last and never listed. */
async function world(options: { readonly long?: boolean } = {}) {
  const w = await meetingWorld({ r4_transcript: admittedTranscriptV1(TRANSCRIPT) });
  worlds.push(w);
  await w.approve({
    name: "detail", approval_id: "apr_detail", projects: "team", final_approver: OWNER, issued_at: T(11),
    signals: { decisions: 2, actions: 1, rationales: 1 },
    action_owners: [{ signal_id: "action-apr_detail-0", owner: "Jules" }],
    brief: withMeeting((brief) => ({
      meeting: {
        ...brief.meeting, title: "Pricing review",
        time: { actual_start_at: "2026-09-21T20:00:00.000Z", actual_end_at: "2026-09-21T21:00:00.000Z", timezone: "America/Los_Angeles" },
        participants: [
          { id: "participant-ari", display_name: "Ari Employee", identities: [{ kind: "email", value: "ari-identity@example.test" }], roles: ["host"], organization: { name: "Acme Org" }, metadata: { note: "META-SECRET" } },
          { id: "participant-maya", display_name: "Maya Chen" },
          { id: "participant-maya-again", display_name: "Maya Chen" },
          { id: "participant-unnamed" },
        ],
      },
      decisions: brief.decisions.map((signal, index) => quoted({ ...signal, status: index === 1 ? "proposed" as const : signal.status })),
      actions: brief.actions.map((signal) => quoted({ ...signal, due_at: "2026-09-30T00:00:00.000Z" })),
      rationales: brief.rationales.map(quoted),
    })),
  });
  await w.approve({
    name: "thirty", approval_id: "apr_thirty", projects: "team", final_approver: EMP_B, issued_at: T(12), signals: { decisions: 30 },
    brief: withMeeting((brief) => ({ meeting: { ...brief.meeting, participants: Array.from({ length: 40 }, (_, index) => ({ id: `p-${index}`, display_name: `Person ${String(index + 1).padStart(2, "0")}` })) } })),
  });
  // Twelve 3,000-byte atoms cross the 32 KiB page budget before the 25-atom cap.
  await w.approve({
    name: "budget", approval_id: "apr_budget", projects: "team", final_approver: EMP_B, issued_at: T(13), signals: { decisions: 12 },
    brief: withMeeting((brief) => ({ decisions: brief.decisions.map((signal, index) => ({ ...signal, text: `${index}`.padEnd(3_000, "x") })) })),
  });
  // A V2 brief may carry an owner the approver never confirmed; it is not released.
  await w.approve({
    name: "mallory", approval_id: "apr_mallory", projects: "team", final_approver: EMP_B, issued_at: T(14), signals: { decisions: 0, actions: 1 },
    brief: withMeeting((brief) => ({ actions: brief.actions.map((signal) => ({ ...signal, owner: "Mallory" })) })),
  });
  await w.approve({ name: "emp_a_only", approval_id: "apr_emp_a_only", projects: [], final_approver: EMP_A, issued_at: T(15) });
  await w.approve({ name: "zero", approval_id: "apr_zero", projects: [SHARED], final_approver: EMP_A, issued_at: T(16), signals: { decisions: 0 } });
  // Shared, but its revision was never admitted to this Authority's custody.
  await w.approve({ name: "unadmitted", approval_id: "apr_unadmitted", projects: "team", final_approver: EMP_B, issued_at: T(17), share_transcript: true });
  w.rebuild();
  if (options.long === true) {
    await w.approve({
      name: "long", approval_id: "apr_long", projects: "team", final_approver: EMP_A, issued_at: T(18), signals: { decisions: 0, actions: 1 },
      action_owners: [{ signal_id: "action-apr_long-0", owner: "Jules" }],
      brief: withMeeting((brief) => ({ actions: brief.actions.map((signal) => ({ ...signal, text: LONG_ACTION, due_at: "2026-10-01T00:00:00.000Z" })) })),
    });
    // A form feed and a cp1252 C1 character in approved text.
    await w.approve({
      name: "controls", approval_id: "apr_controls", projects: "team", final_approver: EMP_B, issued_at: T(20), signals: { decisions: 1 },
      brief: withMeeting((brief) => ({ decisions: brief.decisions.map((signal) => ({ ...signal, text: CONTROLS })) })),
    });
  }
  const originals = new SqlitePersonOriginalContextRetrievalV1(w.authority, w.sessions, COORDINATES.organization_id, {
    authority_id: COORDINATES.authority_id, state_lineage_id: COORDINATES.state_lineage_id,
    grants: new ApprovedMeetingTranscriptGrantReaderV1(w.record),
    is_expected_policy_contract: (grant) =>
      (grant.policy_id === "organization-member-readable-person-v2" && grant.policy_contract_sha256 === organizationMemberReadablePersonPolicyContractSha256()) ||
      (grant.policy_id === "restricted-reviewer-person-v2" && grant.policy_contract_sha256 === restrictedReviewerPersonPolicyContractSha256()) ||
      (grant.policy_id === "project-members-readable-person-v1" && grant.policy_contract_sha256 === projectMembersReadablePersonPolicyContractSha256()),
  });
  return { ...w, originals, probed: () => w.route({ transcript_probe: (input) => originals.probeApprovedMeetingTranscriptV1(input) }) };
}

function failure(operation: () => unknown): { readonly code: string; readonly message: string } {
  try { operation(); } catch (error) {
    if (error instanceof AuthorityOperationError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected an Authority failure");
}

function pages(route: PersonRecordSearchRouteV1, token: ReaderToken, record_sha256: Sha256Digest) {
  const opened: ReturnType<PersonRecordSearchRouteV1["openMeeting"]>[] = [];
  let from: PersonMeetingPartPositionV1 | undefined;
  do {
    const page = route.openMeeting({ access_token: token, record_sha256, ...(from === undefined ? {} : { from }) });
    opened.push(page);
    from = page.next ?? undefined;
  } while (from !== undefined && opened.length < 10);
  return opened;
}

const NOT_FOUND = { code: "not_found", message: "item is not available" };

/** The page as the list route shapes it, through the public open contract. */
function validated(page: ReturnType<PersonRecordSearchRouteV1["openMeeting"]>) {
  const { row } = page;
  const ref = `meeting:${row.id}` as const;
  return validatePersonOpenResponseV1({
    schema_version: 1, kind: "echo-person-open-v1", ref,
    item: { ref, kind: "meeting", title: row.title ?? "Approved meeting", added_at: row.added_at, visibility: row.visibility === "approver_only" ? "only_me" : row.visibility === "projects" ? "project" : row.visibility, projects: [], ...(row.meeting_date === undefined ? {} : { meeting_date: row.meeting_date }) },
    ...(page.meeting === undefined ? {} : { meeting: page.meeting }), atoms: page.atoms,
    next_cursor: page.next === null ? null : "next",
  });
}

describe("Person meetings open: one record by its digest (ADR-0024)", () => {
  it("releases the row, a names-only meeting, the approver's name and every atom in brief order", async () => {
    const w = await world();
    const route = w.route();
    const opened = route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("detail") });
    expect(opened.row).toEqual({ kind: "meeting", id: w.digest("detail"), title: "Pricing review", added_at: T(11), visibility: "team", association_project_ids: [], meeting_date: "2026-09-21" });
    expect(opened.meeting).toEqual({
      started_at: "2026-09-21T20:00:00.000Z", ended_at: "2026-09-21T21:00:00.000Z", timezone: "America/Los_Angeles", all_day: false,
      participants: ["Ari Employee", "Maya Chen"], participants_more: false, approved_by: "Olive Owner",
    });
    expect(opened.atoms).toEqual([
      { kind: "decision", text: "Decision 0", status: "decided" },
      { kind: "decision", text: "Decision 1", status: "proposed" },
      { kind: "action", text: "Action 0", owner: "Jules", due_at: "2026-09-30T00:00:00.000Z" },
      { kind: "rationale", text: "Rationale 0" },
    ]);
    expect(opened.next).toBeNull();
    expect(opened.transcript_shared).toBe(false);
    const serialized = JSON.stringify(opened);
    for (const hidden of [
      "participant-", "ari-identity", "host", "Acme Org", "META-SECRET", "meeting-apr", "brief-apr", "decision-apr", "action-apr", "block-",
      QUOTE, "granola", "external-approval", "decision-processor", "prn_", "mem_", "apr_", UNJOINED, "source-apr", "revision-1", SIGNED_APPROVAL_SLACK_SUBJECT,
    ]) expect(serialized).not.toContain(hidden);
    const [audit] = w.audits("person_open");
    expect(w.audits("person_open")).toHaveLength(1);
    expect(audit).toMatchObject({ read_mode: "person_open", principal_id: EMP_A.principal_id, result_count: 4 });
    route.revalidateMeetingRelease({ access_token: "emp_a", release: opened.release });
    // The approver's name is the directory's current label; absent without a directory.
    expect(w.route({ memberships: undefined }).openMeeting({ access_token: "emp_a", record_sha256: w.digest("detail") }).meeting).not.toHaveProperty("approved_by");
    // Evidence quotes never leave, from open or from the list (N-17).
    expect(JSON.stringify(pages(route, "owner", w.digest("detail")))).not.toContain(QUOTE);
    const listed = route.collectMeetings({ access_token: "owner", scope: { kind: "global" }, after: null, limit: 26 });
    expect(JSON.stringify(listed)).not.toContain(QUOTE);
  });

  it("pages 30 atoms as 25 then 5, keeps pages under the byte budget, and caps participants at 32", async () => {
    const w = await world();
    const route = w.route();
    const [first, second] = pages(route, "emp_b", w.digest("thirty"));
    expect(first!.atoms).toHaveLength(25);
    expect(first!.next).toEqual({ atom_order: 25, part: 1 });
    expect(first!.meeting).toMatchObject({ participants_more: true });
    expect(first!.meeting!.participants).toEqual(Array.from({ length: 32 }, (_, index) => `Person ${String(index + 1).padStart(2, "0")}`));
    expect(second!.atoms).toHaveLength(5);
    expect(second!.next).toBeNull();
    expect(second).not.toHaveProperty("meeting");
    expect(second).not.toHaveProperty("transcript_shared");
    expect([first!, second!].flatMap((page) => page.atoms.map((atom) => atom.text))).toEqual(Array.from({ length: 30 }, (_, index) => `Decision ${index}`));
    const budget = pages(route, "emp_b", w.digest("budget"));
    expect(budget.map((page) => page.atoms.length)).toEqual([10, 2]);
    expect(budget[0]!.next).toEqual({ atom_order: 10, part: 1 });
    for (const page of budget) expect(Buffer.byteLength(JSON.stringify(page.atoms))).toBeLessThanOrEqual(32 * 1024);
    // A zero-signal record opens with its meeting and no atoms; it has no second page.
    const zero = route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("zero") });
    expect(zero).toMatchObject({ atoms: [], next: null, meeting: { participants: [] }, row: { visibility: "project", association_project_ids: [SHARED] } });
    expect(failure(() => route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("zero"), from: { atom_order: 0, part: 1 } }))).toEqual(NOT_FOUND);
  });

  it("splits an atom over 3,072 bytes into parts that join exactly, with owners only from the signed act", async () => {
    const w = await world({ long: true });
    const route = w.route();
    const [page] = pages(route, "emp_b", w.digest("long"));
    expect(page!.atoms.map((atom) => Buffer.byteLength(atom.text))).toEqual([3_072, 3_072, 856]);
    expect(page!.atoms.map((atom) => atom.text).join("")).toBe(LONG_ACTION);
    expect(page!.atoms[0]).toMatchObject({ kind: "action", owner: "Jules", due_at: "2026-10-01T00:00:00.000Z", part: { index: 1, count: 3 } });
    expect(page!.atoms.slice(1)).toEqual([
      { kind: "action", text: page!.atoms[1]!.text, part: { index: 2, count: 3 } },
      { kind: "action", text: page!.atoms[2]!.text, part: { index: 3, count: 3 } },
    ]);
    const rest = route.openMeeting({ access_token: "emp_b", record_sha256: w.digest("long"), from: { atom_order: 0, part: 2 } });
    expect(rest.atoms.map((atom) => atom.part)).toEqual([{ index: 2, count: 3 }, { index: 3, count: 3 }]);
    const mallory = route.openMeeting({ access_token: "emp_b", record_sha256: w.digest("mallory") });
    expect(mallory.atoms).toEqual([{ kind: "action", text: "Action 0" }]);
    expect(JSON.stringify(mallory)).not.toContain("Mallory");
  });

  it("replaces the characters the open contract refuses in approved text, so the meeting still opens", async () => {
    const w = await world({ long: true });
    const [opened] = pages(w.route(), "emp_b", w.digest("controls"));
    expect(opened!.atoms).toEqual([{ kind: "decision", text: "Ship it s plan\r\n\tnow ", status: "decided" }]);
    expect(validated(opened!).kind).toBe("echo-person-open-v1");
    expect(releasableBodyV1("a\uD800b\uDC00c😀")).toBe("a�b�c😀");
  });

  it("gives one not_found, and writes no audit, for every record or position it cannot release", async () => {
    const w = await world();
    const route = w.route();
    const misses = {
      emp_a: [sha256Digest("guessed-record"), w.digest("r5"), w.digest("r2"), w.digest("r6")],
      owner: [sha256Digest("guessed-record"), w.digest("r5"), w.digest("emp_a_only"), w.digest("r6")],
    } as const;
    for (const [token, records] of Object.entries(misses) as [ReaderToken, readonly Sha256Digest[]][]) {
      for (const record_sha256 of records) {
        expect(failure(() => route.openMeeting({ access_token: token, record_sha256 }))).toEqual(NOT_FOUND);
        expect(failure(() => route.openMeeting({ access_token: token, record_sha256, from: { atom_order: 0, part: 1 } }))).toEqual(NOT_FOUND);
        expect(failure(() => route.admitMeeting({ access_token: token, record_sha256 }))).toEqual(NOT_FOUND);
      }
      // A position beyond a readable record is the same miss.
      for (const from of [{ atom_order: 1, part: 1 }, { atom_order: 0, part: 2 }]) {
        expect(failure(() => route.openMeeting({ access_token: token, record_sha256: w.digest("r1"), from }))).toEqual(NOT_FOUND);
      }
      expect(failure(() => route.openMeeting({ access_token: token, record_sha256: "sha256:ABC" as Sha256Digest }))).toEqual(NOT_FOUND);
      expect(failure(() => route.openMeeting({ access_token: token, record_sha256: w.digest("r1"), from: { atom_order: 0, part: 0 } })).code).toBe("invalid_request");
    }
    expect(w.audits("person_open")).toEqual([]);
    // After leaving SHARED, EMP_A's own r4 is unreadable, and so unopenable.
    route.admitMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") });
    w.leave(SHARED, EMP_A);
    expect(failure(() => route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") }))).toEqual(NOT_FOUND);
    expect(failure(() => route.admitMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") }))).toEqual(NOT_FOUND);
  });

  it("offers a transcript only when the probe passes, and reads it by record only while the reader may", async () => {
    const w = await world();
    const route = w.probed();
    for (const token of ["emp_a", "owner"] as const) expect(route.openMeeting({ access_token: token, record_sha256: w.digest("r4") }).transcript_shared).toBe(true);
    expect(route.openMeeting({ access_token: "emp_b", record_sha256: w.digest("r1") }).transcript_shared).toBe(false);
    expect(route.openMeeting({ access_token: "emp_b", record_sha256: w.digest("unadmitted") }).transcript_shared).toBe(false);
    expect(w.route({ transcript_probe: () => false }).openMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") }).transcript_shared).toBe(false);
    expect(w.route().openMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") }).transcript_shared).toBe(false);

    const first = w.originals.readApprovedMeetingTranscriptByRecordV1({ access_token: "emp_a", record_sha256: w.digest("r4") });
    expect(first.next_offset).not.toBeNull();
    const second = w.originals.readApprovedMeetingTranscriptByRecordV1({ access_token: "emp_a", record_sha256: w.digest("r4"), offset: first.next_offset! });
    expect(second.next_offset).toBeNull();
    expect(first.text + second.text).toBe(TRANSCRIPT);
    expect(Object.keys(first).sort()).toEqual(["next_offset", "text"]);
    const denied = { code: "unauthorized", message: "person authentication failed" };
    for (const record of [w.digest("r1"), sha256Digest("guessed-record")]) {
      expect(failure(() => w.originals.readApprovedMeetingTranscriptByRecordV1({ access_token: "emp_a", record_sha256: record }))).toEqual(denied);
    }
    w.leave(SHARED, EMP_A);
    expect(failure(() => w.originals.readApprovedMeetingTranscriptByRecordV1({ access_token: "emp_a", record_sha256: w.digest("r4") }))).toEqual(denied);
    expect(w.originals.probeApprovedMeetingTranscriptV1({ actor: w.sessions.authenticateAccess({ access_token: "emp_a" }), approval_id: "apr_r4", record_sha256: w.digest("r4") })).toBe(false);
    expect(w.originals.probeApprovedMeetingTranscriptV1({ actor: w.sessions.authenticateAccess({ access_token: "owner" }), approval_id: "apr_r4", record_sha256: w.digest("r1") })).toBe(false);
  });

  it("opens every listed row with the identical row", async () => {
    const w = await world();
    const route = w.route();
    for (const token of ["owner", "emp_a", "emp_b"] as const) {
      const listed = route.collectMeetings({ access_token: token, scope: { kind: "global" }, after: null, limit: 26 });
      if (listed.status !== "ok") throw new Error("expected rows");
      expect(listed.rows.length).toBeGreaterThan(5);
      for (const row of listed.rows) {
        const opened: PersonStoreMeetingRowV1 = route.openMeeting({ access_token: token, record_sha256: row.id }).row;
        expect(opened).toEqual(row);
      }
    }
  });

  it("releases nothing when the session or the reader's grants change during an open", async () => {
    const w = await world();
    const audits = () => w.audits("person_open").length;
    const rotating = w.route({ transcript_probe: () => { w.session.state = "rotated during open"; return true; } });
    expect(failure(() => rotating.openMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") })).code).toBe("unauthorized");
    w.session.state = "meeting session";
    const leaving = w.route({ transcript_probe: () => { w.leave(SHARED, OWNER); return true; } });
    expect(failure(() => leaving.openMeeting({ access_token: "owner", record_sha256: w.digest("r1") })).code).toBe("unauthorized");
    expect(audits()).toBe(0);
    const route = w.route();
    const opened = route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("r1") });
    w.leave(SHARED, EMP_A);
    expect(failure(() => route.revalidateMeetingRelease({ access_token: "emp_a", release: opened.release })).code).toBe("unauthorized");
    expect(failure(() => w.route().revalidateMeetingRelease({ access_token: "emp_a", release: opened.release })).code).toBe("unauthorized");
  });
});
