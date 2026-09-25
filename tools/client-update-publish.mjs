#!/usr/bin/env node

// Exact approved files into the dedicated S3 feed. The original first
// publication lane never overwrites; the separate replacement lane below binds
// the current signed feed and uses S3 If-Match for its one permitted overwrite.
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awsCliArguments, sanitizedAwsEnvironment } from './authority-staging-onboarding-transfer.mjs';
import { canonicalJson } from './clean-v1-release.mjs';
import { validateSealedClientUpdateFeed } from './client-update-feed.mjs';
import { UPDATE_ARTIFACT_LIMIT, UPDATE_METADATA_LIMIT, verifyUpdateEnvelope } from '../src/product/person-client/dist/client-update-contract.js';

const REPO = resolve(import.meta.dirname, '..');
const ACCOUNT = '904560150024';
const REGION = 'us-west-2';
const STACK = 'echo-client-update-staging-s3-v1';
const KIND = 'echo-client-update-first-publication-v1';
const REPLACEMENT_KIND = 'echo-client-update-feed-replacement-v1';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ETAG = /^"[a-f0-9]{32}"$/;
const STACK_ID = new RegExp(`^arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${STACK}/[a-f0-9-]{36}$`);
const INVENTORY = [{ action: 'Add', logical_id: 'FeedBucket', resource_type: 'AWS::S3::Bucket' }, { action: 'Add', logical_id: 'FeedBucketPolicy', resource_type: 'AWS::S3::BucketPolicy' }];
// Each reserve is checked after the preflight HEAD: the remaining PUT,
// verification HEAD, and public GET are capped at 120 seconds each, followed
// by a two-minute scheduling cushion.
const OBJECT_PUBLICATION_WINDOW_MS = 8 * 60 * 1000;
// The first write reserves the full maximum two-artifact publication window.
// Its preflight HEAD has completed, leaving eleven bounded 120-second
// operations plus one 120-second scheduling cushion before the feed verifies.
const INITIAL_PUBLICATION_WINDOW_MS = 24 * 60 * 1000;
const fail = code => { throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const templateHash = value => digest(canonicalJson(typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(value.toString()) : value));

function runtime() {
  try {
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO, maxBuffer: 1024 * 1024 }).length) fail('reviewed_clean_checkout_required');
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    if (!COMMIT.test(source)) fail('reviewed_source_unavailable');
    return source;
  } catch { fail('reviewed_clean_checkout_required'); }
}
function absolute(path) { if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('absolute_path_required'); return path; }
function privateDirectory(path) {
  absolute(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('private_directory_required');
  const real = realpathSync(path);
  if (real === REPO || real.startsWith(`${REPO}/`)) fail('private_state_outside_checkout_required');
}
function read(path, limit = UPDATE_METADATA_LIMIT) {
  absolute(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > limit) fail('private_file_required');
  return readFileSync(path);
}
function save(path, value, fresh = false) {
  privateDirectory(dirname(path));
  if (!fresh) read(path);
  if (fresh && existsSync(path)) fail('receipt_destination_exists');
  const destination = fresh ? path : `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(destination, 'wx', 0o600);
  try { writeFileSync(descriptor, `${canonicalJson(value)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  if (!fresh) renameSync(destination, path);
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
async function locked(path, action) {
  privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch { fail('receipt_locked'); }
  try { return await action(); } finally { rmdirSync(lock); }
}
export function isAbsentClientUpdateHead(args, stderr) {
  return args[0] === 's3api' && args[1] === 'head-object' &&
    /^An error occurred \((404|NoSuchKey)\) when calling the HeadObject operation(?: \(reached max retries: [0-9]+\))?: [^\r\n]+$/.test(String(stderr ?? '').trim());
}
function defaultAws(args) {
  try {
    const output = execFileSync('aws', awsCliArguments([...args, '--region', REGION, '--output', 'json']), {
      env: { ...sanitizedAwsEnvironment(), AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return output ? JSON.parse(output) : {};
  } catch (error) {
    // An authenticated 403 is never evidence that an object is absent.
    if (isAbsentClientUpdateHead(args, error?.stderr)) return { absent: true };
    fail('aws_operation_unconfirmed');
  }
}
function account(aws) {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity?.Account !== ACCOUNT || !new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_[A-Za-z0-9_]+/[^/]+$`).test(identity?.Arn ?? '')) fail('echo_prod_sso_required');
}
function hosting(path, aws, readTemplate) {
  const bytes = read(path);
  const receipt = JSON.parse(bytes);
  const bucket = receipt.outputs?.bucket_name;
  if (receipt.schema_version !== 1 || receipt.kind !== 'echo-client-update-staging-s3-feed-operation-v1' || receipt.state !== 'succeeded' || receipt.account !== ACCOUNT || receipt.region !== REGION || receipt.stack_name !== STACK || !STACK_ID.test(receipt.stack_id ?? '') || !COMMIT.test(receipt.source_sha ?? '') || !SHA.test(receipt.template_sha256 ?? '') || !equal(receipt.inventory, INVENTORY) || receipt.outputs?.distribution_id !== null || !new RegExp(`^${STACK}-feedbucket-[a-z0-9]{12}$`).test(bucket ?? '') || receipt.outputs.feed_url !== `https://${bucket}.s3.${REGION}.amazonaws.com/feed.json`) fail('succeeded_s3_hosting_required');
  const hash = templateHash(readTemplate());
  if (receipt.template_sha256 !== hash) fail('hosting_template_mismatch');
  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', receipt.stack_id]);
  if (stack?.Stacks?.length !== 1 || stack.Stacks[0].StackId !== receipt.stack_id || stack.Stacks[0].StackName !== STACK || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.Stacks[0].StackStatus)) fail('hosting_stack_mismatch');
  const outputs = stack.Stacks[0].Outputs;
  if (!Array.isArray(outputs) || outputs.length !== 2 || !equal(Object.fromEntries(outputs.map(item => [item.OutputKey, item.OutputValue])), { BucketName: bucket, FeedUrl: receipt.outputs.feed_url })) fail('hosting_outputs_mismatch');
  const remote = aws(['cloudformation', 'get-template', '--stack-name', receipt.stack_id, '--template-stage', 'Original']);
  if (!remote?.TemplateBody || templateHash(remote.TemplateBody) !== hash) fail('hosting_template_mismatch');
  const resources = aws(['cloudformation', 'list-stack-resources', '--stack-name', receipt.stack_id]);
  if (!Array.isArray(resources?.StackResourceSummaries) || resources.NextToken || resources.StackResourceSummaries.length !== 2 || !equal(resources.StackResourceSummaries.map(item => [item.LogicalResourceId, item.ResourceType]).sort(), INVENTORY.map(item => [item.logical_id, item.resource_type]).sort()) || resources.StackResourceSummaries.some(item => !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(item.ResourceStatus)) || resources.StackResourceSummaries.find(item => item.LogicalResourceId === 'FeedBucket').PhysicalResourceId !== bucket || resources.StackResourceSummaries.find(item => item.LogicalResourceId === 'FeedBucketPolicy').PhysicalResourceId !== bucket) fail('hosting_resources_mismatch');
  const versioning = aws(['s3api', 'get-bucket-versioning', '--bucket', bucket, '--expected-bucket-owner', ACCOUNT]);
  if (versioning?.Status !== 'Enabled') fail('hosting_versioning_required');
  return { receipt_sha256: digest(bytes), stack_id: receipt.stack_id, template_sha256: hash, bucket, feed_url: receipt.outputs.feed_url };
}
function preparedInputs(prepared, authorizationPath, validatePrepared, validation = {}) {
  privateDirectory(prepared);
  privateDirectory(join(prepared, 'artifacts'));
  const validated = validatePrepared({ prepared, authorizationPath, ...validation });
  const { config, manifest } = validated;
  const files = ['bootstrap-config.json', 'manifest.json', 'release.json', 'feed.json'];
  const hashes = Object.fromEntries(files.map(file => [file, digest(read(join(prepared, file)))]));
  hashes.authorization = digest(read(authorizationPath));
  const feed = read(join(prepared, 'feed.json'));
  if (!Buffer.isBuffer(validated.feedBytes) || !feed.equals(validated.feedBytes)) fail('validated_feed_mismatch');
  const objects = manifest.artifacts.map(artifact => {
    const key = `artifacts/${artifact.sha256}.zip`;
    const bytes = read(join(prepared, key), UPDATE_ARTIFACT_LIMIT);
    if (!SHA.test(artifact.sha256) || bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256 || artifact.url !== new URL(key, config.feed_url).href) fail('artifact_binding_mismatch');
    return { key, sha256: artifact.sha256, bytes: artifact.bytes, content_type: 'application/zip', cache_control: 'public, max-age=31536000, immutable' };
  });
  if (!objects.length || objects.length > 2 || new Set(objects.map(item => item.key)).size !== objects.length) fail('publication_inventory_invalid');
  objects.push({ key: 'feed.json', sha256: digest(feed), bytes: feed.length, content_type: 'application/json', cache_control: 'no-store' });
  return { config, manifest, hashes, objects };
}
function deps(dependencies) {
  return { aws: dependencies.aws ?? defaultAws, runtime: dependencies.runtime ?? runtime, fetch: dependencies.fetch ?? globalThis.fetch, now: dependencies.now ?? Date.now, validatePrepared: dependencies.validatePrepared ?? validateSealedClientUpdateFeed, readTemplate: dependencies.readTemplate ?? (() => readFileSync(join(REPO, 'deploy/client-updates/staging-feed-s3-v1.template.json'))) };
}
function head(aws, bucket, key) { return aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--expected-bucket-owner', ACCOUNT]); }
function absent(aws, bucket, key) { const observed = head(aws, bucket, key); if (!equal(observed, { absent: true })) fail('first_publication_object_already_exists'); }
function currentTime(d) { const now = d.now(); if (!Number.isFinite(now)) fail('clock_unavailable'); return now; }
function metadataFresh(inputs, d) { return Date.parse(inputs.manifest.expires_at) > currentTime(d); }
function summary(receipt, inputs, d) { return { kind: KIND, operation_id: receipt.operation_id, state: receipt.state, manifest_sha256: receipt.hashes['manifest.json'], feed_url: receipt.hosting.feed_url, release_id: receipt.release_id, verified_objects: receipt.objects.filter(item => item.verified).length, object_count: receipt.objects.length, metadata_fresh: metadataFresh(inputs, d) }; }
function objectIdentity(item) { return { key: item.key, sha256: item.sha256, bytes: item.bytes, content_type: item.content_type, cache_control: item.cache_control }; }
function readReceipt(path) {
  const receipt = JSON.parse(read(path));
  if (receipt?.schema_version !== 1 || receipt.kind !== KIND || !/^[a-f0-9-]{36}$/.test(receipt.operation_id ?? '') || !COMMIT.test(receipt.source_sha ?? '') || !['planned', 'publishing', 'succeeded', 'unconfirmed'].includes(receipt.state) || !Array.isArray(receipt.objects) || !receipt.objects.length || receipt.objects.length > 3 || receipt.objects.some(item => typeof item.attempted !== 'boolean' || typeof item.succeeded !== 'boolean' || typeof item.verified !== 'boolean' || (item.succeeded && !item.attempted) || (item.verified && !item.succeeded) || (item.version_id !== null && (typeof item.version_id !== 'string' || !item.version_id || item.version_id === 'null')))) fail('publication_receipt_invalid');
  return receipt;
}
function boundInputs(receipt, d, { allowExpired = false } = {}) {
  if (d.runtime() !== receipt.source_sha) fail('exact_reviewed_runtime_required');
  account(d.aws);
  const currentHosting = hosting(receipt.hosting_receipt, d.aws, d.readTemplate);
  if (!equal(currentHosting, receipt.hosting)) fail('hosting_receipt_changed');
  const inputs = preparedInputs(receipt.prepared, receipt.authorization, d.validatePrepared, { now: currentTime(d), allowExpired });
  if (inputs.config.feed_url !== currentHosting.feed_url || !equal(inputs.hashes, receipt.hashes) || inputs.manifest.release_id !== receipt.release_id || !equal(inputs.objects, receipt.objects.map(objectIdentity))) fail('publication_inputs_changed');
  return inputs;
}
function requirePublicationWindow(receipt, index, inputs, d) {
  const firstWrite = receipt.objects.every(object => !object.attempted);
  const remainingObjects = receipt.objects.slice(index).filter(object => !object.attempted).length;
  const required = firstWrite ? INITIAL_PUBLICATION_WINDOW_MS : remainingObjects * OBJECT_PUBLICATION_WINDOW_MS;
  if (Date.parse(inputs.manifest.expires_at) - currentTime(d) < required) fail('insufficient_metadata_validity');
}
function revalidateSealedInputs(receipt, d) {
  const refreshed = preparedInputs(receipt.prepared, receipt.authorization, d.validatePrepared, { now: currentTime(d) });
  if (refreshed.config.feed_url !== receipt.hosting.feed_url || !equal(refreshed.hashes, receipt.hashes) || refreshed.manifest.release_id !== receipt.release_id || !equal(refreshed.objects, receipt.objects.map(objectIdentity))) fail('publication_inputs_changed');
  return refreshed;
}
async function verifyObject(receipt, object, inputs, d, { allowExpired = false } = {}) {
  const observed = head(d.aws, receipt.hosting.bucket, object.key);
  if (observed?.absent || observed.ContentLength !== object.bytes || observed.ContentType !== object.content_type || observed.CacheControl !== object.cache_control || observed.ContentEncoding || observed.WebsiteRedirectLocation || observed.ServerSideEncryption !== 'AES256' || typeof observed.VersionId !== 'string' || !observed.VersionId || observed.VersionId === 'null' || (object.version_id !== null && object.version_id !== observed.VersionId)) fail('published_object_metadata_mismatch');
  const url = new URL(object.key, receipt.hosting.feed_url).href;
  const response = await d.fetch(url, { redirect: 'manual', headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || response.headers.get('content-encoding') || response.headers.get('content-length') !== String(object.bytes) || response.headers.get('content-type') !== object.content_type || response.headers.get('cache-control') !== object.cache_control || response.headers.get('x-amz-server-side-encryption') !== 'AES256' || response.headers.get('x-amz-version-id') !== observed.VersionId || !response.body) { await response.body?.cancel(); fail('public_object_headers_mismatch'); }
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > object.bytes || size > (object.key === 'feed.json' ? UPDATE_METADATA_LIMIT : UPDATE_ARTIFACT_LIMIT)) fail('public_object_size_mismatch');
      hash.update(value);
      if (object.key === 'feed.json') chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  if (size !== object.bytes || hash.digest('hex') !== object.sha256) fail('public_object_digest_mismatch');
  if (object.key === 'feed.json') {
    const expiresAt = Date.parse(inputs.manifest.expires_at);
    const verificationTime = allowExpired ? Math.min(currentTime(d), expiresAt - 1) : currentTime(d);
    verifyUpdateEnvelope(Buffer.concat(chunks), inputs.config, verificationTime);
  }
  object.version_id = observed.VersionId;
  object.succeeded = true;
  object.verified = true;
}

export async function planClientUpdatePublish({ hostingReceipt, prepared, authorization, output }, dependencies = {}) {
  absolute(output);
  const d = deps(dependencies);
  return locked(output, async () => {
    if (existsSync(output)) fail('receipt_destination_exists');
    const source = d.runtime();
    if (!COMMIT.test(source)) fail('reviewed_source_unavailable');
    account(d.aws);
    const host = hosting(absolute(hostingReceipt), d.aws, d.readTemplate);
    const inputs = preparedInputs(absolute(prepared), absolute(authorization), d.validatePrepared, { now: currentTime(d) });
    if (inputs.config.feed_url !== host.feed_url) fail('publication_feed_url_mismatch');
    // Check feed first. A new receipt cannot bypass an existing publication.
    absent(d.aws, host.bucket, 'feed.json');
    for (const object of inputs.objects.filter(item => item.key !== 'feed.json')) absent(d.aws, host.bucket, object.key);
    const receipt = { schema_version: 1, kind: KIND, operation_id: randomUUID(), source_sha: source, state: 'planned', hosting_receipt: hostingReceipt, prepared, authorization, hosting: host, hashes: inputs.hashes, release_id: inputs.manifest.release_id, objects: inputs.objects.map(item => ({ ...item, attempted: false, succeeded: false, verified: false, version_id: null })) };
    save(output, receipt, true);
    return summary(receipt, inputs, d);
  });
}

export async function executeClientUpdatePublish({ receipt: path, approveManifest }, dependencies = {}) {
  absolute(path);
  const d = deps(dependencies);
  return locked(path, async () => {
    const receipt = readReceipt(path);
    if (!SHA.test(approveManifest ?? '') || approveManifest !== receipt.hashes['manifest.json']) fail('exact_manifest_approval_required');
    if (receipt.state === 'unconfirmed') fail('publication_unconfirmed_use_status');
    let inputs = boundInputs(receipt, d);
    if (receipt.state === 'succeeded') return summary(receipt, inputs, d);
    try {
      for (const [index, object] of receipt.objects.entries()) {
        if (!object.attempted) {
          // Every artifact has just passed anonymous HTTPS verification before
          // the final feed PUT makes this release discoverable.
          absent(d.aws, receipt.hosting.bucket, object.key);
          const file = join(receipt.prepared, object.key);
          const bytes = read(file, object.key === 'feed.json' ? UPDATE_METADATA_LIMIT : UPDATE_ARTIFACT_LIMIT);
          if (bytes.length !== object.bytes || digest(bytes) !== object.sha256) fail('publication_inputs_changed');
          // The final feed is revalidated after its preflight HEAD and file
          // read, immediately before the sole conditional write makes it live.
          if (object.key === 'feed.json') inputs = revalidateSealedInputs(receipt, d);
          requirePublicationWindow(receipt, index, inputs, d);
          receipt.state = 'publishing'; object.attempted = true; save(path, receipt);
          const result = d.aws(['s3api', 'put-object', '--bucket', receipt.hosting.bucket, '--key', object.key, '--body', file, '--if-none-match', '*', '--expected-bucket-owner', ACCOUNT, '--server-side-encryption', 'AES256', '--content-type', object.content_type, '--cache-control', object.cache_control, '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(object.sha256, 'hex').toString('base64')]);
          if (result?.ServerSideEncryption !== 'AES256' || typeof result.VersionId !== 'string' || !result.VersionId || result.VersionId === 'null') fail('put_object_result_unconfirmed');
          object.succeeded = true; object.version_id = result.VersionId; save(path, receipt);
        }
        await verifyObject(receipt, object, inputs, d);
        save(path, receipt);
      }
      receipt.state = 'succeeded'; save(path, receipt);
    } catch { receipt.state = 'unconfirmed'; save(path, receipt); }
    return summary(receipt, inputs, d);
  });
}

export async function statusClientUpdatePublish({ receipt: path }, dependencies = {}) {
  absolute(path);
  const d = deps(dependencies);
  return locked(path, async () => {
    const receipt = readReceipt(path);
    const inputs = boundInputs(receipt, d, { allowExpired: true });
    try {
      for (const object of receipt.objects) {
        if (object.attempted) { await verifyObject(receipt, object, inputs, d, { allowExpired: true }); save(path, receipt); }
        else absent(d.aws, receipt.hosting.bucket, object.key);
      }
      receipt.state = receipt.objects.every(item => item.verified) ? 'succeeded' : receipt.objects.some(item => item.attempted) ? 'publishing' : 'planned';
    } catch { receipt.state = 'unconfirmed'; }
    save(path, receipt);
    return summary(receipt, inputs, d);
  });
}

// Replacement uses a distinct receipt kind. Existing first-publication
// receipts never acquire overwrite semantics when newer tooling reads them.
function replacementSummary(receipt, inputs, d) {
  const objects = [...receipt.artifacts, receipt.feed];
  return { kind: REPLACEMENT_KIND, operation_id: receipt.operation_id, state: receipt.state,
    manifest_sha256: receipt.hashes['manifest.json'], feed_url: receipt.hosting.feed_url,
    release_id: receipt.release_id, verified_objects: objects.filter(item => item.verified).length,
    object_count: objects.length, metadata_fresh: metadataFresh(inputs, d) };
}
function feedHeadIdentity(observed) {
  if (observed?.absent || !Number.isSafeInteger(observed.ContentLength) || observed.ContentLength <= 0 ||
      observed.ContentLength > UPDATE_METADATA_LIMIT || observed.ContentType !== 'application/json' ||
      observed.CacheControl !== 'no-store' || observed.ContentEncoding || observed.WebsiteRedirectLocation ||
      observed.ServerSideEncryption !== 'AES256' || typeof observed.VersionId !== 'string' ||
      !observed.VersionId || observed.VersionId === 'null' || !ETAG.test(observed.ETag ?? '')) fail('predecessor_feed_metadata_mismatch');
  return { version_id: observed.VersionId, etag: observed.ETag };
}
async function readPublicObject(host, key, observed, limit, d) {
  const url = new URL(key, host.feed_url).href;
  const response = await d.fetch(url, { redirect: 'manual', headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url) ||
      response.headers.get('content-encoding') || response.headers.get('content-length') !== String(observed.ContentLength) ||
      response.headers.get('content-type') !== observed.ContentType || response.headers.get('cache-control') !== observed.CacheControl ||
      response.headers.get('etag') !== observed.ETag || response.headers.get('x-amz-server-side-encryption') !== 'AES256' ||
      response.headers.get('x-amz-version-id') !== observed.VersionId || !response.body) {
    await response.body?.cancel(); fail('public_object_headers_mismatch');
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('public_object_size_mismatch');
      parts.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  if (size !== observed.ContentLength) fail('public_object_size_mismatch');
  return Buffer.concat(parts);
}
function historicalEnvelopeTime(raw, d) {
  let expiresAt;
  try {
    const envelope = JSON.parse(raw.toString('utf8'));
    expiresAt = Date.parse(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')).expires_at);
  } catch { fail('predecessor_feed_invalid'); }
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) fail('predecessor_feed_invalid');
  // Only the already-published predecessor is verified historically. The new
  // manifest remains strictly fresh before any replacement write.
  return Math.min(currentTime(d), expiresAt - 1);
}
async function observePredecessor(host, config, d) {
  const observed = head(d.aws, host.bucket, 'feed.json');
  const identity = feedHeadIdentity(observed);
  const raw = await readPublicObject(host, 'feed.json', observed, UPDATE_METADATA_LIMIT, d);
  let verified;
  try { verified = verifyUpdateEnvelope(raw, config, historicalEnvelopeTime(raw, d)); }
  catch { fail('predecessor_feed_invalid'); }
  return { key: 'feed.json', sha256: digest(raw), bytes: raw.length, ...identity,
    sequence: verified.manifest.sequence, channel: verified.manifest.channel };
}
function samePredecessor(left, right) {
  return left?.key === 'feed.json' && right?.key === 'feed.json' && left.sha256 === right.sha256 &&
    left.bytes === right.bytes && left.version_id === right.version_id && left.etag === right.etag &&
    left.sequence === right.sequence && left.channel === right.channel;
}
function replacementObject(object, { reused = false, versionId = null } = {}) {
  return { ...object, reused, attempted: false, succeeded: reused, verified: reused, version_id: versionId };
}
function validReplacementObject(item, { feed = false } = {}) {
  return item && typeof item === 'object' && typeof item.key === 'string' && (!feed || item.key === 'feed.json') &&
    SHA.test(item.sha256 ?? '') && Number.isSafeInteger(item.bytes) && item.bytes > 0 && typeof item.content_type === 'string' &&
    typeof item.cache_control === 'string' && typeof item.reused === 'boolean' && typeof item.attempted === 'boolean' &&
    typeof item.succeeded === 'boolean' && typeof item.verified === 'boolean' && (!feed || !item.reused) &&
    (!item.reused || (item.succeeded && item.verified)) && (!item.succeeded || item.reused || item.attempted) &&
    (!item.verified || item.succeeded) && (item.version_id === null || (typeof item.version_id === 'string' && item.version_id && item.version_id !== 'null'));
}
function readReplacementReceipt(path) {
  const receipt = JSON.parse(read(path));
  const predecessor = receipt?.predecessor;
  if (receipt?.schema_version !== 1 || receipt.kind !== REPLACEMENT_KIND || !/^[a-f0-9-]{36}$/.test(receipt.operation_id ?? '') ||
      !COMMIT.test(receipt.source_sha ?? '') || !['planned', 'publishing', 'succeeded', 'unconfirmed'].includes(receipt.state) ||
      !Array.isArray(receipt.artifacts) || !receipt.artifacts.length || receipt.artifacts.length > 2 || receipt.artifacts.some(item => !validReplacementObject(item)) ||
      !validReplacementObject(receipt.feed, { feed: true }) || !predecessor || predecessor.key !== 'feed.json' || !SHA.test(predecessor.sha256 ?? '') ||
      !Number.isSafeInteger(predecessor.bytes) || predecessor.bytes <= 0 || typeof predecessor.version_id !== 'string' || !predecessor.version_id ||
      !ETAG.test(predecessor.etag ?? '') || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(predecessor.channel ?? '') ||
      !Number.isSafeInteger(predecessor.sequence) || predecessor.sequence <= 0) fail('replacement_receipt_invalid');
  return receipt;
}
function replacementInputs(receipt, d, { allowExpired = false } = {}) {
  if (d.runtime() !== receipt.source_sha) fail('exact_reviewed_runtime_required');
  account(d.aws);
  const currentHosting = hosting(receipt.hosting_receipt, d.aws, d.readTemplate);
  if (!equal(currentHosting, receipt.hosting)) fail('hosting_receipt_changed');
  const inputs = preparedInputs(receipt.prepared, receipt.authorization, d.validatePrepared, { now: currentTime(d), allowExpired });
  if (inputs.config.feed_url !== currentHosting.feed_url || !equal(inputs.hashes, receipt.hashes) ||
      inputs.manifest.release_id !== receipt.release_id || inputs.manifest.sequence <= receipt.predecessor.sequence ||
      !equal(inputs.objects.filter(item => item.key !== 'feed.json'), receipt.artifacts.map(objectIdentity)) ||
      !equal(inputs.objects.find(item => item.key === 'feed.json'), objectIdentity(receipt.feed))) fail('replacement_inputs_changed');
  return inputs;
}
async function recheckPredecessor(receipt, inputs, d) {
  if (!samePredecessor(await observePredecessor(receipt.hosting, inputs.config, d), receipt.predecessor)) fail('predecessor_feed_changed');
}
function replacementWindow(receipt, artifactIndex, inputs, d) {
  const remainingArtifacts = receipt.artifacts.slice(artifactIndex).filter(object => !object.reused && !object.attempted).length;
  const remainingWrites = remainingArtifacts + (receipt.feed.attempted ? 0 : 1);
  if (Date.parse(inputs.manifest.expires_at) - currentTime(d) < remainingWrites * OBJECT_PUBLICATION_WINDOW_MS) fail('insufficient_metadata_validity');
}
async function matchingRemoteArtifact(host, object, d) {
  const observed = head(d.aws, host.bucket, object.key);
  if (observed?.absent) return null;
  if (observed.ContentLength !== object.bytes || observed.ContentType !== object.content_type || observed.CacheControl !== object.cache_control ||
      observed.ContentEncoding || observed.WebsiteRedirectLocation || observed.ServerSideEncryption !== 'AES256' ||
      typeof observed.VersionId !== 'string' || !observed.VersionId || observed.VersionId === 'null') fail('immutable_artifact_mismatch');
  const bytes = await readPublicObject(host, object.key, observed, UPDATE_ARTIFACT_LIMIT, d);
  if (digest(bytes) !== object.sha256) fail('immutable_artifact_mismatch');
  return observed.VersionId;
}

export async function planClientUpdateReplacement({ hostingReceipt, prepared, authorization, output, expectedPredecessor }, dependencies = {}) {
  absolute(output);
  if (!SHA.test(expectedPredecessor ?? '')) fail('expected_predecessor_required');
  const d = deps(dependencies);
  return locked(output, async () => {
    if (existsSync(output)) fail('receipt_destination_exists');
    const source = d.runtime();
    if (!COMMIT.test(source)) fail('reviewed_source_unavailable');
    account(d.aws);
    const host = hosting(absolute(hostingReceipt), d.aws, d.readTemplate);
    const inputs = preparedInputs(absolute(prepared), absolute(authorization), d.validatePrepared, { now: currentTime(d) });
    if (inputs.config.feed_url !== host.feed_url) fail('publication_feed_url_mismatch');
    const predecessor = await observePredecessor(host, inputs.config, d);
    if (predecessor.sha256 !== expectedPredecessor) fail('unexpected_predecessor_feed');
    if (inputs.manifest.sequence <= predecessor.sequence) fail('replacement_sequence_not_advanced');
    const artifacts = [];
    for (const object of inputs.objects.filter(item => item.key !== 'feed.json')) {
      const versionId = await matchingRemoteArtifact(host, object, d);
      artifacts.push(replacementObject(object, { reused: versionId !== null, versionId }));
    }
    const feed = replacementObject(inputs.objects.find(item => item.key === 'feed.json'));
    const receipt = { schema_version: 1, kind: REPLACEMENT_KIND, operation_id: randomUUID(), source_sha: source,
      state: 'planned', hosting_receipt: hostingReceipt, prepared, authorization, hosting: host, hashes: inputs.hashes,
      release_id: inputs.manifest.release_id, predecessor, artifacts, feed };
    save(output, receipt, true);
    return replacementSummary(receipt, inputs, d);
  });
}

export async function executeClientUpdateReplacement({ receipt: path, approveManifest }, dependencies = {}) {
  absolute(path);
  const d = deps(dependencies);
  return locked(path, async () => {
    const receipt = readReplacementReceipt(path);
    if (!SHA.test(approveManifest ?? '') || approveManifest !== receipt.hashes['manifest.json']) fail('exact_manifest_approval_required');
    if (receipt.state === 'unconfirmed') fail('publication_unconfirmed_use_status');
    let inputs = replacementInputs(receipt, d);
    if (receipt.state === 'succeeded') return replacementSummary(receipt, inputs, d);
    try {
      for (const [index, object] of receipt.artifacts.entries()) {
        if (object.reused) {
          await verifyObject(receipt, object, inputs, d); save(path, receipt); continue;
        }
        if (!object.attempted) {
          await recheckPredecessor(receipt, inputs, d);
          absent(d.aws, receipt.hosting.bucket, object.key);
          const file = join(receipt.prepared, object.key);
          const bytes = read(file, UPDATE_ARTIFACT_LIMIT);
          if (bytes.length !== object.bytes || digest(bytes) !== object.sha256) fail('publication_inputs_changed');
          replacementWindow(receipt, index, inputs, d);
          receipt.state = 'publishing'; object.attempted = true; save(path, receipt);
          const result = d.aws(['s3api', 'put-object', '--bucket', receipt.hosting.bucket, '--key', object.key, '--body', file, '--if-none-match', '*', '--expected-bucket-owner', ACCOUNT, '--server-side-encryption', 'AES256', '--content-type', object.content_type, '--cache-control', object.cache_control, '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(object.sha256, 'hex').toString('base64')]);
          if (result?.ServerSideEncryption !== 'AES256' || typeof result.VersionId !== 'string' || !result.VersionId || result.VersionId === 'null') fail('put_object_result_unconfirmed');
          object.succeeded = true; object.version_id = result.VersionId; save(path, receipt);
        }
        await verifyObject(receipt, object, inputs, d); save(path, receipt);
      }
      if (!receipt.feed.attempted) {
        await recheckPredecessor(receipt, inputs, d);
        const file = join(receipt.prepared, 'feed.json');
        const bytes = read(file, UPDATE_METADATA_LIMIT);
        if (bytes.length !== receipt.feed.bytes || digest(bytes) !== receipt.feed.sha256) fail('publication_inputs_changed');
        inputs = replacementInputs(receipt, d);
        await recheckPredecessor(receipt, inputs, d);
        replacementWindow(receipt, receipt.artifacts.length, inputs, d);
        receipt.state = 'publishing'; receipt.feed.attempted = true; save(path, receipt);
        const result = d.aws(['s3api', 'put-object', '--bucket', receipt.hosting.bucket, '--key', 'feed.json', '--body', file, '--if-match', receipt.predecessor.etag, '--expected-bucket-owner', ACCOUNT, '--server-side-encryption', 'AES256', '--content-type', receipt.feed.content_type, '--cache-control', receipt.feed.cache_control, '--checksum-algorithm', 'SHA256', '--checksum-sha256', Buffer.from(receipt.feed.sha256, 'hex').toString('base64')]);
        if (result?.ServerSideEncryption !== 'AES256' || typeof result.VersionId !== 'string' || !result.VersionId || result.VersionId === 'null') fail('put_object_result_unconfirmed');
        receipt.feed.succeeded = true; receipt.feed.version_id = result.VersionId; save(path, receipt);
      }
      await verifyObject(receipt, receipt.feed, inputs, d); save(path, receipt);
      receipt.state = 'succeeded'; save(path, receipt);
    } catch { receipt.state = 'unconfirmed'; save(path, receipt); }
    return replacementSummary(receipt, inputs, d);
  });
}

export async function statusClientUpdateReplacement({ receipt: path }, dependencies = {}) {
  absolute(path);
  const d = deps(dependencies);
  return locked(path, async () => {
    const receipt = readReplacementReceipt(path);
    const inputs = replacementInputs(receipt, d, { allowExpired: true });
    try {
      // Before the conditional feed write, the predecessor remains the guard
      // for a resumable artifact-only operation. Afterwards only the exact new
      // feed can resolve the uncertain outcome; never issue another PUT.
      if (!receipt.feed.attempted) await recheckPredecessor(receipt, inputs, d);
      for (const object of receipt.artifacts) {
        if (object.reused || object.attempted) { await verifyObject(receipt, object, inputs, d, { allowExpired: true }); save(path, receipt); }
        else absent(d.aws, receipt.hosting.bucket, object.key);
      }
      if (receipt.feed.attempted) { await verifyObject(receipt, receipt.feed, inputs, d, { allowExpired: true }); save(path, receipt); }
      receipt.state = receipt.feed.verified && receipt.artifacts.every(item => item.verified) ? 'succeeded' : receipt.feed.attempted || receipt.artifacts.some(item => item.attempted) ? 'publishing' : 'planned';
    } catch { receipt.state = 'unconfirmed'; }
    save(path, receipt);
    return replacementSummary(receipt, inputs, d);
  });
}

async function main(argv) {
  const [action, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || !rest[index + 1] || rest[index + 1].startsWith('--') || Object.hasOwn(values, rest[index])) fail('arguments_invalid');
    values[rest[index]] = rest[index + 1];
  }
  const keys = Object.keys(values).sort();
  if (action === 'plan' && equal(keys, ['--authorization', '--hosting-receipt', '--output', '--prepared'])) return planClientUpdatePublish({ hostingReceipt: values['--hosting-receipt'], prepared: values['--prepared'], authorization: values['--authorization'], output: values['--output'] });
  if (action === 'replace-plan' && equal(keys, ['--authorization', '--expected-predecessor', '--hosting-receipt', '--output', '--prepared'])) return planClientUpdateReplacement({ hostingReceipt: values['--hosting-receipt'], prepared: values['--prepared'], authorization: values['--authorization'], output: values['--output'], expectedPredecessor: values['--expected-predecessor'] });
  if (action === 'execute' && equal(keys, ['--approve-manifest', '--receipt'])) return executeClientUpdatePublish({ receipt: values['--receipt'], approveManifest: values['--approve-manifest'] });
  if (action === 'replace-execute' && equal(keys, ['--approve-manifest', '--receipt'])) return executeClientUpdateReplacement({ receipt: values['--receipt'], approveManifest: values['--approve-manifest'] });
  if (action === 'status' && equal(keys, ['--receipt'])) return statusClientUpdatePublish({ receipt: values['--receipt'] });
  if (action === 'replace-status' && equal(keys, ['--receipt'])) return statusClientUpdateReplacement({ receipt: values['--receipt'] });
  fail('usage: client-update-publish.mjs plan --hosting-receipt FILE --prepared DIRECTORY --authorization FILE --output NEW_RECEIPT | execute --receipt FILE --approve-manifest SHA256 | status --receipt FILE | replace-plan --hosting-receipt FILE --prepared DIRECTORY --authorization FILE --expected-predecessor FEED_SHA256 --output NEW_RECEIPT | replace-execute --receipt FILE --approve-manifest SHA256 | replace-status --receipt FILE');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); if (result.state === 'unconfirmed') process.exitCode = 1; }).catch(error => { process.stderr.write(`ECHO first publication stopped: ${/^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'publication_inputs_invalid'}.\n`); process.exitCode = 1; });
}
