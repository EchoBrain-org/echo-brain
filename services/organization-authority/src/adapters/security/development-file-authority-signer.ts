import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import {
  assertFederationId,
  canonicalJson,
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityDescriptor } from "@echo-brain/organization-protocol";
import type { OrganizationAuthorityDescriptorV1 } from "@echo-brain/organization-protocol";
import type { OrganizationAuthoritySigner } from "../../application/ports/runtime-ports.js";

export const DEVELOPMENT_AUTHORITY_KEY_FILENAME =
  "authority-development-key.v1.json";
const MAX_KEY_FILE_BYTES = 8 * 1024;

interface StoredDevelopmentKey {
  schema_version: 1;
  descriptor: OrganizationAuthorityDescriptorV1;
  private_key_pkcs8_der_base64: string;
}

function fail(message: string): never {
  throw new Error(`development authority signer: ${message}`);
}

function assertPrivateDirectory(directory: string): void {
  const state = lstatSync(directory);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o700
  ) {
    fail("directory must be a current-user 0700 directory");
  }
}

function readKeyFile(path: string): StoredDevelopmentKey {
  const descriptor = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    descriptor.isSymbolicLink() ||
    !descriptor.isFile() ||
    descriptor.size <= 0 ||
    descriptor.size > MAX_KEY_FILE_BYTES ||
    (currentUid !== undefined && descriptor.uid !== currentUid) ||
    (descriptor.mode & 0o777) !== 0o600
  ) {
    fail("key file must be a bounded current-user 0600 regular file");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(file);
    if (opened.dev !== descriptor.dev || opened.ino !== descriptor.ino) {
      fail("key file changed while opening");
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseCanonicalJson(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      fail("key file is not an object");
    }
    const record = parsed as unknown as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
      "descriptor,private_key_pkcs8_der_base64,schema_version"
    ) {
      fail("key file has an unexpected shape");
    }
    if (
      record.schema_version !== 1 ||
      typeof record.private_key_pkcs8_der_base64 !== "string"
    ) {
      fail("key file version or private key is invalid");
    }
    const authorityDescriptor = validateOrganizationAuthorityDescriptor(
      record.descriptor,
    );
    const privateBytes = Buffer.from(
      record.private_key_pkcs8_der_base64,
      "base64",
    );
    if (
      privateBytes.length === 0 ||
      privateBytes.toString("base64") !== record.private_key_pkcs8_der_base64
    ) {
      fail("private key is not canonical base64");
    }
    const privateKey = createPrivateKey({
      key: privateBytes,
      format: "der",
      type: "pkcs8",
    });
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      fail("private key must be P-256 PKCS#8");
    }
    const publicBytes = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    if (
      !Buffer.isBuffer(publicBytes) ||
      publicBytes.toString("base64") !==
        authorityDescriptor.signing_key.public_key_spki_der_base64 ||
      p256KeyId(publicBytes) !== authorityDescriptor.signing_key.key_id
    ) {
      fail("private key does not match the authority descriptor");
    }
    return {
      schema_version: 1,
      descriptor: authorityDescriptor,
      private_key_pkcs8_der_base64: record.private_key_pkcs8_der_base64,
    };
  } finally {
    closeSync(file);
  }
}

function privateKey(value: StoredDevelopmentKey): KeyObject {
  return createPrivateKey({
    key: Buffer.from(value.private_key_pkcs8_der_base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export class DevelopmentFileOrganizationAuthoritySigner implements OrganizationAuthoritySigner {
  private constructor(
    private readonly keyPath: string,
    private readonly pinnedDescriptor: OrganizationAuthorityDescriptorV1,
  ) {}

  /**
   * Creates the development identity exactly once, or reopens the exact same
   * identity. Only explicit initialization paths may call this method.
   */
  static initialize(options: {
    directory: string;
    authority_id: string;
    organization_id: string;
  }): DevelopmentFileOrganizationAuthoritySigner {
    assertFederationId(options.authority_id, "oau", "development authority_id");
    assertFederationId(
      options.organization_id,
      "org",
      "development organization_id",
    );
    const existed = existsSync(options.directory);
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (!existed) {
      const state = lstatSync(options.directory);
      if ((state.mode & 0o777) !== 0o700) {
        fail("new directory was not created with mode 0700");
      }
    }
    assertPrivateDirectory(options.directory);
    const keyPath = join(options.directory, DEVELOPMENT_AUTHORITY_KEY_FILENAME);
    if (!existsSync(keyPath)) {
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const publicBytes = pair.publicKey.export({
        format: "der",
        type: "spki",
      });
      const privateBytes = pair.privateKey.export({
        format: "der",
        type: "pkcs8",
      });
      if (!Buffer.isBuffer(publicBytes) || !Buffer.isBuffer(privateBytes)) {
        fail("generated authority key did not export as DER");
      }
      const descriptor: OrganizationAuthorityDescriptorV1 = {
        schema_version: 1,
        kind: "echo-organization-authority",
        authority_id: options.authority_id,
        organization_id: options.organization_id,
        signing_key: {
          key_id: p256KeyId(publicBytes),
          algorithm: "ecdsa-p256-sha256-der-low-s",
          public_key_spki_der_base64: publicBytes.toString("base64"),
        },
      };
      verifyP256SigningKeyDescriptor(descriptor.signing_key);
      const stored: StoredDevelopmentKey = {
        schema_version: 1,
        descriptor,
        private_key_pkcs8_der_base64: privateBytes.toString("base64"),
      };
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      let file: number | undefined;
      try {
        file = openSync(
          keyPath,
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY |
            noFollow,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (file !== undefined) {
        try {
          writeFileSync(file, canonicalJson(stored), "utf8");
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
      }
    }
    const stored = readKeyFile(keyPath);
    if (
      stored.descriptor.authority_id !== options.authority_id ||
      stored.descriptor.organization_id !== options.organization_id
    ) {
      fail("persisted key belongs to another authority or organization");
    }
    return new DevelopmentFileOrganizationAuthoritySigner(
      keyPath,
      stored.descriptor,
    );
  }

  /**
   * Opens a pre-existing identity without creating directories or key files.
   * Runtime and diagnostic paths use this fail-closed entrypoint.
   */
  static openExisting(options: {
    directory: string;
    authority_id: string;
    organization_id: string;
  }): DevelopmentFileOrganizationAuthoritySigner {
    assertFederationId(options.authority_id, "oau", "development authority_id");
    assertFederationId(
      options.organization_id,
      "org",
      "development organization_id",
    );
    if (!existsSync(options.directory)) {
      fail("directory does not exist; run init-development first");
    }
    assertPrivateDirectory(options.directory);
    const keyPath = join(options.directory, DEVELOPMENT_AUTHORITY_KEY_FILENAME);
    if (!existsSync(keyPath)) {
      fail("key file does not exist; run init-development first");
    }
    const stored = readKeyFile(keyPath);
    if (
      stored.descriptor.authority_id !== options.authority_id ||
      stored.descriptor.organization_id !== options.organization_id
    ) {
      fail("persisted key belongs to another authority or organization");
    }
    return new DevelopmentFileOrganizationAuthoritySigner(
      keyPath,
      stored.descriptor,
    );
  }

  /** @deprecated Use initialize or openExisting to make mutation explicit. */
  static open(options: {
    directory: string;
    authority_id: string;
    organization_id: string;
  }): DevelopmentFileOrganizationAuthoritySigner {
    return DevelopmentFileOrganizationAuthoritySigner.initialize(options);
  }

  /** Synchronous counterpart for private stopped-state initialization only. */
  inspectSync(): OrganizationAuthorityDescriptorV1 {
    const current = readKeyFile(this.keyPath);
    if (
      canonicalJson(current.descriptor) !== canonicalJson(this.pinnedDescriptor)
    ) {
      fail("authority descriptor changed after signer initialization");
    }
    return JSON.parse(
      canonicalJson(current.descriptor),
    ) as OrganizationAuthorityDescriptorV1;
  }

  async inspect(): Promise<OrganizationAuthorityDescriptorV1> {
    return this.inspectSync();
  }

  async sign(message: Buffer, expectedKeyId: Sha256Digest): Promise<Buffer> {
    const current = readKeyFile(this.keyPath);
    if (
      canonicalJson(current.descriptor) !==
        canonicalJson(this.pinnedDescriptor) ||
      expectedKeyId !== current.descriptor.signing_key.key_id
    ) {
      fail("signing key does not match the expected authority key");
    }
    return normalizeP256LowS(
      signMessage("sha256", Buffer.from(message), {
        key: privateKey(current),
        dsaEncoding: "der",
      }),
    );
  }
}
