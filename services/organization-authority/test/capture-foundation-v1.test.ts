import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCaptureBindingsV1, captureSourceRefV1, sourceContentSha256V1, type CaptureSnapshotSelectionV1, type ContextCaptureContentV2 } from '@echo-brain/organization-processing/core';
import { SqliteCaptureFoundationV1 } from '../src/adapters/persistence/sqlite/capture-foundation-v1.js';
import type { CaptureFoundationAuthorityV1 } from '../src/application/capture-foundation-v1.js';
import { CAPTURE_IDENTITY, CAPTURE_PROJECT, CAPTURE_CONTAINER, CAPTURE_TIME, captureBindings, captureClassification, captureContent, captureContainerScope, captureSource } from '../../../tests/support/context-capture-v2.js';
import { MEMBER, OWNER, PROJECT_BETA, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

let database: Database.Database;
let directory: string;
let allowed: boolean;
let checks: string[];
const authority: CaptureFoundationAuthorityV1 = { requireCurrent({ operation, source, bindings }) {
  expect(database.inTransaction).toBe(true); expect(Object.isFrozen(source.content)).toBe(true); expect(Object.isFrozen(bindings)).toBe(true);
  assertCaptureBindingsV1(bindings, source); checks.push(operation);
  if (!allowed || bindings.people.some(person => person.identity_link_ref !== 'verified:fixture:alex')) throw new Error('Current custody or identity consent denied');
} };
function store(project = CAPTURE_PROJECT) { return new SqliteCaptureFoundationV1(database, authority, captureContainerScope(project)); }
function admit(source = captureSource(), bindings = captureBindings()) {
  return store(bindings.project_id).admit({ identity: CAPTURE_IDENTITY, source, classification: captureClassification(source), bindings });
}
function selection(result: ReturnType<typeof admit>): CaptureSnapshotSelectionV1 {
  if (!('selection' in result)) throw new Error('Expected retained capture'); return result.selection;
}
function snapshot(selections: readonly CaptureSnapshotSelectionV1[]) {
  return store().snapshot({ organization_id: OWNER.organization_id, project_id: CAPTURE_PROJECT, selections });
}
function count(table: string) { return (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n; }
function addProject(projectId = CAPTURE_PROJECT) {
  database.prepare("INSERT INTO authority_projects_v1(project_id,organization_id,name,status,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,'active',?,?,?,'owner')").run(projectId, OWNER.organization_id, 'Fixture', CAPTURE_TIME, OWNER.principal_id, OWNER.membership_id);
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'echo-capture-')); database = projectContextDatabase(join(directory, 'authority.sqlite')); addProject(); allowed = true; checks = []; });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

describe('shared capture custody and derivation input', () => {
  it('retains once, replays across restart, and returns frozen exact snapshots independent of selection order', () => {
    const first = selection(admit()); const second = selection(admit(captureSource({ external_id: 'second' })));
    const original = snapshot([second, first]);
    database.close(); database = new Database(join(directory, 'authority.sqlite')); database.pragma('foreign_keys = ON');
    const repoll = admit(captureSource({ captured_at: '2026-10-03T01:00:00.000Z' }));
    expect(repoll.admission).toBe('duplicate'); expect(selection(repoll)).toEqual(first);
    expect(snapshot([first, second])).toEqual(original); expect(Object.isFrozen(original.inputs)).toBe(true);
    expect(count('authority_source_contents_v1')).toBe(2); expect(count('authority_source_representations_v1')).toBe(2);
  });
  it.each([['skip', 'noise', 'skipped'], ['unresolved', 'needs_review', 'unresolved']] as const)('does not retain %s bodies or require persistence bindings', (decision, reason, admission) => {
    const source = captureSource(); allowed = false;
    const expected = admission === 'skipped' ? { admission } : { admission, cursor_may_advance: false,
      retry: { source_id: source.item.source_id, revision_id: source.revision.revision_id, content_sha256: source.revision.content_sha256, reason: 'needs_review' } };
    expect(store().admit({ identity: CAPTURE_IDENTITY, source, classification: { ...captureClassification(source), decision, reason } })).toEqual(expected);
    expect(count('authority_sources_v1')).toBe(0); expect(count('authority_source_revisions_v1')).toBe(0);
    expect(count('authority_source_contents_v1')).toBe(0); expect(count('authority_source_representations_v1')).toBe(0); expect(checks).toEqual([]);
  });
  it('rolls back source admission if annotation storage fails, including inside a caught owning transaction', () => {
    database.exec("CREATE TRIGGER reject_annotation BEFORE INSERT ON authority_source_representations_v1 BEGIN SELECT RAISE(ABORT, 'annotation failure'); END");
    database.transaction(() => { expect(() => admit()).toThrow(/annotation failure/); expect(count('authority_sources_v1')).toBe(0); })();
    expect(count('authority_source_contents_v1')).toBe(0);
  });
  it('requires current consent on duplicates and historical reads, not just on first retention', () => {
    const exact = selection(admit()); allowed = false;
    expect(() => admit()).toThrow(/consent denied/); expect(() => snapshot([exact])).toThrow(/consent denied/);
    expect(checks).toEqual(['retain', 'retain', 'derive']); expect(count('authority_source_contents_v1')).toBe(1);
  });
  it('refuses asynchronous Authority fences before any bytes are admitted', () => {
    const invalid = new SqliteCaptureFoundationV1(database, { requireCurrent: async () => { throw new Error('late rejection'); } }, captureContainerScope());
    const source = captureSource();
    expect(() => invalid.admit({ identity: CAPTURE_IDENTITY, source, classification: captureClassification(source), bindings: captureBindings() })).toThrow(/synchronously/);
    expect(count('authority_sources_v1')).toBe(0);
  });
  it('refuses model preclassification before storing a source or annotation', () => {
    const source = captureSource();
    const classification = { ...captureClassification(source), method: 'inferred' } as unknown as ReturnType<typeof captureClassification>;
    expect(() => store().admit({ identity: CAPTURE_IDENTITY, source, classification, bindings: captureBindings() })).toThrow(/classification|Classification/);
    expect(count('authority_source_contents_v1')).toBe(0); expect(count('authority_source_representations_v1')).toBe(0); expect(checks).toEqual([]);
  });
  it('checks actual project and Person tenancy and current membership, plus verified-link consent', () => {
    expect(() => admit(captureSource(), { ...captureBindings(), project_id: PROJECT_BETA })).toThrow(/project/);
    expect(() => admit(captureSource(), { ...captureBindings(), scope: { ...captureBindings().scope, organization_id: 'org_other' } })).toThrow(/project/);
    expect(() => admit(captureSource(), { ...captureBindings(), people: [{ ...captureBindings().people[0]!, identity_link_ref: 'forged' }] })).toThrow(/consent/);
    const exact = selection(admit()); revokeMembership(database, MEMBER);
    expect(() => snapshot([exact])).toThrow(/membership/);
    expect(count('authority_sources_v1')).toBe(1);
  });
  it('uses new project bindings without rewriting source evidence or selecting an implicit newest annotation', () => {
    const first = selection(admit()); const oldSnapshot = snapshot([first]); addProject(PROJECT_BETA);
    const second = selection(admit(captureSource(), { ...captureBindings(), project_id: PROJECT_BETA }));
    expect(second.source_id).toBe(first.source_id); expect(second.content_sha256).toBe(first.content_sha256);
    expect(second.annotation_representation_id).not.toBe(first.annotation_representation_id);
    expect(snapshot([first])).toEqual(oldSnapshot); expect(() => snapshot([second])).toThrow(/selection/);
    const otherProject = store(PROJECT_BETA).snapshot({ organization_id: OWNER.organization_id, project_id: PROJECT_BETA, selections: [second] });
    expect(otherProject.snapshot_sha256).not.toBe(oldSnapshot.snapshot_sha256); expect(count('authority_source_contents_v1')).toBe(1);
  });
  it('requires exact retained predecessors and refuses tombstone derive inputs', () => {
    const first = selection(admit());
    const content: ContextCaptureContentV2 = { schema_version: 2, kind: 'echo-context-capture-v2', lifecycle: 'deleted', label: 'Deleted',
      provenance: { origin_ref: 'fixture://handoff', container_ref: CAPTURE_CONTAINER, source_updated_at: '2026-10-03T01:00:00.000Z' }, deletion: 'explicit_upstream_tombstone' };
    const deleted = captureSource({ content, previous: captureSource() });
    const exact = selection(admit(deleted, { ...captureBindings(), people: [] }));
    expect(() => snapshot([exact])).toThrow(/selection/);
    // Historical access still needs the current Authority fence; tombstone observation is not a head ledger.
    allowed = false; expect(() => snapshot([first])).toThrow(/consent/); allowed = true;
    expect(() => admit(captureSource({ content, external_id: 'other', previous: captureSource({ external_id: 'other' }) }), { ...captureBindings(), people: [] })).toThrow(/predecessor/);
    expect(count('authority_source_contents_v1')).toBe(2);
  });
  it('refuses duplicate, swapped, missing and cross-organization selections', () => {
    const exact = selection(admit());
    expect(() => snapshot([exact, exact])).toThrow(/selection/);
    expect(() => snapshot([{ ...exact, content_sha256: '0'.repeat(64) }])).toThrow(/integrity/);
    expect(() => snapshot([{ ...exact, annotation_representation_id: `representation:${'0'.repeat(64)}` }])).toThrow(/not retained/);
    expect(() => store().snapshot({ organization_id: 'org_other', project_id: CAPTURE_PROJECT, selections: [exact] })).toThrow(/not retained/);
  });
  it.each(['authority_source_contents_v1', 'authority_source_representations_v1'])('detects stored tampering in %s', table => {
    const exact = selection(admit());
    const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[];
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
    database.prepare(`UPDATE ${table} SET content_json=?`).run('{}');
    expect(() => snapshot([exact])).toThrow();
  });
  it('maps mixed source types into one project and preserves document artifact descriptors', () => {
    const content = captureContent(); if (content.lifecycle !== 'present') throw new Error('fixture');
    const documents = captureSourceRefV1({ tool: 'fixture', tenant: 'workspace', kind: 'container', id: 'documents' });
    const original = { artifact_id: 'accepted-original', media_type: 'application/pdf', sha256: 'a'.repeat(64), byte_length: 100 };
    let artifactCurrent = true;
    const foundation = new SqliteCaptureFoundationV1(database, { requireCurrent(input) {
      authority.requireCurrent(input);
      if (input.source.revision.artifact_refs.length && !artifactCurrent) throw new Error('Original artifact custody denied');
    } }, { ...captureContainerScope(), mappings: [...captureContainerScope().mappings, { ...captureContainerScope().mappings[0]!, container_ref: documents }] });
    const message = captureSource();
    const document = captureSource({ external_id: 'prd', content: { ...content,
      provenance: { origin_ref: 'fixture://prd', container_ref: documents, upstream_version: 'etag-7' },
      payload: { schema_version: 2, kind: 'document', media_type: 'application/pdf', filename: 'PRD.pdf', path: '/design/PRD.pdf', original_artifact: original } } });
    const first = selection(foundation.admit({ identity: CAPTURE_IDENTITY, source: message, classification: captureClassification(message), bindings: captureBindings() }));
    const second = selection(foundation.admit({ identity: CAPTURE_IDENTITY, source: document, classification: captureClassification(document), bindings: { ...captureBindings(), container_ref: documents } }));
    const request = { organization_id: OWNER.organization_id, project_id: CAPTURE_PROJECT, selections: [first, second] };
    const retained = foundation.snapshot(request);
    expect(retained.inputs.map(entry => entry.source.content.lifecycle === 'present' && entry.source.content.payload.kind).sort()).toEqual(['document', 'message']);
    expect(retained.inputs.find(entry => entry.source.item.external_id === 'prd')!.source.revision.artifact_refs).toEqual([original]);
    artifactCurrent = false;
    expect(() => foundation.snapshot(request)).toThrow(/custody denied/);
  });
  it('treats container mappings as exact configuration and rechecks a later remapping', () => {
    addProject(PROJECT_BETA);
    let currentProject: string = CAPTURE_PROJECT;
    const configured = captureContainerScope();
    const foundation = new SqliteCaptureFoundationV1(database, { requireCurrent(input) {
      authority.requireCurrent(input);
      if (input.bindings.project_id !== currentProject) throw new Error('Container mapping is no longer current');
    } }, configured);
    // Caller mutation cannot replace the constructor's scope snapshot.
    (configured.mappings as unknown as { container_ref: string; project_id: string }[])[0]!.project_id = PROJECT_BETA;
    const source = captureSource();
    const input = { identity: CAPTURE_IDENTITY, source, classification: captureClassification(source), bindings: captureBindings() };
    const exact = selection(foundation.admit(input));
    expect(() => foundation.admit({ ...input, bindings: { ...input.bindings, project_id: PROJECT_BETA } })).toThrow(/configured container mapping/);
    currentProject = PROJECT_BETA;
    expect(() => foundation.snapshot({ organization_id: OWNER.organization_id, project_id: CAPTURE_PROJECT, selections: [exact] })).toThrow(/no longer current/);
    expect(() => foundation.admit(input)).toThrow(/no longer current/);
  });
  it.each([{ adapter_id: 'unrelated' }, { instance_id: 'unrelated' }])('rejects unrelated adapters before retention or policy evaluation: %j', change => {
    const identity = { ...CAPTURE_IDENTITY, ...change };
    const source = captureSource({ identity });
    expect(() => store().admit({ identity, source, classification: captureClassification(source), bindings: captureBindings() })).toThrow(/adapter/);
    expect(count('authority_sources_v1')).toBe(0); expect(checks).toEqual([]);
    const accepted = selection(admit());
    const remapped = { ...captureContainerScope(), mappings: [{ ...captureContainerScope().mappings[0]!, adapter: { adapter_id: identity.adapter_id, instance_id: identity.instance_id } }] };
    expect(() => new SqliteCaptureFoundationV1(database, authority, remapped).snapshot({ organization_id: OWNER.organization_id, project_id: CAPTURE_PROJECT, selections: [accepted] })).toThrow(/adapter/);
  });
  it('replays a changed source without a new successor and rejects fabricated unchanged successors', () => {
    const first = captureSource(); admit(first);
    const next = captureSource({ content: { ...first.content, label: 'Changed label' }, previous: first });
    const accepted = selection(admit(next));
    const repoll = captureSource({ content: next.content, previous: next, captured_at: '2026-10-03T01:00:00.000Z' });
    expect(admit(repoll).admission).toBe('duplicate'); expect(repoll.revision.revision_id).toBe(accepted.revision_id);
    expect(repoll.revision.previous_revision_id).toBe(first.revision.revision_id);
    const fabricated = { ...next, revision: { ...next.revision, previous_revision_id: next.revision.revision_id,
      revision_id: `context:${sourceContentSha256V1({ content: next.content, previous_revision_id: next.revision.revision_id })}` } };
    expect(() => admit(fabricated)).toThrow(/Unchanged capture/);
    expect(count('authority_source_revisions_v1')).toBe(2);
  });
  it('allows an unchanged child replay but rejects a different successor after restart', () => {
    const parent = captureSource(); admit(parent);
    const child = captureSource({ content: { ...parent.content, label: 'First successor' }, previous: parent });
    const retained = selection(admit(child));
    const replay = captureSource({ content: child.content, previous: child, captured_at: '2026-10-03T01:00:00.000Z' });
    expect(admit(replay)).toMatchObject({ admission: 'duplicate', selection: retained });
    const branch = captureSource({ content: { ...parent.content, label: 'Forked successor' }, previous: parent });
    database.close(); database = new Database(join(directory, 'authority.sqlite')); database.pragma('foreign_keys = ON');
    expect(() => admit(branch)).toThrow(/already has a retained successor/);
    expect(count('authority_source_revisions_v1')).toBe(2);
  });
  it('does not claim a predecessor when its attempted child rolls back', () => {
    const parent = captureSource(); admit(parent);
    const failed = captureSource({ content: { ...parent.content, label: 'Failed successor' }, previous: parent });
    database.exec("CREATE TRIGGER reject_successor_annotation BEFORE INSERT ON authority_source_representations_v1 BEGIN SELECT RAISE(ABORT, 'successor annotation failure'); END");
    expect(() => admit(failed)).toThrow(/successor annotation failure/);
    database.exec('DROP TRIGGER reject_successor_annotation');
    const replacement = captureSource({ content: { ...parent.content, label: 'Replacement successor' }, previous: parent });
    expect(admit(replacement)).toMatchObject({ admission: 'admitted' });
    expect(count('authority_source_revisions_v1')).toBe(2);
  });
  it('requires a predecessor for every changed source after its initial root', () => {
    const root = captureSource(); expect(admit(root)).toMatchObject({ admission: 'admitted' });
    const changed = captureSource({ content: { ...root.content, label: 'Changed root' } });
    expect(() => admit(changed)).toThrow(/requires a retained predecessor/);
    expect(count('authority_source_revisions_v1')).toBe(1);
    const child = captureSource({ content: changed.content, previous: root });
    expect(admit(child)).toMatchObject({ admission: 'admitted' });
    const rootReplay = captureSource({ content: root.content, captured_at: '2026-10-03T01:00:00.000Z' });
    expect(admit(rootReplay)).toMatchObject({ admission: 'duplicate' });
    const anotherRoot = captureSource({ content: { ...root.content, label: 'Another changed root' } });
    expect(() => admit(anotherRoot)).toThrow(/requires a retained predecessor/);
    expect(count('authority_source_revisions_v1')).toBe(2);
  });
  it('refuses oversized annotations before retention rather than committing unreadable inputs', () => {
    const raw = captureContent(); if (raw.lifecycle !== 'present') throw new Error('fixture');
    const refs = Array.from({ length: 64 }, (_, i) => captureSourceRefV1({ tool: 'fixture', tenant: 'workspace', kind: 'actor', id: `actor-${i}` }));
    const mentions = refs.slice(0, 32).map(ref => ({ source_actor_ref: ref, role: 'mentioned' as const, evidence: { passage_id: 'p1', start: 0, end: 4, quote: 'Alex' } }));
    const source = captureSource({ content: { ...raw, payload: { schema_version: 1, kind: 'meeting', started_at: CAPTURE_TIME, participant_refs: refs.slice(32) },
      actors: mentions, actions: [] } });
    // Long principal/membership/link fields are structurally bounded but exceed the aggregate annotation cap.
    const people = refs.map(source_actor_ref => ({ source_actor_ref, principal_id: 'p'.repeat(2048), membership_id: 'm'.repeat(2048), identity_link_ref: 'l'.repeat(2048) }));
    expect(() => admit(source, { ...captureBindings(), people })).toThrow(/annotation exceeds/);
    expect(count('authority_sources_v1')).toBe(0);
  });
});
