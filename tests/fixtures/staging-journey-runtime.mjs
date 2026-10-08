// Synthetic fixture only. Real Authority/SQLite/setup/canary code with a
// provider-free decision processor and deny-by-default network. Never reads live state.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { openOrganizationControlDatabase } from "@echo-brain/provider-slack-server/organization-control-plane/slack-approval-integration-v1";

const REPO = resolve(import.meta.dirname, '../..');
const [mode, root, releaseId] = process.argv.slice(2);
assert.ok(root?.startsWith('/') && readFileSync(join(root, 'fixture-owner'), 'utf8') === 'staging-journey-v1\n');
const state = join(root, 'host/clean-data/state');
const metadataPath = join(root, 'fixture-runtime.json');
const evidencePath = join(root, 'provider-evidence.json');
const socket = join(root, 'canary.sock');
const NOW = '2026-09-06T00:00:00.000Z';
const ORIGIN = 'https://authority-staging.echobrain.org';
const OWNER = 'owner@example.test';
const SLACK = { workspace: 'T012JOURNEY', app: 'A012JOURNEY', bot: 'B012JOURNEY', botUser: 'U012BOT', owner: 'U012OWNER' };
const SCOPES = ['chat:write', 'im:history', 'im:write', 'users:read'];
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'journey-client', redirect_uri: `${ORIGIN}/v2/session/oidc/callback`, tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] };
const product = suffix => import(pathToFileURL(join(REPO, 'services/organization-authority/dist', suffix)));
const write = (path, value) => { writeFileSync(path, typeof value === 'string' ? value : canonicalJson(value) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); return path; };
const read = path => JSON.parse(readFileSync(path, 'utf8'));
globalThis.fetch = async () => { throw new Error('fixture refuses unconfigured network'); };

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}

async function seedOwner(initialized) {
  const { initializePersonSessionCredentials, issuePersonOnboardingInvitation } = await product('composition/person-onboarding-service.js');
  const { readPrivateAuthorityPersonSessionPkceKey } = await import(pathToFileURL(join(REPO, 'packages/organization-authority-kernel/dist/adapters/security/private-file-credentials.js')));
  const { openAuthorityDatabase } = await import(pathToFileURL(join(REPO, 'packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js')));
  const { PersonIdentitySessionApplication } = await product('application/person-identity-sessions.js');
  const { SqlitePersonSessionRepository } = await product('adapters/persistence/sqlite/sqlite-person-session-repository.js');
  const { NodePersonSessionCrypto } = await product('adapters/security/node-person-session-crypto.js');
  const { SystemAuthorityClock } = await product('adapters/system/system-authority-clock.js');
  const credentials = initializePersonSessionCredentials({ state_directory: state });
  const pkce = readPrivateAuthorityPersonSessionPkceKey(credentials.pkce_sealing_key_reference);
  const invitationPath = join(root, 'invitation.json');
  issuePersonOnboardingInvitation({ state_directory: state, oidc: OIDC, pkce_sealing_key: pkce, membership_id: initialized.owner_membership_id, expected_email: OWNER, authority_url: ORIGIN, output_path: invitationPath });
  const db = openAuthorityDatabase(join(state, 'authority.sqlite'), { fileMustExist: true });
  try {
    let attempt;
    const provider = {
      buildAuthorizationUrl(input) { attempt = input; return 'https://issuer.example.test/authorize'; },
      async redeemAuthorizationCode() { return { kind: 'verified', token: { issuer: OIDC.issuer, subject: 'synthetic-owner', audience: OIDC.client_id, nonce: attempt.nonce, issued_at: Math.floor(Date.now() / 1000), claims: { email: OWNER, email_verified: true } } }; },
    };
    const crypto = new NodePersonSessionCrypto(pkce);
    const sessions = new PersonIdentitySessionApplication(new SqlitePersonSessionRepository(db), OIDC, { clock: new SystemAuthorityClock(), random: crypto, hash: crypto, pkce_sealer: crypto, oidc_provider: provider });
    const begun = sessions.beginOidcLogin({ kind: 'identity_bootstrap', login_grant: read(invitationPath).login_grant });
    provider.buildAuthorizationUrl(begun);
    const result = await sessions.completeOidcLogin({ state: begun.state, authorization_code: 'synthetic-code' });
    assert.ok(result);
  } finally { db.close(); }
  return { pkce_key_file: credentials.pkce_sealing_key_reference.slice(5), invitationPath };
}

async function seedCanaryProject(initialized) {
  const { openAuthorityDatabase } = await import(pathToFileURL(join(REPO, 'packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js')));
  const db = openAuthorityDatabase(join(state, 'authority.sqlite'), { fileMustExist: true });
  const project_id = 'prj_00000000-0000-4000-8000-000000000001';
  try {
    db.prepare(`INSERT OR IGNORE INTO authority_project_authorization_state_v1
      (organization_id, revision, updated_at) VALUES (?, 0, ?)`)
      .run(initialized.organization_id, NOW);
    db.prepare(`INSERT INTO authority_projects_v1
      (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
      VALUES (?, ?, 'Synthetic canary project', ?, ?, ?, 'owner')`)
      .run(project_id, initialized.organization_id, NOW, initialized.owner_principal_id, initialized.owner_membership_id);
    db.prepare(`INSERT INTO authority_project_memberships_v1
      (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at, revoked_at)
      VALUES ('pgm_00000000-0000-4000-8000-000000000001', ?, ?, ?, ?, 'owner', 'lead', 'active', ?, NULL)`)
      .run(project_id, initialized.organization_id, initialized.owner_principal_id, initialized.owner_membership_id, NOW);
  } finally { db.close(); }
  return project_id;
}

/** The owner's in-app install of the ECHO app through Nango, with its credential bundle, and the owner's Slack link. */
async function seedSlack(initialized) {
  const { buildExternalHumanIdentityLinkContractV2 } = await import(pathToFileURL(join(REPO, 'providers/slack/server/dist/organization-control-plane/application/organization-tool-connection-contracts-v2.js')));
  const { activateNangoSlackConnectionV1 } = await import(pathToFileURL(join(REPO, 'providers/slack/server/dist/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js')));
  const { serializeSlackAppCredentialsV1 } = await import(pathToFileURL(join(REPO, 'providers/slack/server/dist/organization-control-plane/application/slack-app-credentials-v1.js')));
  const { FileOrganizationSecretStore } = await import(pathToFileURL(join(REPO, 'packages/organization-control-plane/dist/security/file-secret-store.js')));
  const coordinates = { authority_id: initialized.authority_id, organization_id: initialized.organization_id, state_lineage_id: initialized.state_lineage_id };
  const link = buildExternalHumanIdentityLinkContractV2({ ...coordinates, external_identity_link_id: 'clm_journey', provider_issuer: 'https://slack.com', provider_tenant_kind: 'workspace', provider_tenant_id: SLACK.workspace, provider_enterprise_id: null, provider_subject_id: SLACK.owner, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id, membership_type: 'owner', verification_event_id: 'verify_owner', verification_evidence_sha256: canonicalSha256({ fixture: 'owner' }), verified_at: NOW });
  const linkSha = canonicalSha256(link);
  const db = openOrganizationControlDatabase(join(state, 'integrations.sqlite'), { fileMustExist: true });
  try {
    const secrets = new FileOrganizationSecretStore(join(state, 'secrets'));
    const credentials = { kind: 'echo-slack-app-credentials-v1', app_id: SLACK.app, client_id: '1234.5678', client_secret: 'synthetic-not-a-client-secret', signing_secret: 'synthetic-not-a-signing-secret-00000000', nango_connection_id: null };
    await activateNangoSlackConnectionV1({ database: db, secrets, ...coordinates, now: () => NOW, new_connection_id: () => `con_${randomUUID()}`,
      verifier: { verifyConnection: async () => ({ team_id: SLACK.workspace, enterprise_id: null, bot_user_id: SLACK.botUser, bot_id: SLACK.bot, app_id: SLACK.app, granted_scopes: SCOPES, verification_evidence_sha256: canonicalSha256({ fixture: 'verified' }) }) },
      credential: { reference: secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials },
      nango: { connection_id: 'nango-journey', tags: {}, team_id: SLACK.workspace, app_id: SLACK.app, bot_user_id: SLACK.botUser, granted_scopes: SCOPES, bot_token: 'xoxb-synthetic-provider-token', updated_at: NOW } });
    db.prepare('INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)').run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
    db.prepare("INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)").run(link.external_identity_link_id, linkSha, link.provider_issuer, link.provider_tenant_kind, link.provider_tenant_id, null, link.provider_subject_id, link.principal_id, link.membership_id, NOW);
  } finally { db.close(); }
}

if (mode === 'init') {
  const { bootstrapOrganizationAuthorityState } = await product('composition/organization-authority-state-bootstrap.js');
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: state, organization_display_name: 'Synthetic staging rehearsal', owner_display_name: 'Synthetic founder', created_at: NOW, creating_artifact_revision: 'staging-journey-fixture' });
  const owner = await seedOwner(initialized);
  const canary_project_id = await seedCanaryProject(initialized);
  const llm = write(join(root, 'llm.fixture'), 'synthetic-not-a-provider-credential-000000');
  await seedSlack(initialized);
  const oidcPath = write(join(root, 'oidc.json'), { ...OIDC, client_authentication: 'none' });
  const manifest = { schema_version: 3, kind: 'echo-clean-founder-onboarding-manifest-v3', state_directory: state, created_at: NOW, artifact_revision: 'staging-journey-fixture', authority_url: ORIGIN, oidc_config_path: oidcPath, pkce_key_file: owner.pkce_key_file, invitation_path: owner.invitationPath, authority_id: initialized.authority_id, organization_id: initialized.organization_id, state_lineage_id: initialized.state_lineage_id, owner_principal_id: initialized.owner_principal_id, owner_membership_id: initialized.owner_membership_id, llm_credential_file: llm, setup_seed: Object.fromEntries(['authority_id', 'organization_id', 'state_lineage_id', 'owner_principal_id', 'owner_membership_id', 'control_plane_id'].map(key => [key, initialized[key]])), owner_email: OWNER, organization_name: 'Synthetic staging rehearsal', owner_display_name: 'Synthetic founder' };
  mkdirSync(join(state, 'onboarding'), { recursive: true, mode: 0o700 });
  write(join(state, 'onboarding/clean-founder-v1.json'), manifest);
  // The real stopped-state finalize sets up the owner's staging synthetic source.
  const { runOrganizationAuthoritySetupCli } = await product('composition/organization-authority-setup-cli.js');
  assert.equal(await runOrganizationAuthoritySetupCli(['finalize', '--state-dir', state], { stdout: () => undefined, stderr: value => process.stderr.write(value) }), 0);
  // Explicit canary calls drive this test. Keep periodic work out of its window
  // even on a slow CI host.
  write(metadataPath, { initialized, canary_project_id, config: { state_directory: state, host: '127.0.0.1', port: await port(), authority_url: ORIGIN, oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: owner.pkce_key_file, slack_nango: { secret_key: 'synthetic-not-a-nango-secret-key-000000', integration_key: 'slack' }, openrouter_credential_file: llm, worker_interval_ms: 3_600_000 } });
  write(evidencePath, { extraction_calls: 0, worker_errors: [] });
} else if (mode === 'serve') {
  const metadata = read(metadataPath);
  // Provider-free extraction for the personal meeting runtime; it accepts the admitted commitments.
  const person_meeting_processor = {
    processor_adapter_id: 'llm',
    current_commitments: instance_id => ({ adapter_id: 'llm', instance_id, version: 'journey-fixture', configuration_sha256: canonicalSha256({ fixture: 'configuration' }), credential_reference_sha256: canonicalSha256({ fixture: 'credential' }) }),
    assert_admission_commitments() {},
    create_processor(admission) {
      const identity = { kind: 'decision-processor', adapter_id: 'llm', instance_id: admission.processor.instance_id, version: admission.processor.version };
      return { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: NOW }), async extract(meeting) {
        const evidence = read(evidencePath); evidence.extraction_calls++; write(evidencePath, evidence);
        return { schema_version: 1, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity, generated_at: NOW, signals: [{ id: 'fixture-decision', kind: 'decision', status: 'decided', text: 'Rehearse the exact candidate and await human approval.', subject: 'staging', confidence: 1, evidence: [{ meeting_id: meeting.id, block_id: 'synthetic-decision' }] }] };
      } };
    },
  };
  const { openOrganizationAuthorityService } = await product('composition/organization-authority-composition-root.js');
  const runtime = await openOrganizationAuthorityService({ ...metadata.config, on_worker_error(error) { const evidence = read(evidencePath); evidence.worker_errors.push(error.message); write(evidencePath, evidence); } }, { person_meeting_processor });
  assert.equal(runtime.processing, 'active');
  const { openStagingSyntheticPrivateDmCanaryControlV1 } = await import(pathToFileURL(join(REPO, 'providers/slack/server/dist/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-control-v1.js')));
  const observedRuntime = { ...runtime, async run_staging_synthetic_canary(...args) {
    try { return await runtime.run_staging_synthetic_canary(...args); }
    catch (error) { write(join(root, 'runtime-error.txt'), String(error.stack)); throw error; }
  } };
  const control = await openStagingSyntheticPrivateDmCanaryControlV1({ authority_url: ORIGIN, authority_host: 'authority-staging.echobrain.org', release_id: releaseId, runtime: observedRuntime, socket_path: socket });
  process.stdout.write('ready\n');
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await control.close(); await runtime.close();
} else if (mode === 'client') {
  const { requestStagingSyntheticPrivateDmCanaryV1 } = await import(pathToFileURL(join(REPO, 'providers/slack/server/dist/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-client-v1.js')));
  process.stdout.write(JSON.stringify(await requestStagingSyntheticPrivateDmCanaryV1({ release_id: releaseId, socket_path: socket })) + '\n');
} else if (mode === 'verify') {
  const { verifyAuthorityStateLineage } = await import(pathToFileURL(join(REPO, 'packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js')));
  verifyAuthorityStateLineage(state);
} else if (mode === 'setup-status') {
  const { runOrganizationAuthoritySetupCli } = await product('composition/organization-authority-setup-cli.js');
  process.exitCode = await runOrganizationAuthoritySetupCli(['status', '--state-dir', state]);
} else throw new Error('unknown fixture command');
