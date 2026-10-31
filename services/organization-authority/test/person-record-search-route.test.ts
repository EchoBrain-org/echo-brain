import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { approvalRecordIdV2 } from "@echo-brain/organization-protocol";
import {
  applyOrganizationRecordLogBaselineV6,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  buildReadableSearchGenerationV1,
  searchReadableSearchGenerationV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchPlaneBaselineSha256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
  type ReadableSearchResultItemV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { createPersonRecordSearchRouteV1, PersonRecordSearchIndexLagV1, type CreatePersonRecordSearchRouteV1Options } from "../src/composition/person-record-search-route.js";
import { createRecordProjectAuthorizationV1, recordProjectAuthorizationOfGrantsV1 } from "../src/composition/person-record-project-scope-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../src/adapters/persistence/sqlite/project-context-v1.js";
import { createProjectContextApplicationV1 } from "../src/application/project-context-application-v1.js";
import { addMembership, seedProjectMember } from "./fixtures/project-context-sqlite.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1";
import { EMP_A, EMP_B, OWNER, PROJ_X, SHARED, T, UNJOINED, meetingWorld } from "./fixtures/person-meeting-world.js";

import { independentRecordCoverageFixture, rolloutCoverageFixture } from "./retrieval-coverage-fixture.js";

const roots: string[] = [];
const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const RETRIEVAL_CONTRACT = digest("clean-retrieval-contract");

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-search-route-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

function authorization(): PersonAccessAuthorization {
  return {
    organization_id: "org_clean",
    principal_id: "principal_reader",
    membership_id: "membership_reader",
    membership_type: "employee",
    identity_binding_id: "identity_reader",
    session_family_id: "session_reader",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-22T13:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T14:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: "2026-08-22T12:00:00.000Z",
  };
}

function readerAuthorization(input: {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}): PersonAccessAuthorization {
  return {
    ...authorization(),
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    membership_type: input.membership_type,
    identity_binding_id: `identity_${input.principal_id}`,
    session_family_id: `session_${input.membership_id}`,
    access_credential_sha256: digest(`access_${input.membership_id}`),
  };
}

function realGenerationInput(
  state_directory: string,
  atoms: readonly ReadableSearchAtomV1[],
): BuildReadableSearchGenerationV1Input {
  const authority_id = "oau_clean";
  const organization_id = "org_clean";
  const state_lineage_id = "lineage_clean";
  const exact_head = {
    authority_id,
    organization_id,
    state_lineage_id,
    position: 2,
    record_sha256: sha256Digest("restricted-record"),
  } as const;
  const plane = (
    role: string,
    schema_sha256: Sha256Digest,
    database_schema_version: 1 | 2 | 3 = 1,
  ) => {
    const manifest_json = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id,
      organization_id,
      state_lineage_id,
      database_schema_version,
      schema_sha256,
      created_at: "2026-08-22T00:00:00.000Z",
      creating_artifact_revision: "test",
    });
    return {
      database_schema_version,
      schema_sha256,
      manifest_json,
      manifest_sha256: sha256Digest(manifest_json),
    };
  };
  return {
    state_directory,
    lineage: {
      authority_id,
      organization_id,
      state_lineage_id,
      planes: {
        facts: plane(
          "retrieval-facts",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3),
          READABLE_SEARCH_FACTS_BASELINE_SCHEMA_VERSION_V3,
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_CONTENT_BASELINE_V2), 2,
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_LEXICAL_BASELINE_V2), 2,
        ),
      },
    },
    exact_head,
    retrieval_contract_sha256: RETRIEVAL_CONTRACT,
    organization_member_policy_contract_sha256: sha256Digest("member-policy"),
    restricted_reviewer_policy_contract_sha256:
      sha256Digest("restricted-policy"),
    analyzer: {
      analyzer_contract_sha256: sha256Digest("analyzer-contract"),
      analyzer_source_sha256: sha256Digest("analyzer-source"),
      node_version: "22.22.1",
      unicode_version: "16.0",
      icu_version: "76.1",
    },
    source_revision: "test",
    builder_artifact_sha256: sha256Digest("builder"),
    sqlite_version: "3.50.4",
    atoms,
  };
}

function policyAtom(input: {
  readonly id: "member" | "restricted";
  readonly policy_id: ReadableSearchAtomV1["policy_id"];
}): ReadableSearchAtomV1 {
  const reviewer = input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  return {
    authority_id: "oau_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    record_position: reviewer ? 2 : 1,
    record_sha256: sha256Digest(`${input.id}-record`),
    envelope_sha256: sha256Digest(`${input.id}-envelope`),
    approval_id: `approval-${input.id}`,
    atom_id: sha256Digest(`${input.id}-atom`),
    atom_order: 0,
    signal_id_sha256: sha256Digest(`${input.id}-signal`),
    item_kind: "decision",
    text: `${input.id} policy signal`,
    text_sha256: sha256Digest(`${input.id} policy signal`),
    policy_id: input.policy_id,
    policy_contract_sha256: sha256Digest(`${input.id}-policy`),
    authorization_audit_event_id: `audit-${input.id}`,
    authorization_audit_sequence: reviewer ? 2 : 1,
    authorization_audit_entry_sha256: sha256Digest(`${input.id}-audit`),
    provider_action_sha256: sha256Digest(`${input.id}-provider`),
    authorization_proof_sha256: sha256Digest(`${input.id}-proof`),
    reviewer_principal_id: reviewer ? "principal_owner" : null,
    reviewer_membership_id: reviewer ? "membership_owner" : null,
  };
}

function benchmarkAtom(index: number): ReadableSearchAtomV1 {
  // From index 14 an atom is restricted to a reviewer other than the policy
  // fixture's owner, so the owner never reads it.
  const reviewer = index >= 14;
  const reviewerIndex = reviewer ? index % 14 : 0;
  const text = Array.from(
    { length: 16 },
    (_, term) => `benchmark${term}`,
  ).join(" ");
  return {
    ...policyAtom({
      id: reviewer ? "restricted" : "member",
      policy_id: reviewer
        ? RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2
        : ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
    }),
    record_position: 1,
    record_sha256: sha256Digest(`benchmark-record-${index}`),
    envelope_sha256: sha256Digest(`benchmark-envelope-${index}`),
    approval_id: `benchmark-approval-${index}`,
    atom_id: sha256Digest(`benchmark-atom-${index}`),
    atom_order: index,
    signal_id_sha256: sha256Digest(`benchmark-signal-${index}`),
    text,
    text_sha256: sha256Digest(text),
    authorization_audit_event_id: `benchmark-audit-${index}`,
    authorization_audit_sequence: index + 1,
    authorization_audit_entry_sha256: sha256Digest(
      `benchmark-audit-entry-${index}`,
    ),
    provider_action_sha256: sha256Digest(`benchmark-provider-${index}`),
    authorization_proof_sha256: sha256Digest(`benchmark-proof-${index}`),
    reviewer_principal_id: reviewer ? `reviewer-${reviewerIndex}` : null,
    reviewer_membership_id: reviewer ? `membership-${reviewerIndex}` : null,
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

/** The exact head of setup()'s default pointer. */
const HEAD = { authority_id: "oau_clean", organization_id: "org_clean", state_lineage_id: "lineage_clean", position: 0, record_sha256: null } as const;

/** Points the Authority at a generation and its exact head. */
function pointAt(authority: Database.Database, active: {
  readonly generation_id: Sha256Digest; readonly manifest_sha256: Sha256Digest;
  readonly exact_head: { readonly position: number; readonly record_sha256: Sha256Digest | null };
}): void {
  authority.prepare(`INSERT INTO authority_readable_search_active_generation
    (singleton, organization_id, generation_id, manifest_sha256, retrieval_contract_sha256,
     record_head_position, record_head_hash, published_at) VALUES (1, 'org_clean', ?, ?, ?, ?, ?, '2026-08-22T11:59:00.000Z')`)
    .run(active.generation_id, active.manifest_sha256, RETRIEVAL_CONTRACT, active.exact_head.position, active.exact_head.record_sha256);
}

function setup(pointer = true) {
  const authority = openAuthorityDatabase(":memory:");
  applyAuthorityBaseline(authority);
  authority
    .prepare(
      `INSERT INTO authority_metadata
       (singleton, authority_id, organization_id, organization_display_name,
        descriptor_json, created_at, last_observed_at)
       VALUES (1, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(
      "oau_clean",
      "org_clean",
      "Clean Organization",
      "2026-08-22T11:00:00.000Z",
      "2026-08-22T11:00:00.000Z",
    );
  const record = openOrganizationRecordDatabase(":memory:");
  applyOrganizationRecordLogBaselineV6(record);
  if (pointer) pointAt(authority, { generation_id: digest("generation"), manifest_sha256: digest("manifest"), exact_head: HEAD });
  return { authority, record, state_directory: root() };
}

/** A stubbed Layer 2 result, at setup()'s pointer unless a test moves it. */
function fakeResult<Item>(items: readonly Item[], at: { readonly generation_id?: Sha256Digest; readonly position?: number } = {}) {
  return { generation_id: at.generation_id ?? digest("generation"), exact_head: { ...HEAD, position: at.position ?? 0 }, items };
}

/** The route over setup()'s databases, read by principal_reader unless a test overrides it. */
function createRoute(value: ReturnType<typeof setup>, overrides: Partial<CreatePersonRecordSearchRouteV1Options> = {}) {
  return createPersonRecordSearchRouteV1({
    state_directory: value.state_directory, authority_id: "oau_clean", organization_id: "org_clean",
    state_lineage_id: "lineage_clean", retrieval_contract_sha256: RETRIEVAL_CONTRACT,
    sessions: { authenticateAccess: () => authorization() }, authority: value.authority, record: value.record,
    audit: new SqlitePersonRecordReadAuditV1(value.authority), ...overrides,
  });
}

/** A hand-made record log holding only the head rows the route's fences read. */
function recordLog(): Database.Database {
  const record = new Database(":memory:");
  record.exec("CREATE TABLE organization_record_log (position INTEGER PRIMARY KEY, record_sha256 TEXT NOT NULL)");
  return record;
}

/** Logs `head` in `record`, then builds, warms and points the Authority at a generation over `atoms`. */
function publish(
  value: ReturnType<typeof setup>, record: Database.Database, atoms: readonly ReadableSearchAtomV1[],
  head: { readonly position: number; readonly record_sha256: Sha256Digest }, extra: Partial<BuildReadableSearchGenerationV1Input> = {},
) {
  const input = realGenerationInput(value.state_directory, atoms);
  const exact_head = { ...input.exact_head, ...head };
  record.prepare("INSERT INTO organization_record_log VALUES (?, ?)").run(exact_head.position, exact_head.record_sha256);
  const built = buildReadableSearchGenerationV1({ ...input, ...extra, exact_head });
  const active_generation = { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, retrieval_contract_sha256: RETRIEVAL_CONTRACT, exact_head };
  warmReadableSearchActiveGenerationV1({ state_directory: value.state_directory, active_generation });
  pointAt(value.authority, active_generation);
  return active_generation;
}

const auditCount = (authority: Database.Database) =>
  (authority.prepare("SELECT count(*) AS count FROM authority_person_read_decision_audit_v2").get() as { readonly count: number }).count;

describe("Person Layer 2 route", () => {
  it("keeps approved project records searchable after archive, then removes their scope on leave", async () => {
    const value = setup(false);
    const record = recordLog();
    const reader = authorization();
    const lead = readerAuthorization({ principal_id: "principal_owner", membership_id: "membership_owner", membership_type: "owner" });
    addMembership(value.authority, reader, "Reader", "reader@example.test");
    addMembership(value.authority, lead, "Lead", null);
    value.authority.prepare("INSERT INTO authority_project_authorization_state_v1(organization_id,revision,updated_at) VALUES (?,0,?)").run(reader.organization_id, reader.checked_at);
    const repository = new SqliteProjectContextRepositoryV1(value.authority, () => reader.checked_at);
    const projects = createProjectContextApplicationV1({ repository, authenticate: token => token === "lead" ? lead : reader });
    const created = projects.createProject("lead", { schema_version: 1, kind: "echo-project-create-v1", request_id: randomUUID(), name: "Launch" });
    const projectId = created.project_id;
    seedProjectMember(value.authority, projectId, reader, "member", { granted_at: reader.checked_at });
    const text = "Approved launch remains scheduled for Monday.";
    const atom = { ...policyAtom({ id: "member", policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1 }), policy_contract_sha256: sha256Digest("project-policy"), text, text_sha256: sha256Digest(text), audience_project_ids: [projectId], association_project_ids: [projectId] };
    try {
      publish(value, record, [atom], { position: 1, record_sha256: atom.record_sha256 }, { project_members_policy_contract_sha256: sha256Digest("project-policy") });
      let checkedMilliseconds = Date.parse(reader.checked_at);
      const sessions = { authenticateAccess: () => ({ ...reader, checked_at: new Date(checkedMilliseconds += 1000).toISOString() }) };
      const route = createRoute(value, { sessions, record, capture_projects: createRecordProjectAuthorizationV1(repository) });
      const search = () => route.searchBatch({ access_token: "reader", query: "launch", project_id: projectId });
      expect(search().response.items.map(item => item.text)).toEqual([text]);
      projects.archiveProject("lead", { schema_version: 1, kind: "echo-project-archive-v1", request_id: randomUUID(), project_id: projectId, archived: true });
      const archived = search();
      expect(archived.response.items.map(item => item.text)).toEqual([text]);
      expect(route.searchBatch({ access_token: "reader", query: "launch" }).response.items.map(item => item.text)).toEqual([text]);
      projects.leaveProject("reader", { schema_version: 1, kind: "echo-project-leave-v1", request_id: randomUUID(), project_id: projectId });
      expect(search).toThrow("person authentication failed");
      expect(() => route.revalidateBatchRelease({ access_token: "reader", release: archived.release })).toThrow("person authentication failed");
      expect(route.searchBatch({ access_token: "reader", query: "launch" }).response.items).toEqual([]);
    } finally { record.close(); value.record.close(); value.authority.close(); }
  });
  it("uses trusted project grants for union visibility, association scope, and the final release fence", () => {
    const value = setup(false);
    const record = recordLog();
    const policy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1;
    const alphaId = "prj_00000000-0000-4000-8000-000000000001";
    const betaId = "prj_00000000-0000-4000-8000-000000000002";
    const alpha = { ...policyAtom({ id: "member", policy_id: policy }), policy_contract_sha256: sha256Digest("project-policy"), text: "alpha launch", text_sha256: sha256Digest("alpha launch"), audience_project_ids: [alphaId, betaId], association_project_ids: [alphaId] };
    const beta = { ...policyAtom({ id: "restricted", policy_id: policy }), policy_contract_sha256: sha256Digest("project-policy"), record_position: 2, text: "beta launch", text_sha256: sha256Digest("beta launch"), audience_project_ids: [alphaId, betaId], association_project_ids: [betaId] };
    publish(value, record, [alpha, beta], { position: 2, record_sha256: beta.record_sha256 }, { project_members_policy_contract_sha256: sha256Digest("project-policy") });
    let grants = [
      alphaId,
      ...Array.from({ length: 21 }, (_, index) =>
        `prj_00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      ),
    ].sort();
    const capture_projects = () => ({ project_ids: grants, grants_sha256: canonicalSha256(grants) });
    const route = createRoute(value, { record, capture_projects });
    expect(route.searchBatch({ access_token: "reader", query: "launch", project_id: alphaId }).response.items.map(item => item.text)).toEqual(["alpha launch"]);
    expect(() => route.searchBatch({ access_token: "reader", query: "launch", project_id: betaId })).toThrow("authentication failed");
    const revokeAfterSearch = createRoute(value, { record, capture_projects, search_generation: (input) => { const result = searchReadableSearchGenerationV1(input); grants = []; return result; } });
    expect(() => revokeAfterSearch.searchBatch({ access_token: "reader", query: "launch", project_id: alphaId })).toThrow("person authentication failed");
    grants = [alphaId];
    grants = [];
    expect(route.searchBatch({ access_token: "reader", query: "launch" }).response.items).toEqual([]);
    record.close(); value.record.close(); value.authority.close();
  });
  it.each(["owner", "employee", "other-owner"] as const)("finds independent lexical facts across the four frozen queries for %s", async (actor) => {
    const value = setup(false);
    const record = recordLog();
    const atoms = independentRecordCoverageFixture.records.flatMap((source, index) =>
      source.items.map((item, order): ReadableSearchAtomV1 => ({
        ...policyAtom({ id: index === 3 ? "restricted" : "member", policy_id: index === 3
          ? RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 : ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 }),
        record_position: index + 1,
        record_sha256: sha256Digest(source.title),
        envelope_sha256: sha256Digest(`envelope-${source.title}`),
        atom_id: sha256Digest(item.text),
        atom_order: order,
        signal_id_sha256: sha256Digest(`signal-${item.text}`),
        item_kind: item.kind,
        text: item.text,
        text_sha256: sha256Digest(item.text),
      })),
    );
    try {
      const active_generation = publish(value, record, atoms, { position: 4, record_sha256: atoms.at(-1)!.record_sha256 });
      const reader = readerAuthorization({ principal_id: `principal_${actor}`,
        membership_id: `membership_${actor}`, membership_type: actor === "employee" ? "employee" : "owner" });
      let authenticationCount = 0;
      const search = vi.fn(searchReadableSearchGenerationV1);
      const route = createRoute(value, { record, search_generation: search, sessions: { authenticateAccess: () => ({ ...reader,
        checked_at: new Date(Date.parse(reader.checked_at) + authenticationCount++).toISOString(),
      }) } });
      const reads = independentRecordCoverageFixture.queries.map(query => route.searchBatch({ access_token: "fixture-reader", query, limit: 10 }));
      const released = reads.flatMap(read => read.response.items);
      const revenue = sha256Digest("Revenue signal calibration");
      const perQuery = search.mock.results.map(result => result.value.items as readonly ReadableSearchResultItemV1[]);
      const required = atoms.filter(atom => atom.record_sha256 === revenue &&
        (atom.text.includes("at least 8") || atom.text.includes("confirmed list")));
      expect(required).toHaveLength(2);
      expect(perQuery.map(items => items.length)).toEqual([10, 10, 10, 10]);
      expect(reads.map(read => read.response.items.map(item => item.atom_id))).toEqual(perQuery.map(items => items.map(item => item.atom_id)));
      if (actor === "owner") {
        // Real lexical ranks (one-based, zero means absent), not captured live
        // scores: per-query limits do not lose these facts.
        expect(perQuery.map(items => items.findIndex(item => item.atom_id === required[0]!.atom_id) + 1))
          .toEqual([0, 0, 9, 0]);
        expect(perQuery.map(items => items.findIndex(item => item.atom_id === required[1]!.atom_id) + 1))
          .toEqual([10, 7, 4, 9]);
      }
      for (const fact of required) {
        expect(released.map(item => item.atom_id)).toContain(fact.atom_id);
      }
      for (const read of reads) {
        expect(read.release.active_pointer.generation_id).toBe(active_generation.generation_id);
        expect(read.release.active_pointer.record_head).toEqual({ position: 4, record_sha256: atoms.at(-1)!.record_sha256 });
      }

      // One read per query above.
      expect(search.mock.calls.map(([call]) => call.query)).toEqual([...independentRecordCoverageFixture.queries]);
      for (const [call] of search.mock.calls) {
        expect(call.reader).toEqual({ principal_id: reader.principal_id, membership_id: reader.membership_id });
        expect(call.active_generation).toEqual(active_generation);
      }
      const privateAtoms = atoms.filter(atom => atom.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2);
      if (actor === "owner") {
        expect(released.some(item => item.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2)).toBe(true);
      } else {
        // Owner role alone also cannot grant the exact reviewer's private scope.
        const observed = [...perQuery.flat(), ...released];
        expect(observed.every(item => item.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2)).toBe(true);
        for (const atom of privateAtoms) expect(released.map(item => item.text)).not.toContain(atom.text);
      }
    } finally {
      record.close();
      value.record.close();
      value.authority.close();
    }
  });

  it.each([false, true])("keeps the frozen four-query rollout plan to approved member evidence (mixed corpus: %s)", (mixed) => {
    const value = setup(false);
    const record = recordLog();
    const atoms = rolloutCoverageFixture.records.flatMap((source, index) =>
      source.items.map((item, order): ReadableSearchAtomV1 => ({
        ...policyAtom({ id: "member", policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2 }),
        record_position: 3 - index,
        record_sha256: sha256Digest(source.title),
        envelope_sha256: sha256Digest(`envelope-${source.title}`),
        atom_id: sha256Digest(item.text),
        atom_order: order,
        signal_id_sha256: sha256Digest(`signal-${item.text}`),
        item_kind: item.kind,
        text: item.text,
        text_sha256: sha256Digest(item.text),
      })),
    );
    if (mixed) {
      for (const [index, text] of [
        "September 16 office renovation work remains on schedule; confirm furniture delivery first.",
        "Echo training materials for operational workflows are ready for review.",
        "The September newsletter launch needs an editorial review before publication.",
      ].entries()) {
        atoms.push({ ...atoms[0]!, record_position: 5 + index, record_sha256: sha256Digest(`distractor-${index}`),
          atom_id: sha256Digest(text), atom_order: 0, item_kind: index === 2 ? "decision" : "action",
          text, text_sha256: sha256Digest(text) });
      }
    }
    const privateText = "Echo private commercial concession: 28 locations September 16 guaranteed at a secret discount.";
    atoms.push({ ...policyAtom({ id: "restricted", policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2 }),
      record_position: 4, text: privateText, text_sha256: sha256Digest(privateText) });
    const headAtom = atoms.reduce((head, atom) => atom.record_position > head.record_position ? atom : head);
    try {
      publish(value, record, atoms, { position: headAtom.record_position, record_sha256: headAtom.record_sha256 });
      let authenticationCount = 0;
      const search = vi.fn(searchReadableSearchGenerationV1);
      const route = createRoute(value, { record, search_generation: search, sessions: { authenticateAccess: () => ({ ...authorization(),
        checked_at: new Date(Date.parse("2026-09-09T00:00:00.000Z") + authenticationCount++).toISOString(),
      }) } });
      const read = () => rolloutCoverageFixture.queries.map(query => route.searchBatch({ access_token: "fixture-reader", query, limit: 10 }).response);
      const responses = read();
      if (!mixed) {
        // Real lexical ranks: the adoption decision is found at ranks 10 and 9;
        // the three deadline actions are absent from every top ten.
        expect(search.mock.results.map(result => result.value.items.findIndex((item: ReadableSearchResultItemV1) => item.text.includes("at least 8"))))
          .toEqual([-1, 9, 8, -1]);
        for (const deadline of ["September 3", "September 5", "September 11"]) {
          expect(search.mock.results.every(result => result.value.items.every((item: ReadableSearchResultItemV1) => !item.text.includes(deadline))))
            .toBe(true);
        }
      }
      const items = responses.flatMap(response => response.items);
      expect(items.map(item => item.text).join("\n")).not.toContain(privateText);
      expect(items.every(item => item.policy_id === ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2)).toBe(true);
      expect(items.every(item => atoms.some(atom => atom.atom_id === item.atom_id && atom.text === item.text && atom.record_sha256 === item.record_sha256))).toBe(true);
      expect(read()).toEqual(responses);
      const factual = route.search({ access_token: "fixture-reader", query: "revised data-processing addendum Leah September 5" });
      expect(factual.items[0]!.text).toContain("by September 5");
      // This sentence exists only outside the approved generation.
      expect(route.search({ access_token: "fixture-reader", query: "unapproved-windfall-claim" }).items).toEqual([]);
    } finally {
      record.close();
      value.record.close();
      value.authority.close();
    }
  });

  it("uses only the bearer-derived reader tuple and writes one compact Layer 2 audit", () => {
    const value = setup();
    const search = vi.fn(() => fakeResult([
      {
        atom_id: digest("atom"),
        record_position: 1,
        record_sha256: digest("record"),
        envelope_sha256: digest("envelope"),
        item_kind: "decision" as const,
        text: "Choose the lean path.",
        policy_id: "organization-member-readable-person-v2" as const,
      },
    ]));
    try {
      const route = createRoute(value, { search_generation: search });
      expect(
        route.search({
          access_token: "bearer-only",
          query: "unlogged-query-phrase",
        }),
      ).toEqual({
        schema_version: 2,
        kind: "echo-clean-person-record-search-v2",
        items: [
          {
            atom_id: digest("atom"),
            record_sha256: digest("record"),
            kind: "decision",
            text: "Choose the lean path.",
            policy_id: "organization-member-readable-person-v2",
          },
        ],
      });
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          state_directory: value.state_directory,
          reader: {
            principal_id: "principal_reader",
            membership_id: "membership_reader",
          },
          query: "unlogged-query-phrase",
        }),
      );
      const audit = value.authority
        .prepare(
          "SELECT body_json FROM authority_person_read_decision_audit_v2",
        )
        .get() as { readonly body_json: string };
      const body = JSON.parse(audit.body_json) as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "echo-clean-person-record-read-audit-v1",
        read_mode: "layer2",
        principal_id: "principal_reader",
        membership_id: "membership_reader",
        result_count: 1,
      });
      expect(audit.body_json).not.toContain("unlogged-query-phrase");
      expect(audit.body_json).not.toContain("Choose the lean path.");
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("releases each policy only to the authenticated active member tuple it admits", () => {
    const value = setup(false);
    const record = recordLog();
    const restrictedRecordHash = sha256Digest("restricted-record");
    record
      .prepare(
        "INSERT INTO organization_record_log (position, record_sha256) VALUES (?, ?)",
      )
      .run(2, restrictedRecordHash);
    const built = buildReadableSearchGenerationV1(
      realGenerationInput(value.state_directory, [
        policyAtom({
          id: "member",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
        policyAtom({
          id: "restricted",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        }),
        ...Array.from({ length: 16 }, (_, index) =>
          benchmarkAtom(index + 2),
        ),
      ]),
    );
    warmReadableSearchActiveGenerationV1({
      state_directory: value.state_directory,
      active_generation: {
        generation_id: built.manifest.generation_id,
        manifest_sha256: built.manifest_sha256,
        retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
        exact_head: built.manifest.exact_head,
      },
    });
    pointAt(value.authority, { generation_id: built.manifest.generation_id, manifest_sha256: built.manifest_sha256, exact_head: built.manifest.exact_head });
    const authorizations = {
      "owner-bearer": readerAuthorization({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      }),
      "employee-bearer": readerAuthorization({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      }),
      "replacement-owner-bearer": readerAuthorization({
        principal_id: "principal_owner",
        membership_id: "membership_owner_replacement",
        membership_type: "owner",
      }),
    } as const;
    try {
      const route = createRoute(value, {
        record,
        sessions: {
          authenticateAccess: ({ access_token }) => {
            const current =
              authorizations[access_token as keyof typeof authorizations];
            if (current === undefined) throw new Error("unexpected bearer");
            return current;
          },
        },
      });

      const owner = route.search({
        access_token: "owner-bearer",
        query: "policy",
      });
      const benchmark = route.searchBatch({
        access_token: "owner-bearer",
        query: "benchmark0 benchmark1 benchmark2 benchmark3",
      });
      expect(benchmark.response.items).toHaveLength(10);
      expect(
        benchmark.response.items.every(
          (item) =>
            item.policy_id ===
            ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        ),
      ).toBe(true);
      expect(Object.keys(owner).sort()).toEqual(["items", "kind", "schema_version"]);
      expect(owner.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            atom_id: sha256Digest("member-atom"),
            record_sha256: sha256Digest("member-record"),
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
          }),
          expect.objectContaining({
            atom_id: sha256Digest("restricted-atom"),
            record_sha256: restrictedRecordHash,
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
          }),
        ]),
      );
      expect(owner.items).toHaveLength(2);

      const maximumCallerTermDecisionQuery = route.search({
        access_token: "owner-bearer",
        query: `decision ${Array.from({ length: 31 }, (_, index) => `term${index}`).join(" ")}`,
      });
      expect(maximumCallerTermDecisionQuery.items).toHaveLength(10);

      const employee = route.search({
        access_token: "employee-bearer",
        query: "policy",
      });
      expect(employee.items).toEqual([
        expect.objectContaining({
          atom_id: sha256Digest("member-atom"),
          record_sha256: sha256Digest("member-record"),
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
      ]);

      expect(employee).not.toHaveProperty("generation_id");
      expect(employee).not.toHaveProperty("record_head");
      expect(JSON.stringify(employee)).not.toContain(restrictedRecordHash);
      const emptyEmployee = route.search({ access_token: "employee-bearer", query: "absentneedle" });
      expect(emptyEmployee.items).toEqual([]);
      expect(Object.keys(emptyEmployee).sort()).toEqual(["items", "kind", "schema_version"]);
      expect(JSON.stringify(emptyEmployee)).not.toContain(restrictedRecordHash);

      const replacementOwner = route.search({
        access_token: "replacement-owner-bearer",
        query: "policy",
      });
      expect(replacementOwner.items).toEqual([
        expect.objectContaining({
          atom_id: sha256Digest("member-atom"),
          record_sha256: sha256Digest("member-record"),
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
      ]);
    } finally {
      record.close();
      value.record.close();
      value.authority.close();
    }
  });

  it("returns unavailable without search or audit when the exact-head pointer is absent", () => {
    const value = setup(false);
    const search = vi.fn();
    try {
      const route = createRoute(value, { search_generation: search });
      expect(() =>
        route.search({ access_token: "bearer-only", query: "lean" }),
      ).toThrow(AuthorityOperationError);
      try {
        route.search({ access_token: "bearer-only", query: "lean" });
      } catch (error) {
        expect((error as AuthorityOperationError).code).toBe("unavailable");
      }
      expect(search).not.toHaveBeenCalled();
      expect(auditCount(value.authority)).toBe(0);
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("runs a bounded query batch under one reader and snapshot, then releases one aggregate audit", () => {
    const value = setup();
    const item = (
      name: string,
    ): {
      readonly atom_id: Sha256Digest;
      readonly record_position: number;
      readonly record_sha256: Sha256Digest;
      readonly envelope_sha256: Sha256Digest;
      readonly item_kind: "decision";
      readonly text: string;
      readonly policy_id: "organization-member-readable-person-v2";
    } => ({
      atom_id: digest(`atom-${name}`),
      record_position: 1,
      record_sha256: digest(`record-${name}`),
      envelope_sha256: digest(`envelope-${name}`),
      item_kind: "decision",
      text: `evidence ${name}`,
      policy_id: "organization-member-readable-person-v2",
    });
    const search = vi.fn((_input: { readonly query: string }) => fakeResult([item("original"), item("shared")]));
    let authenticateCount = 0;
    try {
      const route = createRoute(value, {
        sessions: {
          authenticateAccess: () => {
            authenticateCount += 1;
            return authorization();
          },
        },
        search_generation: search,
      });
      const batch = route.searchBatch({
        access_token: "bearer-only",
        query: "original",
      });

      expect(authenticateCount).toBe(2);
      expect(search).toHaveBeenCalledTimes(1);
      for (const call of search.mock.calls) {
        expect(call[0]).toMatchObject({
          reader: {
            principal_id: "principal_reader",
            membership_id: "membership_reader",
          },
          active_generation: {
            generation_id: digest("generation"),
            exact_head: { position: 0, record_sha256: null },
          },
        });
      }
      expect(batch.response.items.map((result) => result.atom_id)).toEqual([
        digest("atom-original"),
        digest("atom-shared"),
      ]);
      expect(batch.release).toMatchObject({
        initial_authorization: {
          principal_id: "principal_reader",
          membership_id: "membership_reader",
        },
        current_authorization: {
          principal_id: "principal_reader",
          membership_id: "membership_reader",
        },
        active_pointer: {
          generation_id: digest("generation"),
          record_head: { position: 0, record_sha256: null },
        },
        record_read_audit_row_sha256: expect.stringMatching(/^sha256:/),
      });
      expect(auditCount(value.authority)).toBe(1);
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it.each([
    ["returns a mismatched generation", digest("other-generation"), 0],
    ["returns a mismatched head", digest("generation"), 1],
  ])("does not release or audit when the search %s", (_name, generation_id, position) => {
    const value = setup();
    const item = {
      atom_id: digest("expansion-anchor"),
      record_position: 1,
      record_sha256: digest("expansion-record"),
      envelope_sha256: digest("expansion-envelope"),
      item_kind: "decision" as const,
      text: "expansion anchor",
      policy_id: "organization-member-readable-person-v2" as const,
    };
    try {
      const route = createRoute(value, { search_generation: () => fakeResult([item], { generation_id, position }) });
      expect(() =>
        route.searchBatch({
          access_token: "bearer-only",
          query: "expansion",
        }),
      ).toThrow("exact-head readable-search generation is not available");
      expect(auditCount(value.authority)).toBe(0);
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it.each([
    ["an empty query", ""],
    ["invalid query", " leading space"],
    [
      "query with 33 unique terms",
      Array.from({ length: 33 }, (_, index) => `term${index}`).join(" "),
    ],
  ])("rejects %s before retrieval or audit", (_name, query) => {
    const value = setup();
    const search = vi.fn();
    const authenticateAccess = vi.fn(() => authorization());
    try {
      const route = createRoute(value, { sessions: { authenticateAccess }, search_generation: search });
      expect(() =>
        route.searchBatch({ access_token: "bearer-only", query }),
      ).toThrow("request is invalid");
      expect(authenticateAccess).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(auditCount(value.authority)).toBe(0);
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("revalidates only the route-local release against the same bearer, pointer, and head", () => {
    const value = setup();
    let currentAuthorization = authorization();
    try {
      const route = createRoute(value, { sessions: { authenticateAccess: () => currentAuthorization }, search_generation: () => fakeResult([]) });
      const { release } = route.searchBatch({
        access_token: "bearer-only",
        query: "original",
      });
      expect(
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toMatchObject({
        principal_id: "principal_reader",
        membership_id: "membership_reader",
      });
      expect(auditCount(value.authority)).toBe(1);

      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release: { ...release },
        }),
      ).toThrow("person authentication failed");
      currentAuthorization = {
        ...authorization(),
        session_family_id: "session-replacement",
      };
      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toThrow("person authentication failed");
      currentAuthorization = authorization();

      value.authority
        .prepare(
          `UPDATE authority_readable_search_active_generation
              SET generation_id = ? WHERE singleton = 1`,
        )
        .run(digest("replacement-generation"));
      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toThrow(expect.objectContaining({ code: "unavailable" }));
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("refuses release when the active generation changes during the read", () => {
    const value = setup();
    try {
      const route = createRoute(value, {
        search_generation: () => {
          value.authority
            .prepare(
              `UPDATE authority_readable_search_active_generation
                  SET generation_id = ? WHERE singleton = 1`,
            )
            .run(digest("replacement-generation"));
          return fakeResult([]);
        },
      });
      expect(() =>
        route.search({ access_token: "bearer-only", query: "lean" }),
      ).toThrow("exact-head readable-search generation is not available");
      expect(auditCount(value.authority)).toBe(0);
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it.each([
    [
      "membership",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        membership_id: "membership_replacement",
      }),
    ],
    [
      "session",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        session_family_id: "session_replacement",
      }),
    ],
    [
      "authorization state",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        person_state_sha256: digest("person-state-replacement"),
      }),
    ],
  ])(
    "does not release or audit when %s changes during the search",
    (_change, changedAuthorization) => {
      const value = setup();
      const admitted = authorization();
      let authenticateCount = 0;
      try {
        const route = createRoute(value, {
          sessions: {
            authenticateAccess: () => {
              authenticateCount += 1;
              return authenticateCount === 1
                ? admitted
                : changedAuthorization(admitted);
            },
          },
          search_generation: () => fakeResult([
            {
              atom_id: digest("atom"),
              record_position: 1,
              record_sha256: digest("record"),
              envelope_sha256: digest("envelope"),
              item_kind: "decision" as const,
              text: "must not leave the Authority",
              policy_id: "organization-member-readable-person-v2" as const,
            },
          ]),
        });

        expect(() =>
          route.search({ access_token: "bearer-only", query: "lean" }),
        ).toThrow("person authentication failed");
        expect(authenticateCount).toBe(2);
        expect(auditCount(value.authority)).toBe(0);
      } finally {
        value.record.close();
        value.authority.close();
      }
    },
  );
});

describe("Person Layer 2 route: a project narrows the desk to its own records (ADR-0024)", () => {
  it("searches, lists and opens only records filed in the project, and its release opens nothing outside it", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const records = (result: { readonly response: { readonly items: readonly { readonly record_sha256: Sha256Digest }[] } }) =>
        [...new Set(result.response.items.map((item) => item.record_sha256))].sort();
      const filed = [w.digest("r3"), w.digest("r4")].sort();
      const global = route.searchBatch({ access_token: "emp_a", query: "Decision", desk: true });
      expect(records(global)).toEqual([w.digest("r1"), w.digest("r3"), w.digest("r4"), w.digest("r7a"), w.digest("r7b")].sort());
      const shared = route.searchBatch({ access_token: "emp_a", query: "Decision", desk: true, project_id: SHARED });
      expect(records(shared)).toEqual(filed);
      expect(shared.release.project_id).toBe(SHARED);
      expect(global.release).not.toHaveProperty("project_id");
      expect(records(route.searchBatch({ access_token: "owner", query: "Decision", project_id: SHARED }))).toEqual(filed);
      // A project the reader does not hold is the Ask denial, before any read.
      expect(() => route.searchBatch({ access_token: "emp_c", query: "Decision", project_id: SHARED })).toThrow(expect.objectContaining({ code: "unauthorized" }));
      const listed = route.listDeskBatch({ access_token: "emp_a", project_id: SHARED });
      expect(records(listed)).toEqual(filed);
      expect(listed.release.project_id).toBe(SHARED);
      expect(route.initializeDesk({ access_token: "emp_a", project_id: SHARED }).release.project_id).toBe(SHARED);
      route.revalidateBatchRelease({ access_token: "emp_a", release: shared.release });

      // A citation to a record outside the project does not open in it; one filed there does.
      const other = global.desk_items!.find((item) => item.record_sha256 === w.digest("r1"))!;
      const own = shared.desk_items!.find((item) => item.record_sha256 === w.digest("r4"))!;
      const cite = (item: typeof own) => ({ access_token: "emp_a", atom_id: item.atom_id, record_sha256: item.record_sha256, policy_id: item.policy_id });
      expect(() => route.openDeskCitation({ ...cite(other), project_id: SHARED })).toThrow(expect.objectContaining({ code: "not_found" }));
      expect(records(route.openDeskCitation(cite(other)))).toEqual([w.digest("r1")]);
      const opened = route.openDeskCitation({ ...cite(own), project_id: SHARED });
      expect(records(opened)).toEqual([w.digest("r4")]);
      expect(opened.release.project_id).toBe(SHARED);
      // A project release cannot open, or expand into, a record outside the project.
      expect(() => route.openDeskBatch({ access_token: "emp_a", release: shared.release, anchor: other })).toThrow(expect.objectContaining({ code: "unavailable" }));
      expect(records(route.openDeskBatch({ access_token: "emp_a", release: shared.release, anchor: own }))).toEqual([w.digest("r4")]);
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: a desk open reads the anchor's own record", () => {
  const ids = (items: readonly { readonly atom_id: Sha256Digest }[]) => items.map((item) => item.atom_id);

  it("returns the anchor, then at most nine more items of its record in the record's order, never another record's", async () => {
    const w = await meetingWorld({ extra: [
      { name: "big", approval_id: "apr_big", projects: [SHARED], final_approver: EMP_A, issued_at: T(9), signals: { decisions: 4, actions: 5, rationales: 3 } },
      // Another record that the same readers read in the same project.
      { name: "pair", approval_id: "apr_pair", projects: [SHARED], final_approver: EMP_A, issued_at: T(10), signals: { decisions: 1, actions: 1 } },
    ] });
    try {
      const route = w.route();
      const listed = route.listDeskBatch({ access_token: "emp_a", project_id: SHARED }).desk_items!;
      const of = (name: string) => listed.filter((item) => item.record_sha256 === w.digest(name)).sort((left, right) => left.atom_order - right.atom_order);
      const open = (item: (typeof listed)[number]) =>
        route.openDeskCitation({ access_token: "emp_a", atom_id: item.atom_id, record_sha256: item.record_sha256, policy_id: item.policy_id });
      // A record's own order runs decisions, then actions, then rationales.
      const big = of("big");
      expect(big.map((item) => item.item_kind)).toEqual([...Array<string>(4).fill("decision"), ...Array<string>(5).fill("action"), ...Array<string>(3).fill("rationale")]);
      for (const anchor of [0, 6, 11]) {
        const opened = open(big[anchor]!);
        expect(ids(opened.response.items)).toEqual(ids([big[anchor]!, ...big.filter((_, index) => index !== anchor).slice(0, 9)]));
        expect(ids(opened.desk_items!)).toEqual(ids(opened.response.items));
        // Twelve items are more than one open releases; the anchor itself is whole.
        expect(opened).toMatchObject({ truncated: true, anchor_truncated: false });
      }
      const pair = of("pair");
      const opened = open(pair[1]!);
      expect(ids(opened.response.items)).toEqual(ids([pair[1]!, pair[0]!]));
      expect(opened).toMatchObject({ truncated: false, anchor_truncated: false });
    } finally { w.close(); }
  });

  it("leaves out an anchor longer than a desk item and says so, keeping the rest of its record", async () => {
    const w = await meetingWorld({ extra: [{
      name: "long", approval_id: "apr_long", projects: [SHARED], final_approver: EMP_A, issued_at: T(9), signals: { decisions: 2, actions: 1 },
      brief: (brief) => ({ ...brief, decisions: brief.decisions.map((signal, index) => (index === 0 ? { ...signal, text: `Decision 0 ${"x".repeat(3_100)}` } : signal)) }),
    }] });
    try {
      const route = w.route();
      const anchor = route.recordAnchor({ access_token: "emp_a", record_sha256: w.digest("long") });
      const opened = route.openDeskCitation({ access_token: "emp_a", atom_id: anchor.atom_id, record_sha256: anchor.record_sha256, policy_id: anchor.policy_id });
      expect(opened.response.items.map((item) => item.text)).toEqual(["Decision 1", "Action 0"]);
      expect(opened).toMatchObject({ truncated: true, anchor_truncated: true });
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: an approved record's projects (research trigger contract v1)", () => {
  it("names only the record's projects the reader can read now, after the exact Layer 1 admission, and audits nothing", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const projects = (token: string, name: string) => route.recordProjects({ access_token: token, record_sha256: w.digest(name) });
      const before = auditCount(w.authority);
      expect(projects("owner", "r4")).toEqual([SHARED]);
      expect(projects("emp_a", "r4")).toEqual([SHARED]);
      // r3 is also in a project the owner never joined; that project's id never leaves the route.
      expect(projects("owner", "r3")).toEqual([SHARED]);
      // A team record is in no project.
      expect(projects("owner", "r1")).toEqual([]);
      w.grant(UNJOINED, OWNER);
      expect(projects("owner", "r3")).toEqual([SHARED, UNJOINED]);
      const notFound = expect.objectContaining({ code: "not_found" });
      // No grant on r4's project, and no such record, are the same miss.
      expect(() => projects("emp_c", "r4")).toThrow(notFound);
      expect(() => route.recordProjects({ access_token: "owner", record_sha256: "sha256:nope" as Sha256Digest })).toThrow(notFound);
      expect(() => route.recordProjects({ access_token: "owner", record_sha256: canonicalSha256("missing") })).toThrow(notFound);
      expect(() => route.recordProjects({ access_token: "nobody", record_sha256: w.digest("r4") })).toThrow(expect.objectContaining({ code: "unauthorized" }));
      expect(auditCount(w.authority)).toBe(before);
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: readable decisions for open items (open items and Home v1)", () => {
  it("names the records the reader can read now, with what a list row shows of each, and audits nothing", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const before = auditCount(w.authority);
      const found = route.readableDecisions({ access_token: "emp_a", record_sha256s: [w.digest("r4"), w.digest("r1"), w.digest("r3"), w.digest("r6"), canonicalSha256("missing"), w.digest("r4"), "sha256:nope" as Sha256Digest] });
      // r6 is in a project emp_a left; a missing or malformed digest is the same miss.
      expect([...found.keys()].sort()).toEqual([w.digest("r1"), w.digest("r3"), w.digest("r4")].sort());
      expect(found.get(w.digest("r4"))).toEqual({ approval_id: approvalRecordIdV2("apr_r4", [SHARED]), record_sha256: w.digest("r4"), title: "Pricing review", approved_at: expect.any(String), project_ids: [SHARED], visibility: "project" });
      expect(found.get(w.digest("r1"))).toMatchObject({ approval_id: "apr_r1", title: "Weekly sync", project_ids: [], visibility: "team" });
      // r3 is also in a project emp_a never joined; that project's id never leaves the route, though its audience counts both.
      expect(found.get(w.digest("r3"))).toMatchObject({ project_ids: [SHARED], visibility: "projects" });
      // A meeting with no title reads as the person list names it.
      expect(route.readableDecisions({ access_token: "owner", record_sha256s: [w.digest("r2")] }).get(w.digest("r2"))).toMatchObject({ title: "Approved meeting", project_ids: [], visibility: "approver_only" });
      expect(route.readableDecisions({ access_token: "emp_c", record_sha256s: [w.digest("r4"), w.digest("r2")] }).size).toBe(0);
      expect(route.readableDecisions({ access_token: "emp_a", record_sha256s: [] }).size).toBe(0);
      expect(() => route.readableDecisions({ access_token: "nobody", record_sha256s: [w.digest("r4")] })).toThrow(expect.objectContaining({ code: "unauthorized" }));
      expect(auditCount(w.authority)).toBe(before);
      // The approval time is the person list's own time for the meeting.
      expect(found.get(w.digest("r4"))!.approved_at).toBe(route.openMeeting({ access_token: "emp_a", record_sha256: w.digest("r4") }).row.added_at);
      // Current grants decide: after leaving SHARED, r4 is no longer readable.
      w.leave(SHARED, EMP_A);
      expect(route.readableDecisions({ access_token: "emp_a", record_sha256s: [w.digest("r4")] }).size).toBe(0);
    } finally { w.close(); }
  });

  it("answers the change check which decisions a reader reads, with their projects, from grants read in its own transaction (ADR-0036)", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const repository = new SqliteProjectContextRepositoryV1(w.authority);
      const records = [w.digest("r4"), w.digest("r1"), w.digest("r3"), w.digest("r6"), w.digest("r2")];
      for (const token of ["owner", "emp_a", "emp_c"] as const) {
        const outside = route.readableDecisions({ access_token: token, record_sha256s: records });
        const captured = createRecordProjectAuthorizationV1(repository)(w.sessions.authenticateAccess({ access_token: token }));
        const before = auditCount(w.authority);
        // Outside a transaction of its own the change view refuses to read.
        expect(() => repository.personChangeView(w.sessions.authenticateAccess({ access_token: token }))).toThrow("inside its own read transaction");
        const inside = w.authority.transaction(() => {
          const view = repository.personChangeView(w.sessions.authenticateAccess({ access_token: token }));
          const projects = recordProjectAuthorizationOfGrantsV1(view.grants);
          expect(projects).toEqual(captured);
          // Capturing the grants again would nest a second transaction.
          expect(() => route.readableDecisions({ access_token: token, record_sha256s: records })).toThrow("not reentrant");
          return route.readableDecisionProjects({ access_token: token, record_sha256s: records, projects });
        }).deferred();
        // The same readers and projects as readableDecisions, with no record read beyond the check.
        expect([...inside.entries()]).toEqual([...outside.entries()].map(([record, decision]) => [record, { project_ids: decision.project_ids }]));
        expect(auditCount(w.authority)).toBe(before);
      }
      // The change view lists every project the V2 list pages through, active and archived, with no audit row.
      const projects = createProjectContextApplicationV1({ authenticate: (access_token) => w.sessions.authenticateAccess({ access_token }), repository });
      projects.archiveProject("owner", { schema_version: 1, kind: "echo-project-archive-v1", request_id: randomUUID(), project_id: SHARED, archived: true });
      const listed = (["active", "archived"] as const).flatMap((status) => projects.listProjectsV2("owner", { limit: 10, status }).items
        .map(({ project_id, name, status: listedStatus, role }) => ({ project_id, name, status: listedStatus, role })));
      const audits = () => [auditCount(w.authority), w.authority.prepare("SELECT count(*) FROM authority_project_read_audit_v1").pluck().get()];
      const before = audits();
      const view = w.authority.transaction(() => repository.personChangeView(w.sessions.authenticateAccess({ access_token: "owner" }))).deferred();
      expect(view.projects).toEqual(listed);
      expect(view.projects).toEqual([{ project_id: SHARED, name: "Shared launch", status: "archived", role: "lead" }]);
      expect(audits()).toEqual(before);
      // The list itself is audited, as ever.
      projects.listProjectsV2("owner", { limit: 10, status: "archived" });
      expect(audits()[1]).toBe((before[1] as number) + 1);
    } finally { w.close(); }
  });

  it("lists the records a reader can read in one project now, newest first, and audits nothing", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const before = auditCount(w.authority);
      expect(route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 500 })).toEqual([w.digest("r4"), w.digest("r3")]);
      expect(route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 1 })).toEqual([w.digest("r4")]);
      expect(route.projectRecords({ access_token: "owner", project_id: SHARED, limit: 500 })).toEqual([w.digest("r4"), w.digest("r3")]);
      // A project the reader does not hold lists nothing, whatever it holds.
      expect(route.projectRecords({ access_token: "emp_c", project_id: SHARED, limit: 500 })).toEqual([]);
      expect(route.projectRecords({ access_token: "owner", project_id: UNJOINED, limit: 500 })).toEqual([]);
      expect(route.projectRecords({ access_token: "emp_a", project_id: PROJ_X, limit: 500 })).toEqual([]);
      w.grant(UNJOINED, OWNER);
      expect(route.projectRecords({ access_token: "owner", project_id: UNJOINED, limit: 500 })).toEqual([w.digest("r3")]);
      const invalid = expect.objectContaining({ code: "invalid_request" });
      expect(() => route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 0 })).toThrow(invalid);
      expect(() => route.projectRecords({ access_token: "emp_a", project_id: SHARED, limit: 501 })).toThrow(invalid);
      expect(() => route.projectRecords({ access_token: "emp_a", project_id: "prj_nope", limit: 5 })).toThrow(invalid);
      expect(() => route.projectRecords({ access_token: "nobody", project_id: SHARED, limit: 5 })).toThrow(expect.objectContaining({ code: "unauthorized" }));
      expect(auditCount(w.authority)).toBe(before);
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: an approved meeting's actions (follow-ups thread v1)", () => {
  it("returns the brief's actions in order with their confirmed owners, after the exact Layer 1 admission, and audits nothing", async () => {
    const w = await meetingWorld({ extra: [{ name: "r9", approval_id: "apr_r9", projects: [SHARED], final_approver: EMP_A, issued_at: T(9), signals: { decisions: 1, actions: 2 },
      brief: (brief) => ({ ...brief, actions: brief.actions.map((action, at) => (at === 0 ? { ...action, text: "Send the vendor the pilot plan" } : action)) }),
      action_owners: [{ signal_id: "action-apr_r9-0", owner: "Ari Employee" }] }] });
    try {
      const route = w.route();
      const before = auditCount(w.authority);
      const expected = [{ signal_id: "action-apr_r9-0", text: "Send the vendor the pilot plan", owner: "Ari Employee" }, { signal_id: "action-apr_r9-1", text: "Action 1", owner: null }];
      expect(route.recordActions({ access_token: "emp_a", record_sha256: w.digest("r9") })).toEqual(expected);
      expect(route.recordActions({ access_token: "owner", record_sha256: w.digest("r9") })).toEqual(expected);
      expect(Object.isFrozen(route.recordActions({ access_token: "emp_a", record_sha256: w.digest("r9") })[0])).toBe(true);
      // A meeting that decided no action has none.
      expect(route.recordActions({ access_token: "emp_a", record_sha256: w.digest("r4") })).toEqual([]);
      const notFound = expect.objectContaining({ code: "not_found" });
      // No grant on its project, no such record, a malformed digest and a rejection are the same miss.
      expect(() => route.recordActions({ access_token: "emp_c", record_sha256: w.digest("r9") })).toThrow(notFound);
      expect(() => route.recordActions({ access_token: "owner", record_sha256: canonicalSha256("missing") })).toThrow(notFound);
      expect(() => route.recordActions({ access_token: "owner", record_sha256: "sha256:nope" as Sha256Digest })).toThrow(notFound);
      expect(() => route.recordActions({ access_token: "owner", record_sha256: w.digest("r5") })).toThrow(notFound);
      expect(() => route.recordActions({ access_token: "nobody", record_sha256: w.digest("r9") })).toThrow(expect.objectContaining({ code: "unauthorized" }));
      expect(auditCount(w.authority)).toBe(before);
      // Current grants decide.
      w.leave(SHARED, EMP_A);
      expect(() => route.recordActions({ access_token: "emp_a", record_sha256: w.digest("r9") })).toThrow(notFound);
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: an approved record's anchor (runs store v1)", () => {
  const trigger = AGENTIC_TRIGGER_DEFINITIONS_V1.find((definition) => definition.name === "approved_record")!;

  it("returns the record's first atom as an approved-record citation that the desk and the trigger accept", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const anchor = route.recordAnchor({ access_token: "emp_a", record_sha256: w.digest("r4") });
      expect(Object.keys(anchor).sort()).toEqual(["atom_id", "kind", "policy_id", "record_sha256"]);
      expect(anchor).toMatchObject({ kind: "approved_record", record_sha256: w.digest("r4"), policy_id: "project-members-readable-person-v1" });

      // With several atoms it is the first in the record's own order.
      const many = await w.approve({ name: "r9", approval_id: "apr_r9", projects: [SHARED], final_approver: EMP_A, issued_at: T(9), signals: { decisions: 2, actions: 2, rationales: 1 } });
      w.rebuild();
      const atoms = route.listDeskBatch({ access_token: "emp_a" }).desk_items!.filter((item) => item.record_sha256 === many);
      expect(atoms.map((item) => item.atom_order).sort()).toEqual([0, 1, 2, 3, 4]);
      const first = route.recordAnchor({ access_token: "emp_a", record_sha256: many });
      expect(first.atom_id).toBe(atoms.find((item) => item.atom_order === 0)!.atom_id);
      expect(atoms.find((item) => item.atom_order === 0)!.item_kind).toBe("decision");

      // The desk opens it, and the approved-record trigger takes it as its event.
      const opened = route.openDeskCitation({ access_token: "emp_a", atom_id: anchor.atom_id, record_sha256: anchor.record_sha256, policy_id: anchor.policy_id });
      expect([...new Set(opened.response.items.map((item) => item.record_sha256))]).toEqual([w.digest("r4")]);
      expect(trigger.parseEvent({ record: anchor })).toEqual({ record: anchor });

      // The same record anchors the same way for another reader who can read it, and a team record anchors too.
      expect(route.recordAnchor({ access_token: "owner", record_sha256: w.digest("r4") })).toEqual(anchor);
      expect(route.recordAnchor({ access_token: "emp_c", record_sha256: w.digest("r1") })).toMatchObject({ kind: "approved_record", record_sha256: w.digest("r1"), policy_id: "organization-member-readable-person-v2" });
    } finally { w.close(); }
  });

  it("is a lookup: it audits nothing", async () => {
    const w = await meetingWorld();
    try {
      const before = auditCount(w.authority);
      w.route().recordAnchor({ access_token: "emp_a", record_sha256: w.digest("r4") });
      expect(auditCount(w.authority)).toBe(before);
    } finally { w.close(); }
  });

  it("throws index lag for a record the active generation does not include yet, and finds it once it does", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const digest = await w.approve({ name: "r8", approval_id: "apr_r8", projects: [SHARED], final_approver: EMP_A, issued_at: T(8) });
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: digest })).toThrow(PersonRecordSearchIndexLagV1);
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: digest })).toThrow(expect.objectContaining({ code: "unavailable" }));
      // The older records stay behind the same lag: the generation is not at the log's head.
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: w.digest("r4") })).toThrow(PersonRecordSearchIndexLagV1);
      w.rebuild();
      expect(route.recordAnchor({ access_token: "emp_a", record_sha256: digest })).toMatchObject({ kind: "approved_record", record_sha256: digest });
    } finally { w.close(); }
  });

  it("says index lag exactly when the anchor would, reading no record and auditing nothing", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      expect(route.recordIndexLags()).toBe(false);
      const digest = await w.approve({ name: "r8", approval_id: "apr_r8", projects: [SHARED], final_approver: EMP_A, issued_at: T(8) });
      const before = auditCount(w.authority);
      expect(route.recordIndexLags()).toBe(true);
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: digest })).toThrow(PersonRecordSearchIndexLagV1);
      expect(auditCount(w.authority)).toBe(before);
      w.rebuild();
      expect(route.recordIndexLags()).toBe(false);
      expect(route.recordAnchor({ access_token: "emp_a", record_sha256: digest })).toMatchObject({ kind: "approved_record", record_sha256: digest });
      // A generation of another retrieval contract is unavailable, not lag: the run's own anchor answers that.
      expect(w.route({ retrieval_contract_sha256: canonicalSha256("another contract") }).recordIndexLags()).toBe(false);
    } finally { w.close(); }
  });

  it("answers not_found, indexed or not, to a reader who cannot see the record", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      const notFound = expect.objectContaining({ code: "not_found" });
      // r4 is in SHARED only; emp_c holds nothing. r3 is also in a project nobody reading holds.
      expect(() => route.recordAnchor({ access_token: "emp_c", record_sha256: w.digest("r4") })).toThrow(notFound);
      expect(() => route.recordAnchor({ access_token: "emp_b", record_sha256: w.digest("r4") })).toThrow(notFound);
      // A record that does not exist, and a malformed digest, are the same miss.
      expect(() => route.recordAnchor({ access_token: "owner", record_sha256: canonicalSha256("missing") })).toThrow(notFound);
      expect(() => route.recordAnchor({ access_token: "owner", record_sha256: "sha256:nope" as Sha256Digest })).toThrow(notFound);
      // A rejected approval writes no readable record.
      expect(() => route.recordAnchor({ access_token: "owner", record_sha256: w.digest("r5") })).toThrow(notFound);
      expect(() => route.recordAnchor({ access_token: "nobody", record_sha256: w.digest("r4") })).toThrow(expect.objectContaining({ code: "unauthorized" }));

      // Not seeing a record outranks its index lag: nothing about it leaks.
      const lagging = await w.approve({ name: "r8", approval_id: "apr_r8", projects: [SHARED], final_approver: EMP_A, issued_at: T(8) });
      expect(() => route.recordAnchor({ access_token: "emp_c", record_sha256: lagging })).toThrow(notFound);
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: lagging })).toThrow(PersonRecordSearchIndexLagV1);
    } finally { w.close(); }
  });

  it("follows the reader's current grants", async () => {
    const w = await meetingWorld();
    try {
      const route = w.route();
      expect(route.recordAnchor({ access_token: "emp_a", record_sha256: w.digest("r4") })).toMatchObject({ kind: "approved_record" });
      w.leave(SHARED, EMP_A);
      expect(() => route.recordAnchor({ access_token: "emp_a", record_sha256: w.digest("r4") })).toThrow(expect.objectContaining({ code: "not_found" }));
      // The owner still holds the project.
      expect(route.recordAnchor({ access_token: "owner", record_sha256: w.digest("r4") })).toMatchObject({ kind: "approved_record" });
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: Ask's list rows name each meeting record by its own line (ADR-0041)", () => {
  it("gives every decision, action and rationale a list label of its own text and its meeting, released and audited with the row", async () => {
    // Over 80 characters, so its line is cut.
    const long = "Keep the DVT gate on hold until the probe reads within 0.1 C at 42 C across every fixture position and both firmware builds.";
    const w = await meetingWorld({ extra: [{
      name: "r9", approval_id: "apr_r9", projects: [SHARED], final_approver: EMP_A, issued_at: T(9), signals: { decisions: 1, actions: 1, rationales: 1 },
      action_owners: [{ signal_id: "action-apr_r9-0", owner: "Ari Employee" }],
      brief: (brief) => ({ ...brief, meeting: { ...brief.meeting, title: "THERM DVT sync", time: { actual_start_at: "2026-10-04T16:00:00.000Z" } }, decisions: brief.decisions.map((signal) => ({ ...signal, text: long })) }),
    }] });
    try {
      const route = w.route();
      const listed = route.listDeskBatch({ access_token: "emp_a" });
      const items = listed.desk_items!;
      const r9 = items.filter((item) => item.record_sha256 === w.digest("r9"));
      expect(r9.map((item) => item.item_kind).sort()).toEqual(["action", "decision", "rationale"]);
      // The label stays the meeting's; the list label is one line of the record's own text, then its meeting.
      for (const item of r9) expect(item.label).toBe("THERM DVT sync (2026-10-04)");
      expect(r9.find((item) => item.item_kind === "decision")!.list_label).toBe(`${[...long].slice(0, 79).join("").trimEnd()}… (THERM DVT sync, 2026-10-04)`);
      // An action's line is its own text: its owner is the row's own fact, not part of its line.
      const action = r9.find((item) => item.item_kind === "action")!;
      expect(action.text).toMatch(/ Owner: Ari Employee\.$/u);
      expect(action.list_label).toBe(`${action.text.replace(/ Owner: Ari Employee\.$/u, "")} (THERM DVT sync, 2026-10-04)`);
      // Every other record is named the same way, from its meeting's title (or "Approved meeting") and day.
      const meetings = new Map([[w.digest("r1"), "Weekly sync, 2026-09-01"], [w.digest("r4"), "Pricing review, 2026-09-04"]]);
      const others = items.filter((value) => meetings.has(value.record_sha256));
      expect(new Set(others.map((item) => item.record_sha256)).size).toBe(2);
      for (const item of others) expect(item.list_label).toBe(`${item.text} (${meetings.get(item.record_sha256)})`);
      // The read audit's response digest binds the list labels with the rows they name.
      const digest = (desk_items: readonly unknown[]) => canonicalSha256(JSON.parse(canonicalJson({ response: listed.response, desk_items })) as never);
      const audited = w.audits("layer2").map((body) => body.response_sha256);
      expect(audited).toContain(digest(items));
      expect(audited).not.toContain(digest(items.map(({ list_label: _listLabel, ...item }) => item)));
      // A reader who cannot read r9 gets neither its row nor its line.
      const other = route.listDeskBatch({ access_token: "emp_c" });
      expect(other.desk_items!.some((item) => item.record_sha256 === w.digest("r9"))).toBe(false);
      expect(JSON.stringify(other)).not.toContain("THERM DVT sync");
      expect(JSON.stringify(route.searchBatch({ access_token: "emp_c", query: "DVT", desk: true }))).not.toContain("THERM DVT sync");
      // A search releases the same line with the hit.
      const searched = route.searchBatch({ access_token: "emp_a", query: "fixture position", desk: true }).desk_items!;
      expect(searched.filter((item) => item.record_sha256 === w.digest("r9")).map((item) => item.list_label)).toEqual([r9.find((item) => item.item_kind === "decision")!.list_label]);
    } finally { w.close(); }
  });
});

describe("Person Layer 2 route: approved records carry their dates and their meeting's people (research tool contract v1)", () => {
  const people = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `p-${index}`, display_name: `Person ${String(index + 1).padStart(2, "0")}` }));

  it("gives every atom its approval time, and its meeting's participants and final approver as the person open names them, released and audited with it", async () => {
    const w = await meetingWorld({ extra: [
      { name: "r9", approval_id: "apr_r9", projects: [SHARED], final_approver: OWNER, issued_at: "2026-10-05T23:30:00.000Z", signals: { decisions: 1, actions: 1 },
        brief: (brief) => ({ ...brief, meeting: { ...brief.meeting, title: "THERM DVT sync", time: { actual_start_at: "2026-10-04T16:00:00.000Z" },
          participants: [{ id: "ari", display_name: "Ari Employee", identities: [{ kind: "email", value: "ari-identity@example.test" }] }, { id: "maya", display_name: "Maya Chen" }, { id: "maya-again", display_name: "Maya Chen" }, { id: "unnamed" }] },
          actions: brief.actions.map((signal) => ({ ...signal, due_at: "2026-10-09T17:00:00.000Z" })) }) },
      // A Team approval is a generic human act, which names no approver; forty participants are more than open releases.
      { name: "crowd", approval_id: "apr_crowd", projects: "team", final_approver: EMP_B, issued_at: T(10), brief: (brief) => ({ ...brief, meeting: { ...brief.meeting, participants: people(40) } }) },
    ] });
    try {
      const route = w.route();
      const listed = route.listDeskBatch({ access_token: "emp_a" });
      const of = (name: string) => listed.desk_items!.filter((item) => item.record_sha256 === w.digest(name));
      const r9 = of("r9");
      expect(r9.map((item) => [item.item_kind, item.dates, item.attributes])).toEqual([
        ["decision", { occurred: "2026-10-04T16:00:00.000Z", approved: "2026-10-05T23:30:00.000Z" }, { status: "decided", participants: "Ari Employee, Maya Chen", approved_by: "Olive Owner" }],
        ["action", { occurred: "2026-10-04T16:00:00.000Z", approved: "2026-10-05T23:30:00.000Z", due: "2026-10-09T17:00:00.000Z" }, { due_at: "2026-10-09T17:00:00.000Z", participants: "Ari Employee, Maya Chen", approved_by: "Olive Owner" }],
      ]);
      // The open's names, "and more" past its 32, and no approver a record does not name.
      expect(of("crowd")[0]!.attributes).toEqual({ status: "decided", participants: `${people(32).map((person) => person.display_name).join(", ")}, and more` });
      expect(of("r1")[0]).toMatchObject({ dates: { occurred: "2026-09-01T02:00:00.000Z", approved: T(1) }, attributes: { status: "decided" } });
      expect(of("r3")[0]!.dates).toEqual({ approved: T(3) });
      // Names only: no identity, id or membership of a participant or the approver.
      for (const hidden of ["ari-identity", "unnamed", "prn_", "mem_"]) expect(JSON.stringify(r9)).not.toContain(hidden);
      // A search and an open release the same facts with the atom.
      const searched = route.searchBatch({ access_token: "emp_a", query: "Decision", desk: true }).desk_items!.find((item) => item.record_sha256 === w.digest("r9"))!;
      expect(searched).toMatchObject({ dates: r9[0]!.dates, attributes: r9[0]!.attributes });
      const opened = route.openDeskCitation({ access_token: "emp_a", atom_id: searched.atom_id, record_sha256: searched.record_sha256, policy_id: searched.policy_id });
      expect(opened.desk_items!.map((item) => item.attributes?.approved_by)).toEqual(["Olive Owner", "Olive Owner"]);
      // The read audit's digest binds them with the rows they describe.
      const digest = (desk_items: readonly unknown[]) => canonicalSha256(JSON.parse(canonicalJson({ response: listed.response, desk_items })) as never);
      expect(w.audits("layer2").map((body) => body.response_sha256)).toContain(digest(listed.desk_items!));
      expect(w.audits("layer2").map((body) => body.response_sha256)).not.toContain(digest(listed.desk_items!.map(({ attributes: _attributes, ...item }) => item)));
      // The approver's name is the directory's current label; without a directory it is left out, and the participants stay.
      expect(w.route({ memberships: undefined }).listDeskBatch({ access_token: "emp_a" }).desk_items!.find((item) => item.record_sha256 === w.digest("r9"))!.attributes)
        .toEqual({ status: "decided", participants: "Ari Employee, Maya Chen" });
      // A reader who cannot read r9 gets neither its people nor its approver.
      const other = JSON.stringify([route.listDeskBatch({ access_token: "emp_c" }), route.searchBatch({ access_token: "emp_c", query: "Decision Action", desk: true })]);
      for (const hidden of ["Maya Chen", "Ari Employee", "Olive Owner", "2026-10-05T23:30:00.000Z"]) expect(other).not.toContain(hidden);
    } finally { w.close(); }
  });

  it("filters by any meetings date before the limit, and counts the atoms of its selection a date cannot test, never as a notice", async () => {
    const w = await meetingWorld({ extra: [{
      name: "r9", approval_id: "apr_r9", projects: [SHARED], final_approver: EMP_A, issued_at: "2026-10-05T23:30:00.000Z", signals: { decisions: 1, actions: 2 },
      brief: (brief) => ({ ...brief, meeting: { ...brief.meeting, time: { actual_start_at: "2026-10-04T16:00:00.000Z" } }, actions: brief.actions.map((signal, index) => ({ ...signal, due_at: index === 0 ? "2026-10-09T17:00:00.000Z" : null })) }),
    }] });
    try {
      const route = w.route();
      // emp_a reads r1 (held Aug 31 in Los Angeles, approved Sep 1), r3, r7a and r7b (no meeting time; approved Sep 3, 7, 7), r4 (held
      // and approved Sep 4) and r9 (held Oct 4, approved Oct 5 at 16:30 in Los Angeles; a decision and two actions, one due Oct 9).
      const read = (filter: Record<string, unknown>) => {
        const listed = route.listDeskBatch({ access_token: "emp_a", ...filter });
        expect(listed).not.toHaveProperty("notice");
        return { atoms: listed.desk_items!.map((item) => `${Object.entries({ r1: 1, r3: 3, r4: 4, r7a: 7, r7b: 8, r9: 9 }).find(([name]) => w.digest(name) === item.record_sha256)![0]}:${item.item_kind}`).sort(), unchecked: listed.unchecked };
      };
      const day = (value: string) => ({ since: value, until: value });
      expect(read({ ...day("2026-09-07"), date_field: "approved" })).toEqual({ atoms: ["r7a:decision", "r7b:decision"], unchecked: undefined });
      expect(read({ ...day("2026-10-05"), date_field: "approved", time_zone: "America/Los_Angeles" }).atoms).toEqual(["r9:action", "r9:action", "r9:decision"]);
      expect(read({ ...day("2026-10-05"), date_field: "approved", time_zone: "Asia/Tokyo" }).atoms).toEqual([]);
      // No field is the meeting's time, as before: the undated meetings are counted, with the date they do record.
      expect(read(day("2026-10-16"))).toEqual({ atoms: [], unchecked: { count: 3, dates: ["approved"] } });
      expect(read({ ...day("2026-10-04"), date_field: "occurred" })).toEqual({ atoms: ["r9:action", "r9:action", "r9:decision"], unchecked: { count: 3, dates: ["approved"] } });
      // The count is of the requested kinds: no undated meeting has an action.
      expect(read({ ...day("2026-10-16"), kinds: ["action"] })).toEqual({ atoms: [], unchecked: undefined });
      expect(read({ ...day("2026-10-09"), date_field: "due" })).toEqual({ atoms: ["r9:action"], unchecked: { count: 7, dates: ["occurred", "approved"] } });
      // No approved record records when ECHO received it: every atom is untested.
      expect(read({ ...day("2026-10-09"), date_field: "received" })).toEqual({ atoms: [], unchecked: { count: 8, dates: ["occurred", "due", "approved"] } });
      // Any of an atom's dates: an approval, a due date, or a meeting's day in its own time zone.
      expect(read({ ...day("2026-09-03"), date_field: "any" })).toEqual({ atoms: ["r3:decision"], unchecked: undefined });
      expect(read({ ...day("2026-10-09"), date_field: "any" }).atoms).toEqual(["r9:action"]);
      expect(read({ ...day("2026-08-31"), date_field: "any" }).atoms).toEqual(["r1:decision"]);
      expect(read({ until: "2026-09-03", date_field: "any" }).atoms).toEqual(["r1:decision", "r3:decision"]);
      // Selected before the limit: the newest atoms are r9's, which that day does not hold.
      expect(route.listDeskBatch({ access_token: "emp_a", ...day("2026-09-07"), date_field: "approved", limit: 2 })).toMatchObject({
        truncated: false, desk_items: [expect.objectContaining({ record_sha256: w.digest("r7b") }), expect.objectContaining({ record_sha256: w.digest("r7a") })] });
      // A search selects the same atoms, and says the same of its selection whatever its words match.
      const searched = route.searchBatch({ access_token: "emp_a", query: "Decision", desk: true, ...day("2026-10-16") });
      expect(searched).toMatchObject({ response: { items: [] }, unchecked: { count: 3, dates: ["approved"] } });
      expect(searched).not.toHaveProperty("notice");
      expect(route.searchBatch({ access_token: "emp_a", query: "Decision", desk: true, ...day("2026-09-07"), date_field: "approved" }).response.items.map((item) => item.record_sha256).sort())
        .toEqual([w.digest("r7a"), w.digest("r7b")].sort());
      // The count is the release's: audited with it.
      const listed = route.listDeskBatch({ access_token: "emp_a", ...day("2026-10-16") });
      expect(w.audits("layer2").at(-1)!.response_sha256).toBe(canonicalSha256(JSON.parse(canonicalJson({ response: listed.response, desk_items: listed.desk_items, unchecked: listed.unchecked })) as never));
      // A project counts only its own records: SHARED's undated r3, never the team's r7a and r7b.
      expect(route.listDeskBatch({ access_token: "emp_a", project_id: SHARED, ...day("2026-10-16") })).toMatchObject({ desk_items: [], unchecked: { count: 1, dates: ["approved"] } });
      // A field no meetings item records is refused, naming those it records.
      for (const date_field of ["created", "updated", "sent", "checked"]) {
        expect(() => route.listDeskBatch({ access_token: "emp_a", ...day("2026-10-16"), date_field: date_field as never })).toThrow("This source supports date_field: occurred, due, received, approved, any");
      }
    } finally { w.close(); }
  });
});
