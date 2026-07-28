import { createPrivateKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileInstallationSigner } from '../../src/product/machine/security/file-installation-signer.js';
import { canonicalJson } from '../../src/product/federation/foundation/canonical-json.js';
import {
  assertP256LowS,
  verifyP256LowSSignature,
} from '../../src/product/federation/foundation/signature-profile.js';

const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const OTHER_INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000002';
const KEY_STATE_FILENAME = `${INSTALLATION_ID}.key-state.v1.json`;
const roots: string[] = [];

function signerDirectory(label: string): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `echo-file-signer-${label}-`)),
  );
  roots.push(root);
  return join(root, 'keys');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('portable file installation signer', () => {
  it('persists one private PKCS#8 key and signs after restart', async () => {
    const directory = signerDirectory('persist');
    const signer = new FileInstallationSigner(directory);
    await expect(signer.inspect(INSTALLATION_ID)).resolves.toBeNull();
    expect(existsSync(directory)).toBe(false);

    const descriptor = await signer.generate(INSTALLATION_ID);
    expect(descriptor).toMatchObject({
      installation_id: INSTALLATION_ID,
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual([KEY_STATE_FILENAME]);
    const keyStatePath = join(directory, KEY_STATE_FILENAME);
    expect(statSync(keyStatePath).mode & 0o777).toBe(0o600);
    const keyStateBytes = readFileSync(keyStatePath, 'utf8');
    const keyState = JSON.parse(keyStateBytes) as {
      schema_version: number;
      descriptor: typeof descriptor;
      private_key_pkcs8_der_base64: string;
    };
    expect(keyStateBytes).toBe(canonicalJson(keyState));
    expect(keyState).toMatchObject({
      schema_version: 1,
      descriptor,
    });
    expect(() =>
      createPrivateKey({
        key: Buffer.from(keyState.private_key_pkcs8_der_base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    ).not.toThrow();
    await expect(signer.generate(INSTALLATION_ID)).resolves.toEqual(descriptor);
    expect(readFileSync(keyStatePath, 'utf8')).toBe(keyStateBytes);

    const restarted = new FileInstallationSigner(directory);
    const message = Buffer.from('portable pilot message');
    const signature = await restarted.sign(
      INSTALLATION_ID,
      message,
      descriptor.key_id,
    );
    assertP256LowS(signature);
    expect(
      verifyP256LowSSignature(
        Buffer.from(descriptor.public_key_spki_der_base64, 'base64'),
        message,
        signature,
      ),
    ).toBe(true);

    await expect(
      restarted.deleteOrphan(INSTALLATION_ID, descriptor.key_id),
    ).resolves.toBe(true);
    await expect(restarted.inspect(INSTALLATION_ID)).resolves.toBeNull();
  });

  it('rejects permissive modes and symlinked key state', async () => {
    const directory = signerDirectory('filesystem');
    const signer = new FileInstallationSigner(directory);
    await signer.generate(INSTALLATION_ID);
    const keyStatePath = join(directory, KEY_STATE_FILENAME);

    chmodSync(keyStatePath, 0o644);
    await expect(signer.inspect(INSTALLATION_ID)).rejects.toThrow(/mode 0600/);
    chmodSync(keyStatePath, 0o600);

    const linkedDirectory = signerDirectory('symlink');
    mkdirSync(linkedDirectory, { mode: 0o700 });
    symlinkSync(keyStatePath, join(linkedDirectory, KEY_STATE_FILENAME));
    await expect(
      new FileInstallationSigner(linkedDirectory).inspect(INSTALLATION_ID),
    ).rejects.toThrow(/regular file|mode 0600/);
  });

  it('rejects tampered state and a mismatched private key', async () => {
    const directory = signerDirectory('tamper');
    const signer = new FileInstallationSigner(directory);
    await signer.generate(INSTALLATION_ID);
    const keyStatePath = join(directory, KEY_STATE_FILENAME);
    const original = JSON.parse(readFileSync(keyStatePath, 'utf8')) as Record<
      string,
      unknown
    >;

    writeFileSync(
      keyStatePath,
      canonicalJson({ ...original, unexpected: true }),
      { mode: 0o600 },
    );
    await expect(signer.inspect(INSTALLATION_ID)).rejects.toThrow(
      /unexpected shape/,
    );

    const otherDirectory = signerDirectory('other-key');
    const otherSigner = new FileInstallationSigner(otherDirectory);
    await otherSigner.generate(OTHER_INSTALLATION_ID);
    const otherState = JSON.parse(
      readFileSync(
        join(
          otherDirectory,
          `${OTHER_INSTALLATION_ID}.key-state.v1.json`,
        ),
        'utf8',
      ),
    ) as { private_key_pkcs8_der_base64: string };
    writeFileSync(
      keyStatePath,
      canonicalJson({
        ...original,
        private_key_pkcs8_der_base64:
          otherState.private_key_pkcs8_der_base64,
      }),
      { mode: 0o600 },
    );
    await expect(signer.inspect(INSTALLATION_ID)).rejects.toThrow(
      /does not match the persisted descriptor/,
    );
  });

  it('requires the expected fingerprint for signing and deletion', async () => {
    const directory = signerDirectory('fingerprint');
    const signer = new FileInstallationSigner(directory);
    const descriptor = await signer.generate(INSTALLATION_ID);
    const wrongKeyId = `sha256:${'0'.repeat(64)}` as const;

    await expect(
      signer.sign(INSTALLATION_ID, Buffer.from('message')),
    ).rejects.toThrow(/requires the expected key fingerprint/);
    await expect(
      signer.sign(INSTALLATION_ID, Buffer.from('message'), wrongKeyId),
    ).rejects.toThrow(/does not match expected_key_id/);
    await expect(
      signer.deleteOrphan(INSTALLATION_ID, wrongKeyId),
    ).rejects.toThrow(/different fingerprint/);
    await expect(signer.inspect(INSTALLATION_ID)).resolves.toEqual(descriptor);
  });
});
