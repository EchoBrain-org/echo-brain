import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOL_DIR, '../..');
export const ARTIFACT_BUNDLED_WORKSPACES = Object.freeze([
  {
    name: '@echo-brain/federation-protocol',
    directory: 'packages/federation-protocol',
  },
  {
    name: '@echo-brain/organization-protocol',
    directory: 'packages/organization-protocol',
  },
  {
    name: '@echo-brain/organization-api',
    directory: 'packages/organization-api',
  },
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--version', '--source-sha', '--out-dir'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
  }
  for (const flag of ['version', 'source-sha', 'out-dir']) {
    if (args[flag] === undefined) throw new Error(`--${flag} is required`);
  }
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(args.version)) {
    throw new Error('--version must be a valid prerelease version');
  }
  if (!/^[0-9a-fA-F]{40}$/.test(args['source-sha'])) {
    throw new Error('--source-sha must be a full 40-character commit SHA');
  }
  if (!isAbsolute(args['out-dir'])) {
    throw new Error('--out-dir must be absolute');
  }
  return args;
}

export function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeout ?? 180_000,
  };
  let result;
  if (command === 'git') result = spawnSync('git', args, spawnOptions);
  else if (command === '/usr/bin/tar')
    result = spawnSync('/usr/bin/tar', args, spawnOptions);
  else if (command === 'npm') result = spawnSync('npm', args, spawnOptions);
  else if (command === process.execPath)
    result = spawnSync(process.execPath, args, spawnOptions);
  else throw new Error(`unsupported artifact build command: ${command}`);
  if (result.status !== 0) {
    const stderr =
      typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout =
      typeof result.stdout === 'string' ? result.stdout.trim() : '';
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed (${String(result.status)}): ${stderr || stdout || result.error?.message || 'no output'}`,
    );
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

export function gitOutput(args) {
  return run('git', args, { cwd: REPO_ROOT }).trim();
}

export function materializeCommit(sourceSha, destination, archivePath) {
  mkdirSync(destination, { recursive: true });
  const archiveFd = openSync(archivePath, 'w');
  try {
    run('git', ['archive', '--format=tar', sourceSha], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      stdio: ['ignore', archiveFd, 'pipe'],
    });
  } finally {
    closeSync(archiveFd);
  }
  run('/usr/bin/tar', ['-xf', archivePath, '-C', destination]);
}

export function linkMaterializedBuildDependencies(source) {
  const installed = join(REPO_ROOT, 'node_modules');
  if (!existsSync(installed) || !lstatSync(installed).isDirectory()) {
    throw new Error('root node_modules is required after npm ci');
  }
  const materialized = join(source, 'node_modules');
  mkdirSync(materialized, { recursive: true });
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    if (
      entry.name === '@echo-brain' ||
      entry.name === '.bin' ||
      entry.name === '.package-lock.json'
    ) {
      continue;
    }
    symlinkSync(
      join(installed, entry.name),
      join(materialized, entry.name),
      entry.isDirectory() ? 'dir' : 'file',
    );
  }
  const scope = join(materialized, '@echo-brain');
  mkdirSync(scope, { recursive: true });
  for (const workspace of ARTIFACT_BUNDLED_WORKSPACES) {
    symlinkSync(
      join(source, workspace.directory),
      join(scope, workspace.name.slice('@echo-brain/'.length)),
      'dir',
    );
  }
}

export function isolatedNpmEnvironment(cache) {
  return {
    ...process.env,
    npm_config_cache: cache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

export function parseSinglePackResult(output, context) {
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(`${context} did not emit exactly one artifact record`);
  }
  if (!Array.isArray(result[0].files)) {
    throw new Error(`${context} did not report its packed file set`);
  }
  return result[0];
}

export function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`package staging contains a non-file entry: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

export function stageBundledWorkspaces(source, packageDir, work) {
  const packDirectory = join(work, 'workspace-packs');
  mkdirSync(packDirectory, { recursive: true });
  for (const workspace of ARTIFACT_BUNDLED_WORKSPACES) {
    const workspaceDirectory = join(source, workspace.directory);
    const manifest = readJson(join(workspaceDirectory, 'package.json'));
    if (
      manifest.name !== workspace.name ||
      typeof manifest.version !== 'string'
    ) {
      throw new Error(
        `bundled workspace manifest identity is invalid: ${workspace.directory}`,
      );
    }
    const output = run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
      {
        cwd: workspaceDirectory,
        env: isolatedNpmEnvironment(join(work, 'npm-cache')),
      },
    );
    const packed = parseSinglePackResult(
      output,
      `npm pack for ${workspace.name}`,
    );
    if (packed.name !== workspace.name || packed.version !== manifest.version) {
      throw new Error(
        `npm pack identity differs from bundled workspace: ${workspace.name}`,
      );
    }
    const packedPaths = packed.files.map(({ path }) => path).sort();
    if (
      !packedPaths.includes('package.json') ||
      !packedPaths.includes('dist/index.js') ||
      packedPaths.some(
        (path) =>
          isAbsolute(path) ||
          path.split('/').includes('..') ||
          path === 'src' ||
          path.startsWith('src/') ||
          path.endsWith('.tsbuildinfo'),
      )
    ) {
      throw new Error(
        `bundled workspace pack contains an invalid file set: ${workspace.name}`,
      );
    }
    const tarballPath = join(packDirectory, packed.filename);
    if (!existsSync(tarballPath)) {
      throw new Error(
        `bundled workspace pack output is missing: ${packed.filename}`,
      );
    }
    const destination = join(packageDir, 'node_modules', workspace.name);
    mkdirSync(destination, { recursive: true });
    run(
      '/usr/bin/tar',
      ['-xzf', tarballPath, '--strip-components', '1', '-C', destination],
      { cwd: workspaceDirectory },
    );
    const stagedPaths = filesUnder(destination).map((path) =>
      relative(destination, path).split(sep).join('/'),
    );
    if (JSON.stringify(stagedPaths) !== JSON.stringify(packedPaths)) {
      throw new Error(
        `staged files differ from npm pack output: ${workspace.name}`,
      );
    }
  }
}

export function copyRequired(source, destination, inputLabel) {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`required ${inputLabel} is missing: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

export function safeRemoveTemporary(path, parent) {
  const rel = relative(parent, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`refusing to remove unsafe temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

export function assertPackageHasNoBuildPaths(files, forbiddenPaths, label) {
  for (const path of files) {
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    for (const forbidden of forbiddenPaths) {
      if (text.includes(forbidden)) {
        throw new Error(`${label} contains an absolute build path: ${path}`);
      }
    }
  }
}

export function waitAtTestPreflightCheckpoint({
  readyEnvVar,
  resumeEnvVar,
  label,
}) {
  if (process.env.NODE_ENV !== 'test') return;
  const ready = process.env[readyEnvVar];
  const resume = process.env[resumeEnvVar];
  if (ready === undefined && resume === undefined) return;
  if (!isAbsolute(ready ?? '') || !isAbsolute(resume ?? '')) {
    throw new Error(`${label} build test checkpoint paths must both be absolute`);
  }
  writeFileSync(ready, 'ready\n');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(resume)) return;
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error(`${label} build test checkpoint timed out`);
}
