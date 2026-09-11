// Real packaged-client proof. Run on Linux x64 from clean committed source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../tools/clean-v1-release.mjs';

const repo = resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v22.22.1');
const root = mkdtempSync(join(tmpdir(), 'echo-linux-person-proof-'));
chmodSync(root, 0o700);

function run(command, args, env = process.env, status = 0) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, status, `${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
function node(script, ...args) {
  return run(process.execPath, [join(repo, script), ...args]);
}
function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  const packed = JSON.parse(node('tools/pack-person-client.mjs', root));
  const profile = join(root, 'runtime-profile.json');
  node('tools/clean-v1-runtime-profile.mjs', 'create', join(repo, 'deploy/organization-authority'), profile);
  const release = join(root, 'release.json');
  // These offline fixture URLs and image digest are never deployed or fetched.
  writeFileSync(release, `${canonicalJson({
    schema_version: 1,
    kind: 'echo-clean-v1-release',
    release_id: `clean-v1-linux-proof-${packed.source_sha.slice(0, 12)}`,
    released_at: '2026-09-11T00:00:00Z',
    baseline_compatibility_class: 'clean-v1',
    source_sha: packed.source_sha,
    authority_image: { reference: `123456789012.dkr.ecr.us-west-2.amazonaws.com/echo/authority@sha256:${'b'.repeat(64)}` },
    person_client: {
      package: packed.package,
      version: packed.version,
      artifact_url: 'https://rehearsal.invalid/person-client.tgz',
      artifact_sha256: packed.artifact_sha256,
    },
    runtime_profile: {
      artifact_url: 'https://rehearsal.invalid/runtime-profile.json',
      artifact_sha256: sha(profile),
      profile_version: 'clean-v1-profile-1',
    },
  })}\n`, { mode: 0o600 });
  const archive = join(root, 'ECHO-linux-x64.zip');
  const receipt = JSON.parse(node('deploy/release/create-person-onboarding-kit.mjs',
    '--target', 'linux-x64', '--release', release, '--artifact', packed.artifact_path,
    '--runtime-node', process.execPath, '--output', archive));
  assert.equal(receipt.kit_sha256, sha(archive));
  const extracted = join(root, 'extracted');
  run('unzip', ['-q', archive, '-d', extracted]);
  assert.deepEqual(readdirSync(extracted), ['echo-person-onboarding-kit']);
  const kit = join(extracted, 'echo-person-onboarding-kit');
  assert.deepEqual(readdirSync(kit).sort(), [
    'Start-ECHO.sh', 'build-identity.v1.json', 'clean-v1-release.mjs',
    'kit-manifest.v1.json', 'node', 'person-client.tgz', 'release.json', 'verify-person-onboarding-kit.mjs',
  ].sort());
  run(join(kit, 'node'), [join(kit, 'verify-person-onboarding-kit.mjs'), kit]);

  const home = join(root, 'home');
  const path = join(root, 'runtime-tools');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(path, { mode: 0o700 });
  // Standard OS utilities only: no node, npm, Python, compiler or network tool.
  for (const command of ['bash', 'dirname', 'uname', 'getconf', 'od', 'stat', 'id', 'mkdir', 'chmod', 'install', 'cmp', 'diff', 'mktemp', 'tar', 'find', 'mv', 'rm', 'rmdir', 'realpath', 'cat']) {
    symlinkSync(run('/bin/sh', ['-c', `command -v ${command}`]), join(path, command));
  }
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'custom data'), PATH: path };
  run('/bin/bash', ['-c', '! command -v node && ! command -v npm'], env);
  const start = join(kit, 'Start-ECHO.sh');
  run('/bin/bash', [start, '--install-only'], env);
  const cli = join(env.XDG_DATA_HOME, 'echo/person/bin/echo-brain');
  assert.equal(run(cli, ['--version'], env), packed.version);
  const status = JSON.parse(run(cli, ['person', 'status'], env));
  assert.equal(status.signed_in, false);
  const wrapper = readFileSync(cli, 'utf8');
  run('/bin/bash', [start, '--install-only'], env);
  assert.equal(readFileSync(cli, 'utf8'), wrapper);
  run('/bin/bash', [start], env, 2);
  run('/bin/bash', [start, 'relative-invitation.json'], env, 2);
  appendFileSync(join(kit, 'person-client.tgz'), 'tampered');
  run('/bin/bash', [start, '--install-only'], env, 1);
  assert.equal(readFileSync(cli, 'utf8'), wrapper);
  assert.equal(run(cli, ['--version'], env), packed.version);
  process.stdout.write(`${JSON.stringify({ ok: true, source_sha: packed.source_sha, checks: ['real-archive', 'no-system-node', 'install', 'signed-out-status', 'reinstall', 'arguments', 'tamper-preserves-install'] })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
