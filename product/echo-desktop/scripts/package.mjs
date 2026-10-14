#!/usr/bin/env node
// Packages ECHO from a clean commit: the person client packed exactly as the
// kit ships it, release bundles with the test hook compiled out, then
// electron-builder. Prints where the app is. A release package (ADR-0035)
// embeds the release's client tarball and the identity that turns updates on.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readValidatedPersonClientReleaseArtifact, sha256File } from '../../../deploy/release/release-artifact-validation.mjs';
import { canonicalJson, readCleanV1Release } from '../../../tools/clean-v1-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '..', '..');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const fail = message => { throw new Error(`Release packaging: ${message}`); };
const RELEASE_INPUTS = ['--release', '--artifact', '--update-config'];

/** The rebuilt Person-client dist's build identity must name the release's clean commit and version. */
export function requireReleaseClientBuild(identity, record) {
  if (identity?.kind !== 'echo-packaged-build-identity' || identity.source_kind !== 'materialized-commit' ||
      identity.source_sha !== record.source_sha || identity.product_version !== record.person_client.version) {
    fail('the rebuilt Person client is not this release\'s clean commit and version');
  }
}

// Run as a script, not when a test imports the check above. Real paths, since
// Node names the entry module by its real path even when started through a link.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(args) {
  if (args.includes('--help')) {
    console.log([
      'Usage: npm run package -- [--mac | --linux] [--release FILE --artifact FILE --update-config FILE]',
      'Builds macOS arm64 zip or Linux x64 deb/tar.gz from a clean checkout. Defaults to the current OS.',
      'A release package takes all three absolute paths: the canonical release.json, its exact',
      'person-client.tgz and the electron update config. It embeds that tarball and the desktop identity.',
    ].join('\n'));
    process.exit(0);
  }
  let choice = '';
  const inputs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '--mac' || arg === '--linux') && !choice) choice = arg;
    else if (RELEASE_INPUTS.includes(arg) && !inputs[arg] && isAbsolute(args[index + 1] ?? '')) inputs[arg] = args[++index];
    else throw new Error('Choose --mac or --linux, and give release inputs as absolute paths. See --help.');
  }
  if (![0, RELEASE_INPUTS.length].includes(Object.keys(inputs).length)) {
    throw new Error('Pass --release, --artifact and --update-config together, or none of them. See --help.');
  }
  const platform = choice === '--linux' ? 'linux' : choice === '--mac' ? 'darwin' : process.platform;
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Supported package targets: --mac or --linux.');
  const linux = platform === 'linux';

  if (run('git', ['status', '--porcelain'], repository).trim() !== '') {
    console.error('Refusing to package: commit your changes first.');
    process.exit(1);
  }

  const release = Object.keys(inputs).length ? await readRelease(inputs) : null;
  const packed = release ? null : mkdtempSync(join(tmpdir(), 'echo-person-client-'));
  try {
    const client = release
      ? { artifact_path: release.artifactPath, source_sha: release.record.source_sha }
      : JSON.parse(run('node', ['tools/pack-person-client.mjs', packed], repository).trim().split('\n').pop());
    // build.mjs empties build/, so the identity is written after it.
    run('node', ['scripts/build.mjs', '--release']);
    const identity = release ? writeIdentity(release, linux) : null;
    const target = join(root, 'build', 'person-client');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    run('tar', ['-xzf', client.artifact_path, '-C', target]);
    rmSync(join(root, 'dist-app'), { recursive: true, force: true });
    execFileSync('npx', ['electron-builder', '--config', 'electron-builder.config.cjs',
      ...(linux ? ['--linux', '--x64'] : ['--mac', '--arm64']), '--publish', 'never'], { cwd: root, stdio: 'inherit' });
    console.log(JSON.stringify({
      app: linux ? join(root, 'dist-app', 'linux-unpacked', 'echo-desktop') : join(root, 'dist-app', 'mac-arm64', 'ECHO.app'),
      person_client: client.source_sha,
      identity,
    }));
  } finally {
    if (packed) rmSync(packed, { recursive: true, force: true });
  }
}

/** The release, its exact client tarball and the electron update config, checked as the CLI kit builder checks them. */
async function readRelease({ '--release': releasePath, '--artifact': artifactPath, '--update-config': configPath }) {
  const record = readCleanV1Release(releasePath);
  if (run('git', ['rev-parse', 'HEAD'], repository).trim() !== record.source_sha) fail('HEAD must be the release source_sha');
  for (const [path, name] of [[artifactPath, 'client artifact'], [configPath, 'update config']]) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) fail(`${name} must be a regular file`);
  }
  readValidatedPersonClientReleaseArtifact({
    artifactPath, releasePath,
    releaseValidator: join(repository, 'tools', 'clean-v1-release.mjs'),
    nodeExecutable: process.execPath,
    run: (command, commandArgs, description) => {
      const result = spawnSync(command, commandArgs, { cwd: repository, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (result.status !== 0) fail(`${description}: ${(result.stderr || result.stdout || 'command failed').trim()}`);
      return result.stdout;
    },
    fail,
  });
  // Packing a client is what rebuilds the gitignored workspace dist host.mjs
  // bundles. A release packs none, so rebuild from HEAD lest an older commit's
  // build ship under this identity; tsc's output goes to stderr, not the result line.
  try { execFileSync(process.execPath, [join(repository, 'tools', 'build.mjs'), '--person-client'], { cwd: repository, stdio: ['ignore', 2, 'inherit'] }); } catch { fail('the Person client did not build from HEAD'); }
  let built;
  try { built = JSON.parse(readFileSync(join(repository, 'src', 'product', 'person-client', 'dist', 'build-identity.v1.json'), 'utf8')); } catch { fail('the rebuilt Person client has no build identity'); }
  requireReleaseClientBuild(built, record);
  const contract = pathToFileURL(join(repository, 'src', 'product', 'person-client', 'dist', 'client-update-contract.js')).href;
  const { parseUpdateConfig } = await import(contract).catch(() => fail('the rebuilt Person client has no update contract'));
  if (lstatSync(configPath).size > 64 * 1024) fail('update config is too large');
  let value;
  try { value = JSON.parse(readFileSync(configPath, 'utf8')); } catch { fail('update config is not valid JSON'); }
  const config = parseUpdateConfig(value);
  if (config.installation !== 'electron' || config.automatic !== true) fail('update config must set installation "electron" and automatic true');
  return { record, artifactPath, recordSha256: sha256File(releasePath), config };
}

/** build/echo-desktop-identity.v1.json, which electron-builder ships outside app.asar. */
function writeIdentity({ record, recordSha256, config }, linux) {
  const identity = {
    schema_version: 1, kind: 'echo-desktop-identity-v1', release_id: record.release_id,
    release_record_sha256: recordSha256, source_sha: record.source_sha, product_version: record.person_client.version,
    person_client_artifact_sha256: record.person_client.artifact_sha256,
    platform: linux ? 'linux' : 'darwin', architecture: linux ? 'x64' : 'arm64', libc: linux ? 'glibc' : null,
    installation: 'electron', update_bootstrap: config,
  };
  const path = join(root, 'build', 'echo-desktop-identity.v1.json');
  writeFileSync(path, `${canonicalJson(identity)}\n`, { mode: 0o644, flag: 'wx' });
  chmodSync(path, 0o644);
  const { release_id, source_sha, platform, architecture } = identity;
  return { path, sha256: sha256File(path), release_id, release_record_sha256: recordSha256, source_sha, platform, architecture };
}
