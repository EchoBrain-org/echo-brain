import type {
  FederationId,
  OrganizationAuthorityDescriptorV1,
  Sha256Digest,
} from '../contracts.js';
import { FileInstallationSigner } from '../foundation/file-installation-signer.js';
import { assertFederationId } from '../foundation/identifiers.js';
import type { InstallationKeyDescriptor } from '../foundation/installation-signer.js';
import { signWithInstallationKey } from '../foundation/installation-signer.js';
import type { OrganizationAuthoritySigner } from './authority-signer.js';

export interface OpenFileOrganizationAuthoritySignerOptions {
  directory: string;
  authorityId: FederationId;
  organizationId: FederationId;
}

function fail(message: string): never {
  throw new Error(`development file organization authority signer: ${message}`);
}

function keySlotForAuthority(authorityId: string): string {
  assertFederationId(authorityId, 'oau', 'file authority signer authority_id');
  return `ins_${authorityId.slice('oau_'.length)}`;
}

/**
 * Disposable-pilot authority adapter over one unencrypted development-file
 * key. The authority database, not this adapter, pins the full public
 * authority/organization descriptor. Loss of the directory requires resetting
 * and reenrolling the pilot.
 */
export class FileOrganizationAuthoritySigner implements OrganizationAuthoritySigner {
  private constructor(
    private readonly installationSigner: FileInstallationSigner,
    private readonly authorityId: FederationId,
    private readonly organizationId: FederationId,
    private readonly keySlotId: FederationId,
    private readonly pinnedKey: InstallationKeyDescriptor,
  ) {}

  static async open(
    options: OpenFileOrganizationAuthoritySignerOptions,
  ): Promise<FileOrganizationAuthoritySigner> {
    assertFederationId(
      options.authorityId,
      'oau',
      'file authority signer authority_id',
    );
    assertFederationId(
      options.organizationId,
      'org',
      'file authority signer organization_id',
    );
    const keySlotId = keySlotForAuthority(options.authorityId);
    const installationSigner = new FileInstallationSigner(options.directory);
    const key =
      (await installationSigner.inspect(keySlotId)) ??
      (await installationSigner.generate(keySlotId));
    return new FileOrganizationAuthoritySigner(
      installationSigner,
      options.authorityId,
      options.organizationId,
      keySlotId,
      key,
    );
  }

  private async currentKey(): Promise<InstallationKeyDescriptor> {
    const key = await this.installationSigner.inspect(this.keySlotId);
    if (key === null) fail('authority key is unavailable');
    if (
      key.key_id !== this.pinnedKey.key_id ||
      key.public_key_spki_der_base64 !==
        this.pinnedKey.public_key_spki_der_base64
    ) {
      fail('authority key differs from the key opened for this process');
    }
    return key;
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    const key = await this.currentKey();
    return {
      schema_version: 1,
      kind: 'echo-organization-authority',
      authority_id: this.authorityId,
      organization_id: this.organizationId,
      signing_key: {
        key_id: key.key_id,
        algorithm: key.algorithm,
        public_key_spki_der_base64: key.public_key_spki_der_base64,
      },
    };
  }

  async sign(message: Buffer, expectedKeyId?: Sha256Digest): Promise<Buffer> {
    if (expectedKeyId === undefined) {
      fail('signing requires the expected key fingerprint');
    }
    const key = await this.currentKey();
    if (key.key_id !== expectedKeyId) {
      fail('signing key does not match expected_key_id');
    }
    return signWithInstallationKey(
      this.installationSigner,
      this.keySlotId,
      expectedKeyId,
      Buffer.from(message),
    );
  }
}
