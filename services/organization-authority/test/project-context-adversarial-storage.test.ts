import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import type { PersonUpdateSubmitV2, ProjectCreateV1 } from "@echo-brain/organization-api";
import type { ProjectContextWriteTransactionV1 } from "../src/application/ports/project-context-v1.js";
import { OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from "./fixtures/project-context-sqlite.js";

const databases: Database.Database[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function snapshot(transaction: ProjectContextWriteTransactionV1, request: PersonUpdateSubmitV2) {
  return transaction.captureAuthorization(authorization(OWNER), { operation: "upload_submit", request });
}

function createSnapshot(transaction: ProjectContextWriteTransactionV1, request: ProjectCreateV1) {
  return transaction.captureAuthorization(authorization(OWNER), { operation: "create", request });
}

function createProject(repository: SqliteProjectContextRepositoryV1, number: number) {
  const request: ProjectCreateV1 = {
    schema_version: 1,
    kind: "echo-project-create-v1",
    request_id: requestId(number),
    name: `Project ${number}`,
  };
  return repository.withWriteTransaction(transaction => transaction.createProject(
    createSnapshot(transaction, request), request,
  ));
}

it("does not commit an upload prefix when its callback catches a durable work failure", () => {
  const database = projectContextDatabase();
  databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const request: PersonUpdateSubmitV2 = {
    schema_version: 2,
    kind: "echo-person-update-submit-v2",
    request_id: requestId(1),
    title: "Atomic admission",
    text: "The work row must commit with the original and replay receipt.",
    project_id: null,
    audience: { kind: "only_me" },
  };
  database.exec(`CREATE TRIGGER fixture_work_failure
    BEFORE INSERT ON authority_person_update_work_v2
    BEGIN SELECT RAISE(ABORT, 'fixture work failure'); END`);

  repository.withWriteTransaction(transaction => {
    try {
      transaction.submitUpload(snapshot(transaction, request), request);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  expect(database.prepare("SELECT count(*) AS n FROM authority_person_updates_v2").get()).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_person_update_work_v2").get()).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_project_command_receipts_v1").get()).toEqual({ n: 0 });
});

it("does not leave a ghost project when a caught create failure is retried after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "project-context-adversarial-"));
  roots.push(root);
  const path = join(root, "authority.sqlite");
  const database = projectContextDatabase(path);
  databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const request: ProjectCreateV1 = {
    schema_version: 1,
    kind: "echo-project-create-v1",
    request_id: requestId(2),
    name: "Restart-safe project",
  };
  database.exec(`CREATE TRIGGER fixture_membership_failure
    BEFORE INSERT ON authority_project_memberships_v1
    BEGIN SELECT RAISE(ABORT, 'fixture membership failure'); END`);

  repository.withWriteTransaction(transaction => {
    try {
      transaction.createProject(createSnapshot(transaction, request), request);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
  expect.soft(database.prepare("SELECT count(*) AS n FROM authority_projects_v1").get()).toEqual({ n: 0 });
  database.exec("DROP TRIGGER fixture_membership_failure");
  database.close();

  const reopened = new Database(path);
  reopened.pragma("foreign_keys = ON");
  databases.push(reopened);
  const recovered = new SqliteProjectContextRepositoryV1(reopened, () => PROJECT_CONTEXT_NOW);
  recovered.withWriteTransaction(transaction => transaction.createProject(createSnapshot(transaction, request), request));

  expect(reopened.prepare("SELECT count(*) AS n FROM authority_projects_v1").get()).toEqual({ n: 1 });
  expect(reopened.prepare("SELECT count(*) AS n FROM authority_project_command_receipts_v1 WHERE request_id = ?").get(request.request_id)).toEqual({ n: 1 });
});

it("rolls an initial association back when its insert fails after original and work admission", () => {
  const database = projectContextDatabase();
  databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const project = createProject(repository, 3);
  const request: PersonUpdateSubmitV2 = {
    schema_version: 2,
    kind: "echo-person-update-submit-v2",
    request_id: requestId(4),
    title: "Association fence",
    text: "All upload admission rows must roll back if the initial association fails.",
    project_id: project.project_id,
    audience: { kind: "team" },
  };
  database.exec(`CREATE TRIGGER fixture_association_failure
    BEFORE INSERT ON authority_project_context_associations_v1
    BEGIN SELECT RAISE(ABORT, 'fixture association failure'); END`);

  repository.withWriteTransaction(transaction => {
    try {
      transaction.submitUpload(snapshot(transaction, request), request);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  expect(database.prepare("SELECT count(*) AS n FROM authority_person_updates_v2 WHERE request_id = ?").get(request.request_id)).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_person_update_work_v2").get()).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_project_context_associations_v1").get()).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_project_command_receipts_v1 WHERE request_id = ?").get(request.request_id)).toEqual({ n: 0 });
});

it("rolls a newly-added association back when recording its replay receipt fails", () => {
  const database = projectContextDatabase();
  databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const project = createProject(repository, 5);
  const upload: PersonUpdateSubmitV2 = {
    schema_version: 2,
    kind: "echo-person-update-submit-v2",
    request_id: requestId(6),
    title: "Receipt fence",
    text: "The association cannot outlive a failed replay receipt write.",
    project_id: null,
    audience: { kind: "only_me" },
  };
  const receipt = repository.withWriteTransaction(transaction => transaction.submitUpload(
    snapshot(transaction, upload), upload,
  ));
  const request = {
    schema_version: 1 as const,
    kind: "echo-project-context-associate-v1" as const,
    request_id: requestId(7),
    project_id: project.project_id,
    context_id: receipt.context_id,
  };
  database.exec(`CREATE TRIGGER fixture_association_receipt_failure
    BEFORE INSERT ON authority_project_command_receipts_v1
    WHEN NEW.request_id = '${request.request_id}'
    BEGIN SELECT RAISE(ABORT, 'fixture association receipt failure'); END`);

  repository.withWriteTransaction(transaction => {
    try {
      transaction.associateContext(transaction.captureAuthorization(
        authorization(OWNER), { operation: "associate", request },
      ), request);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  expect(database.prepare("SELECT count(*) AS n FROM authority_project_context_associations_v1 WHERE context_id = ?").get(receipt.context_id)).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) AS n FROM authority_project_command_receipts_v1 WHERE request_id = ?").get(request.request_id)).toEqual({ n: 0 });
});
