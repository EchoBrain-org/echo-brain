import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_LIST_HEADER_PROJECTS_MAX_V1,
  PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1,
  PERSON_LIST_PAGE_SIZE_V1,
  PERSON_LIST_TEXT_MAX_BYTES_V1,
  personRefIdV1,
  personRefKindV1,
  validatePersonListResponseV1,
  validatePersonOpenResponseV1,
  type OrganizationPersonToolV3,
  type PersonAnswerScopeV3,
  type PersonListProjectV1,
  type PersonListRequestV1,
  type PersonListResponseV1,
  type PersonListRowV1,
  type PersonListVisibilityV1,
  type PersonOpenRefV1,
  type PersonOpenResponseV1,
} from "@echo-brain/organization-api";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  PersonItemPositionV1,
  PersonListDirectoryPortV1,
  PersonMeetingItemsPortV1,
  PersonOriginalItemsPortV1,
  PersonStoreDocumentRowV1,
  PersonStoreMeetingRowV1,
  PersonStoreNoteRowV1,
  PersonStoreReleaseV1,
  PersonStoreVisibilityV1,
  PersonTranscriptByRecordPortV1,
} from "../application/ports/person-list-v1.js";
import type { PersonListHttpApplicationV1 } from "../presentation/person-list-http-application-v1.js";
import { boundedTextV1 } from "./person-item-text-v1.js";
import {
  PERSON_LIST_START_V1,
  decodePersonListCursorV1,
  decodePersonOpenCursorV1,
  encodePersonListCursorV1,
  encodePersonOpenCursorV1,
  type PersonListPositionsV1,
  type PersonListSourcePositionV1,
  type PersonListSourceV1,
  type PersonOpenCursorBindingV1,
  type PersonOpenPositionV1,
} from "./person-list-cursor-v1.js";

/** One page of 25 plus the row that proves another page exists. */
const COLLECT_LIMIT = PERSON_LIST_PAGE_SIZE_V1 + 1;
const SOURCES = ["note", "document", "meeting"] as const satisfies readonly PersonListSourceV1[];
const IDS: Readonly<Record<PersonListSourceV1, RegExp>> = {
  note: /^ctx_[0-9a-f]{64}$/,
  document: /^doc_[0-9a-f]{64}$/,
  meeting: /^sha256:[0-9a-f]{64}$/,
};
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DONE: PersonListSourcePositionV1 = Object.freeze({ state: "done" });

type StoreRow = PersonStoreNoteRowV1 | PersonStoreDocumentRowV1 | PersonStoreMeetingRowV1;
type Ordered = { readonly kind: PersonListSourceV1; readonly id: string; readonly added_at: string };
type Joined = ReturnType<PersonListDirectoryPortV1["joinedProjects"]>;
type Opened =
  | Extract<ReturnType<PersonOriginalItemsPortV1["open"]>, { readonly kind: "note" }>
  | Extract<ReturnType<PersonOriginalItemsPortV1["open"]>, { readonly kind: "document" }>
  | (ReturnType<PersonMeetingItemsPortV1["openMeeting"]> & { readonly kind: "meeting" })
  | (ReturnType<PersonTranscriptByRecordPortV1["readApprovedMeetingTranscriptByRecordV1"]> & { readonly kind: "transcript" });

export interface CreatePersonListRouteV1Options {
  readonly organization_id: string;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  /** The caller's connected tools; only each tool id and status leave. */
  readonly tools: (access_token: string) => Promise<readonly OrganizationPersonToolV3[]>;
  readonly directory: PersonListDirectoryPortV1;
  readonly originals: PersonOriginalItemsPortV1;
  readonly meetings: PersonMeetingItemsPortV1;
  readonly transcripts: PersonTranscriptByRecordPortV1;
}

function denied(): never {
  throw new AuthorityOperationError("unauthorized", "person authentication failed");
}
function invalidRequest(): never {
  throw new AuthorityOperationError("invalid_request", "request failed");
}
function notFound(): never {
  throw new AuthorityOperationError("not_found", "item is not available");
}
function invalidOutput(): never {
  throw new AuthorityOperationError("invalid_output", "request failed");
}
function unavailable(): never {
  throw new AuthorityOperationError("unavailable", "person list is unavailable");
}
function unknownScope(scope: never): never {
  throw new AuthorityOperationError("invalid_request", `scope ${String((scope as { readonly kind?: unknown }).kind)} is invalid`);
}

function scopeOf(request: PersonListRequestV1): PersonAnswerScopeV3 {
  if (request.project_id !== undefined && request.mine !== undefined) invalidRequest();
  if (request.project_id !== undefined) return Object.freeze({ kind: "project", project_id: request.project_id });
  return request.mine === true ? Object.freeze({ kind: "mine" }) : Object.freeze({ kind: "global" });
}

/** The session fields a fence compares; checked_at alone may move. */
function sameAuthorization(left: PersonAccessAuthorization, right: PersonAccessAuthorization): boolean {
  return left.organization_id === right.organization_id && left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id && left.membership_type === right.membership_type &&
    left.identity_binding_id === right.identity_binding_id && left.session_family_id === right.session_family_id &&
    left.access_credential_sha256 === right.access_credential_sha256 && left.person_state_sha256 === right.person_state_sha256 &&
    left.session_state_sha256 === right.session_state_sha256;
}

/** One vs several audience projects, and approver vs uploader, are never released. */
function collapse(visibility: PersonStoreVisibilityV1): PersonListVisibilityV1 {
  switch (visibility) {
    case "only_me":
    case "approver_only":
      return "only_me";
    case "team":
      return "team";
    case "project":
    case "projects":
      return "project";
    default:
      return invalidOutput();
  }
}

function title(row: StoreRow): string {
  return boundedTextV1(row.title, PERSON_LIST_TEXT_MAX_BYTES_V1) ?? (row.kind === "meeting" ? "Approved meeting" : "Untitled");
}

/** The only place a row is shaped: projects are the caller's joined snapshot, in its order, with its names. */
function projectRow(row: StoreRow, joined: Joined): PersonListRowV1 {
  const associated = new Set<string>(row.association_project_ids);
  const base = {
    title: title(row), added_at: row.added_at, visibility: collapse(row.visibility),
    projects: joined.projects.filter((project) => associated.has(project.project_id)).map(({ project_id, name }) => ({ project_id, name })),
  };
  switch (row.kind) {
    case "note":
      return { ref: `note:${row.id}`, kind: "note", ...base };
    case "document":
      return { ref: `document:${row.id}`, kind: "document", ...base, media_type: row.media_type, extraction_state: row.extraction_state, size_bytes: row.size_bytes };
    case "meeting":
      return { ref: `meeting:${row.id}`, kind: "meeting", ...base, ...(row.meeting_date === undefined ? {} : { meeting_date: row.meeting_date }) };
  }
}

function headerProject({ project_id, name, role, status }: PersonListProjectV1): PersonListProjectV1 {
  return { project_id, name, role, status };
}

/** added_at DESC, then `${kind}:${id}` ASC; every ref starts with its kind. */
function compareRows(left: Ordered, right: Ordered): number {
  if (left.added_at !== right.added_at) return left.added_at > right.added_at ? -1 : 1;
  const leftRef = `${left.kind}:${left.id}`;
  const rightRef = `${right.kind}:${right.id}`;
  return leftRef < rightRef ? -1 : leftRef > rightRef ? 1 : 0;
}

function canonicalTime(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_TIME.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** A store page must be its own kind, strictly ordered, strictly after the cursor, and inside the scope. */
function assertSource(kind: PersonListSourceV1, rows: readonly StoreRow[], after: PersonListSourcePositionV1, scope: PersonAnswerScopeV3): void {
  if (rows.length > COLLECT_LIMIT) invalidOutput();
  let previous: Ordered | undefined = after.state === "after" ? { kind, id: after.id, added_at: after.added_at } : undefined;
  for (const row of rows) {
    if (row.kind !== kind || !IDS[kind].test(row.id) || !canonicalTime(row.added_at)) invalidOutput();
    if (previous !== undefined && compareRows(previous, row) >= 0) invalidOutput();
    if (scope.kind === "project" && !row.association_project_ids.includes(scope.project_id)) invalidOutput();
    previous = row;
  }
}

function storePosition(position: PersonListSourcePositionV1): PersonItemPositionV1 | null {
  return position.state === "after" ? Object.freeze({ added_at: position.added_at, id: position.id }) : null;
}

/** A source is done only when it returned fewer than it was asked for and all of it left. */
function advance(previous: PersonListSourcePositionV1, fetched: readonly StoreRow[] | undefined, emitted: readonly StoreRow[]): PersonListSourcePositionV1 {
  if (fetched === undefined) return previous;
  if (emitted.length === fetched.length && fetched.length < COLLECT_LIMIT) return DONE;
  const last = emitted.at(-1);
  return last === undefined ? previous : Object.freeze({ state: "after", added_at: last.added_at, id: last.id });
}

/** A store's stale access state is lost access here; the HTTP map would otherwise call it a bad request. */
function accessChanged(error: unknown): unknown {
  return error instanceof AuthorityOperationError && error.code === "stale_access_state"
    ? new AuthorityOperationError("unauthorized", "person authentication failed")
    : error;
}

function receipts(...releases: readonly (PersonStoreReleaseV1 | undefined)[]): Sha256Digest[] {
  return releases.flatMap((release) => release?.receipt === undefined ? [] : [release.receipt]);
}

/**
 * The person list and open by ref (ADR-0024). Each call is a fresh
 * authenticated read: stores collect unaudited, the route merges and shapes,
 * each store audits only what left, and the session, grants and project names
 * are revalidated before the page audit and the response. No model is called.
 */
export function createPersonListRouteV1(options: CreatePersonListRouteV1Options): PersonListHttpApplicationV1 {
  const authenticate = (access_token: string): PersonAccessAuthorization => {
    const actor = options.sessions.authenticateAccess({ access_token });
    if (actor.organization_id !== options.organization_id) denied();
    return actor;
  };

  async function listPage(access_token: string, request: PersonListRequestV1, actor: PersonAccessAuthorization, signal: AbortSignal | undefined): Promise<PersonListResponseV1> {
    const scope = scopeOf(request);
    const binding = { scope, organization_id: actor.organization_id, membership_id: actor.membership_id };
    const positions = request.cursor === undefined ? PERSON_LIST_START_V1 : decodePersonListCursorV1(request.cursor, binding);
    const joined = options.directory.joinedProjects(actor);
    const project = scope.kind === "project" ? joined.projects.find((candidate) => candidate.project_id === scope.project_id) : undefined;
    // The same denial as Ask with this project, before any store or tool runs.
    if (scope.kind === "project" && project === undefined) denied();
    let header: Pick<PersonListResponseV1, "me" | "connected" | "projects" | "projects_more" | "project"> = {};
    if (request.cursor === undefined) {
      switch (scope.kind) {
        case "global": {
          const me = options.directory.me(actor);
          if (me === undefined) denied();
          const tools = await options.tools(access_token);
          header = {
            me: { display_name: boundedTextV1(me.display_name, PERSON_LIST_TEXT_MAX_BYTES_V1) ?? invalidOutput(), membership_type: actor.membership_type },
            connected: tools.map((tool) => ({ tool: tool.tool_id, status: tool.personal_status })),
            projects: joined.projects.slice(0, PERSON_LIST_HEADER_PROJECTS_MAX_V1).map(headerProject),
            projects_more: joined.projects.length > PERSON_LIST_HEADER_PROJECTS_MAX_V1,
          };
          break;
        }
        case "project":
          header = { project: headerProject(project!) };
          break;
        case "mine":
          break;
        default:
          unknownScope(scope);
      }
      signal?.throwIfAborted();
    }

    // Synchronous from here: collect, merge, shape, commit, revalidate, audit.
    const originals = positions.note.state === "done" && positions.document.state === "done" ? undefined : options.originals.collect({
      access_token, scope, limit: COLLECT_LIMIT,
      ...(positions.note.state === "done" ? {} : { notes: { after: storePosition(positions.note) } }),
      ...(positions.document.state === "done" ? {} : { documents: { after: storePosition(positions.document) } }),
    });
    const meetings = positions.meeting.state === "done" ? undefined
      : options.meetings.collectMeetings({ access_token, scope, after: storePosition(positions.meeting), limit: COLLECT_LIMIT });
    const held = meetings?.status === "held";
    const fetched: Readonly<Record<PersonListSourceV1, readonly StoreRow[] | undefined>> = {
      note: positions.note.state === "done" ? undefined : originals!.notes,
      document: positions.document.state === "done" ? undefined : originals!.documents,
      meeting: meetings?.status === "ok" ? meetings.rows : undefined,
    };
    for (const source of SOURCES) if (fetched[source] !== undefined) assertSource(source, fetched[source], positions[source], scope);
    const emitted = SOURCES.flatMap((source) => fetched[source] ?? []).sort(compareRows).slice(0, PERSON_LIST_PAGE_SIZE_V1);
    // A later page that can only wait for meetings would hand back its own cursor forever.
    if (request.cursor !== undefined && held && emitted.length === 0) unavailable();
    const of = (source: PersonListSourceV1): readonly StoreRow[] => emitted.filter((row) => row.kind === source);
    const next: PersonListPositionsV1 = Object.freeze({
      note: advance(positions.note, fetched.note, of("note")),
      document: advance(positions.document, fetched.document, of("document")),
      meeting: advance(positions.meeting, fetched.meeting, of("meeting")),
    });

    let response: PersonListResponseV1;
    try {
      response = validatePersonListResponseV1({
        schema_version: 1, kind: "echo-person-list-v1", scope, ...header,
        items: emitted.map((row) => projectRow(row, joined)),
        next_cursor: SOURCES.every((source) => next[source].state === "done") ? null : encodePersonListCursorV1(binding, next),
        ...(held ? { notice: PERSON_LIST_NOTICE_MEETINGS_UNAVAILABLE_V1 } : {}),
      });
    } catch {
      invalidOutput();
    }

    const originalsRelease = originals === undefined ? undefined
      : options.originals.commit({ access_token, handle: originals.handle, notes: of("note").length, documents: of("document").length });
    const meetingsRelease = meetings?.status === "ok"
      ? options.meetings.commitMeetings({ access_token, handle: meetings.handle, count: of("meeting").length })
      : undefined;
    if (originalsRelease !== undefined) options.originals.revalidate({ access_token, release: originalsRelease });
    if (meetingsRelease !== undefined) options.meetings.revalidateMeetingRelease({ access_token, release: meetingsRelease });
    const current = authenticate(access_token);
    if (!sameAuthorization(actor, current)) denied();
    const now = options.directory.joinedProjects(current);
    if (now.grants_sha256 !== joined.grants_sha256) denied();
    // Only a name, role or status moved: retryable, and not lost access.
    if (now.names_sha256 !== joined.names_sha256) unavailable();
    signal?.throwIfAborted();
    options.directory.audit({
      operation: "person_list", scope_kind: scope.kind, actor: current, response_sha256: canonicalSha256(response),
      released_count: response.items.length, store_receipts: receipts(originalsRelease, meetingsRelease),
    });
    return response;
  }

  function openStore(access_token: string, ref: PersonOpenRefV1, position: PersonOpenPositionV1 | undefined): Opened {
    const kind = personRefKindV1(ref);
    const id = personRefIdV1(ref);
    switch (kind) {
      case "note":
      case "document": {
        const opened = options.originals.open({
          access_token,
          ref: kind === "note" ? { kind, id: id as `ctx_${string}` } : { kind, id: id as `doc_${string}` },
          ...(position?.kind === "document" ? { from_ordinal: position.from_ordinal } : {}),
        });
        if (opened.kind !== kind) invalidOutput();
        return opened;
      }
      case "meeting":
        return {
          kind, ...options.meetings.openMeeting({
            access_token, record_sha256: id as `sha256:${string}`,
            ...(position?.kind === "meeting" ? { from: { atom_order: position.atom_order, part: position.part } } : {}),
          }),
        };
      case "transcript":
        // Layer 1 admission first: a transcript is never reached through a record the caller cannot read.
        options.meetings.admitMeeting({ access_token, record_sha256: id as `sha256:${string}` });
        return {
          kind, ...options.transcripts.readApprovedMeetingTranscriptByRecordV1({
            access_token, record_sha256: id as `sha256:${string}`,
            ...(position?.kind === "transcript" ? { offset: position.offset } : {}),
          }),
        };
    }
  }

  function openResponse(opened: Opened, ref: PersonOpenRefV1, binding: PersonOpenCursorBindingV1, joined: Joined): unknown {
    const base = { schema_version: 1, kind: "echo-person-open-v1", ref };
    switch (opened.kind) {
      case "note":
        return { ...base, item: projectRow(opened.row, joined), text: opened.text, next_cursor: null };
      case "document":
        return {
          ...base, item: projectRow(opened.row, joined), filename: opened.filename,
          chunks: opened.chunks.map((chunk) => ({ anchor: { kind: chunk.anchor_kind, start: chunk.anchor_start }, text: chunk.text })),
          next_cursor: opened.next_ordinal === null ? null : encodePersonOpenCursorV1(binding, { kind: "document", from_ordinal: opened.next_ordinal }),
        };
      case "meeting":
        return {
          ...base, item: projectRow(opened.row, joined), ...(opened.meeting === undefined ? {} : { meeting: opened.meeting }), atoms: opened.atoms,
          ...(opened.transcript_shared === true ? { transcript_ref: `transcript:${personRefIdV1(ref)}` } : {}),
          next_cursor: opened.next === null ? null : encodePersonOpenCursorV1(binding, { kind: "meeting", atom_order: opened.next.atom_order, part: opened.next.part }),
        };
      case "transcript":
        return {
          ...base, text: opened.text,
          next_cursor: opened.next_offset === null ? null : encodePersonOpenCursorV1(binding, { kind: "transcript", offset: opened.next_offset }),
        };
    }
  }

  return Object.freeze({
    async list(input: Parameters<PersonListHttpApplicationV1["list"]>[0]): Promise<PersonListResponseV1> {
      input.signal?.throwIfAborted();
      const actor = authenticate(input.access_token);
      try {
        return await listPage(input.access_token, input.request, actor, input.signal);
      } catch (error) {
        throw accessChanged(error);
      }
    },

    async open(input: Parameters<PersonListHttpApplicationV1["open"]>[0]): Promise<PersonOpenResponseV1> {
      input.signal?.throwIfAborted();
      const { access_token } = input;
      const actor = authenticate(access_token);
      const ref = input.request.ref;
      try {
        personRefKindV1(ref);
      } catch {
        invalidRequest();
      }
      const binding: PersonOpenCursorBindingV1 = { ref, organization_id: actor.organization_id, membership_id: actor.membership_id };
      const position = input.request.cursor === undefined ? undefined : decodePersonOpenCursorV1(input.request.cursor, binding);
      const joined = options.directory.joinedProjects(actor);
      let opened: Opened;
      try {
        opened = openStore(access_token, ref, position);
      } catch (error) {
        // Unknown, unreadable, left, pending, unshared and out-of-range are one answer.
        // A non-Authority error can only follow admission of a readable item.
        if (error instanceof AuthorityOperationError && error.code !== "unavailable") notFound();
        throw error;
      }
      let response: PersonOpenResponseV1;
      try {
        response = validatePersonOpenResponseV1(openResponse(opened, ref, binding, joined));
      } catch {
        invalidOutput();
      }
      let current: PersonAccessAuthorization;
      try {
        if (opened.kind === "note" || opened.kind === "document") options.originals.revalidate({ access_token, release: opened.release });
        if (opened.kind === "meeting") options.meetings.revalidateMeetingRelease({ access_token, release: opened.release });
        current = authenticate(access_token);
        if (!sameAuthorization(actor, current) || options.directory.joinedProjects(current).grants_sha256 !== joined.grants_sha256) notFound();
      } catch (error) {
        if (error instanceof AuthorityOperationError) notFound();
        throw error;
      }
      input.signal?.throwIfAborted();
      options.directory.audit({
        operation: "person_open", scope_kind: "item", actor: current, response_sha256: canonicalSha256(response),
        released_count: 1, store_receipts: receipts(opened.kind === "transcript" ? undefined : opened.release),
      });
      return response;
    },
  });
}
