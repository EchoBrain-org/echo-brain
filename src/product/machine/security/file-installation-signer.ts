import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFederationId,
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { atomicCreate } from '../../../infrastructure/filesystem/atomic-create.js';
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  canonicalLocalPath,
  ensureDirectory,
  fsyncDirectory,
  pathEntryExists,
  readFileNoFollow,
} from '../../secure-local-files.js';
import {
  verifyInstallationKeyDescriptor,
  type InstallationKeyDescriptor,
  type InstallationSigner,
} from './installation-signer.js';

const KEY_STATE_SUFFIX = '.key-state.v1.json';

interface StoredKey {
  descriptor: InstallationKeyDescriptor;
  privateKey: KeyObject;
}

interface StoredKeyStateV1 {
  schema_version: 1;
  descriptor: InstallationKeyDescriptor;
  private_key_pkcs8_der_base64: string;
}

function fail(message: string): never {
  throw new Error(`file installation signer: ${message}`);
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

function parseDescriptor(raw: string): InstallationKeyDescriptor {
  const value = parseCanonicalJson(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('descriptor must be one canonical JSON object');
  }
  assertExactKeys(
    value,
    [
      'installation_id',
      'key_id',
      'algorithm',
      'public_key_spki_der_base64',
      'protection',
      'assurance',
      'private_key_exportable',
    ],
    'descriptor',
  );
  const descriptor = value as InstallationKeyDescriptor;
  verifyInstallationKeyDescriptor(descriptor);
  if (
    descriptor.protection !== 'development-file' ||
    descriptor.assurance !== 'software_key_development_only' ||
    descriptor.private_key_exportable !== true
  ) {
    fail('descriptor is not a software file key');
  }
  return descriptor;
}

function parseStoredKeyState(raw: string): StoredKey {
  const value = parseCanonicalJson(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('key state must be one canonical JSON object');
  }
  assertExactKeys(
    value,
    ['schema_version', 'descriptor', 'private_key_pkcs8_der_base64'],
    'key state',
  );
  const record = value as Record<string, unknown>;
  if (record['schema_version'] !== 1) {
    fail('key state schema_version must be 1');
  }
  const privateKeyBase64 = record['private_key_pkcs8_der_base64'];
  if (
    typeof privateKeyBase64 !== 'string' ||
    privateKeyBase64.length === 0 ||
    Buffer.from(privateKeyBase64, 'base64').toString('base64') !==
      privateKeyBase64
  ) {
    fail('private PKCS#8 must use canonical base64');
  }
  return {
    descriptor: parseDescriptor(canonicalJson(record['descriptor'])),
    privateKey: privateKeyFromPkcs8(Buffer.from(privateKeyBase64, 'base64')),
  };
}

function privateKeyFromPkcs8(bytes: Buffer): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  } catch (error) {
    fail(`private PKCS#8 is invalid: ${(error as Error).message}`);
  }
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    fail('private key must be P-256 PKCS#8');
  }
  const canonical = privateKey.export({ format: 'der', type: 'pkcs8' });
  if (!Buffer.isBuffer(canonical) || !canonical.equals(bytes)) {
    fail('private key must use canonical PKCS#8 DER bytes');
  }
  return privateKey;
}

/**
 * Portable pilot signer. Keys are exportable software keys stored in one
 * atomically created 0600 state file below a current-user 0700 directory. The
 * public descriptor records that lower assurance explicitly.
 */
export class FileInstallationSigner implements InstallationSigner {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = canonicalLocalPath(
      directory,
      'file installation signer directory',
      false,
    );
  }

  private keyStatePath(installationId: string): string {
    assertFederationId(
      installationId,
      'ins',
      'file signer installation_id',
    );
    return join(this.directory, `${installationId}${KEY_STATE_SUFFIX}`);
  }

  private load(installationId: string): StoredKey | null {
    if (!pathEntryExists(this.directory)) return null;
    assertPrivateOwnedDirectory(
      this.directory,
      'file installation signer directory',
    );
    const keyStatePath = this.keyStatePath(installationId);
    if (!pathEntryExists(keyStatePath)) return null;
    assertPrivateOwnedRegularFile(keyStatePath, 0o600, () => {
      fail('key state must be a current-user regular file with mode 0600');
    });
    const { descriptor, privateKey } = parseStoredKeyState(
      readFileNoFollow(keyStatePath, 'installation key state').toString('utf8'),
    );
    if (descriptor.installation_id !== installationId) {
      fail('descriptor belongs to another installation');
    }
    const publicKey = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    });
    if (
      !Buffer.isBuffer(publicKey) ||
      publicKey.toString('base64') !== descriptor.public_key_spki_der_base64 ||
      p256KeyId(publicKey) !== descriptor.key_id
    ) {
      fail('private PKCS#8 does not match the persisted descriptor');
    }
    return { descriptor, privateKey };
  }

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    const existing = this.load(installationId);
    if (existing !== null) return structuredClone(existing.descriptor);

    ensureDirectory(this.directory, 0o700);
    assertPrivateOwnedDirectory(
      this.directory,
      'file installation signer directory',
    );
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const privatePkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const publicSpki = publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.isBuffer(privatePkcs8) || !Buffer.isBuffer(publicSpki)) {
      fail('P-256 key export did not return DER bytes');
    }
    const descriptor: InstallationKeyDescriptor = {
      installation_id: installationId,
      key_id: p256KeyId(publicSpki),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicSpki.toString('base64'),
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    };
    verifyInstallationKeyDescriptor(descriptor);
    const keyState: StoredKeyStateV1 = {
      schema_version: 1,
      descriptor,
      private_key_pkcs8_der_base64: privatePkcs8.toString('base64'),
    };
    const keyStatePath = this.keyStatePath(installationId);
    if (
      !atomicCreate({
        filePath: keyStatePath,
        content: canonicalJson(keyState),
        mode: 0o600,
      })
    ) {
      const concurrent = this.load(installationId);
      if (concurrent === null) {
        fail(`key state for ${installationId} already exists but is unavailable`);
      }
      return structuredClone(concurrent.descriptor);
    }
    return structuredClone(this.load(installationId)!.descriptor);
  }

  async inspect(
    installationId: string,
  ): Promise<InstallationKeyDescriptor | null> {
    const stored = this.load(installationId);
    return stored === null ? null : structuredClone(stored.descriptor);
  }

  async sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer> {
    if (expectedKeyId === undefined) {
      fail('signing requires the expected key fingerprint');
    }
    const stored = this.load(installationId);
    if (stored === null) fail('signing key is unavailable');
    if (stored.descriptor.key_id !== expectedKeyId) {
      fail('signing key does not match expected_key_id');
    }
    return normalizeP256LowS(
      signMessage('sha256', Buffer.from(message), {
        key: stored.privateKey,
        dsaEncoding: 'der',
      }),
    );
  }

  async deleteOrphan(
    installationId: string,
    expectedKeyId: Sha256Digest,
  ): Promise<boolean> {
    const stored = this.load(installationId);
    if (stored === null) return false;
    if (stored.descriptor.key_id !== expectedKeyId) {
      fail('refusing to delete a key with a different fingerprint');
    }
    unlinkSync(this.keyStatePath(installationId));
    fsyncDirectory(this.directory);
    return true;
  }
}
