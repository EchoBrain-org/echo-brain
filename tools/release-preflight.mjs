import { spawnSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
const REPO = resolve(import.meta.dirname, '..');
const fail = code => { throw new Error(code); };

/** Local preparation checks. Never starts Docker, signs in, or contacts a host. */
export function releasePreflight({ target = process.platform, cwd = REPO } = {}, dependencies = {}) {
  if (!['darwin', 'linux'].includes(target)) fail('build_target_invalid');
  const run = dependencies.run ?? ((command, args) => spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const engines = JSON.parse(readFileSync(resolve(REPO, 'package.json'))).engines;
  const tools = ['git', 'tar', 'unzip', 'zip', 'python3', ...(target === 'darwin' ? ['codesign'] : ['dpkg-deb'])];
  const checks = tools.map(tool => ({ check: tool, passed: run(tool === 'codesign' ? 'xcrun' : tool, tool === 'codesign' ? ['--find', 'codesign'] : ['zip', 'unzip'].includes(tool) ? ['-v'] : ['--version']).status === 0 }));
  checks.push({ check: 'node_version', passed: (dependencies.nodeVersion ?? process.versions.node) === engines.node });
  checks.push({ check: 'npm_version', passed: run('npm', ['--version']).stdout?.trim() === engines.npm });
  const git = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  checks.push({ check: 'clean_checkout', passed: git.status === 0 && git.stdout.trim() === '' });
  checks.push({ check: 'test_umask_022', passed: (dependencies.umask ?? process.umask()) === 0o022 });
  const disk = (dependencies.statfs ?? statfsSync)(cwd);
  checks.push({ check: 'build_disk_10_gib', passed: disk.bavail * disk.bsize >= 10 * 1024 ** 3 });
  return { kind: 'echo-release-local-preflight-v1', ready: checks.every(check => check.passed), target, checks,
    live_checks_required: ['existing_sso_and_registry_access', 'accepted_host_and_tooling', 'runtime_trace_export', 'source_connections', 'native_mac_and_linux_baselines'],
    note: 'Local readiness only. Verify live prerequisites through the operator playbook before staging or Ask checks.' };
}

