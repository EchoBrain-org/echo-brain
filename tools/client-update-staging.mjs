#!/usr/bin/env node

// Dedicated, bounded CloudFormation lane for the signed CLI-update staging
// feed.  It intentionally has no Authority, SSM, IAM, or arbitrary S3 path.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awsCliArguments, sanitizedAwsEnvironment } from './authority-staging-onboarding-transfer.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '904560150024';
const REGION = 'us-west-2';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BUCKET_RESOURCES = Object.freeze([
  ['FeedBucket', 'AWS::S3::Bucket'],
  ['FeedBucketPolicy', 'AWS::S3::BucketPolicy'],
]);
const HOSTING = Object.freeze(Object.fromEntries([
  ['cloudfront', 'echo-client-update-staging-v1', 'staging-feed-v1.template.json', 'echo-client-update-staging-feed-operation-v1', 'echo-client-update-staging-', [
    ...BUCKET_RESOURCES,
    ['FeedDistribution', 'AWS::CloudFront::Distribution'],
    ['FeedOriginAccessControl', 'AWS::CloudFront::OriginAccessControl'],
    ['FeedCachePolicy', 'AWS::CloudFront::CachePolicy'],
  ]],
  ['s3', 'echo-client-update-staging-s3-v1', 'staging-feed-s3-v1.template.json', 'echo-client-update-staging-s3-feed-operation-v1', 'echo-client-update-staging-s3-', BUCKET_RESOURCES],
].map(([name, stack, file, kind, prefix, expected]) => [name, Object.freeze({
  name, stack, template: resolve(REPO, 'deploy/client-updates', file), kind, prefix, expected,
  changeSet: new RegExp(`^arn:aws:cloudformation:${REGION}:${ACCOUNT}:changeSet/${prefix}[0-9a-f-]{36}/[a-f0-9-]{36}$`),
  changeSetName: new RegExp(`^${prefix}[0-9a-f-]{36}$`),
  stackId: new RegExp(`^arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stack}/[a-f0-9-]{36}$`),
})])));
const fail = code => { throw new Error(code); };
const hostingLane = name => Object.hasOwn(HOSTING, name) ? HOSTING[name] : fail('hosting_invalid');
const receiptLane = receipt => Object.values(HOSTING).find(lane => lane.kind === receipt?.kind) ?? fail('receipt_invalid');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const jsonBytes = value => Buffer.from(`${canonical(value)}\n`);

function git(args) {
  try { return execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }); }
  catch { fail('reviewed_source_unavailable'); }
}

// Planning can prepare a reviewable change set from a clean committed branch.
// Execution rechecks that exact commit after it has merged into origin/main.
function planningRuntime() {
  if (git(['status', '--porcelain=v1', '--untracked-files=all']).length !== 0) fail('reviewed_clean_checkout_required');
  const commit = git(['rev-parse', 'HEAD']).toString('utf8').trim();
  if (!COMMIT.test(commit)) fail('reviewed_source_unavailable');
  return commit;
}

function executionRuntime() {
  const commit = planningRuntime();
  git(['fetch', '--quiet', 'origin', 'main']);
  git(['merge-base', '--is-ancestor', commit, 'origin/main']);
  return commit;
}

function privateDirectory(path) {
  const absolute = resolve(path);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) fail('private_directory_required');
  const real = realpathSync(absolute);
  if (real === REPO || real.startsWith(`${REPO}/`)) fail('receipt_inside_checkout');
  return absolute;
}

function privateFile(path, limit = 256 * 1024) {
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1 || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600 || state.size <= 0 || state.size > limit) fail('private_file_required');
  return readFileSync(path);
}

function save(path, value, fresh = false) {
  const absolute = resolve(path);
  privateDirectory(dirname(absolute));
  if (!fresh) privateFile(absolute);
  if (fresh && existsSync(absolute)) fail('receipt_destination_exists');
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  const fd = openSync(fresh ? absolute : temporary, 'wx', 0o600);
  try { writeFileSync(fd, jsonBytes(value)); fsyncSync(fd); } finally { closeSync(fd); }
  if (!fresh) renameSync(temporary, absolute);
  const parent = openSync(dirname(absolute), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function withLock(path, action) {
  privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('receipt_locked'); }
  try { return action(); } finally { rmdirSync(lock); }
}

function defaultAws(args) {
  try {
    const stdout = execFileSync('aws', awsCliArguments([...args, '--region', REGION, '--output', 'json']), {
      env: { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 1024 * 1024,
    });
    return stdout ? JSON.parse(stdout) : {};
  } catch (error) {
    // A missing staging-feed stack is the one expected "not found" outcome:
    // planning it creates a CREATE change set. Every other AWS error remains
    // unconfirmed instead of being mistaken for an empty account.
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks' && /does not exist/i.test(String(error?.stderr ?? ''))) return { Stacks: [] };
    if (args[0] === 'cloudformation' && args[1] === 'describe-change-set' && /does not exist/i.test(String(error?.stderr ?? ''))) return { Status: 'NOT_FOUND' };
    if (args[0] === 's3control' && args[1] === 'get-public-access-block' && /\(NoSuchPublicAccessBlockConfiguration\)/.test(String(error?.stderr ?? ''))) return { PublicAccessBlockConfiguration: null };
    fail('aws_operation_unconfirmed');
  }
}

function defaultAwsNoOutput(args) {
  try {
    execFileSync('aws', awsCliArguments([...args, '--region', REGION]), {
      env: { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' },
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 45_000,
    });
  } catch { fail('aws_operation_unconfirmed'); }
}

function templateBytes(lane, readTemplate = () => readFileSync(lane.template)) {
  const bytes = readTemplate();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 51_200) fail('template_unreadable');
  try { JSON.parse(bytes.toString('utf8')); } catch { fail('template_unreadable'); }
  return bytes;
}

function templateHash(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : JSON.stringify(value);
  try { return sha256(Buffer.from(canonical(JSON.parse(text)))); } catch { fail('template_unreadable'); }
}

function account(aws) {
  const identity = aws(['sts', 'get-caller-identity']);
  const pattern = new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_[A-Za-z0-9_]+/[^/]+$`);
  if (identity?.Account !== ACCOUNT || typeof identity?.Arn !== 'string' || !pattern.test(identity.Arn)) fail('echo_prod_sso_required');
}

function accountPublicAccess(lane, aws) {
  if (lane.name !== 's3') return;
  const response = aws(['s3control', 'get-public-access-block', '--account-id', ACCOUNT]);
  const configuration = response?.PublicAccessBlockConfiguration;
  // Only the explicit NoSuchPublicAccessBlockConfiguration result is absent.
  // ACL restrictions can stay enabled; this lane relies only on bucket policy.
  if (configuration === null) return;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
      ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].some(key => typeof configuration[key] !== 'boolean')) fail('account_public_access_check_unconfirmed');
  if (configuration.BlockPublicPolicy || configuration.RestrictPublicBuckets) fail('account_public_access_blocks_s3_feed');
}

function stackDescription(lane, aws) {
  const response = aws(['cloudformation', 'describe-stacks', '--stack-name', lane.stack]);
  if (!Array.isArray(response?.Stacks)) fail('staging_stack_invalid');
  if (response.Stacks.length === 0) return null;
  const stack = response.Stacks[0];
  if (response.Stacks.length !== 1 || !lane.stackId.test(stack.StackId ?? '')) fail('staging_stack_invalid');
  return stack;
}

function stableOutputs(lane, stack) {
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(item => [item.OutputKey, item.OutputValue]));
  const bucket = outputs.BucketName;
  const distribution = outputs.DistributionId;
  const feed = outputs.FeedUrl;
  if (lane.name === 's3') {
    // Dotted bucket names cannot use S3's wildcard HTTPS certificate. Require
    // the literal regional REST URL, rejecting normalization and other origins.
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
        (distribution !== undefined && distribution !== null) || feed !== `https://${bucket}.s3.${REGION}.amazonaws.com/feed.json`) fail('staging_outputs_invalid');
    return { bucket_name: bucket, distribution_id: null, feed_url: feed };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') || !/^[A-Z0-9]{13,20}$/.test(distribution ?? '')) fail('staging_outputs_invalid');
  let url;
  try { url = new URL(feed); } catch { fail('staging_outputs_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/feed.json' || !/^[a-z0-9]+\.cloudfront\.net$/.test(url.hostname)) fail('staging_outputs_invalid');
  return { bucket_name: bucket, distribution_id: distribution, feed_url: url.href };
}

function expectedChanges(lane, changes, action) {
  const actual = (changes ?? []).map(change => [change?.ResourceChange?.LogicalResourceId, change?.ResourceChange?.ResourceType, change?.ResourceChange?.Action]);
  const wantedAction = action === 'CREATE' ? 'Add' : undefined;
  if (actual.length !== lane.expected.length || new Set(actual.map(item => item[0])).size !== lane.expected.length) fail('change_set_boundary_violation');
  for (const [logicalId, type] of lane.expected) {
    const entry = actual.find(item => item[0] === logicalId);
    if (!entry || entry[1] !== type || (wantedAction && entry[2] !== wantedAction) || (!wantedAction && !['Add', 'Modify'].includes(entry[2]))) fail('change_set_boundary_violation');
  }
  return actual.map(([logical_id, resource_type, action_name]) => ({ logical_id, resource_type, action: action_name })).sort((a, b) => a.logical_id.localeCompare(b.logical_id));
}

function changeSetName(lane, operationId) { return `${lane.prefix}${operationId}`; }
function clientToken(purpose, value) { return `echo-client-update-${purpose}-${sha256(value).slice(0, 44)}`; }

function createChangeSet({ lane, aws, awsNoOutput, operationId }) {
  account(aws);
  const stack = stackDescription(lane, aws);
  // This lane deliberately provisions a single new feed stack. Supporting an
  // update requires an explicit new review of the prior resource inventory.
  if (stack) fail('staging_feed_stack_already_exists');
  const type = 'CREATE';
  const name = changeSetName(lane, operationId);
  awsNoOutput(['cloudformation', 'create-change-set', '--stack-name', lane.stack, '--change-set-name', name, '--change-set-type', type,
    '--client-token', clientToken('plan', `${lane.stack}:${name}`), '--template-body', `file://${lane.template}`]);
  return { name, type };
}

function readChangeSet(lane, name, aws) {
  const described = aws(['cloudformation', 'describe-change-set', '--stack-name', lane.stack, '--change-set-name', name]);
  if (described?.Status === 'NOT_FOUND') return null;
  if (['CREATE_PENDING', 'CREATE_IN_PROGRESS'].includes(described?.Status)) return { pending: true };
  if (described?.Status !== 'CREATE_COMPLETE' || typeof described.ChangeSetId !== 'string' || !lane.changeSet.test(described.ChangeSetId) || described.StackName !== lane.stack || typeof described.StackId !== 'string' || !lane.stackId.test(described.StackId)) fail('change_set_not_reviewable');
  return { id: described.ChangeSetId, stack_id: described.StackId, inventory: expectedChanges(lane, described.Changes, 'CREATE') };
}

function readReceipt(path) {
  let receipt;
  try { receipt = JSON.parse(privateFile(path).toString('utf8')); } catch { fail('receipt_invalid'); }
  const lane = receiptLane(receipt);
  const keys = ['schema_version', 'kind', 'operation_id', 'source_sha', 'template_sha256', 'account', 'region', 'stack_name', 'change_set_name', 'change_set_id', 'stack_id', 'change_set_type', 'inventory', 'state', 'outputs'];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || canonical(Object.keys(receipt).sort()) !== canonical(keys.sort()) ||
      receipt.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(receipt.operation_id) || !COMMIT.test(receipt.source_sha) || !SHA.test(receipt.template_sha256) ||
      receipt.account !== ACCOUNT || receipt.region !== REGION || receipt.stack_name !== lane.stack || receipt.change_set_name !== changeSetName(lane, receipt.operation_id) || !lane.changeSetName.test(receipt.change_set_name) ||
      !['planning', 'planned', 'executing', 'succeeded', 'unconfirmed'].includes(receipt.state) || (receipt.state === 'planning' ? (receipt.change_set_id !== null || receipt.stack_id !== null || receipt.change_set_type !== null || receipt.inventory !== null) :
        (!lane.changeSet.test(receipt.change_set_id) || !lane.stackId.test(receipt.stack_id) || receipt.change_set_type !== 'CREATE' || !Array.isArray(receipt.inventory) || receipt.inventory.some(item => !item || item.action !== 'Add') || canonical(receipt.inventory) !== canonical([...receipt.inventory].sort((a, b) => String(a.logical_id).localeCompare(String(b.logical_id)))) || canonical(receipt.inventory.map(item => [item.logical_id, item.resource_type]).sort()) !== canonical(lane.expected.map(item => [...item]).sort()))) ||
      (receipt.state === 'succeeded' ? receipt.outputs === null : receipt.outputs !== null)) fail('receipt_invalid');
  if (receipt.outputs !== null) {
    if (!receipt.outputs || typeof receipt.outputs !== 'object' || Array.isArray(receipt.outputs) || canonical(Object.keys(receipt.outputs).sort()) !== canonical(['bucket_name', 'distribution_id', 'feed_url'])) fail('receipt_invalid');
    stableOutputs(lane, { Outputs: [
      { OutputKey: 'BucketName', OutputValue: receipt.outputs.bucket_name },
      { OutputKey: 'DistributionId', OutputValue: receipt.outputs.distribution_id },
      { OutputKey: 'FeedUrl', OutputValue: receipt.outputs.feed_url },
    ] });
  }
  return receipt;
}

function describeBoundChangeSet(lane, receipt, aws) {
  account(aws);
  const value = aws(['cloudformation', 'describe-change-set', '--stack-name', lane.stack, '--change-set-name', receipt.change_set_id]);
  if (value?.ChangeSetId !== receipt.change_set_id || value?.StackName !== lane.stack || value?.StackId !== receipt.stack_id || value?.Status !== 'CREATE_COMPLETE' || expectedChanges(lane, value.Changes, receipt.change_set_type).some((item, index) => canonical(item) !== canonical(receipt.inventory[index]))) fail('change_set_changed');
  return value;
}

function remoteTemplateMatches(lane, receipt, aws) {
  const remote = aws(['cloudformation', 'get-template', '--stack-name', lane.stack, '--change-set-name', receipt.change_set_id, '--template-stage', 'Original']);
  if (remote?.TemplateBody === undefined || templateHash(remote.TemplateBody) !== receipt.template_sha256) fail('remote_template_binding_mismatch');
}

function predeployValidation(lane, receipt, aws) {
  // This newer CloudFormation API exposes Early Validation failures for the
  // exact change set. It is deliberately not describe-stack-events.
  let events;
  try { events = aws(['cloudformation', 'describe-events', '--stack-name', lane.stack, '--change-set-name', receipt.change_set_id, '--filters', 'FailedEvents=true']); }
  catch { fail('predeploy_validation_unavailable'); }
  if (!Array.isArray(events?.OperationEvents)) fail('predeploy_validation_unavailable');
  if (events.OperationEvents.length !== 0) fail('predeploy_validation_failed');
}

function summary(receipt) {
  return { schema_version: 1, kind: receipt.kind, operation_id: receipt.operation_id, state: receipt.state, change_set_id: receipt.change_set_id, feed_url: receipt.outputs?.feed_url ?? null };
}

export function planClientUpdateStaging({ output, hosting = 'cloudfront' }, dependencies = {}) {
  const lane = hostingLane(hosting);
  const runtime = dependencies.runtime ?? planningRuntime;
  const aws = dependencies.aws ?? defaultAws;
  const awsNoOutput = dependencies.awsNoOutput ?? defaultAwsNoOutput;
  const template = templateBytes(lane, dependencies.readTemplate);
  const destination = resolve(output);
  privateDirectory(dirname(destination));
  const operationId = dependencies.operationId ?? randomUUID();
  const source = runtime();
  if (!COMMIT.test(source)) fail('reviewed_source_unavailable');
  const fresh = !existsSync(destination);
  let receipt;
  if (!fresh) {
    receipt = readReceipt(destination);
    if (receipt.kind !== lane.kind || receipt.source_sha !== source || receipt.template_sha256 !== templateHash(template) || receipt.state !== 'planning') fail('receipt_destination_exists');
  } else {
    receipt = { schema_version: 1, kind: lane.kind, operation_id: operationId, source_sha: source,
      template_sha256: templateHash(template), account: ACCOUNT, region: REGION, stack_name: lane.stack, change_set_name: changeSetName(lane, operationId),
      change_set_id: null, stack_id: null, change_set_type: null, inventory: null, state: 'planning', outputs: null };
  }
  account(aws);
  accountPublicAccess(lane, aws);
  if (fresh) save(destination, receipt, true);
  const existing = readChangeSet(lane, receipt.change_set_name, aws);
  if (existing?.pending) return summary(receipt);
  if (existing === null) createChangeSet({ lane, aws, awsNoOutput, operationId: receipt.operation_id });
  const change = readChangeSet(lane, receipt.change_set_name, aws);
  if (change === null || change.pending) return summary(receipt);
  receipt.change_set_id = change.id;
  receipt.stack_id = change.stack_id;
  receipt.change_set_type = 'CREATE';
  receipt.inventory = change.inventory;
  remoteTemplateMatches(lane, receipt, aws);
  predeployValidation(lane, receipt, aws);
  receipt.state = 'planned';
  save(destination, receipt);
  return summary(receipt);
}

export function executeClientUpdateStaging({ receipt: receiptPath, approveChangeSet }, dependencies = {}) {
  const runtime = dependencies.runtime ?? executionRuntime;
  const aws = dependencies.aws ?? defaultAws;
  const awsNoOutput = dependencies.awsNoOutput ?? defaultAwsNoOutput;
  const path = resolve(receiptPath);
  return withLock(path, () => {
    const receipt = readReceipt(path);
    const lane = receiptLane(receipt);
    if (approveChangeSet !== receipt.change_set_id) fail('exact_change_set_approval_required');
    if (receipt.state === 'succeeded') return summary(receipt);
    if (receipt.state === 'unconfirmed') fail('operation_unconfirmed');
    if (runtime() !== receipt.source_sha) fail('exact_reviewed_runtime_required');
    const template = templateBytes(lane, dependencies.readTemplate);
    if (templateHash(template) !== receipt.template_sha256) fail('template_changed');
    if (receipt.state === 'planned') {
      describeBoundChangeSet(lane, receipt, aws);
      remoteTemplateMatches(lane, receipt, aws);
      accountPublicAccess(lane, aws);
      receipt.state = 'executing'; save(path, receipt);
      try { awsNoOutput(['cloudformation', 'execute-change-set', '--change-set-name', receipt.change_set_id, '--client-request-token', clientToken('execute', receipt.change_set_id)]); }
      catch { return summary(receipt); }
    }
    return statusReceipt(path, receipt, aws);
  });
}

function statusReceipt(path, receipt, aws) {
  const lane = receiptLane(receipt);
  account(aws);
  let stack;
  try { stack = stackDescription(lane, aws); } catch { receipt.state = 'unconfirmed'; save(path, receipt); return summary(receipt); }
  if (!stack) { receipt.state = 'unconfirmed'; save(path, receipt); return summary(receipt); }
  if (['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'REVIEW_IN_PROGRESS'].includes(stack.StackStatus)) return summary(receipt);
  if (stack.StackId !== receipt.stack_id) { receipt.state = 'unconfirmed'; save(path, receipt); return summary(receipt); }
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) { receipt.state = 'unconfirmed'; save(path, receipt); return summary(receipt); }
  try { receipt.outputs = stableOutputs(lane, stack); receipt.state = 'succeeded'; save(path, receipt); }
  catch { receipt.state = 'unconfirmed'; save(path, receipt); }
  return summary(receipt);
}

export function statusClientUpdateStaging({ receipt: receiptPath }, dependencies = {}) {
  const aws = dependencies.aws ?? defaultAws;
  const path = resolve(receiptPath);
  return withLock(path, () => {
    const receipt = readReceipt(path);
    if (receipt.state === 'planning' || receipt.state === 'planned' || receipt.state === 'succeeded') return summary(receipt);
    return statusReceipt(path, receipt, aws);
  });
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || !rest[index + 1] || rest[index + 1].startsWith('--') || Object.hasOwn(options, rest[index])) fail('arguments_invalid');
    options[rest[index]] = rest[index + 1];
  }
  if (command === 'plan' && canonical(Object.keys(options).sort()) === canonical(['--output'])) return planClientUpdateStaging({ output: options['--output'] });
  if (command === 'plan' && canonical(Object.keys(options).sort()) === canonical(['--hosting', '--output'])) return planClientUpdateStaging({ output: options['--output'], hosting: options['--hosting'] });
  if (command === 'execute' && canonical(Object.keys(options).sort()) === canonical(['--approve-change-set', '--receipt'])) return executeClientUpdateStaging({ receipt: options['--receipt'], approveChangeSet: options['--approve-change-set'] });
  if (command === 'status' && canonical(Object.keys(options).sort()) === canonical(['--receipt'])) return statusClientUpdateStaging({ receipt: options['--receipt'] });
  fail('arguments_invalid');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: /^[a-z][a-z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : 'staging_feed_operation_refused' })}\n`); process.exitCode = 1; }
}
