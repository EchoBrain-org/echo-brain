import { SqlitePersonImportedMeetingsV1 } from './person-imported-meetings-v1.js';
import { releasableBodyV1 } from '../../../application/person-item-text-v1.js';
import { randomUUID } from "node:crypto";
import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES,
  validatePersonDocumentIdV1,
  validatePersonUploadContextId,
  type PersonDocumentExtractionStateV1,
  type PersonDocumentMediaTypeV1,
  type ProjectIdV1,
} from "@echo-brain/organization-api";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type Database from "better-sqlite3";
import type {
  PersonItemPositionV1,
  PersonOriginalItemsPortV1,
  PersonStoreDocumentRowV1,
  PersonStoreHandleV1,
  PersonStoreNoteRowV1,
  PersonStoreReleaseV1,
} from "../../../application/ports/person-list-v1.js";
import type { PersonAskScopeV2 } from "../../../application/ports/person-original-context-retrieval-v1.js";
import {
  PERSON_ORIGINAL_NOTE_CUSTODY_V1,
  personOriginalAclV1,
  personOriginalGrantedProjectIdsV1,
  personOriginalScopeFilterV1,
  personUnknownScopeV1,
} from "./person-original-access-v1.js";
import { assertPersonTextCustodyV1, type PersonTextCustodyRowV1 } from "./person-text-source-v1.js";
import { isCanonicalUtcMillisTimestampV1 } from "../../../application/canonical-utc-timestamp-v1.js";

/** One page of 25 plus the row that proves another page exists. */
const MAXIMUM_COLLECT = 26;
/** read-v2's text page bounds (document-v1.ts), so open never releases more than documents already do. */
const MAXIMUM_OPEN_CHUNKS = 8;
const MAXIMUM_OPEN_TEXT_BYTES = 8_192;
const MAXIMUM_OPEN_CANONICAL_BYTES = 20 * 1024;
const MAXIMUM_ORDINAL = 65_535;
const NOTE_ID = /^(?:ctx|cap)_[0-9a-f]{64}$/;
const DOCUMENT_ID = /^doc_[0-9a-f]{64}$/;
const GLOBAL: PersonAskScopeV2 = Object.freeze({ kind: "global" });
const NOT_QUARANTINED = "NOT EXISTS (SELECT 1 FROM authority_person_text_source_failures_v1 f WHERE f.organization_id=u.organization_id AND f.api_version=u.api_version AND f.context_id=u.context_id)";

type DocumentCustodyRow = {
  readonly document_id: string;
  readonly title: string;
  readonly filename: string;
  readonly received_at: string;
  readonly audience_kind: "only_me" | "team" | "project" | "projects";
  readonly detected_media_type: PersonDocumentMediaTypeV1;
  readonly original_size: number;
  readonly extraction_state: PersonDocumentExtractionStateV1;
};
type TextChunkRow = { readonly ordinal: number; readonly anchor_kind: "page" | "paragraph"; readonly anchor_start: number; readonly text: string };
type Grants = { readonly ids: readonly string[]; readonly sha256: Sha256Digest };
/** Which rows, beyond the ACL and scope: a keyset page, or exact ids. */
type Selection = { readonly after: PersonItemPositionV1 | null; readonly limit: number } | { readonly ids: readonly string[] };
type Witness = {
  readonly tuple: string;
  readonly scope: PersonAskScopeV2;
  readonly grants_sha256: Sha256Digest;
  readonly notes: readonly PersonStoreNoteRowV1[];
  readonly documents: readonly PersonStoreDocumentRowV1[];
};

interface Sessions {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}

/** Ask's originals adapter answers a scope denial exactly like this; the list must not differ. */
function denied(): never {
  throw new AuthorityOperationError("unauthorized", "person authentication failed");
}
function invalid(): never {
  throw new AuthorityOperationError("invalid_request", "request failed");
}
function notFound(): never {
  throw new AuthorityOperationError("not_found", "request failed");
}
function stale(): never {
  throw new AuthorityOperationError("stale_access_state", "request failed");
}
function unavailable(): never {
  throw new AuthorityOperationError("unavailable", "person items are unavailable");
}

function position(value: PersonItemPositionV1 | null | undefined, id: RegExp): PersonItemPositionV1 | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || !isCanonicalUtcMillisTimestampV1(value.added_at) || typeof value.id !== "string" || !id.test(value.id)) invalid();
  return Object.freeze({ added_at: value.added_at, id: value.id });
}

/** The session fields a fence compares; checked_at alone may move. */
function tuple(actor: PersonAccessAuthorization): string {
  return canonicalJson({
    organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id,
    membership_type: actor.membership_type, identity_binding_id: actor.identity_binding_id, session_family_id: actor.session_family_id,
    access_credential_sha256: actor.access_credential_sha256, person_state_sha256: actor.person_state_sha256, session_state_sha256: actor.session_state_sha256,
  });
}

function marks(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function count(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/**
 * Notes (every version) and documents (every extraction state) for the person
 * list and open (ADR-0024), read from custody under Ask's exact ACL. Custody
 * rows are listed before Ask can find them; nothing here reads a source
 * revision or a meeting.
 */
export class SqlitePersonOriginalItemsV1 implements PersonOriginalItemsPortV1 {
  private readonly imported: SqlitePersonImportedMeetingsV1;
  private readonly collected = new WeakMap<PersonStoreHandleV1, Witness & { consumed: boolean }>();
  private readonly released = new WeakMap<PersonStoreReleaseV1, Witness>();

  constructor(
    private readonly database: Database.Database,
    private readonly sessions: Sessions,
    private readonly organizationId: string,
  ) {
    this.imported = new SqlitePersonImportedMeetingsV1(database);
    if (database.pragma("user_version", { simple: true }) !== 12 || database.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("Person items require Authority V12 with foreign keys enabled");
    }
  }

  collect(input: Parameters<PersonOriginalItemsPortV1["collect"]>[0]): ReturnType<PersonOriginalItemsPortV1["collect"]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_COLLECT) invalid();
    const notesAfter = input.notes === undefined ? undefined : position(input.notes.after, NOTE_ID);
    const documentsAfter = input.documents === undefined ? undefined : position(input.documents.after, DOCUMENT_ID);
    const actor = this.authenticate(input.access_token);
    const grants = this.grants(actor);
    this.assertScope(input.scope, grants);
    const notes = notesAfter === undefined ? [] : this.notes(actor, input.scope, grants, { after: notesAfter, limit: input.limit }).map(({ row }) => row);
    const documents = documentsAfter === undefined ? [] : this.documents(actor, input.scope, grants, { after: documentsAfter, limit: input.limit }).map(({ row }) => row);
    const handle: PersonStoreHandleV1 = Object.freeze({});
    this.collected.set(handle, { tuple: tuple(actor), scope: Object.freeze({ ...input.scope }), grants_sha256: grants.sha256, notes, documents, consumed: false });
    return Object.freeze({ notes: Object.freeze(notes), documents: Object.freeze(documents), handle });
  }

  commit(input: Parameters<PersonOriginalItemsPortV1["commit"]>[0]): PersonStoreReleaseV1 {
    const collected = this.collected.get(input.handle);
    if (collected === undefined || collected.consumed) unavailable();
    if (!count(input.notes, collected.notes.length) || !count(input.documents, collected.documents.length)) invalid();
    collected.consumed = true;
    const actor = this.fence(input.access_token, collected.tuple, collected.grants_sha256);
    const witness: Witness = Object.freeze({
      tuple: collected.tuple, scope: collected.scope, grants_sha256: collected.grants_sha256,
      notes: Object.freeze(collected.notes.slice(0, input.notes)), documents: Object.freeze(collected.documents.slice(0, input.documents)),
    });
    const rows = [...witness.notes, ...witness.documents];
    // A page that emits no originals writes no audit row, so it has no receipt.
    const release: PersonStoreReleaseV1 = Object.freeze(rows.length === 0 ? {} : {
      receipt: this.audit(actor, { operation: "person_list", scope: witness.scope, grants_sha256: witness.grants_sha256, released_items_sha256: canonicalSha256(rows), released_count: rows.length }),
    });
    this.released.set(release, witness);
    return release;
  }

  open(input: Parameters<PersonOriginalItemsPortV1["open"]>[0]): ReturnType<PersonOriginalItemsPortV1["open"]> {
    const kind = input.ref.kind;
    let id: string;
    try {
      id = kind === "imported_meeting" ? (/^cap_[a-f0-9]{64}$/.test(input.ref.id) ? input.ref.id : notFound()) : kind === "note" ? validatePersonUploadContextId(input.ref.id) : kind === "document" ? validatePersonDocumentIdV1(input.ref.id) : notFound();
    } catch { notFound(); }
    const actor = this.authenticate(input.access_token);
    const grants = this.grants(actor);
    if (kind === "note" || kind === "imported_meeting") {
      if (kind === "note" && input.from_ordinal !== undefined) invalid();
      const found = this.notes(actor, GLOBAL, grants, { ids: [id] })[0];
      if (found === undefined || found.row.kind !== kind) notFound();
      const current = this.fence(input.access_token, tuple(actor), grants.sha256);
      if (kind === 'imported_meeting') {
        const offset = input.from_ordinal ?? 0, body = releasableBodyV1(found.text);
        if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= body.length)) notFound();
        let text = '', bytes = 0;
        for (const scalar of body.slice(offset)) { const size = Buffer.byteLength(scalar); if (bytes + size > 8192) break; text += scalar; bytes += size; }
        const release = this.openRelease(current, grants, { notes: [found.row], documents: [] }, {
          ref: `${kind}:${id}`, from_offset: offset, released_text_sha256: canonicalSha256(text),
        });
        return { kind, row: found.row, text, next_offset: offset + text.length < body.length ? offset + text.length : null, release };
      }
      const release = this.openRelease(current, grants, { notes: [found.row], documents: [] }, {
        ref: `note:${id}`, released_text_sha256: canonicalSha256(found.text),
      });
      return Object.freeze({ kind, row: found.row, text: found.text, release });
    }
    const from = input.from_ordinal ?? 0;
    if (!Number.isSafeInteger(from) || from < 0 || from > MAXIMUM_ORDINAL) invalid();
    const found = this.documents(actor, GLOBAL, grants, { ids: [id] })[0];
    if (found === undefined) notFound();
    // Mirrors the V2 document text route exactly: at most 8 chunks, 8 KiB raw and 20 KiB canonical per page.
    const candidates = this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text FROM authority_person_document_text_v1 WHERE document_id=? AND ordinal>=? ORDER BY ordinal LIMIT 9").all(id, from) as TextChunkRow[];
    const chunks: TextChunkRow[] = [];
    let total = 0;
    for (const chunk of candidates) {
      const size = Buffer.byteLength(chunk.text);
      if (size > PERSON_DOCUMENT_TEXT_CHUNK_MAX_BYTES) throw new AuthorityOperationError("invalid_output", "request failed");
      if (chunks.length >= MAXIMUM_OPEN_CHUNKS || total + size > MAXIMUM_OPEN_TEXT_BYTES || Buffer.byteLength(canonicalJson([...chunks, chunk])) > MAXIMUM_OPEN_CANONICAL_BYTES) break;
      chunks.push(chunk);
      total += size;
    }
    // A later page past the last chunk is indistinguishable from a guess.
    if (from > 0 && chunks.length === 0) notFound();
    const next_ordinal = candidates.length > chunks.length ? chunks.at(-1)!.ordinal + 1 : null;
    const released = Object.freeze(chunks.map(({ anchor_kind, anchor_start, text }) => Object.freeze({ anchor_kind, anchor_start, text })));
    const current = this.fence(input.access_token, tuple(actor), grants.sha256);
    const release = this.openRelease(current, grants, { notes: [], documents: [found.row] }, {
      ref: `document:${id}`, from_ordinal: from, next_ordinal, released_text_sha256: canonicalSha256(released),
    });
    return Object.freeze({ kind: "document" as const, row: found.row, filename: found.filename, chunks: released, next_ordinal, release });
  }

  revalidate(input: { readonly access_token: string; readonly release: PersonStoreReleaseV1 }): void {
    const witness = this.released.get(input.release);
    if (witness === undefined) unavailable();
    const actor = this.authenticate(input.access_token);
    if (tuple(actor) !== witness.tuple) denied();
    // The org-wide authorization revision bumps on every note insert, so it is
    // deliberately not pinned: only this caller's grants and released rows are.
    const grants = this.grants(actor);
    const notes = witness.notes.length === 0 ? [] : this.notes(actor, witness.scope, grants, { ids: witness.notes.map((row) => row.id) }).map(({ row }) => row);
    const documents = witness.documents.length === 0 ? [] : this.documents(actor, witness.scope, grants, { ids: witness.documents.map((row) => row.id) }).map(({ row }) => row);
    if (grants.sha256 !== witness.grants_sha256 ||
      canonicalJson({ notes, documents }) !== canonicalJson({ notes: witness.notes, documents: witness.documents })) stale();
  }

  private authenticate(accessToken: string): PersonAccessAuthorization {
    const actor = this.sessions.authenticateAccess({ access_token: accessToken });
    if (actor.organization_id !== this.organizationId ||
      !this.database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type)) denied();
    return actor;
  }

  /** One grants snapshot per call: the ACL, association filtering and the fence all read it. */
  private grants(actor: PersonAccessAuthorization): Grants {
    const ids = Object.freeze([...personOriginalGrantedProjectIdsV1(this.database, actor)].sort());
    return Object.freeze({ ids, sha256: canonicalSha256(ids) });
  }

  private assertScope(scope: PersonAskScopeV2, grants: Grants): void {
    switch (scope.kind) {
      case "project":
        if (!grants.ids.includes(scope.project_id)) denied();
        return;
      case "global":
      case "mine":
        return;
      default:
        personUnknownScopeV1(scope);
    }
  }

  /** Same session and same grants as when the rows were read, or nothing is released. */
  private fence(accessToken: string, expected: string, grantsSha256: Sha256Digest): PersonAccessAuthorization {
    const actor = this.authenticate(accessToken);
    if (tuple(actor) !== expected || this.grants(actor).sha256 !== grantsSha256) denied();
    return actor;
  }

  private notes(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, grants: Grants, selection: Selection): readonly { readonly row: PersonStoreNoteRowV1; readonly text: string }[] {
    const acl = personOriginalAclV1("u", actor, grants.ids);
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    const tail = "ids" in selection
      ? { sql: `AND u.context_id IN (${marks(selection.ids)}) ORDER BY u.received_at DESC,u.context_id ASC`, args: selection.ids }
      : selection.after === null
        ? { sql: "ORDER BY u.received_at DESC,u.context_id ASC LIMIT ?", args: [selection.limit] }
        : { sql: "AND (u.received_at < ? OR (u.received_at = ? AND u.context_id > ?)) ORDER BY u.received_at DESC,u.context_id ASC LIMIT ?", args: [selection.after.added_at, selection.after.added_at, selection.after.id, selection.limit] };
    const rows = this.database.prepare(`SELECT u.* FROM ${PERSON_ORIGINAL_NOTE_CUSTODY_V1} u
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql} AND ${NOT_QUARANTINED} ${tail.sql}`)
      .all(actor.organization_id, ...acl.args, ...scoped.args, ...tail.args) as PersonTextCustodyRowV1[];
    for (const row of rows) {
      // A retained note that no longer binds its accepted request stops the list; the inbox quarantines it.
      try { assertPersonTextCustodyV1(row); } catch { unavailable(); }
      if (!isCanonicalUtcMillisTimestampV1(row.received_at) || !NOTE_ID.test(row.context_id)) unavailable();
    }
    const projects = this.associations("authority_project_context_associations_v1", "context_id", actor, rows.map((row) => row.context_id), grants);
    const notes = rows.map((row) => Object.freeze({
      row: Object.freeze({
        kind: "note" as const, id: row.context_id as `ctx_${string}`, title: row.title, added_at: row.received_at,
        visibility: row.audience_kind, association_project_ids: projects.get(row.context_id) ?? Object.freeze([]),
      }),
      text: row.text,
    }));
    const imported = this.imported.rows(actor, scope, 'ids' in selection ? { ids: selection.ids } : undefined).map(item => ({
      row: { kind: 'imported_meeting' as const, id: item.context_id, title: item.title, added_at: item.received_at, visibility: item.visibility,
        association_project_ids: item.project_id === null ? [] : [item.project_id as ProjectIdV1] }, text: item.text,
    })).filter(({ row }) => 'ids' in selection || selection.after === null || row.added_at < selection.after.added_at || (row.added_at === selection.after.added_at && row.id > selection.after.id));
    return [...notes, ...imported].sort((a, b) => b.row.added_at.localeCompare(a.row.added_at) || a.row.id.localeCompare(b.row.id)).slice(0, 'ids' in selection ? selection.ids.length : selection.limit);
  }

  private documents(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, grants: Grants, selection: Selection): readonly { readonly row: PersonStoreDocumentRowV1; readonly filename: string }[] {
    const acl = personOriginalAclV1("d", actor, grants.ids);
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    const tail = "ids" in selection
      ? { sql: `AND d.document_id IN (${marks(selection.ids)}) ORDER BY d.received_at DESC,d.document_id ASC`, args: selection.ids }
      : selection.after === null
        ? { sql: "ORDER BY d.received_at DESC,d.document_id ASC LIMIT ?", args: [selection.limit] }
        : { sql: "AND (d.received_at < ? OR (d.received_at = ? AND d.document_id > ?)) ORDER BY d.received_at DESC,d.document_id ASC LIMIT ?", args: [selection.after.added_at, selection.after.added_at, selection.after.id, selection.limit] };
    const rows = this.database.prepare(`SELECT d.document_id,d.title,d.filename,d.received_at,d.audience_kind,d.detected_media_type,d.original_size,w.extraction_state
      FROM authority_person_documents_v1 d JOIN authority_person_document_work_v1 w ON w.document_id=d.document_id
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql} ${tail.sql}`)
      .all(actor.organization_id, ...acl.args, ...scoped.args, ...tail.args) as DocumentCustodyRow[];
    // The keyset compares stored text, so a non-canonical time would misorder the list.
    for (const row of rows) if (!isCanonicalUtcMillisTimestampV1(row.received_at) || !DOCUMENT_ID.test(row.document_id)) unavailable();
    const projects = this.associations("authority_person_document_associations_v1", "document_id", actor, rows.map((row) => row.document_id), grants);
    return Object.freeze(rows.map((row) => Object.freeze({
      row: Object.freeze({
        kind: "document" as const, id: row.document_id as `doc_${string}`, title: row.title, added_at: row.received_at,
        visibility: row.audience_kind, association_project_ids: projects.get(row.document_id) ?? Object.freeze([]),
        media_type: row.detected_media_type, extraction_state: row.extraction_state, size_bytes: row.original_size,
      }),
      filename: row.filename,
    })));
  }

  /** Current associations ∩ the caller's grants; an unjoined project id never leaves this query. */
  private associations(
    table: "authority_project_context_associations_v1" | "authority_person_document_associations_v1",
    column: "context_id" | "document_id",
    actor: PersonAccessAuthorization,
    ids: readonly string[],
    grants: Grants,
  ): ReadonlyMap<string, readonly ProjectIdV1[]> {
    const result = new Map<string, ProjectIdV1[]>();
    if (ids.length === 0 || grants.ids.length === 0) return result;
    const rows = this.database.prepare(`SELECT ${column} AS id,project_id FROM ${table} WHERE organization_id=? AND ${column} IN (${marks(ids)}) AND project_id IN (${marks(grants.ids)})`)
      .all(actor.organization_id, ...ids, ...grants.ids) as { readonly id: string; readonly project_id: ProjectIdV1 }[];
    for (const row of rows) result.set(row.id, [...(result.get(row.id) ?? []), row.project_id]);
    for (const [id, projects] of result) result.set(id, Object.freeze(projects.sort()) as ProjectIdV1[]);
    return result;
  }

  private openRelease(
    actor: PersonAccessAuthorization,
    grants: Grants,
    rows: { readonly notes: readonly PersonStoreNoteRowV1[]; readonly documents: readonly PersonStoreDocumentRowV1[] },
    detail: Readonly<Record<string, unknown>>,
  ): PersonStoreReleaseV1 {
    const receipt = this.audit(actor, {
      operation: "person_open", scope: GLOBAL, grants_sha256: grants.sha256,
      released_items_sha256: canonicalSha256([...rows.notes, ...rows.documents]), released_count: 1, ...detail,
    });
    const release: PersonStoreReleaseV1 = Object.freeze({ receipt });
    this.released.set(release, Object.freeze({ tuple: tuple(actor), scope: GLOBAL, grants_sha256: grants.sha256, notes: Object.freeze([...rows.notes]), documents: Object.freeze([...rows.documents]) }));
    return release;
  }

  /** Content-free: digests of what left, never ids of rows the caller did not receive. */
  private audit(actor: PersonAccessAuthorization, entry: Readonly<Record<string, unknown>>): Sha256Digest {
    const body = {
      schema_version: 1, kind: "echo-person-original-item-release-audit-v1", audit_id: randomUUID(),
      organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id,
      session_family_id: actor.session_family_id, ...entry, checked_at: actor.checked_at,
    };
    const receipt = canonicalSha256(body);
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(receipt, canonicalJson(body), actor.checked_at);
    return receipt;
  }
}
