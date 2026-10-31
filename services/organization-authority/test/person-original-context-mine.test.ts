import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { SqlitePersonDocumentRepositoryV1 } from "../src/adapters/persistence/sqlite/document-v1.js";
import { personOriginalScopeFilterV1 } from "../src/adapters/persistence/sqlite/person-original-access-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonTextSourceInboxV1 } from "../src/adapters/persistence/sqlite/person-text-source-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createPersonDocumentApplicationV1 } from "../src/application/document-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import type { OriginalContextDeskItemV1, PersonAskScopeV2 } from "../src/application/ports/person-original-context-retrieval-v1.js";
import { PersonDocumentProcessingV1 } from "../src/composition/person-document-processing-v1.js";
import { MEMBER, OWNER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase, seedProject, seedProjectMember } from "./fixtures/project-context-sqlite.js";

const GLOBAL: PersonAskScopeV2 = { kind: "global" };
const MINE: PersonAskScopeV2 = { kind: "mine" };

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function fixture() {
  const database = projectContextDatabase();
  databases.push(database);
  for (const projectId of [PROJECT_ALPHA, PROJECT_BETA]) seedProject(database, projectId, OWNER);
  seedProjectMember(database, PROJECT_ALPHA, MEMBER, "member");
  let clock = Date.parse(PROJECT_CONTEXT_NOW);
  const now = () => new Date(clock += 1_000).toISOString();
  const authenticate = (token: string): PersonAccessAuthorization => authorization(token === "member" ? MEMBER : OWNER);
  const projects = createProjectContextApplicationV1({ authenticate, repository: new SqliteProjectContextRepositoryV1(database, now) });
  const repository = new SqlitePersonDocumentRepositoryV1(database, now);
  const documents = createPersonDocumentApplicationV1({ repository, authenticate });
  const worker = new PersonDocumentProcessingV1(repository, undefined, new SqlitePersonTextSourceInboxV1(database, now));

  const retrieval = new SqlitePersonOriginalContextRetrievalV1(database, { authenticateAccess: ({ access_token }) => authenticate(access_token) }, OWNER.organization_id);

  const authors = new Map<string, "owner" | "member">();
  const note = async (token: "owner" | "member", text: string, audience: "team" | "only_me" = "team") => {
    const receipt = projects.submitUploadV3(token, { schema_version: 3, kind: "echo-person-update-submit-v3", request_id: randomUUID(), title: `${token} note`, text, association_project_ids: [], audience: { kind: audience } });
    expect(await worker.runOnce(new AbortController().signal)).toBe("admitted");
    authors.set(`note:${receipt.context_id}`, token);
    return receipt.context_id;
  };
  const document = (token: "owner" | "member", text: string) => {
    const bytes = Buffer.from(text);
    const saved = documents.uploadV2(token, { schema_version: 2, kind: "echo-person-document-upload-v2", request_id: randomUUID(), filename: `${token}.md`, title: `${token} document`, content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience: { kind: "team" }, association_project_ids: [] }, bytes);
    const claim = repository.claimExtraction()!;
    expect(repository.completeExtraction(claim, { status: "ready", sourceSha256: claim.source_sha256, extractorVersion: "fixture-1", chunks: [{ anchor_kind: "paragraph", anchor_start: 1, text }], message: null })).toBe(true);
    authors.set(`document:${saved.document_id}`, token);
    return saved.document_id;
  };
  const ownedBy = (items: readonly OriginalContextDeskItemV1[]) => items.map((item) => authors.get(item.ref ?? "") ?? item.ref?.split(":")[0]);
  return { database, retrieval, note, document, ownedBy };
}

describe("originals a desk read leaves out (ADR-0046)", () => {
  it("leaves out excluded sources and Only-me items before the limit, in search and inventory alike", async () => {
    const f = await fixture();
    // Ten of the owner's private notes outrank and postdate their one shared note.
    const shared = await f.note("owner", "sharedterm once");
    for (let index = 0; index < 10; index += 1) await f.note("owner", `sharedterm sharedterm sharedterm private ${index}`, "only_me");
    const search = (exclude?: { readonly source_ids: readonly string[]; readonly only_me: boolean }) =>
      f.retrieval.deskSearch({ access_token: "owner", scope: GLOBAL, query: "sharedterm", ...(exclude === undefined ? {} : { exclude }) });
    const sharedRef = `note:${shared}`;
    expect(search().items.map((item) => item.ref)).not.toContain(sharedRef);
    const fenced = search({ source_ids: [], only_me: true });
    expect(fenced.items.map((item) => [item.ref, item.visibility])).toEqual([[sharedRef, "team"]]);
    expect(fenced.truncated).toBe(false);
    // The inventory, whose rows come from a limited query, leaves them out before its limit too.
    const inventory = f.retrieval.deskSearch({ access_token: "owner", scope: GLOBAL, limit: 1, exclude: { source_ids: [], only_me: true } });
    expect(inventory.items.map((item) => item.ref)).toEqual([sharedRef]);
    // A source left out by id is never offered either.
    const sourceId = fenced.items[0]!.citation.source_id;
    expect(search({ source_ids: [sourceId], only_me: true }).items).toEqual([]);
    expect(f.retrieval.deskSearch({ access_token: "owner", scope: GLOBAL, exclude: { source_ids: [sourceId], only_me: true } }).items).toEqual([]);
  });
});

describe("originals under the mine scope", () => {
  it("searches, opens and revalidates only the caller's own notes and documents", async () => {
    const f = await fixture();
    await f.note("owner", "sharedterm owner note");
    await f.note("member", "sharedterm member note");
    f.document("owner", "sharedterm owner document");
    f.document("member", "sharedterm member document");
    const search = (token: string, scope: PersonAskScopeV2) => f.retrieval.deskSearch({ access_token: token, scope, query: "sharedterm" });

    const global = search("owner", GLOBAL);
    expect(f.ownedBy(global.items).sort()).toEqual(["member", "member", "owner", "owner"]);
    const mine = search("owner", MINE);
    expect(f.ownedBy(mine.items).sort()).toEqual(["owner", "owner"]);
    expect(f.ownedBy(search("member", MINE).items).sort()).toEqual(["member", "member"]);
    expect(f.ownedBy(f.retrieval.deskSearch({ access_token: "owner", scope: MINE }).items).sort()).toEqual(["owner", "owner"]);
    expect(() => f.retrieval.revalidateDeskRelease({ access_token: "owner", release: mine })).not.toThrow();

    // A teammate's team note is readable globally, but it is not the caller's.
    for (const item of global.items.filter((value) => f.ownedBy([value])[0] === "member")) {
      expect(f.retrieval.deskOpen({ access_token: "owner", scope: GLOBAL, citation: item.citation }).items).toHaveLength(1);
      expect(() => f.retrieval.deskOpen({ access_token: "owner", scope: MINE, citation: item.citation })).toThrow(AuthorityOperationError);
      expect(() => f.retrieval.read({ access_token: "owner", scope: MINE, citation: item.citation })).toThrow(AuthorityOperationError);
    }
    for (const item of mine.items) {
      expect(f.retrieval.deskOpen({ access_token: "owner", scope: MINE, citation: item.citation }).items[0]).toEqual(item);
    }
  });

  it("makes an unknown scope a compile error", () => {
    const actor = authorization(MEMBER);
    // @ts-expect-error A new scope kind must be handled before it compiles.
    expect(() => personOriginalScopeFilterV1("u", actor, { kind: "everyone" })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("gives every desk item the ref it opens as, and binds that ref into the release audit", async () => {
    const f = await fixture();
    const contextId = await f.note("owner", "sharedterm owner note");
    const documentId = f.document("owner", "sharedterm owner document");
    const desk = f.retrieval.deskSearch({ access_token: "owner", scope: GLOBAL, query: "sharedterm" });
    expect(desk.items.map((item) => item.ref).sort()).toEqual([`document:${documentId}`, `note:${contextId}`].sort());
    const audit = JSON.parse((f.database.prepare("SELECT body_json FROM authority_person_upload_read_audit_v1 WHERE row_sha256=?").get(desk.receipt) as { body_json: string }).body_json) as { released_metadata_sha256: string };
    expect(audit.released_metadata_sha256).toBe(canonicalSha256(desk.items.map(({ citation, kind, visibility, label, received_at, version, text, ref, dates }) => ({ citation, kind, visibility, label, received_at, version, ...(dates === undefined ? {} : { dates }), ...(text === undefined ? {} : { text_sha256: canonicalSha256(text) }), ref }))));
  });
});
