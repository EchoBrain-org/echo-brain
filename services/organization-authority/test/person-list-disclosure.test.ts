import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { canonicalSha256, sha256Digest, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_PATH_V3,
  PERSON_LIST_PATH_V1,
  PERSON_OPEN_PATH_V1,
  validatePersonAnswerResponseV4,
  type PersonListResponseV1,
  type PersonOpenMeetingV1,
  type PersonOpenResponseV1,
  type PersonOpenTranscriptV1,
} from "@echo-brain/organization-api";
import type { StructuredGenerationInput, StructuredGenerationPort } from "@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import {
  organizationMemberReadablePersonPolicyContractSha256,
  projectMembersReadablePersonPolicyContractSha256,
  restrictedReviewerPersonPolicyContractSha256,
  type OrganizationRecordDecisionBriefV1,
} from "@echo-brain/organization-protocol";
import { ApprovedMeetingTranscriptGrantReaderV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import { afterEach, describe, expect, it } from "vitest";
import { COORDINATES } from "../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { SqlitePersonAgenticAskAuditV1 } from "../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { SqlitePersonListDirectoryV1 } from "../src/adapters/persistence/sqlite/person-list-directory-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonOriginalItemsV1 } from "../src/adapters/persistence/sqlite/person-original-items-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import type { PersonMeetingItemsPortV1, PersonOriginalItemsPortV1 } from "../src/application/ports/person-list-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import { createPersonAnswerV3Route } from "../src/composition/person-answer-v3-route.js";
import { PersonDocumentProcessingV1 } from "../src/composition/person-document-processing-v1.js";
import { decodePersonListCursorV1, encodePersonListCursorV1, type PersonListPositionsV1 } from "../src/composition/person-list-cursor-v1.js";
import { createPersonListRouteV1 } from "../src/composition/person-list-v1-route.js";
import { createOrganizationAuthorityHttpServer } from "../src/presentation/organization-authority-http-server.js";
import { APPROVER_X, EMP_A, EMP_B, EMP_C, OWNER, PROJECT_NAMES, PROJ_X, SHARED, STANDARD_RECORDS, T, UNJOINED, admittedTranscriptV1, meetingWorld, type MeetingWorldV1 } from "./fixtures/person-meeting-world.js";
import { addMembership, authorization } from "./fixtures/project-context-sqlite.js";

/**
 * The person list and open (ADR-0023) on real SQLite stores and signed
 * approvals, composed as the Authority runtime composes them and served by the
 * real HTTP server. Owner and employee readers; every negative disclosure case
 * of the spec, Ask's included (N-16).
 */

type Actor = AuthorityPersonMembershipBinding;
type Token = "owner" | "emp_a" | "emp_b" | "emp_c" | "returned";
type NoteAudience = { readonly kind: "only_me" | "team" } | { readonly kind: "project"; readonly project_id: string } | { readonly kind: "projects"; readonly project_ids: readonly string[] };

/** EMP_A's principal under a second membership: the same person, a new tenure. */
const RETURNED: Actor = { ...EMP_A, membership_id: "mem_emp_a_returned" };
/** A second project the owner leads, so project cursors have two scopes to cross. */
const OWNER_B = "prj_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NONEXISTENT = "prj_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TRANSCRIPT = Array.from({ length: 700 }, (_, index) => `word${index}`).join(" ");
const QUOTE = "QUOTE-SECRET-EVIDENCE";
const FORBIDDEN_KEYS = new Set(["count", "total", "position", "log_position", "record_position", "generation_id", "audit_sequence", "approval_id", "request_id", "envelope", "source_id", "revision_id", "source_sha256"]);
const NOT_FOUND_BODY = '{"error":{"code":"not_found","message":"request failed"}}';
const UNAUTHORIZED_BODY = '{"error":{"code":"unauthorized","message":"request failed"}}';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Every key of a JSON value, at any depth, except an atom part's own count. */
function keys(value: unknown, parent = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(Array.isArray(value) || (parent === "part" && key === "count") ? [] : [key]),
    ...keys(child, Array.isArray(value) ? parent : key),
  ]);
}

/** Records every call a store receives, so a test can prove none ran. */
function counted<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === "function" ? (...args: unknown[]) => { calls.push(String(property)); return (value as (...input: unknown[]) => unknown).apply(object, args); } : value;
    },
  });
}

async function disclosureWorld() {
  const w: MeetingWorldV1 = await meetingWorld({ r4_transcript: admittedTranscriptV1(TRANSCRIPT) });
  cleanups.push(() => w.close());
  const org = COORDINATES.organization_id;
  // APPROVER_X authors across SHARED and UNJOINED; no reader holds UNJOINED.
  w.grant(SHARED, APPROVER_X);
  w.authority.prepare(`INSERT INTO authority_projects_v1
    (project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type)
    VALUES (?,?,?,?,?,?,?)`).run(OWNER_B, org, "Owner side project", T(1), OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
  w.grant(OWNER_B, OWNER);
  addMembership(w.authority, RETURNED, "Ari Employee", "ari-returned@example.test");
  await w.approve({
    name: "quoted", approval_id: "apr_quoted", projects: "team", final_approver: EMP_B, issued_at: T(8), share_transcript: false,
    brief: (brief: OrganizationRecordDecisionBriefV1) => ({
      ...brief,
      decisions: brief.decisions.map((signal) => ({ ...signal, evidence: signal.evidence.map((span) => ({ ...span, quote: `${QUOTE} ${span.block_id}` })) })),
    }),
  });
  w.rebuild();

  // Originals, authored through the real applications on the same Authority database.
  let clock = Date.parse("2026-09-02T12:00:00.000Z");
  // Short ticks: an extraction lease lasts 60 seconds of this clock.
  const now = () => new Date(clock += 1_000).toISOString();
  const authors: Readonly<Record<string, Actor>> = { owner: OWNER, emp_a: EMP_A, emp_b: EMP_B, emp_c: EMP_C, approver_x: APPROVER_X };
  const author = (token: string) => authorization(authors[token]!);
  const projects = createProjectContextApplicationV1({ authenticate: author, repository: new SqliteProjectContextRepositoryV1(w.authority, now) });
  const repository = new SqlitePersonDocumentRepositoryV1(w.authority, now);
  const documents = createPersonDocumentApplicationV1({ repository, authenticate: author });
  const requestIds: string[] = [];
  const note = (token: string, audience: NoteAudience, associations: readonly string[] = []): string => {
    const request_id = randomUUID();
    requestIds.push(request_id);
    const receipt = projects.submitUploadV3(token, { schema_version: 3, kind: "echo-person-update-submit-v3", request_id, title: `Note ${requestIds.length}`, text: `note text ${requestIds.length}`, association_project_ids: associations, audience } as never);
    return `note:${receipt.context_id}`;
  };
  const document = (token: string, audience: NoteAudience, associations: readonly string[] = [], chunks: readonly string[] = ["document text"]): string => {
    const request_id = randomUUID();
    requestIds.push(request_id);
    const bytes = Buffer.from(chunks.join("\n"));
    const saved = documents.uploadV2(token, {
      schema_version: 2, kind: "echo-person-document-upload-v2", request_id, filename: `document-${requestIds.length}.md`, title: `Doc ${requestIds.length}`,
      content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience, association_project_ids: associations,
    } as never, bytes);
    const claim = repository.claimExtraction();
    expect(claim?.document_id).toBe(saved.document_id);
    repository.completeExtraction(claim!, {
      status: "ready", sourceSha256: claim!.source_sha256, extractorVersion: "fixture-1", message: null,
      chunks: chunks.map((text, index) => ({ anchor_kind: "paragraph" as const, anchor_start: index + 1, text })),
    });
    return `document:${saved.document_id}`;
  };
  const refs = {
    ownerOnlyNote: note("owner", { kind: "only_me" }),
    empAOnlyNote: note("emp_a", { kind: "only_me" }),
    empASharedNote: note("emp_a", { kind: "project", project_id: SHARED }, [SHARED]),
    empATeamNote: note("emp_a", { kind: "team" }, [SHARED]),
    unjoinedNote: note("approver_x", { kind: "projects", project_ids: [SHARED, UNJOINED] }, [SHARED, UNJOINED]),
    empBTeamNote: note("emp_b", { kind: "team" }),
    ownerOnlyDocument: document("owner", { kind: "only_me" }),
    empAOnlyDocument: document("emp_a", { kind: "only_me" }),
    empASharedDocument: document("emp_a", { kind: "project", project_id: SHARED }, [SHARED]),
    unjoinedDocument: document("approver_x", { kind: "projects", project_ids: [SHARED, UNJOINED] }, [SHARED, UNJOINED]),
    longDocument: document("emp_b", { kind: "team" }, [], Array.from({ length: 11 }, (_, index) => `Paragraph ${index + 1}.`)),
  };
  // Enough team notes that every reader's global list takes more than one page.
  for (let index = 0; index < 20; index += 1) note("emp_c", { kind: "team" });
  // Lists read custody; Ask reads notes only once the text inbox admitted them.
  const inbox = new PersonDocumentProcessingV1(repository, undefined, new SqlitePersonTextSourceInboxV1(w.authority, now));
  const admitNotes = async () => { while (await inbox.runOnce(new AbortController().signal) === "admitted") { /* next note */ } };

  // The runtime's composition, with the world's sessions plus the returned tenure.
  let returnedChecks = Date.parse("2026-09-25T00:00:00.000Z");
  const sessions = {
    authenticateAccess: ({ access_token }: { readonly access_token: string }) => access_token === "returned"
      ? authorization(RETURNED, { session_state_sha256: canonicalSha256(w.session.state), checked_at: new Date(returnedChecks += 1).toISOString() })
      : w.sessions.authenticateAccess({ access_token }),
  };
  const grantReads = { count: 0, fault: false };
  const grantReader = new ApprovedMeetingTranscriptGrantReaderV1(w.record);
  const grants = new Proxy(grantReader, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        grantReads.count += 1;
        if (grantReads.fault) throw new TypeError("grant reader fault");
        return (value as (...input: unknown[]) => unknown).apply(object, args);
      };
    },
  });
  const originals = new SqlitePersonOriginalContextRetrievalV1(w.authority, sessions, org, {
    authority_id: COORDINATES.authority_id, state_lineage_id: COORDINATES.state_lineage_id, grants,
    is_expected_policy_contract: (grant) =>
      (grant.policy_id === "organization-member-readable-person-v2" && grant.policy_contract_sha256 === organizationMemberReadablePersonPolicyContractSha256()) ||
      (grant.policy_id === "restricted-reviewer-person-v2" && grant.policy_contract_sha256 === restrictedReviewerPersonPolicyContractSha256()) ||
      (grant.policy_id === "project-members-readable-person-v1" && grant.policy_contract_sha256 === projectMembersReadablePersonPolicyContractSha256()),
  });
  const storeCalls: string[] = [];
  const hooks: { afterCollect?: () => void } = {};
  const items: PersonOriginalItemsPortV1 = counted(new SqlitePersonOriginalItemsV1(w.authority, sessions, org), storeCalls);
  const records = w.route({ sessions, transcript_probe: (input) => originals.probeApprovedMeetingTranscriptV1(input) });
  const meetings: PersonMeetingItemsPortV1 = counted({
    collectMeetings: (input) => { const collected = records.collectMeetings(input); hooks.afterCollect?.(); return collected; },
    commitMeetings: (input) => records.commitMeetings(input),
    openMeeting: (input) => records.openMeeting(input),
    admitMeeting: (input) => records.admitMeeting(input),
    revalidateMeetingRelease: (input) => records.revalidateMeetingRelease(input),
  } satisfies PersonMeetingItemsPortV1, storeCalls);
  // N-16's Ask model takes every item the small-scope preload opened and cites all of them.
  const everything: StructuredGenerationPort = {
    async generate(input: StructuredGenerationInput) {
      const prompt = JSON.parse(input.user_prompt) as { readonly question: string; readonly opened?: readonly { readonly id: string }[]; readonly evidence?: readonly { readonly id: string }[] };
      if ((input.schema.properties as Readonly<Record<string, unknown>>).sentences !== undefined) {
        const ids = prompt.evidence!.map((entry) => entry.id);
        return { sentences: Array.from({ length: Math.ceil(ids.length / 12) }, (_, index) => ({ text: `Group ${index + 1} of what I added.`, evidence: ids.slice(index * 12, index * 12 + 12) })), not_found: [] };
      }
      const opened = (prompt.opened ?? []).map((entry) => entry.id);
      return { parts: [{ question: prompt.question, needs: [{ need: "what I added", status: "found", evidence: opened.slice(0, 12) }], notes: "" }], actions: [{ tool: "finish", args: {} }] };
    },
  };
  const slackAskers: { readonly principal_id: string; readonly membership_id: string }[] = [];
  const server = createOrganizationAuthorityHttpServer({
    descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: "https://issuer.example",
    person_list: createPersonListRouteV1({
      organization_id: org, sessions, tools: async () => [], directory: new SqlitePersonListDirectoryV1(w.authority),
      originals: items, meetings, transcripts: originals,
    }),
    person_answer_v3: createPersonAnswerV3Route({
      authority_id: COORDINATES.authority_id, organization_id: org, state_lineage_id: COORDINATES.state_lineage_id,
      sessions: sessions as never, originals, records, model: everything,
      generation: { generation_adapter_id: "fixture", planner_model: "fixture", answer_model: "fixture", timeout_ms: 25_000 },
      audit: new SqlitePersonAgenticAskAuditV1(w.authority), small_scope_shortcut: true,
      slack_for: (asker) => { slackAskers.push(asker); return undefined; },
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;

  const bodies: string[] = [];
  const post = async (path: string, token: Token, body: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, text };
  };
  const list = async (token: Token, request: Readonly<Record<string, unknown>> = {}) => post(PERSON_LIST_PATH_V1, token, { schema_version: 1, ...request });
  const open = async (token: Token, ref: string, cursor?: string) => post(PERSON_OPEN_PATH_V1, token, { schema_version: 1, ref, ...(cursor === undefined ? {} : { cursor }) });
  const walk = async (token: Token, request: Readonly<Record<string, unknown>> = {}): Promise<PersonListResponseV1[]> => {
    const pages: PersonListResponseV1[] = [];
    let cursor: string | null = null;
    do {
      const response = await list(token, { ...request, ...(cursor === null ? {} : { cursor }) });
      expect(response.status).toBe(200);
      const page = JSON.parse(response.text) as PersonListResponseV1;
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null && pages.length < 20);
    return pages;
  };
  const listed = async (token: Token, request: Readonly<Record<string, unknown>> = {}) => (await walk(token, request)).flatMap((page) => page.items);
  const refsOf = async (token: Token, request: Readonly<Record<string, unknown>> = {}): Promise<string[]> => (await listed(token, request)).map((item) => item.ref);
  const openAll = async (token: Token, ref: string): Promise<PersonOpenResponseV1[]> => {
    const pages: PersonOpenResponseV1[] = [];
    let cursor: string | undefined;
    do {
      const response = await open(token, ref, cursor);
      expect(response.status).toBe(200);
      const page = JSON.parse(response.text) as PersonOpenResponseV1;
      pages.push(page);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined && pages.length < 20);
    return pages;
  };
  const pageAudits = () => (w.authority.prepare("SELECT body_json FROM authority_project_read_audit_v1").all() as { readonly body_json: string }[])
    .map((row) => JSON.parse(row.body_json) as Record<string, unknown>).filter((body) => body.kind === "echo-person-list-page-audit-v1");
  const originalAudits = () => (w.authority.prepare("SELECT body_json FROM authority_person_upload_read_audit_v1").all() as { readonly body_json: string }[])
    .map((row) => JSON.parse(row.body_json) as Record<string, unknown>).filter((body) => body.kind === "echo-person-original-item-release-audit-v1");
  const meeting = (name: string) => `meeting:${w.digest(name)}`;
  const ask = async (token: Token, request: Readonly<Record<string, unknown>> = {}) => post(PERSON_ANSWER_PATH_V3, token, { schema_version: 3, question: "What did I add?", ...request });
  return { w, refs, requestIds, list, open, walk, listed, refsOf, openAll, ask, admitNotes, slackAskers, bodies, pageAudits, originalAudits, meeting, storeCalls, hooks, grantReads };
}

type World = Awaited<ReturnType<typeof disclosureWorld>>;
const guessed = {
  note: `note:ctx_${"0".repeat(64)}`,
  document: `document:doc_${"0".repeat(64)}`,
  meeting: `meeting:${sha256Digest("pending-approval-without-a-record")}`,
  transcript: `transcript:${sha256Digest("pending-approval-without-a-record")}`,
};

/** Every scope a reader can list: global, mine and each joined project. */
async function scopes(f: World, token: Token): Promise<Readonly<Record<string, unknown>>[]> {
  const first = JSON.parse((await f.list(token)).text) as PersonListResponseV1;
  return [{}, { mine: true }, ...first.projects!.map((project) => ({ project_id: project.project_id }))];
}

describe("person list and open negative disclosure (ADR-0023)", () => {
  it("N-1, N-8, N-9: another member's only-me items, rejected and pending meetings stay hidden, and every miss is one 404", async () => {
    const f = await disclosureWorld();
    const hidden: Readonly<Record<Token, readonly string[]>> = {
      owner: [f.refs.empAOnlyNote, f.refs.empAOnlyDocument, f.meeting("r5")],
      emp_a: [f.refs.ownerOnlyNote, f.refs.ownerOnlyDocument, f.meeting("r2"), f.meeting("r5")],
      emp_b: [f.refs.ownerOnlyNote, f.refs.ownerOnlyDocument, f.refs.empAOnlyNote, f.refs.empAOnlyDocument, f.meeting("r2"), f.meeting("r5")],
      emp_c: [], returned: [],
    };
    for (const token of ["owner", "emp_a", "emp_b"] as const) {
      for (const scope of await scopes(f, token)) {
        const listed = await f.refsOf(token, scope);
        for (const ref of hidden[token]) expect({ token, scope, listed: listed.includes(ref) }).toEqual({ token, scope, listed: false });
      }
      // Own only-me items are listed to their author.
      if (token !== "emp_b") expect(await f.refsOf(token, { mine: true })).toContain(token === "owner" ? f.refs.ownerOnlyNote : f.refs.empAOnlyNote);
      for (const ref of [...hidden[token], ...Object.values(guessed)]) {
        const response = await f.open(token, ref);
        expect({ ref, status: response.status, text: response.text }).toEqual({ ref, status: 404, text: NOT_FOUND_BODY });
      }
    }
    // N-8: a guess and an existing unreadable ref of each kind answer byte for byte alike.
    const unreadable = { note: f.refs.ownerOnlyNote, document: f.refs.ownerOnlyDocument, meeting: f.meeting("r2"), transcript: `transcript:${f.w.digest("r4")}` };
    for (const kind of ["note", "document", "meeting", "transcript"] as const) {
      expect((await f.open("emp_b", unreadable[kind])).text).toBe((await f.open("emp_b", guessed[kind])).text);
    }
    expect(f.pageAudits().filter((audit) => audit.operation === "person_open")).toHaveLength(0);
  });

  it("N-2: an item reachable only through a left project is gone in every scope, the reader's own included", async () => {
    const f = await disclosureWorld();
    const before = await f.listed("emp_a");
    expect(before.find((item) => item.ref === f.refs.empASharedNote)?.projects).toEqual([{ project_id: SHARED, name: PROJECT_NAMES[SHARED] }]);
    expect(before.map((item) => item.ref)).toEqual(expect.arrayContaining([f.refs.empASharedDocument, f.meeting("r4")]));
    // r6 went with PROJ_X, which EMP_A left after approving it.
    expect(before.map((item) => item.ref)).not.toContain(f.meeting("r6"));
    f.w.leave(SHARED, EMP_A);
    const gone = [f.refs.empASharedNote, f.refs.empASharedDocument, f.meeting("r4"), f.meeting("r3"), f.meeting("r6")];
    for (const scope of [{}, { mine: true }]) {
      const items = await f.listed("emp_a", scope);
      for (const ref of gone) expect(items.map((item) => item.ref)).not.toContain(ref);
      expect(items.find((item) => item.ref === f.refs.empATeamNote)).toMatchObject({ visibility: "team", projects: [] });
    }
    for (const ref of [...gone, `transcript:${f.w.digest("r4")}`]) expect(await f.open("emp_a", ref)).toEqual({ status: 404, text: NOT_FOUND_BODY });
    for (const project_id of [SHARED, PROJ_X]) expect(await f.list("emp_a", { project_id })).toEqual({ status: 401, text: UNAUTHORIZED_BODY });
    // Another member of SHARED still sees the association.
    expect((await f.listed("owner")).find((item) => item.ref === f.refs.empATeamNote)?.projects).toEqual([{ project_id: SHARED, name: PROJECT_NAMES[SHARED] }]);
  });

  it("N-3, N-4, N-10, N-17: no unjoined project, record coordinate, identity, request id or evidence quote leaves", async () => {
    const f = await disclosureWorld();
    for (const token of ["owner", "emp_a", "emp_b"] as const) {
      for (const scope of await scopes(f, token)) {
        for (const page of await f.walk(token, scope)) {
          if (page.next_cursor !== null) expect(JSON.stringify(decodePersonListCursorV1(page.next_cursor, { scope: page.scope, organization_id: COORDINATES.organization_id, membership_id: `mem_${token}` }))).not.toContain(UNJOINED);
        }
      }
      for (const item of await f.listed(token)) {
        const pages = await f.openAll(token, item.ref);
        const first = pages[0] as PersonOpenMeetingV1;
        if (first.transcript_ref !== undefined) await f.openAll(token, first.transcript_ref);
      }
    }
    for (const token of ["owner", "emp_a"] as const) {
      const multi = (await f.listed(token)).filter((item) => item.ref === f.refs.unjoinedNote || item.ref === f.refs.unjoinedDocument || item.ref === f.meeting("r3"));
      expect(multi).toHaveLength(3);
      for (const item of multi) expect(item).toMatchObject({ visibility: "project", projects: [{ project_id: SHARED, name: PROJECT_NAMES[SHARED] }] });
    }
    expect(f.bodies.length).toBeGreaterThan(50);
    const hiddenValues = [
      UNJOINED, PROJECT_NAMES[UNJOINED], PROJ_X, PROJECT_NAMES[PROJ_X], QUOTE, "mem_", "prn_", "apr_", "audit-apr", "source-apr", "revision-1",
      "U0APPROVERSUBJECT", ...f.requestIds,
    ];
    for (const body of f.bodies) {
      for (const value of hiddenValues) expect(body).not.toContain(value);
      expect(keys(JSON.parse(body)).filter((key) => FORBIDDEN_KEYS.has(key) || key.startsWith("predecessor"))).toEqual([]);
      // The only digests that leave are the record refs themselves.
      expect(body.replace(/"(?:meeting|transcript):sha256:[0-9a-f]{64}"/g, "\"\"")).not.toContain("sha256:");
    }
  });

  it("N-5, N-11: a cursor holds only emitted positions and is refused for another person, tenure, scope, ref or operation", async () => {
    const f = await disclosureWorld();
    const org = COORDINATES.organization_id;
    for (const token of ["owner", "emp_a"] as const) {
      const pages = await f.walk(token);
      expect(pages.length).toBeGreaterThan(1);
      const emitted = new Set<string>();
      for (const page of pages) {
        for (const item of page.items) emitted.add(item.ref);
        if (page.next_cursor === null) continue;
        const positions: PersonListPositionsV1 = decodePersonListCursorV1(page.next_cursor, { scope: page.scope, organization_id: org, membership_id: `mem_${token}` });
        for (const kind of ["note", "document", "meeting"] as const) {
          const position = positions[kind];
          if (position.state === "after") expect(emitted.has(`${kind}:${position.id}`)).toBe(true);
        }
      }
    }
    const ownerCursor = (await f.walk("owner"))[0]!.next_cursor!;
    const empACursor = (await f.walk("emp_a"))[0]!.next_cursor!;
    const refused = { status: 400, text: '{"error":{"code":"invalid_request","message":"request failed"}}' };
    expect(await f.list("emp_b", { cursor: ownerCursor })).toEqual(refused);
    expect(await f.list("returned", { cursor: empACursor })).toEqual(refused);
    expect((await f.list("emp_a", { cursor: empACursor })).status).toBe(200);
    // Minted cursors: a well-formed position under each scope, replayed under every other.
    const minted = [{ kind: "global" }, { kind: "mine" }, { kind: "project", project_id: SHARED }, { kind: "project", project_id: OWNER_B }] as const;
    const request = (scope: (typeof minted)[number]) => scope.kind === "global" ? {} : scope.kind === "mine" ? { mine: true } : { project_id: scope.project_id };
    for (const scope of minted) {
      const cursor = encodePersonListCursorV1({ scope, organization_id: org, membership_id: OWNER.membership_id }, { note: { state: "start" }, document: { state: "start" }, meeting: { state: "done" } });
      expect((await f.list("owner", { ...request(scope), cursor })).status).toBe(200);
      for (const other of minted.filter((candidate) => candidate !== scope)) expect(await f.list("owner", { ...request(other), cursor })).toEqual(refused);
    }
    const [documentPage] = await f.openAll("emp_b", f.refs.longDocument);
    expect(documentPage!.next_cursor).not.toBeNull();
    expect(await f.open("emp_b", f.refs.ownerOnlyDocument, documentPage!.next_cursor!)).toEqual(refused);
    expect(await f.open("owner", f.refs.longDocument, documentPage!.next_cursor!)).toEqual(refused);
    expect(await f.open("emp_b", f.refs.longDocument, ownerCursor)).toEqual(refused);
    expect(await f.list("emp_b", { cursor: documentPage!.next_cursor! })).toEqual(refused);
  });

  it("N-6, N-7: mine and every project are subsets of global, and mine is what the reader added or approved", async () => {
    const f = await disclosureWorld();
    for (const token of ["owner", "emp_a", "emp_b"] as const) {
      const global = await f.listed(token);
      const byRef = new Map(global.map((item) => [item.ref, item]));
      for (const scope of (await scopes(f, token)).slice(1)) {
        for (const item of await f.listed(token, scope)) expect(byRef.get(item.ref)).toEqual(item);
      }
    }
    const mine = async (token: Token) => (await f.refsOf(token, { mine: true })).filter((ref) => ref.startsWith("meeting:"));
    // r1 is team: EMP_A reads it, but only its approver EMP_B has it as mine.
    expect(await mine("emp_b")).toEqual([f.meeting("quoted"), f.meeting("r1")]);
    expect(await f.refsOf("emp_a")).toContain(f.meeting("r1"));
    expect(await mine("emp_a")).toEqual([f.meeting("r4")]);
    // r3 is SHARED and UNJOINED: EMP_A reads it, the owner approved it.
    expect(await mine("owner")).toEqual([f.meeting("r3"), f.meeting("r2")]);
    expect(await f.refsOf("emp_a")).toContain(f.meeting("r3"));
    expect(await mine("emp_c")).toEqual([]);
    const ownNotes = (await f.refsOf("emp_a", { mine: true })).filter((ref) => !ref.startsWith("meeting:"));
    expect(new Set(ownNotes)).toEqual(new Set([f.refs.empAOnlyNote, f.refs.empASharedNote, f.refs.empATeamNote, f.refs.empAOnlyDocument, f.refs.empASharedDocument]));
    // A new tenure of the same person starts with nothing of its own.
    expect(await f.refsOf("returned", { mine: true })).toEqual([]);
  });

  it("N-13: a transcript opens only by a shared, readable record; every other transcript ref is the same 404", async () => {
    const f = await disclosureWorld();
    const r4 = (await f.openAll("emp_a", f.meeting("r4")))[0] as PersonOpenMeetingV1;
    expect(r4.transcript_ref).toBe(`transcript:${f.w.digest("r4")}`);
    const pages = await f.openAll("emp_a", r4.transcript_ref!) as PersonOpenTranscriptV1[];
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.text).join("")).toBe(TRANSCRIPT);
    for (const name of ["r1", "quoted"]) expect((await f.openAll("emp_a", f.meeting(name)))[0]).not.toHaveProperty("transcript_ref");
    const misses = [
      ["emp_a", `transcript:${f.w.digest("r1")}`], ["emp_b", `transcript:${f.w.digest("r4")}`], ["emp_b", guessed.transcript],
      ["owner", `transcript:${f.w.digest("r2")}`], ["owner", guessed.transcript],
    ] as const;
    for (const [token, ref] of misses) expect(await f.open(token, ref)).toEqual({ status: 404, text: NOT_FOUND_BODY });
    // A faulting grant reader is reached only after Layer 1 admitted the record.
    f.grantReads.fault = true;
    f.grantReads.count = 0;
    expect(await f.open("emp_b", `transcript:${f.w.digest("r4")}`)).toEqual({ status: 404, text: NOT_FOUND_BODY });
    expect(await f.open("emp_b", guessed.transcript)).toEqual({ status: 404, text: NOT_FOUND_BODY });
    expect(f.grantReads.count).toBe(0);
    expect((await f.open("emp_a", `transcript:${f.w.digest("r4")}`)).status).toBe(500);
    expect(f.grantReads.count).toBe(1);
  });

  it("N-14: a session revoked or a grant changed after collect releases nothing and audits nothing", async () => {
    const f = await disclosureWorld();
    const audits = () => ({ pages: f.pageAudits().length, originals: f.originalAudits().length, meetings: f.w.audits("person_list").length });
    const quiet = audits();
    f.hooks.afterCollect = () => { f.w.session.revoked.add("emp_a"); };
    expect(await f.list("emp_a")).toEqual({ status: 401, text: UNAUTHORIZED_BODY });
    expect(audits()).toEqual(quiet);
    f.w.session.revoked.clear();
    f.hooks.afterCollect = () => { f.w.leave(SHARED, EMP_A); };
    expect(await f.list("emp_a")).toEqual({ status: 401, text: UNAUTHORIZED_BODY });
    expect(audits()).toEqual(quiet);
    f.hooks.afterCollect = undefined;
    const page = JSON.parse((await f.list("emp_a")).text) as PersonListResponseV1;
    expect(audits()).toEqual({ pages: quiet.pages + 1, originals: quiet.originals + 1, meetings: quiet.meetings + 1 });
    expect(f.pageAudits().at(-1)).toMatchObject({ operation: "person_list", scope_kind: "global", released_count: page.items.length, response_sha256: canonicalSha256(page as never) });
    expect((f.pageAudits().at(-1)!.store_receipts as Sha256Digest[])).toHaveLength(2);
  });

  it("N-19: a project the reader has not joined, or that does not exist, is one 401 before any store runs", async () => {
    const f = await disclosureWorld();
    for (const token of ["owner", "emp_a"] as const) {
      f.storeCalls.length = 0;
      for (const project_id of [UNJOINED, NONEXISTENT, PROJ_X]) expect(await f.list(token, { project_id })).toEqual({ status: 401, text: UNAUTHORIZED_BODY });
      expect(f.storeCalls).toEqual([]);
    }
    expect((await f.list("owner", { project_id: SHARED })).status).toBe(200);
    expect(f.storeCalls).toEqual(expect.arrayContaining(["collect", "collectMeetings"]));
  });

  it("N-16, N-17: Ask with mine cites only what the reader added or approved, every citation opens, and no Slack or transcript is read", async () => {
    const f = await disclosureWorld();
    await f.admitNotes();
    const approvers = new Map<string, { readonly principal_id: string; readonly membership_id: string }>([
      ...STANDARD_RECORDS.map((input) => [f.meeting(input.name), input.final_approver] as const), [f.meeting("quoted"), EMP_B],
    ]);
    const added = (ref: string) => (ref.startsWith("note:")
      ? f.w.authority.prepare("SELECT principal_id, membership_id FROM authority_person_updates_v2 WHERE context_id = ?").get(ref.slice("note:".length))
      : f.w.authority.prepare("SELECT principal_id, membership_id FROM authority_person_documents_v1 WHERE document_id = ?").get(ref.slice("document:".length))) as { readonly principal_id: string; readonly membership_id: string } | undefined;
    // Items each reader may read but did not add or approve: a teammate's team and project notes and meetings.
    const readers = [
      { token: "owner", actor: OWNER, teammates: [f.refs.empATeamNote, f.refs.empASharedNote, f.meeting("r1"), f.meeting("r4")] },
      { token: "emp_a", actor: EMP_A, teammates: [f.refs.empBTeamNote, f.refs.unjoinedNote, f.meeting("r1"), f.meeting("r3")] },
      { token: "emp_b", actor: EMP_B, teammates: [f.refs.empATeamNote, f.meeting("r7a")] },
    ] as const;
    for (const { token, actor, teammates } of readers) {
      const global = await f.refsOf(token);
      const mine = await f.refsOf(token, { mine: true });
      for (const ref of teammates) expect({ token, ref, global: global.includes(ref), mine: mine.includes(ref) }).toEqual({ token, ref, global: true, mine: false });
      const response = await f.ask(token, { mine: true });
      expect(response.status).toBe(200);
      const answer = validatePersonAnswerResponseV4(JSON.parse(response.text));
      expect(answer.scope).toEqual({ kind: "mine" });
      expect(answer.citations.length).toBeGreaterThan(0);
      const refs: string[] = answer.citations.map((citation) => citation.ref ?? "");
      // The model took every item the mine desk offered: exactly the reader's mine list, and nothing else.
      expect(new Set(refs)).toEqual(new Set(mine));
      for (const citation of answer.citations) {
        const ref = citation.ref!;
        expect(citation.citation.kind).not.toBe("slack_message");
        expect(ref).toMatch(/^(note|document|meeting):/);
        const owner = ref.startsWith("meeting:") ? approvers.get(ref) : added(ref);
        expect({ ref, principal_id: owner?.principal_id, membership_id: owner?.membership_id }).toEqual({ ref, principal_id: actor.principal_id, membership_id: actor.membership_id });
        expect({ ref, status: (await f.open(token, ref)).status }).toEqual({ ref, status: 200 });
      }
      for (const ref of teammates) expect({ token, ref, cited: refs.includes(ref) }).toEqual({ token, ref, cited: false });
    }
    // EMP_A may read r4's shared transcript globally; mine never reads it, nor any Slack.
    expect((await f.openAll("emp_a", `transcript:${f.w.digest("r4")}`)).length).toBeGreaterThan(0);
    expect(f.slackAskers).toEqual([]);
    for (const token of ["owner", "emp_a"] as const) {
      expect(await f.ask(token, { mine: true, project_id: SHARED })).toEqual({ status: 400, text: '{"error":{"code":"invalid_request","message":"request failed"}}' });
    }
    for (const body of f.bodies) expect(body).not.toContain(QUOTE);
  });
});
