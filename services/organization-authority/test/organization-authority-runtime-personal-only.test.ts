import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { HUMAN_ACT_RECORD_INPUT_CODECS_V4 } from '@echo-brain/organization-protocol';
import { createPersonPolicyFactProjectorV2, createRecordPolicyFactProjectorRegistryV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { AnswerCompositionGenerationBindingV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import { openOrganizationAuthorityRuntime } from '../src/composition/organization-authority-runtime.js';
import { openOrganizationAuthorityService } from '../src/composition/organization-authority-composition-root.js';
import type { OrganizationAuthorityApiRuntimeDependencies } from '../src/composition/organization-authority-api-runtime.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials } from '../src/composition/person-onboarding-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

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

/** The provider-neutral runtime with only the seams a caller selects; no meeting provider is composed. */
async function startRuntimeForTest(options: {
  readonly slack: OrganizationAuthorityApiRuntimeDependencies['external_identity_runtime_bundle'];
  readonly granola: OrganizationAuthorityApiRuntimeDependencies['person_http_runtime_factory'];
  readonly organization_source_row?: true;
}) {
  const created = mkdtempSync(join(tmpdir(), 'echo-runtime-personal-only-'));
  chmodSync(created, 0o700);
  const root = realpathSync(created);
  roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'), organization_display_name: 'Personal-only fixture', owner_display_name: 'Owner',
    created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: 'personal-only-runtime-test',
  });
  const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  if (options.organization_source_row === true) seedOrganizationSourceRow(initialized.state_directory, initialized);
  const runtime = await openOrganizationAuthorityRuntime({
    state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
    oidc: { issuer: 'https://issuer.invalid', client_id: 'fixture-client', redirect_uri: 'https://authority.example/v2/session/oidc/callback', tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] },
    client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
    answer_composition_generation_bundle: { load: () => generation },
    record_input_codecs: HUMAN_ACT_RECORD_INPUT_CODECS_V4,
    record_policy_fact_projectors: createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2()]),
    worker_interval_ms: 3_600_000,
  }, {
    api: {
      ...(options.slack === undefined ? {} : { external_identity_runtime_bundle: options.slack }),
      ...(options.granola === undefined ? {} : { person_http_runtime_factory: options.granola }),
    },
  });
  const db = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  return {
    processing: runtime.processing,
    address: runtime.address,
    db,
    close: async () => { try { await runtime.close(); } finally { db.close(); } },
  };
}

describe('Organization Authority runtime without an organization source lane', () => {
  it('starts with neither Slack nor Granola configured and never admits source 1', async () => {
    const runtime = await startRuntimeForTest({ slack: undefined, granola: undefined });
    expect(runtime.processing).toBe('idle_until_finalize');
    expect(runtime.db.prepare('SELECT count(*) FROM authority_live_source_admission_v2 WHERE source_key = ?').pluck().get('1')).toBe(0);
    await runtime.close();
  });

  it('serves the API on the personal path even when an admission row is keyed like the removed organization source', async () => {
    const runtime = await startRuntimeForTest({ slack: undefined, granola: undefined, organization_source_row: true });
    try {
      expect(runtime.processing).toBe('idle_until_finalize');
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(runtime.db.prepare('SELECT count(*) FROM authority_live_source_progress_v2').pluck().get()).toBe(0);
    } finally { await runtime.close(); }
  });

  it('starts the deployable service before any personal source without reading provider credentials', async () => {
    const created = mkdtempSync(join(tmpdir(), 'echo-runtime-personal-only-'));
    chmodSync(created, 0o700);
    const parent = realpathSync(created);
    roots.push(parent);
    const initialized = bootstrapOrganizationAuthorityState({
      state_directory: join(parent, 'state'), organization_display_name: 'Founder Organization', owner_display_name: 'Founder',
      created_at: new Date(Date.now() - 1000).toISOString(), creating_artifact_revision: 'organization-authority-runtime-test',
    });
    const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
    const runtime = await openOrganizationAuthorityService({
      state_directory: initialized.state_directory, host: '127.0.0.1', port: await availablePort(), authority_url: 'https://authority.example',
      oidc: { issuer: 'https://issuer.invalid', client_id: 'founder-client', redirect_uri: 'https://authority.example/v2/session/oidc/callback', tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] },
      client_authentication: { method: 'none' }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
      slack_nango: { secret_key: 'nango-secret-key-not-used-000000', integration_key: 'slack' },
      openrouter_credential_file: join(parent, 'not-read-openrouter'),
    });
    const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    try {
      // The personal meeting runtime is composed and idle until a person connects a source.
      expect(runtime.processing).toBe('active');
      expect(runtime.run_staging_synthetic_canary).toBeUndefined();
      expect((await fetch(`http://127.0.0.1:${String(runtime.address.port)}/v1/authority-descriptor`)).status).toBe(200);
      expect(database.prepare('SELECT count(*) FROM authority_live_source_admission_v2').pluck().get()).toBe(0);
    } finally { database.close(); await runtime.close(); }
  });
});
