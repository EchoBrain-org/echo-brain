import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const helper = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../../src/product/spawn-sanitized-child.js", () => ({
  spawnBundledProductHelper: helper.spawn,
}));

import { MacOsSecureEnclaveInstallationSigner } from "../../src/product/federation/macos-installation-signer.js";
import type { InstallationKeyDescriptor } from "../../src/product/federation/installation-signer.js";
import { p256KeyId } from "../../src/product/federation/signature-profile.js";

const INSTALLATION_ID = "ins_11111111-1111-4111-8111-111111111111";
const KEY_ID = `sha256:${"a".repeat(64)}` as const;

interface ChildFixture {
  child: ReturnType<typeof fakeChild>["child"];
  request: () => string;
}

function fakeChild(
  response: unknown,
  options: { status?: number; stderr?: string } = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end(value: string): void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let request = "";
  const stdin = new EventEmitter() as EventEmitter & {
    end(value: string): void;
  };
  stdin.end = (value: string) => {
    request = value;
    queueMicrotask(() => {
      if (options.stderr !== undefined) {
        child.stderr.emit("data", Buffer.from(options.stderr));
      }
      if (response !== undefined) {
        child.stdout.emit("data", Buffer.from(JSON.stringify(response)));
      }
      child.emit("close", options.status ?? 0, null);
    });
  };
  child.stdin = stdin;
  child.kill = vi.fn();
  return { child, request: () => request };
}

function fixture(response: unknown): ChildFixture {
  return fakeChild(response);
}

function descriptor(): InstallationKeyDescriptor {
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    installation_id: INSTALLATION_ID,
    key_id: p256KeyId(spki),
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: spki.toString("base64"),
    protection: "secure-enclave",
    assurance: "hardware_bound",
    private_key_exportable: false,
  };
}

beforeEach(() => {
  helper.spawn.mockReset();
});

describe("macOS installation signer helper protocol", () => {
  it("sends an exact fingerprint-bound delete request and returns the helper result", async () => {
    const first = fixture({ schema_version: 1, ok: true, deleted: true });
    const second = fixture({ schema_version: 1, ok: true, deleted: false });
    helper.spawn
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const signer = new MacOsSecureEnclaveInstallationSigner();

    await expect(signer.deleteOrphan(INSTALLATION_ID, KEY_ID)).resolves.toBe(
      true,
    );
    expect(first.request()).toBe(
      `{"command":"delete","expected_key_id":"${KEY_ID}","installation_id":"${INSTALLATION_ID}","schema_version":1}\n`,
    );
    await expect(signer.deleteOrphan(INSTALLATION_ID, KEY_ID)).resolves.toBe(
      false,
    );
    expect(helper.spawn).toHaveBeenNthCalledWith(1, "installation-signer");
    expect(helper.spawn).toHaveBeenNthCalledWith(2, "installation-signer");
  });

  it("fails closed when delete is rejected or omits its boolean result", async () => {
    const mismatch = fixture({
      schema_version: 1,
      ok: false,
      error: {
        code: "key_mismatch",
        message: "installation signing key does not match expected_key_id",
      },
    });
    const malformed = fixture({ schema_version: 1, ok: true });
    helper.spawn
      .mockReturnValueOnce(mismatch.child)
      .mockReturnValueOnce(malformed.child);
    const signer = new MacOsSecureEnclaveInstallationSigner();

    await expect(signer.deleteOrphan(INSTALLATION_ID, KEY_ID)).rejects.toThrow(
      /key_mismatch/,
    );
    await expect(signer.deleteOrphan(INSTALLATION_ID, KEY_ID)).rejects.toThrow(
      /omitted its delete result/,
    );
  });

  it("preserves create, describe, and sign request behavior", async () => {
    const key = descriptor();
    const create = fixture({ schema_version: 1, ok: true, descriptor: key });
    const describe = fixture({ schema_version: 1, ok: true, descriptor: null });
    const sign = fixture({
      schema_version: 1,
      ok: true,
      signature_base64: "AQ==",
    });
    helper.spawn
      .mockReturnValueOnce(create.child)
      .mockReturnValueOnce(describe.child)
      .mockReturnValueOnce(sign.child);
    const signer = new MacOsSecureEnclaveInstallationSigner();

    await expect(signer.generate(INSTALLATION_ID)).resolves.toEqual(key);
    await expect(signer.inspect(INSTALLATION_ID)).resolves.toBeNull();
    await expect(
      signer.sign(INSTALLATION_ID, Buffer.from("message"), key.key_id),
    ).resolves.toEqual(Buffer.from([1]));
    expect(JSON.parse(create.request())).toEqual({
      schema_version: 1,
      command: "create",
      installation_id: INSTALLATION_ID,
    });
    expect(JSON.parse(describe.request())).toEqual({
      schema_version: 1,
      command: "describe",
      installation_id: INSTALLATION_ID,
    });
    expect(JSON.parse(sign.request())).toEqual({
      schema_version: 1,
      command: "sign",
      installation_id: INSTALLATION_ID,
      expected_key_id: key.key_id,
      message_base64: Buffer.from("message").toString("base64"),
    });
  });

  it("keeps the native mismatch check before SecItemDelete", () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        "../../native/macos/EchoBrainSigningHelper/Sources/main.swift",
      ),
      "utf8",
    );
    const deleteFunction = source.indexOf("private func deleteKey(");
    const fingerprintCheck = source.indexOf(
      "guard actual.keyID == expectedKeyID else",
      deleteFunction,
    );
    const deleteCall = source.indexOf("SecItemDelete(", deleteFunction);
    expect(deleteFunction).toBeGreaterThan(-1);
    expect(fingerprintCheck).toBeGreaterThan(deleteFunction);
    expect(deleteCall).toBeGreaterThan(fingerprintCheck);
    expect(source.slice(fingerprintCheck, deleteCall)).toContain(
      'code: "key_mismatch"',
    );
    expect(source.slice(fingerprintCheck, deleteCall)).toContain(
      "kSecMatchItemList: [key]",
    );
  });
});
