#!/usr/bin/env node

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProductBundle } from './install-bundle.mjs';
import { verifyBundle } from './verify-bundle.mjs';

const CREDENTIAL_KEY =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|GRANOLA|ANTHROPIC|OPENAI)/i;

function sanitizedEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      key.startsWith('ECHO_') ||
      CREDENTIAL_KEY.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    npm_config_offline: 'true',
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      !['--artifact-dir', '--support-dir', '--work-dir', '--evidence'].includes(
        flag,
      )
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of ['artifact-dir', 'support-dir', 'work-dir', 'evidence']) {
    if (!isAbsolute(args[flag] ?? ''))
      throw new Error(`--${flag} must be absolute`);
  }
  return args;
}

function runCli(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
    timeout: 30_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr || result.error?.message || '',
  };
}

function writeConfig(path, stateDir) {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: 1,
        lane: 'team-product',
        state_dir: stateDir,
        meeting_sources: [
          {
            adapter_id: 'granola',
            instance_id: 'primary',
            settings: { page_size: 30 },
          },
        ],
        decision_processor: {
          adapter_id: 'structured-text',
          instance_id: 'primary',
          settings: {},
        },
        delivery_surfaces: [
          {
            adapter_id: 'jsonl-outbox',
            instance_id: 'qualification',
            settings: {
              path: join(stateDir, 'outbox.jsonl'),
              destination_id: 'synthetic-qualification',
            },
          },
        ],
        approval_mode: 'manual',
      },
      null,
      2,
    )}\n`,
  );
}

export async function runTargetCell({ artifactDir, supportDir, workDir }) {
  const evidence = {
    schema_version: 1,
    ok: false,
    artifact_identity: null,
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    unexpected_skip_count: 0,
    statuses: {
      bundle_verified: false,
      platform_match: false,
      first_install: false,
      repeat_install_noop: false,
      onboard: false,
      operator_init: false,
      fresh_selftest: false,
      repeat_selftest: false,
      marker_preserved: false,
      second_install: false,
      isolated_selftest: false,
      state_roots_distinct: false,
    },
    errors: [],
  };
  try {
    mkdirSync(workDir, { recursive: true });
    const verified = verifyBundle({ artifactDir, supportDir });
    if (!verified.ok) throw new Error(verified.errors.join('; '));
    evidence.statuses.bundle_verified = true;
    evidence.artifact_identity = {
      source_sha: verified.artifact_manifest.source_sha,
      version: verified.artifact_manifest.version,
      sha256: verified.artifact_manifest.artifact.sha256,
    };
    const declared = verified.artifact_manifest.declared_platform;
    evidence.statuses.platform_match =
      process.platform === declared.os &&
      process.arch === declared.architecture &&
      process.versions.node === declared.node;
    if (!evidence.statuses.platform_match) {
      throw new Error(
        `target mismatch: expected ${declared.os}/${declared.architecture}/node-${declared.node}`,
      );
    }

    const bundleRoot = dirname(artifactDir);
    if (join(bundleRoot, 'qualification-support') !== supportDir) {
      throw new Error('artifact and support directories must be siblings');
    }
    const firstInstallRoot = join(workDir, 'install-a');
    const operatorConfig = join(workDir, 'operator', 'runtime.json');
    const operatorState = join(workDir, 'operator-state');
    const firstInstall = await installProductBundle({
      bundleRoot,
      installRoot: firstInstallRoot,
      expectedArtifactSha256: verified.artifact_manifest.artifact.sha256,
      onboard: {
        configPath: operatorConfig,
        stateDirectory: operatorState,
      },
    });
    evidence.statuses.first_install = firstInstall.ok && firstInstall.changed;
    if (!evidence.statuses.first_install) {
      throw new Error(
        'first bundle install failed or did not publish a release',
      );
    }
    evidence.statuses.onboard =
      firstInstall.onboard.requested && firstInstall.onboard.changed;
    if (!evidence.statuses.onboard)
      throw new Error('onboard did not create its baseline');
    const repeatedInstall = await installProductBundle({
      bundleRoot,
      installRoot: firstInstallRoot,
      expectedArtifactSha256: verified.artifact_manifest.artifact.sha256,
      onboard: {
        configPath: operatorConfig,
        stateDirectory: operatorState,
      },
    });
    evidence.statuses.repeat_install_noop =
      repeatedInstall.ok &&
      !repeatedInstall.changed &&
      !repeatedInstall.onboard.changed;
    if (!evidence.statuses.repeat_install_noop) {
      throw new Error('exact installer rerun was not idempotent');
    }
    const firstState = join(workDir, 'state-a');
    const firstConfig = join(workDir, 'runtime-a.json');
    writeConfig(firstConfig, firstState);
    const firstBin = firstInstall.paths.cli;
    const initialized = runCli(
      firstBin,
      ['init', '--config', operatorConfig],
      workDir,
    );
    evidence.statuses.operator_init = initialized.ok;
    if (!initialized.ok) {
      throw new Error(`operator init failed: ${initialized.stderr}`);
    }

    const fresh = runCli(
      firstBin,
      ['selftest', '--config', firstConfig],
      workDir,
    );
    evidence.statuses.fresh_selftest = fresh.ok;
    if (!fresh.ok) throw new Error(`fresh selftest failed: ${fresh.stderr}`);

    mkdirSync(firstState, { recursive: true });
    const marker = join(firstState, 'synthetic-qualification-seed.json');
    writeFileSync(marker, '{"synthetic":true}\n');
    const populated = runCli(
      firstBin,
      ['selftest', '--config', firstConfig],
      workDir,
    );
    evidence.statuses.repeat_selftest = populated.ok;
    evidence.statuses.marker_preserved = populated.ok && existsSync(marker);
    if (!evidence.statuses.marker_preserved) {
      throw new Error(
        'repeated packaged invocation did not preserve synthetic state',
      );
    }

    const secondInstall = await installProductBundle({
      bundleRoot,
      installRoot: join(workDir, 'install-b'),
      expectedArtifactSha256: verified.artifact_manifest.artifact.sha256,
    });
    evidence.statuses.second_install =
      secondInstall.ok && secondInstall.changed;
    if (!secondInstall.ok) throw new Error('second offline install failed');
    const secondState = join(workDir, 'state-b');
    const secondConfig = join(workDir, 'runtime-b.json');
    writeConfig(secondConfig, secondState);
    const isolated = runCli(
      secondInstall.paths.cli,
      ['selftest', '--config', secondConfig],
      workDir,
    );
    evidence.statuses.isolated_selftest = isolated.ok;
    evidence.statuses.state_roots_distinct =
      isolated.ok &&
      !existsSync(join(secondState, 'synthetic-qualification-seed.json'));
    if (!evidence.statuses.state_roots_distinct) {
      throw new Error(
        'second installation/state root observed the first root marker',
      );
    }
    evidence.ok = Object.values(evidence.statuses).every(Boolean);
  } catch (error) {
    evidence.errors.push(error.message);
  }
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runTargetCell({
    artifactDir: resolve(args['artifact-dir']),
    supportDir: resolve(args['support-dir']),
    workDir: resolve(args['work-dir']),
  });
  mkdirSync(dirname(resolve(args.evidence)), { recursive: true });
  writeFileSync(resolve(args.evidence), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`run-target-cell: ${error.message}\n`);
    process.exitCode = 1;
  }
}
