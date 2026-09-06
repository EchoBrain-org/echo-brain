import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const RULES = [
  'no-dupe-keys',
  'no-unreachable',
  'no-unsafe-finally',
  'valid-typeof',
];
const BROKEN_TOOL = `
const duplicateKey = { once: 1, once: 2 };
function unsafeFinally() { try { return 1; } finally { return 2; } }
function unreachable() { return 1; const never = 2; }
if (typeof duplicateKey === 'misspelled-type') { unsafeFinally(); }
`;

describe('tooling JavaScript lint coverage', () => {
  it('applies correctness rules to tools and release scripts', async () => {
    const eslint = new ESLint({ cwd: REPO });
    for (const path of ['tools/lint-sentinel.mjs', 'deploy/release/lint-sentinel.mjs']) {
      const [result] = await eslint.lintText(BROKEN_TOOL, { filePath: resolve(REPO, path) });
      expect(new Set(result.messages.map((message) => message.ruleId))).toEqual(new Set(RULES));
    }
  });
});
