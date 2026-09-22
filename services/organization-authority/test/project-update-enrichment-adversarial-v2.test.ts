import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { PersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/retrieval-grounded-answer-composition';
import { SqlitePersonUpdateInboxV1 } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { SqlitePersonUpdateEnrichmentWorkV2 } from '../src/adapters/persistence/sqlite/person-update-enrichment-work-v2.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { SqliteProjectUploadEnrichmentAuthorizationV1 } from '../src/adapters/persistence/sqlite/project-upload-enrichment-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createPersonUpdateProcessingV1 } from '../src/composition/person-update-processing-v1.js';
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase, revokeMembership } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });
const requestId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  let now = PROJECT_CONTEXT_NOW;
  const repository = new SqliteProjectContextRepositoryV1(database, () => now);
  const application = createProjectContextApplicationV1({
    authenticate: token => authorization(token === 'member' ? MEMBER : OWNER), repository,
  });
  const inbox = new SqlitePersonUpdateInboxV1(database, () => now);
  const policy = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
  const work = new SqlitePersonUpdateEnrichmentWorkV2(database, policy, () => now);
  const generate = vi.fn<StructuredGenerationPort['generate']>(async () => ({ search_hints: 'telephone' }));
  const generation = {
    structured_output: { generate },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1_000 },
  };
  const project = application.createProject('owner', {
    schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(1), name: 'Project',
  });
  application.setMember('owner', {
    schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(2),
    project_id: project.project_id, membership_id: MEMBER.membership_id, role: 'lead',
  });
  const worker = () => createPersonUpdateProcessingV1(inbox, generation, work);
  const run = () => worker().runOnce(new AbortController().signal);
  const submit = (audience: PersonUpdateSubmitV2['audience'] = { kind: 'team' }) => application.submitUpload('owner', {
    schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(3),
    title: 'Customer note', text: 'The customer prefers calls.', project_id: project.project_id, audience,
  });
  const removeUploader = () => application.removeMember('member', {
    schema_version: 1, kind: 'echo-project-member-remove-v1', request_id: requestId(4),
    project_id: project.project_id, membership_id: OWNER.membership_id,
  });
  return {
    database, application, inbox, policy, generate, project, worker, run, submit, removeUploader,
    later: () => { now = new Date(Date.parse(now) + 301_000).toISOString(); },
  };
}

function workState(database: Database.Database, contextId: string) {
  return database.prepare('SELECT state, search_hints, attempts FROM authority_person_update_work_v2 WHERE context_id = ?').get(contextId);
}

describe('V2 enrichment lifecycle and revocation', () => {
  it('uses the same bounded worker pass for V1 and V2 work without reprocessing completed hints', async () => {
    const f = fixture();
    const v1 = f.inbox.submit(OWNER, {
      schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: requestId(5),
      title: 'V1 note', text: 'The first customer prefers calls.', visibility: 'team',
    });
    const v2 = f.submit();
    await f.run();
    expect(f.inbox.status(OWNER, v1.request_id).metadata).toBe('ready');
    expect(workState(f.database, v2.context_id)).toMatchObject({ state: 'pending' });
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.run();
    await f.run();
    expect(workState(f.database, v2.context_id)).toMatchObject({ state: 'ready' });
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.database.prepare('SELECT count(*) AS n FROM authority_live_source_candidates_v2').get()).toEqual({ n: 0 });
  });

  it.each(['organization', 'audience project'] as const)('does not hand an original to the model after uploader %s revocation', async kind => {
    const f = fixture();
    const receipt = f.submit({ kind: 'project', project_id: f.project.project_id });
    if (kind === 'organization') revokeMembership(f.database, OWNER);
    else f.removeUploader();
    await f.run();
    expect(f.generate).not.toHaveBeenCalled();
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'unavailable', search_hints: '' });
    expect(f.application.readUpload('member', receipt.context_id).text).toBe('The customer prefers calls.');
  });

  it('discards model hints after organization revocation and preserves another member’s team-original access', async () => {
    const f = fixture();
    const receipt = f.submit();
    f.generate.mockImplementationOnce(async () => {
      revokeMembership(f.database, OWNER);
      return { search_hints: 'telephone' };
    });
    await f.run();
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'unavailable', search_hints: '' });
    expect(f.application.readUpload('member', receipt.context_id).text).toBe('The customer prefers calls.');
    expect(f.application.searchUploads('member', { query: 'telephone' }).results).toEqual([]);
    expect(f.application.searchUploads('member', { query: 'customer' }).results).toHaveLength(1);
  });

  it('does not let an association-project removal change team-audience enrichment eligibility', async () => {
    const f = fixture();
    const receipt = f.submit();
    f.generate.mockImplementationOnce(async () => {
      f.removeUploader();
      return { search_hints: 'telephone' };
    });
    await f.run();
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'ready', search_hints: 'telephone' });
    expect(f.application.readUpload('owner', receipt.context_id)).toMatchObject({ audience: { kind: 'team' } });
    expect(f.application.searchUploads('member', { query: 'telephone' }).results).toHaveLength(1);
  });

  it('leaves interrupted V2 work reclaimable and never commits hints after cancellation', async () => {
    const f = fixture();
    const receipt = f.submit();
    const aborted = new AbortController();
    f.generate.mockImplementationOnce(async () => {
      aborted.abort(new Error('fixture shutdown'));
      return { search_hints: 'telephone' };
    });
    await expect(f.worker().runOnce(aborted.signal)).rejects.toThrow('fixture shutdown');
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'processing', search_hints: '' });
    expect(f.application.readUpload('member', receipt.context_id).text).toBe('The customer prefers calls.');
    await f.run();
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'ready', search_hints: 'telephone' });
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it('backs off and terminates optional V2 retries while retaining original search', async () => {
    const f = fixture();
    const receipt = f.submit();
    f.generate.mockRejectedValue(new Error('fixture model failure'));
    await f.run();
    await f.run();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'pending', attempts: 1 });
    for (let attempt = 0; attempt < 4; attempt++) { f.later(); await f.run(); }
    expect(workState(f.database, receipt.context_id)).toEqual({ state: 'unavailable', search_hints: '', attempts: 5 });
    f.later(); await f.run();
    expect(f.generate).toHaveBeenCalledTimes(5);
    expect(f.application.readUpload('member', receipt.context_id).text).toBe('The customer prefers calls.');
    expect(f.application.searchUploads('member', { query: 'customer' }).results).toHaveLength(1);
  });

  it('performs the final eligibility check in the same transaction as hint completion', async () => {
    const f = fixture();
    const receipt = f.submit();
    const assertCurrent = f.policy.assertCurrent.bind(f.policy);
    const checked = vi.spyOn(f.policy, 'assertCurrent').mockImplementation(snapshot => {
      expect(f.database.inTransaction).toBe(true);
      expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'processing', search_hints: '' });
      assertCurrent(snapshot);
    });
    await f.run();
    expect(checked).toHaveBeenCalledTimes(1);
    expect(f.database.inTransaction).toBe(false);
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'ready', search_hints: 'telephone' });
  });

  it('rejects provider output that tries to rewrite audience or original bytes', async () => {
    const f = fixture();
    const receipt = f.submit({ kind: 'only_me' });
    f.generate.mockResolvedValue({ search_hints: 'telephone', audience: { kind: 'team' }, text: 'rewritten' });
    await f.run();
    expect(workState(f.database, receipt.context_id)).toMatchObject({ state: 'pending', search_hints: '' });
    expect(f.application.readUpload('owner', receipt.context_id)).toMatchObject({ text: 'The customer prefers calls.', audience: { kind: 'only_me' } });
    expect(() => f.application.readUpload('member', receipt.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
