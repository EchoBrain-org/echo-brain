import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AdminBearerAuthenticator } from '../adapters/security/admin-bearer-authenticator.js';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  CryptoEnrollmentGrantGenerator,
  RandomAuthorityIdentifierGenerator,
  SystemAuthorityClock,
} from '../adapters/runtime/system-runtime-ports.js';
import { SqliteOrganizationAuthorityRepository } from '../adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAuthorityApplication } from '../application/organization-authority.js';
import { createOrganizationAuthorityHttpServer } from '../presentation/http-server.js';
import { AuthenticatedProxyClientIdentityResolver } from '../presentation/trusted-proxy-client-identity.js';
import {
  assertIndependentAuthorityTokens,
  assertPersistentAuthorityDatabasePath,
  type AuthorityServeConfig,
} from './config.js';

export interface RunningOrganizationAuthority {
  address: AddressInfo;
  close(): Promise<void>;
}

export async function startOrganizationAuthority(
  config: AuthorityServeConfig,
): Promise<RunningOrganizationAuthority> {
  assertPersistentAuthorityDatabasePath(config.database_path);
  assertIndependentAuthorityTokens(
    config.admin_token,
    config.trusted_proxy_token,
  );
  const adminAuthenticator = new AdminBearerAuthenticator(config.admin_token);
  const clientIdentityResolver = new AuthenticatedProxyClientIdentityResolver(
    config.trusted_proxy_token,
  );
  const signer = DevelopmentFileOrganizationAuthoritySigner.open({
    directory: config.key_directory,
    authority_id: config.authority_id,
    organization_id: config.organization_id,
  });
  const repository = new SqliteOrganizationAuthorityRepository(
    config.database_path,
  );
  let application: OrganizationAuthorityApplication;
  try {
    application = await OrganizationAuthorityApplication.create({
      repository,
      signer,
      clock: new SystemAuthorityClock(),
      identifiers: new RandomAuthorityIdentifierGenerator(),
      grants: new CryptoEnrollmentGrantGenerator(),
      independently_trusted_authority_pin: config.authority_pin_sha256,
      organization_display_name: config.organization_display_name,
      active_lease_ttl_ms: config.active_lease_ttl_ms,
      access_request_maximum_age_ms: config.access_request_maximum_age_ms,
    });
  } catch (error) {
    repository.close();
    throw error;
  }
  let server: ReturnType<typeof createOrganizationAuthorityHttpServer>;
  try {
    server = createOrganizationAuthorityHttpServer({
      application,
      adminAuthenticator,
      clientIdentityResolver,
    });
  } catch (error) {
    application.close();
    throw error;
  }
  server.listen(config.port, config.host);
  try {
    await once(server, 'listening');
  } catch (error) {
    application.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    application.close();
    throw new Error('organization authority did not bind a TCP address');
  }
  let closed = false;
  return {
    address,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const closeEvent = once(server, 'close');
      server.close();
      await closeEvent;
      application.close();
    },
  };
}
