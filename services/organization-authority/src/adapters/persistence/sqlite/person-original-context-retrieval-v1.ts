import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { randomUUID } from "node:crypto";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";
import type Database from "better-sqlite3";
import { canonicalSourceContentV1, sourceContentSha256V1 } from "@echo-brain/organization-processing/core";
import { assertCanonicalMeetingDocument, type MeetingDocument } from "@echo-brain/organization-processing/core";
import type { PersonMeetingTranscriptCitationV1, PersonOpenRefV1 } from "@echo-brain/organization-api";
import type {
  ApprovedMeetingTranscriptGrantReaderV1,
  ApprovedMeetingTranscriptGrantV1,
  ApprovedMeetingTranscriptReadV1,
  OriginalContextReleaseV1,
  OriginalContextCitationV1,
  OriginalContextDeskItemV1,
  OriginalContextDeskReleaseV1,
  PersonAskScopeV2,
  PersonOriginalContextEvidenceDeskPortV1,
} from "../../../application/ports/person-original-context-retrieval-v1.js";
import { personOriginalAclV1, personOriginalGrantedProjectIdsV1, personOriginalScopeFilterV1, personUnknownScopeV1 } from "./person-original-access-v1.js";

const MAXIMUM_PACKET_BYTES = 3_072;
/** Leave room for five approved-record atoms in a 10-hit Ask query budget. */
const MAXIMUM_RESULTS_PER_QUERY = 5;
const SOURCE_ID = /^source:[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;


/** Legacy retrieval and the desk share admission/ACL joins, but retain their own matching rules and caps. */
interface OriginalRowsQueryV1 {
  readonly match: "substring" | "whole_term";
  readonly limit: number;
  readonly inventory?: true;
  readonly first_document_passage?: true;
}
const LEGACY_ORIGINAL_ROWS_V1: OriginalRowsQueryV1 = Object.freeze({ match: "substring", limit: MAXIMUM_RESULTS_PER_QUERY });
const ORIGINAL_TEXT_CUSTODY_V1 = `(SELECT request_version AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,audience_kind,audience_project_id,received_at FROM authority_person_updates_v2
  UNION ALL SELECT 1 AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,received_at FROM authority_person_updates_v1)`;

type SourceRow = {
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
type MeetingSourceRow = {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly source_content_sha256: string;
  readonly manifest_json: string;
  readonly source_content_json: string;
  readonly analysis_policy: string;
};

/** One approved, shared transcript the asker may read now, with its searchable text. */
type TranscriptCandidate = {
  readonly grant: ApprovedMeetingTranscriptGrantV1;
  readonly title: string;
  readonly body: string;
  readonly representation_sha256: Sha256Digest;
  readonly received_at: string;
};
/** The best-matching packet of one transcript for one query. */
type TranscriptHit = {
  readonly transcript: TranscriptCandidate;
  readonly source_id: string;
  readonly received_at: string;
  readonly lexical_score: number;
};

interface Sessions {
  authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization;
}

function denied(): never {
  throw new AuthorityOperationError("unauthorized", "person authentication failed");
}

function unavailable(): never {
  throw new AuthorityOperationError("unavailable", "person source retrieval is unavailable");
}

/** A record opened by ref is read with global access (ADR-0024). */
const GLOBAL_SCOPE: PersonAskScopeV2 = Object.freeze({ kind: "global" });

function transcriptCitation(grant: ApprovedMeetingTranscriptGrantV1): PersonMeetingTranscriptCitationV1 {
  return Object.freeze({
    kind: "approved_meeting_transcript", approval_id: grant.approval_id, source_id: grant.source_id as `source:${string}`,
    revision_id: grant.revision_id, source_sha256: grant.source_sha256,
  });
}

// Closed English function words only. No domain synonyms, stemming, or semantic
// expansion: project IDs, negation, numbers and subject words remain intact.
const QUERY_FUNCTION_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "can", "could", "should", "would", "will",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "they", "their",
  "this", "that", "these", "those", "of", "to", "for", "from", "in", "on",
  "at", "with", "by", "and", "or", "as", "about",
]);

function lexicalScore(title: string, text: string, terms: readonly string[]): number {
  const value = `${title}\n${text}`.normalize("NFC").toLocaleLowerCase("en-US");
  // Preserve the original substring matching contract, but rank by distinct
  // matched terms. Repetition cannot boost a source's score.
  return terms.reduce((score, term) => score + (value.includes(term) ? 1 : 0), 0);
}

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
  return terms.filter(term => !QUERY_FUNCTION_WORDS.has(term) || acronyms.has(term));
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

function matchingPacket(title: string, body: string, terms: readonly string[]): { readonly index: number; readonly text: string } {
  const values = packets(title, body);
  let index = -1;
  let bestScore = 0;
  for (let candidate = 0; candidate < values.length; candidate += 1) {
    const score = lexicalScore("", values[candidate]!, terms);
    if (score > bestScore) { bestScore = score; index = candidate; }
  }
  if (index < 0) unavailable();
  return Object.freeze({ index, text: values[index]! });
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

/** A transcript page is bounded by UTF-8 bytes and never splits a code point. */
function transcriptPage(body: string, offset: number): { readonly text: string; readonly next_offset: number | null } {
  const points = [...body.normalize("NFC")];
  if (offset >= points.length) denied();
  let end = offset;
  let bytes = 0;
  while (end < points.length) {
    const point = points[end]!;
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > MAXIMUM_PACKET_BYTES) break;
    bytes += size;
    end += 1;
  }
  if (end === offset) unavailable();
  return Object.freeze({ text: points.slice(offset, end).join(""), next_offset: end === points.length ? null : end });
}

/** Longest speaker name a transcript turn is led by, in characters. */
const MAXIMUM_SPEAKER_NAME_CHARACTERS = 120;

/**
 * A shared transcript as Ask reads it: each turn led by its speaker's display
 * name, so who said or took on what survives into search and citations
 * (ADR-0021). The names are the meeting's own participants, which the approved
 * record already shows its readers; identities (emails, provider ids) stay out.
 * A turn without a named speaker keeps its bare text.
 */
function speakerTranscript(meeting: MeetingDocument): string {
  const names = new Map<string, string>();
  for (const participant of meeting.participants) {
    const name = participant.display_name?.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
    if (name !== undefined && name.length > 0) names.set(participant.id, [...name].slice(0, MAXIMUM_SPEAKER_NAME_CHARACTERS).join(""));
  }
  return meeting.content.filter(block => block.kind === "transcript").map(block => {
    const name = block.speaker_participant_id === undefined ? undefined : names.get(block.speaker_participant_id);
    return name === undefined ? block.text : `${name}: ${block.text}`;
  }).join("\n\n");
}

/** Each transcript's best packet for these terms, when it matches at all. */
function transcriptHits(transcripts: readonly TranscriptCandidate[], terms: readonly string[]): readonly TranscriptHit[] {
  const hits: TranscriptHit[] = [];
  for (const transcript of transcripts) {
    const score = lexicalScore(transcript.title, transcript.body, terms);
    if (score > 0) hits.push(Object.freeze({ transcript, source_id: transcript.grant.source_id, received_at: transcript.received_at, lexical_score: score }));
  }
  return hits.sort((left, right) => right.lexical_score - left.lexical_score || right.received_at.localeCompare(left.received_at)).slice(0, MAXIMUM_RESULTS_PER_QUERY);
}

/** A transcript packet as released evidence. Its anchor binds the approval that shared it. */
function transcriptAtom(transcript: TranscriptCandidate, packet: { readonly index: number; readonly text: string }): ReleasedSourceContextAtomV1 {
  const { grant } = transcript;
  return Object.freeze({
    kind: "source_revision" as const, source_id: grant.source_id, revision_id: grant.revision_id, source_sha256: grant.source_sha256,
    representation_sha256: transcript.representation_sha256,
    anchor_sha256: canonicalSha256({ kind: "transcript", approval_id: grant.approval_id, segment: packet.index, text: packet.text }),
    label: presentationLabel(transcript.title), text: packet.text,
  });
}

/** A transcript passage on the desk: a note whose audience is its record's. */
function transcriptDeskItem(transcript: TranscriptCandidate, atom: ReleasedSourceContextAtomV1, includeText: boolean): OriginalContextDeskItemV1 {
  const { grant } = transcript;
  const visibility = grant.policy_id === "restricted-reviewer-person-v2" ? "only_me"
    : grant.policy_id === "project-members-readable-person-v1" ? (grant.audience_project_ids.length === 1 ? "project" : "projects")
    : "team";
  const citation: OriginalContextCitationV1 = Object.freeze({ kind: "source_revision", source_id: atom.source_id, revision_id: atom.revision_id, source_sha256: atom.source_sha256, representation_sha256: atom.representation_sha256, anchor_sha256: atom.anchor_sha256 });
  return Object.freeze({ citation, kind: "note", ...(includeText ? { text: atom.text } : {}), visibility, label: atom.label ?? "Transcript", received_at: transcript.received_at, version: atom.revision_id, ref: `transcript:${grant.record_sha256}` as const });
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
 * Reads immutable Person-upload source revisions and, since ADR-0017's
 * 2026-09-28 amendment, the transcripts an approver shared at approval.
 * Admission alone never makes a raw meeting readable through Ask: a
 * transcript is searched only under its approval grant, its current audience
 * and, for a project question, its recorded project association.
 */
export class SqlitePersonOriginalContextRetrievalV1 implements PersonOriginalContextEvidenceDeskPortV1 {
  private readonly releases = new WeakSet<OriginalContextReleaseV1>();
  private readonly deskReleases = new WeakSet<OriginalContextDeskReleaseV1>();
  constructor(
    private readonly database: Database.Database,
    private readonly sessions: Sessions,
    private readonly organizationId: string,
    private readonly transcriptOptions?: Readonly<{
      readonly authority_id: string;
      readonly state_lineage_id: string;
      readonly grants: ApprovedMeetingTranscriptGrantReaderV1;
      /** Bound by composition to the versioned policy contract registry. */
      readonly is_expected_policy_contract: (grant: ApprovedMeetingTranscriptGrantV1) => boolean;
    }>,
  ) {
    // The query parameter is a bound, adapter-created JSON array of validated terms.
    database.function("echo_original_context_score_v1", { deterministic: true }, (title, text, query) =>
      typeof title === "string" && typeof text === "string" && typeof query === "string"
        ? lexicalScore(title, text, JSON.parse(query) as readonly string[]) : 0);
    database.function("echo_original_context_whole_score_v1", { deterministic: true }, (title, text, query) =>
      typeof title === "string" && typeof text === "string" && typeof query === "string"
        ? wholeTermScore(title, text, JSON.parse(query) as readonly string[]) : 0);
  }

  retrieve(input: {
    readonly access_token: string;
    readonly queries: readonly string[];
    readonly scope: PersonAskScopeV2;
    readonly on_authorized?: () => void;
  }) {
    if (input.queries.length < 1 || input.queries.length > 4) {
      throw new AuthorityOperationError("invalid_request", "request is invalid");
    }
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    const revision = this.authorizationRevision(actor.organization_id);
    this.assertScope(actor, input.scope);
    input.on_authorized?.();
    const selected = new Map<string, ReleasedSourceContextAtomV1>();
    const transcriptKeys = new Set<string>();
    const counts: number[] = [];
    const transcripts = this.transcriptCandidates(actor, input.scope);
    for (const query of input.queries) {
      const terms = queryTerms(query);
      if (terms.length === 0) { counts.push(0); continue; }
      const rows = [
        ...this.textRows(actor, input.scope, terms),
        ...this.documentRows(actor, input.scope, terms),
        ...transcriptHits(transcripts, terms),
      ].sort((left, right) => right.lexical_score - left.lexical_score
        || right.received_at.localeCompare(left.received_at)
        || left.source_id.localeCompare(right.source_id)
        || ("ordinal" in left ? left.ordinal : 0) - ("ordinal" in right ? right.ordinal : 0)).slice(0, MAXIMUM_RESULTS_PER_QUERY);
      counts.push(rows.length);
      for (const row of rows) {
        const atom = "transcript" in row
          ? transcriptAtom(row.transcript, matchingPacket(row.transcript.title, row.transcript.body, terms))
          : "document_id" in row
          ? this.documentAtom(row, terms)
          : this.textAtom(row, terms);
        const key = `${atom.source_id}\u0000${atom.revision_id}\u0000${atom.representation_sha256}\u0000${atom.anchor_sha256}`;
        if (!selected.has(key)) selected.set(key, atom);
        if ("transcript" in row) transcriptKeys.add(key);
      }
    }
    // Observability only: how many released packets came from shared transcripts.
    annotateCoreRuntimeV1({ counts: { transcript_items: transcriptKeys.size } });
    const release: OriginalContextReleaseV1 = Object.freeze({
      authorization: Object.freeze({
        principal_id: actor.principal_id,
        membership_id: actor.membership_id,
        session_family_id: actor.session_family_id,
        checked_at: actor.checked_at,
      }),
      scope: Object.freeze({ ...input.scope }),
      authorization_revision: revision,
      released_atoms: Object.freeze([...selected.values()]),
    });
    this.releases.add(release);
    // Layer 3 must leave an immutable, content-free read witness before any
    // source text can enter a provider prompt. Revalidate every selected atom
    // first so the witness cannot describe a stale release.
    this.revalidate({ access_token: input.access_token, release });
    const audit = {
      schema_version: 1,
      kind: "echo-person-original-context-release-audit-v1",
      audit_id: randomUUID(),
      organization_id: actor.organization_id,
      principal_id: actor.principal_id,
      membership_id: actor.membership_id,
      session_family_id: actor.session_family_id,
      scope: input.scope,
      authorization_revision: revision,
      released_atoms_sha256: canonicalSha256(release.released_atoms.map((atom) => ({
        source_id: atom.source_id,
        revision_id: atom.revision_id,
        source_sha256: atom.source_sha256,
        representation_sha256: atom.representation_sha256,
        anchor_sha256: atom.anchor_sha256,
      }))),
      released_count: release.released_atoms.length,
      checked_at: actor.checked_at,
    };
    const receipt = canonicalSha256(audit);
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(receipt, canonicalJson(audit), actor.checked_at);
    return Object.freeze({ release, receipt, query_hit_counts: Object.freeze(counts) });
  }

  /**
   * Request-bound desk search.  This is intentionally distinct from V2's
   * substring matcher: whole terms and the three-passages-per-document cap
   * apply only to the new desk surface.
   */
  deskSearch(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly query?: string;
    readonly kinds?: readonly ("note" | "document_passage")[];
    readonly limit?: number;
    readonly inventory_mode?: "items";
  }): OriginalContextDeskReleaseV1 {
    const limit = input.limit ?? (input.query === undefined ? 50 : 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > (input.query === undefined ? 50 : 10)) {
      throw new AuthorityOperationError("invalid_request", "request is invalid");
    }
    if (input.inventory_mode !== undefined &&
      (input.query !== undefined || input.inventory_mode !== "items")) {
      throw new AuthorityOperationError("invalid_request", "request is invalid");
    }
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    const terms = input.query === undefined ? [] : queryTerms(input.query);
    const candidates = input.query === undefined
      ? this.deskInventoryRows(
          actor,
          input.scope,
          limit + 1,
          input.kinds,
          input.inventory_mode === "items",
        )
      : this.deskSearchRows(actor, input.scope, terms, limit + 1, input.kinds);
    // Complete-items inventory counts canonical desk packets, rather than
    // extraction rows. A single long note or extracted chunk can contain many
    // independently citable 3 KiB packets. The SQL candidates are already
    // bounded to limit+1 rows; every row has at least one packet, so expanding
    // then taking limit+1 is sufficient to prove truncation without an
    // unbounded source scan.
    const expanded: { readonly score: number; readonly received_at: string; readonly atom: ReleasedSourceContextAtomV1; readonly item: () => OriginalContextDeskItemV1; readonly transcript?: true }[] = input.inventory_mode === "items"
      ? candidates.flatMap((row) => this.deskAtoms(row, [], true).map((atom) => ({ score: 0, received_at: row.received_at, atom, item: () => this.deskItem(row, atom, false) })))
      : candidates.map((row) => { const atom = this.deskAtom(row, terms); return { score: row.lexical_score, received_at: row.received_at, atom, item: () => this.deskItem(row, atom, input.query !== undefined) }; });
    // ADR-0021: a search also reads transcripts shared at approval, as notes
    // labeled "Transcript: <meeting>", under their grant and current audience.
    if (input.query !== undefined && (input.kinds === undefined || input.kinds.includes("note"))) {
      for (const transcript of this.transcriptCandidates(actor, input.scope)) {
        const score = wholeTermScore(transcript.title, transcript.body, terms);
        if (score === 0) continue;
        const atom = transcriptAtom(transcript, wholeMatchingPacket(transcript.title, transcript.body, terms));
        expanded.push({ score, received_at: transcript.received_at, atom, item: () => transcriptDeskItem(transcript, atom, true), transcript: true });
      }
      expanded.sort((left, right) => right.score - left.score || right.received_at.localeCompare(left.received_at));
    }
    const selected = expanded.slice(0, limit);
    annotateCoreRuntimeV1({ counts: { transcript_items: selected.filter((entry) => entry.transcript === true).length } });
    const atoms = selected.map(({ atom }) => atom);
    const items = selected.map(({ item }) => item());
    return this.commitDeskRelease(actor, input.access_token, input.scope, items, atoms, expanded.length > limit);
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
      const row = this.textBySource(actor, input.scope, input.citation.source_id, input.citation.revision_id);
      if (row === undefined) {
        // A transcript passage opens with its neighbouring passages.
        const found = this.transcriptPacketForCitation(actor, input.scope, input.citation);
        if (found === undefined) denied();
        const all = packets(found.transcript.title, found.transcript.body);
        const around = [found.index - 1, found.index + 1].filter((index) => index >= 0 && index < all.length).slice(0, neighbours);
        const atoms = [found.atom, ...around.map((index) => transcriptAtom(found.transcript, { index, text: all[index]! }))];
        annotateCoreRuntimeV1({ counts: { transcript_items: atoms.length } });
        return this.commitDeskRelease(actor, input.access_token, input.scope,
          atoms.map((atom) => transcriptDeskItem(found.transcript, atom, true)), atoms);
      }
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
  }): { readonly checked_at: string } {
    if (!this.deskReleases.has(input.release)) unavailable();
    const checked = this.revalidate({ access_token: input.access_token, release: input.release.release });
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    // Batch releases keep their per-atom revalidation semantics.  The
    // request-bound desk additionally pins the authorization revision so a
    // later desk call cannot mix project-association snapshots.
    if (this.authorizationRevision(actor.organization_id) !== input.release.release.authorization_revision) denied();
    for (const item of input.release.items) {
      const atom = input.release.release.released_atoms.find((candidate) => this.citationMatches(candidate, item.citation));
      if (atom === undefined || canonicalJson(this.currentDeskItem(actor, input.release.release.scope, atom, item.text !== undefined)) !== canonicalJson(item)) denied();
    }
    return checked;
  }

  revalidate(input: { readonly access_token: string; readonly release: OriginalContextReleaseV1 }) {
    if (!this.releases.has(input.release)) unavailable();
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    if (actor.principal_id !== input.release.authorization.principal_id ||
      actor.membership_id !== input.release.authorization.membership_id ||
      actor.session_family_id !== input.release.authorization.session_family_id) denied();
    this.assertScope(actor, input.release.scope);
    for (const atom of input.release.released_atoms) this.assertReleasedAtomReadable(actor, input.release.scope, atom);
    return Object.freeze({ checked_at: actor.checked_at });
  }

  read(input: { readonly access_token: string; readonly scope: PersonAskScopeV2; readonly citation: OriginalContextCitationV1 }) {
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    let atom: ReleasedSourceContextAtomV1 | undefined;
    if (input.citation.document_id === undefined) {
      const row = this.textBySource(actor, input.scope, input.citation.source_id, input.citation.revision_id);
      atom = row !== undefined
        ? this.textAnchorForCitation(row, input.citation)
        : this.transcriptAnchorForCitation(actor, input.scope, input.citation);
    } else {
      atom = this.documentAnchorByCitation(actor, input.scope, input.citation);
    }
    if (atom === undefined) denied();
    this.auditProofRead(actor, input.scope, atom);
    return Object.freeze({ scope: Object.freeze({ ...input.scope }), atom });
  }

  readApprovedMeetingTranscript(input: {
    readonly access_token: string;
    readonly scope: PersonAskScopeV2;
    readonly citation: PersonMeetingTranscriptCitationV1;
    readonly offset?: number;
  }): ApprovedMeetingTranscriptReadV1 {
    if (this.transcriptOptions === undefined) unavailable();
    const actor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(actor);
    this.assertScope(actor, input.scope);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) unavailable();
    const grant = this.transcriptOptions.grants.find({
      authority_id: this.transcriptOptions.authority_id,
      organization_id: this.organizationId,
      state_lineage_id: this.transcriptOptions.state_lineage_id,
      approval_id: input.citation.approval_id,
    });
    if (grant === null || !this.matchesTranscriptGrant(grant, input.citation) ||
      !this.transcriptOptions.is_expected_policy_contract(grant) ||
      !this.readableTranscriptGrant(actor, input.scope, grant)) denied();
    const initialProjectGrantSnapshot = this.projectGrantSnapshot(actor, input.scope, grant);
    const row = this.meetingSource(input.citation);
    if (row === undefined) denied();
    const meeting = this.meetingContent(row);
    const body = meeting.content.filter(block => block.kind === "transcript").map(block => block.text).join("\n\n");
    if (body.length === 0) denied();
    const page = transcriptPage(body, offset);
    // The policy record is immutable, but the current actor/project grants and
    // exact retained revision are intentionally re-evaluated immediately
    // before both audit and byte release.
    const current = this.transcriptOptions.grants.find({
      authority_id: this.transcriptOptions.authority_id,
      organization_id: this.organizationId,
      state_lineage_id: this.transcriptOptions.state_lineage_id,
      approval_id: input.citation.approval_id,
    });
    const currentActor = this.sessions.authenticateAccess({ access_token: input.access_token });
    this.assertOrganization(currentActor);
    if (currentActor.organization_id !== actor.organization_id ||
      currentActor.principal_id !== actor.principal_id ||
      currentActor.membership_id !== actor.membership_id ||
      currentActor.membership_type !== actor.membership_type ||
      currentActor.identity_binding_id !== actor.identity_binding_id ||
      currentActor.session_family_id !== actor.session_family_id ||
      currentActor.access_credential_sha256 !== actor.access_credential_sha256 ||
      currentActor.person_state_sha256 !== actor.person_state_sha256 ||
      currentActor.session_state_sha256 !== actor.session_state_sha256) denied();
    this.assertScope(currentActor, input.scope);
    if (current === null || !this.sameTranscriptGrant(grant, current) ||
      !this.matchesTranscriptGrant(current, input.citation) ||
      !this.transcriptOptions.is_expected_policy_contract(current) ||
      !this.readableTranscriptGrant(currentActor, input.scope, current) ||
      this.projectGrantSnapshot(currentActor, input.scope, current) !== initialProjectGrantSnapshot) denied();
    const currentRow = this.meetingSource(input.citation);
    if (currentRow === undefined) denied();
    this.meetingContent(currentRow);
    const response = Object.freeze({ scope: Object.freeze({ ...input.scope }), citation: Object.freeze({ ...input.citation }), text: page.text, next_offset: page.next_offset });
    this.auditTranscriptRead(currentActor, response);
    return response;
  }

  probeApprovedMeetingTranscriptV1(input: {
    readonly actor: PersonAccessAuthorization;
    readonly approval_id: string;
    readonly record_sha256: Sha256Digest;
  }): boolean {
    const options = this.transcriptOptions;
    if (options === undefined) return false;
    this.assertOrganization(input.actor);
    const grant = options.grants.find({ authority_id: options.authority_id, organization_id: this.organizationId, state_lineage_id: options.state_lineage_id, approval_id: input.approval_id });
    return grant !== null && grant.record_sha256 === input.record_sha256 &&
      options.is_expected_policy_contract(grant) &&
      this.readableTranscriptGrant(input.actor, GLOBAL_SCOPE, grant) &&
      this.meetingSource(transcriptCitation(grant)) !== undefined;
  }

  /**
   * The same double-fenced, audited read as a citation, keyed by the record.
   * Callers admit the record through Layer 1 first; every miss here is the
   * same denial.
   */
  readApprovedMeetingTranscriptByRecordV1(input: {
    readonly access_token: string;
    readonly record_sha256: Sha256Digest;
    readonly offset?: number;
  }): { readonly text: string; readonly next_offset: number | null } {
    const options = this.transcriptOptions;
    if (options?.grants.findByRecord === undefined) unavailable();
    this.assertOrganization(this.sessions.authenticateAccess({ access_token: input.access_token }));
    const grant = options.grants.findByRecord({ authority_id: options.authority_id, organization_id: this.organizationId, state_lineage_id: options.state_lineage_id, record_sha256: input.record_sha256 });
    if (grant === null) denied();
    const page = this.readApprovedMeetingTranscript({
      access_token: input.access_token, scope: GLOBAL_SCOPE, citation: transcriptCitation(grant),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    });
    return Object.freeze({ text: page.text, next_offset: page.next_offset });
  }

  private assertOrganization(actor: PersonAccessAuthorization): void {
    if (actor.organization_id !== this.organizationId ||
      !this.database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type)) denied();
  }

  private authorizationRevision(organizationId: string): number {
    const row = this.database.prepare("SELECT revision FROM authority_project_authorization_state_v1 WHERE organization_id=?").get(organizationId) as { readonly revision: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.revision)) unavailable();
    return row.revision;
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
      case "mine":
        return;
      default:
        personUnknownScopeV1(scope);
    }
  }

  private matchesTranscriptGrant(grant: ApprovedMeetingTranscriptGrantV1, citation: PersonMeetingTranscriptCitationV1): boolean {
    return grant.approval_id === citation.approval_id && grant.source_id === citation.source_id &&
      grant.revision_id === citation.revision_id && grant.source_sha256 === citation.source_sha256;
  }

  private sameTranscriptGrant(left: ApprovedMeetingTranscriptGrantV1, right: ApprovedMeetingTranscriptGrantV1): boolean {
    return canonicalJson({
      approval_id: left.approval_id, record_position: left.record_position, record_sha256: left.record_sha256,
      policy_id: left.policy_id, policy_contract_sha256: left.policy_contract_sha256,
      source_id: left.source_id, revision_id: left.revision_id, source_sha256: left.source_sha256,
      reviewer_principal_id: left.reviewer_principal_id, reviewer_membership_id: left.reviewer_membership_id,
      audience_project_ids: left.audience_project_ids, association_project_ids: left.association_project_ids,
    }) === canonicalJson({
      approval_id: right.approval_id, record_position: right.record_position, record_sha256: right.record_sha256,
      policy_id: right.policy_id, policy_contract_sha256: right.policy_contract_sha256,
      source_id: right.source_id, revision_id: right.revision_id, source_sha256: right.source_sha256,
      reviewer_principal_id: right.reviewer_principal_id, reviewer_membership_id: right.reviewer_membership_id,
      audience_project_ids: right.audience_project_ids, association_project_ids: right.association_project_ids,
    });
  }

  private projectGrantSnapshot(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, grant: ApprovedMeetingTranscriptGrantV1): Sha256Digest {
    const activeGrant = (projectId: string): Record<string, unknown> | undefined => this.database.prepare(
      "SELECT project_membership_id,project_id,principal_id,membership_id,membership_type,role,granted_at FROM authority_project_memberships_v1 WHERE organization_id=? AND project_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'",
    ).get(actor.organization_id, projectId, actor.principal_id, actor.membership_id, actor.membership_type) as Record<string, unknown> | undefined;
    // A project-policy audience is a union: retaining any selected project is
    // sufficient. Snapshot only the grants that currently authorize this
    // caller, while scope remains an independently required grant.
    const scope_grant = scope.kind === "project" ? activeGrant(scope.project_id) : null;
    if (scope.kind === "project" && scope_grant === undefined) denied();
    const audience_grants = grant.policy_id !== "project-members-readable-person-v1"
      ? []
      : grant.audience_project_ids.map(activeGrant).filter((row): row is Record<string, unknown> => row !== undefined)
        .sort((left, right) => String(left.project_id).localeCompare(String(right.project_id)));
    if (grant.policy_id === "project-members-readable-person-v1" && audience_grants.length === 0) denied();
    return canonicalSha256({ scope_grant, audience_grants });
  }

  private readableTranscriptGrant(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, grant: ApprovedMeetingTranscriptGrantV1): boolean {
    switch (scope.kind) {
      // A shared transcript is not something the caller added (ADR-0024, v1).
      case "mine":
        return false;
      case "project":
        if (!grant.association_project_ids.includes(scope.project_id) || !this.projectGrant(actor, scope.project_id)) return false;
        break;
      case "global":
        break;
      default:
        personUnknownScopeV1(scope);
    }
    if (grant.policy_id === "organization-member-readable-person-v2") return true;
    if (grant.policy_id === "restricted-reviewer-person-v2") {
      return actor.principal_id === grant.reviewer_principal_id && actor.membership_id === grant.reviewer_membership_id;
    }
    if (grant.policy_id === "project-members-readable-person-v1") {
      return grant.audience_project_ids.some(projectId => this.projectGrant(actor, projectId));
    }
    return false;
  }

  private meetingSource(citation: PersonMeetingTranscriptCitationV1): MeetingSourceRow | undefined {
    const row = this.database.prepare(`SELECT source.source_id,revision.revision_id,('sha256:' || revision.revision_sha256) AS source_sha256,revision.content_sha256 AS source_content_sha256,revision.manifest_json,content.content_json AS source_content_json,source.analysis_policy
      FROM authority_sources_v1 source
      JOIN authority_source_revisions_v1 revision ON revision.organization_id=source.organization_id AND revision.source_id=source.source_id
      JOIN authority_source_contents_v1 content ON content.organization_id=revision.organization_id AND content.source_id=revision.source_id AND content.revision_id=revision.revision_id
      WHERE source.organization_id=? AND source.source_id=? AND revision.revision_id=? AND source.analysis_policy='automatic'`).get(this.organizationId, citation.source_id, citation.revision_id) as MeetingSourceRow | undefined;
    if (row === undefined || row.source_sha256 !== citation.source_sha256 || !SOURCE_ID.test(row.source_id) || !SHA256.test(row.source_sha256)) return undefined;
    return row;
  }

  private meetingContent(row: MeetingSourceRow): MeetingDocument {
    const content = this.assertRevisionEnvelope(row as Pick<SourceRow, "source_sha256" | "source_content_sha256" | "manifest_json" | "source_content_json">);
    try {
      const manifest = JSON.parse(row.manifest_json) as { readonly captured_at?: unknown };
      if (typeof manifest.captured_at !== "string" || content === null || typeof content !== "object" || Array.isArray(content)) unavailable();
      const sourceContent = content as { readonly provenance?: unknown };
      if (sourceContent.provenance === null || typeof sourceContent.provenance !== "object" || Array.isArray(sourceContent.provenance)) unavailable();
      const meeting = { ...sourceContent, provenance: { ...(sourceContent.provenance as Record<string, unknown>), observed_at: manifest.captured_at } };
      assertCanonicalMeetingDocument(meeting);
      return meeting;
    } catch { unavailable(); }
  }

  private auditTranscriptRead(actor: PersonAccessAuthorization, response: ApprovedMeetingTranscriptReadV1): void {
    const body = { schema_version: 1, kind: "echo-person-approved-meeting-transcript-read-audit-v1", audit_id: randomUUID(), organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, scope: response.scope, approval_id: response.citation.approval_id, source_id: response.citation.source_id, revision_id: response.citation.revision_id, source_sha256: response.citation.source_sha256, page_sha256: canonicalSha256(response.text), response_sha256: canonicalSha256({ schema_version: 1, kind: "echo-person-meeting-transcript-v1", ...response }), checked_at: actor.checked_at };
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(canonicalSha256(body), canonicalJson(body), actor.checked_at);
  }

  /**
   * The shared transcripts this asker may read now in this scope: each grant's
   * policy contract, current audience and project association are checked,
   * and its exact retained revision is re-verified before any text is scored.
   */
  private transcriptCandidates(
    actor: PersonAccessAuthorization,
    scope: PersonAskScopeV2,
    source?: { readonly source_id: string; readonly revision_id: string; readonly source_sha256: Sha256Digest },
  ): readonly TranscriptCandidate[] {
    const options = this.transcriptOptions;
    if (options?.grants.list === undefined) return Object.freeze([]);
    const grants = options.grants.list({
      authority_id: options.authority_id,
      organization_id: this.organizationId,
      state_lineage_id: options.state_lineage_id,
      ...(source === undefined ? {} : source),
    });
    const candidates: TranscriptCandidate[] = [];
    for (const grant of grants) {
      if (!options.is_expected_policy_contract(grant) || !this.readableTranscriptGrant(actor, scope, grant)) continue;
      const row = this.meetingSource({ kind: "approved_meeting_transcript", approval_id: grant.approval_id, source_id: grant.source_id as `source:${string}`, revision_id: grant.revision_id, source_sha256: grant.source_sha256 });
      if (row === undefined) continue;
      const meeting = this.meetingContent(row);
      const body = speakerTranscript(meeting);
      if (body.length === 0) continue;
      const title = `Transcript: ${meeting.title?.trim() || "Untitled meeting"}`;
      candidates.push(Object.freeze({
        grant, title, body,
        representation_sha256: canonicalSha256({ kind: "meeting-transcript-v1", approval_id: grant.approval_id, text: body }),
        received_at: meeting.provenance.observed_at,
      }));
    }
    return Object.freeze(candidates);
  }

  /** A transcript packet an existing citation names, if the asker may still read it here. */
  private transcriptAnchorForCitation(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, citation: OriginalContextCitationV1): ReleasedSourceContextAtomV1 | undefined {
    return this.transcriptPacketForCitation(actor, scope, citation)?.atom;
  }

  private transcriptPacketForCitation(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, citation: OriginalContextCitationV1): { readonly transcript: TranscriptCandidate; readonly index: number; readonly atom: ReleasedSourceContextAtomV1 } | undefined {
    if (!SOURCE_ID.test(citation.source_id) || !SHA256.test(citation.source_sha256)) return undefined;
    const source = { source_id: citation.source_id, revision_id: citation.revision_id, source_sha256: citation.source_sha256 };
    for (const transcript of this.transcriptCandidates(actor, scope, source)) {
      if (transcript.representation_sha256 !== citation.representation_sha256) continue;
      for (const [index, text] of packets(transcript.title, transcript.body).entries()) {
        const atom = transcriptAtom(transcript, { index, text });
        if (this.citationMatches(atom, citation)) return Object.freeze({ transcript, index, atom });
      }
    }
    return undefined;
  }

  private acl(actor: PersonAccessAuthorization, prefix: "u" | "d"): { readonly sql: string; readonly args: readonly string[] } {
    return personOriginalAclV1(prefix, actor, personOriginalGrantedProjectIdsV1(this.database, actor));
  }

  private deskSearchRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], limit: number, kinds: readonly ("note" | "document_passage")[] | undefined): readonly (SourceRow | DocumentRow)[] {
    const candidates = [...this.textRows(actor, scope, terms, { match: "whole_term", limit: 100 }), ...this.documentRows(actor, scope, terms, { match: "whole_term", limit: 100 })]
      .filter((row) => kinds === undefined || kinds.includes("document_id" in row ? "document_passage" : "note"))
      .sort((left, right) => right.lexical_score - left.lexical_score || right.received_at.localeCompare(left.received_at) || left.source_id.localeCompare(right.source_id) || ("ordinal" in left ? left.ordinal : 0) - ("ordinal" in right ? right.ordinal : 0));
    const documents = new Map<string, number>();
    const selected: (SourceRow | DocumentRow)[] = [];
    for (const row of candidates) {
      if ("document_id" in row) {
        const count = documents.get(row.document_id) ?? 0;
        if (count >= 3) continue;
        documents.set(row.document_id, count + 1);
      }
      selected.push(row);
      if (selected.length === limit) break;
    }
    return Object.freeze(selected);
  }

  private deskInventoryRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, limit: number, kinds: readonly ("note" | "document_passage")[] | undefined, allDocumentPassages: boolean): readonly (SourceRow | DocumentRow)[] {
    // Ordinary source inventory exposes one stable representative passage per
    // document. The internal complete-items mode needs every readable atom,
    // but fetches only limit+1 rows from each sorted source before merging.
    const sourceLimit = allDocumentPassages ? limit : 100;
    const candidates = [
      ...this.textRows(actor, scope, [], { match: "whole_term", inventory: true, limit: sourceLimit }),
      ...this.documentRows(actor, scope, [], { match: "whole_term", inventory: true, limit: sourceLimit, ...(allDocumentPassages ? {} : { first_document_passage: true }) }),
    ]
      .filter((row) => kinds === undefined || kinds.includes("document_id" in row ? "document_passage" : "note"))
      .sort((left, right) => right.received_at.localeCompare(left.received_at) || left.source_id.localeCompare(right.source_id) || ("ordinal" in left ? left.ordinal : 0) - ("ordinal" in right ? right.ordinal : 0));
    const documents = new Set<string>();
    const selected: (SourceRow | DocumentRow)[] = [];
    for (const row of candidates) {
      if (!allDocumentPassages && "document_id" in row) {
        if (documents.has(row.document_id)) continue;
        documents.add(row.document_id);
      }
      selected.push(row);
      if (selected.length === limit) break;
    }
    return Object.freeze(selected);
  }

  private deskAtom(row: SourceRow | DocumentRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    return this.deskAtoms(row, terms, false)[0]!;
  }

  private deskAtoms(row: SourceRow | DocumentRow, terms: readonly string[], allPackets: boolean): readonly ReleasedSourceContextAtomV1[] {
    const selected = allPackets
      ? packets(row.title, row.text).map((text, index) => ({ index, text }))
      : [wholeMatchingPacket(row.title, row.text, terms)];
    this.assertIntegrity(row);
    if ("document_id" in row) {
      this.assertDocumentSourceRevision(row);
      this.assertDocumentChunk(row, this.representationChunks(row));
    } else this.assertTextSourceRevision(row);
    return Object.freeze(selected.map((packet) => originalPacketAtomV1(row, packet)));
  }

  private deskItem(row: SourceRow | DocumentRow, atom: ReleasedSourceContextAtomV1, includeText: boolean): OriginalContextDeskItemV1 {
    const visibility = row.visibility;
    if (visibility !== "only_me" && visibility !== "team" && visibility !== "project" && visibility !== "projects") unavailable();
    const citation: OriginalContextCitationV1 = Object.freeze({ kind: "source_revision", source_id: atom.source_id, revision_id: atom.revision_id, source_sha256: atom.source_sha256, representation_sha256: atom.representation_sha256, anchor_sha256: atom.anchor_sha256, ...(atom.document_id === undefined ? {} : { document_id: atom.document_id }) });
    const ref = (atom.document_id === undefined ? `note:${(row as SourceRow).context_id}` : `document:${atom.document_id}`) as PersonOpenRefV1;
    return Object.freeze({ citation, kind: atom.document_id === undefined ? "note" : "document_passage", ...(includeText ? { text: atom.text } : {}), visibility, label: atom.label ?? "Saved context", received_at: row.received_at, version: atom.revision_id, ref });
  }

  private currentDeskItem(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, atom: ReleasedSourceContextAtomV1, includeText: boolean): OriginalContextDeskItemV1 {
    if (atom.document_id === undefined) {
      const row = this.textBySource(actor, scope, atom.source_id, atom.revision_id);
      if (row === undefined) {
        const found = this.transcriptPacketForCitation(actor, scope, atom);
        if (found === undefined || found.atom.text !== atom.text) denied();
        return transcriptDeskItem(found.transcript, atom, includeText);
      }
      return this.deskItem(row, atom, includeText);
    }
    const row = this.documentSourceMeta(actor, scope, atom.source_id, atom.revision_id, atom.document_id, atom.representation_sha256);
    if (row === undefined) denied();
    return this.deskItem(row as DocumentRow, atom, includeText);
  }

  private commitDeskRelease(actor: PersonAccessAuthorization, accessToken: string, scope: PersonAskScopeV2, items: readonly OriginalContextDeskItemV1[], atoms: readonly ReleasedSourceContextAtomV1[], truncated = false): OriginalContextDeskReleaseV1 {
    const release: OriginalContextReleaseV1 = Object.freeze({ authorization: Object.freeze({ principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, checked_at: actor.checked_at }), scope: Object.freeze({ ...scope }), authorization_revision: this.authorizationRevision(actor.organization_id), released_atoms: Object.freeze([...atoms]) });
    this.releases.add(release);
    this.revalidate({ access_token: accessToken, release });
    const audit = { schema_version: 1, kind: "echo-person-original-context-desk-release-audit-v1", audit_id: randomUUID(), organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, scope, authorization_revision: release.authorization_revision, released_atoms_sha256: canonicalSha256(atoms.map(({ source_id, revision_id, source_sha256, representation_sha256, anchor_sha256 }) => ({ source_id, revision_id, source_sha256, representation_sha256, anchor_sha256 }))), released_metadata_sha256: canonicalSha256(items.map(({ citation, kind, visibility, label, received_at, version, text, ref }) => ({ citation, kind, visibility, label, received_at, version, ...(text === undefined ? {} : { text_sha256: canonicalSha256(text) }), ...(ref === undefined ? {} : { ref }) }))), released_count: items.length, checked_at: actor.checked_at };
    const receipt = canonicalSha256(audit);
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(receipt, canonicalJson(audit), actor.checked_at);
    const result: OriginalContextDeskReleaseV1 = Object.freeze({ release, receipt, items: Object.freeze([...items]), truncated });
    this.deskReleases.add(result);
    return result;
  }

  private textRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], query: OriginalRowsQueryV1 = LEGACY_ORIGINAL_ROWS_V1): readonly SourceRow[] {
    const acl = this.acl(actor, "u");
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    const score = query.match === "substring" ? "echo_original_context_score_v1" : "echo_original_context_whole_score_v1";
    const visibility = query.match === "substring" ? "" : "u.audience_kind AS visibility,";
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at,${visibility}${score}(u.title,u.text,?) AS lexical_score
      FROM ${ORIGINAL_TEXT_CUSTODY_V1} u
      JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql} ${query.inventory === true ? "" : "AND lexical_score > 0"}
      ORDER BY lexical_score DESC,u.received_at DESC,s.source_id LIMIT ?`;
    return this.database.prepare(sql).all(JSON.stringify(terms), actor.organization_id, ...acl.args, ...scoped.args, query.limit) as readonly SourceRow[];
  }

  private documentRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[], query: OriginalRowsQueryV1 = LEGACY_ORIGINAL_ROWS_V1): readonly DocumentRow[] {
    const acl = this.acl(actor, "d");
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    const score = query.match === "substring" ? "echo_original_context_score_v1" : "echo_original_context_whole_score_v1";
    const visibility = query.match === "substring" ? "" : "d.audience_kind AS visibility,";
    const firstChunk = query.first_document_passage === true ? "AND t.ordinal=(SELECT MIN(first_t.ordinal) FROM authority_person_document_text_v1 first_t WHERE first_t.document_id=d.document_id AND first_t.extractor=t.extractor)" : "";
    // Matching and packet titles use the verified filename, never a display title.
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,t.ordinal,t.anchor_kind,t.anchor_start,t.text,t.extractor,representation.content_json AS representation_json,d.received_at,${visibility}${score}(d.filename,t.text,?) AS lexical_score
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_text_v1 t ON t.document_id=d.document_id
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial') AND work.extractor=t.extractor
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=t.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql} ${query.inventory === true ? "" : "AND lexical_score > 0"} ${firstChunk}
      ORDER BY lexical_score DESC,d.received_at DESC,s.source_id,t.ordinal LIMIT ?`;
    return this.database.prepare(sql).all(JSON.stringify(terms), actor.organization_id, ...acl.args, ...scoped.args, query.limit) as readonly DocumentRow[];
  }

  private textAtom(row: SourceRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    this.assertIntegrity(row);
    this.assertTextSourceRevision(row);
    const selected = matchingPacket(row.title, row.text, terms);
    return originalPacketAtomV1(row, selected);
  }

  private documentAtom(row: DocumentRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    this.assertIntegrity(row);
    this.assertDocumentSourceRevision(row);
    this.assertDocumentChunk(row, this.representationChunks(row));
    const selected = matchingPacket(row.title, row.text, terms);
    return originalPacketAtomV1(row, selected);
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
      const row = this.textBySource(actor, scope, atom.source_id, atom.revision_id);
      if (row !== undefined ? !this.hasTextAnchor(row, atom) : this.transcriptAnchorForCitation(actor, scope, atom)?.text !== atom.text) denied();
      return;
    }
    if (!this.hasDocumentAnchorByCitation(actor, scope, atom)) denied();
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
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(canonicalSha256(body), canonicalJson(body), actor.checked_at);
  }

  private textBySource(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, sourceId: string, revisionId: string): SourceRow | undefined {
    const acl = this.acl(actor, "u");
    const scoped = personOriginalScopeFilterV1("u", actor, scope);
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at,u.audience_kind AS visibility
      FROM ${ORIGINAL_TEXT_CUSTODY_V1} u JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scoped.sql} AND s.source_id=? AND r.revision_id=?`).get(actor.organization_id, ...acl.args, ...scoped.args, sourceId, revisionId) as SourceRow | undefined;
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

  private hasDocumentAnchorByCitation(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, atom: ReleasedSourceContextAtomV1): boolean {
    return this.documentAnchorByCitation(actor, scope, atom) !== undefined;
  }

  private documentSourceMeta(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, sourceId: string, revisionId: string, documentId: string, representationSha256: Sha256Digest): Omit<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text"> | undefined {
    const acl = this.acl(actor, "d");
    const scoped = personOriginalScopeFilterV1("d", actor, scope);
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,work.extractor,representation.content_json AS representation_json,d.received_at,d.audience_kind AS visibility
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial')
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=work.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scoped.sql} AND s.source_id=? AND r.revision_id=? AND d.document_id=? AND ('sha256:' || representation.content_sha256)=?`).get(actor.organization_id, ...acl.args, ...scoped.args, sourceId, revisionId, documentId, representationSha256) as Omit<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text"> | undefined;
  }
}
