import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('retrieval workspace boundary', () => {
  it('declares no Authority, record, or control-plane workspace dependency', () => {
    const manifest = readFileSync(resolve(root, 'source-boundary.v1.json'), 'utf8');
    const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
    expect(manifest).toContain('services/organization-authority');
    expect(manifest).toContain('packages/organization-record');
    expect(packageJson).not.toContain('organization-authority');
    expect(packageJson).not.toContain('organization-record');
    expect(packageJson).not.toContain('organization-control-plane');
  });
});
