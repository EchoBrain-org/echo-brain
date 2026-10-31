import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { HUMAN_ACT_RECORD_INPUT_CODECS_V4 } from '@echo-brain/organization-protocol';
import { createPersonPolicyFactProjectorV2, createRecordPolicyFactProjectorRegistryV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { AnswerCompositionGenerationBindingV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import { openOrganizationAuthorityRuntime, type OrganizationAuthorityRuntimeConfig } from '../src/composition/organization-authority-runtime.js';
import { openOrganizationAuthorityService } from '../src/composition/organization-authority-composition-root.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials } from '../src/composition/person-onboarding-service.js';
import { port as availablePort } from './fixtures/owner-session.js';

// The real meeting runtime, recording the diagnostics its meeting worker claims captures through.
const meetingDiagnostics = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/composition/person-meeting-runtime-v1.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composition/person-meeting-runtime-v1.js')>();
  return { ...actual, openPersonMeetingRuntimeV1: (...args: Parameters<typeof actual.openPersonMeetingRuntimeV1>) => {
    const runtime = actual.openPersonMeetingRuntimeV1(...args);
    return { ...runtime, attachDiagnostics: (value: Parameters<typeof runtime.attachDiagnostics>[0]) => { meetingDiagnostics.push(value); runtime.attachDiagnostics(value); } };
  } };
});

// The search engine as shipped, unless a test makes builds refuse or reports a fuller published generation.
const searchEngine = vi.hoisted(() => ({
  refuse: undefined as string | undefined,
  usage: undefined as { atoms: number; segments: number; postings: number } | undefined,
}));
vi.mock('@echo-brain/organization-retrieval/readable-search-engine-v1', async importOriginal => {
  const actual = await importOriginal<typeof import('@echo-brain/organization-retrieval/readable-search-engine-v1')>();
  return {
    ...actual,
    buildReadableSearchGenerationV1: (input: Parameters<typeof actual.buildReadableSearchGenerationV1>[0]) => {
      if (searchEngine.refuse !== undefined) throw new Error(`readable-search generation exceeds ${searchEngine.refuse}`);
      return actual.buildReadableSearchGenerationV1(input);
    },
    readableSearchActiveGenerationUsageV1: () => searchEngine.usage ?? actual.readableSearchActiveGenerationUsageV1(),
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  searchEngine.refuse = undefined;
  searchEngine.usage = undefined;
});

const generation: AnswerCompositionGenerationBindingV1 = {
  generation: { generation_adapter_id: 'personal-only-generation', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1000 },
  structured_output: { async generate() { throw new Error('the idle runtime must not generate'); } },
};

/** A fixture organization's own row in the shared admission table, keyed like the removed organization lane. */
function seedOrganizationSourceRow(state: string, owner: { organization_id: string; owner_principal_id: string; owner_membership_id: string }): void {
  const database = openAuthorityDatabase(join(state, 'authority.sqlite'), { fileMustExist: true });
  const now = new Date().toISOString();
  try {
    database.prepare(`INSERT INTO authority_live_source_admission_v2 (
      source_key, organization_id, principal_id, membership_id, membership_type,
      source_adapter_id, source_adapter_version, source_adapter_instance_id, normalizer_version,
      source_custodian_sha256, source_custodian_assurance, source_custodian_observed_at,
      source_credential_reference_sha256, initial_cursor, cutoff_at,
      processor_adapter_id, processor_adapter_version, processor_instance_id,
      processor_configuration_sha256, processor_credential_reference_sha256, semantic_input_sha256, admitted_at
    ) VALUES (?, ?, ?, ?, 'owner', 'fixture-source', '1.0.0', 'fixture-source', '1.0.0', ?, 'authority_initial_owner_identity', ?, ?, 'fixture-cursor', ?,
      'llm', '1.0.0', 'fixture-llm', ?, ?, ?, ?)`)
      .run('1', owner.organization_id, owner.owner_principal_id, owner.owner_membership_id, canonicalSha256('custodian'), now,
        canonicalSha256('source-credential'), now, canonicalSha256('processor-configuration'), canonicalSha256('processor-credential'),
        canonicalSha256('organization-source-admission'), now);
  } finally { database.close(); }
}

/** A fresh private state directory with an initialized owner and session credentials. */
function bootstrapFixture(names: { readonly organization: string; readonly owner: string; readonly revision: string }) {
  const created = mkdtempSync(join(tmpdir(), 'echo-runtime-personal-only-'));
  chmodSync(created, 0o700);
  const root = realpathSync(created);
  roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'), organization_display_name: names.organization, owner_display_name: names.owner,
    created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: names.revision,
  });
  return { root, initialized, credentials: initializePersonSessionCredentials({ state_directory: initialized.state_directory }) };
}

/** The provider-neutral runtime with no meeting provider composed. */
async function startRuntimeForTest(options: { readonly organization_source_row?: true; readonly before_open?: (state_directory: string) => void } & Pick<OrganizationAuthorityRuntimeConfig, 'on_search_capacity' | 'on_worker_error'>) {
  const { initialized, credentials } = bootstrapFixture({ organization: 'Personal-only fixture', owner: 'Owner', revision: 'personal-only-runtime-test' });
  if (options.organization_source_row === true) seedOrganizationSourceRow(initialized.state_directory, initialized);
  options.before_open?.(initialized.state_directory);
  const runtime = await openOrganizationAuthorityRuntime({
    ...(options.on_search_capacity === undefined ? {} : { on_search_capacity: options.on_search_capacity }),
    ...(options.on_worker_error === undefined ? {} : { on_worker_error: options.on_worker_error }),
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
    oidc: { issuer: 'https://issuer.invalid', client_id: 'fixture-client', redirect_uri: 'https://authority.example/v2/session/oidc/callback', tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] },
    client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
    answer_composition_generation_bundle: { load: () => generation },
    record_input_codecs: HUMAN_ACT_RECORD_INPUT_CODECS_V4,
    record_policy_fact_projectors: createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2()]),
    worker_interval_ms: 3_600_000,
  }, { api: {} });
  const db = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  return {
    processing: runtime.processing,
    address: runtime.address,
    db,
    close: async () => { try { await runtime.close(); } finally { db.close(); } },
  };
}

describe('Organization Authority runtime without an organization source lane', () => {
  it('serves the API on the personal path even when an admission row is keyed like the removed organization source', async () => {
    const runtime = await startRuntimeForTest({ organization_source_row: true });
    try {
      expect(runtime.processing).toBe('idle_until_finalize');
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(runtime.db.prepare('SELECT count(*) FROM authority_live_source_progress_v2').pluck().get()).toBe(0);
    } finally { await runtime.close(); }
  });

  it('serves the API with its search index past the ceiling, naming the limit it hit', async () => {
    searchEngine.refuse = 'maximum_segments';
    const capacity: unknown[] = [];
    const failures: string[] = [];
    const runtime = await startRuntimeForTest({ on_search_capacity: event => capacity.push(event), on_worker_error: error => failures.push(error.message) });
    try {
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(capacity[0]).toEqual({ status: 'over', limit: 'maximum_segments' });
      expect(failures[0]).toBe('readable-search generation exceeds maximum_segments');
      expect(runtime.db.prepare('SELECT count(*) FROM authority_readable_search_active_generation').pluck().get()).toBe(0);
    } finally { await runtime.close(); }
  });

  it('starts after a search rebuild was killed midway, and its next build removes the leftover', async () => {
    let retrieval = '';
    const runtime = await startRuntimeForTest({ before_open: state => {
      // What a kill during the first rebuild leaves: generations/, and a half-written segment beside it.
      retrieval = join(state, 'record-retrieval');
      const segment = join(retrieval, `.staging-${'c'.repeat(32)}`, 'segments', 'partial');
      mkdirSync(segment, { recursive: true, mode: 0o700 });
      mkdirSync(join(retrieval, 'generations'), { mode: 0o700 });
      writeFileSync(join(segment, 'facts.sqlite-journal'), 'unfinished');
    } });
    try {
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(readdirSync(retrieval)).toEqual(['generations']);
      expect(readdirSync(join(retrieval, 'generations'))).toEqual([
        runtime.db.prepare('SELECT generation_id FROM authority_readable_search_active_generation').pluck().get(),
      ]);
    } finally { await runtime.close(); }
  });

  it('warns once a published search generation reaches three quarters of a limit', async () => {
    const notices = async (usage: NonNullable<typeof searchEngine.usage>) => {
      searchEngine.usage = usage;
      const capacity: unknown[] = [];
      const runtime = await startRuntimeForTest({ on_search_capacity: event => capacity.push(event) });
      await runtime.close();
      return capacity;
    };
    expect(await notices({ atoms: 6_143, segments: 95, postings: 153_599 })).toEqual([]);
    for (const usage of [{ atoms: 6_144, segments: 1, postings: 0 }, { atoms: 0, segments: 96, postings: 0 }, { atoms: 0, segments: 1, postings: 153_600 }])
      expect(await notices(usage)).toEqual([{ status: 'near', ...usage }]);
  });

  it('starts the deployable service before any personal source without reading provider credentials', async () => {
    const { root: parent, initialized, credentials } = bootstrapFixture({ organization: 'Founder Organization', owner: 'Founder', revision: 'organization-authority-runtime-test' });
    const runtime = await openOrganizationAuthorityService({
      state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
      oidc: { issuer: 'https://issuer.invalid', client_id: 'founder-client', redirect_uri: 'https://authority.example/v2/session/oidc/callback', tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] },
      client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
      nango: { secret_key: 'nango-secret-key-not-used-000000', integration_key: 'slack' },
      openrouter_credential_file: join(parent, 'not-read-openrouter'),
    });
    const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    try {
      // The personal meeting runtime is composed and idle until a person connects a source.
      expect(runtime.processing).toBe('active');
      expect(runtime.run_staging_synthetic_canary).toBeUndefined();
      // Prepared meeting_extraction captures are claimed only once the root hands the worker its diagnostics.
      expect(meetingDiagnostics).toEqual([expect.objectContaining({ claimMeeting: expect.any(Function) })]);
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(database.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
    } finally { database.close(); await runtime.close(); }
  });
});
