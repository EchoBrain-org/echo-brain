import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { executeStagingRelease, planStagingRelease, releaseAction, releaseSsmParameters, safeReleaseOutcome, stagingReleaseTarget, validateReleaseRequest } from '../../tools/authority-staging-release.mjs';
import type { StagingReleasePlanOptions, StagingReleaseRequest } from '../../tools/authority-staging-release.mjs';

const temporary: string[] = [];
const REPO = resolve(import.meta.dirname, '../..');
const COMMIT = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const INSTANCE = 'i-0123456789abcdef0';
const VOLUME = 'vol-0123456789abcdef0';
const STACK = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-authority-staging-v1/12345678-1234-1234-1234-123456789012';
const COMMAND = '11111111-1111-4111-8111-111111111111';
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function write(path: string, value: any) { writeFileSync(path, canonical(value) + '\n', { mode: 0o600 }); }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-staging-release-test-'));
  chmodSync(directory, 0o700);
  temporary.push(directory);
  const profile = { schema_version: 1, kind: 'echo-clean-v1-runtime-profile', source_sha: COMMIT, files: Object.fromEntries(['Caddyfile.clean-v1', 'Caddyfile.clean-v1.ec2', 'compose.clean-v1.ec2.yaml', 'compose.clean-v1.yaml'].map(name => [name, readFileSync(join(REPO, 'deploy/organization-authority', name), 'utf8')])) };
  const record = (id: string) => ({ schema_version: 1, kind: 'echo-clean-v1-release', release_id: id, released_at: '2026-09-05T00:00:00Z', source_sha: COMMIT, baseline_compatibility_class: 'clean-v1', authority_image: { reference: `904560150024.dkr.ecr.us-west-2.amazonaws.com/echo/organization-authority@sha256:${'d'.repeat(64)}` }, person_client: { package: '@echo-brain/person-client', version: '0.1.0-internal.1', artifact_url: 'https://rehearsal.invalid/client.tgz', artifact_sha256: 'c'.repeat(64) }, runtime_profile: { profile_version: 'clean-v1-profile-1', artifact_url: 'https://rehearsal.invalid/profile.json', artifact_sha256: digest(canonical(profile) + '\n') } });
  const options: StagingReleasePlanOptions = { action: 'diagnose', acceptedRelease: join(directory, 'accepted.json'), release: join(directory, 'candidate.json'), runtimeProfile: join(directory, 'profile.json'), output: join(directory, 'operation.json'), previousToolingSource: OLD };
  write(options.acceptedRelease, record('clean-v1-accepted-test'));
  write(options.release, record('clean-v1-candidate-test'));
  write(options.runtimeProfile, profile);
  const calls: string[][] = [];
  const state = { sendLost: false, invocationPending: false, failure: false, targetChanged: false, targetAccount: '904560150024', tagEnvironment: 'staging', outputOverride: null as string | null, submissions: 0 };
  const request = () => JSON.parse(readFileSync(options.output, 'utf8')).request;
  const outcome = () => {
    const receipt = JSON.parse(readFileSync(options.output, 'utf8'));
    const inspection = receipt.request.action === 'inspect-install';
    return { schema_version: 1, kind: 'echo-staging-release-host-result-v1', operation_id: receipt.request.operation_id, request_sha256: receipt.request_sha256, action: receipt.request.action, ok: true, code: inspection ? 'inspection_verified' : 'verified', diagnostic: inspection ? { schema_version: 1, kind: 'echo-staging-release-install-inspection-v1', category: 'ready', tool: null } : receipt.request.action === 'diagnose' ? { schema_version: 1, kind: 'echo-clean-v1-environment-drift', release_id: receipt.request.accepted.release_id, candidate_staged: false, environment_matches: false, changed_settings: ['ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1'], other_bytes_changed: false, allowlisted_settings_valid: true, environment_format_supported: true, repair_pending: false, repair_eligible: true, runtime_checked: false } : null };
  };
  const aws = (args: string[]) => {
    calls.push(args);
    switch (args.slice(0, 2).join(' ')) {
      case 'sts get-caller-identity': return { Account: state.targetAccount, Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
      case 'cloudformation describe-stacks': return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', EnableTerminationProtection: true, StackId: STACK, Outputs: [{ OutputKey: 'StagingHostInstanceId', OutputValue: state.targetChanged ? 'i-1123456789abcdef0' : INSTANCE }, { OutputKey: 'StagingDataVolumeId', OutputValue: VOLUME }, { OutputKey: 'StagingHostReady', OutputValue: 'true' }] }] };
      case 'ec2 describe-instances': return { Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: 'running' }, Tags: [{ Key: 'aws:cloudformation:stack-id', Value: STACK }, { Key: 'aws:cloudformation:logical-id', Value: 'StagingHost' }, { Key: 'Environment', Value: state.tagEnvironment }], BlockDeviceMappings: [{ Ebs: { VolumeId: VOLUME } }] }] }] };
      case 'ssm describe-instance-information': return { InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: 'Online' }] };
      case 'ssm send-command': state.submissions++; if (state.sendLost) throw new Error('sensitive AWS stderr'); return { Command: { CommandId: COMMAND } };
      case 'ssm list-commands': return { Commands: state.submissions ? [{ CommandId: COMMAND, Comment: `echo-release:${request().operation_id}`, DocumentName: 'AWS-RunShellScript', InstanceIds: [INSTANCE] }] : [] };
      case 'ssm get-command-invocation': if (state.invocationPending) throw new Error('InvocationDoesNotExist'); return { Status: state.failure ? 'TimedOut' : 'Success', StandardOutputContent: state.outputOverride ?? JSON.stringify(outcome()) };
      default: throw new Error(`Unexpected AWS operation: ${args.slice(0, 2).join(' ')}`);
    }
  };
  const reviewedLegacy = new Set(['be71eef5d3678957ef5f086a2ed42baeeb548687', '2b2a1b25647e5bc0e3b58ed4d5e1bb8f461ad19a']);
  const readSource = (commit: string, path: string) => reviewedLegacy.has(commit)
    ? execFileSync('git', ['-C', REPO, 'show', `${commit}:${path}`])
    : commit === OLD && path !== 'tools/authority-staging-release-host.py'
      ? Buffer.from(`old-reviewed-tool:${path}\n`)
      : readFileSync(join(REPO, path));
  const dependencies = { aws, readSource, runtime: () => COMMIT, now: () => 1788640000000 };
  return { directory, options, calls, state, request, outcome, dependencies };
}

afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function inventoryOutcome(f: ReturnType<typeof fixture>): any {
  const request = f.request();
  return { ...f.outcome(), diagnostic: { schema_version: 2, kind: 'echo-staging-release-install-inspection-v2', category: 'ready', tool: null, inventory: Object.fromEntries(Object.entries(request.old_tool_hashes).map(([name, sha256]) => [name, { state: 'old', sha256 }])) } };
}

describe('bounded staging release operator', () => {
  it('exposes validated protocol results without losing their types', () => {
    expectTypeOf<ReturnType<typeof stagingReleaseTarget>>().not.toBeAny();
    expectTypeOf<ReturnType<typeof validateReleaseRequest>>().not.toBeAny();
    expectTypeOf<ReturnType<typeof planStagingRelease>>().not.toBeAny();
    expectTypeOf<ReturnType<typeof executeStagingRelease>>().not.toBeAny();
    expectTypeOf<ReturnType<typeof safeReleaseOutcome>>().not.toBeAny();
    type Paths = Pick<StagingReleasePlanOptions, 'acceptedRelease' | 'release' | 'runtimeProfile' | 'output'>;
    expectTypeOf<Paths & { action: 'promote' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'status'; approval: string }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'status'; contentTelemetry: 'true' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'promote'; approval: string }>().toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'stage'; contentTelemetry: 'true' }>().toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'install' | 'inspect-install' }>().toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'install' | 'inspect-install'; toolingMigration: 'legacy-staging-host-v1' }>().toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'install'; toolingMigration: 'anything-else' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'status'; toolingMigration: 'legacy-staging-host-v1' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'stage'; toolingMigration: 'legacy-staging-host-v1' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    expectTypeOf<Paths & { action: 'promote'; approval: string; toolingMigration: 'legacy-staging-host-v1' }>().not.toMatchTypeOf<StagingReleasePlanOptions>();
    type MigrationRequest = Extract<StagingReleaseRequest, { schema_version: 3 }>;
    expectTypeOf<MigrationRequest>().not.toBeNever();
    expectTypeOf<MigrationRequest['action']>().toEqualTypeOf<'install' | 'inspect-install'>();
    expectTypeOf<MigrationRequest['kind']>().toEqualTypeOf<'echo-staging-release-request-v3'>();
    expectTypeOf<MigrationRequest['tooling_migration']>().toEqualTypeOf<'legacy-staging-host-v1'>();
    expectTypeOf<MigrationRequest['approval']>().toBeNull();
    expectTypeOf<MigrationRequest['content_telemetry']>().toBeNull();
    expectTypeOf<Omit<MigrationRequest, 'tooling_migration'>>().not.toMatchTypeOf<StagingReleaseRequest>();
    expectTypeOf<Omit<MigrationRequest, 'action'> & { action: 'diagnose' }>().not.toMatchTypeOf<StagingReleaseRequest>();
    expectTypeOf<Extract<StagingReleaseRequest, { schema_version: 1 | 2 }> & { tooling_migration: 'legacy-staging-host-v1' }>().not.toMatchTypeOf<StagingReleaseRequest>();
  });

  it('does not accept arbitrary commands or a production operation', () => {
    expect(() => releaseAction('shell')).toThrow('action_invalid');
    expect(() => releaseAction('onboard')).toThrow('action_invalid');
    expect(releaseAction('diagnose')).toBe('diagnose');
    expect(releaseAction('inspect-install')).toBe('inspect-install');
  });

  it('requires a validated request before rendering any remote command', () => {
    expect(() => releaseSsmParameters({ action: 'status' })).toThrow();
  });

  it('plans without sending commands and transports only exact source artifacts under the size limit', () => {
    const f = fixture();
    expect(planStagingRelease(f.options, f.dependencies).state).toBe('planned');
    expect(f.state.submissions).toBe(0);
    const parameters = releaseSsmParameters(f.request(), f.dependencies.readSource);
    expect(Buffer.byteLength(JSON.stringify(parameters))).toBeLessThan(60 * 1024);
    expect(parameters.executionTimeout).toEqual(['1200']);
    expect(parameters.commands).toHaveLength(1);
    expect(f.calls.every(args => !['s3api', 'iam', 'secretsmanager'].includes(args[0]))).toBe(true);
  });

  it('uses a new request version only for the exact named install migration', () => {
    const f = fixture();
    // @ts-expect-error Untrusted JS/CLI callers still require action validation.
    expect(() => planStagingRelease({ ...f.options, action: 'status', toolingMigration: 'legacy-staging-host-v1' }, f.dependencies)).toThrow('tooling_migration_invalid');
    // @ts-expect-error Untrusted JS/CLI callers still require migration-name validation.
    expect(() => planStagingRelease({ ...f.options, action: 'install', toolingMigration: 'anything-else' }, f.dependencies)).toThrow('tooling_migration_invalid');
    planStagingRelease({ ...f.options, action: 'install', toolingMigration: 'legacy-staging-host-v1' }, f.dependencies);
    const request = validateReleaseRequest(f.request(), f.dependencies.readSource);
    if (request.schema_version !== 3) throw new Error('Expected the named migration to produce a V3 request');
    expect(request).toMatchObject({
      schema_version: 3,
      kind: 'echo-staging-release-request-v3',
      action: 'install',
      tooling_migration: 'legacy-staging-host-v1',
    });
    expect(request.old_tool_hashes).toMatchObject({
      'update-clean-v1.sh': 'db04aaacad63d71e6e74c3d90d1c521fc2f85f177013de8869eff0cbedd398d4',
      'onboard-clean-v1.sh': '23b19666f5a85446dc50bc989f42dbd72ceafbedd6f294f13d7077220e9a036c',
      'restore-clean-v1-host.sh': '4de16f689929ae4310cd7ff0f29b01e59cd577b652ea33b100397789dd13b583',
      'release/clean-v1-release.py': 'fa72418c3daef1da8436f1a3963085d61f40ef4635f618c52be87d368eaacff6',
      'release/clean-v1-runtime-profile.py': '83f5f96b6a330fc30eda56ffe25bfe4a074952e170147dacbe431644873b7072',
    });
    expect(request.old_tool_hashes['backup-authority-maintenance.sh']).toBe(request.files['backup-authority-maintenance.sh'].sha256);
    expect(Buffer.byteLength(JSON.stringify(releaseSsmParameters(request, f.dependencies.readSource)))).toBeLessThan(60 * 1024);
  });

  it.each(['shell', 'onboard', 'restore', 'down'])('rejects unsupported action %s before AWS', action => {
    const f = fixture();
    // @ts-expect-error Untrusted JS/CLI callers still require runtime rejection.
    expect(() => planStagingRelease({ ...f.options, action }, f.dependencies)).toThrow('action_invalid');
    expect(f.calls).toHaveLength(0);
  });

  it('executes and replays a migration inspection with explicit backup absence', () => {
    const f = fixture();
    planStagingRelease({ ...f.options, action: 'inspect-install', toolingMigration: 'legacy-staging-host-v1' }, f.dependencies);
    const result = inventoryOutcome(f);
    for (const [name, entry] of Object.entries(result.diagnostic.inventory) as [string, any][]) {
      if (entry.sha256 === f.request().files[name].sha256) entry.state = 'new';
    }
    result.diagnostic.inventory['backup-authority-maintenance.sh'] = { state: 'missing', sha256: null };
    f.state.outputOverride = JSON.stringify(result);
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(f.state.submissions).toBe(1);
    result.diagnostic.inventory['release/clean-v1-release.py'] = { state: 'unknown', sha256: '0'.repeat(64) };
    expect(() => safeReleaseOutcome(JSON.stringify(result), f.request(), result.request_sha256)).toThrow('remote_outcome_unproven');
    result.ok = false; result.code = 'inspection_refused';
    result.diagnostic.category = 'tool_hash_unknown'; result.diagnostic.tool = 'release/clean-v1-release.py';
    expect(safeReleaseOutcome(JSON.stringify(result), f.request(), result.request_sha256)).toEqual(result);
  });

  it('requires an Identity Center role in the exact account', () => {
    const f = fixture();
    f.state.targetAccount = '123456789012';
    expect(() => stagingReleaseTarget(f.dependencies.aws)).toThrow('echo_prod_sso_required');
    expect(f.calls).toHaveLength(1);
  });

  it('rejects an instance carrying a production tag', () => {
    const f = fixture(); f.state.tagEnvironment = 'production';
    expect(() => planStagingRelease(f.options, f.dependencies)).toThrow('staging_instance_binding_mismatch');
    expect(f.state.submissions).toBe(0);
  });

  it('re-resolves the live target immediately before sending', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    f.state.targetChanged = true;
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow();
    expect(f.state.submissions).toBe(0);
  });

  it('requires the exact reviewed runtime and unexpired plan', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    expect(() => executeStagingRelease(f.options.output, { ...f.dependencies, runtime: () => OLD })).toThrow('exact_reviewed_runtime_required');
    expect(() => executeStagingRelease(f.options.output, { ...f.dependencies, now: () => 1788642000000 })).toThrow('plan_expired');
    expect(f.state.submissions).toBe(0);
  });

  it('refuses modified tooling even when its supplied hash is recomputed', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    const request = f.request();
    request.files['update-clean-v1.sh'] = { base64: Buffer.from('arbitrary shell').toString('base64'), sha256: digest('arbitrary shell') };
    expect(() => validateReleaseRequest(request, f.dependencies.readSource)).toThrow('tooling_source_mismatch');
  });

  it('refuses a release URL containing credential-like query metadata', () => {
    const f = fixture();
    const release = JSON.parse(readFileSync(f.options.release, 'utf8'));
    release.person_client.artifact_url += '?token=must-not-leak'; write(f.options.release, release);
    expect(() => planStagingRelease(f.options, f.dependencies)).toThrow('release_url_not_public_metadata');
  });

  it('does not permit symlink or permissive receipt files', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    chmodSync(f.options.output, 0o644);
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow('private_file_required');
    const link = join(f.directory, 'link.json'); symlinkSync(f.options.output, link);
    expect(() => executeStagingRelease(link, f.dependencies)).toThrow('private_file_required');
  });

  it('submits once and returns the same verified outcome on repeated execute', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(executeStagingRelease(f.options.output, f.dependencies).outcome?.diagnostic).toMatchObject({ repair_eligible: true });
    expect(f.state.submissions).toBe(1);
  });

  it('reconciles a lost SendCommand response without ever sending twice', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies); f.state.sendLost = true;
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('submitting');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(f.state.submissions).toBe(1);
  });

  it('treats eventual-consistency misses and timeouts as unconfirmed, not permission to retry', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies); f.state.invocationPending = true;
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('submitted');
    f.state.invocationPending = false; f.state.failure = true;
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('unconfirmed');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('unconfirmed');
    expect(f.state.submissions).toBe(1);
  });

  it.each(['extra-key', 'wrong-hash', 'unknown-setting', 'free-text-error'])('rejects remote output with %s', kind => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    const result: any = f.outcome();
    if (kind === 'extra-key') result.secret = 'must-not-leak';
    if (kind === 'wrong-hash') result.request_sha256 = 'f'.repeat(64);
    if (kind === 'unknown-setting') result.diagnostic.changed_settings = ['PRIVATE_SETTING_NAME'];
    if (kind === 'free-text-error') result.code = 'must-not-leak';
    f.state.outputOverride = JSON.stringify(result);
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow();
    expect(readFileSync(f.options.output, 'utf8')).not.toContain('must-not-leak');
  });

  it.each(['arbitrary-category', 'inconsistent-success', 'unknown-tool', 'non-string-tool'])('rejects arbitrary or inconsistent install diagnostics: %s', kind => {
    const f = fixture(); planStagingRelease({ ...f.options, action: 'inspect-install' }, f.dependencies);
    const result: any = f.outcome();
    if (kind === 'arbitrary-category') result.diagnostic.category = 'must-not-leak';
    if (kind === 'inconsistent-success') { result.ok = false; result.code = 'inspection_refused'; }
    if (kind === 'unknown-tool') { result.ok = false; result.code = 'inspection_refused'; result.diagnostic.category = 'tool_missing'; result.diagnostic.tool = 'private/path'; }
    if (kind === 'non-string-tool') { result.ok = false; result.code = 'inspection_refused'; result.diagnostic.category = 'tool_missing'; result.diagnostic.tool = ['update-clean-v1.sh']; }
    f.state.outputOverride = JSON.stringify(result);
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow('remote_outcome_unproven');
    expect(readFileSync(f.options.output, 'utf8')).not.toContain('must-not-leak');
    expect(readFileSync(f.options.output, 'utf8')).not.toContain('private/path');
  });

  it('accepts every host inspection category with exact success and tool bindings', () => {
    const f = fixture(); planStagingRelease({ ...f.options, action: 'inspect-install' }, f.dependencies);
    const receipt = JSON.parse(readFileSync(f.options.output, 'utf8'));
    const host = readFileSync(join(REPO, 'tools/authority-staging-release-host.py'), 'utf8');
    const categories = [...host.match(/^INSPECTION_CATEGORIES = \((.*)\)$/m)![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(categories).toContain('ready');
    for (const category of categories) {
      const result: any = f.outcome();
      result.ok = category === 'ready';
      result.code = result.ok ? 'inspection_verified' : 'inspection_refused';
      result.diagnostic.category = category;
      result.diagnostic.tool = ['tool_missing', 'tool_file_invalid', 'tool_hash_unknown'].includes(category) ? 'update-clean-v1.sh' : null;
      expect(safeReleaseOutcome(JSON.stringify(result), receipt.request, receipt.request_sha256)).toEqual(result);
    }
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(f.state.submissions).toBe(1);
  });

  it('persists installation-phase failures without retrying or accepting them for inspection', () => {
    const f = fixture(); planStagingRelease({ ...f.options, action: 'install' }, f.dependencies);
    const receipt = JSON.parse(readFileSync(f.options.output, 'utf8'));
    const result = { ...f.outcome(), ok: false, code: 'installation_failed' };
    f.state.outputOverride = JSON.stringify(result);
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('failed');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('failed');
    expect(f.state.submissions).toBe(1);
    expect(() => safeReleaseOutcome(JSON.stringify({ ...result, action: 'inspect-install' }), { ...receipt.request, action: 'inspect-install' }, receipt.request_sha256)).toThrow('remote_outcome_unproven');
  });

  it.each(['ready', 'unknown', 'early-refusal', 'repair-pending'])('persists complete versioned inventory without resubmission: %s', kind => {
    const f = fixture(); planStagingRelease({ ...f.options, action: 'inspect-install' }, f.dependencies);
    const result = inventoryOutcome(f);
    const names = Object.keys(result.diagnostic.inventory);
    if (kind !== 'early-refusal') result.diagnostic.inventory[names[1]] = { state: 'new', sha256: f.request().files[names[1]].sha256 };
    if (kind !== 'ready') {
      result.ok = false; result.code = 'inspection_refused';
      if (kind === 'unknown') {
        result.diagnostic.category = 'tool_hash_unknown'; result.diagnostic.tool = 'update-clean-v1.sh';
        result.diagnostic.inventory['update-clean-v1.sh'] = { state: 'unknown', sha256: '0'.repeat(64) };
      } else if (kind === 'early-refusal') {
        result.diagnostic.category = 'identity_invalid'; result.diagnostic.inventory = null;
      } else result.diagnostic.category = 'repair_pending';
    }
    f.state.outputOverride = JSON.stringify(result);
    const state = result.ok ? 'succeeded' : 'failed';
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe(state);
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe(state);
    expect(f.state.submissions).toBe(1);
    expect(JSON.parse(readFileSync(f.options.output, 'utf8')).outcome).toEqual(result);
  });

  it.each(['missing-entry', 'extra-entry', 'extra-field', 'bad-digest', 'array-digest', 'upper-digest', 'trailing-newline', 'unknown-state', 'wrong-old', 'wrong-new', 'known-as-unknown', 'missing-with-digest', 'null-ready', 'unknown-ready', 'wrong-tool', 'earlier-refusal', 'inventory-before-guards'])('rejects malformed or contradictory inventory: %s', kind => {
    const f = fixture(); planStagingRelease({ ...f.options, action: 'inspect-install' }, f.dependencies);
    const result = inventoryOutcome(f);
    const inventory = result.diagnostic.inventory;
    const tool = 'update-clean-v1.sh';
    if (kind === 'missing-entry') delete inventory[tool];
    if (kind === 'extra-entry') inventory['private/path'] = { state: 'old', sha256: '0'.repeat(64) };
    if (kind === 'extra-field') inventory[tool].content = 'must-not-leak';
    if (kind === 'bad-digest') inventory[tool].sha256 = 'must-not-leak';
    if (kind === 'array-digest') inventory[tool].sha256 = [inventory[tool].sha256];
    if (kind === 'upper-digest') inventory[tool].sha256 = inventory[tool].sha256.toUpperCase();
    if (kind === 'trailing-newline') {
      result.ok = false; result.code = 'inspection_refused'; result.diagnostic.category = 'tool_hash_unknown'; result.diagnostic.tool = tool;
      inventory[tool] = { state: 'unknown', sha256: '0'.repeat(64) + '\n' };
    }
    if (kind === 'unknown-state') inventory[tool].state = 'must-not-leak';
    if (kind === 'wrong-old') inventory[tool].sha256 = '0'.repeat(64);
    if (kind === 'wrong-new') inventory[tool].state = 'new';
    if (kind === 'known-as-unknown') inventory[tool].state = 'unknown';
    if (kind === 'missing-with-digest') inventory[tool].state = 'missing';
    if (kind === 'null-ready') result.diagnostic.inventory = null;
    if (kind === 'unknown-ready') inventory[tool] = { state: 'unknown', sha256: '0'.repeat(64) };
    if (['wrong-tool', 'earlier-refusal'].includes(kind)) {
      result.ok = false; result.code = 'inspection_refused'; result.diagnostic.category = 'tool_hash_unknown'; result.diagnostic.tool = 'onboard-clean-v1.sh';
      inventory[tool] = { state: 'unknown', sha256: '0'.repeat(64) };
      if (kind === 'earlier-refusal') inventory['onboard-clean-v1.sh'] = { state: 'unknown', sha256: '0'.repeat(64) };
    }
    if (kind === 'inventory-before-guards') { result.ok = false; result.code = 'inspection_refused'; result.diagnostic.category = 'identity_invalid'; }
    f.state.outputOverride = JSON.stringify(result);
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow();
    expect(readFileSync(f.options.output, 'utf8')).not.toContain('must-not-leak');
    expect(readFileSync(f.options.output, 'utf8')).not.toContain('private/path');
  });

  it('requires an explicit exact-release founder authorization for promotion', () => {
    const f = fixture();
    // @ts-expect-error Verify the runtime also refuses missing authorization.
    expect(() => planStagingRelease({ ...f.options, action: 'promote' }, f.dependencies)).toThrow();
    const candidate = JSON.parse(readFileSync(f.options.release, 'utf8'));
    const approval = join(f.directory, 'approval.json');
    const value = { kind: 'echo-staging-release-founder-authorization-v1', release_sha256: digest(readFileSync(f.options.release)), person_client_sha256: candidate.person_client.artifact_sha256, slack_approved: true, person_records_passed: true, person_ask_passed: true, release_authorized: false };
    write(approval, value);
    expect(() => planStagingRelease({ ...f.options, action: 'promote', approval }, f.dependencies)).toThrow('exact_founder_authorization_required');
    write(approval, { ...value, release_authorized: true });
    expect(planStagingRelease({ ...f.options, action: 'promote', approval }, f.dependencies).state).toBe('planned');
  });

  it('executes the host runner hermetically against private fixture state', () => {
    // Every inline updater publication must preserve the pinned relative cwd;
    // tempfile.mkstemp internally applies abspath even when given a relative dir.
    expect(readFileSync(join(REPO, 'deploy/organization-authority/update-clean-v1.sh'), 'utf8')).not.toMatch(/tempfile\.mkstemp\(/);
    const f = fixture(); planStagingRelease({ ...f.options, action: 'install' }, f.dependencies);
    const result = spawnSync('python3', ['-B', join(REPO, 'tests/fixtures/staging-release-host-test.py'), join(REPO, 'tools/authority-staging-release-host.py'), f.options.output, f.options.acceptedRelease], { encoding: 'utf8', timeout: 30000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('OK');
  });

  it('is silent and successful when imported instead of invoked as a CLI', () => {
    const result = spawnSync('node', ['--input-type=module', '-e', 'await import("./tools/authority-staging-release.mjs")'], { cwd: REPO, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  });

  it('supports fresh post-promotion status without inventing another candidate', () => {
    const f = fixture();
    expect(planStagingRelease({ ...f.options, action: 'status', acceptedRelease: f.options.release }, f.dependencies).state).toBe('planned');
    expect(executeStagingRelease(f.options.output, f.dependencies).state).toBe('succeeded');
    expect(() => planStagingRelease({ ...f.options, action: 'stage', acceptedRelease: f.options.release, output: join(f.directory, 'bad-stage.json') }, f.dependencies)).toThrow('accepted_binding_invalid');
  });

  it('revalidates a saved result before printing it on a later invocation', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    executeStagingRelease(f.options.output, f.dependencies);
    const receipt = JSON.parse(readFileSync(f.options.output, 'utf8'));
    receipt.outcome.secret = 'must-not-print'; write(f.options.output, receipt);
    expect(() => executeStagingRelease(f.options.output, f.dependencies)).toThrow();
    expect(f.state.submissions).toBe(1);
  });

  it('round-trips the compressed reviewed runner and request without calling AWS', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    const request = f.request();
    const source = `def main(payload, expected):\n import base64,gzip,hashlib,json\n body=gzip.decompress(base64.b64decode(payload))\n assert hashlib.sha256(body).hexdigest()==expected\n value=json.loads(body)\n assert value['schema_version']==2\n assert len(value['files'])==8\n print('verified-offline-wire')\n`;
    const readSource = (commit: string, path: string) => path === 'tools/authority-staging-release-host.py' ? Buffer.from(source) : f.dependencies.readSource(commit, path);
    const parameters = releaseSsmParameters(request, readSource);
    const result = spawnSync('sh', ['-c', parameters.commands[0]], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('verified-offline-wire\n');
    const tampered = parameters.commands[0].replace(/hexdigest\(\)!='[a-f0-9]{64}'/, `hexdigest()!='${'0'.repeat(64)}'`);
    const rejected = spawnSync('sh', ['-c', tampered], { encoding: 'utf8', timeout: 10000 });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toBe('');
    expect(f.state.submissions).toBe(0);
  });

  it('can poll legacy receipts but never submit a legacy unpinned plan', () => {
    const f = fixture(); planStagingRelease(f.options, f.dependencies);
    const dependencies = { ...f.dependencies, readSource: (commit: string, path: string) => path === 'tools/authority-staging-release-host.py' ? Buffer.from('# legacy reviewed runner fixture\n') : f.dependencies.readSource(commit, path) };
    const receipt = JSON.parse(readFileSync(f.options.output, 'utf8'));
    receipt.request.schema_version = 1;
    receipt.request.kind = 'echo-staging-release-request-v1';
    for (const name of ['onboard-clean-v1.sh', 'restore-clean-v1-host.sh', 'backup-authority-maintenance.sh']) {
      delete receipt.request.files[name]; delete receipt.request.old_tool_hashes[name];
    }
    receipt.request_sha256 = digest(canonical(receipt.request) + '\n');
    receipt.parameters_sha256 = digest(canonical(releaseSsmParameters(receipt.request, dependencies.readSource)) + '\n');
    write(f.options.output, receipt);
    expect(() => executeStagingRelease(f.options.output, dependencies)).toThrow('legacy_plan_execution_refused');
    expect(f.state.submissions).toBe(0);
    receipt.state = 'submitted'; receipt.command_id = COMMAND; write(f.options.output, receipt);
    expect(executeStagingRelease(f.options.output, dependencies, true).state).toBe('succeeded');
    expect(f.state.submissions).toBe(0);
  });
});
