// Connected, synthetic-only rehearsal. The AWS boundary executes the real host
// runner; the container boundary executes the real local runtime, never Docker.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { canonicalJson } from '@echo-brain/federation-protocol';
import Database from 'better-sqlite3';
import { planStagingRelease, executeStagingRelease } from '../../tools/authority-staging-release.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const COMMIT = 'a'.repeat(40);
const OLD = 'be71eef5d3678957ef5f086a2ed42baeeb548687';
const RESTORE = '2b2a1b25647e5bc0e3b58ed4d5e1bb8f461ad19a';
const INSTANCE = 'i-0123456789abcdef0';
const VOLUME = 'vol-0123456789abcdef0';
const STACK = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-authority-staging-v1/12345678-1234-1234-1234-123456789012';
const root = realpathSync(mkdtempSync('/tmp/echo-j-'));
const host = join(root, 'host');
const release = join(host, 'clean-data/release');
const runtimeFixture = join(import.meta.dirname, 'staging-journey-runtime.mjs');
const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
// No inherited credentials, proxy, Node preload, AWS profile, or provider vars.
const env = { PATH: [dirname(process.execPath), dirname(python), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), LANG: 'en_US.UTF-8', TMPDIR: root };
const digest = data => createHash('sha256').update(data).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value, mode = 0o600) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value) + '\n', { mode });
  chmodSync(path, mode);
};
const gitSource = (commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: REPO, env });
const readSource = (commit, path) => commit === COMMIT ? readFileSync(join(REPO, path)) : gitSource(commit, path);
const run = (file, args) => {
  const result = spawnSync(file, args, { cwd: REPO, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `${file} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
let runtime;
let runtimeError = '';
const start = async candidateId => {
  runtime = spawn(process.execPath, [runtimeFixture, 'serve', root, candidateId], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.stderr.on('data', chunk => { runtimeError = (runtimeError + chunk).slice(-10000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime readiness timeout: ' + runtimeError)), 15000);
    runtime.once('exit', code => { clearTimeout(timer); reject(new Error(`runtime exited ${code}: ${runtimeError}`)); });
    runtime.stdout.on('data', chunk => { if (chunk.toString().includes('ready\n')) { clearTimeout(timer); resolve(); } });
  });
};
const stop = async () => {
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    const child = runtime;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(timer); }
  }
  runtime = undefined;
};

try {
  chmodSync(root, 0o700);
  write(join(root, 'fixture-owner'), 'staging-journey-v1\n');
  const profile = { schema_version: 1, kind: 'echo-clean-v1-runtime-profile', source_sha: COMMIT, files: Object.fromEntries(['Caddyfile.clean-v1', 'Caddyfile.clean-v1.ec2', 'compose.clean-v1.ec2.yaml', 'compose.clean-v1.yaml'].map(name => [name, readFileSync(join(REPO, 'deploy/organization-authority', name), 'utf8')])) };
  const profileSha = digest(canonicalJson(profile) + '\n');
  const record = (id, digit) => ({ schema_version: 1, kind: 'echo-clean-v1-release', release_id: id, released_at: '2026-09-05T00:00:00Z', source_sha: COMMIT, baseline_compatibility_class: 'clean-v1', authority_image: { reference: `904560150024.dkr.ecr.us-west-2.amazonaws.com/echo/organization-authority@sha256:${digit.repeat(64)}` }, person_client: { package: '@echo-brain/person-client', version: '0.1.0-internal.1', artifact_url: 'https://rehearsal.invalid/client.tgz', artifact_sha256: 'c'.repeat(64) }, runtime_profile: { profile_version: 'clean-v1-profile-1', artifact_url: 'https://rehearsal.invalid/profile.json', artifact_sha256: profileSha } });
  const accepted = record('clean-v1-journey-accepted', 'd');
  const candidate = record('clean-v1-journey-candidate', 'e');
  write(join(root, 'accepted.json'), accepted);
  write(join(root, 'candidate.json'), candidate);
  write(join(root, 'profile.json'), profile);
  write(join(release, 'current.clean-v1.json'), accepted);
  write(join(release, 'runtime-profiles', accepted.release_id + '.profile'), profile);
  write(join(release, 'runtime-profile.active'), profile);
  const acceptedEnvironment = {
    ECHO_CLEAN_AUTHORITY_HOST: 'authority-staging.echobrain.org', ECHO_CLEAN_AUTHORITY_UID: '999', ECHO_CLEAN_AUTHORITY_GID: '988',
    ECHO_CLEAN_AUTHORITY_IMAGE: accepted.authority_image.reference, ECHO_CLEAN_RELEASE_ID: accepted.release_id,
    ECHO_CLEAN_RELEASE_SOURCE_SHA: COMMIT, ECHO_CLEAN_RUNTIME_PROFILE_SHA256: profileSha, ECHO_CLEAN_RUNTIME_PROFILE_VERSION: 'clean-v1-profile-1',
    PRIVATE_FIXTURE: 'synthetic-never-publish-value',
  };
  const acceptedEnv = Object.entries(acceptedEnvironment).map(([key, value]) => `${key}=${value}\n`).join('');
  write(join(release, 'runtime-environments', accepted.release_id + '.env'), acceptedEnv);
  write(join(host, '.env.clean-v1'), acceptedEnv + 'ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1=true\n');
  for (const name of ['update-clean-v1.sh', 'onboard-clean-v1.sh', 'restore-clean-v1-host.sh']) write(join(host, name), gitSource(name.startsWith('restore') ? RESTORE : OLD, 'deploy/organization-authority/' + name), 0o755);
  for (const name of ['clean-v1-release.py', 'clean-v1-runtime-profile.py']) write(join(host, 'release', name), readFileSync(join(REPO, 'deploy/release', name)), 0o755);
  assert.equal(digest(readFileSync(join(host, 'update-clean-v1.sh'))), 'db04aaacad63d71e6e74c3d90d1c521fc2f85f177013de8869eff0cbedd398d4');
  assert.equal(existsSync(join(host, 'backup-authority-maintenance.sh')), false);
  const materialized = join(root, 'materialized-profile');
  run(python, ['-B', join(host, 'release/clean-v1-runtime-profile.py'), 'materialize', join(root, 'profile.json'), materialized]);
  for (const name of Object.keys(profile.files)) write(join(host, name), readFileSync(join(materialized, name)), 0o644);
  write(join(root, 'fixture-engine.json'), { node: process.execPath, runtime_fixture: runtimeFixture, fetch_fixture: join(import.meta.dirname, 'staging-journey-fetch.mjs'), images: Object.fromEntries([accepted, candidate].map((item, index) => [item.authority_image.reference, { reference: item.authority_image.reference, source: COMMIT, id: 'sha256:' + String(index + 1).repeat(64) }])) });
  write(join(root, 'engine-state.json'), { running: true, environment: acceptedEnvironment });
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  write(join(root, 'bin/docker'), `#!/bin/sh\nexec ${quote(python)} ${quote(join(import.meta.dirname, 'staging-journey-docker.py'))} ${quote(root)} "$@"\n`, 0o755);
  run(process.execPath, [runtimeFixture, 'init', root]);
  const setup = run(process.execPath, [runtimeFixture, 'setup-status', root]);
  assert.equal(JSON.parse(setup).runtime_status, 'ready_to_start');
  await start(candidate.release_id);

  let output, failure, submissions = 0;
  const commands = new Map();
  const aws = args => {
    switch (args.slice(0, 2).join(' ')) {
      case 'sts get-caller-identity': return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
      case 'cloudformation describe-stacks': return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', EnableTerminationProtection: true, StackId: STACK, Outputs: [{ OutputKey: 'StagingHostInstanceId', OutputValue: INSTANCE }, { OutputKey: 'StagingDataVolumeId', OutputValue: VOLUME }, { OutputKey: 'StagingHostReady', OutputValue: 'true' }] }] };
      case 'ec2 describe-instances': return { Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: 'running' }, Tags: [{ Key: 'aws:cloudformation:stack-id', Value: STACK }, { Key: 'aws:cloudformation:logical-id', Value: 'StagingHost' }, { Key: 'Environment', Value: 'staging' }], BlockDeviceMappings: [{ Ebs: { VolumeId: VOLUME } }] }] }] };
      case 'ssm describe-instance-information': return { InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: 'Online' }] };
      case 'ssm send-command': {
        submissions++;
        const id = randomUUID();
        try { commands.set(id, run(python, ['-B', join(import.meta.dirname, 'staging-journey-host.py'), REPO, root, output])); }
        catch (error) { failure = error; throw error; }
        return { Command: { CommandId: id } };
      }
      case 'ssm get-command-invocation': return { Status: 'Success', StandardOutputContent: commands.get(args[args.indexOf('--command-id') + 1]) };
      default: throw new Error('unexpected simulated AWS call: ' + args.slice(0, 2).join(' '));
    }
  };
  const dependencies = { aws, readSource, runtime: () => COMMIT, now: () => 1788652800000 };
  let sequence = 0;
  const action = (name, options = {}) => {
    output = join(root, `operation-${++sequence}-${name}.json`);
    planStagingRelease({ action: name, acceptedRelease: join(root, 'accepted.json'), release: join(root, 'candidate.json'), runtimeProfile: join(root, 'profile.json'), output, ...options }, dependencies);
    const result = executeStagingRelease(output, dependencies);
    if (failure) throw failure;
    const sent = submissions;
    assert.deepEqual(executeStagingRelease(output, dependencies), result);
    assert.equal(submissions, sent, 'terminal receipt replay must not resubmit');
    process.stdout.write(`${name}: ${result.state} ${result.outcome?.code}\n`);
    return result;
  };
  const success = result => assert.equal(result.state, 'succeeded', JSON.stringify(result.outcome));
  const rows = (database, sql) => {
    const db = new Database(join(host, 'clean-data/state', database), { readonly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const noApproval = () => {
    assert.deepEqual(rows('integrations.sqlite', 'SELECT * FROM organization_private_approval_signed_action_receipts_v2'), []);
    assert.deepEqual(rows('integrations.sqlite', 'SELECT * FROM organization_private_approval_terminal_evidence_v2'), []);
    assert.deepEqual(rows('record-log.sqlite', 'SELECT * FROM organization_record_log'), []);
  };
  const noEngineCalls = () => existsSync(join(root, 'engine-calls.jsonl')) ? readFileSync(join(root, 'engine-calls.jsonl'), 'utf8') : '';
  const legacy = action('inspect-install');
  assert.equal(legacy.state, 'failed');
  assert.equal(legacy.outcome.diagnostic.inventory['backup-authority-maintenance.sh'].state, 'missing');
  success(action('inspect-install', { toolingMigration: 'legacy-staging-host-v1' }));
  // Expected backup absence must not hide a later unknown validator.
  const validator = join(host, 'release/clean-v1-release.py');
  const validatorBytes = readFileSync(validator);
  write(validator, 'unrecognized synthetic validator\n', 0o755);
  const refused = action('inspect-install', { toolingMigration: 'legacy-staging-host-v1' });
  assert.equal(refused.outcome.diagnostic.tool, 'release/clean-v1-release.py');
  assert.equal(action('install', { toolingMigration: 'legacy-staging-host-v1' }).state, 'failed');
  assert.equal(digest(readFileSync(join(host, 'update-clean-v1.sh'))), 'db04aaacad63d71e6e74c3d90d1c521fc2f85f177013de8869eff0cbedd398d4');
  write(validator, validatorBytes, 0o755);
  success(action('install', { toolingMigration: 'legacy-staging-host-v1' }));
  const installReceipt = read(output);
  const installEvidence = join(release, 'remote-operations', installReceipt.request.operation_id);
  assert.equal(read(join(installEvidence, 'tooling-before.json'))['backup-authority-maintenance.sh'], null);
  assert.equal(readFileSync(join(installEvidence, 'tool-3.absent'), 'utf8'), 'absent\n');
  assert.equal(noEngineCalls(), '', 'inspection/install must never invoke container actions');
  const drifted = readFileSync(join(host, '.env.clean-v1'), 'utf8');
  write(join(host, '.env.clean-v1'), drifted + 'UNRELATED_FIXTURE=changed\n');
  const ineligible = action('diagnose'); success(ineligible);
  assert.equal(ineligible.outcome.diagnostic.repair_eligible, false);
  assert.equal(action('repair').state, 'failed');
  assert.equal(noEngineCalls(), '', 'unknown drift must not start runtime repair');
  assert.equal(readFileSync(join(host, '.env.clean-v1'), 'utf8'), drifted + 'UNRELATED_FIXTURE=changed\n');
  write(join(host, '.env.clean-v1'), drifted);
  const diagnosis = action('diagnose'); success(diagnosis);
  assert.equal(diagnosis.outcome.diagnostic.repair_eligible, true);
  const manifestPath = join(host, 'clean-data/state/onboarding/clean-founder-v1.json');
  const savedManifest = join(root, 'saved-manifest.json');
  renameSync(manifestPath, savedManifest);
  assert.equal(JSON.parse(run(process.execPath, [runtimeFixture, 'setup-status', root])).runtime_status, 'not_ready');
  assert.equal(action('repair').state, 'failed', 'exit-zero not_ready setup must not complete runtime repair');
  assert.equal(existsSync(join(release, 'environment-repair.pending.json')), true);
  renameSync(savedManifest, manifestPath);
  success(action('repair'));
  assert.equal(readFileSync(join(host, '.env.clean-v1'), 'utf8'), acceptedEnv);
  success(action('stage', { contentTelemetry: 'true' }));
  const beforeFailure = read(join(root, 'provider-evidence.json'));
  write(join(root, 'provider-evidence.json'), { ...beforeFailure, publish_failures_remaining: 1 });
  const pending = action('canary');
  assert.equal(pending.state, 'failed');
  assert.equal(pending.outcome.code, 'delivery_pending');
  assert.equal(existsSync(join(release, 'canary-receipts', candidate.release_id + '.json')), false);
  const afterFailure = read(join(root, 'provider-evidence.json'));
  assert.equal(afterFailure.extraction_calls, 1);
  assert.equal(afterFailure.messages.length, 1);
  assert.deepEqual(afterFailure.messages[0].blocks, [], 'failed publication leaves only an inert marker');
  noApproval();
  await stop();
  await start(candidate.release_id);
  success(action('canary'));
  const receipt = read(join(release, 'canary-receipts', candidate.release_id + '.json'));
  assert.equal(receipt.approval_outcome, 'staged');
  assert.equal(receipt.release_id, candidate.release_id);
  // A fresh canary operation after a second runtime restart must observe the
  // durable delivery acknowledgment without re-extracting or posting again.
  await stop();
  await start(candidate.release_id);
  success(action('canary'));
  success(action('status'));
  assert.deepEqual(read(join(release, 'current.clean-v1.json')), accepted, 'must not promote');
  assert.deepEqual(read(join(release, 'candidate.clean-v1.json')), candidate);
  const providers = read(join(root, 'provider-evidence.json'));
  assert.equal(providers.messages.length, 1);
  assert.equal(providers.extraction_calls, 1);
  assert.deepEqual(providers.worker_errors, []);
  assert.ok(providers.messages[0].blocks.length > 0, 'real card publication required');
  const card = JSON.stringify(providers.messages[0].blocks);
  for (const label of ['Approve meeting', 'Reject', 'Only me', 'Team']) assert.ok(card.includes(label), 'missing human card control: ' + label);
  const outbox = rows('authority.sqlite', 'SELECT approval_id, state, provider_message_ts, frozen_card_sha256 FROM authority_live_approval_outbox_v2');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].state, 'staged');
  assert.equal(outbox[0].approval_id, receipt.approval_id);
  assert.equal(outbox[0].provider_message_ts, providers.messages[0].ts);
  const contracts = rows('integrations.sqlite', 'SELECT approval_id, dm_channel_id, provider_message_ts, card_sha256 FROM organization_private_approval_pending_contracts_v2');
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].approval_id, receipt.approval_id);
  assert.equal(contracts[0].dm_channel_id, providers.messages[0].channel);
  assert.equal(contracts[0].provider_message_ts, providers.messages[0].ts);
  assert.equal(contracts[0].card_sha256, outbox[0].frozen_card_sha256);
  noApproval();
  assert.equal(readFileSync(join(release, 'runtime-environments', accepted.release_id + '.env'), 'utf8'), acceptedEnv);
  assert.equal(existsSync(join(release, 'environment-repair.pending.json')), false);
  assert.equal(existsSync(join(host, '.staging-release-guard')), false);
  process.stdout.write(JSON.stringify({ result: 'awaiting_human_slack_approval', simulated_boundaries: ['AWS/SSM', 'container engine and identity', 'public TLS routing', 'OIDC/Granola/LLM/Slack HTTP'] }) + '\n');
} catch (error) {
  for (const name of ['wrapper-output.jsonl', 'provider-evidence.json', 'runtime-error.txt']) if (existsSync(join(root, name))) process.stderr.write(name + ':\n' + readFileSync(join(root, name), 'utf8').slice(-18000) + '\n');
  process.stderr.write(runtimeError);
  throw error;
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
