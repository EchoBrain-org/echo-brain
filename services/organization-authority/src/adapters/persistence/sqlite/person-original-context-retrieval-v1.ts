import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { randomUUID } from "node:crypto";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import type { ReleasedSourceContextAtomV1 } from "@echo-brain/organization-authority-kernel/shared/released-source-context-v1";
import type Database from "better-sqlite3";
import { canonicalSourceContentV1, sourceContentSha256V1 } from "@echo-brain/organization-processing/core";
import type {
  OriginalContextReleaseV1,
  OriginalContextCitationV1,
  PersonAskScopeV2,
  PersonOriginalContextRetrievalPortV1,
} from "../../../application/ports/person-original-context-retrieval-v1.js";

const MAXIMUM_PACKET_BYTES = 3_072;
/** Leave room for five approved-record atoms in a 10-hit Ask query budget. */
const MAXIMUM_RESULTS_PER_QUERY = 5;
const SOURCE_ID = /^source:[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

/**
 * Reads only immutable Person-upload source revisions. Meeting/source adapters
 * are intentionally excluded here: admission alone never makes raw meetings
 * readable through Ask.
 */
export class SqlitePersonOriginalContextRetrievalV1 implements PersonOriginalContextRetrievalPortV1 {
  private readonly releases = new WeakSet<OriginalContextReleaseV1>();
  constructor(
    private readonly database: Database.Database,
    private readonly sessions: Sessions,
    private readonly organizationId: string,
  ) {
    // The query parameter is a bound, adapter-created JSON array of validated terms.
    database.function("echo_original_context_score_v1", { deterministic: true }, (title, text, query) =>
      typeof title === "string" && typeof text === "string" && typeof query === "string"
        ? lexicalScore(title, text, JSON.parse(query) as readonly string[]) : 0);
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
    const counts: number[] = [];
    for (const query of input.queries) {
      const terms = queryTerms(query);
      if (terms.length === 0) { counts.push(0); continue; }
      const rows = [
        ...this.textRows(actor, input.scope, terms),
        ...this.documentRows(actor, input.scope, terms),
      ].sort((left, right) => right.lexical_score - left.lexical_score
        || right.received_at.localeCompare(left.received_at)
        || left.source_id.localeCompare(right.source_id)
        || ("ordinal" in left ? left.ordinal : 0) - ("ordinal" in right ? right.ordinal : 0)).slice(0, MAXIMUM_RESULTS_PER_QUERY);
      counts.push(rows.length);
      for (const row of rows) {
        const atom = "document_id" in row
          ? this.documentAtom(row, terms)
          : this.textAtom(row, terms);
        const key = `${atom.source_id}\u0000${atom.revision_id}\u0000${atom.representation_sha256}\u0000${atom.anchor_sha256}`;
        if (!selected.has(key)) selected.set(key, atom);
      }
    }
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
    this.database.prepare("INSERT INTO authority_person_upload_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)").run(canonicalSha256(audit), canonicalJson(audit), actor.checked_at);
    return Object.freeze({ release, query_hit_counts: Object.freeze(counts) });
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
      if (row !== undefined) atom = this.textAnchorForCitation(row, input.citation);
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

  private authorizationRevision(organizationId: string): number {
    const row = this.database.prepare("SELECT revision FROM authority_project_authorization_state_v1 WHERE organization_id=?").get(organizationId) as { readonly revision: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.revision)) unavailable();
    return row.revision;
  }

  private projectGrant(actor: PersonAccessAuthorization, projectId: string): boolean {
    return this.database.prepare("SELECT 1 FROM authority_project_memberships_v1 WHERE organization_id=? AND project_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(actor.organization_id, projectId, actor.principal_id, actor.membership_id, actor.membership_type) !== undefined;
  }

  private assertScope(actor: PersonAccessAuthorization, scope: PersonAskScopeV2): void {
    if (scope.kind === "project" && !this.projectGrant(actor, scope.project_id)) denied();
  }

  private acl(actor: PersonAccessAuthorization, prefix: "u" | "d"): { readonly sql: string; readonly args: readonly string[] } {
    const projects = this.database.prepare("SELECT project_id FROM authority_project_memberships_v1 WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").all(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) as readonly { readonly project_id: string }[];
    const ids = projects.map((row) => row.project_id);
    return Object.freeze({
      sql: `(${prefix}.audience_kind='team' OR (${prefix}.audience_kind='only_me' AND ${prefix}.membership_id=?) OR (${prefix}.audience_kind='project' AND ${prefix}.audience_project_id IN (${ids.map(() => "?").join(",") || "NULL"})) OR (${prefix}.audience_kind='projects' AND EXISTS (SELECT 1 FROM ${prefix === 'u' ? 'authority_person_update_audience_projects_v1' : 'authority_person_document_audience_projects_v1'} audience_project WHERE audience_project.${prefix === 'u' ? 'context_id' : 'document_id'}=${prefix}.${prefix === 'u' ? 'context_id' : 'document_id'} AND audience_project.organization_id=${prefix}.organization_id AND audience_project.project_id IN (${ids.map(() => "?").join(",") || "NULL"}))))`,
      args: [actor.membership_id, ...ids, ...ids],
    });
  }

  private textRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[]): readonly SourceRow[] {
    const acl = this.acl(actor, "u");
    const scopeSql = scope.kind === "project"
      ? "AND EXISTS (SELECT 1 FROM authority_project_context_associations_v1 association WHERE association.context_id=u.context_id AND association.organization_id=u.organization_id AND association.project_id=?)"
      : "";
    const updates = `(SELECT request_version AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,audience_kind,audience_project_id,received_at FROM authority_person_updates_v2
      UNION ALL SELECT 1 AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,received_at FROM authority_person_updates_v1)`;
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at,echo_original_context_score_v1(u.title,u.text,?) AS lexical_score
      FROM ${updates} u
      JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scopeSql}
        AND lexical_score > 0
      ORDER BY lexical_score DESC,u.received_at DESC,s.source_id LIMIT ?`;
    const args = [JSON.stringify(terms), actor.organization_id, ...acl.args, ...(scope.kind === "project" ? [scope.project_id] : []), MAXIMUM_RESULTS_PER_QUERY];
    return this.database.prepare(sql).all(...args) as readonly SourceRow[];
  }

  private documentRows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, terms: readonly string[]): readonly DocumentRow[] {
    const acl = this.acl(actor, "d");
    const scopeSql = scope.kind === "project"
      ? "AND EXISTS (SELECT 1 FROM authority_person_document_associations_v1 association WHERE association.document_id=d.document_id AND association.organization_id=d.organization_id AND association.project_id=?)"
      : "";
    // The admitted source binds filename, but not the document's display title.
    // Use the verified filename for both matching and the packet's title field.
    const sql = `SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,t.ordinal,t.anchor_kind,t.anchor_start,t.text,t.extractor,representation.content_json AS representation_json,d.received_at,echo_original_context_score_v1(d.filename,t.text,?) AS lexical_score
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_text_v1 t ON t.document_id=d.document_id
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial') AND work.extractor=t.extractor
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=t.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scopeSql}
        AND lexical_score > 0
      ORDER BY lexical_score DESC,d.received_at DESC,s.source_id,t.ordinal LIMIT ?`;
    const args = [JSON.stringify(terms), actor.organization_id, ...acl.args, ...(scope.kind === "project" ? [scope.project_id] : []), MAXIMUM_RESULTS_PER_QUERY];
    return this.database.prepare(sql).all(...args) as readonly DocumentRow[];
  }

  private textAtom(row: SourceRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    this.assertIntegrity(row);
    this.assertTextSourceRevision(row);
    const selected = matchingPacket(row.title, row.text, terms);
    return Object.freeze({ kind: "source_revision" as const, source_id: row.source_id, revision_id: row.revision_id, source_sha256: row.source_sha256, representation_sha256: row.representation_sha256, anchor_sha256: canonicalSha256({ kind: "text", context_id: row.context_id, segment: selected.index, text: selected.text }), label: row.title, text: selected.text });
  }

  private documentAtom(row: DocumentRow, terms: readonly string[]): ReleasedSourceContextAtomV1 {
    this.assertIntegrity(row);
    this.assertDocumentSourceRevision(row);
    this.assertDocumentChunk(row, this.representationChunks(row));
    const selected = matchingPacket(row.title, row.text, terms);
    return Object.freeze({ kind: "source_revision" as const, source_id: row.source_id, revision_id: row.revision_id, source_sha256: row.source_sha256, representation_sha256: row.representation_sha256, anchor_sha256: canonicalSha256({ kind: "document", document_id: row.document_id, ordinal: row.ordinal, anchor_kind: row.anchor_kind, anchor_start: row.anchor_start, segment: selected.index, text: selected.text }), document_id: row.document_id, label: presentationLabel(row.title), text: selected.text });
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
      if (row === undefined || !this.hasTextAnchor(row, atom)) denied();
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
      const atom = Object.freeze({ kind: "source_revision" as const, source_id: row.source_id, revision_id: row.revision_id, source_sha256: row.source_sha256, representation_sha256: row.representation_sha256, anchor_sha256: canonicalSha256({ kind: "text", context_id: row.context_id, segment, text }), label: row.title, text });
      if (this.citationMatches(atom, citation)) return atom;
    }
    return undefined;
  }

  private documentAnchorForCitation(row: DocumentRow, citation: OriginalContextCitationV1, chunks: readonly unknown[]): ReleasedSourceContextAtomV1 | undefined {
    const represented = chunks[row.ordinal] as Record<string, unknown> | undefined;
    if (represented?.anchor_kind !== row.anchor_kind || represented.anchor_start !== row.anchor_start || represented.text !== row.text) unavailable();
    for (const [segment, text] of packets(row.title, row.text).entries()) {
      const atom = Object.freeze({ kind: "source_revision" as const, source_id: row.source_id, revision_id: row.revision_id, source_sha256: row.source_sha256, representation_sha256: row.representation_sha256, anchor_sha256: canonicalSha256({ kind: "document", document_id: row.document_id, ordinal: row.ordinal, anchor_kind: row.anchor_kind, anchor_start: row.anchor_start, segment, text }), document_id: row.document_id, label: presentationLabel(row.title), text });
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
    const scopeSql = scope.kind === "project" ? "AND EXISTS (SELECT 1 FROM authority_project_context_associations_v1 association WHERE association.context_id=u.context_id AND association.organization_id=u.organization_id AND association.project_id=?)" : "";
    const updates = `(SELECT request_version AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,audience_kind,audience_project_id,received_at FROM authority_person_updates_v2
      UNION ALL SELECT 1 AS api_version,organization_id,principal_id,membership_id,membership_type,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,received_at FROM authority_person_updates_v1)`;
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || r.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,u.api_version,u.context_id,u.title,u.text,u.received_at
      FROM ${updates} u JOIN authority_sources_v1 s ON s.organization_id=u.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=u.context_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=u.payload_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      WHERE u.organization_id=? AND ${acl.sql} ${scopeSql} AND s.source_id=? AND r.revision_id=?`).get(actor.organization_id, ...acl.args, ...(scope.kind === "project" ? [scope.project_id] : []), sourceId, revisionId) as SourceRow | undefined;
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
    const scopeSql = scope.kind === "project" ? "AND EXISTS (SELECT 1 FROM authority_person_document_associations_v1 association WHERE association.document_id=d.document_id AND association.organization_id=d.organization_id AND association.project_id=?)" : "";
    return this.database.prepare(`SELECT s.source_id,r.revision_id,('sha256:' || r.revision_sha256) AS source_sha256,('sha256:' || representation.content_sha256) AS representation_sha256,r.content_sha256 AS source_content_sha256,r.manifest_json,content.content_json AS source_content_json,d.document_id,d.filename AS title,d.filename,d.original_sha256,d.original_size,d.detected_media_type,work.extractor,representation.content_json AS representation_json,d.received_at
      FROM authority_person_documents_v1 d
      JOIN authority_person_document_work_v1 work ON work.document_id=d.document_id AND work.state='complete' AND work.extraction_state IN ('ready','partial')
      JOIN authority_sources_v1 s ON s.organization_id=d.organization_id AND s.adapter_id='person' AND s.instance_id='authority-inbox' AND s.external_id=d.document_id
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id AND r.revision_id=d.original_sha256
      JOIN authority_source_contents_v1 content ON content.organization_id=r.organization_id AND content.source_id=r.source_id AND content.revision_id=r.revision_id
      JOIN authority_source_representations_v1 representation ON representation.organization_id=r.organization_id AND representation.source_id=r.source_id AND representation.revision_id=r.revision_id AND representation.processor_version=work.extractor
      WHERE d.organization_id=? AND ${acl.sql} ${scopeSql} AND s.source_id=? AND r.revision_id=? AND d.document_id=? AND ('sha256:' || representation.content_sha256)=?`).get(actor.organization_id, ...acl.args, ...(scope.kind === "project" ? [scope.project_id] : []), sourceId, revisionId, documentId, representationSha256) as Omit<DocumentRow, "ordinal" | "anchor_kind" | "anchor_start" | "text"> | undefined;
  }
}
