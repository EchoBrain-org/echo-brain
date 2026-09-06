// Synthetic fixture only. Real Authority/SQLite/canary/Slack adapter code,
// with deny-by-default external-provider responses. Never reads live state.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { openOrganizationControlDatabase } from '@echo-brain/organization-control-plane/slack-approval-integration-v1';

const REPO = resolve(import.meta.dirname, '../..');
const [mode, root, releaseId] = process.argv.slice(2);
assert.ok(root?.startsWith('/') && readFileSync(join(root, 'fixture-owner'), 'utf8') === 'staging-journey-v1\n');
const state = join(root, 'host/clean-data/state');
const metadataPath = join(root, 'fixture-runtime.json');
const evidencePath = join(root, 'provider-evidence.json');
const socket = join(root, 'canary.sock');
const NOW = '2026-09-06T00:00:00.000Z';
const ORIGIN = 'https://authority-staging.echobrain.org';
const OWNER = 'founder@example.test';
const SLACK = { workspace: 'T012JOURNEY', app: 'A012JOURNEY', bot: 'B012JOURNEY', botUser: 'U012BOT', owner: 'U012OWNER', dm: 'D012JOURNEY' };
const SCOPES = ['channels:history', 'channels:read', 'chat:write', 'im:history', 'im:write', 'reactions:read', 'users:read'];
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
  const { readPrivateAuthorityPersonSessionPkceKey } = await product('adapters/security/private-file-credentials.js');
  const { openAuthorityDatabase } = await product('adapters/persistence/sqlite/open-authority-database.js');
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

async function seedSlack(initialized, connectionId) {
  const { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2, buildExternalHumanIdentityLinkContractV2 } = await import(pathToFileURL(join(REPO, 'packages/organization-control-plane/dist/application/person-slack-reaction-approval-contracts-v2.js')));
  const coordinates = { authority_id: initialized.authority_id, organization_id: initialized.organization_id, state_lineage_id: initialized.state_lineage_id };
  const connection = buildOrganizationToolConnectionContractV2({ ...coordinates, connection_id: connectionId, provider_issuer: 'https://slack.com', provider_tenant_kind: 'workspace', provider_tenant_id: SLACK.workspace, provider_enterprise_id: null, tool_kind: 'slack', provider_app_id: SLACK.app, provider_bot_id: SLACK.bot, provider_bot_user_id: SLACK.botUser, required_provider_scopes: SCOPES, public_connection_configuration_sha256: canonicalSha256({ fixture: true }) });
  const connectionSha = canonicalSha256(connection);
  const current = buildOrganizationToolConnectionStateV2({ connection_id: connectionId, connection_contract_sha256: connectionSha, connection_status: 'active', credential_reference_sha256: canonicalSha256({ fixture: 'token' }), observed_granted_scopes: SCOPES, verification_event_id: 'verify_journey', verification_evidence_sha256: canonicalSha256({ fixture: 'verified' }), verification_revision: 1, verified_at: NOW });
  const link = buildExternalHumanIdentityLinkContractV2({ ...coordinates, external_identity_link_id: 'clm_journey', provider_issuer: 'https://slack.com', provider_tenant_kind: 'workspace', provider_tenant_id: SLACK.workspace, provider_enterprise_id: null, provider_subject_id: SLACK.owner, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id, membership_type: 'owner', verification_event_id: 'verify_owner', verification_evidence_sha256: canonicalSha256({ fixture: 'owner' }), verified_at: NOW });
  const linkSha = canonicalSha256(link);
  const db = openOrganizationControlDatabase(join(state, 'integrations.sqlite'), { fileMustExist: true });
  try {
    db.prepare('INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?, ?)').run(connectionId, canonicalJson(connection), connectionSha, NOW);
    db.prepare("INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, 'active', ?)").run(connectionId, connectionSha, canonicalJson(current), canonicalSha256(current), NOW);
    db.prepare('INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)').run(link.external_identity_link_id, linkSha, canonicalJson(link), NOW);
    db.prepare("INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)").run(link.external_identity_link_id, linkSha, link.provider_issuer, link.provider_tenant_kind, link.provider_tenant_id, null, link.provider_subject_id, link.principal_id, link.membership_id, NOW);
  } finally { db.close(); }
}

if (mode === 'init') {
  const { bootstrapOrganizationAuthorityState } = await product('composition/organization-authority-state-bootstrap.js');
  const initialized = bootstrapOrganizationAuthorityState({ state_directory: state, organization_display_name: 'Synthetic staging rehearsal', owner_display_name: 'Synthetic founder', created_at: NOW, creating_artifact_revision: 'staging-journey-fixture' });
  const owner = await seedOwner(initialized);
  const granola = write(join(root, 'granola.fixture'), `grn_${'a'.repeat(32)}`);
  const email = write(join(root, 'owner.fixture'), OWNER);
  const llm = write(join(root, 'llm.fixture'), 'synthetic-not-a-provider-credential-000000');
  const signing = write(join(root, 'slack.fixture'), 'synthetic-not-a-signing-secret-00000000');
  const connectionId = `con_${randomUUID()}`;
  const { admitGranolaMeetingSource } = await product('composition/providers/granola/granola-meeting-source-admission.js');
  const { createOpenRouterDecisionProcessorAdmissionCommitmentV1 } = await product('composition/providers/openrouter/openrouter-decision-processor-admission-commitment.js');
  const admitted = await admitGranolaMeetingSource({ state_directory: state, source_instance_id: 'founder-granola-v1', granola_credential_reference: `file:${granola}`, granola_owner_email_reference: `file:${email}`, processor: createOpenRouterDecisionProcessorAdmissionCommitmentV1({ instance_id: 'founder-llm-v1', credential_reference: `file:${llm}` }), create_granola_record_owner_client: () => ({ async listNotes() { return { notes: [{ id: 'fixture', owner: { email: OWNER } }], hasMore: false, cursor: null }; } }), now: () => NOW });
  await seedSlack(initialized, connectionId);
  const oidcPath = write(join(root, 'oidc.json'), { ...OIDC, client_authentication: 'none' });
  const manifest = { schema_version: 1, kind: 'echo-clean-founder-onboarding-manifest-v1', state_directory: state, created_at: NOW, artifact_revision: 'staging-journey-fixture', authority_url: ORIGIN, oidc_config_path: oidcPath, pkce_key_file: owner.pkce_key_file, invitation_path: owner.invitationPath, slack_approval_channel_id: 'C012JOURNEY', slack_connection_id: connectionId, authority_id: initialized.authority_id, organization_id: initialized.organization_id, state_lineage_id: initialized.state_lineage_id, owner_principal_id: initialized.owner_principal_id, owner_membership_id: initialized.owner_membership_id, granola_credential_file: granola, granola_owner_email_file: email, llm_credential_file: llm, setup_seed: { ...Object.fromEntries(['authority_id', 'organization_id', 'state_lineage_id', 'owner_principal_id', 'owner_membership_id', 'control_plane_id'].map(key => [key, initialized[key]])), slack_connection_id: connectionId }, owner_email: OWNER, organization_name: 'Synthetic staging rehearsal', owner_display_name: 'Synthetic founder' };
  mkdirSync(join(state, 'onboarding'), { recursive: true, mode: 0o700 });
  write(join(state, 'onboarding/clean-founder-v1.json'), manifest);
  // Explicit canary calls drive this test. Keep periodic provider retries out
  // of its fault-injection window even on a slow CI host.
  write(metadataPath, { initialized, admitted, config: { state_directory: state, host: '127.0.0.1', port: await port(), authority_url: ORIGIN, oidc: OIDC, client_authentication: { method: 'none' }, pkce_key_file: owner.pkce_key_file, slack_signing_secret_file: signing, slack_connection_id: connectionId, slack_identity_link_channel_id: 'C012JOURNEY', granola_credential_file: granola, granola_owner_email_file: email, openrouter_credential_file: llm, worker_interval_ms: 3_600_000 } });
  write(evidencePath, { extraction_calls: 0, source_pulls: 0, requests: [], messages: [], publish_failures_remaining: 0, worker_errors: [] });
} else if (mode === 'serve') {
  const metadata = read(metadataPath);
  const { PrivateSlackApprovalCardPosterV1 } = await product('processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js');
  const fetchImpl = async (url, options) => {
    assert.ok(String(url).startsWith('https://slack.com/api/'));
    const method = new URL(url).pathname.split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url).searchParams);
    const evidence = read(evidencePath);
    evidence.requests.push({ method, body });
    let response;
    if (method === 'conversations.open') {
      assert.equal(body.users, SLACK.owner);
      response = { ok: true, channel: { id: SLACK.dm, is_im: true, user: SLACK.owner } };
    } else if (method === 'chat.postMessage') {
      assert.equal(body.channel, SLACK.dm);
      assert.deepEqual(body.blocks, []);
      const ts = `1788652800.${String(evidence.messages.length + 1).padStart(6, '0')}`;
      evidence.messages.push({ ...body, ts, bot_id: SLACK.bot });
      response = { ok: true, channel: SLACK.dm, ts };
    } else if (method === 'chat.update') {
      assert.equal(body.channel, SLACK.dm);
      const message = evidence.messages.find(message => message.ts === body.ts);
      assert.ok(message);
      if (evidence.publish_failures_remaining > 0) {
        evidence.publish_failures_remaining--;
        response = { ok: false, error: 'service_unavailable' };
      } else {
        Object.assign(message, body);
        response = { ok: true, channel: SLACK.dm, ts: body.ts, message: body };
      }
    } else if (method === 'auth.test') {
      response = { ok: true, team_id: SLACK.workspace, enterprise_id: null, user_id: SLACK.botUser, bot_id: SLACK.bot };
    } else if (method === 'bots.info') {
      response = { ok: true, bot: { id: SLACK.bot, app_id: SLACK.app, user_id: SLACK.botUser, deleted: false } };
    } else if (method === 'conversations.history') {
      assert.equal(body.channel, SLACK.dm);
      response = { ok: true, messages: evidence.messages, has_more: false };
    } else throw new Error(`unexpected simulated Slack method: ${method}`);
    write(evidencePath, evidence);
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': SCOPES.join(',') } });
  };
  const identity = { kind: 'decision-processor', adapter_id: 'llm', instance_id: metadata.admitted.processor.instance_id, version: metadata.admitted.processor.version };
  const processor = { identity, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: NOW }), async extract(meeting) {
    const evidence = read(evidencePath); evidence.extraction_calls++; write(evidencePath, evidence);
    return { schema_version: 1, meeting_id: meeting.id, meeting_revision: meeting.provenance.canonical_revision, processor: identity, generated_at: NOW, signals: [{ id: 'fixture-decision', kind: 'decision', status: 'decided', text: 'Rehearse the exact candidate and await human approval.', subject: 'staging', confidence: 1, evidence: [{ meeting_id: meeting.id, block_id: 'synthetic-decision' }] }] };
  } };
  const source = { identity: { kind: 'meeting-source', adapter_id: 'granola', instance_id: metadata.admitted.source.instance_id, version: metadata.admitted.source.version }, validateConfig: () => ({ ok: true, errors: [] }), healthCheck: async () => ({ status: 'healthy', checked_at: NOW }), async pull(request) { const evidence = read(evidencePath); evidence.source_pulls++; write(evidencePath, evidence); return { meetings: [], next_cursor: request.cursor }; } };
  const { openOrganizationAuthorityService } = await product('composition/organization-authority-composition-root.js');
  const runtime = await openOrganizationAuthorityService({ ...metadata.config, on_worker_error(error) { const evidence = read(evidencePath); evidence.worker_errors.push(error.message); write(evidencePath, evidence); } }, { processing_adapter_overrides: { source, processor, private_approval_card_poster: new PrivateSlackApprovalCardPosterV1('synthetic-provider-token', { fetchImpl }) } });
  assert.equal(runtime.processing, 'active');
  const { openStagingSyntheticPrivateDmCanaryControlV1 } = await product('composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-control-v1.js');
  const observedRuntime = { ...runtime, async run_staging_synthetic_private_dm_canary(...args) {
    try { return await runtime.run_staging_synthetic_private_dm_canary(...args); }
    catch (error) { write(join(root, 'runtime-error.txt'), String(error.stack)); throw error; }
  } };
  const control = await openStagingSyntheticPrivateDmCanaryControlV1({ authority_url: ORIGIN, authority_host: 'authority-staging.echobrain.org', release_id: releaseId, owner_email: OWNER, runtime: observedRuntime, socket_path: socket, now: () => NOW });
  process.stdout.write('ready\n');
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await control.close(); await runtime.close();
} else if (mode === 'client') {
  const { requestStagingSyntheticPrivateDmCanaryV1 } = await product('composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-client-v1.js');
  process.stdout.write(JSON.stringify(await requestStagingSyntheticPrivateDmCanaryV1({ release_id: releaseId, socket_path: socket })) + '\n');
} else if (mode === 'verify') {
  const { verifyAuthorityStateLineage } = await product('composition/verify-authority-state-lineage.js');
  const { verifyPersistedOpenRouterDecisionProcessorAdmissionV1 } = await product('composition/providers/openrouter/verify-openrouter-decision-processor-admission-v1.js');
  verifyAuthorityStateLineage(state); verifyPersistedOpenRouterDecisionProcessorAdmissionV1(state);
} else if (mode === 'setup-status') {
  const { runOrganizationAuthoritySetupCli } = await product('composition/organization-authority-setup-cli.js');
  process.exitCode = await runOrganizationAuthoritySetupCli(['status', '--state-dir', state]);
} else throw new Error('unknown fixture command');
