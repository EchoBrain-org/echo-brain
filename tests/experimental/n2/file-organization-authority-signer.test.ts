import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileOrganizationAuthoritySigner } from '../../../src/experimental/n2/authority/file-organization-authority-signer.js';
import { signWithOrganizationAuthority } from '../../../src/experimental/n2/authority/authority-signer.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000002';
const roots: string[] = [];

function signerDirectory(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-file-authority-')),
  );
  roots.push(root);
  return join(root, 'keys');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('development file organization authority signer', () => {
  it('creates once, resumes the same authority key, and signs', async () => {
    const directory = signerDirectory();
    const first = await FileOrganizationAuthoritySigner.open({
      directory,
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
    });
    const firstDescriptor = await first.inspect();
    const signature = await signWithOrganizationAuthority(
      first,
      firstDescriptor,
      Buffer.from('authority pilot message'),
    );
    expect(signature.length).toBeGreaterThan(0);

    const resumed = await FileOrganizationAuthoritySigner.open({
      directory,
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
    });
    await expect(resumed.inspect()).resolves.toEqual(firstDescriptor);
  });
});
