// The capture core stays vendor-free: a tool is data (adapter ID, reference prefix,
// origin), never a branch. A provider is its own workspace plus one config row.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const VENDOR_NAMES = /slack|jira|granola/i;
const CORE_CAPTURE_FILES = [
  // V2 contracts and the Layer 1 store.
  'packages/organization-processing/src/core/contracts/context-capture-v2.ts',
  'packages/organization-processing/src/core/contracts/capture-source-ref-v1.ts',
  'packages/organization-processing/src/core/contracts/capture-container-scope-v1.ts',
  'packages/organization-processing/src/core/contracts/context-derivation-v1.ts',
  'services/organization-authority/src/application/capture-foundation-v1.ts',
  'services/organization-authority/src/adapters/persistence/sqlite/capture-foundation-v1.ts',
  // The vendor-free capture runtime.
  'packages/organization-processing/src/core/contracts/capture-source-v2.ts',
  'packages/organization-processing/src/core/contracts/capture-source-config-v1.ts',
  'packages/organization-processing/src/core/processing/capture-classification-v1.ts',
  'services/organization-authority/src/application/capture-source-authority-v1.ts',
  'services/organization-authority/src/application/capture-source-run-v1.ts',
  'services/organization-authority/src/adapters/persistence/sqlite/capture-cursors-v1.ts',
  'services/organization-authority/src/composition/capture-source-runner-v1.ts',
  // The fake provider and the tests that prove the core against it.
  'tests/support/context-capture-v2.ts',
  'tests/support/capture-fake-provider-v2.ts',
  'packages/organization-processing/test/core/capture-source-v2.test.ts',
  'services/organization-authority/test/capture-source-run-v1.test.ts',
] as const;

describe('capture core vendor neutrality', () => {
  it.each(CORE_CAPTURE_FILES)('%s names no vendor and imports no provider', (path) => {
    const absolute = resolve(REPOSITORY_ROOT, path);
    expect(existsSync(absolute), `${path} moved; update this list`).toBe(true);
    const source = readFileSync(absolute, 'utf8');
    const vendors = source.split('\n').flatMap((line, index) => (VENDOR_NAMES.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
    expect(vendors).toEqual([]);
    expect(source).not.toMatch(/@echo-brain\/provider-|providers\//);
  });
});
