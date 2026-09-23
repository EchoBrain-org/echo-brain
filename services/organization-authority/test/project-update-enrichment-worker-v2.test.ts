import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { SqlitePersonUpdateInboxV1 } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { SqlitePersonUpdateEnrichmentWorkV2 } from '../src/adapters/persistence/sqlite/person-update-enrichment-work-v2.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { SqliteProjectUploadEnrichmentAuthorizationV1 } from '../src/adapters/persistence/sqlite/project-upload-enrichment-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { PersonUpdateProcessingV1 } from '../src/composition/person-update-processing-v1.js';
import { MEMBER, OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });

function requestId(value: number): string { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }

function fixture() {
  const database = projectContextDatabase(); databases.push(database);
  const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
  const application = createProjectContextApplicationV1({
    authenticate: token => authorization(token === 'member' ? MEMBER : OWNER),
    repository,
  });
  const generation = {
    structured_output: { generate: vi.fn(async () => ({ search_hints: 'customer telephone preference' })) },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1_000 },
  };
  const inbox = new SqlitePersonUpdateInboxV1(database, () => PROJECT_CONTEXT_NOW);
  const worker = () => new PersonUpdateProcessingV1(
    inbox,
    generation,
    new SqlitePersonUpdateEnrichmentWorkV2(database, new SqliteProjectUploadEnrichmentAuthorizationV1(database), () => PROJECT_CONTEXT_NOW),
  );
  return { database, application, generation, inbox, worker };
}

function setupProject(f: ReturnType<typeof fixture>) {
  const project = f.application.createProject('owner', {
    schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(1), name: 'Launch',
  });
  f.application.setMember('owner', {
    schema_version: 1, kind: 'echo-project-member-set-v1', request_id: requestId(2),
    project_id: project.project_id, membership_id: MEMBER.membership_id, role: 'member',
  });
  return project.project_id;
}

describe('V2 project upload enrichment in the serialized Person worker', () => {
  it('validates and enriches a V3 projects-audience upload through the same requested-only worker', async () => {
    const f = fixture();
    const first = f.application.createProject('owner', { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(70), name: 'Sensors' });
    const second = f.application.createProject('owner', { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(71), name: 'Software' });
    const projectIds = [first.project_id, second.project_id].sort();
    const receipt = f.application.submitUploadV3('owner', {
      schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: requestId(72), title: 'Shared plan',
      text: 'The sensor and software teams need one verified integration plan.', association_project_ids: projectIds,
      audience: { kind: 'projects', project_ids: projectIds },
    });
    await f.worker().runOnce(new AbortController().signal);
    expect(f.database.prepare('SELECT state, search_hints FROM authority_person_update_work_v2 WHERE context_id = ?').get(receipt.context_id))
      .toEqual({ state: 'ready', search_hints: 'customer telephone preference' });
    expect(f.generation.structured_output.generate).toHaveBeenCalledTimes(1);
  });

  it('serves due V2 work on the next run despite a continuing V1 backlog', async () => {
    const f = fixture(); const projectId = setupProject(f); const worker = f.worker();
    f.inbox.submit(OWNER, {
      schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: requestId(90),
      title: 'Legacy note', text: 'The legacy queue remains busy.',
    });
    const receipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(91),
      title: 'Project note', text: 'The project queue must not starve.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });

    await worker.runOnce(new AbortController().signal);
    f.inbox.submit(OWNER, {
      schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: requestId(92),
      title: 'Later legacy note', text: 'Sustained legacy input must remain serialized.',
    });
    await worker.runOnce(new AbortController().signal);

    expect(f.database.prepare('SELECT state FROM authority_person_update_work_v2 WHERE context_id = ?').get(receipt.context_id))
      .toEqual({ state: 'ready' });
    expect(f.generation.structured_output.generate).toHaveBeenCalledTimes(2);
  });

  it('does not let a visibly corrupt V1 item starve due V2 work', async () => {
    const f = fixture(); const projectId = setupProject(f); const worker = f.worker();
    const legacy = f.inbox.submit(OWNER, {
      schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: requestId(93),
      title: 'Legacy note', text: 'This source will be corrupted.',
    });
    const receipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(94),
      title: 'Project note', text: 'The project queue must still progress.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });
    f.database.exec('DROP TRIGGER authority_person_updates_v1_immutable');
    f.database.prepare('UPDATE authority_person_updates_v1 SET text = ? WHERE context_id = ?')
      .run('corrupt', legacy.context_id);

    await expect(worker.runOnce(new AbortController().signal)).rejects.toThrow('integrity');
    await worker.runOnce(new AbortController().signal);

    expect(f.database.prepare('SELECT state FROM authority_person_update_work_v2 WHERE context_id = ?').get(receipt.context_id))
      .toEqual({ state: 'ready' });
    expect(f.generation.structured_output.generate).toHaveBeenCalledTimes(1);
  });

  it('validates immutable V2 source bytes, captures eligibility before generation, and persists optional hints', async () => {
    const f = fixture(); const projectId = setupProject(f);
    const receipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(3),
      title: 'Customer notes', text: 'The customer prefers a telephone call.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });

    await f.worker().runOnce(new AbortController().signal);
    expect(f.database.prepare('SELECT state, search_hints FROM authority_person_update_work_v2 WHERE context_id = ?').get(receipt.context_id))
      .toEqual({ state: 'ready', search_hints: 'customer telephone preference' });
    expect(f.application.readUpload('member', receipt.context_id)).toMatchObject({ text: 'The customer prefers a telephone call.' });
    expect(f.generation.structured_output.generate).toHaveBeenCalledTimes(1);
  });

  it('stops hints after audience-project revoke/rejoin while another current reader can still read the original', async () => {
    const f = fixture(); const projectId = setupProject(f);
    const receipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(4),
      title: 'Customer notes', text: 'The customer prefers a telephone call.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });
    f.generation.structured_output.generate.mockImplementationOnce(async () => {
      f.database.prepare("UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_id = ? AND membership_id = ?")
        .run(PROJECT_CONTEXT_NOW, projectId, OWNER.membership_id);
      f.database.prepare(`INSERT INTO authority_project_memberships_v1
        (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at)
        VALUES ('pgm_99999999-9999-4999-8999-999999999999', ?, ?, ?, ?, ?, 'lead', 'active', ?)`)
        .run(projectId, OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type, PROJECT_CONTEXT_NOW);
      return { search_hints: 'customer telephone preference' };
    });

    await f.worker().runOnce(new AbortController().signal);
    expect(f.database.prepare('SELECT state, search_hints FROM authority_person_update_work_v2 WHERE context_id = ?').get(receipt.context_id))
      .toEqual({ state: 'unavailable', search_hints: '' });
    expect(f.application.readUpload('member', receipt.context_id)).toMatchObject({ text: 'The customer prefers a telephone call.' });
  });

  it('fails visibly before model handoff when immutable V2 source bytes are corrupt', async () => {
    const f = fixture(); const projectId = setupProject(f);
    const receipt = f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(5),
      title: 'Customer notes', text: 'The customer prefers a telephone call.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });
    f.database.exec('DROP TRIGGER authority_person_updates_v2_immutable');
    f.database.prepare('UPDATE authority_person_updates_v2 SET text = ? WHERE context_id = ?').run('corrupt', receipt.context_id);

    await expect(f.worker().runOnce(new AbortController().signal)).rejects.toThrow('integrity');
    expect(f.generation.structured_output.generate).not.toHaveBeenCalled();
  });

  it('never completes one claimed source with another source eligibility snapshot', () => {
    const f = fixture(); const projectId = setupProject(f);
    for (const number of [6, 7]) f.application.submitUpload('owner', {
      schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: requestId(number),
      title: `Customer notes ${number}`, text: 'The customer prefers a telephone call.', project_id: projectId,
      audience: { kind: 'project', project_id: projectId },
    });
    const work = new SqlitePersonUpdateEnrichmentWorkV2(f.database, new SqliteProjectUploadEnrichmentAuthorizationV1(f.database), () => PROJECT_CONTEXT_NOW);
    const first = work.claim()!;
    f.database.prepare("UPDATE authority_person_update_work_v2 SET retry_at = '2027-01-01T00:00:00.000Z' WHERE context_id = ?").run(first.context_id);
    const second = work.claim()!;
    const firstEligibility = work.captureEligibility(first)!;
    const secondEligibility = work.captureEligibility(second)!;

    expect(firstEligibility.context_id).not.toBe(secondEligibility.context_id);
    expect(() => work.enriched(first, secondEligibility, 'customer', canonicalSha256('fixture')))
      .toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(f.database.prepare('SELECT state, search_hints FROM authority_person_update_work_v2 WHERE context_id = ?').get(first.context_id))
      .toEqual({ state: 'processing', search_hints: '' });
  });
});
