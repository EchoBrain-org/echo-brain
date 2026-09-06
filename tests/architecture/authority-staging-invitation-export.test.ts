import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeInvitationExport, invitationExportCommands, openInvitationPayload, planInvitationExport, sealInvitationPayload } from '../../tools/authority-staging-invitation-export.mjs';
import type { InvitationExportRequest } from '../../tools/authority-staging-invitation-export.mjs';

const roots: string[] = [];
const INSTANCE = 'i-0123456789abcdef0';
const VOLUME = 'vol-0123456789abcdef0';
const STACK = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-authority-staging-v1/12345678-1234-1234-1234-123456789012';
const COMMAND = '11111111-1111-4111-8111-111111111111';
const PREFIX = 'echo-staging-invitation-export-v1:';
const INVITATION = Buffer.from('{"grant":"synthetic-private-invitation-do-not-print"}\n');
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const write = (path: string, value: unknown) => writeFileSync(path, canonicalJson(value) + '\n', { mode: 0o600 });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'echo-invitation-export-'));
  chmodSync(root, 0o700); roots.push(root);
  const output = join(root, 'output'); mkdirSync(output, { mode: 0o700 });
  const releasePath = join(root, 'release.json');
  write(releasePath, { schema_version: 1, kind: 'echo-clean-v1-release', release_id: 'clean-v1-export-test', released_at: '2026-09-06T00:00:00Z', source_sha: 'a'.repeat(40), baseline_compatibility_class: 'clean-v1', authority_image: { reference: `904560150024.dkr.ecr.us-west-2.amazonaws.com/echo/organization-authority@sha256:${'d'.repeat(64)}` }, person_client: { package: '@echo-brain/person-client', version: '0.1.0-internal.1', artifact_url: 'https://rehearsal.invalid/client.tgz', artifact_sha256: 'c'.repeat(64) }, runtime_profile: { profile_version: 'clean-v1-profile-1', artifact_url: 'https://rehearsal.invalid/profile.json', artifact_sha256: 'b'.repeat(64) } });
  const release = readFileSync(releasePath);
  const input = join(root, 'input.json'); write(input, { outputDir: output, release: releasePath });
  const receipt = join(output, 'invitation-export.json');
  const request = (): InvitationExportRequest => JSON.parse(readFileSync(receipt, 'utf8'));
  const calls: (readonly string[])[] = [];
  const state = { submissions: 0, account: '904560150024', changedVolume: false, lostSend: false, pending: false, failed: false, rawOutput: false, clock: 0 };
  const payload = () => { const size = Buffer.alloc(4); size.writeUInt32BE(release.length); return Buffer.concat([size, release, INVITATION]); };
  const encrypted = () => PREFIX + JSON.stringify(sealInvitationPayload(payload(), request().public_key, request().binding_sha256)) + '\n';
  const aws = (args: readonly string[]) => {
    calls.push(args);
    switch (args.slice(0, 2).join(' ')) {
      case 'sts get-caller-identity': return { Account: state.account, Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
      case 'cloudformation describe-stacks': return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', EnableTerminationProtection: true, StackId: STACK, Outputs: [{ OutputKey: 'StagingHostInstanceId', OutputValue: INSTANCE }, { OutputKey: 'StagingDataVolumeId', OutputValue: state.changedVolume ? 'vol-1123456789abcdef0' : VOLUME }, { OutputKey: 'StagingHostReady', OutputValue: 'true' }] }] };
      case 'ec2 describe-instances': return { Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: 'running' }, Tags: [{ Key: 'aws:cloudformation:stack-id', Value: STACK }, { Key: 'aws:cloudformation:logical-id', Value: 'StagingHost' }, { Key: 'Environment', Value: 'staging' }], BlockDeviceMappings: [{ Ebs: { VolumeId: state.changedVolume ? 'vol-1123456789abcdef0' : VOLUME } }] }] }] };
      case 'ssm describe-instance-information': return { InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: 'Online' }] };
      case 'ssm send-command': state.submissions++; if (state.lostSend) throw new Error('simulated send response loss'); return { Command: { CommandId: COMMAND } };
      case 'ssm get-command-invocation': return { Status: state.pending ? 'InProgress' : state.failed ? 'Failed' : 'Success', CommandId: COMMAND, InstanceId: INSTANCE, StandardErrorContent: '', StandardOutputContent: state.rawOutput ? INVITATION.toString() : encrypted() };
      default: throw new Error('unexpected AWS operation');
    }
  };
  const dependencies = { aws, now: () => state.clock, sleep: (ms: number) => { state.clock += ms; } };
  return { root, output, input, receipt, releasePath, release, request, calls, state, payload, encrypted, dependencies };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('private staging invitation export', () => {
  it('plans without remote execution and writes only private recipient material', () => {
    const f = fixture(); const plan = planInvitationExport(f.input, f.dependencies);
    expect(plan).toMatchObject({ state: 'planned', infrastructure_changes: false, target: { instance_id: INSTANCE, volume_id: VOLUME } });
    expect(f.state.submissions).toBe(0);
    expect(statSync(join(f.output, 'recipient-key.pem')).mode & 0o777).toBe(0o600);
    const commands = invitationExportCommands(f.request()).join('\n');
    expect(commands).not.toContain(INVITATION.toString());
    expect(commands).not.toContain('PRIVATE KEY');
    expect(Buffer.byteLength(commands)).toBeLessThan(24000);
    expect(f.calls.every(args => !['s3api', 'iam', 'secretsmanager'].includes(args[0]))).toBe(true);
  });

  it('decrypts directly to two private files, removes the recipient key and never resubmits after completion', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies);
    const result = executeInvitationExport(f.receipt, f.dependencies);
    expect(readFileSync(result.invitation_path)).toEqual(INVITATION);
    expect(readFileSync(result.release_path)).toEqual(f.release);
    expect(statSync(result.invitation_path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(f.output, 'recipient-key.pem'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
    expect(executeInvitationExport(f.receipt, f.dependencies)).toEqual(result);
    expect(f.state.submissions).toBe(1);
  });

  it('authenticates the ciphertext and request binding before publishing anything', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies);
    const key = readFileSync(join(f.output, 'recipient-key.pem'));
    expect(() => openInvitationPayload(f.encrypted(), key, { ...f.request(), binding_sha256: '0'.repeat(64) })).toThrow();
    const packet = sealInvitationPayload(f.payload(), f.request().public_key, f.request().binding_sha256);
    const data = Buffer.from(packet.data, 'base64'); data[0] ^= 1; packet.data = data.toString('base64');
    expect(() => openInvitationPayload(PREFIX + JSON.stringify(packet) + '\n', key, f.request())).toThrow();
    f.state.rawOutput = true;
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_ciphertext_invalid');
    expect(existsSync(join(f.output, 'founder-person-invitation.json'))).toBe(false);
  });

  it('rejects changed completed files instead of reporting success again', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies);
    const result = executeInvitationExport(f.receipt, f.dependencies);
    writeFileSync(result.invitation_path, 'changed');
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_completed_output_changed');
    expect(f.state.submissions).toBe(1);
  });

  it('refuses credential-bearing release URLs before AWS inspection or recipient creation', () => {
    const f = fixture();
    const release = JSON.parse(f.release.toString());
    release.person_client.artifact_url = 'https://rehearsal.invalid/client.tgz?credential=synthetic';
    write(f.releasePath, release);
    expect(() => planInvitationExport(f.input, f.dependencies)).toThrow('export_release_url_not_public_metadata');
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(f.output, 'recipient-key.pem'))).toBe(false);
  });

  it('rejects unrecognized receipt fields when rendering and executing', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies);
    const altered = { ...f.request(), host_path: '/unapproved' };
    expect(() => invitationExportCommands(altered)).toThrow('export_receipt_invalid');
    write(f.receipt, altered);
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_receipt_invalid');
    expect(f.state.submissions).toBe(0);
  });

  it('removes the recipient key after a confirmed remote failure and refuses resubmission', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies); f.state.failed = true;
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_command_failed');
    expect(existsSync(join(f.output, 'recipient-key.pem'))).toBe(false);
    expect(existsSync(join(f.output, 'founder-person-invitation.json'))).toBe(false);
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_command_failed');
    expect(f.state.submissions).toBe(1);
  });

  it('resumes polling the same command after a deadline', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies); f.state.pending = true;
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_pending_retry_same_receipt');
    f.state.pending = false;
    expect(executeInvitationExport(f.receipt, f.dependencies).state).toBe('exported');
    expect(f.state.submissions).toBe(1);
  });

  it('preserves an unknown submission and never sends another command', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies); f.state.lostSend = true;
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow();
    expect(f.request().state).toBe('submitting');
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_submission_unconfirmed_do_not_resubmit');
    expect(f.state.submissions).toBe(1);
  });

  it('refuses changed targets and existing outputs before remote execution', () => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies); f.state.changedVolume = true;
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_target_changed');
    f.state.changedVolume = false;
    writeFileSync(join(f.output, 'founder-person-invitation.json'), 'existing', { mode: 0o600 });
    expect(() => executeInvitationExport(f.receipt, f.dependencies)).toThrow('export_output_already_exists');
    expect(f.state.submissions).toBe(0);
  });

  it('rejects the wrong account and an exposed output directory before creating a key', () => {
    const f = fixture(); f.state.account = '123456789012';
    expect(() => planInvitationExport(f.input, f.dependencies)).toThrow('echo_prod_sso_required');
    f.state.account = '904560150024'; chmodSync(f.output, 0o755);
    expect(() => planInvitationExport(f.input, f.dependencies)).toThrow('export_private_directory_required');
    expect(existsSync(join(f.output, 'recipient-key.pem'))).toBe(false);
  });

  it.each(['valid', 'symlink', 'exposed', 'oversized', 'wrong-release', 'wrong-volume', 'busy'] as const)('executes the real host reader/encryptor offline: %s', mode => {
    const f = fixture(); planInvitationExport(f.input, f.dependencies);
    const host = join(f.root, 'host');
    const base = join(host, 'srv/echo-authority-clean-v1');
    const invitation = join(base, 'clean-data/state/onboarding/founder-person-invitation.json');
    const release = join(base, 'clean-data/release/current.clean-v1.json');
    for (const path of [dirname(invitation), dirname(release)]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(release, mode === 'wrong-release' ? Buffer.from('{}') : f.release, { mode: 0o600 });
    writeFileSync(invitation, mode === 'oversized' ? Buffer.alloc(8193) : INVITATION, { mode: 0o600 });
    if (mode === 'exposed') chmodSync(invitation, 0o644);
    if (mode === 'symlink') { rmSync(invitation); symlinkSync(release, invitation); }
    if (mode === 'busy') mkdirSync(join(base, '.staging-release-guard'), { mode: 0o700 });
    const command = invitationExportCommands(f.request()).at(-1)!;
    const script = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('\nPY'));
    const harness = String.raw`
import os,subprocess,json,types
real_open,real_fstat,real_lexists,real_run=os.open,os.fstat,os.path.lexists,subprocess.run
host=${JSON.stringify(host)}
def mapped(path):
    return host+path if isinstance(path,str) and (path=='/' or path.startswith('/srv/')) else path
os.open=lambda path,*args,**kwargs: real_open(mapped(path),*args,**kwargs)
os.path.lexists=lambda path: real_lexists(mapped(path))
def metadata(fd):
    original=real_fstat(fd)
    fields={name:getattr(original,name) for name in dir(original) if name.startswith('st_')}
    fields['st_uid']=0
    return types.SimpleNamespace(**fields)
os.fstat=metadata
def run(args,**kwargs):
    if args[0]=='findmnt': value=b'/dev/mock ext4 /srv/echo-authority-clean-v1/clean-data\n'
    elif args[0]=='lsblk': value=${JSON.stringify(mode === 'wrong-volume' ? 'vol99999999999999999' : VOLUME.replaceAll('-', ''))}.encode()
    elif args[:2]==['docker','inspect']:
        value=json.dumps([{'Id':'e'*64,'Image':'sha256:'+'f'*64,'State':{'Running':True,'Health':{'Status':'healthy'}},'Config':{'Image':${JSON.stringify(JSON.parse(f.release.toString()).authority_image.reference)}}}]).encode()
    elif args[:3]==['docker','image','inspect']: value=json.dumps([{'Id':'sha256:'+'f'*64}]).encode()
    elif args[:2]==['docker','exec']:
        return real_run([${JSON.stringify(process.execPath)},'--input-type=module','-e',args[-1]],**kwargs)
    else: raise AssertionError('unexpected process')
    return subprocess.CompletedProcess(args,0,value,b'')
subprocess.run=run
`;
    // Preserve diagnostics only in this synthetic fixture; live failures stay silent.
    const result = spawnSync('python3', ['-'], { input: harness + script.replace('    raise SystemExit(1)', '    raise'), encoding: 'utf8' });
    expect(result.stdout).not.toContain('synthetic-private-invitation');
    if (mode === 'valid') {
      expect(result.status, result.stderr).toBe(0);
      const opened = openInvitationPayload(result.stdout, readFileSync(join(f.output, 'recipient-key.pem')), f.request());
      expect(opened.invitation).toEqual(INVITATION);
      expect(opened.release).toEqual(f.release);
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(existsSync(join(base, '.staging-release-guard'))).toBe(mode === 'busy');
  });
});
