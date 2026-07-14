import dgram from 'node:dgram';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SANITIZED_CHILD_MARKER,
  spawnSanitizedChild,
} from '../../src/product/spawn-sanitized-child.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const PRODUCT_CONFIG = join(REPO_ROOT, 'vitest.product.config.ts');
const PRODUCT_SETUP = join(REPO_ROOT, 'tests/product/setup.ts');
const VITEST_CLI = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function collectChild(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawnSanitizedChild>[2] = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawnSanitizedChild(command, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', resolveStatus);
  });
  return { status, stdout, stderr };
}

function productSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productSourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('product hermeticity setup', () => {
  it('is registered for every product test file', () => {
    expect(globalThis.__ECHO_PRODUCT_HERMETICITY_GUARD__).toMatchObject({ active: true });
    const config = readFileSync(PRODUCT_CONFIG, 'utf8');
    expect(config).toContain("include: ['tests/product/**/*.test.ts']");
    expect(config).toContain("setupFiles: ['tests/product/setup.ts']");
  });

  it('blocks every enumerated in-worker network surface', () => {
    expect(() => fetch('https://example.invalid')).toThrow('product hermeticity guard');
    expect(() => net.connect(443, 'example.invalid')).toThrow('product hermeticity guard');
    expect(() => tls.connect(443, 'example.invalid')).toThrow('product hermeticity guard');
    expect(() => http.request('http://example.invalid')).toThrow('product hermeticity guard');
    expect(() => https.request('https://example.invalid')).toThrow('product hermeticity guard');
    expect(() => http2.connect('https://example.invalid')).toThrow('product hermeticity guard');
    expect(() => dgram.createSocket('udp4')).toThrow('product hermeticity guard');
    expect(() => dns.lookup('example.invalid', () => undefined)).toThrow(
      'product hermeticity guard',
    );
    expect(() => dns.promises.lookup('example.invalid')).toThrow('product hermeticity guard');
  });

  it('blocks credential environment reads and clears product overrides', () => {
    expect(() => process.env.ANTHROPIC_API_KEY).toThrow('credential environment access');
    expect(process.env.ECHO_HOME).toBeUndefined();
    expect(process.env.ECHO_LOG_LEVEL).toBeUndefined();
  });

  it('keeps real wall-clock reads out of product modules', () => {
    const offenders = productSourceFiles(join(REPO_ROOT, 'src/product')).filter((path) => {
      const source = readFileSync(path, 'utf8');
      return /\bDate\.now\s*\(|\bnew\s+Date\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('sanitized child process boundary', () => {
  it('removes credentials and overrides inside the sentinel child', async () => {
    const script = [
      'const keys = [',
      "  'ANTHROPIC_API_KEY', 'GRANOLA_API_KEY', 'NPM_TOKEN', 'ECHO_TEST_OVERRIDE',",
      `  '${SANITIZED_CHILD_MARKER}', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',`,
      "  'NO_PROXY', 'npm_config_offline', 'CUSTOM_SENTINEL'",
      '];',
      'console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));',
    ].join('\n');
    const result = await collectChild(process.execPath, ['-e', script], {
      env: {
        ANTHROPIC_API_KEY: 'secret',
        GRANOLA_API_KEY: 'secret',
        NPM_TOKEN: 'secret',
        ECHO_TEST_OVERRIDE: 'unsafe',
        CUSTOM_SENTINEL: 'visible',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      [SANITIZED_CHILD_MARKER]: '1',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
      npm_config_offline: 'true',
      CUSTOM_SENTINEL: 'visible',
    });
  });

  it('makes an empty-cache npm lookup fail offline instead of fetching', async () => {
    const cache = temporaryDirectory('echo-product-empty-npm-cache-');
    const result = await collectChild(
      'npm',
      [
        'view',
        '@echo/product-hermeticity-cache-miss-132',
        'version',
        '--cache',
        cache,
        '--offline',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: cache },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/cache miss|offline mode|ENOTCACHED/i);
  });

  it('fails red fixture files for direct spawn, dgram, and DNS access', async () => {
    const fixtureRoot = temporaryDirectory('echo-product-hermetic-red-');
    writeFileSync(
      join(fixtureRoot, 'vitest.config.mjs'),
      [
        'export default {',
        `  root: ${JSON.stringify(fixtureRoot)},`,
        '  test: {',
        '    globals: true,',
        "    include: ['*.test.ts'],",
        `    setupFiles: [${JSON.stringify(PRODUCT_SETUP)}],`,
        '    fileParallelism: false,',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'direct-spawn.test.ts'),
      [
        "import { spawn } from 'node:child_process';",
        "test('direct spawn is red', () => spawn(process.execPath, ['-e', '']));",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'dgram-red.test.ts'),
      [
        "import dgram from 'node:dgram';",
        "test('dgram is red', () => dgram.createSocket('udp4'));",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'dns-red.test.ts'),
      [
        "import dns from 'node:dns';",
        "test('DNS is red', () => dns.lookup('example.invalid', () => undefined));",
        '',
      ].join('\n'),
    );

    const result = await collectChild(
      process.execPath,
      [VITEST_CLI, 'run', '--config', join(fixtureRoot, 'vitest.config.mjs')],
      { cwd: REPO_ROOT },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain('direct-spawn.test.ts');
    expect(output).toContain('dgram-red.test.ts');
    expect(output).toContain('dns-red.test.ts');
    expect(output).toContain('product hermeticity guard');
  });
});
