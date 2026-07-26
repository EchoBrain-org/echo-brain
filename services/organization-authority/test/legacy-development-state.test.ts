import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federationId } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAuthorityDatabaseReadOnly } from '../src/adapters/persistence/sqlite/read-only-inspection.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../src/adapters/security/development-file-authority-signer.js';
import type { AuthorityServeConfig } from '../src/composition/config.js';
import { initializeMissingLegacyDevelopmentDatabase } from '../src/composition/legacy-development-state.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy development authority state compatibility', () => {
  it('creates a missing rehearsal database once without weakening normal serve', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'echo-authority-legacy-state-')),
    );
    temporaryRoots.push(root);
    const stateDirectory = join(root, 'state');
    const keyDirectory = join(stateDirectory, 'keys');
    const databasePath = join(stateDirectory, 'authority.sqlite');
    const authorityId = federationId('oau');
    const organizationId = federationId('org');
    const signer = DevelopmentFileOrganizationAuthoritySigner.initialize({
      directory: keyDirectory,
      authority_id: authorityId,
      organization_id: organizationId,
    });
    const descriptor = await signer.inspect();
    const config: AuthorityServeConfig = {
      state_directory: stateDirectory,
      authority_id: authorityId,
      organization_id: organizationId,
      key_directory: keyDirectory,
      organization_display_name: 'Legacy Phase 5 Company',
      authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
      database_path: databasePath,
      admin_token: 'a'.repeat(32),
      trusted_proxy_token: 'b'.repeat(32),
      host: '127.0.0.1',
      port: 39_479,
      active_lease_ttl_ms: 5_000,
      access_request_maximum_age_ms: 60_000,
    };

    await initializeMissingLegacyDevelopmentDatabase(config);
    const firstBytes = readFileSync(databasePath);
    expect(inspectAuthorityDatabaseReadOnly(databasePath)).toMatchObject({
      authority_id: authorityId,
      organization_id: organizationId,
      organization_display_name: 'Legacy Phase 5 Company',
    });

    await initializeMissingLegacyDevelopmentDatabase(config);
    expect(readFileSync(databasePath)).toEqual(firstBytes);
  });
});
