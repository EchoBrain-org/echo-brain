// Rehearsal fault injection deliberately destroys stored product state. The
// Phase 5 ceremony needs it, but a client installation must never carry it:
// tools/product/build-artifact.mjs compiles `files: closure.closure`, so any
// module the product boundary closure reaches is compiled into the shipped
// package. Keeping such a hook out of that closure is what keeps it out of the
// artifact, and this test is the thing that notices when it drifts back in.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSanitizedChild } from '../../src/product/spawn-sanitized-child.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CHECK_BOUNDARY = join(REPO_ROOT, 'tools/product/check-boundary.mjs');
const MANIFEST = 'product/source-boundary.v1.json';

// A rehearsal-only hook names itself. Both halves are load-bearing: the suffix
// is the repository's convention for these hooks, and `corrupt` catches a hook
// that is renamed without adopting the convention.
const REHEARSAL_HOOK = /\b(?:\w*ForRehearsal|corrupt\w*)\b/;
const EXPORTED_NAME =
  /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface BoundaryResult {
  closure: string[];
}

async function productClosure(): Promise<string[]> {
  const output = join(
    mkdtempSync(join(tmpdir(), 'echo-shipped-closure-')),
    'closure.json',
  );
  temporaryDirectories.push(output);
  const child = spawnSanitizedChild(
    process.execPath,
    [CHECK_BOUNDARY, '--manifest', MANIFEST, '--output', output],
    { cwd: REPO_ROOT },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', resolveStatus);
  });
  expect(status, stderr).toBe(0);
  return (JSON.parse(readFileSync(output, 'utf8')) as BoundaryResult).closure;
}

function exportedNames(source: string): string[] {
  return [...source.matchAll(EXPORTED_NAME)].map((match) => match[1]!);
}

describe('shipped product artifact', () => {
  it('reaches no rehearsal fault-injection hook from its entry points', async () => {
    const closure = await productClosure();
    expect(closure).not.toEqual([]);
    const shipped = closure.flatMap((path) =>
      exportedNames(readFileSync(join(REPO_ROOT, path), 'utf8'))
        .filter((name) => REHEARSAL_HOOK.test(name))
        .map((name) => `${path}: ${name}`),
    );
    expect(shipped).toEqual([]);
  });

  it('keeps the hook off the organization export surface', () => {
    const index = readFileSync(
      join(REPO_ROOT, 'src/product/organization/index.ts'),
      'utf8',
    );
    const reexported = [...index.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
      .map((match) => match[1]!)
      .filter((name) => REHEARSAL_HOOK.test(name));
    expect(reexported).toEqual([]);
  });
});
