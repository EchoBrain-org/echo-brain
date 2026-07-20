import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import { join } from "node:path";
import { atomicCreate } from "../../../infrastructure/filesystem/atomic-create.js";
import {
  assertPrivateOwnedDirectory,
  assertPrivateOwnedRegularFile,
  canonicalLocalPath,
  ensureDirectory,
  pathEntryExists,
  readFileNoFollow,
} from "../../secure-local-files.js";
import type { Sha256Digest } from "../contracts.js";
import { canonicalJson, parseCanonicalJson } from "./canonical-json.js";
import { assertFederationId } from "./identifiers.js";
import type {
  InstallationKeyDescriptor,
  InstallationSigner,
} from "./installation-signer.js";
import { verifyInstallationKeyDescriptor } from "./installation-signer.js";
import { normalizeP256LowS, p256KeyId } from "./signature-profile.js";

const PRIVATE_KEY_SUFFIX = ".private.pk8";
const DESCRIPTOR_SUFFIX = ".descriptor.v1.json";

interface StoredKey {
  descriptor: InstallationKeyDescriptor;
  privateKey: KeyObject;
}

function fail(message: string): never {
  throw new Error(`development file installation signer: ${message}`);
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("descriptor has an unexpected shape");
  }
}

function parseDescriptor(raw: string): InstallationKeyDescriptor {
  const value = parseCanonicalJson(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("descriptor must be one canonical JSON object");
  }
  assertExactKeys(value, [
    "installation_id",
    "key_id",
    "algorithm",
    "public_key_spki_der_base64",
    "protection",
    "assurance",
    "private_key_exportable",
  ]);
  const descriptor = value as InstallationKeyDescriptor;
  verifyInstallationKeyDescriptor(descriptor);
  if (
    descriptor.protection !== "development-file" ||
    descriptor.assurance !== "software_key_development_only" ||
    descriptor.private_key_exportable !== true
  ) {
    fail("descriptor is not an explicit development-file key");
  }
  return descriptor;
}

function privateKeyFromPkcs8(bytes: Buffer): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  } catch (error) {
    fail(`private PKCS#8 is invalid: ${(error as Error).message}`);
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    fail("private key must be P-256 PKCS#8");
  }
  const canonical = privateKey.export({ format: "der", type: "pkcs8" });
  if (!Buffer.isBuffer(canonical) || !canonical.equals(bytes)) {
    fail("private key must use canonical PKCS#8 DER bytes");
  }
  return privateKey;
}

/**
 * Unencrypted, exportable P-256 keys for the disposable N=2 development pilot.
 * The caller must provide a private current-user directory. This signer offers
 * no encryption, rotation, backup, recovery, or production assurance.
 */
export class FileInstallationSigner implements InstallationSigner {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = canonicalLocalPath(
      directory,
      "development file signer directory",
      false,
    );
    ensureDirectory(this.directory, 0o700);
    assertPrivateOwnedDirectory(
      this.directory,
      "development file signer directory",
    );
  }

  private paths(installationId: string): {
    privateKey: string;
    descriptor: string;
  } {
    assertFederationId(
      installationId,
      "ins",
      "development file signer installation_id",
    );
    return {
      privateKey: join(
        this.directory,
        `${installationId}${PRIVATE_KEY_SUFFIX}`,
      ),
      descriptor: join(this.directory, `${installationId}${DESCRIPTOR_SUFFIX}`),
    };
  }

  private load(installationId: string): StoredKey | null {
    assertPrivateOwnedDirectory(
      this.directory,
      "development file signer directory",
    );
    const paths = this.paths(installationId);
    const privateKeyExists = pathEntryExists(paths.privateKey);
    const descriptorExists = pathEntryExists(paths.descriptor);
    if (!privateKeyExists && !descriptorExists) return null;
    if (privateKeyExists !== descriptorExists) {
      fail(`key state for ${installationId} is incomplete`);
    }
    assertPrivateOwnedRegularFile(paths.privateKey, 0o600, () => {
      fail("private PKCS#8 must be a current-user regular file with mode 0600");
    });
    assertPrivateOwnedRegularFile(paths.descriptor, 0o600, () => {
      fail("descriptor must be a current-user regular file with mode 0600");
    });
    const privateKey = privateKeyFromPkcs8(
      readFileNoFollow(paths.privateKey, "development private PKCS#8"),
    );
    const descriptor = parseDescriptor(
      readFileNoFollow(paths.descriptor, "development key descriptor").toString(
        "utf8",
      ),
    );
    if (descriptor.installation_id !== installationId) {
      fail("descriptor belongs to another installation");
    }
    const publicKey = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    if (
      !Buffer.isBuffer(publicKey) ||
      publicKey.toString("base64") !== descriptor.public_key_spki_der_base64 ||
      p256KeyId(publicKey) !== descriptor.key_id
    ) {
      fail("private PKCS#8 does not match the persisted descriptor");
    }
    return { descriptor, privateKey };
  }

  async generate(installationId: string): Promise<InstallationKeyDescriptor> {
    const existing = this.load(installationId);
    if (existing !== null) return structuredClone(existing.descriptor);

    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const privatePkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const publicSpki = publicKey.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(privatePkcs8) || !Buffer.isBuffer(publicSpki)) {
      fail("P-256 key export did not return DER bytes");
    }
    const descriptor: InstallationKeyDescriptor = {
      installation_id: installationId,
      key_id: p256KeyId(publicSpki),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicSpki.toString("base64"),
      protection: "development-file",
      assurance: "software_key_development_only",
      private_key_exportable: true,
    };
    verifyInstallationKeyDescriptor(descriptor);
    const paths = this.paths(installationId);
    if (
      !atomicCreate({
        filePath: paths.privateKey,
        content: privatePkcs8,
        mode: 0o600,
      })
    ) {
      fail(`private key for ${installationId} already exists`);
    }
    if (
      !atomicCreate({
        filePath: paths.descriptor,
        content: canonicalJson(descriptor),
        mode: 0o600,
      })
    ) {
      fail(`descriptor for ${installationId} already exists`);
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
      fail("signing requires the expected key fingerprint");
    }
    const stored = this.load(installationId);
    if (stored === null) fail("signing key is unavailable");
    if (stored.descriptor.key_id !== expectedKeyId) {
      fail("signing key does not match expected_key_id");
    }
    return normalizeP256LowS(
      signMessage("sha256", Buffer.from(message), {
        key: stored.privateKey,
        dsaEncoding: "der",
      }),
    );
  }
}
