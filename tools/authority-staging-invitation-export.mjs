// Private initial-owner handoff only. The remote command reads two fixed files
// and returns authenticated ciphertext; login and all onboarding mutations stay human.
import { constants, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, validateCleanV1Release } from './clean-v1-release.mjs';
import { stagingReleaseTarget } from './authority-staging-release.mjs';
import { awsCliArguments, sanitizedAwsEnvironment } from './authority-staging-onboarding-transfer.mjs';
export { sealInvitationPayload } from './authority-staging-invitation-seal.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'echo-staging-invitation-export-v1:';
const LIMIT = 8192;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILES = ['founder-person-invitation.json', 'current.clean-v1.json'];
export class InvitationExportError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new InvitationExportError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const json = value => Buffer.from(`${canonicalJson(value)}\n`);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), keys.sort());

function privateDirectory(path) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail('export_private_directory_required');
  const real = realpathSync(path);
  if (real === REPO || real.startsWith(`${REPO}/`)) fail('export_directory_inside_checkout');
  return real;
}
function privateFile(path, maximum = 32768) {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600 || state.size > maximum) fail('export_private_file_required');
    const bytes = Buffer.alloc(maximum + 1);
    // A bounded read cannot allocate an unbounded buffer if the file changes.
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const contents = bytes.subarray(0, size);
    const after = fstatSync(descriptor);
    if (contents.length > bytes.length - 1 || contents.length !== state.size || after.mtimeMs !== state.mtimeMs || after.size !== state.size) fail('export_private_file_changed');
    return contents;
  } finally { closeSync(descriptor); }
}
function save(path, bytes, fresh = false) {
  privateDirectory(dirname(path));
  if (!fresh) privateFile(path);
  const temporary = fresh ? path : `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (!fresh) renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function exactOutput(path, bytes) {
  if (existsSync(path)) {
    if (!privateFile(path, LIMIT).equals(bytes)) fail('export_output_already_exists');
  } else save(path, bytes, true);
}
function sourceHash() {
  return hash(Buffer.concat(['authority-staging-invitation-export.mjs', 'authority-staging-invitation-seal.mjs', 'authority-staging-onboarding-transfer.mjs', 'authority-staging-release.mjs', 'clean-v1-release.mjs'].map(name => readFileSync(resolve(REPO, 'tools', name)))));
}
function awsJson(args) {
  try {
    return JSON.parse(execFileSync('aws', awsCliArguments([...args, '--region', 'us-west-2', '--output', 'json']), {
      env: { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 45000, maxBuffer: 65536,
    }));
  } catch { fail('export_aws_operation_unconfirmed'); }
}
function binding(request) {
  return hash(json({ target: request.target, release_sha256: request.release_sha256, request_id: request.request_id, public_key: request.public_key, source_sha256: request.source_sha256 }));
}
function canonicalRelease(bytes) {
  const release = validateCleanV1Release(JSON.parse(bytes));
  if (bytes.length > LIMIT || !json(release).equals(bytes) || !/^904560150024\.dkr\.ecr\.us-west-2\.amazonaws\.com\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/.test(release.authority_image.reference)) fail('export_release_invalid');
  for (const value of [release.person_client.artifact_url, release.runtime_profile.artifact_url]) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) fail('export_release_url_not_public_metadata');
  }
  return release;
}
function validateRequest(request) {
  if (!exactKeys(request, ['schema_version', 'kind', 'state', 'request_id', 'target', 'release_sha256', 'release_base64', 'public_key', 'source_sha256', 'command_id', 'binding_sha256', 'invitation_sha256'])) fail('export_receipt_invalid');
  if (request.schema_version !== 1 || request.kind !== 'echo-staging-invitation-export-v1' || !ID.test(request.request_id) || !HASH.test(request.release_sha256) || request.source_sha256 !== sourceHash() || !['planned', 'submitting', 'submitted', 'failed', 'complete'].includes(request.state)) fail('export_receipt_invalid');
  const target = request.target;
  if (!exactKeys(target, ['account', 'region', 'stack_id', 'instance_id', 'volume_id']) || target.account !== '904560150024' || target.region !== 'us-west-2' || !/^arn:aws:cloudformation:us-west-2:904560150024:stack\/echo-authority-staging-v1\/[a-f0-9-]+$/.test(target.stack_id) || !/^i-[a-f0-9]{17}$/.test(target.instance_id) || !/^vol-[a-f0-9]{17}$/.test(target.volume_id)) fail('export_target_invalid');
  if (request.binding_sha256 !== binding(request)) fail('export_receipt_binding_mismatch');
  const key = createPublicKey(request.public_key);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072) fail('export_recipient_invalid');
  if (['planned', 'submitting'].includes(request.state) ? request.command_id !== null : !ID.test(request.command_id)) fail('export_command_id_invalid');
  if (request.state === 'complete' ? !HASH.test(request.invitation_sha256) : request.invitation_sha256 !== null) fail('export_receipt_invalid');
  const releaseBytes = Buffer.from(request.release_base64, 'base64');
  if (releaseBytes.toString('base64') !== request.release_base64 || hash(releaseBytes) !== request.release_sha256) fail('export_release_mismatch');
  const release = canonicalRelease(releaseBytes);
  return { request, release, releaseBytes };
}
function checkedRequest(path) {
  privateDirectory(dirname(path));
  return validateRequest(JSON.parse(privateFile(path)));
}

export function openInvitationPayload(output, privateKey, request) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 20000 || !output.startsWith(PREFIX) || !output.endsWith('\n')) fail('export_ciphertext_invalid');
  const packet = JSON.parse(output.slice(PREFIX.length));
  if (!same(Object.keys(packet).sort(), ['data', 'iv', 'key', 'tag', 'version']) || packet.version !== 1) fail('export_ciphertext_invalid');
  const decode = (value, length) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('export_ciphertext_invalid');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || (length && bytes.length !== length)) fail('export_ciphertext_invalid');
    return bytes;
  };
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, decode(packet.key, 384));
  const cipher = createDecipheriv('aes-256-gcm', key, decode(packet.iv, 12));
  cipher.setAAD(Buffer.from(request.binding_sha256, 'hex'));
  cipher.setAuthTag(decode(packet.tag, 16));
  const data = decode(packet.data);
  if (data.length > LIMIT + 4) fail('export_payload_too_large');
  const payload = Buffer.concat([cipher.update(data), cipher.final()]);
  if (payload.length < 6) fail('export_payload_invalid');
  const releaseLength = payload.readUInt32BE();
  if (releaseLength < 1 || releaseLength >= payload.length - 4) fail('export_payload_invalid');
  const release = payload.subarray(4, 4 + releaseLength);
  if (hash(release) !== request.release_sha256) fail('export_release_mismatch');
  return { release, invitation: payload.subarray(4 + releaseLength) };
}

export function invitationExportCommands(request) {
  validateRequest(request);
  const sealSource = readFileSync(resolve(REPO, 'tools/authority-staging-invitation-seal.mjs'), 'utf8');
  const nodeProgram = `${sealSource}\nimport { readFileSync } from 'node:fs';\nconst payload=readFileSync(0); if(payload.length>${LIMIT + 4}) process.exit(1); process.stdout.write(${JSON.stringify(PREFIX)}+JSON.stringify(sealInvitationPayload(payload,${JSON.stringify(request.public_key)},${JSON.stringify(request.binding_sha256)}))+'\\n');`;
  // No operator-supplied host path, shell command, grant, or private key is sent.
  return ['set -eu', 'umask 077', 'exec 2>/dev/null', `python3 - <<'PY'
import hashlib,json,os,stat,struct,subprocess,sys
control=None
guard=None
def read_fixed(path):
    descriptor=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        parts=path.split('/')[1:]
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            os.close(descriptor)
            descriptor=child
            info=os.fstat(descriptor)
            assert info.st_uid in (0,999) and not info.st_mode & 0o022
        leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=descriptor)
        try:
            before=os.fstat(leaf)
            assert stat.S_ISREG(before.st_mode) and before.st_nlink==1
            assert before.st_uid in (0,999) and stat.S_IMODE(before.st_mode)==0o600
            assert 0<before.st_size<=${LIMIT}
            result=b''
            while len(result)<=${LIMIT}:
                block=os.read(leaf,${LIMIT}+1-len(result))
                if not block: break
                result+=block
            after=os.fstat(leaf)
            assert len(result)==before.st_size and (before.st_mtime_ns,before.st_size)==(after.st_mtime_ns,after.st_size)
            return result
        finally: os.close(leaf)
    finally: os.close(descriptor)
try:
    control=os.open('/srv/echo-authority-clean-v1',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    assert os.fstat(control).st_uid==0 and not os.fstat(control).st_mode & 0o022
    os.mkdir('.staging-release-guard',0o700,dir_fd=control)
    guard=os.open('.staging-release-guard',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=control)
    owner=os.open('owner-pid',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=guard)
    with os.fdopen(owner,'wb') as output: output.write((str(os.getpid())+'\\n').encode())
    assert not os.path.lexists('/srv/echo-authority-clean-v1/clean-data/.authority-operation-lock')
    assert not os.path.lexists('/srv/echo-authority-clean-v1/clean-data/release/candidate.clean-v1.json')
    mount=subprocess.run(['findmnt','-rn','-o','SOURCE,FSTYPE,TARGET','--target','/srv/echo-authority-clean-v1/clean-data'],check=True,capture_output=True,timeout=10).stdout.decode().split()
    assert len(mount)==3 and mount[1:] == ['ext4','/srv/echo-authority-clean-v1/clean-data'] and mount[0].startswith('/dev/')
    serial=subprocess.run(['lsblk','-dn','-o','SERIAL','--',mount[0]],check=True,capture_output=True,timeout=10).stdout.decode().strip().replace('-','')
    assert serial==${JSON.stringify(request.target.volume_id.replaceAll('-', ''))}
    release=read_fixed('/srv/echo-authority-clean-v1/clean-data/release/current.clean-v1.json')
    assert hashlib.sha256(release).hexdigest()==${JSON.stringify(request.release_sha256)}
    record=json.loads(release)
    invitation=read_fixed('/srv/echo-authority-clean-v1/clean-data/state/onboarding/founder-person-invitation.json')
    assert len(release)+len(invitation)<=${LIMIT}
    container='echo-organization-authority-clean-v1-authority-1'
    inspect=subprocess.run(['docker','inspect',container],check=True,capture_output=True,timeout=10)
    node=json.loads(inspect.stdout)[0]
    assert node['State']['Running'] and node['State']['Health']['Status']=='healthy'
    assert node['Config']['Image']==record['authority_image']['reference']
    image=subprocess.run(['docker','image','inspect',record['authority_image']['reference']],check=True,capture_output=True,timeout=10)
    assert json.loads(image.stdout)[0]['Id']==node['Image']
    sealed=subprocess.run(['docker','exec','-i',node['Id'],'node','--input-type=module','-e',${JSON.stringify(nodeProgram)}],input=struct.pack('>I',len(release))+release+invitation,check=True,capture_output=True,timeout=30)
    assert len(sealed.stdout)<=20000 and sealed.stdout.startswith(${JSON.stringify(PREFIX)}.encode()) and not sealed.stderr
    sys.stdout.buffer.write(sealed.stdout)
except BaseException:
    raise SystemExit(1)
finally:
    if guard is not None:
        current=os.stat('.staging-release-guard',dir_fd=control,follow_symlinks=False)
        assert (current.st_dev,current.st_ino)==(os.fstat(guard).st_dev,os.fstat(guard).st_ino)
        os.unlink('owner-pid',dir_fd=guard)
        os.close(guard)
        os.rmdir('.staging-release-guard',dir_fd=control)
    if control is not None: os.close(control)
PY`];
}

export function planInvitationExport(input, { aws = awsJson } = {}) {
  const config = JSON.parse(privateFile(input));
  if (!same(Object.keys(config).sort(), ['outputDir', 'release'])) fail('export_input_invalid');
  const directory = privateDirectory(config.outputDir);
  for (const name of [...FILES, 'invitation-export.json', 'recipient-key.pem']) if (existsSync(resolve(directory, name))) fail('export_output_already_exists');
  const releaseBytes = privateFile(config.release, LIMIT);
  const release = canonicalRelease(releaseBytes);
  const target = stagingReleaseTarget(aws);
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const request = { schema_version: 1, kind: 'echo-staging-invitation-export-v1', state: 'planned', request_id: randomUUID(), target, release_sha256: hash(releaseBytes), release_base64: releaseBytes.toString('base64'), public_key: keys.publicKey, source_sha256: sourceHash(), command_id: null, invitation_sha256: null };
  request.binding_sha256 = binding(request);
  validateRequest(request);
  const path = resolve(directory, 'invitation-export.json');
  save(resolve(directory, 'recipient-key.pem'), Buffer.from(keys.privateKey), true);
  save(path, json(request), true);
  checkedRequest(path);
  return { action: 'export-plan', state: 'planned', receipt_path: path, target, release_id: release.release_id, release_sha256: request.release_sha256, files: FILES, remote_access: 'read two fixed files; ciphertext output only', infrastructure_changes: false };
}

export function executeInvitationExport(path, { aws = awsJson, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = Date.now } = {}) {
  const directory = privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('export_receipt_locked'); }
  try {
    const { request, release } = checkedRequest(path);
    const keyPath = resolve(directory, 'recipient-key.pem');
    const result = () => ({ action: 'export-execute', state: 'exported', release_id: release.release_id, invitation_path: resolve(directory, FILES[0]), release_path: resolve(directory, FILES[1]) });
    if (request.state === 'complete') {
      if (hash(privateFile(resolve(directory, FILES[0]), LIMIT)) !== request.invitation_sha256 || hash(privateFile(resolve(directory, FILES[1]), LIMIT)) !== request.release_sha256) fail('export_completed_output_changed');
      if (existsSync(keyPath)) { privateFile(keyPath); rmSync(keyPath); }
      return result();
    }
    if (request.state === 'submitting') fail('export_submission_unconfirmed_do_not_resubmit');
    if (request.state === 'failed') fail('export_command_failed');
    const privateKey = privateFile(keyPath);
    if (createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== request.public_key) fail('export_recipient_mismatch');
    if (!same(stagingReleaseTarget(aws), request.target)) fail('export_target_changed');
    if (request.state === 'planned') {
      for (const name of FILES) if (existsSync(resolve(directory, name))) fail('export_output_already_exists');
      request.state = 'submitting';
      save(path, json(request));
      const sent = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--timeout-seconds', '60', '--instance-ids', request.target.instance_id, '--parameters', JSON.stringify({ commands: invitationExportCommands(request), executionTimeout: ['90'] }), '--cloud-watch-output-config', 'CloudWatchOutputEnabled=false']);
      if (!ID.test(sent.Command?.CommandId)) fail('export_submission_unconfirmed_do_not_resubmit');
      request.command_id = sent.Command.CommandId;
      request.state = 'submitted';
      save(path, json(request));
    }
    const deadline = now() + 180000;
    while (now() < deadline) {
      let invocation;
      try { invocation = aws(['ssm', 'get-command-invocation', '--command-id', request.command_id, '--instance-id', request.target.instance_id]); }
      catch { sleep(3000); continue; }
      if (invocation.Status === 'Success') {
        if (invocation.CommandId !== request.command_id || invocation.InstanceId !== request.target.instance_id || invocation.StandardErrorContent) fail('export_remote_result_invalid');
        const bytes = openInvitationPayload(invocation.StandardOutputContent, privateKey, request);
        exactOutput(resolve(directory, FILES[1]), bytes.release);
        exactOutput(resolve(directory, FILES[0]), bytes.invitation);
        request.invitation_sha256 = hash(bytes.invitation);
        request.state = 'complete';
        save(path, json(request));
        rmSync(keyPath);
        return result();
      }
      if (['Failed', 'Cancelled', 'TimedOut', 'Undeliverable', 'Terminated'].includes(invocation.Status)) {
        request.state = 'failed'; save(path, json(request)); rmSync(keyPath); fail('export_command_failed');
      }
      sleep(3000);
    }
    fail('export_pending_retry_same_receipt');
  } finally { rmdirSync(lock); }
}
