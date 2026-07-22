import { canonicalJson } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import { DevelopmentFileOrganizationAuthoritySigner } from '../adapters/security/development-file-authority-signer.js';
import {
  loadAuthorityServeConfig,
  loadDevelopmentSignerConfig,
} from './config.js';
import { startOrganizationAuthority } from './runtime.js';

export async function runOrganizationAuthorityCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const command = arguments_[0];
  if (command === 'init-development') {
    const config = loadDevelopmentSignerConfig(environment);
    const signer = DevelopmentFileOrganizationAuthoritySigner.open({
      directory: config.key_directory,
      authority_id: config.authority_id,
      organization_id: config.organization_id,
    });
    const descriptor = await signer.inspect();
    process.stdout.write(
      `${canonicalJson({
        authority_descriptor: descriptor,
        authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
      })}\n`,
    );
    return;
  }
  if (command !== 'serve') {
    throw new Error('usage: organization-authority <init-development|serve>');
  }
  const runtime = await startOrganizationAuthority(
    loadAuthorityServeConfig(environment),
  );
  process.stderr.write(
    `organization authority listening on ${runtime.address.address}:${runtime.address.port}\n`,
  );
  const shutdown = (): void => {
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
