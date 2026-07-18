#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
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

function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      ![
        '--artifact',
        '--artifact-manifest',
        '--support-dir',
        '--prefix',
        '--evidence',
      ].includes(flag)
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  for (const flag of [
    'artifact',
    'artifact-manifest',
    'support-dir',
    'prefix',
  ]) {
    if (!isAbsolute(args[flag] ?? ''))
      throw new Error(`--${flag} must be absolute`);
  }
  if (args.evidence !== undefined && !isAbsolute(args.evidence)) {
    throw new Error('--evidence must be absolute');
  }
  return args;
}

function readPackagedShrinkwrap(artifact) {
  const result = spawnSync(
    '/usr/bin/tar',
    ['-xOf', artifact, 'package/npm-shrinkwrap.json'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `cannot read packaged shrinkwrap: ${result.stderr || result.error?.message}`,
    );
  }
  return JSON.parse(result.stdout);
}

function sanitizedInstallEnvironment(supportDir, environmentRoot) {
  const selectedNodeDirectory = dirname(process.execPath);
  return {
    PATH: `${selectedNodeDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(environmentRoot, 'home'),
    TMPDIR: join(environmentRoot, 'tmp'),
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    no_proxy: '',
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_build_from_source: 'true',
    npm_config_ignore_scripts: 'false',
    npm_config_omit: '',
    npm_config_include: 'optional',
    npm_config_script_shell: '/bin/sh',
    npm_config_node_options: '',
    npm_config_userconfig: join(environmentRoot, 'user-npmrc'),
    npm_config_globalconfig: join(environmentRoot, 'global-npmrc'),
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
      ...Object.fromEntries(
        Object.entries(productLock.packages).filter(([path]) => path !== ''),
      ),
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
  const prefixAlreadyExisted = existsSync(prefix);
  const previousPrefixMode = prefixAlreadyExisted
    ? lstatSync(prefix).mode & 0o777
    : 0o700;
  if (prefixAlreadyExisted) {
    const prefixState = lstatSync(prefix);
    if (
      prefixState.isSymbolicLink() ||
      !prefixState.isDirectory() ||
      readdirSync(prefix).length > 0
    ) {
      throw new Error(`install prefix must be absent or empty: ${prefix}`);
    }
  }

  // Verify every supplied byte and the target platform before creating or
  // mutating the installation destination.
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

  const declaredPlatform = artifactManifest.declared_platform;
  if (
    declaredPlatform?.os !== process.platform ||
    declaredPlatform?.architecture !== process.arch
  ) {
    return {
      ok: false,
      stage: 'platform-preflight',
      expected_platform: {
        os: declaredPlatform?.os ?? null,
        architecture: declaredPlatform?.architecture ?? null,
      },
      observed_platform: { os: process.platform, architecture: process.arch },
      npm_invoked: false,
    };
  }

  const expectedNode = artifactManifest.declared_platform.node;
  const preflight = runToolchainPreflight({
    expectedNode,
    nodedir: join(supportDir, 'node-headers'),
  });
  if (!preflight.ok) {
    return {
      ok: false,
      stage: 'toolchain-preflight',
      preflight,
      npm_invoked: false,
    };
  }

  if (!prefixAlreadyExisted)
    mkdirSync(prefix, { recursive: true, mode: 0o700 });

  const productLock = readPackagedShrinkwrap(artifact);
  if (productLock.version !== artifactManifest.version) {
    throw new Error(
      'packaged shrinkwrap version does not match artifact manifest',
    );
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
  const environmentRoot = join(prefix, '.echo-offline-environment');
  mkdirSync(join(environmentRoot, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(environmentRoot, 'tmp'), { recursive: true, mode: 0o700 });
  writeFileSync(join(environmentRoot, 'user-npmrc'), '', { mode: 0o600 });
  writeFileSync(join(environmentRoot, 'global-npmrc'), '', { mode: 0o600 });
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
        '--ignore-scripts=false',
        '--include=optional',
        '--cache',
        installCache,
      ],
      {
        encoding: 'utf8',
        env: sanitizedInstallEnvironment(supportDir, environmentRoot),
        timeout: 180_000,
      },
    );
  } finally {
    rmSync(installCache, { recursive: true, force: true });
    rmSync(environmentRoot, { recursive: true, force: true });
  }
  const result = {
    ok: install.status === 0,
    stage: 'npm-ci',
    preflight,
    npm_invoked: true,
    npm_status: install.status,
    npm_stdout: install.stdout,
    npm_stderr: install.stderr || install.error?.message || '',
    artifact_sha256: artifactSha256,
  };
  if (!result.ok) {
    rmSync(prefix, { recursive: true, force: true });
    if (prefixAlreadyExisted) {
      mkdirSync(prefix, { recursive: true, mode: previousPrefixMode });
    }
  }
  return result;
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
  else
    writeFileSync(resolve(args.evidence), output, {
      flag: 'wx',
      mode: 0o600,
    });
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
