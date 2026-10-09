import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  OrganizationPersonToolV4,
  PersonListRequestV1,
  PersonListResponseV1,
  PersonOpenDocumentV1,
  PersonOpenMeetingAtomV1,
  PersonOpenMeetingV1,
  PersonOpenRefV1,
  PersonOpenResponseV1,
  PersonOpenTranscriptV1,
} from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { describe, expect, it } from "vitest";
import type {
  PersonItemPositionV1,
  PersonListDirectoryPortV1,
  PersonListJoinedProjectV1,
  PersonMeetingItemsPortV1,
  PersonOriginalItemsPortV1,
  PersonStoreDocumentRowV1,
  PersonStoreMeetingRowV1,
  PersonStoreNoteRowV1,
  PersonTranscriptByRecordPortV1,
} from "../src/application/ports/person-list-v1.js";
import type { PersonAskScopeV2 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { decodePersonListCursorV1, decodePersonOpenCursorV1, type PersonListPositionsV1 } from "../src/composition/person-list-cursor-v1.js";
import { createPersonListRouteV1 } from "../src/composition/person-list-v1-route.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, authorization } from "./fixtures/project-context-sqlite.js";

type Row = PersonStoreNoteRowV1 | PersonStoreDocumentRowV1 | PersonStoreMeetingRowV1;

const UNJOINED = "prj_99999999-9999-4999-8999-999999999999";
const NONEXISTENT = "prj_88888888-8888-4888-8888-888888888888";
const MEETING_ATOMS_PER_PAGE = 2;
const CHUNKS_PER_PAGE = 3;
const TRANSCRIPT_PAGE = 7;
const hex = (value: number): string => value.toString(16).padStart(64, "0");
const T = (minute: number): string => new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString();
const note = (n: number, added_at: string, extra: Partial<PersonStoreNoteRowV1> = {}): PersonStoreNoteRowV1 =>
  ({ kind: "note", id: `ctx_${hex(n)}`, title: `Note ${n}`, added_at, visibility: "team", association_project_ids: [], ...extra });
const document = (n: number, added_at: string, extra: Partial<PersonStoreDocumentRowV1> = {}): PersonStoreDocumentRowV1 =>
  ({ kind: "document", id: `doc_${hex(n)}`, title: `Doc ${n}`, added_at, visibility: "team", association_project_ids: [], media_type: "application/pdf", extraction_state: "ready", size_bytes: 1024, ...extra });
const meeting = (n: number, added_at: string, extra: Partial<PersonStoreMeetingRowV1> = {}): PersonStoreMeetingRowV1 =>
  ({ kind: "meeting", id: `sha256:${hex(n)}`, title: `Meeting ${n}`, added_at, visibility: "team", association_project_ids: [], ...extra });
const ref = (row: Row): string => `${row.kind}:${row.id}`;

/** added_at DESC, then ref ASC. */
function order(left: Row, right: Row): number {
  if (left.added_at !== right.added_at) return left.added_at > right.added_at ? -1 : 1;
  return ref(left) < ref(right) ? -1 : ref(left) > ref(right) ? 1 : 0;
}
function inScope(row: Row, scope: PersonAskScopeV2, mine: ReadonlySet<string>): boolean {
  return scope.kind === "global" || (scope.kind === "mine" ? mine.has(row.id) : row.association_project_ids.includes(scope.project_id as never));
}
function afterPosition(row: Row, after: PersonItemPositionV1 | null): boolean {
  return after === null || row.added_at < after.added_at || (row.added_at === after.added_at && row.id > after.id);
}

function failure(error: unknown): { readonly code: string; readonly message: string } {
  if (!(error instanceof AuthorityOperationError)) throw error;
  return { code: error.code, message: error.message };
}
async function rejected(promise: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> {
  try { await promise; } catch (error) { return failure(error); }
  throw new Error("expected an Authority failure");
}

interface Options {
  readonly notes?: readonly PersonStoreNoteRowV1[];
  readonly documents?: readonly PersonStoreDocumentRowV1[];
  readonly meetings?: readonly PersonStoreMeetingRowV1[];
  readonly mine?: readonly string[];
  readonly projects?: readonly PersonListJoinedProjectV1[];
}

function fixture(options: Options = {}) {
  const world = {
    notes: [...(options.notes ?? [])], documents: [...(options.documents ?? [])], meetings: [...(options.meetings ?? [])],
    mine: new Set(options.mine ?? []),
    projects: [...(options.projects ?? [
      { project_id: PROJECT_ALPHA, name: "Alpha", role: "lead", status: "active" },
      { project_id: PROJECT_BETA, name: "Beta", role: "member", status: "archived" },
    ] as PersonListJoinedProjectV1[])],
    grants: 1,
    held: false,
    session: "session",
  };
  const calls: { readonly method: string; readonly input: Readonly<Record<string, unknown>> }[] = [];
  const audits: Parameters<PersonListDirectoryPortV1["audit"]>[0][] = [];
  const hooks: {
    collect?: (rows: { notes: readonly PersonStoreNoteRowV1[]; documents: readonly PersonStoreDocumentRowV1[] }) => { notes: readonly PersonStoreNoteRowV1[]; documents: readonly PersonStoreDocumentRowV1[] };
    meetings?: (rows: readonly PersonStoreMeetingRowV1[]) => readonly PersonStoreMeetingRowV1[];
    commit?: () => void;
    revalidate?: () => void;
    open?: () => void;
    tools?: () => void;
  } = {};
  const record = (method: string, input: object) => calls.push({ method, input: { ...input } as Readonly<Record<string, unknown>> });
  const page = <T extends Row>(rows: readonly T[], scope: PersonAskScopeV2, after: PersonItemPositionV1 | null, limit: number): T[] =>
    [...rows].filter((row) => inScope(row, scope, world.mine)).sort(order).filter((row) => afterPosition(row, after)).slice(0, limit);
  const receipt = (value: unknown): Sha256Digest => canonicalSha256({ receipt: value as never });

  const originals: PersonOriginalItemsPortV1 = {
    collect(input) {
      record("collect", { scope: input.scope, limit: input.limit, notes: input.notes, documents: input.documents });
      const rows = {
        notes: input.notes === undefined ? [] : page(world.notes, input.scope, input.notes.after, input.limit),
        documents: input.documents === undefined ? [] : page(world.documents, input.scope, input.documents.after, input.limit),
      };
      const shaped = hooks.collect?.(rows) ?? rows;
      return { ...shaped, handle: {} };
    },
    commit(input) {
      record("commit", { notes: input.notes, documents: input.documents });
      hooks.commit?.();
      return input.notes + input.documents === 0 ? {} : { receipt: receipt(["originals", calls.length]) };
    },
    open(input) {
      record("open", { ref: input.ref, from_ordinal: input.from_ordinal });
      hooks.open?.();
      if (input.ref.kind === "note") {
        const row = world.notes.find((candidate) => candidate.id === input.ref.id);
        if (row === undefined) throw new AuthorityOperationError("not_found", "request failed");
        return { kind: "note", row, text: `Text of ${row.title ?? "note"}`, release: { receipt: receipt(["note", row.id]) } };
      }
      const row = world.documents.find((candidate) => candidate.id === input.ref.id);
      if (row === undefined) throw new AuthorityOperationError("not_found", "request failed");
      const from = input.from_ordinal ?? 1;
      const chunks = CHUNKS.filter((chunk) => chunk.ordinal >= from).slice(0, CHUNKS_PER_PAGE);
      const last = chunks.at(-1)?.ordinal ?? 0;
      return {
        kind: "document", row, filename: "memo.pdf",
        chunks: chunks.map(({ text, ordinal }) => ({ anchor_kind: "page", anchor_start: ordinal, text })),
        next_ordinal: last < CHUNKS.length ? last + 1 : null, release: { receipt: receipt(["document", row.id, from]) },
      };
    },
    revalidate(input) {
      record("revalidate", { receipt: input.release.receipt });
      hooks.revalidate?.();
    },
  };
  const meetings: PersonMeetingItemsPortV1 = {
    collectMeetings(input) {
      record("collectMeetings", { scope: input.scope, after: input.after, limit: input.limit });
      if (world.held) return { status: "held" };
      const rows = page(world.meetings, input.scope, input.after, input.limit);
      return { status: "ok", rows: hooks.meetings?.(rows) ?? rows, handle: {} };
    },
    commitMeetings(input) {
      record("commitMeetings", { count: input.count });
      return input.count === 0 ? {} : { receipt: receipt(["meetings", calls.length]) };
    },
    openMeeting(input) {
      record("openMeeting", { record_sha256: input.record_sha256, from: input.from });
      hooks.open?.();
      const row = world.meetings.find((candidate) => candidate.id === input.record_sha256);
      if (row === undefined) throw new AuthorityOperationError("not_found", "item is not available");
      const start = input.from === undefined ? 0 : PARTS.findIndex((part) => part.atom_order === input.from!.atom_order && part.part === input.from!.part);
      if (start < 0) throw new AuthorityOperationError("not_found", "item is not available");
      const taken = PARTS.slice(start, start + MEETING_ATOMS_PER_PAGE);
      const following = PARTS[start + taken.length];
      return {
        row, atoms: taken.map((part) => part.atom),
        ...(input.from === undefined ? { meeting: { all_day: false, participants: ["Ari"], participants_more: false }, transcript_shared: row.id.endsWith("1") } : {}),
        next: following === undefined ? null : { atom_order: following.atom_order, part: following.part },
        release: { receipt: receipt(["meeting", row.id, start]) },
      };
    },
    admitMeeting(input) {
      record("admitMeeting", { record_sha256: input.record_sha256 });
      if (!world.meetings.some((candidate) => candidate.id === input.record_sha256)) throw new AuthorityOperationError("not_found", "item is not available");
    },
    revalidateMeetingRelease(input) {
      record("revalidateMeetingRelease", { receipt: input.release.receipt });
      hooks.revalidate?.();
    },
  };
  const transcripts: PersonTranscriptByRecordPortV1 = {
    readApprovedMeetingTranscriptByRecordV1(input) {
      record("readTranscript", { record_sha256: input.record_sha256, offset: input.offset });
      hooks.open?.();
      const offset = input.offset ?? 0;
      const end = Math.min(TRANSCRIPT.length, offset + TRANSCRIPT_PAGE);
      return { text: TRANSCRIPT.slice(offset, end), next_offset: end === TRANSCRIPT.length ? null : end };
    },
  };
  const directory: PersonListDirectoryPortV1 = {
    joinedProjects() {
      record("joinedProjects", {});
      return {
        projects: world.projects,
        grants_sha256: canonicalSha256({ ids: world.projects.map((project) => project.project_id), grants: world.grants }),
        names_sha256: canonicalSha256(world.projects as never),
      };
    },
    me: () => ({ display_name: "Maya Chen" }),
    audit(entry) {
      audits.push(entry);
      return canonicalSha256({ audit: audits.length });
    },
  };
  const tools = async (): Promise<readonly OrganizationPersonToolV4[]> => {
    record("tools", {});
    hooks.tools?.();
    return [{ tool_id: "slack", display_name: "Slack", availability: "enabled", personal_status: "linked", external_scope_id: "T0SECRETSCOPE", external_subject_id: "U0SECRETSUBJECT", organization_setup: null }];
  };
  const tokens = { owner: OWNER, member: MEMBER } as const;
  const sessions = {
    authenticateAccess: ({ access_token }: { readonly access_token: string }) => {
      const actor = tokens[access_token as keyof typeof tokens];
      if (actor === undefined) throw new AuthorityOperationError("unauthorized", "person authentication failed");
      return authorization(actor, { session_state_sha256: canonicalSha256(world.session) });
    },
  };
  const route = createPersonListRouteV1({ organization_id: OWNER.organization_id, sessions, tools, directory, originals, meetings, transcripts });
  const list = (request: Omit<PersonListRequestV1, "schema_version"> = {}, access_token = "owner", signal?: AbortSignal) =>
    route.list({ access_token, request: { schema_version: 1, ...request }, ...(signal === undefined ? {} : { signal }) });
  const open = (value: PersonOpenRefV1, cursor?: string, access_token = "owner") =>
    route.open({ access_token, request: { schema_version: 1, ref: value, ...(cursor === undefined ? {} : { cursor }) } });
  const called = (method: string) => calls.filter((call) => call.method === method);
  return { world, calls, called, audits, hooks, list, open };
}

const CHUNKS = Array.from({ length: 7 }, (_, index) => ({ ordinal: index + 1, text: `chunk ${index + 1}. ` }));
const PARTS: readonly { readonly atom_order: number; readonly part: number; readonly atom: PersonOpenMeetingAtomV1 }[] = [
  { atom_order: 0, part: 1, atom: { kind: "decision", text: "Annual plans first.", status: "decided" } },
  { atom_order: 1, part: 1, atom: { kind: "action", text: "First half ", owner: "Maya Chen", part: { index: 1, count: 2 } } },
  { atom_order: 1, part: 2, atom: { kind: "action", text: "second half.", part: { index: 2, count: 2 } } },
  { atom_order: 2, part: 1, atom: { kind: "rationale", text: "Churn drops." } },
  { atom_order: 3, part: 1, atom: { kind: "decision", text: "Ship in October.", status: "proposed" } },
];
const TRANSCRIPT = "Ari: we ship annual plans first. Maya: agreed, October.";

type Fixture = ReturnType<typeof fixture>;
async function walk(f: Fixture, request: Omit<PersonListRequestV1, "schema_version" | "cursor"> = {}, access_token = "owner"): Promise<PersonListResponseV1[]> {
  const pages: PersonListResponseV1[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await f.list({ ...request, ...(cursor === undefined || cursor === null ? {} : { cursor }) }, access_token);
    pages.push(page);
    cursor = page.next_cursor;
    if (pages.length > 50) throw new Error("walk did not terminate");
  } while (cursor !== null);
  return pages;
}
const decode = (cursor: string, scope: PersonListResponseV1["scope"], actor = OWNER): PersonListPositionsV1 =>
  decodePersonListCursorV1(cursor, { scope, organization_id: actor.organization_id, membership_id: actor.membership_id });

describe("person list route", () => {
  it("merges three sources with tied times into one global order over many pages, with no gap or duplicate", async () => {
    const f = fixture({
      notes: Array.from({ length: 30 }, (_, n) => note(n, T(n % 7))),
      documents: Array.from({ length: 27 }, (_, n) => document(n, T(n % 5))),
      meetings: Array.from({ length: 26 }, (_, n) => meeting(n, T(n % 6))),
    });
    const pages = await walk(f);
    expect(pages.length).toBe(4);
    expect(pages.slice(0, -1).every((page) => page.items.length === 25 && page.next_cursor !== null)).toBe(true);
    expect(pages.at(-1)!.next_cursor).toBeNull();
    const all = [...f.world.notes, ...f.world.documents, ...f.world.meetings].sort(order).map(ref);
    expect(pages.flatMap((page) => page.items.map((item) => item.ref))).toEqual(all);
    // N-11: every cursor holds only positions this walk already emitted.
    const emitted = new Set<string>();
    for (const page of pages) {
      for (const item of page.items) emitted.add(item.ref);
      if (page.next_cursor === null) continue;
      const positions = decode(page.next_cursor, page.scope);
      for (const kind of ["note", "document", "meeting"] as const) {
        const position = positions[kind];
        if (position.state === "after") expect(emitted.has(`${kind}:${position.id}`)).toBe(true);
      }
    }
    // Each store audited exactly its emitted prefix, page by page.
    const committed = f.called("commit").map((call) => (call.input.notes as number) + (call.input.documents as number));
    const meetingsCommitted = f.called("commitMeetings").map((call) => call.input.count as number);
    expect(committed.reduce((sum, value) => sum + value, 0)).toBe(57);
    expect(meetingsCommitted.reduce((sum, value) => sum + value, 0)).toBe(26);
    expect(pages.map((page) => page.items.length)).toEqual(f.audits.map((audit) => audit.released_count));
  });

  it("keeps a source at its last emitted row, and at its start when nothing of it left", async () => {
    const f = fixture({
      notes: Array.from({ length: 30 }, (_, n) => note(n, T(100 + n))),
      documents: Array.from({ length: 5 }, (_, n) => document(n, T(n))),
    });
    const first = await f.list();
    expect(first.items.map((item) => item.kind)).toEqual(Array(25).fill("note"));
    const positions = decode(first.next_cursor!, first.scope);
    const lastNote = [...f.world.notes].sort(order)[24]!;
    expect(positions).toEqual({
      note: { state: "after", added_at: lastNote.added_at, id: lastNote.id },
      document: { state: "start" },
      meeting: { state: "done" },
    });
    expect(f.called("commit").at(-1)!.input).toEqual({ notes: 25, documents: 0 });
    expect(f.called("commitMeetings").at(-1)!.input).toEqual({ count: 0 });
    const second = await f.list({ cursor: first.next_cursor! });
    expect(second.items.map((item) => item.kind)).toEqual([...Array(5).fill("note"), ...Array(5).fill("document")]);
    expect(second.next_cursor).toBeNull();
    expect(f.called("collectMeetings")).toHaveLength(1);
  });

  it("passes mine to both stores, and project scope as the project", async () => {
    const f = fixture({ notes: [note(1, T(1)), note(2, T(2))], meetings: [meeting(1, T(3))], mine: [`ctx_${hex(1)}`] });
    const mine = await f.list({ mine: true });
    expect(mine.scope).toEqual({ kind: "mine" });
    expect(mine.items.map((item) => item.ref)).toEqual([`note:ctx_${hex(1)}`]);
    expect(f.called("collect")[0]!.input.scope).toEqual({ kind: "mine" });
    expect(f.called("collectMeetings")[0]!.input.scope).toEqual({ kind: "mine" });
    await f.list({ project_id: PROJECT_ALPHA });
    expect(f.called("collect")[1]!.input.scope).toEqual({ kind: "project", project_id: PROJECT_ALPHA });
    expect(f.called("collectMeetings")[1]!.input.scope).toEqual({ kind: "project", project_id: PROJECT_ALPHA });
  });

  it("denies a project the caller has not joined, or that does not exist, before any store or tool", async () => {
    const f = fixture({ notes: [note(1, T(1), { association_project_ids: [UNJOINED] })] });
    const denials = [await rejected(f.list({ project_id: UNJOINED })), await rejected(f.list({ project_id: NONEXISTENT }))];
    expect(denials).toEqual([{ code: "unauthorized", message: "person authentication failed" }, { code: "unauthorized", message: "person authentication failed" }]);
    expect(f.calls.map((call) => call.method)).toEqual(["joinedProjects", "joinedProjects"]);
    expect(f.audits).toEqual([]);
  });

  it("carries the header on each scope's first page only, and never a tool's external ids", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      project_id: `prj_${hex(index).slice(-8)}-0000-4000-8000-000000000000`, name: `Project ${index}`, role: "member", status: index < 40 ? "active" : "archived",
    }) as PersonListJoinedProjectV1);
    const f = fixture({ notes: Array.from({ length: 26 }, (_, n) => note(n, T(n))), projects: many });
    const global = await f.list();
    expect(global.me).toEqual({ display_name: "Maya Chen", membership_type: "owner" });
    expect(global.connected).toEqual([{ tool: "slack", status: "linked" }]);
    expect(JSON.stringify(global)).not.toMatch(/SECRET|Slack/);
    expect(global.projects).toEqual(many.slice(0, 50));
    expect(global.projects_more).toBe(true);
    expect(global.project).toBeUndefined();
    const next = await f.list({ cursor: global.next_cursor! });
    expect(Object.keys(next).sort()).toEqual(["items", "kind", "next_cursor", "schema_version", "scope"]);
    expect(f.called("tools")).toHaveLength(1);

    const g = fixture({ notes: Array.from({ length: 26 }, (_, n) => note(n, T(n), { association_project_ids: [PROJECT_ALPHA] })) });
    const project = await g.list({ project_id: PROJECT_ALPHA });
    expect(project.project).toEqual({ project_id: PROJECT_ALPHA, name: "Alpha", role: "lead", status: "active" });
    expect(project.me).toBeUndefined();
    const projectNext = await g.list({ project_id: PROJECT_ALPHA, cursor: project.next_cursor! });
    expect(projectNext.project).toBeUndefined();
    const mine = await g.list({ mine: true });
    expect(Object.keys(mine).sort()).toEqual(["items", "kind", "next_cursor", "schema_version", "scope"]);
    expect(g.called("tools")).toHaveLength(0);
    const few = await fixture().list();
    expect(few.projects_more).toBe(false);
    expect(few.projects!.map((item) => item.status)).toEqual(["active", "archived"]);
  });

  it("drops an unjoined project from rows, header and cursor, and collapses visibility and titles", async () => {
    const f = fixture({
      notes: [
        note(1, T(5), { association_project_ids: [PROJECT_BETA, UNJOINED, PROJECT_ALPHA], visibility: "projects", title: "x".repeat(250) }),
        note(2, T(4), { visibility: "only_me", title: null }),
      ],
      documents: [document(1, T(3), { visibility: "project", association_project_ids: [UNJOINED], title: " \u0007 " })],
      meetings: [meeting(1, T(2), { visibility: "approver_only", title: null, meeting_date: "2026-09-01" }), meeting(2, T(1), { visibility: "projects" })],
    });
    const page = await f.list();
    const [first, second, third, fourth, fifth] = page.items;
    // Joined order (active Alpha before archived Beta), with the snapshot's names.
    expect(first!.projects).toEqual([{ project_id: PROJECT_ALPHA, name: "Alpha" }, { project_id: PROJECT_BETA, name: "Beta" }]);
    expect(first).toMatchObject({ visibility: "project", title: `${"x".repeat(197)}…` });
    expect(Buffer.byteLength(first!.title)).toBe(200);
    expect(second).toMatchObject({ visibility: "only_me", title: "Untitled", projects: [] });
    expect(third).toMatchObject({ visibility: "project", title: "Untitled", projects: [] });
    expect(fourth).toMatchObject({ visibility: "only_me", title: "Approved meeting", meeting_date: "2026-09-01" });
    expect(fifth).toMatchObject({ visibility: "project" });
    expect(JSON.stringify(page)).not.toContain(UNJOINED);
    expect(JSON.stringify(page)).not.toMatch(/approver_only|"projects"\s*:\s*"|visibility":"projects"/);
  });

  it("rejects a misordered store page, a repeated cursor row, and a project row outside its association as invalid output", async () => {
    const reversed = fixture({ notes: [note(1, T(2)), note(2, T(1))] });
    reversed.hooks.collect = (rows) => ({ ...rows, notes: [...rows.notes].reverse() });
    expect(await rejected(reversed.list())).toMatchObject({ code: "invalid_output" });
    const tie = fixture({ notes: [note(2, T(1)), note(1, T(1))] });
    tie.hooks.collect = (rows) => ({ ...rows, notes: [...rows.notes].reverse() });
    expect(await rejected(tie.list())).toMatchObject({ code: "invalid_output" });
    const outside = fixture({ meetings: [meeting(1, T(1), { association_project_ids: [PROJECT_ALPHA] })] });
    outside.hooks.meetings = (rows) => rows.map((row) => ({ ...row, association_project_ids: [] }));
    expect(await rejected(outside.list({ project_id: PROJECT_ALPHA }))).toMatchObject({ code: "invalid_output" });
    const replayed = fixture({ notes: Array.from({ length: 26 }, (_, n) => note(n, T(n))) });
    const first = await replayed.list();
    replayed.hooks.collect = (rows) => ({ ...rows, notes: [[...replayed.world.notes].sort(order)[24]!, ...rows.notes] });
    expect(await rejected(replayed.list({ cursor: first.next_cursor! }))).toMatchObject({ code: "invalid_output" });
    const wrongKind = fixture({ notes: [note(1, T(1))] });
    wrongKind.hooks.collect = (rows) => ({ ...rows, documents: rows.notes as never });
    expect(await rejected(wrongKind.list())).toMatchObject({ code: "invalid_output" });
    for (const f of [reversed, tie, outside, replayed, wrongKind]) expect(f.audits.length).toBeLessThanOrEqual(1);
    expect(reversed.called("commit")).toEqual([]);
  });

  it("holds meetings with a notice, never skips them, and refuses a later page that could only wait", async () => {
    const f = fixture({ notes: Array.from({ length: 26 }, (_, n) => note(n, T(100 + n))), meetings: [meeting(1, T(50)), meeting(2, T(200))] });
    f.world.held = true;
    const first = await f.list();
    expect(first.notice).toBe("meetings_unavailable");
    expect(first.me).toBeDefined();
    expect(decode(first.next_cursor!, first.scope).meeting).toEqual({ state: "start" });
    expect(f.called("commitMeetings")).toEqual([]);
    const second = await f.list({ cursor: first.next_cursor! });
    expect(second.items).toHaveLength(1);
    expect(second.notice).toBe("meetings_unavailable");
    const waiting = second.next_cursor!;
    expect(decode(waiting, second.scope)).toEqual({ note: { state: "done" }, document: { state: "done" }, meeting: { state: "start" } });
    expect(await rejected(f.list({ cursor: waiting }))).toMatchObject({ code: "unavailable" });
    expect(f.audits).toHaveLength(2);
    f.world.held = false;
    const resumed = await f.list({ cursor: waiting });
    expect(resumed.items.map((item) => item.ref)).toEqual([`meeting:sha256:${hex(2)}`, `meeting:sha256:${hex(1)}`]);
    expect(resumed.notice).toBeUndefined();
    expect(resumed.next_cursor).toBeNull();

    const empty = fixture({ meetings: [meeting(1, T(1))] });
    empty.world.held = true;
    const page = await empty.list();
    expect(page).toMatchObject({ items: [], notice: "meetings_unavailable", me: { display_name: "Maya Chen" } });
    expect(page.next_cursor).not.toBeNull();
    expect(await rejected(empty.list({ cursor: page.next_cursor! }))).toMatchObject({ code: "unavailable" });
  });

  it("releases nothing when the session, the grants or a store's access changed, and retries on a rename only", async () => {
    const cases: readonly [string, (f: Fixture) => void, string][] = [
      ["session", (f) => { f.hooks.commit = () => { f.world.session = "rotated"; }; }, "unauthorized"],
      ["grants", (f) => { f.hooks.commit = () => { f.world.grants += 1; }; }, "unauthorized"],
      ["stale", (f) => { f.hooks.revalidate = () => { throw new AuthorityOperationError("stale_access_state", "request failed"); }; }, "unauthorized"],
      ["store fence", (f) => { f.hooks.commit = () => { throw new AuthorityOperationError("unauthorized", "person authentication failed"); }; }, "unauthorized"],
      ["rename", (f) => { f.hooks.commit = () => { f.world.projects = f.world.projects.map((project) => ({ ...project, name: `${project.name} renamed` })); }; }, "unavailable"],
    ];
    for (const [name, arrange, code] of cases) {
      const f = fixture({ notes: [note(1, T(1))] });
      arrange(f);
      expect({ name, ...(await rejected(f.list())) }).toMatchObject({ name, code });
      expect(f.audits).toEqual([]);
    }
  });

  it("audits the exact response digest with each store's receipt, and nothing when the caller left", async () => {
    const f = fixture({ notes: [note(1, T(2))], meetings: [meeting(1, T(1))] });
    const page = await f.list();
    expect(f.audits).toHaveLength(1);
    const [audit] = f.audits;
    expect(audit).toMatchObject({ operation: "person_list", scope_kind: "global", response_sha256: canonicalSha256(page as never), released_count: 2 });
    expect(audit!.store_receipts).toHaveLength(2);
    expect(f.called("revalidate").map((call) => call.input.receipt)).toEqual([audit!.store_receipts[0]]);
    expect(f.called("revalidateMeetingRelease").map((call) => call.input.receipt)).toEqual([audit!.store_receipts[1]]);
    const none = fixture();
    await none.list({ mine: true });
    expect(none.audits[0]).toMatchObject({ scope_kind: "mine", released_count: 0, store_receipts: [] });

    const controller = new AbortController();
    const aborted = fixture({ notes: [note(1, T(1))] });
    aborted.hooks.tools = () => controller.abort();
    await expect(aborted.list({}, "owner", controller.signal)).rejects.toThrow();
    expect(aborted.audits).toEqual([]);
    expect(aborted.called("commit")).toEqual([]);
  });

  it("opens each kind through its own store, with the cursor bound to its ref", async () => {
    const f = fixture({
      notes: [note(1, T(1), { association_project_ids: [PROJECT_ALPHA, UNJOINED] })],
      documents: [document(1, T(1))],
      meetings: [meeting(1, T(1)), meeting(2, T(2))],
    });
    const opened = await f.open(`note:ctx_${hex(1)}`);
    expect(opened).toMatchObject({ kind: "echo-person-open-v1", ref: `note:ctx_${hex(1)}`, text: "Text of Note 1", next_cursor: null, item: { projects: [{ project_id: PROJECT_ALPHA, name: "Alpha" }] } });
    expect(JSON.stringify(opened)).not.toContain(UNJOINED);
    expect(f.called("open")[0]!.input).toEqual({ ref: { kind: "note", id: `ctx_${hex(1)}` }, from_ordinal: undefined });

    // N-15: pages concatenate to exactly the stored sequence.
    const documentRef = `document:doc_${hex(1)}` as const;
    const chunks: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await f.open(documentRef, cursor ?? undefined) as PersonOpenDocumentV1;
      chunks.push(...page.chunks.map((chunk) => chunk.text));
      if (page.next_cursor !== null) expect(decodePersonOpenCursorV1(page.next_cursor, { ref: documentRef, organization_id: OWNER.organization_id, membership_id: OWNER.membership_id })).toEqual({ kind: "document", from_ordinal: chunks.length + 1 });
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(chunks).toEqual(CHUNKS.map((chunk) => chunk.text));

    const meetingRef = `meeting:sha256:${hex(1)}` as const;
    const atoms: PersonOpenMeetingAtomV1[] = [];
    const pages: PersonOpenMeetingV1[] = [];
    cursor = undefined;
    do {
      const page = await f.open(meetingRef, cursor ?? undefined) as PersonOpenMeetingV1;
      pages.push(page);
      atoms.push(...page.atoms);
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(atoms).toEqual(PARTS.map((part) => part.atom));
    expect(pages[0]).toMatchObject({ meeting: { participants: ["Ari"] }, transcript_ref: `transcript:sha256:${hex(1)}` });
    expect(pages.slice(1).every((page) => page.meeting === undefined && page.transcript_ref === undefined)).toBe(true);
    expect((await f.open(`meeting:sha256:${hex(2)}`) as PersonOpenMeetingV1).transcript_ref).toBeUndefined();
    await expect(f.open(documentRef, pages[0]!.next_cursor!)).rejects.toMatchObject({ code: "invalid_request" });

    const transcriptRef = `transcript:sha256:${hex(1)}` as const;
    let text = "";
    cursor = undefined;
    do {
      const page = await f.open(transcriptRef, cursor ?? undefined) as PersonOpenTranscriptV1;
      text += page.text;
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(text).toBe(TRANSCRIPT);
    const order = f.calls.map((call) => call.method).filter((method) => method === "admitMeeting" || method === "readTranscript");
    expect(order.slice(0, 2)).toEqual(["admitMeeting", "readTranscript"]);
    expect(f.audits.every((audit) => audit.operation === "person_open" && audit.scope_kind === "item" && audit.released_count === 1)).toBe(true);
  });

  it("answers every store refusal of an open with one not_found, but passes unavailable and a bug through", async () => {
    const refs: readonly PersonOpenRefV1[] = [`note:ctx_${hex(1)}`, `document:doc_${hex(1)}`, `meeting:sha256:${hex(1)}`, `transcript:sha256:${hex(1)}`];
    const answers: unknown[] = [];
    for (const code of ["not_found", "unauthorized", "invalid_request", "conflict", "stale_access_state", "invalid_output"] as const) {
      for (const value of refs) {
        const f = fixture({ notes: [note(1, T(1))], documents: [document(1, T(1))], meetings: [meeting(1, T(1))] });
        f.hooks.open = () => { throw new AuthorityOperationError(code, `store said ${code}`); };
        answers.push(await rejected(f.open(value)));
        expect(f.audits).toEqual([]);
      }
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(new Set([JSON.stringify({ code: "not_found", message: "item is not available" })]));
    const guessed = fixture();
    for (const value of refs) expect(await rejected(guessed.open(value))).toEqual({ code: "not_found", message: "item is not available" });

    const unavailable = fixture({ meetings: [meeting(1, T(1))] });
    unavailable.hooks.open = () => { throw new AuthorityOperationError("unavailable", "record evidence is unavailable"); };
    expect(await rejected(unavailable.open(`meeting:sha256:${hex(1)}`))).toMatchObject({ code: "unavailable" });
    const bug = fixture({ meetings: [meeting(1, T(1))] });
    bug.hooks.open = () => { throw new TypeError("bug"); };
    await expect(bug.open(`meeting:sha256:${hex(1)}`)).rejects.toBeInstanceOf(TypeError);

    // A revalidation failure after the read is the same not_found, with no audit.
    const revoked = fixture({ notes: [note(1, T(1))] });
    revoked.hooks.revalidate = () => { throw new AuthorityOperationError("stale_access_state", "request failed"); };
    expect(await rejected(revoked.open(`note:ctx_${hex(1)}`))).toEqual({ code: "not_found", message: "item is not available" });
    expect(revoked.audits).toEqual([]);
    const regranted = fixture({ meetings: [meeting(1, T(1))] });
    regranted.hooks.open = () => { regranted.world.grants += 1; };
    expect(await rejected(regranted.open(`meeting:sha256:${hex(1)}`))).toEqual({ code: "not_found", message: "item is not available" });
    expect(regranted.audits).toEqual([]);
  });

  it("refuses an open cursor from another ref, person or operation as a bad request", async () => {
    const f = fixture({ documents: [document(1, T(1)), document(2, T(1))], notes: Array.from({ length: 26 }, (_, n) => note(n, T(n))) });
    const page = await f.open(`document:doc_${hex(1)}`) as PersonOpenResponseV1;
    expect(page.next_cursor).not.toBeNull();
    await expect(f.open(`document:doc_${hex(2)}`, page.next_cursor!)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.open(`document:doc_${hex(1)}`, page.next_cursor!, "member")).rejects.toMatchObject({ code: "invalid_request" });
    const listed = await f.list();
    await expect(f.open(`document:doc_${hex(1)}`, listed.next_cursor!)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.list({ cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.list({ mine: true, cursor: listed.next_cursor! })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.list({ cursor: listed.next_cursor! }, "member")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
