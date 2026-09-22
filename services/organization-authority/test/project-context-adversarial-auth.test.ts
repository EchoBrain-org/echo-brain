import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { PersonUpdateSubmitV2, ProjectIdV1 } from "@echo-brain/organization-api";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import type {
  ProjectAuthorizationScopeV1,
  ProjectContextReadTransactionV1,
  ProjectContextWriteTransactionV1,
} from "../src/application/ports/project-context-v1.js";
import {
  MEMBER,
  OWNER,
  PROJECT_CONTEXT_NOW,
  authorization,
  projectContextDatabase,
} from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
});

function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function open(): { database: Database.Database; repository: SqliteProjectContextRepositoryV1 } {
  const database = projectContextDatabase();
  databases.push(database);
  return { database, repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW) };
}

function snapshot<T extends ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1>(
  transaction: T,
  actor: typeof OWNER | typeof MEMBER,
  scope: ProjectAuthorizationScopeV1,
) {
  return transaction.captureAuthorization(authorization(actor), scope);
}

function createProject(repository: SqliteProjectContextRepositoryV1, number: number) {
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-create-v1" as const,
    request_id: requestId(number),
    name: `Project ${number}`,
  };
  return repository.withWriteTransaction(transaction => transaction.createProject(
    snapshot(transaction, OWNER, { operation: "create", request }), request,
  ));
}

function setMember(
  repository: SqliteProjectContextRepositoryV1,
  projectId: ProjectIdV1,
  actor: typeof OWNER | typeof MEMBER,
  target: typeof OWNER | typeof MEMBER,
  role: "lead" | "member",
  number: number,
) {
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-member-set-v1" as const,
    request_id: requestId(number),
    project_id: projectId,
    membership_id: target.membership_id,
    role,
  };
  return repository.withWriteTransaction(transaction => transaction.setMember(
    snapshot(transaction, actor, { operation: "member_set", request }), request,
  ));
}

function submit(
  repository: SqliteProjectContextRepositoryV1,
  actor: typeof OWNER | typeof MEMBER,
  projectId: ProjectIdV1 | null,
  audience: PersonUpdateSubmitV2["audience"],
  number: number,
) {
  const request: PersonUpdateSubmitV2 = {
    schema_version: 2,
    kind: "echo-person-update-submit-v2",
    request_id: requestId(number),
    title: `Context ${number}`,
    text: `Original source ${number}.`,
    project_id: projectId,
    audience,
  };
  return repository.withWriteTransaction(transaction => transaction.submitUpload(
    snapshot(transaction, actor, { operation: "upload_submit", request }), request,
  ));
}

function expectNotFound(action: () => void): void {
  expect(action).toThrow(expect.objectContaining({ code: "not_found" }));
}

describe("project context adversarial authorization", () => {
  it("filters a hidden corrupt original before validation, leaving it indistinguishable from a missing context", () => {
    const { database, repository } = open();
    const project = createProject(repository, 1);
    setMember(repository, project.project_id, OWNER, MEMBER, "member", 2);
    const receipt = submit(repository, OWNER, project.project_id, { kind: "only_me" }, 3);

    database.exec("DROP TRIGGER authority_person_updates_v2_immutable");
    database.prepare("UPDATE authority_person_updates_v2 SET text = 'corrupted' WHERE context_id = ?").run(receipt.context_id);

    repository.withReadTransaction(transaction => {
      const feed = transaction.feed(
        snapshot(transaction, MEMBER, { operation: "feed", project_id: project.project_id }),
        { project_id: project.project_id, limit: 10 },
      );
      const search = transaction.search(
        snapshot(transaction, MEMBER, { operation: "search", project_id: project.project_id }),
        { project_id: project.project_id, query: "original", limit: 10 },
      );
      expect(feed.items).toEqual([]);
      expect(search.items).toEqual([]);
      expectNotFound(() => transaction.readContext(
        snapshot(transaction, MEMBER, { operation: "context_read", project_id: project.project_id, context_id: receipt.context_id }),
        project.project_id,
        receipt.context_id,
      ));
      expectNotFound(() => transaction.readContext(
        snapshot(transaction, MEMBER, { operation: "context_read", project_id: project.project_id, context_id: `ctx_${"f".repeat(64)}` }),
        project.project_id,
        `ctx_${"f".repeat(64)}`,
      ));
    });
  });

  it("does not let loss of an association grant change the uploader's team audience or remove authority", () => {
    const { repository } = open();
    const associationProject = createProject(repository, 10);
    setMember(repository, associationProject.project_id, OWNER, MEMBER, "lead", 11);
    const receipt = submit(repository, OWNER, associationProject.project_id, { kind: "team" }, 12);
    const removal = {
      schema_version: 1 as const,
      kind: "echo-project-member-remove-v1" as const,
      request_id: requestId(13),
      project_id: associationProject.project_id,
      membership_id: OWNER.membership_id,
    };
    repository.withWriteTransaction(transaction => transaction.removeMember(
      snapshot(transaction, MEMBER, { operation: "member_remove", request: removal }), removal,
    ));

    repository.withReadTransaction(transaction => {
      expect(transaction.readUpload(
        snapshot(transaction, OWNER, { operation: "upload_read", context_id: receipt.context_id }), receipt.context_id,
      )).toMatchObject({ context_id: receipt.context_id, audience: { kind: "team" } });
      expectNotFound(() => transaction.readProject(
        snapshot(transaction, OWNER, { operation: "project_read", project_id: associationProject.project_id }),
        associationProject.project_id,
      ));
    });

    const dissociation = {
      schema_version: 1 as const,
      kind: "echo-project-context-dissociate-v1" as const,
      request_id: requestId(14),
      project_id: associationProject.project_id,
      context_id: receipt.context_id,
    };
    repository.withWriteTransaction(transaction => transaction.dissociateContext(
      snapshot(transaction, OWNER, { operation: "dissociate", request: dissociation }), dissociation,
    ));
  });

  it("rejects a forged witness and denies project-audience admission without the exact audience-project grant", () => {
    const { database, repository } = open();
    const audienceProject = createProject(repository, 20);
    const associationProject = createProject(repository, 21);
    setMember(repository, associationProject.project_id, OWNER, MEMBER, "member", 22);
    const request: PersonUpdateSubmitV2 = {
      schema_version: 2,
      kind: "echo-person-update-submit-v2",
      request_id: requestId(23),
      title: "Out of scope audience",
      text: "Membership in the association project cannot authorize the audience project.",
      project_id: associationProject.project_id,
      audience: { kind: "project", project_id: audienceProject.project_id },
    };

    repository.withWriteTransaction(transaction => {
      const admitted = snapshot(transaction, MEMBER, { operation: "upload_submit", request });
      const forged = { ...admitted, grants: [] } as typeof admitted;
      expect(() => transaction.submitUpload(forged, request)).toThrow("snapshot escaped or was forged");
      expectNotFound(() => transaction.submitUpload(admitted, request));
    });
    expect(database.prepare("SELECT count(*) AS n FROM authority_person_updates_v2").get()).toEqual({ n: 0 });
  });
});
