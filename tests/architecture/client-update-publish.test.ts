import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeClientUpdatePublish, planClientUpdatePublish, statusClientUpdatePublish, type ClientUpdatePublicationDependencies } from '../../tools/client-update-publish.mjs';
import { parseUpdateConfig, parseUpdateManifest, updateDigest } from '../../src/product/person-client/client-update-contract.js';

const directories: string[] = [];
const SOURCE = 'a'.repeat(40);
const BUCKET = 'echo-client-update-staging-s3-v1-feedbucket-abcdefghijkl';
const FEED = `https://${BUCKET}.s3.us-west-2.amazonaws.com/feed.json`;
const STACK = 'echo-client-update-staging-s3-v1';
const STACK_ID = `arn:aws:cloudformation:us-west-2:904560150024:stack/${STACK}/11111111-1111-4111-8111-111111111111`;
const TEMPLATE = Buffer.from('{"Resources":{}}');
function save(path: string, value: unknown) { writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 }); }
function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'echo-publish-test-'));
  chmodSync(directory, 0o700); directories.push(directory);
  const prepared = join(directory, 'prepared');
  mkdirSync(prepared, { mode: 0o700 }); mkdirSync(join(prepared, 'artifacts'), { mode: 0o700 });
  const artifactBytes = Buffer.from('synthetic validated kit');
  const sha = updateDigest(artifactBytes);
  const artifactKey = `artifacts/${sha}.zip`;
  save(join(prepared, artifactKey), artifactBytes);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = parseUpdateConfig({ schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'staging', feed_url: FEED, public_key_spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), minimum_sequence: 1, automatic: true, installation: 'cli-kit' });
  const manifest = parseUpdateManifest({ schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: 'staging', sequence: 1, issued_at: new Date(Date.now() - 10000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), release_id: 'clean-v1-fixture', release_sha256: 'b'.repeat(64), source_sha: SOURCE, product_version: '0.1.1', artifacts: [{ platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit', sha256: sha, bytes: artifactBytes.length, url: new URL(artifactKey, FEED).href }] });
  const payload = Buffer.from(JSON.stringify(manifest));
  const feedBytes = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
  save(join(prepared, 'bootstrap-config.json'), config); save(join(prepared, 'manifest.json'), payload); save(join(prepared, 'release.json'), { synthetic: true }); save(join(prepared, 'feed.json'), feedBytes);
  const authorization = join(directory, 'authorization.json'); save(authorization, { synthetic: true });
  const hostingReceipt = join(directory, 'hosting.json');
  const hosting = { schema_version: 1, kind: 'echo-client-update-staging-s3-feed-operation-v1', state: 'succeeded', source_sha: SOURCE, template_sha256: updateDigest(TEMPLATE), account: '904560150024', region: 'us-west-2', stack_name: STACK, stack_id: STACK_ID, inventory: [{ action: 'Add', logical_id: 'FeedBucket', resource_type: 'AWS::S3::Bucket' }, { action: 'Add', logical_id: 'FeedBucketPolicy', resource_type: 'AWS::S3::BucketPolicy' }], outputs: { bucket_name: BUCKET, distribution_id: null, feed_url: FEED } };
  save(hostingReceipt, hosting);
  const receipt = join(directory, 'publication.json');
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, unknown> }>();
  const calls: string[][] = [];
  const events: string[] = [];
  const state = { throwAfterPut: '', throwBeforePut: '', tamperFetch: '', headerOverride: {} as Record<string, string>, statusOverride: 200 };
  const aws = (args: string[]): any => {
    calls.push(args);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === 'sts') return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
    if (args[1] === 'describe-stacks') return { Stacks: [{ StackId: STACK_ID, StackName: STACK, StackStatus: 'CREATE_COMPLETE', Outputs: [{ OutputKey: 'BucketName', OutputValue: BUCKET }, { OutputKey: 'FeedUrl', OutputValue: FEED }] }] };
    if (args[1] === 'get-template') return { TemplateBody: TEMPLATE.toString() };
    if (args[1] === 'list-stack-resources') return { StackResourceSummaries: hosting.inventory.map(item => ({ LogicalResourceId: item.logical_id, ResourceType: item.resource_type, PhysicalResourceId: BUCKET, ResourceStatus: 'CREATE_COMPLETE' })) };
    if (args[1] === 'get-bucket-versioning') return { Status: 'Enabled' };
    if (args[1] === 'head-object') return objects.get(value('--key'))?.metadata ?? { absent: true };
    if (args[1] === 'put-object') {
      const key = value('--key');
      events.push(`put:${key}`);
      const persisted = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(persisted.objects.find((item: any) => item.key === key)).toMatchObject({ attempted: true, succeeded: false, verified: false });
      expect(value('--bucket')).toBe(BUCKET); expect(value('--if-none-match')).toBe('*'); expect(value('--server-side-encryption')).toBe('AES256'); expect(value('--expected-bucket-owner')).toBe('904560150024');
      if (objects.has(key)) throw new Error('precondition_failed');
      if (state.throwBeforePut === key) throw new Error('uncertain_before_put');
      const bytes = readFileSync(value('--body'));
      expect(value('--checksum-sha256')).toBe(Buffer.from(updateDigest(bytes), 'hex').toString('base64'));
      const metadata = { ContentLength: bytes.length, ContentType: value('--content-type'), CacheControl: value('--cache-control'), ServerSideEncryption: 'AES256', VersionId: `version-${objects.size + 1}` };
      objects.set(key, { bytes, metadata });
      if (state.throwAfterPut === key) throw new Error('uncertain_after_put');
      return metadata;
    }
    throw new Error(`unexpected_aws_${args[1]}`);
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input); const key = new URL(url).pathname.slice(1);
    events.push(`get:${key}`);
    expect(init?.redirect).toBe('manual'); expect(init?.headers).toEqual({ 'accept-encoding': 'identity' });
    expect(new URL(url).origin).toBe(new URL(FEED).origin);
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(state.tamperFetch === key ? Buffer.alloc(object.bytes.length, 42) : object.bytes), { status: state.statusOverride, headers: { 'content-length': String(object.bytes.length), 'content-type': String(object.metadata.ContentType), 'cache-control': String(object.metadata.CacheControl), 'x-amz-server-side-encryption': 'AES256', 'x-amz-version-id': String(object.metadata.VersionId), ...state.headerOverride } });
  };
  const dependencies: ClientUpdatePublicationDependencies = { aws, fetch, runtime: () => SOURCE, readTemplate: () => TEMPLATE, validatePrepared: () => ({ config, manifest, feedBytes }) };
  const plan = () => planClientUpdatePublish({ hostingReceipt, prepared, authorization, output: receipt }, dependencies);
  const execute = () => executeClientUpdatePublish({ receipt, approveManifest: updateDigest(payload) }, dependencies);
  const status = () => statusClientUpdatePublish({ receipt }, dependencies);
  return { directory, prepared, authorization, hostingReceipt, hosting, receipt, config, manifest, feedBytes, payload, artifactKey, objects, calls, events, state, dependencies, plan, execute, status };
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('bounded first S3 client update publication', () => {
  it('plans without mutation, durably records attempts, verifies public artifacts, then publishes and verifies the feed', async () => {
    const f = fixture();
    expect(await f.plan()).toMatchObject({ state: 'planned', object_count: 2, verified_objects: 0 });
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
    expect(await f.execute()).toMatchObject({ state: 'succeeded', object_count: 2, verified_objects: 2 });
    expect(f.events).toEqual([`put:${f.artifactKey}`, `get:${f.artifactKey}`, 'put:feed.json', 'get:feed.json']);
    expect([...f.objects.keys()]).toEqual([f.artifactKey, 'feed.json']);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    expect(receipt.objects.every((object: any) => object.attempted && object.succeeded && object.verified && object.version_id)).toBe(true);
    expect(f.calls.flat()).not.toContain('delete-object');
    expect(await f.status()).toMatchObject({ state: 'succeeded', verified_objects: 2 });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it('refuses a preexisting feed, and a new receipt cannot bypass a partially published artifact', async () => {
    const f = fixture();
    f.objects.set('feed.json', { bytes: f.feedBytes, metadata: {} });
    await expect(f.plan()).rejects.toThrow('first_publication_object_already_exists');
    expect(existsSync(f.receipt)).toBe(false);
    f.objects.delete('feed.json'); f.objects.set(f.artifactKey, { bytes: Buffer.from('existing'), metadata: {} });
    await expect(f.plan()).rejects.toThrow('first_publication_object_already_exists');
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('does not interpret denied authenticated HEAD as an absent feed', async () => {
    const f = fixture(); const aws = f.dependencies.aws!;
    f.dependencies.aws = args => { if (args[1] === 'head-object') throw new Error('403_access_denied'); return aws(args); };
    await expect(f.plan()).rejects.toThrow('403_access_denied');
    expect(existsSync(f.receipt)).toBe(false);
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it.each(['wrong-account', 'wrong-stack', 'wrong-resources', 'wrong-template', 'no-versioning'])('refuses hosting drift: %s', async change => {
    const f = fixture(); const aws = f.dependencies.aws!;
    f.dependencies.aws = args => {
      const response = aws(args);
      if (change === 'wrong-account' && args[0] === 'sts') response.Account = '111111111111';
      if (change === 'wrong-stack' && args[1] === 'describe-stacks') response.Stacks[0].StackId = 'unrelated';
      if (change === 'wrong-resources' && args[1] === 'list-stack-resources') response.StackResourceSummaries.push({ LogicalResourceId: 'Role', ResourceType: 'AWS::IAM::Role' });
      if (change === 'wrong-template' && args[1] === 'get-template') response.TemplateBody = '{"Resources":{"Other":{}}}';
      if (change === 'no-versioning' && args[1] === 'get-bucket-versioning') response.Status = 'Suspended';
      return response;
    };
    await expect(f.plan()).rejects.toThrow();
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('binds execution to the exact manifest approval and clean committed runtime', async () => {
    const f = fixture(); await f.plan();
    await expect(executeClientUpdatePublish({ receipt: f.receipt, approveManifest: 'f'.repeat(64) }, f.dependencies)).rejects.toThrow('exact_manifest_approval_required');
    f.dependencies.runtime = () => 'c'.repeat(40);
    await expect(f.execute()).rejects.toThrow('exact_reviewed_runtime_required');
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it.each(['authorization', 'release.json', 'bootstrap-config.json', 'manifest.json'])('rechecks bound local %s bytes before any write', async change => {
    const f = fixture(); await f.plan();
    save(change === 'authorization' ? f.authorization : join(f.prepared, change), '{}');
    await expect(f.execute()).rejects.toThrow('publication_inputs_changed');
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it('requires shared exact release authorization and kit validation on every entry point', async () => {
    const f = fixture(); await f.plan();
    f.dependencies.validatePrepared = () => { throw new Error('exact_release_authorization_required'); };
    await expect(f.execute()).rejects.toThrow('exact_release_authorization_required');
    await expect(f.status()).rejects.toThrow('exact_release_authorization_required');
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it('refuses an artifact path outside the fixed digest ZIP inventory', async () => {
    const f = fixture(); f.manifest.artifacts[0].url = new URL('private.json', FEED).href;
    await expect(f.plan()).rejects.toThrow('artifact_binding_mismatch');
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('preserves an uncertain successful artifact PUT and resumes only after read-only status confirms exact bytes', async () => {
    const f = fixture(); await f.plan(); f.state.throwAfterPut = f.artifactKey;
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 0 });
    await expect(f.execute()).rejects.toThrow('publication_unconfirmed_use_status');
    expect(await f.status()).toMatchObject({ state: 'publishing', verified_objects: 1 });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
    expect(await f.execute()).toMatchObject({ state: 'succeeded' });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it('never retries an attempted PUT whose outcome remains absent', async () => {
    const f = fixture(); await f.plan(); f.state.throwBeforePut = f.artifactKey;
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed' });
    expect(await f.status()).toMatchObject({ state: 'unconfirmed' });
    await expect(f.execute()).rejects.toThrow('publication_unconfirmed_use_status');
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
  });

  it('completes an uncertain final feed PUT using status without any further writes', async () => {
    const f = fixture(); await f.plan(); f.state.throwAfterPut = 'feed.json';
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 1 });
    expect(await f.status()).toMatchObject({ state: 'succeeded', verified_objects: 2 });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it.each(['digest', 'compression', 'redirect', 'length', 'cache'])('does not publish the feed when artifact verification fails: %s', async change => {
    const f = fixture(); await f.plan();
    if (change === 'digest') f.state.tamperFetch = f.artifactKey;
    if (change === 'compression') f.state.headerOverride = { 'content-encoding': 'gzip' };
    if (change === 'redirect') f.state.statusOverride = 302;
    if (change === 'length') f.state.headerOverride = { 'content-length': '999' };
    if (change === 'cache') f.state.headerOverride = { 'cache-control': 'public, max-age=0' };
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed' });
    expect(f.objects.has('feed.json')).toBe(false);
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
  });

  it('detects a changed published version even when public bytes remain the same', async () => {
    const f = fixture(); await f.plan(); await f.execute();
    f.objects.get(f.artifactKey)!.metadata.VersionId = 'replacement-version';
    expect(await f.status()).toMatchObject({ state: 'unconfirmed' });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it('refuses an unexpected public feed signature even when matching planned raw bytes were supplied by a faulty validator', async () => {
    const f = fixture();
    const envelope = JSON.parse(f.feedBytes.toString()); envelope.signature = Buffer.alloc(64).toString('base64');
    const invalid = Buffer.from(JSON.stringify(envelope)); save(join(f.prepared, 'feed.json'), invalid);
    f.dependencies.validatePrepared = () => ({ config: f.config, manifest: f.manifest, feedBytes: invalid });
    await f.plan();
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 1 });
  });

  it('requires private input files and serializes concurrent operations with the receipt lock', async () => {
    const f = fixture(); chmodSync(f.authorization, 0o644);
    await expect(f.plan()).rejects.toThrow('private_file_required');
    chmodSync(f.authorization, 0o600); await f.plan();
    mkdirSync(`${f.receipt}.lock`, { mode: 0o700 });
    await expect(f.execute()).rejects.toThrow('receipt_locked');
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });
});
