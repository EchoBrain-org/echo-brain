import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  p256KeyId,
  verifyP256LowSSignature,
} from "@echo-brain/federation-protocol";
import * as federation from "@echo-brain/federation-protocol";
import {
  assertIsolatedPaths,
  assertPrivateStatePermissions,
  scanFilesForKnownSecrets,
} from "../../tools/phase5/ceremony-support.mjs";
import { Phase5DevelopmentFileInstallationSigner } from "../../tools/phase5/development-file-installation-signer.mjs";
const temporaryDirectories: string[] = [];
const INSTALLATION_ID = "ins_00000000-0000-4000-8000-000000000005";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-phase5-primitives-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Phase 5 one-machine ceremony primitives", () => {
  it("persists one private development key and reuses it across signer instances", async () => {
    const root = temporaryRoot();
    const keys = join(root, "keys");
    mkdirSync(keys, { mode: 0o700 });
    const first = new Phase5DevelopmentFileInstallationSigner({
      directory: keys,
      federation,
    });
    const descriptor = await first.generate(INSTALLATION_ID);
    const message = Buffer.from("phase5-persistent-signer-test");
    const signature = await first.sign(
      INSTALLATION_ID,
      message,
      descriptor.key_id,
    );

    const reopened = new Phase5DevelopmentFileInstallationSigner({
      directory: keys,
      federation,
    });
    expect(await reopened.inspect(INSTALLATION_ID)).toEqual(descriptor);
    const publicKey = Buffer.from(
      descriptor.public_key_spki_der_base64,
      "base64",
    );
    expect(p256KeyId(publicKey)).toBe(descriptor.key_id);
    expect(verifyP256LowSSignature(publicKey, message, signature)).toBe(true);
    const keyFile = join(
      keys,
      `${INSTALLATION_ID}.rehearsal-installation-key.v1.json`,
    );
    expect(statSync(keys).mode & 0o777).toBe(0o700);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8")).not.toContain(
      "phase5-persistent-signer-test",
    );
  });

  it("enforces disjoint roots, private modes, and known-secret absence", () => {
    const root = temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first, { mode: 0o700 });
    mkdirSync(second, { mode: 0o700 });
    writeFileSync(join(first, "state.sqlite"), "digest-only", { mode: 0o600 });
    writeFileSync(join(second, "state.sqlite"), "other-digest", {
      mode: 0o600,
    });

    expect(() => assertIsolatedPaths([first, second])).not.toThrow();
    expect(() => assertIsolatedPaths([first, join(first, "nested")])).toThrow(
      /nested/,
    );
    expect(assertPrivateStatePermissions([first, second])).toBe(2);
    expect(
      scanFilesForKnownSecrets([first, second], ["raw-bearer-value"]),
    ).toBe(2);
    writeFileSync(join(second, "leak"), "raw-bearer-value", { mode: 0o600 });
    expect(() =>
      scanFilesForKnownSecrets([first, second], ["raw-bearer-value"]),
    ).toThrow(/known secret leaked/);
  });
});
