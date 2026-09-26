import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteProjectContextRepositoryV1,
} from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { decodeProjectCursorV1 } from "../src/adapters/persistence/sqlite/project-context-cursor-v1.js";
import type { PersonUpdateSubmitV2, PersonUploadAudienceV2, ProjectIdV1 } from "@echo-brain/organization-api";
import type {
  ProjectAuthorizationScopeV1,
  ProjectContextReadTransactionV1,
  ProjectContextWriteTransactionV1,
} from "../src/application/ports/project-context-v1.js";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import {
  MEMBER,
  OUTSIDE_ORGANIZATION,
  OWNER,
  PROJECT_CONTEXT_NOW,
  RETURNED_MEMBER,
  addMembership,
  authorization,
  insertLegacyTextV1,
  projectContextDatabase,
  revokeMembership,
} from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function open(path = ":memory:"): { database: Database.Database; repository: SqliteProjectContextRepositoryV1 } {
  const database = projectContextDatabase(path);
  databases.push(database);
  return { database, repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW) };
}

function snapshot<T extends ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1>(
  transaction: T,
  actor: AuthorityPersonMembershipBinding,
  scope: ProjectAuthorizationScopeV1,
) {
  return transaction.captureAuthorization(authorization(actor), scope);
}

function createProject(repository: SqliteProjectContextRepositoryV1, actor = OWNER, number = 1) {
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-create-v1" as const,
    request_id: requestId(number),
    name: `Project ${number}`,
  };
  return repository.withWriteTransaction(transaction =>
    transaction.createProject(snapshot(transaction, actor, { operation: "create", request }), request),
  );
}

function submit(repository: SqliteProjectContextRepositoryV1, projectId: ProjectIdV1 | null, audience: PersonUploadAudienceV2, number = 10, actor = OWNER) {
  const request: PersonUpdateSubmitV2 = {
    schema_version: 2,
    kind: "echo-person-update-submit-v2",
    request_id: requestId(number),
    title: `Context ${number}`,
    text: `The durable context ${number} is searchable.`,
    project_id: projectId,
    audience,
  };
  return repository.withWriteTransaction(transaction =>
    transaction.submitUpload(snapshot(transaction, actor, { operation: "upload_submit", request }), request),
  );
}

function setMember(repository: SqliteProjectContextRepositoryV1, projectId: ProjectIdV1, actor: AuthorityPersonMembershipBinding, membership: AuthorityPersonMembershipBinding, role: "lead" | "member", number: number) {
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-member-set-v1" as const,
    request_id: requestId(number),
    project_id: projectId,
    membership_id: membership.membership_id,
    role,
  };
  return repository.withWriteTransaction(transaction =>
    transaction.setMember(snapshot(transaction, actor, { operation: "member_set", request }), request),
  );
}

function addMember(repository: SqliteProjectContextRepositoryV1, projectId: ProjectIdV1, actor: AuthorityPersonMembershipBinding, membership: AuthorityPersonMembershipBinding, number: number) {
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-member-add-v1" as const,
    request_id: requestId(number),
    project_id: projectId,
    membership_id: membership.membership_id,
  };
  return repository.withWriteTransaction(transaction =>
    transaction.addMember(snapshot(transaction, actor, { operation: "member_set", request }), request),
  );
}

describe("SQLite project context V1", () => {
  it("modern association edits affect only the requested project and never rewrite initial receipt coordinates", () => {
    const { database, repository } = open();
    const first = createProject(repository, OWNER, 1), second = createProject(repository, OWNER, 2);
    const ids = [first.project_id, second.project_id].sort();
    const request = { schema_version: 3 as const, kind: "echo-person-update-submit-v3" as const, request_id: requestId(10),
      title: "Private cross-team context", text: "One immutable original", audience: { kind: "only_me" as const }, association_project_ids: ids };
    const saved = repository.withWriteTransaction(transaction => transaction.submitUploadV3(snapshot(transaction, OWNER, { operation: "upload_submit_v3", request }), request));
    const remove = { schema_version: 1 as const, kind: "echo-project-context-dissociate-v1" as const, request_id: requestId(11), project_id: first.project_id, context_id: saved.context_id };
    const applyRemove = () => repository.withWriteTransaction(transaction => transaction.dissociateContext(snapshot(transaction, OWNER, { operation: "dissociate", request: remove }), remove));
    applyRemove();
    expect(database.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id=?").all(saved.context_id)).toEqual([{ project_id: second.project_id }]);
    const add = { ...remove, kind: "echo-project-context-associate-v1" as const, request_id: requestId(12) };
    repository.withWriteTransaction(transaction => transaction.associateContext(snapshot(transaction, OWNER, { operation: "associate", request: add }), add));
    applyRemove();
    expect(database.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id=? ORDER BY project_id").all(saved.context_id)).toEqual(ids.map(project_id => ({ project_id })));
    expect(repository.withWriteTransaction(transaction => transaction.submitUploadV3(snapshot(transaction, OWNER, { operation: "upload_submit_v3", request }), request))).toEqual(saved);
    expect(database.prepare("SELECT count(*) n FROM authority_person_updates_v2").get()).toEqual({ n: 1 });
  });

  it("browses every active organization member and an additive retry cannot demote an existing lead", () => {
    const { database, repository } = open();
    const project = createProject(repository);
    setMember(repository, project.project_id, OWNER, MEMBER, "lead", 2);
    expect(addMember(repository, project.project_id, OWNER, MEMBER, 3)).toMatchObject({ operation: "member_set", membership_id: MEMBER.membership_id });
    expect(repository.withReadTransaction(transaction => transaction.listMembers(
      snapshot(transaction, OWNER, { operation: "members", project_id: project.project_id }), { project_id: project.project_id },
    ).items.find(item => item.membership_id === MEMBER.membership_id))).toMatchObject({ role: "lead" });

    for (let number = 4; number <= 13; number += 1) {
      const suffix = String(number).padStart(12, "0");
      addMembership(database, {
        organization_id: OWNER.organization_id,
        principal_id: `prn_directory_${number}`,
        membership_id: `mem_00000000-0000-4000-8000-${suffix}`,
        membership_type: "employee",
      }, `Directory ${number}`, `directory-${number}@example.test`);
    }
    repository.withReadTransaction(transaction => {
      const first = transaction.searchDirectory(
        snapshot(transaction, OWNER, { operation: "directory", project_id: project.project_id }), { project_id: project.project_id, limit: 10 },
      );
      expect(first.items).toHaveLength(10);
      expect(first.next_cursor).not.toBeNull();
      const final = transaction.searchDirectory(
        snapshot(transaction, OWNER, { operation: "directory", project_id: project.project_id }), { project_id: project.project_id, limit: 10, cursor: first.next_cursor! },
      );
      expect(final.items).toHaveLength(2);
      expect([...first.items, ...final.items]).toContainEqual(expect.objectContaining({ membership_id: OWNER.membership_id }));
      expect(final.next_cursor).toBeNull();
    });
  });

  it("lets any active member page the organization directory with no project, and denies revoked or foreign callers", () => {
    const { database, repository } = open();
    for (let number = 4; number <= 13; number += 1) {
      const suffix = String(number).padStart(12, "0");
      addMembership(database, {
        organization_id: OWNER.organization_id,
        principal_id: `prn_directory_${number}`,
        membership_id: `mem_00000000-0000-4000-8000-${suffix}`,
        membership_type: "employee",
      }, `Directory ${number}`, `directory-${number}@example.test`);
    }
    const LEFT: AuthorityPersonMembershipBinding = { ...OWNER, principal_id: "prn_left", membership_id: "mem_44444444-4444-4444-8444-444444444444", membership_type: "employee" };
    addMembership(database, LEFT, "Left Person", "left@example.test");
    revokeMembership(database, LEFT);
    const directory = (actor: AuthorityPersonMembershipBinding, request: { query?: string; limit?: number; cursor?: string }) =>
      repository.withReadTransaction(transaction => transaction.searchOrganizationDirectory(snapshot(transaction, actor, { operation: "organization_directory" }), request));

    // MEMBER holds no project grant at all.
    expect(database.prepare("SELECT count(*) AS n FROM authority_project_memberships_v1 WHERE membership_id = ?").get(MEMBER.membership_id)).toEqual({ n: 0 });
    const first = directory(MEMBER, { limit: 10 });
    expect(first).toMatchObject({ schema_version: 1, kind: "echo-organization-directory-v1" });
    expect(first.items).toHaveLength(10);
    expect(first.next_cursor).not.toBeNull();
    const final = directory(MEMBER, { limit: 10, cursor: first.next_cursor! });
    expect(final.next_cursor).toBeNull();
    const everyone = [...first.items, ...final.items];
    expect(everyone).toHaveLength(12);
    expect(everyone.map(item => item.display_name)).toEqual([...everyone.map(item => item.display_name)].sort());
    expect(everyone).toContainEqual({ membership_id: OWNER.membership_id, display_name: "Owner" });
    expect(everyone).toContainEqual({ membership_id: MEMBER.membership_id, display_name: "Member" });
    expect(everyone.map(item => item.membership_id)).not.toContain(LEFT.membership_id);
    expect(directory(MEMBER, { query: "member", limit: 10 }).items).toEqual([{ membership_id: MEMBER.membership_id, display_name: "Member" }]);
    expect(directory(OWNER, { query: "left", limit: 10 }).items).toEqual([]);

    // A cursor is bound to its requesting tenure, query, limit and operation.
    const invalid = expect.objectContaining({ code: "invalid_request" });
    expect(() => directory(OWNER, { limit: 10, cursor: first.next_cursor! })).toThrow(invalid);
    expect(() => directory(MEMBER, { query: "directory", limit: 10, cursor: first.next_cursor! })).toThrow(invalid);
    expect(() => directory(MEMBER, { limit: 9, cursor: first.next_cursor! })).toThrow(invalid);
    const project = createProject(repository);
    const organizationCursor = directory(OWNER, { limit: 10 }).next_cursor!;
    expect(() => repository.withReadTransaction(transaction => transaction.searchDirectory(
      snapshot(transaction, OWNER, { operation: "directory", project_id: project.project_id }), { project_id: project.project_id, limit: 10, cursor: organizationCursor },
    ))).toThrow(invalid);
    const projectCursor = repository.withReadTransaction(transaction => transaction.searchDirectory(
      snapshot(transaction, OWNER, { operation: "directory", project_id: project.project_id }), { project_id: project.project_id, limit: 10 },
    )).next_cursor!;
    expect(() => directory(OWNER, { limit: 10, cursor: projectCursor })).toThrow(invalid);

    // Revoked and other-organization callers are denied before any row is read.
    const unauthorized = expect.objectContaining({ code: "unauthorized" });
    expect(() => directory(LEFT, { limit: 10 })).toThrow(unauthorized);
    expect(() => directory({ ...MEMBER, organization_id: OUTSIDE_ORGANIZATION }, { limit: 10 })).toThrow(unauthorized);
    revokeMembership(database, MEMBER);
    expect(() => directory(MEMBER, { limit: 10 })).toThrow(unauthorized);
    expect(directory(OWNER, { query: "member", limit: 10 }).items).toEqual([]);
  });

  it("releases and audits an organization directory page as its own operation", () => {
    const { database, repository } = open();
    const released = repository.withReadTransaction(transaction => {
      const scope = snapshot(transaction, MEMBER, { operation: "organization_directory" });
      expect(() => transaction.searchDirectory(scope, { project_id: "prj_11111111-1111-4111-8111-111111111111", limit: 10 })).toThrow("project context scope mismatch");
      return transaction.revalidateAndAuditRelease(scope, authorization(MEMBER), transaction.searchOrganizationDirectory(scope, { limit: 10 }));
    });
    expect(released.items).toHaveLength(2);
    const audit = database.prepare("SELECT body_json FROM authority_project_read_audit_v1").all() as { body_json: string }[];
    expect(audit.map(row => JSON.parse(row.body_json))).toEqual([expect.objectContaining({
      operation: "organization_directory", membership_id: MEMBER.membership_id, released_count: 2,
    })]);
    expect(audit[0]!.body_json).not.toContain("Owner");
  });

  it("persists every project port and preserves V2's independent custody coordinates", () => {
    const { repository } = open();
    const project = createProject(repository);
    setMember(repository, project.project_id, OWNER, MEMBER, "member", 2);

    const receipt = submit(repository, null, { kind: "project", project_id: project.project_id }, 3);
    const association = {
      schema_version: 1 as const,
      kind: "echo-project-context-associate-v1" as const,
      request_id: requestId(4),
      project_id: project.project_id,
      context_id: receipt.context_id,
    };
    const associated = repository.withWriteTransaction(transaction =>
      transaction.associateContext(snapshot(transaction, OWNER, { operation: "associate", request: association }), association),
    );
    expect(repository.withWriteTransaction(transaction =>
      transaction.associateContext(snapshot(transaction, OWNER, { operation: "associate", request: association }), association),
    )).toEqual(associated);
    const dissociation = { ...association, kind: "echo-project-context-dissociate-v1" as const, request_id: requestId(5) };
    repository.withWriteTransaction(transaction => {
      expect(transaction.activeMembership(MEMBER.membership_id)).toEqual(MEMBER);
      return transaction.dissociateContext(snapshot(transaction, OWNER, { operation: "dissociate", request: dissociation }), dissociation);
    });
    const reassociation = { ...association, request_id: requestId(6) };
    repository.withWriteTransaction(transaction =>
      transaction.associateContext(snapshot(transaction, OWNER, { operation: "associate", request: reassociation }), reassociation),
    );

    repository.withReadTransaction(transaction => {
      const projectSnapshot = snapshot(transaction, OWNER, { operation: "project_read", project_id: project.project_id });
      expect(transaction.readProject(projectSnapshot, project.project_id)).toMatchObject({ project_id: project.project_id, role: "lead" });
      expect(transaction.listProjects(snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 10 }).items).toContainEqual(expect.objectContaining({ project_id: project.project_id }));
      expect(transaction.listMembers(snapshot(transaction, OWNER, { operation: "members", project_id: project.project_id }), { project_id: project.project_id, limit: 10 }).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ membership_id: OWNER.membership_id, role: "lead" }),
        expect.objectContaining({ membership_id: MEMBER.membership_id, role: "member" }),
      ]));
      expect(transaction.searchDirectory(snapshot(transaction, OWNER, { operation: "directory", project_id: project.project_id }), { project_id: project.project_id, query: "member", limit: 10 }).items).toContainEqual(expect.objectContaining({ membership_id: MEMBER.membership_id }));

      const feedSnapshot = snapshot(transaction, OWNER, { operation: "feed", project_id: project.project_id });
      const feed = transaction.feed(feedSnapshot, { project_id: project.project_id, limit: 10 });
      expect(feed.items.map(item => item.context_id)).toContain(receipt.context_id);
      expect(transaction.revalidateAndAuditRelease(feedSnapshot, authorization(), feed)).toEqual(feed);
      const search = transaction.search(snapshot(transaction, OWNER, { operation: "search", project_id: project.project_id }), { project_id: project.project_id, query: "durable", limit: 10 });
      expect(search.items.map(item => item.context_id)).toContain(receipt.context_id);
      const context = transaction.readContext(snapshot(transaction, OWNER, { operation: "context_read", project_id: project.project_id, context_id: receipt.context_id }), project.project_id, receipt.context_id);
      expect(context).toMatchObject({ project_id: project.project_id, context_id: receipt.context_id });

      const status = transaction.uploadStatus(snapshot(transaction, OWNER, { operation: "upload_status", request_id: receipt.request_id }), receipt.request_id);
      expect(status).toMatchObject({ request_id: receipt.request_id, project_id: null, audience: { kind: "project", project_id: project.project_id } });
      const generic = transaction.readUpload(snapshot(transaction, OWNER, { operation: "upload_read", context_id: receipt.context_id }), receipt.context_id);
      expect(generic).toMatchObject({ context_id: receipt.context_id, audience: { kind: "project", project_id: project.project_id } });
      expect(Object.hasOwn(generic, "project_id")).toBe(false);
      const genericSearch = transaction.searchUploads(snapshot(transaction, OWNER, { operation: "upload_search" }), { query: "durable" });
      expect(genericSearch.results.map(item => item.context_id)).toContain(receipt.context_id);
      expect(genericSearch.results.every(item => !Object.hasOwn(item, "project_id"))).toBe(true);
    });
  });

  it("is replay-safe across restart and never restores a lost project grant", () => {
    const root = mkdtempSync(join(tmpdir(), "project-context-replay-"));
    roots.push(root);
    const path = join(root, "authority.sqlite");
    const first = open(path);
    const project = createProject(first.repository, OWNER, 20);
    setMember(first.repository, project.project_id, OWNER, MEMBER, "member", 21);
    const receipt = submit(first.repository, project.project_id, { kind: "team" }, 22);
    first.database.close();

    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    databases.push(database);
    const recovered = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
    const replay = submit(recovered, project.project_id, { kind: "team" }, 22);
    expect(replay).toEqual(receipt);
    expect(() => submit(recovered, project.project_id, { kind: "only_me" }, 22)).toThrow(expect.objectContaining({ code: "conflict" }));

    const remove = {
      schema_version: 1 as const,
      kind: "echo-project-member-remove-v1" as const,
      request_id: requestId(23),
      project_id: project.project_id,
      membership_id: MEMBER.membership_id,
    };
    recovered.withWriteTransaction(transaction => transaction.removeMember(
      snapshot(transaction, OWNER, { operation: "member_remove", request: remove }), remove,
    ));
    expect(() => submit(recovered, project.project_id, { kind: "team" }, 22, MEMBER)).toThrow();
    expect(recovered.withReadTransaction(transaction => transaction.uploadStatus(
      snapshot(transaction, OWNER, { operation: "upload_status", request_id: receipt.request_id }), receipt.request_id,
    ))).toEqual(expect.objectContaining({
      request_id: receipt.request_id,
      context_id: receipt.context_id,
      project_id: receipt.project_id,
      audience: receipt.audience,
      kind: "echo-person-update-status-v2",
      status: "stored",
    }));
  });

  it("keeps tenure and audience checks ahead of candidate release", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 30);
    setMember(repository, project.project_id, OWNER, MEMBER, "member", 31);
    const privateReceipt = submit(repository, project.project_id, { kind: "only_me" }, 32);
    const projectReceipt = submit(repository, project.project_id, { kind: "project", project_id: project.project_id }, 33);

    repository.withReadTransaction(transaction => {
      const memberFeed = transaction.feed(snapshot(transaction, MEMBER, { operation: "feed", project_id: project.project_id }), { project_id: project.project_id, limit: 10 });
      expect(memberFeed.items.map(item => item.context_id)).toContain(projectReceipt.context_id);
      expect(memberFeed.items.map(item => item.context_id)).not.toContain(privateReceipt.context_id);
    });

    revokeMembership(database, MEMBER);
    addMembership(database, RETURNED_MEMBER, "Member", "member@example.test");
    repository.withReadTransaction(transaction => {
      expect(() => transaction.feed(snapshot(transaction, RETURNED_MEMBER, { operation: "feed", project_id: project.project_id }), { project_id: project.project_id, limit: 10 })).toThrow();
      expect(() => transaction.readUpload(snapshot(transaction, RETURNED_MEMBER, { operation: "upload_read", context_id: projectReceipt.context_id }), projectReceipt.context_id)).toThrow(expect.objectContaining({ code: "not_found" }));
    });
  });

  it("binds keysets to their public scope without embedding credential state", () => {
    const { repository } = open();
    createProject(repository, OWNER, 40);
    createProject(repository, OWNER, 41);
    const page = repository.withReadTransaction(transaction => transaction.listProjects(
      snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 1 },
    ));
    expect(page.next_cursor).not.toBeNull();
    const cursor = page.next_cursor!;
    expect(decodeProjectCursorV1(cursor, {
      operation: "project_list",
      project_id: undefined,
      canonical_query: undefined,
      limit: 1,
      organization_id: OWNER.organization_id,
      membership_id: OWNER.membership_id,
    })).toHaveLength(2);
    const raw = Buffer.from(cursor, "base64url");
    expect(raw.subarray(33).toString("utf8")).not.toContain("session-fixture");
    expect(() => repository.withReadTransaction(transaction => transaction.listProjects(
      snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 2, cursor },
    ))).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("releases only the issued current response and atomically records minimized audit evidence", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 50);
    submit(repository, project.project_id, { kind: "project", project_id: project.project_id }, 51);
    repository.withReadTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "feed", project_id: project.project_id });
      const response = transaction.feed(state, { project_id: project.project_id, limit: 10 });
      expect(Object.isFrozen(response)).toBe(true);
      expect(transaction.revalidateAndAuditRelease(state, authorization(), response)).toEqual(response);
    });
    const audit = JSON.stringify(database.prepare("SELECT body_json FROM authority_project_read_audit_v1").all());
    expect(audit).not.toContain("The durable context 51 is searchable.");
    expect(audit).not.toContain('"query"');

    repository.withReadTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "feed", project_id: project.project_id });
      const response = transaction.feed(state, { project_id: project.project_id, limit: 10 });
      expect(() => transaction.revalidateAndAuditRelease(state, authorization(), { ...response, items: [] })).toThrow(expect.objectContaining({ code: "invalid_output" }));
    });

    expect(() => repository.withReadTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "feed", project_id: project.project_id });
      const response = transaction.feed(state, { project_id: project.project_id, limit: 10 });
      database.prepare("UPDATE authority_project_authorization_state_v1 SET revision = revision + 1 WHERE organization_id = ?").run(OWNER.organization_id);
      return transaction.revalidateAndAuditRelease(state, authorization(), response);
    })).toThrow(expect.objectContaining({ code: "stale_access_state" }));

    const before = database.prepare("SELECT count(*) AS n FROM authority_project_read_audit_v1").get();
    database.exec(`CREATE TRIGGER fixture_project_audit_failure
      BEFORE INSERT ON authority_project_read_audit_v1
      BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
    expect(() => repository.withReadTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "feed", project_id: project.project_id });
      const response = transaction.feed(state, { project_id: project.project_id, limit: 10 });
      return transaction.revalidateAndAuditRelease(state, authorization(), response);
    })).toThrow("fixture audit failure");
    expect(database.prepare("SELECT count(*) AS n FROM authority_project_read_audit_v1").get()).toEqual(before);
  });

  it("relies on V7 composite FKs and immutable custody tables, not application types", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 60);
    const receipt = submit(repository, project.project_id, { kind: "team" }, 61);
    expect(() => database.prepare(
      `INSERT INTO authority_project_memberships_v1
       (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at)
       VALUES ('pgm_99999999-9999-4999-8999-999999999999', ?, ?, ?, ?, 'owner', 'lead', 'active', ?)`,
    ).run(project.project_id, OUTSIDE_ORGANIZATION, OWNER.principal_id, OWNER.membership_id, PROJECT_CONTEXT_NOW)).toThrow();
    expect(() => database.prepare("UPDATE authority_person_updates_v2 SET text = 'rewrite' WHERE context_id = ?").run(receipt.context_id)).toThrow("immutable");
    expect(() => database.prepare("UPDATE authority_project_context_associations_v1 SET project_id = ? WHERE context_id = ?").run(project.project_id, receipt.context_id)).toThrow("association update is denied");
    expect(() => database.prepare("UPDATE authority_project_command_receipts_v1 SET receipt_json = '{}' ").run()).toThrow("immutable");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("does not accept stale, forged, or cross-scoped transaction witnesses", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 70);
    const receipt = submit(repository, project.project_id, { kind: "team" }, 71);
    const read = repository.withReadTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "context_read", project_id: project.project_id, context_id: receipt.context_id });
      const response = transaction.readContext(state, project.project_id, receipt.context_id);
      return { state, response };
    });
    expect(() => ((read.state.grants[0] as { role: string }).role = "member")).toThrow();
    expect(() => repository.withReadTransaction(transaction => transaction.readContext(
      read.state, project.project_id, `ctx_${"f".repeat(64)}`,
    ))).toThrow();

    const request = {
      schema_version: 1 as const,
      kind: "echo-project-create-v1" as const,
      request_id: requestId(72),
      name: "Bound command",
    };
    const stale = repository.withReadTransaction(transaction => snapshot(transaction, OWNER, { operation: "create", request }));
    expect(() => repository.withWriteTransaction(transaction => transaction.createProject(stale, request))).toThrow();
    expect(() => repository.withWriteTransaction(transaction => transaction.createProject(
      snapshot(transaction, OWNER, { operation: "create", request }), { ...request, name: "Changed command" },
    ))).toThrow();

    expect(() => repository.withWriteTransaction(transaction => {
      const state = snapshot(transaction, OWNER, { operation: "member_set", request: {
        schema_version: 1, kind: "echo-project-member-set-v1", request_id: requestId(73), project_id: project.project_id, membership_id: MEMBER.membership_id, role: "member",
      } });
      database.prepare("UPDATE authority_project_memberships_v1 SET role = 'member' WHERE project_id = ? AND membership_id = ?").run(project.project_id, OWNER.membership_id);
      return transaction.setMember(state, {
        schema_version: 1, kind: "echo-project-member-set-v1", request_id: requestId(73), project_id: project.project_id, membership_id: MEMBER.membership_id, role: "member",
      });
    })).toThrow();
  });

  it("returns no cursor after the final full page and cages a second repository handle", () => {
    const { database, repository } = open();
    createProject(repository, OWNER, 80);
    createProject(repository, OWNER, 81);
    const page = repository.withReadTransaction(transaction => transaction.listProjects(
      snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 2 },
    ));
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
    const secondHandle = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
    expect(() => repository.withReadTransaction(() => secondHandle.withReadTransaction(() => undefined))).toThrow();
  });

  it("emits a continuation for a full first page and null on the final full project, roster, feed, and search page", () => {
    const database = projectContextDatabase();
    databases.push(database);
    let tick = 0;
    const repository = new SqliteProjectContextRepositoryV1(database, () =>
      `2026-09-21T22:01:${String(tick++).padStart(2, "0")}.000Z`,
    );
    const first = createProject(repository, OWNER, 85);
    const second = createProject(repository, OWNER, 86);
    setMember(repository, first.project_id, OWNER, MEMBER, "member", 87);
    submit(repository, first.project_id, { kind: "team" }, 88);
    submit(repository, first.project_id, { kind: "team" }, 89);

    repository.withReadTransaction(transaction => {
      const projects = transaction.listProjects(snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 1 });
      expect(projects.items).toHaveLength(1);
      expect(projects.next_cursor).not.toBeNull();
      const projectFinal = transaction.listProjects(snapshot(transaction, OWNER, { operation: "project_list" }), { limit: 1, cursor: projects.next_cursor! });
      expect(projectFinal.items).toHaveLength(1);
      expect(projectFinal.items.map(item => item.project_id)).toContain(first.project_id);
      expect(projectFinal.next_cursor).toBeNull();
      expect(projects.items.map(item => item.project_id)).toContain(second.project_id);

      const roster = transaction.listMembers(snapshot(transaction, OWNER, { operation: "members", project_id: first.project_id }), { project_id: first.project_id, limit: 1 });
      expect(roster.next_cursor).not.toBeNull();
      const rosterFinal = transaction.listMembers(snapshot(transaction, OWNER, { operation: "members", project_id: first.project_id }), { project_id: first.project_id, limit: 1, cursor: roster.next_cursor! });
      expect(rosterFinal.items).toHaveLength(1);
      expect(rosterFinal.next_cursor).toBeNull();

      const feed = transaction.feed(snapshot(transaction, OWNER, { operation: "feed", project_id: first.project_id }), { project_id: first.project_id, limit: 1 });
      expect(feed.next_cursor).not.toBeNull();
      const feedFinal = transaction.feed(snapshot(transaction, OWNER, { operation: "feed", project_id: first.project_id }), { project_id: first.project_id, limit: 1, cursor: feed.next_cursor! });
      expect(feedFinal.items).toHaveLength(1);
      expect(feedFinal.next_cursor).toBeNull();
      expect(feed.items[0]!.received_at > feedFinal.items[0]!.received_at).toBe(true);

      const search = transaction.search(snapshot(transaction, OWNER, { operation: "search", project_id: first.project_id }), { project_id: first.project_id, query: "durable context", limit: 1 });
      expect(search.next_cursor).not.toBeNull();
      const searchFinal = transaction.search(snapshot(transaction, OWNER, { operation: "search", project_id: first.project_id }), { project_id: first.project_id, query: "durable context", limit: 1, cursor: search.next_cursor! });
      expect(searchFinal.items).toHaveLength(1);
      expect(searchFinal.next_cursor).toBeNull();
      expect(search.items[0]!.received_at > searchFinal.items[0]!.received_at).toBe(true);
    });
  });

  it("keeps a last active lead and project association identity from being silently rewritten", () => {
    const { repository } = open();
    const project = createProject(repository, OWNER, 90);
    const memberLead = setMember(repository, project.project_id, OWNER, MEMBER, "lead", 91);
    expect(setMember(repository, project.project_id, OWNER, MEMBER, "lead", 91)).toEqual(memberLead);
    const removeOwner = {
      schema_version: 1 as const,
      kind: "echo-project-member-remove-v1" as const,
      request_id: requestId(92),
      project_id: project.project_id,
      membership_id: OWNER.membership_id,
    };
    repository.withWriteTransaction(transaction => transaction.removeMember(
      snapshot(transaction, MEMBER, { operation: "member_remove", request: removeOwner }), removeOwner,
    ));
    const removeLastLead = { ...removeOwner, request_id: requestId(93), membership_id: MEMBER.membership_id };
    expect(() => repository.withWriteTransaction(transaction => transaction.removeMember(
      snapshot(transaction, MEMBER, { operation: "member_remove", request: removeLastLead }), removeLastLead,
    ))).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("shares the 100-item retained-corpus limit across V1 and V2, while exact retry wins before capacity", () => {
    const first = open();
    for (let index = 0; index < 99; index += 1) insertLegacyTextV1(first.database, OWNER, {
      request_id: requestId(1000 + index), title: `V1 ${index}`, text: "shared capacity",
    });
    const v2Receipt = submit(first.repository, null, { kind: "only_me" }, 1100);
    expect(submit(first.repository, null, { kind: "only_me" }, 1100)).toEqual(v2Receipt);
    expect(() => submit(first.repository, null, { kind: "only_me" }, 1101)).toThrow(expect.objectContaining({ code: "rate_limited" }));

    const second = open();
    for (let index = 0; index < 100; index += 1) insertLegacyTextV1(second.database, OWNER, {
      request_id: requestId(1200 + index), title: `V1 ${index}`, text: "shared capacity",
    });
    expect(() => submit(second.repository, null, { kind: "only_me" }, 1300)).toThrow(expect.objectContaining({ code: "rate_limited" }));
  });

  it("rolls V2 original, work, association, and replay receipt back when durable work insertion fails", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 1400);
    database.exec(`CREATE TRIGGER fixture_v2_work_failure
      BEFORE INSERT ON authority_person_update_work_v2
      BEGIN SELECT RAISE(ABORT, 'fixture work failure'); END`);
    expect(() => submit(repository, project.project_id, { kind: "project", project_id: project.project_id }, 1401)).toThrow("fixture work failure");
    expect(database.prepare("SELECT count(*) AS n FROM authority_person_updates_v2").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM authority_person_update_work_v2").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM authority_project_context_associations_v1").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM authority_project_command_receipts_v1 WHERE request_id = ?").get(requestId(1401))).toEqual({ n: 0 });
  });

  it("round-trips the largest valid original byte-for-byte through generic and project reads", () => {
    const { repository } = open();
    const project = createProject(repository, OWNER, 1500);
    const text = "\n".repeat(8047) + "a";
    const request: PersonUpdateSubmitV2 = {
      schema_version: 2, kind: "echo-person-update-submit-v2", request_id: requestId(1501),
      title: "Maximum source", text, project_id: project.project_id,
      audience: { kind: "project", project_id: project.project_id },
    };
    const receipt = repository.withWriteTransaction(transaction => transaction.submitUpload(
      snapshot(transaction, OWNER, { operation: "upload_submit", request }), request,
    ));
    repository.withReadTransaction(transaction => {
      expect(transaction.readUpload(snapshot(transaction, OWNER, { operation: "upload_read", context_id: receipt.context_id }), receipt.context_id).text).toBe(text);
      expect(transaction.readContext(
        snapshot(transaction, OWNER, { operation: "context_read", project_id: project.project_id, context_id: receipt.context_id }),
        project.project_id, receipt.context_id,
      ).text).toBe(text);
    });
  });

  it("prevents an actual second SQLite handle from nesting transaction access", () => {
    const root = mkdtempSync(join(tmpdir(), "project-context-cross-handle-"));
    roots.push(root);
    const path = join(root, "authority.sqlite");
    const first = open(path);
    const secondDatabase = new Database(path);
    secondDatabase.pragma("foreign_keys = ON");
    databases.push(secondDatabase);
    const second = new SqliteProjectContextRepositoryV1(secondDatabase, () => PROJECT_CONTEXT_NOW);
    expect(() => first.repository.withReadTransaction(() => second.withReadTransaction(() => undefined))).toThrow("not reentrant");
  });

  it("permits organization revocation to leave a project leadless without an owner bypass", () => {
    const { database, repository } = open();
    const project = createProject(repository, OWNER, 1600);
    setMember(repository, project.project_id, OWNER, MEMBER, "member", 1601);
    revokeMembership(database, OWNER);
    const request = {
      schema_version: 1 as const, kind: "echo-project-member-set-v1" as const,
      request_id: requestId(1602), project_id: project.project_id,
      membership_id: MEMBER.membership_id, role: "lead" as const,
    };
    expect(() => repository.withWriteTransaction(transaction => transaction.setMember(
      snapshot(transaction, OWNER, { operation: "member_set", request }), request,
    ))).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => repository.withWriteTransaction(transaction => transaction.setMember(
      snapshot(transaction, MEMBER, { operation: "member_set", request }), request,
    ))).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("replays a prior dissociation as its stored receipt without restoring an old association", () => {
    const { database, repository } = open();
    const alpha = createProject(repository, OWNER, 1700);
    const beta = createProject(repository, OWNER, 1701);
    const receipt = submit(repository, null, { kind: "only_me" }, 1702);
    const associateAlpha = {
      schema_version: 1 as const, kind: "echo-project-context-associate-v1" as const,
      request_id: requestId(1703), project_id: alpha.project_id, context_id: receipt.context_id,
    };
    repository.withWriteTransaction(transaction => transaction.associateContext(
      snapshot(transaction, OWNER, { operation: "associate", request: associateAlpha }), associateAlpha,
    ));
    const dissociateAlpha = { ...associateAlpha, kind: "echo-project-context-dissociate-v1" as const, request_id: requestId(1704) };
    const detached = repository.withWriteTransaction(transaction => transaction.dissociateContext(
      snapshot(transaction, OWNER, { operation: "dissociate", request: dissociateAlpha }), dissociateAlpha,
    ));
    const associateBeta = { ...associateAlpha, request_id: requestId(1705), project_id: beta.project_id };
    repository.withWriteTransaction(transaction => transaction.associateContext(
      snapshot(transaction, OWNER, { operation: "associate", request: associateBeta }), associateBeta,
    ));
    expect(repository.withWriteTransaction(transaction => transaction.dissociateContext(
      snapshot(transaction, OWNER, { operation: "dissociate", request: dissociateAlpha }), dissociateAlpha,
    ))).toEqual(detached);
    expect(database.prepare("SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ?").get(receipt.context_id)).toEqual({ project_id: beta.project_id });
  });

  it("rejects storage tampering when immutable triggers are deliberately removed by a fixture", () => {
    const { database, repository } = open();
    const create = createProject(repository, OWNER, 1800);
    database.exec("DROP TRIGGER authority_project_command_receipts_v1_immutable");
    database.prepare("UPDATE authority_project_command_receipts_v1 SET receipt_json = '{}' WHERE request_id = ?").run(create.request_id);
    expect(() => createProject(repository, OWNER, 1800)).toThrow();

    const receipt = submit(repository, null, { kind: "only_me" }, 1801);
    database.exec("DROP TRIGGER authority_person_updates_v2_immutable");
    database.prepare("UPDATE authority_person_updates_v2 SET text = 'tampered' WHERE context_id = ?").run(receipt.context_id);
    expect(() => repository.withReadTransaction(transaction => transaction.readUpload(
      snapshot(transaction, OWNER, { operation: "upload_read", context_id: receipt.context_id }), receipt.context_id,
    ))).toThrow("project upload payload integrity failure");
  });

  it("rejects transaction escape and cross-organization persistence", () => {
    const { database, repository } = open();
    expect(() => repository.withWriteTransaction(() => Promise.resolve("escaped"))).toThrow();
    expect(() => repository.withReadTransaction(transaction => repository.withReadTransaction(() => transaction))).toThrow();
    expect(() => database.prepare(
      `INSERT INTO authority_projects_v1
       (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
       VALUES (?, ?, 'invalid', ?, ?, ?, 'owner')`,
    ).run("prj_99999999-9999-4999-8999-999999999999", OUTSIDE_ORGANIZATION, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id)).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });
});
