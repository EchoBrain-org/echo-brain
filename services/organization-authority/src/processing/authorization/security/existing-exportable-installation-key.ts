import {
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  verifyInstallationKeyDescriptor,
  verifyP256LowSSignature,
  type InstallationKeyDescriptor,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';

const MAX_KEY_STATE_BYTES = 64 * 1024;

interface LoadedInstallationKey {
  descriptor: InstallationKeyDescriptor;
  privateKey: KeyObject;
}

function fail(message: string, cause?: unknown): never {
  throw new Error(`server installation key: ${message}`, { cause });
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
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

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    fail(`${label} must be canonical base64`);
  }
  return bytes;
}

function privateKeyFromPkcs8(bytes: Buffer): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  } catch (error) {
    fail('private PKCS#8 is invalid', error);
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

function descriptor(value: unknown): InstallationKeyDescriptor {
  const record = dataRecord(value, 'descriptor');
  exactKeys(
    record,
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
  const parsed = record as unknown as InstallationKeyDescriptor;
  try {
    verifyInstallationKeyDescriptor(parsed);
  } catch (error) {
    fail('descriptor is invalid', error);
  }
  if (
    parsed.protection !== 'development-file' ||
    parsed.assurance !== 'software_key_development_only' ||
    parsed.private_key_exportable !== true
  ) {
    fail('descriptor is not an exportable software file key');
  }
  return parsed;
}

function parseKeyState(raw: string): LoadedInstallationKey {
  let value: unknown;
  try {
    value = parseCanonicalJson(raw);
  } catch (error) {
    fail('key state must be canonical JSON', error);
  }
  const record = dataRecord(value, 'key state');
  exactKeys(
    record,
    ['schema_version', 'descriptor', 'private_key_pkcs8_der_base64'],
    'key state',
  );
  if (record['schema_version'] !== 1) {
    fail('key state schema_version must be 1');
  }
  const parsedDescriptor = descriptor(record['descriptor']);
  const privateKey = privateKeyFromPkcs8(
    canonicalBase64(
      record['private_key_pkcs8_der_base64'],
      'private PKCS#8',
    ),
  );
  const publicKey = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  if (
    !Buffer.isBuffer(publicKey) ||
    publicKey.toString('base64') !==
      parsedDescriptor.public_key_spki_der_base64 ||
    p256KeyId(publicKey) !== parsedDescriptor.key_id
  ) {
    fail('private key does not match the descriptor');
  }
  return { descriptor: parsedDescriptor, privateKey };
}

function readPrivateKeyState(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail('key state file is unavailable', error);
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) fail('key state must be a regular file');
    if ((status.mode & 0o777) !== 0o600) {
      fail('key state must have mode 0600');
    }
    if (
      typeof process.getuid === 'function' &&
      status.uid !== process.getuid()
    ) {
      fail('key state must belong to the current user');
    }
    if (status.size <= 0 || status.size > MAX_KEY_STATE_BYTES) {
      fail('key state exceeds its byte bound');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Read-only compatibility with the retired machine file signer.
 *
 * This class cannot create, rotate, or delete keys. Every inspection and sign
 * reopens the exact existing file with O_NOFOLLOW and revalidates its 0600
 * ownership, canonical descriptor, exportability, and private/public binding.
 */
export class ExistingExportableInstallationKey {
  readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path) || path.includes('\0')) {
      fail('key state path must be absolute');
    }
    this.path = path;
  }

  inspect(): InstallationKeyDescriptor {
    const loaded = parseKeyState(readPrivateKeyState(this.path));
    return structuredClone(loaded.descriptor);
  }

  sign(
    installationId: string,
    expectedKeyId: Sha256Digest,
    message: Uint8Array,
  ): Buffer {
    const loaded = parseKeyState(readPrivateKeyState(this.path));
    if (loaded.descriptor.installation_id !== installationId) {
      fail('key state belongs to another installation');
    }
    if (loaded.descriptor.key_id !== expectedKeyId) {
      fail('key state does not match the expected key');
    }
    const bytes = Buffer.from(message);
    const signature = normalizeP256LowS(
      signMessage('sha256', bytes, {
        key: loaded.privateKey,
        dsaEncoding: 'der',
      }),
    );
    const publicKey = Buffer.from(
      loaded.descriptor.public_key_spki_der_base64,
      'base64',
    );
    if (!verifyP256LowSSignature(publicKey, bytes, signature)) {
      fail('generated signature is invalid');
    }
    return signature;
  }

}
