import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const nativeTarget = process.version === 'v22.22.1' && (
  (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'darwin' && process.arch === 'arm64')
);
const roots: string[] = [];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(typeof value === 'string' ? readFileSync(value) : value).digest('hex');
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv, expected = 0) {
  const result = spawnSync(command, args, {
    cwd: REPO, env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.error, `${command} did not start`).toBeUndefined();
  expect(result.signal, `${command}: ${result.stderr}`).toBeNull();
  expect(result.status, `${command}: ${result.stderr}\n${result.stdout}`).toBe(expected);
  return result;
}

function runAsync(command: string, args: string[], environment: NodeJS.ProcessEnv, expected = 0): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO, env: environment });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectRun);
    child.once('close', status => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (status !== expected) rejectRun(new Error(`${command}: ${result.stderr}\n${result.stdout}`));
      else resolveRun(result);
    });
  });
}

function writeRelease(path: string, releaseId: string, sourceSha: string, artifact: string, version: string): void {
  writeFileSync(path, `${canonicalJson({
    schema_version: 1,
    kind: 'echo-clean-v1-release',
    release_id: releaseId,
    released_at: '2026-09-24T20:00:00Z',
    baseline_compatibility_class: 'clean-v1',
    source_sha: sourceSha,
    authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo/authority@sha256:${'a'.repeat(64)}` },
    person_client: {
      package: '@echo-brain/person-client', version,
      artifact_url: 'https://fixture.invalid/person-client.tgz', artifact_sha256: sha256(artifact),
    },
    runtime_profile: {
      artifact_url: 'https://fixture.invalid/runtime-profile.json', artifact_sha256: 'b'.repeat(64), profile_version: 'clean-v1-profile-1',
    },
  })}\n`, { mode: 0o600 });
}

/** Build an actual packaged client, with a fixture provenance identity for A or B. */
function packagedClient(root: string, label: 'a' | 'b'): { artifact: string; sourceSha: string; sourceKind: string; version: string } {
  const packageRoot = join(root, `client-${label}`, 'package');
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  cpSync(join(REPO, 'src/product/person-client/dist'), join(packageRoot, 'dist'), { recursive: true });
  const clientManifest = JSON.parse(readFileSync(join(REPO, 'src/product/person-client/package.json'), 'utf8')) as {
    bundleDependencies: string[];
  };
  cpSync(join(REPO, 'src/product/person-client/package.json'), join(packageRoot, 'package.json'));
  const workspaces = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { workspaces: string[] }).workspaces;
  for (const name of clientManifest.bundleDependencies) {
    const workspace = workspaces.find(candidate => {
      const manifest = JSON.parse(readFileSync(join(REPO, candidate, 'package.json'), 'utf8')) as { name?: unknown };
      return manifest.name === name;
    });
    if (!workspace) throw new Error(`Missing packaged Person dependency ${name}`);
    const dependency = join(REPO, workspace);
    const destination = join(packageRoot, 'node_modules', name);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    cpSync(join(dependency, 'package.json'), join(destination, 'package.json'));
    cpSync(join(dependency, 'dist'), join(destination, 'dist'), { recursive: true });
  }
  const identityPath = join(packageRoot, 'dist/build-identity.v1.json');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as Record<string, unknown>;
  const sourceSha = label.repeat(40);
  const sourceKind = String(identity.source_kind);
  identity.source_sha = sourceSha;
  writeFileSync(identityPath, `${canonicalJson(identity)}\n`, { mode: 0o600 });
  const artifact = join(root, `person-client-${label}.tgz`);
  execFileSync('tar', ['-czf', artifact, 'package'], { cwd: join(root, `client-${label}`) });
  return { artifact, sourceSha, sourceKind, version: String(identity.product_version) };
}

/** Assemble the same fixed eight-file kit consumed by the production updater. */
function updateKit(root: string, label: 'a' | 'b', client: ReturnType<typeof packagedClient>, releaseId: string): { archive: string; release: string } {
  const kitParent = join(root, `kit-${label}`);
  const kit = join(kitParent, 'echo-person-onboarding-kit');
  mkdirSync(kit, { recursive: true, mode: 0o700 });
  const release = join(kit, 'release.json');
  writeRelease(release, releaseId, client.sourceSha, client.artifact, client.version);
  const platform = process.platform === 'linux' ? 'linux' : 'darwin';
  const architecture = process.platform === 'linux' ? 'x64' : 'arm64';
  const schemaVersion = process.platform === 'linux' ? 2 : 3;
  const kind = process.platform === 'linux' ? 'echo-person-onboarding-kit-v2' : 'echo-person-cli-kit-v1';
  const identity = Buffer.from(`${canonicalJson({
    schema_version: 1, kind: 'echo-person-onboarding-kit-identity-v1', platform, architecture,
    product_version: client.version, release_id: releaseId, source_sha: client.sourceSha,
  })}\n`);
  writeFileSync(join(kit, 'build-identity.v1.json'), identity, { mode: 0o600 });
  cpSync(client.artifact, join(kit, 'person-client.tgz'));
  cpSync(process.execPath, join(kit, 'node'));
  cpSync(join(REPO, 'deploy/release/verify-person-onboarding-kit.mjs'), join(kit, 'verify-person-onboarding-kit.mjs'));
  cpSync(join(REPO, 'tools/clean-v1-release.mjs'), join(kit, 'clean-v1-release.mjs'));
  cpSync(join(REPO, process.platform === 'linux'
    ? 'deploy/release/start-person-onboarding-kit-linux.sh'
    : 'deploy/release/start-person-cli-kit-macos.sh'), join(kit, 'Start-ECHO.sh'));
  const manifest = {
    schema_version: schemaVersion, kind, release_id: releaseId, source_sha: client.sourceSha,
    release_record_sha256: sha256(release), person_client_artifact_sha256: sha256(client.artifact),
    build_identity_sha256: sha256(identity),
    runtime: { version: process.version, platform, architecture, node_sha256: sha256(process.execPath) },
  };
  writeFileSync(join(kit, 'kit-manifest.v1.json'), `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  execFileSync('chmod', ['0700', 'Start-ECHO.sh', 'node', 'verify-person-onboarding-kit.mjs', 'clean-v1-release.mjs'], { cwd: kit });
  const archive = join(root, `release-${label}.zip`);
  execFileSync('zip', ['-qr', archive, 'echo-person-onboarding-kit'], { cwd: kitParent });
  return { archive, release };
}

function issueLocalCertificate(root: string): { certificate: string; key: string } {
  const config = join(root, 'openssl.cnf');
  const certificate = join(root, 'feed-ca.pem');
  const key = join(root, 'feed-key.pem');
  writeFileSync(config, '[req]\ndistinguished_name=subject\nprompt=no\nx509_extensions=extensions\n[subject]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', config], { stdio: 'ignore' });
  return { certificate, key };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(!nativeTarget)('updates a packaged CLI before exactly one Person command dispatch over signed HTTPS', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'echo-client-update-dispatch-'));
  roots.push(root);
  const home = join(root, 'home');
  const xdg = join(home, 'data');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(xdg, { mode: 0o700 });
  const clientA = packagedClient(root, 'a');
  const clientB = packagedClient(root, 'b');
  const releaseA = 'clean-v1-dispatch-a';
  const releaseB = 'clean-v1-dispatch-b';
  const kitA = updateKit(root, 'a', clientA, releaseA);
  const kitB = updateKit(root, 'b', clientB, releaseB);
  const unpackedA = join(root, 'unpacked-a');
  execFileSync('unzip', ['-q', kitA.archive, '-d', unpackedA]);
  const starter = join(unpackedA, 'echo-person-onboarding-kit', 'Start-ECHO.sh');
  const environment = { ...process.env, HOME: home, XDG_DATA_HOME: xdg };
  run('/bin/bash', [starter, '--install-only'], environment);

  const cliRoot = process.platform === 'linux'
    ? join(xdg, 'echo/person')
    : join(home, 'Library/Application Support/ECHO/cli');
  const cli = join(cliRoot, 'bin/echo-brain');
  const sessionSentinel = join(home, '.local/share/echo-brain/person/session-sentinel');
  const appSentinel = join(home, 'Applications/ECHO.app/sentinel');
  mkdirSync(resolve(sessionSentinel, '..'), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(appSentinel, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(sessionSentinel, 'preserve synthetic session', { mode: 0o600 });
  writeFileSync(appSentinel, 'preserve unrelated app', { mode: 0o600 });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tls = issueLocalCertificate(root);
  const artifact = readFileSync(kitB.archive);
  let envelope = Buffer.alloc(0);
  const server = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.certificate) }, (request, response) => {
    const payload = request.url === '/feed.json' ? envelope : request.url === '/artifact.zip' ? artifact : undefined;
    if (!payload) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Length': String(payload.length), 'Content-Type': 'application/octet-stream' });
    response.end(payload);
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => resolveReady());
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local HTTPS server did not bind TCP');
    const feedUrl = `https://localhost:${address.port}/feed.json`;
    const platform = process.platform === 'linux'
      ? { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit' }
      : { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit' };
    const now = Date.now();
    const manifest = {
      schema_version: 1, kind: 'echo-client-update-manifest-v1', channel: 'fixture', sequence: 1,
      issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(),
      release_id: releaseB, release_sha256: sha256(kitB.release), source_sha: clientB.sourceSha, product_version: clientB.version,
      artifacts: [{ ...platform, url: `https://localhost:${address.port}/artifact.zip`, sha256: sha256(artifact), bytes: artifact.length }],
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    envelope = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
    const config = join(root, 'trusted-config.json');
    writeFileSync(config, JSON.stringify({
      schema_version: 1, kind: 'echo-client-update-config-v1', channel: 'fixture', feed_url: feedUrl,
      public_key_spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      minimum_sequence: 1, automatic: true, installation: 'cli-kit',
    }));
    const updateEnvironment = { ...environment, NODE_EXTRA_CA_CERTS: tls.certificate };
    run(cli, ['update', 'configure', '--file', config], updateEnvironment);
    const dispatched = await runAsync(cli, ['person', 'status'], updateEnvironment);
    const output = dispatched.stdout.trim().split('\n').filter(Boolean);
    expect(output).toHaveLength(1);
    const status = JSON.parse(output[0]);
    expect(status).toMatchObject({ kind: 'echo-person-client-status-v1', signed_in: false,
      client_build: { source_sha: clientB.sourceSha, source_kind: clientB.sourceKind } });
    expect(dispatched.stderr).toContain(`ECHO updated to ${releaseB}.`);
    const updateStatus = JSON.parse(run(cli, ['update', '--status'], updateEnvironment).stdout);
    expect(updateStatus).toMatchObject({ status: 'updated', installed_release: releaseB });
    expect(readFileSync(sessionSentinel, 'utf8')).toBe('preserve synthetic session');
    expect(readFileSync(appSentinel, 'utf8')).toBe('preserve unrelated app');
    expect(readFileSync(cli, 'utf8')).toContain(`/releases/${releaseB}/`);
    expect(readFileSync(cli, 'utf8')).not.toContain(`/releases/${releaseA}/`);
    expect(readFileSync(join(cliRoot, 'releases', releaseA, '.echo-owned-release-v1'), 'utf8').trim()).toBe(releaseA);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClosed, rejectClosed) => server.close(error => error ? rejectClosed(error) : resolveClosed()));
  }
});
