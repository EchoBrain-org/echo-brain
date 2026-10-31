import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import { applyAuthorityBaseline } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import type { AuthorityPersonMembershipBinding } from "@echo-brain/organization-authority-kernel/application/ports/authority-repository";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { OrganizationRecordDecisionBriefV1, OrganizationRecordMeetingTimeV1 } from "@echo-brain/organization-protocol";
import { OrganizationRecordAppenderV4 } from "@echo-brain/organization-record/organization-record-api-v1";
import type { ReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import Database from "better-sqlite3";
import { COORDINATES, database as recordDatabase, protocolAuthority, type ProtocolAuthority } from "../../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { SqlitePersonRecordReadAuditV1 } from "../../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../../src/adapters/persistence/sqlite/project-context-v1.js";
import { createRecordProjectAuthorizationV1 } from "../../src/composition/person-record-project-scope-v1.js";
import type { ApproverMembershipsV1 } from "../../src/composition/person-meeting-items-v1.js";
import { createPersonRecordSearchRouteV1, type CreatePersonRecordSearchRouteV1Options, type PersonRecordSearchRouteV1 } from "../../src/composition/person-record-search-route.js";
import { readableSearchGenerationContractV1 } from "../../src/composition/readable-search-generation-composition.js";
import { addMembership, authorization, seedProject, seedProjectMember } from "./project-context-sqlite.js";
import {
  SIGNED_APPROVAL_APPROVER,
  SIGNED_APPROVAL_CODECS,
  SIGNED_APPROVAL_PROJECTORS,
  appendSignedApprovalV1,
  generationFromRecordDatabase,
  type SignedApprovalInputV1,
} from "./signed-approval-decision-v1.js";

/**
 * A small organization with real signed approval decisions, for the meeting list and open (ADR-0024). Every reader holds
 * EVERYONE, the organization-wide project; OWNER and EMP_A also hold SHARED; EMP_A has left PROJ_X; nobody who reads holds
 * UNJOINED; EMP_B and EMP_C hold nothing else. r1, r7a and r7b are shared with EVERYONE and approved by APPROVER_X, who
 * never reads, so they are nobody's mine.
 */
const person = (name: string, membership_type: "owner" | "employee"): AuthorityPersonMembershipBinding => ({
  organization_id: COORDINATES.organization_id, principal_id: `prn_${name}`, membership_id: `mem_${name}`, membership_type,
});
export const OWNER = person("owner", "owner");
export const EMP_A = person("emp_a", "employee");
export const EMP_B = person("emp_b", "employee");
export const EMP_C = person("emp_c", "employee");
/** Approves r1, r7a and r7b; never a reader. */
export const APPROVER_X = person("approver_x", "employee");
const READERS = { owner: OWNER, emp_a: EMP_A, emp_b: EMP_B, emp_c: EMP_C } as const;
export type ReaderToken = keyof typeof READERS;

export const SHARED = "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const UNJOINED = "prj_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PROJ_X = "prj_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Every reader is a member: what every reader reads. */
export const EVERYONE = "prj_e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
export const PROJECT_NAMES = { [SHARED]: "Shared launch", [UNJOINED]: "Unjoined roadmap", [PROJ_X]: "Project X", [EVERYONE]: "Everyone" } as const;
const NOW = "2026-09-01T00:00:00.000Z";
export const T = (day: number): string => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
export const RETRIEVAL_CONTRACT = readableSearchGenerationContractV1().retrieval_contract_sha256;

export type WorldApprovalV1 = Omit<SignedApprovalInputV1, "audit_sequence"> & { readonly name: string };

const meeting = (title: string | undefined, time: OrganizationRecordMeetingTimeV1) => (brief: OrganizationRecordDecisionBriefV1): OrganizationRecordDecisionBriefV1 =>
  ({ ...brief, meeting: { ...brief.meeting, ...(title === undefined ? {} : { title }), time } });
/** r1..r7b of the world table, in append order. */
export const STANDARD_RECORDS: readonly WorldApprovalV1[] = [
  // 19:00 on Aug 31 in Los Angeles, although Sep 1 in UTC.
  { name: "r1", approval_id: "apr_r1", projects: [EVERYONE], final_approver: APPROVER_X, issued_at: T(1), brief: meeting("Weekly sync", { actual_start_at: "2026-09-01T02:00:00.000Z", timezone: "America/Los_Angeles" }) },
  { name: "r2", approval_id: "apr_r2", projects: [], final_approver: OWNER, issued_at: T(2), brief: meeting(undefined, { scheduled_start_at: "2026-09-02T00:00:00.000Z", all_day: true }) },
  { name: "r3", approval_id: "apr_r3", projects: [SHARED, UNJOINED], final_approver: OWNER, issued_at: T(3) },
  { name: "r4", approval_id: "apr_r4", projects: [SHARED], final_approver: EMP_A, issued_at: T(4), brief: meeting("Pricing review", { actual_start_at: T(4) }) },
  { name: "r6", approval_id: "apr_r6", projects: [PROJ_X], final_approver: EMP_A, issued_at: T(6) },
  { name: "r7a", approval_id: "apr_r7a", projects: [EVERYONE], final_approver: APPROVER_X, issued_at: T(7) },
  { name: "r7b", approval_id: "apr_r7b", projects: [EVERYONE], final_approver: APPROVER_X, issued_at: T(7) },
];

function grant(database: Database.Database, projectId: string, actor: AuthorityPersonMembershipBinding, role: "lead" | "member"): void {
  seedProjectMember(database, projectId, actor, role, { granted_at: NOW });
}

/** Named explicitly: an inferred better-sqlite3 type cannot be emitted from a test module. */
export interface MeetingWorldV1 {
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly signer: ProtocolAuthority;
  readonly state_directory: string;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  /** Changing `state` changes every session tuple. */
  readonly session: { state: string; readonly revoked: Set<string> };
  readonly memberships: ApproverMembershipsV1;
  route(overrides?: Partial<CreatePersonRecordSearchRouteV1Options>): PersonRecordSearchRouteV1;
  /** Record-read audit bodies of one mode, oldest first. */
  audits(read_mode: "layer1" | "layer2" | "person_list" | "person_open"): Record<string, unknown>[];
  /** Appends a signed approval without rebuilding the generation. */
  approve(input: WorldApprovalV1): Promise<Sha256Digest>;
  /** Publishes the generation of the current record head. */
  rebuild(): ReadableSearchActiveGenerationV1;
  leave(projectId: string, actor: AuthorityPersonMembershipBinding): void;
  grant(projectId: string, actor: AuthorityPersonMembershipBinding): void;
  digest(name: string): Sha256Digest;
  close(): void;
}

export async function meetingWorld(options: {
  /** Appended after STANDARD_RECORDS, before the first generation is built. */
  readonly extra?: readonly WorldApprovalV1[];
} = {}): Promise<MeetingWorldV1> {
  const authority: Database.Database = new Database(":memory:");
  authority.pragma("foreign_keys = ON");
  applyAuthorityBaseline(authority);
  authority.prepare(`INSERT INTO authority_metadata
    (singleton, authority_id, organization_id, organization_display_name, descriptor_json, created_at, last_observed_at)
    VALUES (1, ?, ?, 'Meetings', '{}', ?, ?)`).run(COORDINATES.authority_id, COORDINATES.organization_id, NOW, NOW);
  authority.prepare("INSERT INTO authority_project_authorization_state_v1 (organization_id, revision, updated_at) VALUES (?, 0, ?)").run(COORDINATES.organization_id, NOW);
  for (const [actor, name] of [[OWNER, "Olive Owner"], [EMP_A, "Ari Employee"], [EMP_B, "Bea Employee"], [EMP_C, "Cy Employee"], [APPROVER_X, "Xan Approver"]] as const) {
    addMembership(authority, actor, name, actor.membership_type === "owner" ? null : `${actor.principal_id}@example.test`);
  }
  for (const [projectId, creator] of [[SHARED, OWNER], [UNJOINED, APPROVER_X], [PROJ_X, APPROVER_X], [EVERYONE, OWNER]] as const) {
    seedProject(authority, projectId, creator, { name: PROJECT_NAMES[projectId], created_at: NOW });
  }
  grant(authority, SHARED, OWNER, "lead");
  grant(authority, UNJOINED, APPROVER_X, "lead");
  grant(authority, PROJ_X, APPROVER_X, "lead");
  grant(authority, EVERYONE, OWNER, "lead");
  grant(authority, SHARED, EMP_A, "member");
  grant(authority, PROJ_X, EMP_A, "member");
  for (const reader of [EMP_A, EMP_B, EMP_C]) grant(authority, EVERYONE, reader, "member");

  const record: Database.Database = recordDatabase();
  const signer = protocolAuthority();
  const app = new OrganizationRecordAppenderV4(record, COORDINATES, SIGNED_APPROVAL_PROJECTORS);
  const created = mkdtempSync(join(tmpdir(), "echo-person-meetings-"));
  chmodSync(created, 0o700);
  const state_directory = realpathSync(created);
  let sequence = 0;
  const digests = new Map<string, Sha256Digest>();
  const approve = async (input: WorldApprovalV1): Promise<Sha256Digest> => {
    // An approval decision's record carries its destination's derived approval id, so it is found by what was appended.
    const appended = await appendSignedApprovalV1(app, signer, { ...input, audit_sequence: sequence += 1 });
    const row = record.prepare("SELECT record_sha256 FROM organization_record_log WHERE approval_id = ?").get(appended) as { readonly record_sha256: Sha256Digest };
    digests.set(input.name, row.record_sha256);
    return row.record_sha256;
  };
  for (const input of STANDARD_RECORDS) await approve(input);
  for (const input of options.extra ?? []) await approve(input);
  // EMP_A left PROJ_X after approving r6.
  const leave = (projectId: string, actor: AuthorityPersonMembershipBinding): void => {
    authority.prepare("UPDATE authority_project_memberships_v1 SET status='revoked', revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'").run(NOW, projectId, actor.membership_id);
  };
  leave(PROJ_X, EMP_A);
  const rebuild = () => generationFromRecordDatabase({ record, authority, state_directory, signer });
  rebuild();

  const session = { state: "meeting session", revoked: new Set<string>() };
  // Every authentication is a later instant, as it is in production.
  let checks = Date.parse("2026-09-21T22:01:00.000Z");
  const sessions = {
    authenticateAccess: ({ access_token }: { readonly access_token: string }) => {
      const actor = READERS[access_token as ReaderToken];
      if (actor === undefined || session.revoked.has(access_token)) throw new AuthorityOperationError("unauthorized", "person authentication failed");
      return authorization(actor, { session_state_sha256: canonicalSha256(session.state), checked_at: new Date(checks += 1).toISOString() });
    },
  };
  const memberships = {
    membership: (id: string) => authority.prepare(`SELECT m.organization_id, m.principal_id, m.membership_id, p.display_name
      FROM authority_memberships m JOIN authority_principals p ON p.principal_id = m.principal_id WHERE m.membership_id = ?`).get(id) as
      { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string; readonly display_name: string } | undefined,
  };
  const route = (overrides: Partial<CreatePersonRecordSearchRouteV1Options> = {}) => createPersonRecordSearchRouteV1({
    state_directory, ...COORDINATES, retrieval_contract_sha256: RETRIEVAL_CONTRACT, sessions, authority, record,
    audit: new SqlitePersonRecordReadAuditV1(authority),
    capture_projects: createRecordProjectAuthorizationV1(new SqliteProjectContextRepositoryV1(authority)),
    record_input_codecs: SIGNED_APPROVAL_CODECS,
    record_approver: SIGNED_APPROVAL_APPROVER, memberships, ...overrides,
  });
  const audits = (read_mode: "layer1" | "layer2" | "person_list" | "person_open") => (authority.prepare(
    "SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'record_read' ORDER BY rowid",
  ).all() as { readonly body_json: string }[]).map((row) => JSON.parse(row.body_json) as Record<string, unknown>).filter((body) => body.read_mode === read_mode);
  return {
    authority, record, signer, state_directory, sessions, session, memberships, route, audits, approve, rebuild, leave,
    grant: (projectId: string, actor: AuthorityPersonMembershipBinding) => grant(authority, projectId, actor, "member"),
    digest: (name: string): Sha256Digest => digests.get(name)!,
    close: () => { record.close(); authority.close(); rmSync(state_directory, { recursive: true, force: true }); },
  };
}
