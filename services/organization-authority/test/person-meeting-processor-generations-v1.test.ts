import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { meetingSourceEnvelopeV1, type MeetingDocument } from '@echo-brain/organization-processing/core';
import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import { extractionAttemptKeyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1';
import { readAdmittedMeetingProcessingCommitmentsV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments';
import { SqliteAuthorityMeetingProcessingStateV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1';
import { SqliteExtractionAttemptStoreV1 } from '@echo-brain/organization-processing/adapters/persistence/sqlite-extraction-attempt-store-v1';
import { GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, GRANOLA_WATCH_CURSOR_POLICY_V1, readGranolaCheckpointV1, writeGranolaCheckpointV1 } from '@echo-brain/provider-granola/granola-watch-source-v1';
import { reconcilePersonMeetingProcessorsV1, type PersonMeetingProviderV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { personMeetingSourceAnchorV1, SqlitePersonMeetingIntakeV1, type MeetingIntakePersonV1, type MeetingIntakeSettingV1 } from '../src/adapters/persistence/sqlite/person-meeting-intake-v1.js';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { SqlitePersonImportedMeetingsV1 } from '../src/adapters/persistence/sqlite/person-imported-meetings-v1.js';
import { authorization, MEMBER, OWNER, PROJECT_ALPHA, PROJECT_CONTEXT_NOW, projectContextDatabase, revokeMembership, seedProject, seedProjectMember } from './fixtures/project-context-sqlite.js';

const NOTE_1 = '00000000-0000-4000-8000-0000000000a1';
const NOTE_2 = '00000000-0000-4000-8000-0000000000a2';
const opened: Database.Database[] = [];
const ledgers: SqliteExtractionAttemptStoreV1[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const db of opened.splice(0)) db.close();
});
const person = (actor: MeetingIntakePersonV1): MeetingIntakePersonV1 => ({ organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id });
const identity = (actor: MeetingIntakePersonV1) => ({ kind: 'meeting-source' as const, adapter_id: 'granola-person-mcp',
  instance_id: `granola-${canonicalSha256(person(actor)).slice(7, 31)}`, version: '1.0.0' });

function bundle(label: string): DecisionProcessorBundleV1 {
  const current_commitments: DecisionProcessorBundleV1['current_commitments'] = instance_id => ({
    adapter_id: 'llm', instance_id, version: label, configuration_sha256: canonicalSha256({ label }), credential_reference_sha256: canonicalSha256({ account: label }),
  });
  return { processor_adapter_id: 'llm', current_commitments,
    assert_admission_commitments(value) {
      if (canonicalSha256(value.processor) !== canonicalSha256(current_commitments(value.processor.instance_id))) throw new Error('processor commitment mismatch');
    },
    create_processor() { throw new Error('A processor transition must not construct a model client'); },
  };
}

function world() {
  const db = projectContextDatabase(); opened.push(db);
  seedProject(db, PROJECT_ALPHA, OWNER);
  for (const actor of [OWNER, MEMBER]) seedProjectMember(db, PROJECT_ALPHA, actor, 'member');
  const intake = new SqlitePersonMeetingIntakeV1(db, GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1);
  const ledger = new SqliteExtractionAttemptStoreV1(new Database(':memory:'), {
    authority_id: 'oau_project_fixture', organization_id: OWNER.organization_id, state_lineage_id: 'lineage-generations',
  });
  ledgers.push(ledger);
  const provider: PersonMeetingProviderV1 = {
    id: 'granola', normalizer_version: '1.0.0', cursor: { ...GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1, policy: GRANOLA_WATCH_CURSOR_POLICY_V1 },
    connection_http: { routes: [], async accept() { throw new Error('unused'); } },
    tool() { throw new Error('A processor transition must not open a provider connection'); },
    async open() { throw new Error('A processor transition must not open a provider connection'); },
    source() { throw new Error('A processor transition must not pull a source'); },
  };
  const old = bundle('1.0.0'), next = bundle('2.0.0');
  const ensure = (actor = OWNER, processor = old) => intake.ensure({ person: person(actor), identity: identity(actor), normalizer_version: '1.0.0',
    custodian: { account: actor.membership_id }, processor: processor.current_commitments(`personal-${canonicalSha256(person(actor)).slice(7, 39)}`), current() {} });
  const reconcile = (processor = next) => reconcilePersonMeetingProcessorsV1({ database: db, providers: [provider], processor, extraction_attempts: ledger });
  const current = (actor = OWNER) => intake.listCurrent(person(actor))[0]!;
  const snapshot = () => ['authority_live_source_admission_v2', 'authority_live_source_progress_v2', 'authority_person_meeting_sources_v2',
    'authority_person_meeting_pending_suggestions_v1', 'authority_person_meeting_suggestions_v1'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY source_key`).all());
  const checkpoint = (setting: MeetingIntakeSettingV1) => readGranolaCheckpointV1(db.prepare('SELECT cursor FROM authority_live_source_progress_v2 WHERE source_key=?').pluck().get(setting.source_key) as string);
  const setCheckpoint = (setting: MeetingIntakeSettingV1, value: ReturnType<typeof checkpoint>) => db.prepare('UPDATE authority_live_source_progress_v2 SET cursor=?,cursor_version=cursor_version+1 WHERE source_key=?')
    .run(writeGranolaCheckpointV1(value), setting.source_key);
  const meeting = (setting: MeetingIntakeSettingV1, revision = 'one'): MeetingDocument => ({ schema_version: 1,
    id: `${setting.source_adapter_instance_id}:${NOTE_1}`, title: 'Preserved meeting', participants: [], content: [{ id: 'note-1', kind: 'note', text: 'Keep source custody stable.' }],
    artifacts: [], capture: { state: 'complete', components: [] }, provenance: {
      source: { kind: 'meeting-source', adapter_id: setting.source_adapter_id, instance_id: setting.source_adapter_instance_id, version: setting.source_adapter_version },
      external_id: NOTE_1, canonical_revision: canonicalSha256(revision), normalizer_version: '1.0.0', observed_at: PROJECT_CONTEXT_NOW,
    } });
  const admit = (setting: MeetingIntakeSettingV1, value = meeting(setting)) => new SqliteSourceAdmissionStoreV1(db).admit({ source: meetingSourceEnvelopeV1(value), scope: {
    organization_id: setting.organization_id, custody_ref: `person:${setting.membership_id}`, access_policy_ref: `personal-meeting:${personMeetingSourceAnchorV1(setting)}`, analysis_policy: 'automatic',
  } });
  const state = (setting: MeetingIntakeSettingV1) => new SqliteAuthorityMeetingProcessingStateV1(db, GRANOLA_WATCH_CURSOR_POLICY_V1, 'llm', undefined, setting.source_key);
  return { db, intake, ledger, old, next, ensure, reconcile, current, snapshot, checkpoint, setCheckpoint, meeting, admit, state };
}

describe('personal meeting processor generations', () => {
  it('appends forward and backward selections, keeps the latest cursor, and makes repeated startup idempotent', () => {
    vi.useFakeTimers(); vi.setSystemTime(PROJECT_CONTEXT_NOW);
    const w = world(), first = w.ensure();
    w.intake.enqueue(first, NOTE_1, PROJECT_ALPHA, () => undefined);
    const originalAdmission = w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(first.source_key);
    expect(() => w.ensure(OWNER, w.next)).toThrow('transition');
    expect(w.reconcile()).toEqual({ transitioned: 1 });
    const second = w.current();
    expect(second.source_key).not.toBe(first.source_key);
    expect(w.ensure(OWNER, w.next).source_key).toBe(second.source_key);
    expect(w.intake.isCurrentGeneration(first)).toBe(false);
    expect(() => w.intake.requireCurrent(first)).toThrow();
    w.intake.enqueue(second, NOTE_2, null, () => undefined);
    expect(w.reconcile(w.old)).toEqual({ transitioned: 1 });
    const third = w.current();
    expect(new Set([first.source_key, second.source_key, third.source_key]).size).toBe(3);
    expect(w.ensure().source_key).toBe(third.source_key);
    expect(w.checkpoint(third).manual).toEqual([NOTE_1, NOTE_2]);
    expect(w.checkpoint(first).manual).toEqual([]);
    expect(w.checkpoint(second).manual).toEqual([]);
    expect(w.intake.listCurrent()).toHaveLength(1);
    expect(w.intake.list()).toHaveLength(3);
    expect(w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(first.source_key)).toEqual(originalAdmission);
    const admitted = w.db.prepare('SELECT admitted_at FROM authority_live_source_admission_v2 ORDER BY admitted_at').pluck().all() as string[];
    expect(Date.parse(admitted[0]!)).toBeLessThan(Date.parse(admitted[1]!));
    expect(Date.parse(admitted[1]!)).toBeLessThan(Date.parse(admitted[2]!));
    const before = w.snapshot();
    expect(w.reconcile(w.old)).toEqual({ transitioned: 0 });
    expect(w.snapshot()).toEqual(before);
  });

  it('preserves the provider watch checkpoint and queued project choices with only one active watch', () => {
    const w = world(), initial = w.ensure();
    w.intake.watch(initial, { watch: 'mine', folder_id: null }, PROJECT_ALPHA, () => undefined);
    const first = w.current();
    w.intake.enqueue(first, NOTE_1, PROJECT_ALPHA, () => undefined);
    const checkpoint = { ...w.checkpoint(first), baseline: true, since: PROJECT_CONTEXT_NOW, seen: { [NOTE_2]: PROJECT_CONTEXT_NOW } };
    w.setCheckpoint(first, checkpoint);
    expect(w.reconcile()).toEqual({ transitioned: 1 });
    const next = w.current();
    expect(w.checkpoint(next)).toEqual(checkpoint);
    expect(next).toMatchObject({ watch: 'mine', folder_id: null, suggested_project_id: PROJECT_ALPHA });
    expect(w.intake.list().filter(row => row.watch !== 'off').map(row => row.source_key)).toEqual([next.source_key]);
    expect(w.intake.proposalSuggestions(next.source_key, NOTE_1)).toEqual([PROJECT_ALPHA]);
    expect(w.db.prepare('SELECT source_key FROM authority_person_meeting_pending_suggestions_v1').pluck().all()).toEqual([next.source_key]);
    expect(w.checkpoint(first)).toMatchObject({ mode: 'off', manual: [] });
  });

  it('keeps one original custody anchor and private imported-meeting read across generations', () => {
    const w = world(), first = w.ensure();
    expect(w.admit(first)).toBe('admitted');
    const reader = new SqlitePersonImportedMeetingsV1(w.db);
    const before = reader.rows(authorization(OWNER), { kind: 'global' });
    expect(before).toHaveLength(1);
    expect(w.reconcile()).toEqual({ transitioned: 1 });
    const next = w.current();
    expect(personMeetingSourceAnchorV1(next)).toBe(first.source_key);
    expect(w.admit(next)).toBe('duplicate');
    expect(reader.rows(authorization(OWNER), { kind: 'global' })).toEqual(before);
    expect(reader.rows(authorization(MEMBER), { kind: 'global' })).toEqual([]);
    expect(reader.rows(authorization(OWNER), { kind: 'project', project_id: PROJECT_ALPHA })).toEqual([]);
    const sourceFacts = (key: string) => readAdmittedMeetingProcessingCommitmentsV1(w.db, key).source;
    expect(sourceFacts(next.source_key)).toEqual(sourceFacts(first.source_key));
    expect(w.db.prepare('SELECT custody_ref,access_policy_ref FROM authority_sources_v1').all()).toEqual([{
      custody_ref: `person:${OWNER.membership_id}`, access_policy_ref: `personal-meeting:${first.source_key}`,
    }]);
  });

  it('skips a revoked membership without changing its admission and transitions the active person', () => {
    const w = world(); w.ensure(OWNER); w.ensure(MEMBER);
    const last = w.intake.listCurrent().at(-1)!;
    const actor = last.membership_id === OWNER.membership_id ? OWNER : MEMBER;
    const active = actor === OWNER ? MEMBER : OWNER;
    const before = w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(last.source_key);
    const oldCheckpoint = w.checkpoint(last);
    revokeMembership(w.db, actor);
    expect(w.reconcile()).toEqual({ transitioned: 1 });
    expect(w.intake.listCurrent().find(row => row.membership_id === actor.membership_id)?.source_key).toBe(last.source_key);
    expect(w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(last.source_key)).toEqual(before);
    expect(w.checkpoint(last)).toEqual(oldCheckpoint);
    expect(readAdmittedMeetingProcessingCommitmentsV1(w.db, w.current(active).source_key).processor.version).toBe('2.0.0');
    expect(w.intake.list()).toHaveLength(3);
    expect(() => w.intake.requireCurrent(last)).toThrow();
  });

  it('preserves a personal watch while dropping revoked project suggestions from its new generation', () => {
    const w = world(); w.ensure(OWNER); w.ensure(MEMBER);
    const last = w.intake.listCurrent().at(-1)!;
    w.intake.watch(last, { watch: 'mine', folder_id: null }, PROJECT_ALPHA, () => undefined);
    const watched = w.intake.listCurrent().find(row => row.source_key === last.source_key)!;
    w.intake.enqueue(watched, NOTE_1, PROJECT_ALPHA, () => undefined);
    w.db.prepare('INSERT INTO authority_person_meeting_suggestions_v1 VALUES (?,?,?,?)').run(last.source_key, NOTE_1, PROJECT_ALPHA, PROJECT_CONTEXT_NOW);
    const originalAdmission = w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(last.source_key);
    const originalCheckpoint = w.checkpoint(watched);
    w.db.prepare("UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?")
      .run(PROJECT_CONTEXT_NOW, last.membership_id, PROJECT_ALPHA);
    expect(w.reconcile()).toEqual({ transitioned: 2 });
    const selected = w.intake.listCurrent().find(row => row.membership_id === last.membership_id)!;
    expect(selected).toMatchObject({ watch: 'mine', suggested_project_id: null });
    expect(w.checkpoint(selected)).toEqual(originalCheckpoint);
    expect(w.intake.proposalSuggestions(selected.source_key, NOTE_1)).toEqual([]);
    expect(w.db.prepare('SELECT source_key FROM authority_person_meeting_pending_suggestions_v1').all()).toEqual([]);
    expect(w.intake.suggestions(last.source_key, NOTE_1)).toEqual([PROJECT_ALPHA]);
    expect(w.db.prepare('SELECT * FROM authority_live_source_admission_v2 WHERE source_key=?').get(last.source_key)).toEqual(originalAdmission);
    expect(w.intake.list().filter(row => row.watch !== 'off').map(row => row.source_key)).toEqual([selected.source_key]);
  });

  it.each(['pending', 'failed', 'succeeded'] as const)('refuses %s attempted work without a retained completion instead of granting a fresh budget', async outcome => {
    const w = world(), setting = w.ensure();
    w.intake.enqueue(setting, NOTE_1, null, () => undefined);
    const key = extractionAttemptKeyV1(await w.state(setting).readAdmission(), w.meeting(setting));
    const claim = w.ledger.reserve(key);
    if (claim.status !== 'reserved') throw new Error('expected fresh attempt');
    if (outcome === 'succeeded') w.ledger.complete({ key, ...claim, outcome });
    if (outcome === 'failed') w.ledger.complete({ key, ...claim, outcome, failure_code: 'unknown_outcome' });
    const before = w.snapshot(), attempts = w.ledger.listForAdmission(key.admission_sha256);
    expect(() => w.reconcile()).toThrow();
    expect(w.snapshot()).toEqual(before);
    expect(w.ledger.listForAdmission(key.admission_sha256)).toEqual(attempts);
  });

  it('refuses a held extraction even when no attempt row is available', async () => {
    const w = world(), setting = w.ensure(), state = w.state(setting), meeting = w.meeting(setting);
    w.admit(setting, meeting);
    const key = extractionAttemptKeyV1(await state.readAdmission(), meeting);
    await state.holdExtraction({ meeting, key, attempt: 1, failure_stage: 'unknown_outcome' });
    const before = w.snapshot();
    expect(() => w.reconcile()).toThrow();
    expect(w.snapshot()).toEqual(before);
    expect(await state.listHeldExtractions()).toHaveLength(1);
  });
});
