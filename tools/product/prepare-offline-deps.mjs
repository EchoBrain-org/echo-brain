#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runToolchainPreflight } from './toolchain-preflight.mjs';
import { productShrinkwrap } from './sync-shrinkwrap.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--out-dir', '--cache-source', '--headers-source'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
  }
  if (!isAbsolute(args['out-dir'] ?? ''))
    throw new Error('--out-dir must be absolute');
  return args;
}

function integrityContentPath(cacheRoot, integrity) {
  if (!integrity.startsWith('sha512-'))
    throw new Error(`unsupported lock integrity: ${integrity}`);
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString(
    'hex',
  );
  return join(
    cacheRoot,
    '_cacache/content-v2/sha512',
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

function indexPath(cacheRoot, resolvedUrl) {
  const key = `make-fetch-happen:request-cache:${resolvedUrl}`;
  const hex = createHash('sha256').update(key).digest('hex');
  return join(
    cacheRoot,
    '_cacache/index-v5',
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

function copyRequired(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`required offline dependency input is missing: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

function copyIndexedCacheEntry(cacheSource, cacheTarget, resolvedUrl) {
  const sourceIndex = indexPath(cacheSource, resolvedUrl);
  const targetIndex = indexPath(cacheTarget, resolvedUrl);
  copyRequired(sourceIndex, targetIndex);
  const records = readFileSync(sourceIndex, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(line.indexOf('\t') + 1)));
  for (const record of records) {
    if (typeof record.integrity !== 'string') continue;
    copyRequired(
      integrityContentPath(cacheSource, record.integrity),
      integrityContentPath(cacheTarget, record.integrity),
    );
  }
}

function locateHeaders(explicit) {
  const candidates = [
    explicit,
    resolve(dirname(process.execPath), '../include/node'),
    resolve(dirname(process.execPath), '../../include/node'),
    '/usr/local/include/node',
    '/opt/homebrew/include/node',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node.h'))) return candidate;
  }
  throw new Error(
    `matching Node headers were not found; checked: ${candidates.join(', ')}`,
  );
}

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else
        throw new Error(`offline support contains a non-file entry: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

function safeRemoveTemporary(path, parent) {
  const rel = relative(parent, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`refusing to remove unsafe temporary path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args['out-dir']);
  if (existsSync(outDir))
    throw new Error(`--out-dir already exists: ${outDir}`);
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.prepare-`));

  try {
    const boundary = readJson(
      join(REPO_ROOT, 'product/source-boundary.v1.json'),
    );
    const expectedNode = boundary.phase_1_platform.node;
    if (process.versions.node !== expectedNode) {
      throw new Error(
        `Node ${expectedNode} is required, received ${process.versions.node}`,
      );
    }
    const shrinkwrapPath = join(REPO_ROOT, 'npm-shrinkwrap.json');
    const shrinkwrap = productShrinkwrap(
      readJson(join(REPO_ROOT, 'product/package.template.json')),
      readJson(shrinkwrapPath),
    );
    const cacheSource = resolve(
      args['cache-source'] ??
        process.env.npm_config_cache ??
        join(REPO_ROOT, '.npm-cache'),
    );
    const cacheTarget = join(temporary, 'npm-cache');

    for (const [packagePath, metadata] of Object.entries(shrinkwrap.packages)) {
      if (packagePath === '') continue;
      if (metadata.inBundle === true) continue;
      if (metadata.link === true) {
        throw new Error(
          `product shrinkwrap must not contain workspace links: ${packagePath}`,
        );
      }
      if (
        typeof metadata.integrity !== 'string' ||
        typeof metadata.resolved !== 'string'
      ) {
        throw new Error(
          `shrinkwrapped package lacks resolved integrity: ${packagePath}`,
        );
      }
      const contentSource = integrityContentPath(
        cacheSource,
        metadata.integrity,
      );
      const contentTarget = integrityContentPath(
        cacheTarget,
        metadata.integrity,
      );
      copyRequired(contentSource, contentTarget);
      copyIndexedCacheEntry(cacheSource, cacheTarget, metadata.resolved);
    }
    const headersSource = locateHeaders(args['headers-source']);
    const nodedir = join(temporary, 'node-headers');
    mkdirSync(join(nodedir, 'include'), { recursive: true });
    cpSync(headersSource, join(nodedir, 'include/node'), {
      recursive: true,
      dereference: true,
    });
    writeFileSync(join(nodedir, 'node-version.txt'), `${expectedNode}\n`);
    for (const script of [
      'toolchain-preflight.mjs',
      'install-offline.mjs',
      'install-archive.mjs',
      'install-bundle.mjs',
      'install-echo-brain.command',
      'verify-bundle.mjs',
      'run-target-cell.mjs',
      'create-draft-report.mjs',
      'validate-qualification.mjs',
      'aggregate-evidence.mjs',
      'terminal-gate.mjs',
    ]) {
      cpSync(join(TOOL_DIR, script), join(temporary, script));
    }
    mkdirSync(join(temporary, 'schemas/product'), { recursive: true });
    for (const schema of [
      'qualification-report.v1.schema.json',
      'qualification-matrix.v1.json',
    ]) {
      cpSync(
        join(REPO_ROOT, 'schemas/product', schema),
        join(temporary, 'schemas/product', schema),
      );
    }
    mkdirSync(join(temporary, 'synthetic'), { recursive: true });
    writeFileSync(
      join(temporary, 'synthetic/seed.json'),
      '{"schema_version":1,"synthetic":true,"content":"fixture-only"}\n',
    );

    const preflight = runToolchainPreflight({ expectedNode, nodedir });
    writeFileSync(
      join(temporary, 'toolchain-preflight.json'),
      `${JSON.stringify({ ...preflight, nodedir: 'node-headers' }, null, 2)}\n`,
    );
    if (!preflight.ok) {
      throw new Error(
        'toolchain preflight failed while preparing offline dependencies',
      );
    }

    const manifestPath = join(temporary, 'support-manifest.json');
    const entries = filesUnder(temporary)
      .filter((path) => path !== manifestPath)
      .map((path) => ({
        path: relative(temporary, path).split(sep).join('/'),
        size: statSync(path).size,
        sha256: sha256File(path),
      }));
    const manifest = {
      schema_version: 1,
      node: {
        version: process.versions.node,
        modules: process.versions.modules,
        platform: process.platform,
        architecture: process.arch,
      },
      dependency_lock_sha256: sha256File(shrinkwrapPath),
      entries,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, outDir);
    process.stdout.write(
      `${JSON.stringify({ ok: true, out_dir: outDir, entries: entries.length })}\n`,
    );
  } catch (error) {
    if (existsSync(temporary)) safeRemoveTemporary(temporary, parent);
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`prepare-offline-deps: ${error.message}\n`);
    process.exitCode = 1;
  }
}
