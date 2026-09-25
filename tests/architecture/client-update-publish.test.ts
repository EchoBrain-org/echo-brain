import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsentClientUpdateHead, executeClientUpdatePublish, planClientUpdatePublish, statusClientUpdatePublish, executeClientUpdateReplacement, planClientUpdateReplacement, statusClientUpdateReplacement, type ClientUpdatePublicationDependencies } from '../../tools/client-update-publish.mjs';
import { parseUpdateConfig, parseUpdateManifest, updateDigest } from '../../src/product/person-client/client-update-contract.js';

const directories: string[] = [];
const SOURCE = 'a'.repeat(40);
const BUCKET = 'echo-client-update-staging-s3-v1-feedbucket-abcdefghijkl';
const FEED = `https://${BUCKET}.s3.us-west-2.amazonaws.com/feed.json`;
const STACK = 'echo-client-update-staging-s3-v1';
const STACK_ID = `arn:aws:cloudformation:us-west-2:904560150024:stack/${STACK}/11111111-1111-4111-8111-111111111111`;
const TEMPLATE = Buffer.from('{"Resources":{}}');
function save(path: string, value: unknown) { writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 }); }
function fixture(options: { expiresAt?: number; previousExpiresAt?: number; previousSequence?: number; sequence?: number; existingArtifact?: boolean } = {}) {
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
  const createdAt = Date.now();
  const manifest = parseUpdateManifest({ schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: 'staging', sequence: options.sequence ?? 1, issued_at: new Date(createdAt - 10000).toISOString(), expires_at: new Date(options.expiresAt ?? createdAt + 86400000).toISOString(), release_id: 'clean-v1-fixture', release_sha256: 'b'.repeat(64), source_sha: SOURCE, product_version: '0.1.1', artifacts: [{ platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit', sha256: sha, bytes: artifactBytes.length, url: new URL(artifactKey, FEED).href }] });
  const payload = Buffer.from(JSON.stringify(manifest));
  const feedBytes = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
  const previousManifest = options.previousSequence === undefined ? undefined : parseUpdateManifest({ ...manifest, sequence: options.previousSequence, issued_at: new Date(createdAt - 86_400_000).toISOString(), expires_at: new Date(options.previousExpiresAt ?? createdAt + 43_200_000).toISOString() });
  const previousPayload = previousManifest && Buffer.from(JSON.stringify(previousManifest));
  const previousFeedBytes = previousPayload && Buffer.from(JSON.stringify({ payload: previousPayload.toString('base64'), signature: sign(null, previousPayload, privateKey).toString('base64') }));
  save(join(prepared, 'bootstrap-config.json'), config); save(join(prepared, 'manifest.json'), payload); save(join(prepared, 'release.json'), { synthetic: true }); save(join(prepared, 'feed.json'), feedBytes);
  const authorization = join(directory, 'authorization.json'); save(authorization, { synthetic: true });
  const hostingReceipt = join(directory, 'hosting.json');
  const hosting = { schema_version: 1, kind: 'echo-client-update-staging-s3-feed-operation-v1', state: 'succeeded', source_sha: SOURCE, template_sha256: updateDigest(TEMPLATE), account: '904560150024', region: 'us-west-2', stack_name: STACK, stack_id: STACK_ID, inventory: [{ action: 'Add', logical_id: 'FeedBucket', resource_type: 'AWS::S3::Bucket' }, { action: 'Add', logical_id: 'FeedBucketPolicy', resource_type: 'AWS::S3::BucketPolicy' }], outputs: { bucket_name: BUCKET, distribution_id: null, feed_url: FEED } };
  save(hostingReceipt, hosting);
  const receipt = join(directory, 'publication.json');
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, unknown> }>();
  const calls: string[][] = [];
  const events: string[] = [];
  const state = { throwAfterPut: '', throwBeforePut: '', tamperFetch: '', replaceBeforeConditionalFeedPut: false, advanceAfterFetch: {} as Record<string, number>, advanceAfterHead: {} as Record<string, number>, headerOverride: {} as Record<string, string>, statusOverride: 200, now: createdAt, validationOptions: [] as Array<{ now?: number; allowExpired?: boolean }> };
  const metadata = (bytes: Buffer, contentType: string, cacheControl: string, version: number) => ({ ContentLength: bytes.length, ContentType: contentType, CacheControl: cacheControl, ServerSideEncryption: 'AES256', VersionId: `version-${version}`, ETag: `"${version.toString(16).padStart(32, '0')}"` });
  if (previousFeedBytes) objects.set('feed.json', { bytes: previousFeedBytes, metadata: metadata(previousFeedBytes, 'application/json', 'no-store', 1) });
  if (options.existingArtifact) objects.set(artifactKey, { bytes: artifactBytes, metadata: metadata(artifactBytes, 'application/zip', 'public, max-age=31536000, immutable', 2) });
  const aws = (args: string[]): any => {
    calls.push(args);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === 'sts') return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
    if (args[1] === 'describe-stacks') return { Stacks: [{ StackId: STACK_ID, StackName: STACK, StackStatus: 'CREATE_COMPLETE', Outputs: [{ OutputKey: 'BucketName', OutputValue: BUCKET }, { OutputKey: 'FeedUrl', OutputValue: FEED }] }] };
    if (args[1] === 'get-template') return { TemplateBody: TEMPLATE.toString() };
    if (args[1] === 'list-stack-resources') return { StackResourceSummaries: hosting.inventory.map(item => ({ LogicalResourceId: item.logical_id, ResourceType: item.resource_type, PhysicalResourceId: BUCKET, ResourceStatus: 'CREATE_COMPLETE' })) };
    if (args[1] === 'get-bucket-versioning') return { Status: 'Enabled' };
    if (args[1] === 'head-object') {
      const key = value('--key');
      const response = objects.get(key)?.metadata ?? { absent: true };
      if (state.advanceAfterHead[key] !== undefined) state.now = state.advanceAfterHead[key];
      return response;
    }
    if (args[1] === 'put-object') {
      const key = value('--key');
      events.push(`put:${key}`);
      const persisted = JSON.parse(readFileSync(receipt, 'utf8'));
      const pending = persisted.kind === 'echo-client-update-first-publication-v1'
        ? persisted.objects.find((item: any) => item.key === key)
        : [...persisted.artifacts, persisted.feed].find((item: any) => item.key === key);
      expect(pending).toMatchObject({ attempted: true, succeeded: false, verified: false });
      expect(value('--bucket')).toBe(BUCKET); expect(value('--server-side-encryption')).toBe('AES256'); expect(value('--expected-bucket-owner')).toBe('904560150024');
      if (args.includes('--if-none-match')) {
        expect(value('--if-none-match')).toBe('*');
        if (objects.has(key)) throw new Error('precondition_failed');
      } else {
        expect(key).toBe('feed.json');
        if (state.replaceBeforeConditionalFeedPut) objects.set('feed.json', { bytes: Buffer.from('concurrent feed replacement'), metadata: metadata(Buffer.from('concurrent feed replacement'), 'application/json', 'no-store', 99) });
        if (!objects.has(key) || value('--if-match') !== objects.get(key)!.metadata.ETag) throw new Error('precondition_failed');
      }
      if (state.throwBeforePut === key) throw new Error('uncertain_before_put');
      const bytes = readFileSync(value('--body'));
      expect(value('--checksum-sha256')).toBe(Buffer.from(updateDigest(bytes), 'hex').toString('base64'));
      const objectMetadata = metadata(bytes, value('--content-type'), value('--cache-control'), objects.size + 1);
      objects.set(key, { bytes, metadata: objectMetadata });
      if (state.throwAfterPut === key) throw new Error('uncertain_after_put');
      return objectMetadata;
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
    const response = new Response(Uint8Array.from(state.tamperFetch === key ? Buffer.alloc(object.bytes.length, 42) : object.bytes), { status: state.statusOverride, headers: { 'content-length': String(object.bytes.length), 'content-type': String(object.metadata.ContentType), 'cache-control': String(object.metadata.CacheControl), 'etag': String(object.metadata.ETag ?? ''), 'x-amz-server-side-encryption': 'AES256', 'x-amz-version-id': String(object.metadata.VersionId), ...state.headerOverride } });
    if (state.advanceAfterFetch[key] !== undefined) state.now = state.advanceAfterFetch[key];
    return response;
  };
  const dependencies: ClientUpdatePublicationDependencies = { aws, fetch, runtime: () => SOURCE, readTemplate: () => TEMPLATE, now: () => state.now, validatePrepared: options => {
    state.validationOptions.push(options);
    if (!options.allowExpired && Date.parse(manifest.expires_at) <= state.now) throw new Error('expired_metadata');
    return { config, manifest, feedBytes };
  } };
  const plan = () => planClientUpdatePublish({ hostingReceipt, prepared, authorization, output: receipt }, dependencies);
  const execute = () => executeClientUpdatePublish({ receipt, approveManifest: updateDigest(payload) }, dependencies);
  const status = () => statusClientUpdatePublish({ receipt }, dependencies);
  const replacePlan = () => planClientUpdateReplacement({ hostingReceipt, prepared, authorization, output: receipt, expectedPredecessor: previousFeedBytes ? updateDigest(previousFeedBytes) : '0'.repeat(64) }, dependencies);
  const replaceExecute = () => executeClientUpdateReplacement({ receipt, approveManifest: updateDigest(payload) }, dependencies);
  const replaceStatus = () => statusClientUpdateReplacement({ receipt }, dependencies);
  return { directory, prepared, authorization, hostingReceipt, hosting, receipt, config, manifest, feedBytes, previousFeedBytes, previousManifest, privateKey, payload, artifactKey, objects, calls, events, state, dependencies, plan, execute, status, replacePlan, replaceExecute, replaceStatus };
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

  it('does not begin publication when less than the bounded first-publication window remains', async () => {
    const expiresAt = Date.now() + 19 * 60 * 1000;
    const f = fixture({ expiresAt });
    await f.plan();
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 0 });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(0);
  });

  it('keeps execution strict when a planned feed expires before the first write', async () => {
    const f = fixture();
    await f.plan();
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
    await expect(f.execute()).rejects.toThrow('expired_metadata');
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(0);
  });

  it('never sends the feed PUT if expiry advances during artifact verification', async () => {
    const expiresAt = Date.now() + 25 * 60 * 1000;
    const f = fixture({ expiresAt });
    await f.plan();
    f.state.advanceAfterFetch[f.artifactKey] = expiresAt - 5 * 60 * 1000;
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 1 });
    expect(f.events).toEqual([`put:${f.artifactKey}`, `get:${f.artifactKey}`]);
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
    expect(f.objects.has('feed.json')).toBe(false);
  });

  it('revalidates freshness after the final feed HEAD and does not send its PUT when time advanced', async () => {
    const expiresAt = Date.now() + 25 * 60 * 1000;
    const f = fixture({ expiresAt });
    await f.plan();
    f.state.advanceAfterHead['feed.json'] = expiresAt - 5 * 60 * 1000;
    expect(await f.execute()).toMatchObject({ state: 'unconfirmed', verified_objects: 1 });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
    expect(f.objects.has('feed.json')).toBe(false);
  });

  it('verifies an already-published expired feed historically through status without another PUT', async () => {
    const f = fixture();
    await f.plan();
    await f.execute();
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
    expect(await f.status()).toMatchObject({ state: 'succeeded', metadata_fresh: false, verified_objects: 2 });
    expect(f.state.validationOptions.at(-1)).toMatchObject({ allowExpired: true, now: f.state.now });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it('keeps a replaced object version unconfirmed when status audits after expiry', async () => {
    const f = fixture();
    await f.plan();
    await f.execute();
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
    f.objects.get(f.artifactKey)!.metadata.VersionId = 'replacement-version';
    expect(await f.status()).toMatchObject({ state: 'unconfirmed', metadata_fresh: false });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(2);
  });

  it('keeps a corrupted remote feed unconfirmed when status audits after expiry', async () => {
    const f = fixture();
    await f.plan();
    await f.execute();
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
    f.state.tamperFetch = 'feed.json';
    expect(await f.status()).toMatchObject({ state: 'unconfirmed', metadata_fresh: false });
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
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
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

describe('bounded conditional S3 feed replacement', () => {
  it('keeps the first-publication refusal, then replaces only the expected signed predecessor with a higher sequence', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2 });
    await expect(f.plan()).rejects.toThrow('first_publication_object_already_exists');
    expect(await f.replacePlan()).toMatchObject({ kind: 'echo-client-update-feed-replacement-v1', state: 'planned' });
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    expect(receipt.predecessor).toMatchObject({ sha256: updateDigest(f.previousFeedBytes!), sequence: 1, channel: 'staging' });
    expect(await f.replaceExecute()).toMatchObject({ state: 'succeeded', verified_objects: 2 });
    const put = f.calls.find(args => args[1] === 'put-object' && args.includes('feed.json'))!;
    expect(put[put.indexOf('--if-match') + 1]).toBe(receipt.predecessor.etag);
    expect(put).not.toContain('--if-none-match');
  });

  it('rejects a same or lower sequence before creating a replacement receipt', async () => {
    const f = fixture({ previousSequence: 2, sequence: 2 });
    await expect(f.replacePlan()).rejects.toThrow('replacement_sequence_not_advanced');
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('rejects a predecessor with a bad signature, different signed channel, or mismatched public ETag', async () => {
    const invalid = fixture({ previousSequence: 1, sequence: 2 });
    const remote = invalid.objects.get('feed.json')!;
    remote.bytes = Buffer.from(JSON.stringify({ payload: 'e30=', signature: Buffer.alloc(64).toString('base64') }));
    remote.metadata.ContentLength = remote.bytes.length;
    await expect(invalid.replacePlan()).rejects.toThrow('predecessor_feed_invalid');

    const wrongChannel = fixture({ previousSequence: 1, sequence: 2 });
    const changed = parseUpdateManifest({ ...wrongChannel.previousManifest!, channel: 'other' });
    const changedPayload = Buffer.from(JSON.stringify(changed));
    const changedFeed = Buffer.from(JSON.stringify({ payload: changedPayload.toString('base64'), signature: sign(null, changedPayload, wrongChannel.privateKey).toString('base64') }));
    const channelRemote = wrongChannel.objects.get('feed.json')!;
    channelRemote.bytes = changedFeed; channelRemote.metadata.ContentLength = changedFeed.length;
    await expect(wrongChannel.replacePlan()).rejects.toThrow('predecessor_feed_invalid');

    const wrongEtag = fixture({ previousSequence: 1, sequence: 2 });
    wrongEtag.state.headerOverride = { etag: `"${'e'.repeat(32)}"` };
    await expect(wrongEtag.replacePlan()).rejects.toThrow('public_object_headers_mismatch');
  });

  it('permits a verified expired predecessor, while requiring the replacement manifest to remain fresh', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2, previousExpiresAt: Date.now() - 1000 });
    await expect(f.replacePlan()).resolves.toMatchObject({ state: 'planned' });
    f.state.now = Date.parse(f.manifest.expires_at) + 1;
    await expect(f.replaceExecute()).rejects.toThrow('expired_metadata');
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it('refuses a changed predecessor before any artifact or feed write', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2 });
    await f.replacePlan();
    const remote = f.objects.get('feed.json')!;
    remote.metadata.VersionId = 'racing-version';
    remote.metadata.ETag = `"${'f'.repeat(32)}"`;
    expect(await f.replaceExecute()).toMatchObject({ state: 'unconfirmed', verified_objects: 0 });
    expect(f.calls.some(args => args[1] === 'put-object')).toBe(false);
  });

  it('uses an immutable matching artifact without another artifact write', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2, existingArtifact: true });
    await f.replacePlan();
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    expect(receipt.artifacts[0]).toMatchObject({ reused: true, attempted: false, verified: true });
    expect(await f.replaceExecute()).toMatchObject({ state: 'succeeded' });
    expect(f.calls.filter(args => args[1] === 'put-object')).toHaveLength(1);
    expect(f.calls.find(args => args[1] === 'put-object')).toContain('feed.json');
  });

  it('refuses to reuse an existing artifact whose public bytes do not match its signed digest', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2, existingArtifact: true });
    const remote = f.objects.get(f.artifactKey)!;
    remote.bytes = Buffer.from('corrupt immutable artifact'); remote.metadata.ContentLength = remote.bytes.length;
    await expect(f.replacePlan()).rejects.toThrow('immutable_artifact_mismatch');
  });

  it('treats a conditional-feed race as unconfirmed and never repeats its attempted PUT', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2 });
    await f.replacePlan(); f.state.replaceBeforeConditionalFeedPut = true;
    expect(await f.replaceExecute()).toMatchObject({ state: 'unconfirmed' });
    expect(f.calls.filter(args => args[1] === 'put-object' && args.includes('feed.json'))).toHaveLength(1);
    expect(await f.replaceStatus()).toMatchObject({ state: 'unconfirmed' });
    await expect(f.replaceExecute()).rejects.toThrow('publication_unconfirmed_use_status');
    expect(f.calls.filter(args => args[1] === 'put-object' && args.includes('feed.json'))).toHaveLength(1);
  });

  it('recovers a lost final PUT result through status without a second write', async () => {
    const f = fixture({ previousSequence: 1, sequence: 2 });
    await f.replacePlan(); f.state.throwAfterPut = 'feed.json';
    expect(await f.replaceExecute()).toMatchObject({ state: 'unconfirmed', verified_objects: 1 });
    expect(await f.replaceStatus()).toMatchObject({ state: 'succeeded', verified_objects: 2 });
    expect(f.calls.filter(args => args[1] === 'put-object' && args.includes('feed.json'))).toHaveLength(1);
  });
});


describe('authenticated S3 HEAD absence classification', () => {
  it.each([
    'An error occurred (404) when calling the HeadObject operation (reached max retries: 0): Not Found',
    'An error occurred (404) when calling the HeadObject operation: Not Found',
    'An error occurred (NoSuchKey) when calling the HeadObject operation: The specified key does not exist.',
    'An error occurred (NoSuchKey) when calling the HeadObject operation (reached max retries: 0): The specified key does not exist.',
  ])('recognizes a confirmed missing key: %s', stderr => {
    expect(isAbsentClientUpdateHead(['s3api', 'head-object'], stderr)).toBe(true);
  });

  it.each([
    'An error occurred (403) when calling the HeadObject operation (reached max retries: 0): Forbidden',
    'An error occurred (AccessDenied) when calling the HeadObject operation: Access Denied',
    'An error occurred (404) when calling the GetObject operation (reached max retries: 0): Not Found',
    'An error occurred (404) when calling the HeadObject operation (unknown annotation): Not Found',
    'An error occurred (500) when calling the HeadObject operation: Internal Server Error',
  ])('keeps denied, unrelated, or unknown errors unconfirmed: %s', stderr => {
    expect(isAbsentClientUpdateHead(['s3api', 'head-object'], stderr)).toBe(false);
  });

  it('does not classify a different command as a missing HEAD even if its stderr mentions HeadObject', () => {
    const stderr = 'An error occurred (404) when calling the HeadObject operation (reached max retries: 0): Not Found';
    expect(isAbsentClientUpdateHead(['s3api', 'put-object'], stderr)).toBe(false);
    expect(isAbsentClientUpdateHead(['cloudformation', 'head-object'], stderr)).toBe(false);
    expect(isAbsentClientUpdateHead(['s3api', 'head-object'], undefined)).toBe(false);
  });
});
