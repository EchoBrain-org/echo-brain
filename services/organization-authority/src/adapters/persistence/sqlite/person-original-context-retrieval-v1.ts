import {
  EVIDENCE_ANY_DATE_V1,
  EVIDENCE_DATE_FIELDS_V1,
  evidenceDayV1,
  matchesEvidenceDateV1,
  validateEvidenceDateFilterV1,
  type EvidenceDateFieldV1,
  type EvidenceDateFilterV1,
  type EvidenceDateSelectionV1,
  type EvidenceDatesV1,
} from "@echo-brain/organization-authority-kernel/shared/temporal-query-v1";
import type { EvidenceDeskUncheckedV1, EvidenceSourceCapabilitiesV1 } from "@echo-brain/organization-authority-kernel/shared/evidence-desk-v2";
import { DOCUMENTS_SOURCE_CAPABILITIES_V1, MEETINGS_SOURCE_CAPABILITIES_V1 } from "@echo-brain/organization-authority-kernel/shared/source-capabilities-v1";
import { SqlitePersonImportedMeetingsV1, importedMeetingTextV1 } from './person-imported-meetings-v1.js';
import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { randomUUID } from "node:crypto";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";
import type Database from "better-sqlite3";
import { appendAuditRowV1 } from "./audit-row-v1.js";
import { canonicalSourceContentV1, sourceContentSha256V1 } from "@echo-brain/organization-processing/core";
import type { MeetingDocument } from "@echo-brain/organization-processing/core";
import type { PersonItemRefV1 } from "@echo-brain/organization-api";
import type {
  OriginalContextReleaseV1,
  OriginalContextCitationV1,
  OriginalContextDeskItemV1,
  OriginalContextDeskExclusionV1,
  OriginalContextDeskReleaseV1,
  PersonAskScopeV2,
  PersonOriginalContextEvidenceDeskPortV1,
} from "../../../application/ports/person-original-context-retrieval-v1.js";
import { personOriginalAclV1, personOriginalGrantedProjectIdsV1, personOriginalScopeFilterV1, personUnknownScopeV1 } from "./person-original-access-v1.js";
import { analyzeOriginalContextPacketV1, scoreOriginalContextPacketV1 } from "./original-context-bm25-v1.js";
import { createUncheckedTallyV1 } from "../../../application/evidence-unchecked-v1.js";

const MAXIMUM_PACKET_BYTES = 3_072;
const SOURCE_ID = /^source:[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/** The Ask source check reads under global access: everything the caller may read, every project included. */
const GLOBAL_SCOPE: PersonAskScopeV2 = Object.freeze({ kind: "global" });


/** Desk search and inventory share admission/ACL joins; inventory skips term matching. */
interface OriginalRowsQueryV1 extends EvidenceDateFilterV1 {
  readonly limit: number;
  readonly inventory?: true;
  readonly first_document_passage?: true;
  readonly exclude?: OriginalContextDeskExclusionV1;
}

/** A desk exclusion as SQL over one store alias, applied before its LIMIT: no excluded source, and no Only-me row when asked. */
function excludedSql(alias: string, exclude: OriginalContextDeskExclusionV1 | undefined): { readonly sql: string; readonly args: readonly unknown[] } {
  if (exclude === undefined) return { sql: "", args: [] };
  const sources = exclude.source_ids.length === 0 ? "" : "AND s.source_id NOT IN (SELECT value FROM json_each(?))";
  return { sql: `${sources} ${exclude.only_me ? `AND ${alias}.audience_kind != 'only_me'` : ""}`, args: exclude.source_ids.length === 0 ? [] : [JSON.stringify(exclude.source_ids)] };
}
/** Whether a scanned row is excluded: an imported meeting is always its importer's alone. */
function excludedRow(row: { readonly source_id: string; readonly visibility?: string }, imported: boolean, exclude: OriginalContextDeskExclusionV1 | undefined): boolean {
  return exclude !== undefined && (exclude.source_ids.includes(row.source_id) || (exclude.only_me && (imported || row.visibility === "only_me")));
}

/**
 * The date fields a source's capabilities declare, and `any` when it takes it: what its reads accept, so what research is
 * told and what the desk takes are one list (research tool contract v1).
 */
export function evidenceDateFieldsOfV1(capabilities: EvidenceSourceCapabilitiesV1): readonly EvidenceDateSelectionV1[] {
  return Object.freeze([...EVIDENCE_DATE_FIELDS_V1.filter(field => capabilities.dates[field] !== undefined), ...(capabilities.any_date ? [EVIDENCE_ANY_DATE_V1] : [])]);
}
/** What a meetings read takes, in both its halves: approved records and these originals. */
export const PERSON_MEETING_DATE_FIELDS_V1 = evidenceDateFieldsOfV1(MEETINGS_SOURCE_CAPABILITIES_V1);
export const PERSON_DOCUMENT_DATE_FIELDS_V1 = evidenceDateFieldsOfV1(DOCUMENTS_SOURCE_CAPABILITIES_V1);
/** A read across both sources takes either's fields; each item is tested against the dates it records. */
const ANY_SOURCE_DATE_FIELDS: readonly EvidenceDateSelectionV1[] = Object.freeze([...new Set([...PERSON_MEETING_DATE_FIELDS_V1, ...PERSON_DOCUMENT_DATE_FIELDS_V1])]);

/** Notes and documents record only when ECHO received them: no field, `received` and `any` all read that date. */
function receivedDateSql(input: EvidenceDateFilterV1, prefix: 'u' | 'd'): { sql: string; args: string[] } {
  if (input.since === undefined && input.until === undefined) return { sql: '', args: [] };
  if (input.date_field !== undefined && input.date_field !== 'received' && input.date_field !== EVIDENCE_ANY_DATE_V1) return { sql: 'AND 0', args: [] };
  const clauses: string[] = []; const args: string[] = [];
  for (const [bound, operator] of [[input.since, '>='], [input.until, '<=']] as const) {
    if (bound === undefined) continue;
    clauses.push(`AND echo_evidence_day_v1(${prefix}.received_at, ?) ${operator} ?`);
    args.push(input.time_zone ?? 'UTC', bound);
  }
  return { sql: clauses.join(' '), args };
}

type OriginalScanRow = Pick<SourceRow, "source_id" | "revision_id" | "source_sha256" | "representation_sha256" | "context_id" | "title" | "text" | "received_at" | "visibility">;
type DocumentScanRow = Pick<DocumentRow, "source_id" | "revision_id" | "source_sha256" | "representation_sha256" | "document_id" | "title" | "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor" | "received_at" | "visibility">;
type OriginalScanIdentity = Omit<OriginalScanRow, "title" | "text">;
type DocumentScanIdentity = Omit<DocumentScanRow, "title" | "text">;
const ORIGINAL_TEXT_CUSTODY_V1 = `(SELECT request_version AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,audience_kind,audience_project_id,received_at FROM authority_person_updates_v2)`;

type SourceRow = {
  readonly dates?: EvidenceDatesV1;
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly representation_sha256: Sha256Digest;
  readonly source_content_sha256: string;
  readonly manifest_json: string;
  readonly source_content_json: string;
  readonly api_version: number;
  readonly context_id: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
  readonly lexical_score: number;
  readonly visibility?: "only_me" | "team" | "project" | "projects";
};
type DocumentRow = {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly representation_sha256: Sha256Digest;
  readonly document_id: string;
  readonly title: string;
  readonly ordinal: number;
  readonly anchor_kind: string;
  readonly anchor_start: number;
  readonly text: string;
  readonly extractor: string;
  readonly representation_json: string;
  readonly source_content_sha256: string;
  readonly manifest_json: string;
  readonly source_content_json: string;
  readonly filename: string;
  readonly original_sha256: string;
  readonly original_size: number;
  readonly detected_media_type: string;
  readonly received_at: string;
  readonly lexical_score: number;
  readonly visibility?: "only_me" | "team" | "project" | "projects";
};
/** A document source revision's metadata: its row without a chunk. */
type DocumentMeta = Omit<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text">;
type DeskKind = "note" | "document_passage" | "imported_meeting";
type DeskEntry = { readonly score: number; readonly received_at: string; readonly atom: ReleasedSourceContextAtomV1; readonly item: () => OriginalContextDeskItemV1 };

interface Sessions {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}

function denied(): never {
  throw new AuthorityOperationError("unauthorized", "person authentication failed");
}

function unavailable(): never {
  throw new AuthorityOperationError("unavailable", "person source retrieval is unavailable");
}

// Closed English function words only. No domain synonyms, stemming, or semantic
// expansion: project IDs, negation, numbers and subject words remain intact.
// Ask's follow-ups (ADR-0040) drop the same words from a search.
export const PERSON_QUERY_FUNCTION_WORDS_V1: ReadonlySet<string> = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "can", "could", "should", "would", "will",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "they", "their",
  "this", "that", "these", "those", "of", "to", "for", "from", "in", "on",
  "at", "with", "by", "and", "or", "as", "about",
]);

/** Desk ranking deliberately matches complete Unicode terms, never substrings. */
function wholeTermScore(title: string, text: string, terms: readonly string[]): number {
  const found = new Set((`${title}\n${text}`).normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []);
  return terms.reduce((score, term) => score + (found.has(term) ? 1 : 0), 0);
}

function queryTerms(query: string): readonly string[] {
  const runs = query.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  // CAN and IT are meaningful engineering/team names, even though their
  // lowercase forms are common function words in a natural question.
  const acronyms = new Set(runs.filter(term => /^[A-Z]{2,}$/.test(term)).map(term => term.toLowerCase()));
  const terms = [...new Set(runs.map(term => term.toLowerCase().normalize("NFC")))];
  if (terms.length === 0 || terms.length > 32) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
  return terms.filter(term => !PERSON_QUERY_FUNCTION_WORDS_V1.has(term) || acronyms.has(term));
}

function packets(title: string, body: string): readonly string[] {
  const heading = title.normalize("NFC");
  const available = MAXIMUM_PACKET_BYTES - Buffer.byteLength(`${heading}\n`, "utf8");
  if (available < 1) unavailable();
  const characters = [...body.normalize("NFC")];
  const values: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = offset;
    let current = "";
    let currentBytes = 0;
    while (end < characters.length) {
      const character = characters[end]!;
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (currentBytes + characterBytes > available) break;
      current += character;
      currentBytes += characterBytes;
      end += 1;
    }
    if (current.length === 0) unavailable();
    values.push(`${heading}\n${current}`);
    if (end === characters.length) break;
    // A fixed overlap exceeds the validated 64-byte lexical-term bound. It
    // preserves terms that cross a packet boundary and remains reconstructible
    // from immutable source content without a query-dependent window.
    offset = Math.max(offset + 1, end - 256);
  }
  return Object.freeze(values);
}

function wholeMatchingPacket(title: string, body: string, terms: readonly string[]): { readonly index: number; readonly text: string } {
  const values = packets(title, body);
  if (terms.length === 0) return Object.freeze({ index: 0, text: values[0]! });
  let index = -1;
  let bestScore = 0;
  for (let candidate = 0; candidate < values.length; candidate += 1) {
    const score = wholeTermScore("", values[candidate]!, terms);
    if (score > bestScore) { bestScore = score; index = candidate; }
  }
  if (index < 0) unavailable();
  return Object.freeze({ index, text: values[index]! });
}

/** Labels cross the public API boundary; evidence retains the full filename. */
function presentationLabel(value: string): string {
  // Upload filenames deliberately permit a broader set of Unicode than Ask
  // citation labels. This is presentation-only; packets and anchors retain
  // the exact immutable filename.
  const sanitized = value.normalize("NFC").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
  const label = sanitized.length === 0 ? "Saved context" : sanitized;
  const codepoints = [...label];
  return codepoints.length <= 200 ? label : `${codepoints.slice(0, 197).join("")}…`;
}

/** One canonical packet commitment, shared by search, desk inventory and citation opening. */
function originalPacketAtomV1(row: SourceRow | DocumentRow, packet: { readonly index: number; readonly text: string }): ReleasedSourceContextAtomV1 {
  const document = "document_id" in row;
  const anchor = document
    ? { kind: "document", document_id: row.document_id, ordinal: row.ordinal, anchor_kind: row.anchor_kind, anchor_start: row.anchor_start, segment: packet.index, text: packet.text }
    : { kind: "text", context_id: row.context_id, segment: packet.index, text: packet.text };
  return Object.freeze({
    kind: "source_revision" as const, source_id: row.source_id, revision_id: row.revision_id,
    source_sha256: row.source_sha256, representation_sha256: row.representation_sha256,
    anchor_sha256: canonicalSha256(anchor), ...(document ? { document_id: row.document_id } : {}),
    label: document ? presentationLabel(row.title) : row.title, text: packet.text,
  });
}

/**
 * Reads immutable Person-upload source revisions: notes, document passages
 * and the importer's own unapproved meetings. Admission alone never makes a
 * raw meeting readable to anyone else through Ask; approved records are what
 * others read from a meeting (ADR-0046).
 */
export class SqlitePersonOriginalContextRetrievalV1 implements PersonOriginalContextEvidenceDeskPortV1 {
  private readonly imported: SqlitePersonImportedMeetingsV1;
  private readonly releases = new WeakSet<OriginalContextReleaseV1>();
  private readonly deskReleases = new WeakSet<OriginalContextDeskReleaseV1>();
  constructor(
    private readonly database: Database.Database,
    private readonly sessions: Sessions,
    private readonly organizationId: string,
  ) {
    this.imported = new SqlitePersonImportedMeetingsV1(database);
    // The query parameter is a bound, adapter-created JSON array of validated terms.
    database.function("echo_evidence_day_v1", { deterministic: true }, (stamp, zone) => evidenceDayV1(String(stamp), String(zone)) ?? null);
    database.function("echo_original_context_whole_score_v1", { deterministic: true }, (title, text, query) =>
      typeof title === "string" && typeof text === "string" && typeof query === "string"
        ? wholeTermScore(title, text, JSON.parse(query) as readonly string[]) : 0);
  }

  /**
   * Request-bound desk search: whole terms, at most three passages per
   * document.
   */
  deskSearch(input: EvidenceDateFilterV1 & {
    readonly source?: "meeting" | "document";
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly query?: string;
    readonly kinds?: readonly DeskKind[];
    readonly limit?: number;
    readonly exclude?: OriginalContextDeskExclusionV1;
  }): OriginalContextDeskReleaseV1 {
    validateEvidenceDateFilterV1(input, input.source === "meeting" ? PERSON_MEETING_DATE_FIELDS_V1 : input.source === "document" ? PERSON_DOCUMENT_DATE_FIELDS_V1 : ANY_SOURCE_DATE_FIELDS);
    const limit = input.limit ?? (input.query === undefined ? 50 : 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > (input.query === undefined ? 50 : 10) || (input.exclude !== undefined
      && (!Array.isArray(input.exclude.source_ids) || input.exclude.source_ids.some(id => typeof id !== "string") || typeof input.exclude.only_me !== "boolean"))) {
      throw new AuthorityOperationError("invalid_request", "request is invalid");
    }
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    const terms = input.query === undefined ? [] : queryTerms(input.query);
    const filteredInventory = input.query === undefined && (input.source !== undefined || input.since !== undefined || input.until !== undefined);
    const candidates = input.query === undefined && !filteredInventory
      ? this.deskInventoryRows(actor, input.scope, limit + 1, input.kinds, input.exclude)
      : [];
    const expanded: DeskEntry[] = input.query !== undefined
      ? this.deskBm25Entries(actor, input.scope, terms, limit + 1, input.kinds, input)
      : filteredInventory ? this.deskFilteredInventory(actor, input.scope, limit + 1, input)
      : candidates.map((row) => { const atom = this.deskAtom(row, []); return { score: row.lexical_score, received_at: row.received_at, atom, item: () => this.deskItem(row, atom, false) }; });
    const selected = expanded.slice(0, limit);
    const atoms = selected.map(({ atom }) => atom);
    const items = selected.map(({ item }) => item());
    return this.commitDeskRelease(actor, input.access_token, input.scope, items, atoms, expanded.length > limit, this.uncheckedOf(actor, input.scope, input));
  }

  /**
   * A dated read's items its filter could not test (research tool contract v1): of the items its source, kinds and
   * scope select, those that do not record the date it reads, one per list member (a note, a document, an imported
   * meeting), with the dates they do record. As the notice it replaces, a search's words do not
   * narrow it. No date field reads a meeting's time and a note's or document's arrival, as the reads themselves do.
   */
  private uncheckedOf(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, input: EvidenceDateFilterV1 & { readonly source?: "meeting" | "document"; readonly kinds?: readonly DeskKind[] }): EvidenceDeskUncheckedV1 | undefined {
    if (input.since === undefined && input.until === undefined) return undefined;
    const accepts = (kind: DeskKind) => input.kinds === undefined || input.kinds.includes(kind);
    const tally = createUncheckedTallyV1();
    const consider = (dates: EvidenceDatesV1, unnamed: EvidenceDateFieldV1) => { tally.tests(dates, input.date_field ?? unnamed); };
    // Every note and document records when it was received, so only another field leaves one untested.
    const received = input.date_field === undefined || input.date_field === "received" || input.date_field === EVIDENCE_ANY_DATE_V1;
    if (input.source !== "meeting" && !received) {
      if (accepts("note")) for (const row of this.textScanRows(actor, scope)) consider({ received: row.received_at }, "received");
      if (accepts("document_passage")) for (const row of new Map(this.documentScanRows(actor, scope).map(row => [row.document_id, row])).values()) consider({ received: row.received_at }, "received");
    }
    if (input.source !== "document") {
      // An import with no notes has no passage to list, so it is no member either way.
      if (accepts("imported_meeting")) for (const row of this.imported.rows(actor, scope)) if (row.text.length > 0) consider({ ...row.dates, received: row.received_at }, "occurred");
    }
    return tally.unchecked();
  }

  deskAuthorize(input: { readonly access_token: string; readonly scope: PersonAskScopeV2 }): { readonly checked_at: string } {
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    return Object.freeze({ checked_at: actor.checked_at });
  }

  deskOpen(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: OriginalContextCitationV1;
    readonly neighbours?: number;
  }): OriginalContextDeskReleaseV1 {
    const neighbours = input.neighbours ?? 0;
    if (!Number.isSafeInteger(neighbours) || neighbours < 0 || neighbours > 2) {
      throw new AuthorityOperationError("invalid_request", "request is invalid");
    }
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    if (input.citation.document_id === undefined) {
      const row = this.textByCitation(actor, input.scope, input.citation);
      if (row === undefined) denied();
      const atom = this.textAnchorForCitation(row, input.citation);
      if (atom === undefined) denied();
      return this.commitDeskRelease(actor, input.access_token, input.scope,
        [this.deskItem(row, atom, true)], [atom]);
    }
    const meta = this.documentSourceMeta(actor, input.scope, input.citation.source_id, input.citation.revision_id, input.citation.document_id, input.citation.representation_sha256);
    if (meta === undefined) denied();
    // Parse and verify the immutable representation once.  The anchor scan is
    // streaming; it never materializes every extracted chunk or repeats the
    // representation parse for each candidate in a large document.
    const representation = this.representationChunks(meta as DocumentRow);
    let anchorRow: DocumentRow | undefined;
    let anchor: ReleasedSourceContextAtomV1 | undefined;
    for (const chunk of this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text,extractor FROM authority_person_document_text_v1 WHERE document_id=? AND extractor=? ORDER BY ordinal").iterate(input.citation.document_id, meta.extractor) as Iterable<Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor">>) {
      const row = Object.freeze({ ...meta, ...chunk }) as DocumentRow;
      const candidate = this.documentAnchorForCitation(row, input.citation, representation);
      if (candidate !== undefined) { anchorRow = row; anchor = candidate; break; }
    }
    if (anchorRow === undefined || anchor === undefined) denied();
    // Anchor first, then preceding and following ordinal neighbours. The cap
    // is three immutable packets (9 KiB), independent of record/doc size.
    const before = this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text,extractor FROM authority_person_document_text_v1 WHERE document_id=? AND extractor=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1").get(input.citation.document_id, meta.extractor, anchorRow.ordinal) as Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor"> | undefined;
    const after = this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text,extractor FROM authority_person_document_text_v1 WHERE document_id=? AND extractor=? AND ordinal>? ORDER BY ordinal ASC LIMIT 1").get(input.citation.document_id, meta.extractor, anchorRow.ordinal) as Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor"> | undefined;
    const neighbourRows = [before, after].filter((chunk): chunk is Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor"> => chunk !== undefined).slice(0, neighbours).map((chunk) => Object.freeze({ ...meta, ...chunk }) as DocumentRow);
    const selected = [anchorRow, ...neighbourRows];
    // Preserve the exact requested segment.  A large extracted chunk can have
    // several 3 KiB packets, and recomputing the anchor with an empty query
    // would otherwise silently substitute packet zero.
    const atoms = [anchor, ...selected.slice(1).map((row) => this.deskAtom(row, []))];
    return this.commitDeskRelease(actor, input.access_token, input.scope,
      selected.map((row, index) => this.deskItem(row, atoms[index]!, true)), atoms);
  }

  revalidateDeskRelease(input: {
    readonly access_token: string;
    readonly release: OriginalContextDeskReleaseV1;
    readonly items_checked?: true;
  }): { readonly checked_at: string } {
    if (!this.deskReleases.has(input.release)) unavailable();
    // A release whose items this request already checked keeps its session,
    // identity and scope checks but does not re-read each atom (ADR-0038).
    const checked = input.items_checked === true
      ? Object.freeze({ checked_at: this.releaseActor(input.access_token, input.release.release).checked_at })
      : this.revalidate({ access_token: input.access_token, release: input.release.release });
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    // The release keeps its per-atom revalidation semantics.  The
    // request-bound desk additionally pins the caller's own project grants, so
    // a later desk call cannot mix this caller's project-association
    // snapshots. Not the org-wide revision: anyone's note or rename moves it.
    if (this.grantsSha256(actor) !== input.release.release.grants_sha256) denied();
    if (input.items_checked === true) return checked;
    for (const item of input.release.items) {
      const atom = input.release.release.released_atoms.find((candidate) => this.citationMatches(candidate, item.citation));
      if (atom === undefined || canonicalJson(this.currentDeskItem(actor, input.release.release.scope, atom, item.text !== undefined)) !== canonicalJson(item)) denied();
    }
    return checked;
  }

  revalidate(input: { readonly access_token: string; readonly release: OriginalContextReleaseV1 }) {
    const actor = this.releaseActor(input.access_token, input.release);
    for (const atom of input.release.released_atoms) this.assertReleasedAtomReadable(actor, input.release.scope, atom);
    return Object.freeze({ checked_at: actor.checked_at });
  }

  /** The release's session, organization, identity and scope checks, without its atoms. */
  private releaseActor(accessToken: string, release: OriginalContextReleaseV1): PersonAccessAuthorization {
    if (!this.releases.has(release)) unavailable();
    const actor = this.sessions.authenticateAccess({ access_token: accessToken });
    this.assertOrganization(actor);
    if (actor.principal_id !== release.authorization.principal_id ||
      actor.membership_id !== release.authorization.membership_id ||
      actor.session_family_id !== release.authorization.session_family_id) denied();
    this.assertScope(actor, release.scope);
    return actor;
  }

  read(input: { readonly access_token: string; readonly scope: PersonAskScopeV2; readonly citation: OriginalContextCitationV1 }) {
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    let atom: ReleasedSourceContextAtomV1 | undefined;
    if (input.citation.document_id === undefined) {
      const row = this.textByCitation(actor, input.scope, input.citation);
      atom = row === undefined ? undefined : this.textAnchorForCitation(row, input.citation);
    } else {
      atom = this.documentAnchorByCitation(actor, input.scope, input.citation);
    }
    if (atom === undefined) denied();
    this.auditProofRead(actor, input.scope, atom);
    return Object.freeze({ scope: Object.freeze({ ...input.scope }), atom });
  }

  private assertOrganization(actor: PersonAccessAuthorization): void {
    if (actor.organization_id !== this.organizationId ||
      !this.database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type)) denied();
  }

  /**
   * The caller's active project grants, each by its grant row, so leaving and
   * rejoining a project also moves it. Only this caller's grants change their
   * access to a release; other people's writes do not.
   */
  private grantsSha256(actor: PersonAccessAuthorization): Sha256Digest {
    return canonicalSha256(this.database.prepare("SELECT project_id,project_membership_id FROM authority_project_memberships_v1 WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active' ORDER BY project_id,project_membership_id")
      .all(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type));
  }

  private projectGrant(actor: PersonAccessAuthorization, projectId: string): boolean {
    return this.database.prepare("SELECT 1 FROM authority_project_memberships_v1 WHERE organization_id=? AND project_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(actor.organization_id, projectId, actor.principal_id, actor.membership_id, actor.membership_type) !== undefined;
  }

  private assertScope(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): void {
    switch (scope.kind) {
      case "project":
        if (!this.projectGrant(actor, scope.project_id)) denied();
        return;
      case "global":
        return;
      default:
        personUnknownScopeV1(scope);
    }
  }

  private acl(actor: PersonAccessAuthorization, prefix: "u" | "d"): { readonly sql: string; readonly args: readonly string[] } {
    return personOriginalAclV1(prefix, actor, personOriginalGrantedProjectIdsV1(this.database, actor));
  }

  private deskBm25Entries(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], limit: number, kinds: readonly DeskKind[] | undefined, filter: EvidenceDateFilterV1 & { readonly source?: "meeting" | "document"; readonly exclude?: OriginalContextDeskExclusionV1 } = {}): DeskEntry[] {
    type Candidate = Readonly<{ row: OriginalScanIdentity | DocumentScanIdentity; packet: { readonly index: number; readonly text: string }; analysis: ReturnType<typeof analyzeOriginalContextPacketV1> }>;
    const candidates: Candidate[] = [];
    const add = (title: string, body: string, row: Candidate["row"]) => {
      for (const [index, text] of packets(title, body).entries()) candidates.push({ row, packet: { index, text }, analysis: analyzeOriginalContextPacketV1(text, terms) });
    };
    if (filter.source !== "meeting" && (kinds === undefined || kinds.includes("note"))) {
      for (const { title, text, ...identity } of this.textScanRows(actor, scope)) if (!excludedRow(identity, false, filter.exclude) && matchesEvidenceDateV1({ received: identity.received_at }, filter, "received")) add(title, text, identity);
    }
    if (filter.source !== "document" && (kinds === undefined || kinds.includes("imported_meeting"))) {
      for (const { title, text, ...identity } of this.imported.rows(actor, scope)) if (!excludedRow(identity, true, filter.exclude) && matchesEvidenceDateV1({ ...identity.dates, received: identity.received_at }, filter, "occurred")) add(title, text, identity);
    }
    if (filter.source !== "meeting" && (kinds === undefined || kinds.includes("document_passage"))) {
      for (const { title, text, ...identity } of this.documentScanRows(actor, scope)) if (!excludedRow(identity, false, filter.exclude) && matchesEvidenceDateV1({ received: identity.received_at }, filter, "received")) add(title, text, identity);
    }
    const frequencies = new Map<string, number>();
    let totalLength = 0;
    for (const candidate of candidates) {
      totalLength += candidate.analysis.length;
      for (const term of candidate.analysis.frequencies.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    const averageLength = candidates.length === 0 ? 0 : totalLength / candidates.length;
    const ranked = candidates.map(candidate => ({
      ...candidate,
      score: scoreOriginalContextPacketV1(candidate.analysis, terms, candidates.length, averageLength, frequencies),
      received_at: candidate.row.received_at,
    })).filter(candidate => candidate.score > 0).sort((left, right) =>
      right.score - left.score || right.received_at.localeCompare(left.received_at) ||
      left.row.source_id.localeCompare(right.row.source_id) ||
      ("ordinal" in left.row ? left.row.ordinal : 0) - ("ordinal" in right.row ? right.row.ordinal : 0) ||
      left.packet.index - right.packet.index);
    const documents = new Map<string, number>();
    const selected: typeof ranked = [];
    for (const candidate of ranked) {
      if ("document_id" in candidate.row) {
        const count = documents.get(candidate.row.document_id) ?? 0;
        if (count >= 3) continue;
        documents.set(candidate.row.document_id, count + 1);
      }
      selected.push(candidate);
      if (selected.length === limit) break;
    }
    return selected.map(candidate => {
      const scan = candidate.row;
      const row = "document_id" in scan ? this.hydrateDocumentScanRow(actor, scope, scan) : this.textBySource(actor, scope, scan.source_id, scan.revision_id);
      if (row === undefined) denied();
      this.assertRowRevision(row);
      const atom = originalPacketAtomV1(row, candidate.packet);
      return { score: candidate.score, received_at: candidate.received_at, atom, item: () => this.deskItem(row, atom, true) };
    });
  }

  private deskFilteredInventory(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, limit: number, filter: EvidenceDateFilterV1 & { readonly source?: "meeting" | "document"; readonly kinds?: readonly DeskKind[]; readonly exclude?: OriginalContextDeskExclusionV1 }): DeskEntry[] {
    type Candidate = { readonly received_at: string; readonly row: OriginalScanRow | DocumentScanRow };
    const candidates: Candidate[] = [];
    const accepts = (kind: DeskKind) => filter.kinds === undefined || filter.kinds.includes(kind);
    if (filter.source !== 'meeting') {
      if (accepts('note')) for (const row of this.textRows(actor, scope, [], { ...filter, inventory: true, limit })) if (matchesEvidenceDateV1({ received: row.received_at }, filter, 'received')) candidates.push({ received_at: row.received_at, row });
      if (accepts('document_passage')) {
        const seen = new Set<string>();
        for (const row of this.documentRows(actor, scope, [], { ...filter, inventory: true, limit, first_document_passage: true })) {
          if (seen.has(row.document_id) || !matchesEvidenceDateV1({ received: row.received_at }, filter, 'received')) continue;
          seen.add(row.document_id); candidates.push({ received_at: row.received_at, row });
        }
      }
    }
    if (filter.source !== 'document') {
      if (accepts('imported_meeting')) for (const row of this.imported.rows(actor, scope)) if (row.text.length > 0 && !excludedRow(row, true, filter.exclude) && matchesEvidenceDateV1({ ...row.dates, received: row.received_at }, filter, 'occurred')) candidates.push({ received_at: row.received_at, row });
    }
    candidates.sort((a, b) => b.received_at.localeCompare(a.received_at));
    return candidates.slice(0, limit).map(candidate => {
      const scan = candidate.row;
      const row = 'document_id' in scan ? this.hydrateDocumentScanRow(actor, scope, scan) : this.textBySource(actor, scope, scan.source_id, scan.revision_id);
      if (row === undefined) denied();
      const atom = this.deskAtom(row, []);
      return { score: 0, received_at: candidate.received_at, atom, item: () => this.deskItem(row, atom, false) };
    });
  }

  private deskInventoryRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, limit: number, kinds: readonly DeskKind[] | undefined, exclude?: OriginalContextDeskExclusionV1): readonly (SourceRow | DocumentRow)[] {
    // Source inventory exposes one stable representative passage per document.
    const sourceLimit = 100;
    const candidates = [
      ...this.textRows(actor, scope, [], { inventory: true, limit: sourceLimit, ...(exclude === undefined ? {} : { exclude }) }),
      // Transcript-only imports from a meeting tool remain visible in the
      // original-item list, but have no passage to cite (a pasted transcript
      // is text). Exclude them before applying the limit so they neither
      // break packet construction nor hide readable notes.
      ...this.imported.rows(actor, scope).filter(row => row.text.length > 0 && !excludedRow(row, true, exclude)).slice(0, sourceLimit),
      ...this.documentRows(actor, scope, [], { inventory: true, limit: sourceLimit, first_document_passage: true, ...(exclude === undefined ? {} : { exclude }) }),
    ]
      .filter((row) => kinds === undefined || kinds.includes("document_id" in row ? "document_passage" : row.api_version === 0 ? "imported_meeting" : "note"))
      .sort((left, right) => right.received_at.localeCompare(left.received_at) || left.source_id.localeCompare(right.source_id) || ("ordinal" in left ? left.ordinal : 0) - ("ordinal" in right ? right.ordinal : 0));
    const documents = new Set<string>();
    const selected: (SourceRow | DocumentRow)[] = [];
    for (const row of candidates) {
      if ("document_id" in row) {
        if (documents.has(row.document_id)) continue;
        documents.add(row.document_id);
      }
      selected.push(row);
      if (selected.length === limit) break;
    }
    return Object.freeze(selected);
  }

  private deskAtom(row: SourceRow | DocumentRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    const packet = wholeMatchingPacket(row.title, row.text, terms);
    this.assertRowRevision(row);
    return originalPacketAtomV1(row, packet);
  }

  /** A released packet's row must still match its immutable source revision. */
  private assertRowRevision(row: SourceRow | DocumentRow): void {
    this.assertIntegrity(row);
    if ("document_id" in row) {
      this.assertDocumentSourceRevision(row);
      this.assertDocumentChunk(row, this.representationChunks(row));
    } else this.assertTextSourceRevision(row);
  }

  private deskItem(row: SourceRow | DocumentRow, atom: ReleasedSourceContextAtomV1, includeText: boolean): OriginalContextDeskItemV1 {
    // An unapproved import is its importer's alone (ADR-0046); a note or document carries its own audience.
    const visibility = !("document_id" in row) && row.api_version === 0 ? "only_me" : row.visibility;
    if (visibility !== "only_me" && visibility !== "team" && visibility !== "project" && visibility !== "projects") unavailable();
    const citation: OriginalContextCitationV1 = Object.freeze({ kind: "source_revision", source_id: atom.source_id, revision_id: atom.revision_id, source_sha256: atom.source_sha256, representation_sha256: atom.representation_sha256, anchor_sha256: atom.anchor_sha256, ...(atom.document_id === undefined ? {} : { document_id: atom.document_id }) });
    const kind = atom.document_id === undefined ? ((row as SourceRow).api_version === 0 ? "imported_meeting" : "note") : "document_passage";
    const ref = (atom.document_id === undefined ? `${kind}:${(row as SourceRow).context_id}` : `document:${atom.document_id}`) as PersonItemRefV1;
    return Object.freeze({ citation, kind, dates: { ...((row as SourceRow).dates ?? {}), received: row.received_at }, ...(includeText ? { text: atom.text } : {}), visibility, label: atom.label ?? "Saved context", received_at: row.received_at, version: atom.revision_id, ref });
  }

  private currentDeskItem(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, atom: ReleasedSourceContextAtomV1, includeText: boolean): OriginalContextDeskItemV1 {
    if (atom.document_id === undefined) {
      const row = this.textByCitation(actor, scope, atom);
      if (row === undefined) denied();
      return this.deskItem(row, atom, includeText);
    }
    const row = this.documentSourceMeta(actor, scope, atom.source_id, atom.revision_id, atom.document_id, atom.representation_sha256);
    if (row === undefined) denied();
    return this.deskItem(row as DocumentRow, atom, includeText);
  }

  private commitDeskRelease(actor: PersonAccessAuthorization, accessToken: string, scope: PersonAskScopeV2, items: readonly OriginalContextDeskItemV1[], atoms: readonly ReleasedSourceContextAtomV1[], truncated = false, unchecked?: EvidenceDeskUncheckedV1): OriginalContextDeskReleaseV1 {
    const release: OriginalContextReleaseV1 = Object.freeze({ authorization: Object.freeze({ principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, checked_at: actor.checked_at }), scope: Object.freeze({ ...scope }), grants_sha256: this.grantsSha256(actor), released_atoms: Object.freeze([...atoms]) });
    this.releases.add(release);
    this.revalidate({ access_token: accessToken, release });
    // Version 2 commits the caller's grants digest; version 1 rows carry the org-wide authorization revision instead.
    const audit = { schema_version: 2, kind: "echo-person-original-context-desk-release-audit-v1", audit_id: randomUUID(), organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, scope, grants_sha256: release.grants_sha256, released_atoms_sha256: canonicalSha256(atoms.map(({ source_id, revision_id, source_sha256, representation_sha256, anchor_sha256 }) => ({ source_id, revision_id, source_sha256, representation_sha256, anchor_sha256 }))), released_metadata_sha256: canonicalSha256(items.map(({ citation, kind, visibility, label, received_at, version, text, ref, dates }) => ({ citation, kind, visibility, label, received_at, version, ...(dates === undefined ? {} : { dates }), ...(text === undefined ? {} : { text_sha256: canonicalSha256(text) }), ...(ref === undefined ? {} : { ref }) }))), released_count: items.length, ...(unchecked === undefined ? {} : { unchecked }), checked_at: actor.checked_at };
    const receipt = appendAuditRowV1(this.database, "authority_person_upload_read_audit_v1", audit, actor.checked_at);
    const result: OriginalContextDeskReleaseV1 = Object.freeze({ release, receipt, items: Object.freeze([...items]), truncated, ...(unchecked === undefined ? {} : { unchecked }) });
    this.deskReleases.add(result);
    return result;
  }

  private textRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], query: OriginalRowsQueryV1): readonly SourceRow[] {
    const acl = this.acl(actor, "u");
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    const dates = receivedDateSql(query, "u");
    const excluded = excludedSql("u", query.exclude);
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at,u.audience_kind AS visibility,echo_original_context_whole_score_v1(u.title,u.text,?) AS lexical_score
      FROM ${ORIGINAL_TEXT_CUSTODY_V1} u
      JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql} ${query.inventory === true ? "" : "AND lexical_score > 0"} ${dates.sql} ${excluded.sql}
      ORDER BY lexical_score DESC,u.received_at DESC,s.source_id LIMIT ?`;
    return this.database.prepare(sql).all(JSON.stringify(terms), actor.organization_id, ...acl.args, ...scoped.args, ...dates.args, ...excluded.args, query.limit) as readonly SourceRow[];
  }

  private textScanRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): readonly OriginalScanRow[] {
    const acl = this.acl(actor, "u");
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,u.context_id,u.title,u.text,u.received_at,u.audience_kind AS visibility
      FROM ${ORIGINAL_TEXT_CUSTODY_V1} u
      JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql}
      ORDER BY u.received_at DESC,s.source_id`).all(actor.organization_id, ...acl.args, ...scoped.args) as readonly OriginalScanRow[];
  }

  private documentScanRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): readonly DocumentScanRow[] {
    const acl = this.acl(actor, "d");
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,d.document_id,d.filename AS title,t.ordinal,t.anchor_kind,t.anchor_start,t.text,t.extractor,d.received_at,d.audience_kind AS visibility
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_text_v1 t ON t.document_id=d.document_id
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial') AND work.extractor=t.extractor
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=t.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql}
      ORDER BY d.received_at DESC,s.source_id,t.ordinal`).all(actor.organization_id, ...acl.args, ...scoped.args) as readonly DocumentScanRow[];
  }

  private hydrateDocumentScanRow(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, scan: DocumentScanIdentity): DocumentRow | undefined {
    const meta = this.documentSourceMeta(actor, scope, scan.source_id, scan.revision_id, scan.document_id, scan.representation_sha256);
    if (meta === undefined) return undefined;
    const chunk = this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text,extractor FROM authority_person_document_text_v1 WHERE document_id=? AND extractor=? AND ordinal=?")
      .get(scan.document_id, scan.extractor, scan.ordinal) as Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor"> | undefined;
    if (chunk === undefined || chunk.anchor_kind !== scan.anchor_kind || chunk.anchor_start !== scan.anchor_start) return undefined;
    return Object.freeze({ ...meta, ...chunk });
  }

  private documentRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], query: OriginalRowsQueryV1): readonly DocumentRow[] {
    const acl = this.acl(actor, "d");
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    const firstChunk = query.first_document_passage === true ? "AND t.ordinal=(SELECT MIN(first_t.ordinal) FROM authority_person_document_text_v1 first_t WHERE first_t.document_id=d.document_id AND first_t.extractor=t.extractor)" : "";
    // Matching and packet titles use the verified filename, never a display title.
    const dates = receivedDateSql(query, "d");
    const excluded = excludedSql("d", query.exclude);
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,t.ordinal,t.anchor_kind,t.anchor_start,t.text,t.extractor,representation.content_json AS representation_json,d.received_at,d.audience_kind AS visibility,echo_original_context_whole_score_v1(d.filename,t.text,?) AS lexical_score
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_text_v1 t ON t.document_id=d.document_id
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial') AND work.extractor=t.extractor
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=t.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql} ${query.inventory === true ? "" : "AND lexical_score > 0"} ${firstChunk} ${dates.sql} ${excluded.sql}
      ORDER BY lexical_score DESC,d.received_at DESC,s.source_id,t.ordinal LIMIT ?`;
    return this.database.prepare(sql).all(JSON.stringify(terms), actor.organization_id, ...acl.args, ...scoped.args, ...dates.args, ...excluded.args, query.limit) as readonly DocumentRow[];
  }

  private assertIntegrity(row: Pick<SourceRow, "source_id" | "revision_id" | "source_sha256" | "representation_sha256">): void {
    if (!SOURCE_ID.test(row.source_id) || row.revision_id.length === 0 || !SHA256.test(row.source_sha256) || !SHA256.test(row.representation_sha256)) unavailable();
  }

  private representationChunks(row: Pick<DocumentRow, "representation_json" | "representation_sha256">): readonly unknown[] {
    try {
      if (canonicalSha256(JSON.parse(row.representation_json) as never) !== row.representation_sha256) unavailable();
      const content = JSON.parse(row.representation_json) as { readonly kind?: unknown; readonly chunks?: unknown };
      if (content.kind !== "document-text" || !Array.isArray(content.chunks)) unavailable();
      return Object.freeze([...content.chunks]);
    } catch { unavailable(); }
  }

  private assertDocumentChunk(row: Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text">, chunks: readonly unknown[]): void {
    const chunk = chunks[row.ordinal] as Record<string, unknown> | undefined;
    if (chunk?.anchor_kind !== row.anchor_kind || chunk.anchor_start !== row.anchor_start || chunk.text !== row.text) unavailable();
  }

  private assertRevisionEnvelope(row: Pick<SourceRow, "source_sha256" | "source_content_sha256" | "manifest_json" | "source_content_json">): unknown {
    try {
      if (!/^[0-9a-f]{64}$/.test(row.source_content_sha256)) unavailable();
      const content = JSON.parse(row.source_content_json) as unknown;
      if (canonicalSourceContentV1(content) !== row.source_content_json || sourceContentSha256V1(content) !== row.source_content_sha256) unavailable();
      const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
      const { captured_at: _capturedAt, ...immutableRevision } = manifest;
      if (sourceContentSha256V1(immutableRevision) !== row.source_sha256.slice(7)) unavailable();
      return content;
    } catch { unavailable(); }
  }

  private assertTextSourceRevision(row: SourceRow): void {
    const content = this.assertRevisionEnvelope(row);
    if (row.api_version === 0) {
      const meeting = content as MeetingDocument;
      if (importedMeetingTextV1(meeting) !== row.text || canonicalSha256({ kind: 'imported-meeting-notes-v1', text: row.text }) !== row.representation_sha256) unavailable();
      return;
    }
    const expected = { schema_version: 1, kind: "person-text", original_api_version: row.api_version, context_id: row.context_id, title: row.title, text: row.text };
    if (canonicalSourceContentV1(content) !== canonicalSourceContentV1(expected)) unavailable();
  }

  private assertDocumentSourceRevision(row: DocumentRow): void {
    const content = this.assertRevisionEnvelope(row);
    const expected = { schema_version: 1, kind: "person-document", document_id: row.document_id, filename: row.filename, original_sha256: row.original_sha256, original_size: row.original_size, media_type: row.detected_media_type };
    if (canonicalSourceContentV1(content) !== canonicalSourceContentV1(expected)) unavailable();
  }

  private assertReleasedAtomReadable(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, atom: ReleasedSourceContextAtomV1): void {
    if (!SOURCE_ID.test(atom.source_id) || !SHA256.test(atom.source_sha256) || !SHA256.test(atom.representation_sha256) || !SHA256.test(atom.anchor_sha256)) denied();
    if (atom.document_id === undefined) {
      const row = this.textByCitation(actor, scope, atom);
      if (row === undefined || !this.hasTextAnchor(row, atom)) denied();
      return;
    }
    if (this.documentAnchorByCitation(actor, scope, atom) === undefined) denied();
  }

  private hasTextAnchor(row: SourceRow, atom: ReleasedSourceContextAtomV1): boolean {
    this.assertTextSourceRevision(row);
    return packets(row.title, row.text).some((text, segment) => atom.source_id === row.source_id && atom.revision_id === row.revision_id && atom.source_sha256 === row.source_sha256 && atom.representation_sha256 === row.representation_sha256 && atom.anchor_sha256 === canonicalSha256({ kind: "text", context_id: row.context_id, segment, text }) && atom.text === text);
  }

  private textAnchorForCitation(row: SourceRow, citation: OriginalContextCitationV1): ReleasedSourceContextAtomV1 | undefined {
    this.assertTextSourceRevision(row);
    for (const [segment, text] of packets(row.title, row.text).entries()) {
      const atom = originalPacketAtomV1(row, { index: segment, text });
      if (this.citationMatches(atom, citation)) return atom;
    }
    return undefined;
  }

  private documentAnchorForCitation(row: DocumentRow, citation: OriginalContextCitationV1, chunks: readonly unknown[]): ReleasedSourceContextAtomV1 | undefined {
    this.assertDocumentChunk(row, chunks);
    for (const [segment, text] of packets(row.title, row.text).entries()) {
      const atom = originalPacketAtomV1(row, { index: segment, text });
      if (this.citationMatches(atom, citation)) return atom;
    }
    return undefined;
  }

  private citationMatches(atom: ReleasedSourceContextAtomV1, citation: OriginalContextCitationV1): boolean {
    return atom.source_id === citation.source_id && atom.revision_id === citation.revision_id && atom.source_sha256 === citation.source_sha256 && atom.representation_sha256 === citation.representation_sha256 && atom.anchor_sha256 === citation.anchor_sha256 && atom.document_id === citation.document_id;
  }

  private auditProofRead(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, atom: ReleasedSourceContextAtomV1): void {
    const body = { schema_version: 1, kind: "echo-person-original-context-proof-read-audit-v1", audit_id: randomUUID(), organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, scope, source_id: atom.source_id, revision_id: atom.revision_id, source_sha256: atom.source_sha256, representation_sha256: atom.representation_sha256, anchor_sha256: atom.anchor_sha256, checked_at: actor.checked_at };
    appendAuditRowV1(this.database, "authority_person_upload_read_audit_v1", body, actor.checked_at);
  }

  /**
   * The Ask source check (Ask timeline v1, C1; ADR-0047): for each cited source revision, whether the caller can read it now,
   * through the same ACL and global scope filter as every original read, and when they can, whether a newer readable revision
   * of the same source exists: `changed` for an imported or pasted meeting edited since. Notes and documents never change.
   * Read only: it releases nothing and writes no audit row, and a citation the caller cannot read is `unreadable`, never a
   * refusal, so a hidden, deleted and never-existing source read the same.
   *
   * One check reads each cited revision once, however many turns cited it: answers are kept by the revision a citation names
   * (`source_id`, `revision_id`, `source_sha256`, `representation_sha256`, and a document's `document_id`; the cited anchor
   * never changes the answer), and each revision of an imported meeting is verified once. The caller's ACL and scope filter
   * and the statements are prepared once a check. Answers keep the request's order and length.
   */
  checkSourceRevisions(input: { readonly access_token: string; readonly citations: readonly OriginalContextCitationV1[] }): readonly ("same" | "changed" | "unreadable")[] {
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, GLOBAL_SCOPE);
    const text = this.textSourceRead(actor, GLOBAL_SCOPE);
    const documentMeta = this.documentSourceMetaRead(actor, GLOBAL_SCOPE);
    const revisions = this.database.prepare("SELECT revision_id FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? ORDER BY captured_at DESC,revision_id DESC").pluck();
    const importedRows = new Map<string, SourceRow | undefined>();
    /** The importer's exact read of one revision of an imported meeting, verified in full once per check. */
    const imported = (sourceId: string, revisionId: string): SourceRow | undefined => {
      const key = JSON.stringify([sourceId, revisionId]);
      if (!importedRows.has(key)) importedRows.set(key, this.imported.rows(actor, GLOBAL_SCOPE, { source_id: sourceId, revision_id: revisionId })[0]);
      return importedRows.get(key);
    };
    const check = (citation: OriginalContextCitationV1): "same" | "changed" | "unreadable" => {
      if (citation.document_id !== undefined) {
        return documentMeta(citation.source_id, citation.revision_id, citation.document_id, citation.representation_sha256)?.source_sha256 === citation.source_sha256 ? "same" : "unreadable";
      }
      const row = text(citation.source_id, citation.revision_id) ?? imported(citation.source_id, citation.revision_id);
      if (row?.source_sha256 !== citation.source_sha256 || row.representation_sha256 !== citation.representation_sha256) return "unreadable";
      if (row.api_version !== 0) return "same";
      // An imported meeting's revisions newest first, by the rule the import's own list keeps (capture time, then revision
      // id), down to the cited one, which reads: changed exactly when a newer one its importer reads exists.
      for (const revisionId of revisions.all(actor.organization_id, row.source_id) as readonly string[]) {
        if (revisionId === row.revision_id) break;
        if (imported(row.source_id, revisionId) !== undefined) return "changed";
      }
      return "same";
    };
    const answers = new Map<string, "same" | "changed" | "unreadable">();
    return Object.freeze(input.citations.map((citation) => {
      const key = JSON.stringify([citation.source_id, citation.revision_id, citation.source_sha256, citation.representation_sha256, citation.document_id ?? null]);
      if (!answers.has(key)) answers.set(key, check(citation));
      return answers.get(key)!;
    }));
  }

  /** One text source revision through the caller's ACL and `scope`, prepared once for any number of reads. */
  private textSourceRead(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): (sourceId: string, revisionId: string) => SourceRow | undefined {
    const acl = this.acl(actor, "u");
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    const statement = this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at,u.audience_kind AS visibility
      FROM ${ORIGINAL_TEXT_CUSTODY_V1} u JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql} AND s.source_id=? AND r.revision_id=?`);
    return (sourceId, revisionId) => statement.get(actor.organization_id, ...acl.args, ...scoped.args, sourceId, revisionId) as SourceRow | undefined;
  }

  private textBySource(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, sourceId: string, revisionId: string): SourceRow | undefined {
    return this.textSourceRead(actor, scope)(sourceId, revisionId) ?? this.imported.rows(actor, scope, { source_id: sourceId, revision_id: revisionId })[0];
  }

  /** The cited source revision and representation must both be the row's. */
  private textByCitation(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, citation: OriginalContextCitationV1): SourceRow | undefined {
    const row = this.textBySource(actor, scope, citation.source_id, citation.revision_id);
    return row?.source_sha256 === citation.source_sha256 && row.representation_sha256 === citation.representation_sha256 ? row : undefined;
  }

  private documentAnchorByCitation(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, citation: OriginalContextCitationV1): ReleasedSourceContextAtomV1 | undefined {
    const meta = this.documentSourceMeta(actor, scope, citation.source_id, citation.revision_id, citation.document_id!, citation.representation_sha256);
    if (meta === undefined) return undefined;
    this.assertDocumentSourceRevision(meta as DocumentRow);
    const chunks = this.representationChunks(meta as DocumentRow);
    for (const chunk of this.database.prepare("SELECT ordinal,anchor_kind,anchor_start,text,extractor FROM authority_person_document_text_v1 WHERE document_id=? ORDER BY ordinal").iterate(citation.document_id!) as Iterable<Pick<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text" | "extractor">>) {
      const row = Object.freeze({ ...meta, ...chunk }) as DocumentRow;
      if (row.extractor !== meta.extractor) continue;
      const atom = this.documentAnchorForCitation(row, citation, chunks);
      if (atom !== undefined) return atom;
    }
    return undefined;
  }

  private documentSourceMeta(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, sourceId: string, revisionId: string, documentId: string, representationSha256: Sha256Digest): DocumentMeta | undefined {
    return this.documentSourceMetaRead(actor, scope)(sourceId, revisionId, documentId, representationSha256);
  }

  /** One document source revision's metadata through the caller's ACL and `scope`, prepared once for any number of reads. */
  private documentSourceMetaRead(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): (sourceId: string, revisionId: string, documentId: string, representationSha256: Sha256Digest) => DocumentMeta | undefined {
    const acl = this.acl(actor, "d");
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    const statement = this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,work.extractor,representation.content_json AS representation_json,d.received_at,d.audience_kind AS visibility
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial')
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=work.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql} AND s.source_id=? AND r.revision_id=? AND d.document_id=? AND ('sha256:' || representation.content_sha256)=?`);
    return (sourceId, revisionId, documentId, representationSha256) => statement.get(actor.organization_id, ...acl.args, ...scoped.args, sourceId, revisionId, documentId, representationSha256) as DocumentMeta | undefined;
  }
}
