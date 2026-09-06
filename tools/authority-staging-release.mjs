#!/usr/bin/env node

// Current-host staging releases only. No shell passthrough, S3 courier, IAM,
// lifecycle mutation, onboarding input, credential read, or Cloud execution.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canonicalJson, readCleanV1Release, validateCleanV1Release } from './clean-v1-release.mjs';
import { readRuntimeProfile, validateRuntimeProfile } from './clean-v1-runtime-profile.mjs';
import { awsCliArguments, sanitizedAwsEnvironment } from './authority-staging-onboarding-transfer.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '904560150024';
const REGION = 'us-west-2';
const STACK = 'echo-authority-staging-v1';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIONS = ['install', 'diagnose', 'repair', 'stage', 'canary', 'status', 'rollback', 'promote'];
const TOOL_FILES = Object.freeze({
  'update-clean-v1.sh': 'deploy/organization-authority/update-clean-v1.sh',
  'onboard-clean-v1.sh': 'deploy/organization-authority/onboard-clean-v1.sh',
  'restore-clean-v1-host.sh': 'deploy/organization-authority/restore-clean-v1-host.sh',
  'backup-authority-maintenance.sh': 'deploy/organization-authority/backup-authority-maintenance.sh',
  'release/clean-v1-release.py': 'deploy/release/clean-v1-release.py',
  'release/clean-v1-runtime-profile.py': 'deploy/release/clean-v1-runtime-profile.py',
});
const RUNNER = 'tools/authority-staging-release-host.py';
const LEGACY_TOOL_FILES = Object.fromEntries(Object.entries(TOOL_FILES).filter(([name]) => !['onboard-clean-v1.sh', 'restore-clean-v1-host.sh', 'backup-authority-maintenance.sh'].includes(name)));
const MAX_COMMAND_BYTES = 60 * 1024;
const TERMINAL = ['Failed', 'Cancelled', 'TimedOut', 'Undeliverable', 'Terminated'];
const fail = code => { throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const jsonBytes = value => Buffer.from(`${canonicalJson(value)}\n`);

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) fail('shape_invalid');
}

export function releaseAction(action) {
  if (!ACTIONS.includes(action)) fail('action_invalid');
  return action;
}

function git(args) {
  try { return execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }); }
  catch { fail('reviewed_source_unavailable'); }
}

function sourceFile(commit, path) {
  if (!COMMIT.test(commit)) fail('source_invalid');
  return git(['show', `${commit}:${path}`]);
}

function reviewedRuntime() {
  if (git(['status', '--porcelain=v1', '--untracked-files=all']).toString() !== '') fail('reviewed_clean_checkout_required');
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  git(['merge-base', '--is-ancestor', commit, 'origin/main']);
  return commit;
}

function privateDirectory(path) {
  const absolute = resolve(path);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail('private_directory_required');
  // Resolve ancestors as well; receipts must not live inside a checkout.
  const real = realpathSync(absolute);
  if (real === REPO || real.startsWith(`${REPO}/`)) fail('receipt_inside_checkout');
  return absolute;
}

function privateFile(path, max = 1024 * 1024) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600 || state.size > max) fail('private_file_required');
  return readFileSync(path);
}

function save(path, value, fresh = false) {
  privateDirectory(dirname(path));
  if (!fresh) privateFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(fresh ? path : temporary, 'wx', 0o600);
  try { writeFileSync(fd, jsonBytes(value)); fsyncSync(fd); } finally { closeSync(fd); }
  if (!fresh) renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function withReceiptLock(path, action) {
  privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('receipt_locked'); }
  try { return action(); } finally { rmdirSync(lock); }
}

function awsJson(args) {
  try {
    return JSON.parse(execFileSync('aws', awsCliArguments([...args, '--region', REGION, '--output', 'json']), {
      env: { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    }));
  } catch { fail('aws_operation_unconfirmed'); }
}

export function stagingReleaseTarget(aws = awsJson) {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== ACCOUNT || typeof identity.Arn !== 'string' || !new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_[A-Za-z0-9_]+/[^/]+$`).test(identity.Arn)) fail('echo_prod_sso_required');
  const stacks = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK]).Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) fail('staging_stack_invalid');
  const stack = stacks[0];
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus) || stack.EnableTerminationProtection !== true || !stack.StackId?.startsWith(`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${STACK}/`)) fail('staging_stack_not_ready');
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));
  const instance = outputs.StagingHostInstanceId;
  const volume = outputs.StagingDataVolumeId;
  if (!/^i-[a-f0-9]{17}$/.test(instance) || !/^vol-[a-f0-9]{17}$/.test(volume) || outputs.StagingHostReady !== 'true') fail('staging_host_not_ready');
  const reservations = aws(['ec2', 'describe-instances', '--instance-ids', instance]).Reservations;
  const nodes = (reservations ?? []).flatMap(item => item.Instances ?? []);
  if (nodes.length !== 1 || nodes[0].InstanceId !== instance || nodes[0].State?.Name !== 'running') fail('staging_instance_invalid');
  const tags = Object.fromEntries((nodes[0].Tags ?? []).map(item => [item.Key, item.Value]));
  if (tags['aws:cloudformation:stack-id'] !== stack.StackId || tags['aws:cloudformation:logical-id'] !== 'StagingHost' || tags.Environment !== 'staging' || !nodes[0].BlockDeviceMappings?.some(item => item.Ebs?.VolumeId === volume)) fail('staging_instance_binding_mismatch');
  const managed = aws(['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${instance}`]).InstanceInformationList;
  if (managed?.length !== 1 || managed[0].InstanceId !== instance || managed[0].PingStatus !== 'Online') fail('staging_ssm_not_online');
  return { account: ACCOUNT, region: REGION, stack_id: stack.StackId, instance_id: instance, volume_id: volume };
}

function canonicalRecord(bytes) {
  const record = validateCleanV1Release(JSON.parse(bytes.toString('utf8')));
  if (!jsonBytes(record).equals(bytes)) fail('release_not_canonical');
  for (const url of [record.person_client.artifact_url, record.runtime_profile.artifact_url]) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('release_url_not_public_metadata');
  }
  if (!record.authority_image.reference.startsWith(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/`)) fail('release_registry_not_staging_account');
  return record;
}

function approvalFor(request, approval) {
  if (request.action !== 'promote') {
    if (approval !== null) fail('unexpected_approval');
    return;
  }
  exactKeys(approval, ['kind', 'release_sha256', 'person_client_sha256', 'slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized']);
  if (approval.kind !== 'echo-staging-release-founder-authorization-v1' || approval.release_sha256 !== request.candidate.sha256 || approval.person_client_sha256 !== request.candidate.person_client_sha256 || ['slack_approved', 'person_records_passed', 'person_ask_passed', 'release_authorized'].some(key => approval[key] !== true)) fail('exact_founder_authorization_required');
}

/** Pure request validation is repeated before planning, rendering and execution. */
export function validateReleaseRequest(request, readSource = sourceFile) {
  exactKeys(request, ['schema_version', 'kind', 'operation_id', 'action', 'created_at', 'expires_at', 'target', 'tooling_source', 'previous_tooling_source', 'accepted', 'candidate', 'files', 'old_tool_hashes', 'content_telemetry', 'approval']);
  if (![1, 2].includes(request.schema_version) || request.kind !== `echo-staging-release-request-v${request.schema_version}` || !ID.test(request.operation_id)) fail('request_invalid');
  const toolFiles = request.schema_version === 1 ? LEGACY_TOOL_FILES : TOOL_FILES;
  releaseAction(request.action);
  if (!Number.isSafeInteger(request.created_at) || request.expires_at !== request.created_at + 1800) fail('request_lifetime_invalid');
  exactKeys(request.target, ['account', 'region', 'stack_id', 'instance_id', 'volume_id']);
  if (request.target.account !== ACCOUNT || request.target.region !== REGION || !new RegExp(`^arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${STACK}/[a-f0-9-]+$`).test(request.target.stack_id) || !/^i-[a-f0-9]{17}$/.test(request.target.instance_id) || !/^vol-[a-f0-9]{17}$/.test(request.target.volume_id)) fail('target_invalid');
  if (!COMMIT.test(request.tooling_source) || !COMMIT.test(request.previous_tooling_source)) fail('source_invalid');
  exactKeys(request.files, [...Object.keys(toolFiles), 'candidate.json', 'runtime-profile.json']);
  exactKeys(request.old_tool_hashes, Object.keys(toolFiles));
  const bytes = {};
  for (const [name, entry] of Object.entries(request.files)) {
    exactKeys(entry, ['sha256', 'base64']);
    if (!SHA.test(entry.sha256) || typeof entry.base64 !== 'string' || entry.base64.length > 256 * 1024) fail('artifact_invalid');
    bytes[name] = Buffer.from(entry.base64, 'base64');
    if (bytes[name].toString('base64') !== entry.base64 || digest(bytes[name]) !== entry.sha256) fail('artifact_checksum_mismatch');
  }
  for (const [name, path] of Object.entries(toolFiles)) {
    if (!bytes[name].equals(readSource(request.tooling_source, path)) || request.old_tool_hashes[name] !== digest(readSource(request.previous_tooling_source, path))) fail('tooling_source_mismatch');
  }
  const candidate = canonicalRecord(bytes['candidate.json']);
  exactKeys(request.candidate, ['release_id', 'sha256', 'person_client_sha256']);
  if (request.candidate.release_id !== candidate.release_id || request.candidate.sha256 !== digest(bytes['candidate.json']) || request.candidate.person_client_sha256 !== candidate.person_client.artifact_sha256) fail('candidate_binding_mismatch');
  exactKeys(request.accepted, ['release_id', 'sha256']);
  if (!/^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/.test(request.accepted.release_id) || !SHA.test(request.accepted.sha256)) fail('accepted_binding_invalid');
  if (request.accepted.release_id === candidate.release_id && (!['install', 'diagnose', 'repair', 'status'].includes(request.action) || request.accepted.sha256 !== request.candidate.sha256)) fail('accepted_binding_invalid');
  const profile = validateRuntimeProfile(JSON.parse(bytes['runtime-profile.json'].toString('utf8')));
  if (!jsonBytes(profile).equals(bytes['runtime-profile.json']) || digest(bytes['runtime-profile.json']) !== candidate.runtime_profile.artifact_sha256 || profile.source_sha !== candidate.source_sha) fail('profile_binding_mismatch');
  for (const [name, content] of Object.entries(profile.files)) {
    if (!Buffer.from(content).equals(readSource(candidate.source_sha, `deploy/organization-authority/${name}`))) fail('profile_source_mismatch');
  }
  if (![null, 'true', 'false'].includes(request.content_telemetry) || (request.action !== 'stage' && request.content_telemetry !== null)) fail('content_option_invalid');
  approvalFor(request, request.approval);
  return request;
}

export function releaseSsmParameters(request, readSource = sourceFile) {
  validateReleaseRequest(request, readSource);
  const body = jsonBytes(request);
  const payload = gzipSync(body, { level: 9 }).toString('base64');
  const runner = readSource(request.tooling_source, RUNNER).toString('utf8');
  let script = `${runner}\nmain('${payload}', '${digest(body)}')`;
  if (request.schema_version === 2) {
    // Compress text once, not separately base64-expanded files plus a plain
    // runner. The fixed loader verifies the whole reviewed, non-secret bundle.
    const wire = { runner, request: structuredClone(request) };
    for (const entry of Object.values(wire.request.files)) {
      const bytes = Buffer.from(entry.base64, 'base64');
      entry.utf8 = bytes.toString('utf8');
      if (!Buffer.from(entry.utf8).equals(bytes)) fail('artifact_not_utf8');
      delete entry.base64;
    }
    const raw = jsonBytes(wire);
    if (raw.length > 768 * 1024) fail('bounded_command_too_large');
    let compressed;
    try {
      // Python is already an operator/host prerequisite. Its standard-library
      // XZ codec fits the complete interlock participant set without a courier.
      compressed = execFileSync('python3', ['-I', '-c', 'import lzma,sys; raw=sys.stdin.buffer.read(786433); assert len(raw)<=786432; sys.stdout.buffer.write(lzma.compress(raw,format=lzma.FORMAT_XZ,preset=6))'], { input: raw, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 768 * 1024 }).toString('base64');
    } catch { fail('bounded_compression_unavailable'); }
    script = `import base64,gzip,hashlib,json,lzma\ndecoder=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=134217728)\nraw=decoder.decompress(base64.b64decode('${compressed}',validate=True),max_length=786433)\nif not decoder.eof or decoder.unused_data or len(raw)>786432 or hashlib.sha256(raw).hexdigest()!='${digest(raw)}': raise SystemExit(1)\nwire=json.loads(raw)\nfor entry in wire['request']['files'].values():\n entry['base64']=base64.b64encode(entry.pop('utf8').encode()).decode()\nbody=(json.dumps(wire['request'],sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\\n').encode()\nif hashlib.sha256(body).hexdigest()!='${digest(body)}': raise SystemExit(1)\nnamespace={}\nexec(compile(wire['runner'],'<reviewed-staging-runner>','exec'),namespace)\nnamespace['main'](base64.b64encode(gzip.compress(body)).decode(),'${digest(body)}')`;
  }
  const commands = [`/usr/bin/python3 - <<'ECHO_RELEASE_PY'\n${script}\nECHO_RELEASE_PY`];
  const parameters = { commands, executionTimeout: ['1200'] };
  // Leave space for AWS-RunShellScript's document envelope under its 64 KiB limit.
  if (Buffer.byteLength(JSON.stringify(parameters)) > MAX_COMMAND_BYTES) fail('bounded_command_too_large');
  return parameters;
}

export function planStagingRelease(options, dependencies = {}) {
  const { aws = awsJson, readSource = sourceFile, runtime = reviewedRuntime, now = Date.now } = dependencies;
  releaseAction(options.action);
  const toolingSource = runtime();
  const previousSource = options.previousToolingSource ?? toolingSource;
  if (!COMMIT.test(previousSource)) fail('previous_tooling_source_invalid');
  if (!dependencies.readSource) git(['merge-base', '--is-ancestor', previousSource, 'origin/main']);
  privateFile(options.acceptedRelease, 16384);
  privateFile(options.release, 16384);
  privateFile(options.runtimeProfile, 131072);
  const acceptedBytes = readFileSync(options.acceptedRelease);
  const accepted = canonicalRecord(acceptedBytes);
  const candidateBytes = readFileSync(options.release);
  const candidate = readCleanV1Release(options.release);
  readRuntimeProfile(options.runtimeProfile);
  const files = {};
  const old = {};
  const add = (name, bytes) => { files[name] = { sha256: digest(bytes), base64: bytes.toString('base64') }; };
  for (const [name, path] of Object.entries(TOOL_FILES)) { add(name, readSource(toolingSource, path)); old[name] = digest(readSource(previousSource, path)); }
  add('candidate.json', candidateBytes);
  add('runtime-profile.json', readFileSync(options.runtimeProfile));
  const timestamp = Math.floor(now() / 1000);
  const request = {
    schema_version: 2, kind: 'echo-staging-release-request-v2', operation_id: randomUUID(), action: options.action,
    created_at: timestamp, expires_at: timestamp + 1800, target: stagingReleaseTarget(aws),
    tooling_source: toolingSource, previous_tooling_source: previousSource,
    accepted: { release_id: accepted.release_id, sha256: digest(acceptedBytes) },
    candidate: { release_id: candidate.release_id, sha256: digest(candidateBytes), person_client_sha256: candidate.person_client.artifact_sha256 },
    files, old_tool_hashes: old, content_telemetry: options.contentTelemetry ?? null,
    approval: options.approval ? JSON.parse(privateFile(options.approval, 4096).toString()) : null,
  };
  const parameters = releaseSsmParameters(request, readSource);
  const receipt = { schema_version: 1, kind: 'echo-staging-release-operation-v1', request, request_sha256: digest(jsonBytes(request)), parameters_sha256: digest(jsonBytes(parameters)), state: 'planned', command_id: null, outcome: null };
  save(resolve(options.output), receipt, true);
  return summary(receipt);
}

function summary(receipt) {
  return { schema_version: 1, kind: receipt.kind, action: receipt.request.action, operation_id: receipt.request.operation_id, instance_id: receipt.request.target.instance_id, accepted_release_id: receipt.request.accepted.release_id, candidate_release_id: receipt.request.candidate.release_id, state: receipt.state, command_id: receipt.command_id, outcome: receipt.outcome };
}

function readReceipt(path, readSource) {
  const receipt = JSON.parse(privateFile(path).toString());
  exactKeys(receipt, ['schema_version', 'kind', 'request', 'request_sha256', 'parameters_sha256', 'state', 'command_id', 'outcome']);
  if (receipt.kind !== 'echo-staging-release-operation-v1' || receipt.schema_version !== 1 || !['planned', 'submitting', 'submitted', 'succeeded', 'failed', 'unconfirmed'].includes(receipt.state)) fail('receipt_invalid');
  const parameters = releaseSsmParameters(receipt.request, readSource);
  if (receipt.request_sha256 !== digest(jsonBytes(receipt.request)) || receipt.parameters_sha256 !== digest(jsonBytes(parameters))) fail('receipt_binding_mismatch');
  if (receipt.command_id !== null && !ID.test(receipt.command_id)) fail('command_id_invalid');
  if (receipt.outcome !== null) {
    safeReleaseOutcome(JSON.stringify(receipt.outcome), receipt.request, receipt.request_sha256);
    if ((receipt.state === 'succeeded') !== receipt.outcome.ok || !['succeeded', 'failed'].includes(receipt.state)) fail('receipt_outcome_invalid');
  } else if (['succeeded', 'failed'].includes(receipt.state)) fail('receipt_outcome_missing');
  return receipt;
}

export function safeReleaseOutcome(raw, request, requestHash) {
  let result;
  try { result = JSON.parse(raw); } catch { fail('remote_outcome_unproven'); }
  exactKeys(result, ['schema_version', 'kind', 'operation_id', 'request_sha256', 'action', 'ok', 'code', 'diagnostic']);
  const codes = ['installed', 'verified', 'wrapper_failed', 'environment_drift', 'precondition_failed', 'operation_locked', 'operation_incomplete', 'expired', 'delivery_pending', 'control_path_changed'];
  if (result.schema_version !== 1 || result.kind !== 'echo-staging-release-host-result-v1' || result.operation_id !== request.operation_id || result.request_sha256 !== requestHash || result.action !== request.action || typeof result.ok !== 'boolean' || !codes.includes(result.code)) fail('remote_outcome_unproven');
  if (result.ok !== ['installed', 'verified'].includes(result.code)) fail('remote_outcome_unproven');
  if (result.diagnostic !== null) {
    const bools = ['candidate_staged', 'environment_matches', 'other_bytes_changed', 'allowlisted_settings_valid', 'environment_format_supported', 'repair_pending', 'repair_eligible', 'runtime_checked'];
    exactKeys(result.diagnostic, ['schema_version', 'kind', 'release_id', 'changed_settings', ...bools]);
    const diag = result.diagnostic;
    if (request.action !== 'diagnose' || diag.kind !== 'echo-clean-v1-environment-drift' || diag.schema_version !== 1 || ![request.accepted.release_id, request.candidate.release_id].includes(diag.release_id) || bools.some(key => typeof diag[key] !== 'boolean') || diag.runtime_checked !== false || ![canonicalJson([]), canonicalJson(['ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1'])].includes(canonicalJson(diag.changed_settings))) fail('remote_outcome_unproven');
  }
  if (result.ok && request.action === 'diagnose' && result.diagnostic === null) fail('remote_outcome_unproven');
  return result;
}

function pollReceipt(path, receipt, aws) {
  if (['succeeded', 'failed'].includes(receipt.state)) return summary(receipt);
  if (receipt.command_id === null) {
    // SendCommand has no idempotency token. Never automatically re-send after
    // a lost response; reconcile the exact unique comment on the original host.
    const listed = aws(['ssm', 'list-commands', '--instance-id', receipt.request.target.instance_id, '--filters', `Key=InvokedAfter,Values=${new Date(receipt.request.created_at * 1000).toISOString()}`]);
    const matches = (listed.Commands ?? []).filter(item => item.Comment === `echo-release:${receipt.request.operation_id}` && item.DocumentName === 'AWS-RunShellScript' && same(item.InstanceIds, [receipt.request.target.instance_id]));
    if (matches.length > 1) fail('multiple_submissions_unconfirmed');
    if (matches.length === 0) return summary(receipt);
    if (!ID.test(matches[0].CommandId)) fail('command_id_invalid');
    receipt.command_id = matches[0].CommandId;
    receipt.state = 'submitted';
    save(path, receipt);
  }
  let response;
  try { response = aws(['ssm', 'get-command-invocation', '--command-id', receipt.command_id, '--instance-id', receipt.request.target.instance_id]); }
  catch { return summary(receipt); }
  if (response.Status === 'Success') {
    receipt.outcome = safeReleaseOutcome(response.StandardOutputContent, receipt.request, receipt.request_sha256);
    receipt.state = receipt.outcome.ok ? 'succeeded' : 'failed';
    save(path, receipt);
  } else if (TERMINAL.includes(response.Status)) {
    // A timeout, cancel, or failure does not prove that a child/runtime stopped.
    receipt.state = 'unconfirmed';
    save(path, receipt);
  }
  return summary(receipt);
}

export function executeStagingRelease(pathname, dependencies = {}, pollOnly = false) {
  const { aws = awsJson, readSource = sourceFile, runtime = reviewedRuntime, now = Date.now } = dependencies;
  const path = resolve(pathname);
  return withReceiptLock(path, () => {
    const receipt = readReceipt(path, readSource);
    if (pollOnly || receipt.state !== 'planned') {
      if (receipt.state === 'planned') return summary(receipt);
      return pollReceipt(path, receipt, aws);
    }
    if (runtime() !== receipt.request.tooling_source) fail('exact_reviewed_runtime_required');
    if (receipt.request.schema_version !== 2) fail('legacy_plan_execution_refused');
    if (Math.floor(now() / 1000) > receipt.request.expires_at) fail('plan_expired');
    if (!same(stagingReleaseTarget(aws), receipt.request.target)) fail('staging_target_changed');
    const parameters = releaseSsmParameters(receipt.request, readSource);
    receipt.state = 'submitting';
    save(path, receipt);
    let sent;
    try {
      sent = aws(['ssm', 'send-command', '--instance-ids', receipt.request.target.instance_id,
        '--document-name', 'AWS-RunShellScript', '--timeout-seconds', '300', '--max-concurrency', '1', '--max-errors', '0',
        '--comment', `echo-release:${receipt.request.operation_id}`, '--parameters', JSON.stringify(parameters),
        '--cloud-watch-output-config', 'CloudWatchOutputEnabled=false']);
    } catch { return summary(receipt); }
    if (!ID.test(sent.Command?.CommandId)) return summary(receipt);
    receipt.command_id = sent.Command.CommandId;
    receipt.state = 'submitted';
    save(path, receipt);
    return pollReceipt(path, receipt, aws);
  });
}

function main(argv) {
  const command = argv.shift();
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(options, argv[i])) fail('arguments_invalid');
    options[argv[i]] = argv[i + 1];
  }
  if (command === 'plan') {
    const required = ['--action', '--accepted-release', '--release', '--runtime-profile', '--output'];
    const allowed = [...required, '--previous-tooling-source', '--content-telemetry', '--approval'];
    if (required.some(key => !options[key]) || Object.keys(options).some(key => !allowed.includes(key))) fail('arguments_invalid');
    return planStagingRelease({ action: options['--action'], acceptedRelease: options['--accepted-release'], release: options['--release'], runtimeProfile: options['--runtime-profile'], output: options['--output'], previousToolingSource: options['--previous-tooling-source'], contentTelemetry: options['--content-telemetry'], approval: options['--approval'] });
  }
  if (!['execute', 'status'].includes(command) || !same(Object.keys(options), ['--receipt'])) fail('arguments_invalid');
  return executeStagingRelease(options['--receipt'], {}, command === 'status');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Validators, AWS and filesystem errors can contain input values/paths.
    const safe = /^[a-z][a-z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : 'release_operation_refused';
    process.stderr.write(`${JSON.stringify({ ok: false, code: safe })}\n`);
    process.exitCode = 1;
  }
}
