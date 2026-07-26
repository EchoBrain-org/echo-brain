import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
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
import { join, resolve } from "node:path";

const KEY_FILE_SUFFIX = ".rehearsal-installation-key.v1.json";
const MAX_KEY_FILE_BYTES = 16 * 1024;

function fail(message) {
  throw new Error(`Phase 5 development installation signer: ${message}`);
}

function assertPrivateDirectory(directory) {
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

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

function readPrivateFile(path) {
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.size <= 0 ||
    state.size > MAX_KEY_FILE_BYTES ||
    (currentUid !== undefined && state.uid !== currentUid) ||
    (state.mode & 0o777) !== 0o600
  ) {
    fail("key file must be a bounded current-user 0600 regular file");
  }
  const file = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(file);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      fail("key file changed while opening");
    }
    return readFileSync(file, "utf8");
  } finally {
    closeSync(file);
  }
}

function canonicalPrivateKey(bytes) {
  let key;
  try {
    key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  } catch {
    fail("private key is not valid PKCS#8 DER");
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    fail("private key must be P-256");
  }
  const encoded = key.export({ format: "der", type: "pkcs8" });
  if (!Buffer.isBuffer(encoded) || !encoded.equals(bytes)) {
    fail("private key is not canonical PKCS#8 DER");
  }
  return key;
}

/**
 * Explicitly unsafe-for-production signer used only by the one-machine gate.
 * It keeps one exportable, unencrypted P-256 key in a private local file so
 * restart behavior can be exercised on hosts without the Secure Enclave.
 */
export class Phase5DevelopmentFileInstallationSigner {
  constructor(options) {
    this.directory = resolve(options.directory);
    this.federation = options.federation;
    const existed = existsSync(this.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!existed && (lstatSync(this.directory).mode & 0o777) !== 0o700) {
      fail("new directory was not created with mode 0700");
    }
    assertPrivateDirectory(this.directory);
  }

  path(installationId) {
    this.federation.assertFederationId(
      installationId,
      "ins",
      "Phase 5 installation_id",
    );
    return join(this.directory, `${installationId}${KEY_FILE_SUFFIX}`);
  }

  load(installationId) {
    assertPrivateDirectory(this.directory);
    const path = this.path(installationId);
    if (!existsSync(path)) return null;
    const parsed = this.federation.parseCanonicalJson(readPrivateFile(path));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      fail("key file must contain one canonical JSON object");
    }
    exactKeys(
      parsed,
      ["schema_version", "descriptor", "private_key_pkcs8_der_base64"],
      "key file",
    );
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.private_key_pkcs8_der_base64 !== "string" ||
      parsed.descriptor === null ||
      typeof parsed.descriptor !== "object" ||
      Array.isArray(parsed.descriptor)
    ) {
      fail("key file fields are invalid");
    }
    const descriptor = parsed.descriptor;
    exactKeys(
      descriptor,
      [
        "installation_id",
        "key_id",
        "algorithm",
        "public_key_spki_der_base64",
        "protection",
        "assurance",
        "private_key_exportable",
      ],
      "key descriptor",
    );
    if (
      descriptor.installation_id !== installationId ||
      descriptor.algorithm !== "ecdsa-p256-sha256-der-low-s" ||
      descriptor.protection !== "development-file" ||
      descriptor.assurance !== "software_key_development_only" ||
      descriptor.private_key_exportable !== true
    ) {
      fail("key descriptor is inconsistent");
    }
    const privateBytes = Buffer.from(
      parsed.private_key_pkcs8_der_base64,
      "base64",
    );
    if (
      privateBytes.length === 0 ||
      privateBytes.toString("base64") !== parsed.private_key_pkcs8_der_base64
    ) {
      fail("private key is not canonical base64");
    }
    const privateKey = canonicalPrivateKey(privateBytes);
    const publicBytes = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    if (
      !Buffer.isBuffer(publicBytes) ||
      publicBytes.toString("base64") !==
        descriptor.public_key_spki_der_base64 ||
      this.federation.p256KeyId(publicBytes) !== descriptor.key_id
    ) {
      fail("private key does not match its descriptor");
    }
    return { descriptor: structuredClone(descriptor), privateKey };
  }

  async generate(installationId) {
    const existing = this.load(installationId);
    if (existing !== null) return existing.descriptor;
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateBytes = pair.privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    const publicBytes = pair.publicKey.export({
      format: "der",
      type: "spki",
    });
    if (!Buffer.isBuffer(privateBytes) || !Buffer.isBuffer(publicBytes)) {
      fail("generated key did not export as DER");
    }
    const descriptor = {
      installation_id: installationId,
      key_id: this.federation.p256KeyId(publicBytes),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicBytes.toString("base64"),
      protection: "development-file",
      assurance: "software_key_development_only",
      private_key_exportable: true,
    };
    const stored = {
      schema_version: 1,
      descriptor,
      private_key_pkcs8_der_base64: privateBytes.toString("base64"),
    };
    let file;
    try {
      file = openSync(
        this.path(installationId),
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const concurrent = this.load(installationId);
      if (concurrent === null) fail("concurrent key creation was incomplete");
      return concurrent.descriptor;
    }
    try {
      writeFileSync(file, this.federation.canonicalJson(stored), "utf8");
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const created = this.load(installationId);
    if (created === null) fail("created key could not be reloaded");
    return created.descriptor;
  }

  async inspect(installationId) {
    return this.load(installationId)?.descriptor ?? null;
  }

  async sign(installationId, message, expectedKeyId) {
    if (typeof expectedKeyId !== "string") {
      fail("signing requires the expected key fingerprint");
    }
    const stored = this.load(installationId);
    if (stored === null) fail("signing key is unavailable");
    if (stored.descriptor.key_id !== expectedKeyId) {
      fail("signing key does not match the expected fingerprint");
    }
    return this.federation.normalizeP256LowS(
      signMessage("sha256", Buffer.from(message), {
        key: stored.privateKey,
        dsaEncoding: "der",
      }),
    );
  }
}
