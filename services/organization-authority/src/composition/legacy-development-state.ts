import { existsSync } from 'node:fs';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import type { AuthorityServeConfig } from './config.js';

/**
 * Temporary compatibility for the exact-artifact Phase 5 rehearsal. The
 * legacy environment-only flow historically created its database on first
 * serve. Keep that behavior isolated here; config-backed Phase 1 serve never
 * calls this function and remains strictly non-creating.
 */
export async function initializeMissingLegacyDevelopmentDatabase(
  config: AuthorityServeConfig,
): Promise<void> {
  if (existsSync(config.database_path)) return;
  const signer = DevelopmentFileOrganizationAuthoritySigner.openExisting({
    directory: config.key_directory,
    authority_id: config.authority_id,
    organization_id: config.organization_id,
  });
  const descriptor = await signer.inspect();
  const repository = new SqliteOrganizationAuthorityRepository(
    config.database_path,
  );
  try {
    repository.initialize({
      descriptor,
      authority_pin_sha256: config.authority_pin_sha256,
      organization_display_name: config.organization_display_name,
      maximum_active_lease_ttl_ms: config.active_lease_ttl_ms,
      initialized_at: new Date().toISOString(),
    });
  } finally {
    repository.close();
  }
}
