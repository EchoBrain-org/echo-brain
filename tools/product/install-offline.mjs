#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { runToolchainPreflight } from './toolchain-preflight.mjs';
import { verifyBundle } from './verify-bundle.mjs';

const CREDENTIAL_KEY =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|GRANOLA|ANTHROPIC|OPENAI)/i;

function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      !['--artifact', '--artifact-manifest', '--support-dir', '--prefix', '--evidence'].includes(
        flag,
      )
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of ['artifact', 'artifact-manifest', 'support-dir', 'prefix']) {
    if (!isAbsolute(args[flag] ?? '')) throw new Error(`--${flag} must be absolute`);
  }
  if (args.evidence !== undefined && !isAbsolute(args.evidence)) {
    throw new Error('--evidence must be absolute');
  }
  return args;
}

function readPackagedShrinkwrap(artifact) {
  const result = spawnSync('/usr/bin/tar', ['-xOf', artifact, 'package/npm-shrinkwrap.json'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`cannot read packaged shrinkwrap: ${result.stderr || result.error?.message}`);
  }
  return JSON.parse(result.stdout);
}

function sanitizedInstallEnvironment(supportDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ECHO_') || CREDENTIAL_KEY.test(key)) {
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
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_build_from_source: 'true',
    npm_config_nodedir: join(supportDir, 'node-headers'),
  };
}

function rootInstallLock(artifact, artifactManifest, productLock) {
  const dependency = `file:${artifact}`;
  const packageMetadata = productLock.packages[''];
  return {
    name: 'echo-brain-offline-install',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'echo-brain-offline-install',
        version: '0.0.0',
        dependencies: { 'echo-brain': dependency },
      },
      'node_modules/echo-brain': {
        version: artifactManifest.version,
        resolved: dependency,
        integrity: `sha512-${hashFile(artifact, 'sha512', 'base64')}`,
        dependencies: packageMetadata.dependencies,
        bin: packageMetadata.bin,
        engines: packageMetadata.engines,
      },
      ...Object.fromEntries(Object.entries(productLock.packages).filter(([path]) => path !== '')),
    },
  };
}

export function installOffline(options) {
  const artifact = resolve(options.artifact);
  const artifactManifestPath = resolve(options.artifactManifest);
  const supportDir = resolve(options.supportDir);
  const prefix = resolve(options.prefix);
  if (
    artifactManifestPath !==
    join(dirname(artifactManifestPath), 'artifact-manifest.json')
  ) {
    throw new Error('--artifact-manifest must name artifact-manifest.json');
  }
  if (existsSync(prefix)) {
    if (!statSync(prefix).isDirectory() || readdirSync(prefix).length > 0) {
      throw new Error(`install prefix must be absent or empty: ${prefix}`);
    }
  } else {
    mkdirSync(prefix, { recursive: true });
  }

  const bundleVerification = verifyBundle({
    artifactDir: dirname(artifactManifestPath),
    supportDir,
  });
  if (!bundleVerification.ok) {
    throw new Error(
      `bundle verification failed: ${bundleVerification.errors.join('; ')}`,
    );
  }
  if (resolve(bundleVerification.artifact_path) !== artifact) {
    throw new Error('--artifact does not match artifact-manifest.json');
  }
  const artifactManifest = bundleVerification.artifact_manifest;
  const artifactSha256 = hashFile(artifact);
  if (artifactSha256 !== artifactManifest.artifact.sha256) {
    throw new Error('artifact SHA-256 does not match artifact-manifest.json');
  }

  const expectedNode = artifactManifest.declared_platform.node;
  const preflight = runToolchainPreflight({
    expectedNode,
    nodedir: join(supportDir, 'node-headers'),
  });
  if (!preflight.ok) {
    return { ok: false, stage: 'toolchain-preflight', preflight, npm_invoked: false };
  }

  const productLock = readPackagedShrinkwrap(artifact);
  if (productLock.version !== artifactManifest.version) {
    throw new Error('packaged shrinkwrap version does not match artifact manifest');
  }
  writeFileSync(
    join(prefix, 'package.json'),
    `${JSON.stringify(
      {
        name: 'echo-brain-offline-install',
        version: '0.0.0',
        private: true,
        dependencies: { 'echo-brain': `file:${artifact}` },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(prefix, 'package-lock.json'),
    `${JSON.stringify(rootInstallLock(artifact, artifactManifest, productLock), null, 2)}\n`,
  );

  const npmCheck = preflight.checks.find((check) => check.name === 'npm');
  const npmExecutable = npmCheck?.status === 'pass' ? npmCheck.resolved : null;
  if (npmExecutable === null || npmExecutable === undefined) {
    throw new Error('preflight did not resolve npm');
  }
  const installCache = join(prefix, '.echo-offline-npm-cache');
  let install;
  try {
    cpSync(join(supportDir, 'npm-cache'), installCache, { recursive: true });
    install = spawnSync(
      npmExecutable,
      [
        'ci',
        '--prefix',
        prefix,
        '--offline',
        '--no-audit',
        '--no-fund',
        '--cache',
        installCache,
      ],
      {
        encoding: 'utf8',
        env: sanitizedInstallEnvironment(supportDir),
        timeout: 180_000,
      },
    );
  } finally {
    rmSync(installCache, { recursive: true, force: true });
  }
  return {
    ok: install.status === 0,
    stage: 'npm-ci',
    preflight,
    npm_invoked: true,
    npm_status: install.status,
    npm_stdout: install.stdout,
    npm_stderr: install.stderr || install.error?.message || '',
    artifact_sha256: artifactSha256,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = installOffline({
    artifact: args.artifact,
    artifactManifest: args['artifact-manifest'],
    supportDir: args['support-dir'],
    prefix: args.prefix,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.evidence === undefined) process.stdout.write(output);
  else writeFileSync(resolve(args.evidence), output);
  if (!result.ok) {
    if (args.evidence !== undefined) process.stderr.write(output);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`install-offline: ${error.message}\n`);
    process.exitCode = 1;
  }
}
