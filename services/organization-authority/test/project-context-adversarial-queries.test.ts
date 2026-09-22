import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  validateProjectPageRequestV1,
  validateProjectContextSearchV1,
  type PersonUpdateSubmitV2,
} from "@echo-brain/organization-api";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import type {
  ProjectAuthorizationScopeV1,
  ProjectContextReadTransactionV1,
  ProjectContextWriteTransactionV1,
} from "../src/application/ports/project-context-v1.js";
import { OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
});

function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function snapshot<T extends ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1>(
  transaction: T,
  scope: ProjectAuthorizationScopeV1,
) {
  return transaction.captureAuthorization(authorization(OWNER), scope);
}

function open(): SqliteProjectContextRepositoryV1 {
  const database = projectContextDatabase();
  databases.push(database);
  return new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
}

describe("project context adversarial query inputs", () => {
  it("does not turn an empty project search into an authorized feed when a caller bypasses the wire codec", () => {
    const repository = open();
    const create = {
      schema_version: 1 as const,
      kind: "echo-project-create-v1" as const,
      request_id: requestId(1),
      name: "Adversarial query project",
    };
    const project = repository.withWriteTransaction(transaction =>
      transaction.createProject(snapshot(transaction, { operation: "create", request: create }), create),
    );
    const upload: PersonUpdateSubmitV2 = {
      schema_version: 2,
      kind: "echo-person-update-submit-v2",
      request_id: requestId(2),
      title: "Visible only through a real query",
      text: "Bounded source text",
      project_id: project.project_id,
      audience: { kind: "team" },
    };
    repository.withWriteTransaction(transaction => transaction.submitUpload(
      snapshot(transaction, { operation: "upload_submit", request: upload }), upload,
    ));

    const request = { project_id: project.project_id, query: "", limit: 10 };
    expect(() => validateProjectContextSearchV1(request)).toThrow();
    expect(() => repository.withReadTransaction(transaction => transaction.search(
      snapshot(transaction, { operation: "search", project_id: project.project_id }),
      request,
    ))).toThrow();
  });

  it("returns the contract invalid-request outcome for an out-of-bound page size instead of computing an invalid cursor", () => {
    const repository = open();
    const create = {
      schema_version: 1 as const,
      kind: "echo-project-create-v1" as const,
      request_id: requestId(3),
      name: "Adversarial page project",
    };
    repository.withWriteTransaction(transaction => transaction.createProject(
      snapshot(transaction, { operation: "create", request: create }), create,
    ));

    const request = { limit: 0 };
    expect(() => validateProjectPageRequestV1(request)).toThrow();
    expect(() => repository.withReadTransaction(transaction => transaction.listProjects(
      snapshot(transaction, { operation: "project_list" }), request,
    ))).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
});
