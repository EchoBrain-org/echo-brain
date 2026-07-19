#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--version', '--source-sha', '--out-dir'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
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
  if (!isAbsolute(args['out-dir'])) throw new Error('--out-dir must be absolute');
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 20 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeout ?? 180_000,
  });
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed (${String(result.status)}): ${stderr || stdout || result.error?.message || 'no output'}`,
    );
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

function gitOutput(args) {
  return run('git', args, { cwd: REPO_ROOT }).trim();
}

function materializeCommit(sourceSha, destination, archivePath) {
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

function filesUnder(root) {
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

function copyRequired(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`required product package input is missing: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function safeRemoveTemporary(path, parent) {
  const rel = relative(parent, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`refusing to remove unsafe temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

function assertPackageHasNoRepositoryPath(packageFiles, forbiddenPaths) {
  for (const path of packageFiles) {
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    for (const forbidden of forbiddenPaths) {
      if (text.includes(forbidden)) {
        throw new Error(`package file contains an absolute build/repository path: ${path}`);
      }
    }
  }
}

function waitAtTestPreflightCheckpoint() {
  if (process.env.NODE_ENV !== 'test') return;
  const ready = process.env.PRODUCT_BUILD_TEST_PREFLIGHT_READY_FILE;
  const resume = process.env.PRODUCT_BUILD_TEST_CONTINUE_FILE;
  if (ready === undefined && resume === undefined) return;
  if (!isAbsolute(ready ?? '') || !isAbsolute(resume ?? '')) {
    throw new Error('product build test checkpoint paths must both be absolute');
  }
  writeFileSync(ready, 'ready\n');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(resume)) return;
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error('product build test checkpoint timed out');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const sourceSha = args['source-sha'].toLowerCase();
  const outDir = resolve(args['out-dir']);
  const head = gitOutput(['rev-parse', 'HEAD']).toLowerCase();
  if (head !== sourceSha) {
    throw new Error(`source SHA mismatch: HEAD=${head} supplied=${sourceSha}`);
  }
  if (existsSync(outDir)) throw new Error(`--out-dir already exists: ${outDir}`);

  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.build-`));
  const work = join(temporary, 'work');
  const source = join(work, 'source');
  const packageDir = join(work, 'package');
  try {
    mkdirSync(work, { recursive: true });
    materializeCommit(sourceSha, source, join(work, 'source.tar'));
    if (lstatSync(join(REPO_ROOT, 'node_modules')).isDirectory() === false) {
      throw new Error('root node_modules is required after npm ci');
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(source, 'node_modules'), 'dir');

    run(process.execPath, ['tools/product/sync-shrinkwrap.mjs', '--check'], { cwd: source });
    const closurePath = join(work, 'closure.json');
    run(
      process.execPath,
      ['tools/product/check-boundary.mjs', '--project-root', source, '--output', closurePath],
      { cwd: source },
    );
    const closure = readJson(closurePath);
    waitAtTestPreflightCheckpoint();

    mkdirSync(packageDir, { recursive: true });
    const buildConfigPath = join(work, 'tsconfig.product-build.json');
    writeFileSync(
      buildConfigPath,
      `${JSON.stringify(
        {
          extends: join(source, 'tsconfig.json'),
          compilerOptions: {
            outDir: join(packageDir, 'dist'),
            rootDir: join(source, 'src'),
            declaration: true,
            noEmit: false,
            incremental: false,
            tsBuildInfoFile: null,
            typeRoots: [join(source, 'node_modules/@types')],
            types: ['node'],
          },
          files: closure.closure.map((path) => join(source, path)),
          include: [],
          exclude: [],
        },
        null,
        2,
      )}\n`,
    );
    run(
      process.execPath,
      [join(source, 'node_modules/typescript/bin/tsc'), '--project', buildConfigPath],
      { cwd: source },
    );
    writeFileSync(
      join(packageDir, 'dist', 'product', 'build-identity.v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        kind: 'echo-packaged-build-identity',
        product_version: version,
        source_sha: sourceSha,
        source_kind: 'materialized-commit',
      })}\n`,
    );

    for (const asset of closure.runtime_assets ?? []) {
      const destination = asset.startsWith('src/')
        ? join(packageDir, 'dist', asset.slice('src/'.length))
        : join(packageDir, asset);
      copyRequired(join(source, asset), destination);
    }
    copyRequired(join(source, 'product/README.md'), join(packageDir, 'README.md'));
    copyRequired(join(source, 'LICENSE'), join(packageDir, 'LICENSE'));

    const template = readJson(join(source, 'product/package.template.json'));
    const packageJson = { ...template, version };
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    const committedShrinkwrapPath = join(source, 'npm-shrinkwrap.json');
    const packagedShrinkwrapPath = join(packageDir, 'npm-shrinkwrap.json');
    run(
      process.execPath,
      ['tools/product/sync-shrinkwrap.mjs', '--output', packagedShrinkwrapPath],
      { cwd: source },
    );
    const packagedShrinkwrap = readJson(packagedShrinkwrapPath);
    packagedShrinkwrap.version = version;
    packagedShrinkwrap.packages[''].version = version;
    writeFileSync(
      packagedShrinkwrapPath,
      `${JSON.stringify(packagedShrinkwrap, null, 2)}\n`,
    );

    const packageFiles = filesUnder(packageDir);
    assertPackageHasNoRepositoryPath(packageFiles, [REPO_ROOT, temporary, source]);
    const packageEntries = packageFiles.map((path) => ({
      path: relative(packageDir, path).split(sep).join('/'),
      size: statSync(path).size,
      sha256: sha256File(path),
    }));

    const packOutput = run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      {
        cwd: packageDir,
        // npm pack does not need network or the user's ambient cache. Keep its
        // bookkeeping inside the disposable build root so read-only homes and
        // host-owned cache entries cannot affect an otherwise hermetic build.
        env: {
          ...process.env,
          npm_config_cache: join(work, 'npm-cache'),
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false',
        },
      },
    );
    const packResult = JSON.parse(packOutput);
    if (!Array.isArray(packResult) || packResult.length !== 1) {
      throw new Error('npm pack did not emit exactly one artifact record');
    }
    const packedPaths = packResult[0].files.map((entry) => entry.path).sort();
    if (JSON.stringify(packedPaths) !== JSON.stringify(packageEntries.map((entry) => entry.path))) {
      throw new Error('npm-packed file set differs from the staged product package');
    }
    const tarballName = packResult[0].filename;
    const tarballPath = join(temporary, tarballName);
    if (!existsSync(tarballPath)) throw new Error(`npm pack output is missing: ${tarballName}`);
    const tarballSha256 = sha256File(tarballPath);
    writeFileSync(join(temporary, `${tarballName}.sha256`), `${tarballSha256}  ${tarballName}\n`);

    const manifest = {
      schema_version: 1,
      package: template.name,
      version,
      source_sha: sourceSha,
      product_boundary_version: closure.boundary_version,
      declared_platform: closure.phase_1_platform,
      dependency_lock_sha256: sha256File(committedShrinkwrapPath),
      packaged_shrinkwrap_sha256: sha256File(packagedShrinkwrapPath),
      build_command: [
        'node',
        'tools/product/build-artifact.mjs',
        '--version',
        version,
        '--source-sha',
        sourceSha,
        '--out-dir',
        outDir,
      ],
      artifact: {
        path: tarballName,
        size: statSync(tarballPath).size,
        sha256: tarballSha256,
      },
      package_files: packageEntries,
    };
    writeFileSync(
      join(temporary, 'artifact-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    safeRemoveTemporary(work, temporary);
    if (existsSync(outDir)) throw new Error(`--out-dir appeared during build: ${outDir}`);
    renameSync(temporary, outDir);
    process.stdout.write(
      `${JSON.stringify({ ok: true, out_dir: outDir, artifact: tarballName, sha256: tarballSha256 })}\n`,
    );
  } catch (error) {
    if (existsSync(temporary)) safeRemoveTemporary(temporary, parent);
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build-artifact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
