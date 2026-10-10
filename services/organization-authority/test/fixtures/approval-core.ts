import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV14 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { SqliteApprovalWorkflowStateV1, SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { bindApprovalWorkflowStateV1, type ApprovalWorkflowStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1';
import type { ActionSignal, DecisionSet, MeetingDocument } from '@echo-brain/organization-processing/core';
import { meetingSourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import { applyOrganizationRecordLogBaselineV4, OrganizationRecordAppenderV4, RecordRetrievalSourceSnapshotPortV1, type RecordPolicyFactProjectorRegistryV1, type RecordRetrievalSourceAtomV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { organizationAuthorityPinSha256, verifyOrganizationAuthorityPin, verifyOrganizationRecordEnvelopeV4 } from '@echo-brain/organization-protocol';
import type { ApprovalWorkflowContextV1, ApprovalWorkflowProcessingV1 } from '@echo-brain/organization-processing/ports/approval-workflow-bundle-v1';
import { testAuthority } from '../../../../packages/organization-protocol/test/fixtures/record-v4-fixture.js';
import { database as sourceFixture, databases as fixtures, decisions as fixtureDecisions, FIXTURE_SOURCE_KEY, fixtureCursorPolicy, meeting as fixtureMeeting, REVIEW_POLICY } from '../../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { createApprovalCoreV1, createApprovalPublisherV1, type AfterApprovedRecordHookV1, type ApprovalAuthorizationV1, type ApprovalCoreOptionsV1, type ApprovalCoreV1, type ApprovalDecisionRequestV1 } from '../../src/composition/approval-core-v1.js';
import { AUTHORITY_RECORD_INPUT_CODECS_V1, authorityRecordPolicyProjectorsV1 } from '../../src/composition/authority-record-protocols-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../../src/adapters/persistence/sqlite/source-admission-v1.js';
import { SqlitePersonMeetingIntakeV1, type PersonalMeetingCheckpointCodecV1, type PersonalMeetingCheckpointV1 } from '../../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { addMembership } from './project-context-sqlite.js';

const opened: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of [...opened.splice(0), ...fixtures.splice(0)]) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CURSOR_PREFIX = 'fixture-source:v1:live:';
/** The fixture source's live cursor carries a personal checkpoint; the admitted initial cursor reads as empty. */
export const fixtureCheckpointCodec: PersonalMeetingCheckpointCodecV1 = {
  read(value: string): PersonalMeetingCheckpointV1 {
    if (!value.startsWith(CURSOR_PREFIX)) throw new Error('fixture cursor must be live');
    const body = value.slice(CURSOR_PREFIX.length);
    return body.startsWith('{') ? JSON.parse(body) as PersonalMeetingCheckpointV1 : { folder: null, baseline: false, revisions: {}, manual: [] };
  },
  write(value: PersonalMeetingCheckpointV1): string { return CURSOR_PREFIX + JSON.stringify({ folder: value.folder, baseline: value.baseline, revisions: value.revisions, manual: value.manual }); },
};

export const PROJECT_A = 'prj_00000000-0000-4000-8000-0000000000a1';
export const PROJECT_B = 'prj_00000000-0000-4000-8000-0000000000b1';
export const PROJECT_C = 'prj_00000000-0000-4000-8000-0000000000c1';
const PROJECTS = { A: PROJECT_A, B: PROJECT_B, C: PROJECT_C } as const;
const OTHER = { principal_id: 'prn_00000000-0000-4000-8000-0000000000e1', membership_id: 'mem_00000000-0000-4000-8000-0000000000e2' };
const NOW = '2026-10-07T09:00:00.000Z';

export interface ApprovalFixtureActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string; readonly authorization_sha256: Sha256Digest }

export interface ApprovalContextFixtureV1 {
  readonly db: Database.Database; readonly record: Database.Database; readonly actor: ApprovalFixtureActorV1; readonly context: ApprovalWorkflowContextV1;
  readonly state: SqliteAuthorityMeetingProcessingStateV1; readonly path: string | undefined;
  /** Verifies a stored canonical envelope with the production record codecs. */
  readonly verify: (value: unknown) => ReturnType<typeof verifyOrganizationRecordEnvelopeV4>;
}
/** An Authority database seeded with the processing fixture's tenancy and admission, a record log and the approval context; no candidate. */
export async function approvalContextFixture(options: { readonly path?: string } = {}): Promise<ApprovalContextFixtureV1> {
  const authority = testAuthority();
  const path = options.path;
  const db = new Database(path ?? ':memory:'); opened.push(db);
  db.pragma('foreign_keys=ON');
  if (path !== undefined) { db.pragma('journal_mode=DELETE'); db.pragma('busy_timeout=5000'); db.pragma('trusted_schema=OFF'); }
  applyAuthorityBaselineV14(db);
  const old = sourceFixture();
  const actor = { organization_id: authority.descriptor.organization_id, principal_id: 'prn_00000000-0000-4000-8000-000000000003', membership_id: 'mem_00000000-0000-4000-8000-000000000004', authorization_sha256: canonicalSha256('session proof') };
  const substitutions: Record<string, string> = { org_test: actor.organization_id, oau_test: authority.descriptor.authority_id, prn_test: actor.principal_id, mem_test: actor.membership_id };
  for (const table of ['authority_metadata', 'authority_principals', 'authority_memberships', 'authority_live_source_admission_v2']) {
    const row = old.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row).map(value => typeof value === 'string' && substitutions[value] !== undefined ? substitutions[value] : value));
  }
  const record = new Database(':memory:'); opened.push(record); record.pragma('foreign_keys=ON'); applyOrganizationRecordLogBaselineV4(record);
  const coordinates = { authority_id: authority.descriptor.authority_id, organization_id: actor.organization_id, state_lineage_id: 'lineage-test' };
  record.prepare('INSERT INTO organization_record_log_metadata VALUES (1,?,?,?,?)').run(coordinates.authority_id, coordinates.organization_id, coordinates.state_lineage_id, '2026-10-06T00:00:00.000Z');
  const append = new OrganizationRecordAppenderV4(record, coordinates, authorityRecordPolicyProjectorsV1());
  const state = new SqliteAuthorityMeetingProcessingStateV1(db, fixtureCursorPolicy, 'llm', undefined, FIXTURE_SOURCE_KEY);
  await state.readAdmission();
  let envelopes = 0;
  const context: ApprovalWorkflowContextV1 = { coordinates, signer: { inspect: async () => authority.descriptor, sign: authority.sign },
    record_append: append, next_envelope_id: () => `envelope-approval-${++envelopes}`,
    state: bindApprovalWorkflowStateV1(state, () => { if (db.inTransaction) throw new Error('Shared approval port called inside a transaction'); }) };
  // Pinned by the package build the verifier comes from (the protocol fixture pins with its source build).
  const pinned = verifyOrganizationAuthorityPin(authority.descriptor, organizationAuthorityPinSha256(authority.descriptor));
  const verify = (value: unknown) => verifyOrganizationRecordEnvelopeV4(value, pinned, coordinates.state_lineage_id, AUTHORITY_RECORD_INPUT_CODECS_V1);
  return { db, record, actor, context, state, path, verify };
}

export interface ApprovalCoreFixtureOptionsV1 {
  /** Proposed owners by action signal id (act-1, act-2). */
  readonly owners?: Readonly<Record<string, string>>;
  /** Replaces the two default action signals. */
  readonly actions?: readonly { readonly id: string; readonly owner?: string | null; readonly text?: string; readonly due_at?: string | null }[];
  /** The actor is an active member of the first `projects` of A and B (default 2). */
  readonly projects?: number;
  /** Recorded suggestion rows for the first `suggestions` of A and B (default 0). */
  readonly suggestions?: number;
  /** Pending import choices, queued through the intake before processing. */
  readonly pending?: readonly ('A' | 'B' | 'C')[];
  /** A temp-file database, so a peer handle can open the same Authority. */
  readonly file?: boolean;
  readonly stage?: boolean;
  /** False leaves the first revision's source content unretained. */
  readonly retained?: boolean;
  readonly core?: Pick<ApprovalCoreOptionsV1, 'now' | 'after_record'>;
  /** After-record hooks of every core and publisher the fixture builds (merged into `core`). */
  readonly after_record?: readonly AfterApprovedRecordHookV1[];
  readonly wake?: () => void;
}

/** One frozen proposal for the fixture's personal source, decided through the approval core. */
export async function approvalCoreFixture(options: ApprovalCoreFixtureOptionsV1 = {}): Promise<Awaited<ReturnType<typeof buildApprovalCoreFixture>> & Pick<ApprovalContextFixtureV1, 'db' | 'record'>> {
  const directory = options.file === true ? mkdtempSync(join(tmpdir(), 'approval-core-')) : undefined;
  if (directory !== undefined) directories.push(directory);
  const base = await approvalContextFixture(directory === undefined ? {} : { path: join(directory, 'authority.sqlite') });
  return { ...await buildApprovalCoreFixture(base, options), db: base.db, record: base.record };
}

async function buildApprovalCoreFixture(base: ApprovalContextFixtureV1, options: ApprovalCoreFixtureOptionsV1) {
  const { db, record, actor } = base;
  const person = { organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id };
  db.prepare('INSERT INTO authority_person_meeting_sources_v2(source_key,person_key,folder_id,folder_project_id,settings_revision) VALUES (?,?,NULL,NULL,0)').run(FIXTURE_SOURCE_KEY, canonicalSha256(person));
  db.prepare('INSERT INTO authority_project_authorization_state_v1 VALUES (?,0,?)').run(actor.organization_id, NOW);
  addMembership(db, { organization_id: actor.organization_id, ...OTHER, membership_type: 'employee' }, 'Other', 'other@example.test');
  let grants = 0;
  const grant = (projectId: string, who: { principal_id: string; membership_id: string }, type: 'owner' | 'employee', role: 'lead' | 'member') =>
    db.prepare('INSERT INTO authority_project_memberships_v1 VALUES (?,?,?,?,?,?,?,\'active\',?,NULL)').run(`pgm_00000000-0000-4000-8000-${(0xd00 + grants++).toString(16).padStart(12, '0')}`, projectId, actor.organization_id, who.principal_id, who.membership_id, type, role, NOW);
  for (const [index, projectId] of [PROJECT_A, PROJECT_B].entries()) {
    db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,?,'active',?,?,?,?)").run(projectId, actor.organization_id, `Project ${'AB'[index]}`, NOW, actor.principal_id, actor.membership_id, 'owner');
    if (index < (options.projects ?? 2)) grant(projectId, actor, 'owner', 'member');
  }
  db.prepare("INSERT INTO authority_projects_v1 VALUES (?,?,'Project C','active',?,?,?,'employee')").run(PROJECT_C, actor.organization_id, NOW, OTHER.principal_id, OTHER.membership_id);
  grant(PROJECT_C, OTHER, 'employee', 'lead');

  const intake = new SqlitePersonMeetingIntakeV1(db, fixtureCheckpointCodec);
  const setting = () => intake.list(person).find(s => s.source_key === FIXTURE_SOURCE_KEY)!;
  const externalId = fixtureMeeting.provenance.external_id;
  for (const projectId of [PROJECT_A, PROJECT_B].slice(0, options.suggestions ?? 0)) {
    db.prepare('INSERT INTO authority_person_meeting_suggestions_v1 VALUES (?,?,?,?)').run(FIXTURE_SOURCE_KEY, externalId, projectId, NOW);
  }
  for (const name of options.pending ?? []) {
    // The import must be queued by a member; a project the person is not in is held directly, as if they left it after queueing.
    try { intake.enqueue(setting(), externalId, PROJECTS[name], () => {}); }
    catch {
      intake.enqueue(setting(), externalId, null, () => {});
      db.prepare('INSERT INTO authority_person_meeting_pending_suggestions_v1 VALUES (?,?,?,?)').run(FIXTURE_SOURCE_KEY, externalId, PROJECTS[name], NOW);
    }
  }
  const signals = (options.actions ?? [{ id: 'act-1' }, { id: 'act-2', due_at: '2026-10-20T00:00:00.000Z' }]).map((action, index): ActionSignal => ({
    id: action.id, kind: 'action', text: action.text ?? `Follow up on item ${index + 1}.`, subject: null, confidence: 1,
    owner: action.owner !== undefined ? action.owner : options.owners?.[action.id] ?? null, due_at: action.due_at ?? null,
    evidence: [{ meeting_id: fixtureMeeting.id, block_id: 'block-1' }] }));
  let revisions = 0;
  const build = (label: string, title?: string, external = externalId) => {
    const meeting: MeetingDocument = { ...fixtureMeeting, ...(title === undefined ? {} : { title }), provenance: { ...fixtureMeeting.provenance, external_id: external, canonical_revision: canonicalSha256(label) } };
    const decisions: DecisionSet = { ...fixtureDecisions, meeting_revision: meeting.provenance.canonical_revision, signals: [...fixtureDecisions.signals, ...signals] };
    return { meeting, decisions };
  };
  const admitSource = (meeting: MeetingDocument) => new SqliteSourceAdmissionStoreV1(db).admit({ source: meetingSourceEnvelopeV1(meeting), scope: { organization_id: actor.organization_id,
    custody_ref: `person:${actor.membership_id}`, access_policy_ref: `personal-meeting:${FIXTURE_SOURCE_KEY}`, analysis_policy: 'automatic' } });
  // The lane state: it records a consumed import's choices in the cursor advance (R28).
  const state = new SqliteAuthorityMeetingProcessingStateV1(db, fixtureCursorPolicy, 'llm', undefined, FIXTURE_SOURCE_KEY, () => {},
    ({ expected_cursor, next_cursor }) => intake.promoteConsumedImports(setting(), expected_cursor, next_cursor));
  const idle = (handle: Database.Database) => () => { if (handle.inTransaction) throw new Error('Shared approval port called inside a transaction'); };
  const boundState = bindApprovalWorkflowStateV1(state, idle(db));
  let wakes = 0;
  const hooks = options.after_record ?? options.core?.after_record ?? [];
  const context: ApprovalWorkflowContextV1 = { ...base.context, state: boundState, on_terminal_action_queued: () => { wakes++; options.wake?.(); } };
  const coreOptions = (handle: Database.Database): ApprovalCoreOptionsV1 => {
    const handleIntake = handle === db ? intake : new SqlitePersonMeetingIntakeV1(handle, fixtureCheckpointCodec);
    return { ...options.core, ...(options.after_record === undefined ? {} : { after_record: options.after_record }), suggestions: (key, external) => handleIntake.proposalSuggestions(key, external),
      projects: (who, ids) => { for (const id of ids) handleIntake.currentPerson(who, id); } };
  };
  const create = (overrides: Partial<ApprovalWorkflowContextV1> = {}, extra: Partial<ApprovalCoreOptionsV1> = {}) => createApprovalCoreV1(db, { ...context, ...overrides }, { ...coreOptions(db), ...extra });
  const core = await create();
  const stageRevision = async (label: string, title?: string, external = externalId, retain = true) => {
    const { meeting, decisions } = build(label, title, external);
    if (retain) admitSource(meeting);
    const admission = await state.readAdmission();
    const candidate = await state.stageCandidate({ admission, meeting, decisions, review_policy: REVIEW_POLICY });
    if (candidate.disposition !== 'actionable') throw new Error('Expected an approval proposal');
    return { admission, candidate, meeting, decisions };
  };
  const first = await stageRevision('test revision', undefined, externalId, options.retained !== false);
  if (options.stage !== false) await core.stager.stage({ admission: first.admission, candidate: first.candidate, meeting: first.meeting, decisions: first.decisions });
  const approvalId = first.candidate.approval_id;
  const snapshotOf = (id: string) => db.prepare('SELECT approved_snapshot_sha256 FROM authority_live_approval_outbox_v2 WHERE approval_id=?').pluck().get(id) as Sha256Digest | null;
  const session: ApprovalAuthorizationV1 = { actor: person, evidence: { kind: 'person-session', sha256: actor.authorization_sha256 } };
  const click: ApprovalAuthorizationV1 = { actor: person, evidence: { kind: 'slack-click', sha256: canonicalSha256('verified click') } };
  const request = (action: 'approve' | 'reject', o: Partial<ApprovalDecisionRequestV1> = {}): ApprovalDecisionRequestV1 => ({
    approval_id: approvalId, command_id: action === 'approve' ? 'desk-approve' : 'desk-reject', snapshot_sha256: snapshotOf(o.approval_id ?? approvalId) ?? canonicalSha256('unfrozen'),
    action, project_ids: [], share_transcript: false, owners: [], ...o });
  let peerHandle: Database.Database | undefined;
  const peer = async (): Promise<{ readonly db: Database.Database; readonly context: ApprovalWorkflowContextV1; readonly core: ApprovalCoreV1 }> => {
    if (base.path === undefined) throw new Error('peer() needs file: true');
    if (peerHandle === undefined) {
      peerHandle = new Database(base.path); opened.push(peerHandle);
      peerHandle.pragma('foreign_keys=ON'); peerHandle.pragma('busy_timeout=5000'); peerHandle.pragma('journal_mode=DELETE'); peerHandle.pragma('trusted_schema=OFF');
    }
    const handle = peerHandle;
    const peerState: ApprovalWorkflowStateV1 = bindApprovalWorkflowStateV1(new SqliteApprovalWorkflowStateV1(handle, { source_cursor_policies: [fixtureCursorPolicy], processor_adapter_id: 'llm' }), idle(handle));
    const peerContext: ApprovalWorkflowContextV1 = { ...context, state: peerState };
    return { db: handle, context: peerContext, core: await createApprovalCoreV1(handle, peerContext, coreOptions(handle)) };
  };
  return {
    core, context, state, intake, actor, person, approvalId, sourceKey: FIXTURE_SOURCE_KEY, externalId, setting,
    projectA: PROJECT_A, projectB: PROJECT_B, projectC: PROJECT_C, project: (name: 'A' | 'B' | 'C') => PROJECTS[name],
    session, click, wakes: () => wakes, snapshotOf, first,
    approve: (o: Partial<ApprovalDecisionRequestV1> = {}) => request('approve', o),
    reject: (o: Partial<ApprovalDecisionRequestV1> = {}) => request('reject', o),
    removeProjectMembership: (projectId: string) => { db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE project_id=? AND membership_id=? AND status='active'").run(NOW, projectId, actor.membership_id); },
    archiveProject: (projectId: string) => { db.prepare("UPDATE authority_projects_v1 SET status='archived' WHERE project_id=?").run(projectId); },
    revokeReviewer: () => { db.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='fixture' WHERE membership_id=?").run(NOW, actor.membership_id); },
    newRevision: async (stage = true) => {
      const next = await stageRevision(`revision ${++revisions}`, `Pilot sync ${revisions}`);
      if (stage) await core.stager.stage({ admission: next.admission, candidate: next.candidate, meeting: next.meeting, decisions: next.decisions });
      return { approvalId: next.candidate.approval_id, ...next };
    },
    stageRevision,
    /** A proposal for another meeting of the same source (its own lineage). */
    otherProposal: async (stage = true, external = 'note-2') => {
      const next = await stageRevision(`other ${external}`, undefined, external);
      if (stage) await core.stager.stage({ admission: next.admission, candidate: next.candidate, meeting: next.meeting, decisions: next.decisions });
      return { approvalId: next.candidate.approval_id, ...next };
    },
    lastRecord: () => JSON.parse((record.prepare('SELECT canonical_envelope FROM organization_record_log ORDER BY rowid DESC LIMIT 1').get() as { canonical_envelope: string }).canonical_envelope),
    recordCount: () => record.prepare('SELECT count(*) FROM organization_record_log').pluck().get() as number,
    decisionCount: () => db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get() as number,
    receipt: (id = approvalId) => db.prepare('SELECT receipt_json FROM authority_approval_decisions_v1 WHERE approval_id=?').pluck().get(id) as string | null | undefined,
    /** A publisher on this handle with the fixture's hooks whose append goes through `wrap` (the shared appender is its second argument). */
    withAppend: (wrap: (input: AppendInputV1, append: (input: AppendInputV1) => ReturnType<AppendV1>) => ReturnType<AppendV1>): { readonly processing: ApprovalWorkflowProcessingV1 } =>
      ({ processing: createApprovalPublisherV1(db, { ...context, record_append: { append: input => wrap(input, next => base.context.record_append.append(next)) } }, hooks) }),
    create,
    /** A publisher with these hooks (default: the fixture's) on this handle or a peer's, optionally through another append. */
    publisher: (with_hooks: readonly AfterApprovedRecordHookV1[] = hooks, handle?: { readonly db: Database.Database; readonly context: ApprovalWorkflowContextV1 },
      append: ApprovalWorkflowContextV1['record_append'] = base.context.record_append): ApprovalWorkflowProcessingV1 => {
      const target = handle ?? { db, context };
      return createApprovalPublisherV1(target.db, { ...target.context, record_append: append }, with_hooks);
    },
    /** The search snapshot's atoms of the record log, read with the production record protocols. */
    snapshotAtoms: (tamper?: (envelope: ReturnType<typeof verifyOrganizationRecordEnvelopeV4>) => unknown,
      policy_projectors: RecordPolicyFactProjectorRegistryV1 = authorityRecordPolicyProjectorsV1()): readonly RecordRetrievalSourceAtomV1[] =>
      new RecordRetrievalSourceSnapshotPortV1(record).snapshot({ ...context.coordinates, policy_projectors,
        verify_envelope: value => (tamper === undefined ? base.verify(value) : tamper(base.verify(value))) as ReturnType<typeof base.verify> }).atoms,
    peer,
  };
}
type AppendV1 = ApprovalWorkflowContextV1['record_append']['append'];
type AppendInputV1 = Parameters<AppendV1>[0];
export type ApprovalCoreFixtureV1 = Awaited<ReturnType<typeof approvalCoreFixture>>;
export type { ApprovalCoreV1 };
