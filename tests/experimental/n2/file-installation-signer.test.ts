import { createPrivateKey } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileInstallationSigner } from '../../../src/experimental/n2/file-installation-signer.js';
import { canonicalJson } from '../../../src/product/federation/foundation/canonical-json.js';
import {
  assertP256LowS,
  verifyP256LowSSignature,
} from '../../../src/product/federation/foundation/signature-profile.js';

const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const PRIVATE_FILENAME = `${INSTALLATION_ID}.private.pk8`;
const DESCRIPTOR_FILENAME = `${INSTALLATION_ID}.descriptor.v1.json`;
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

describe('development file installation signer', () => {
  it('persists one unencrypted PKCS#8 key and signs after restart', async () => {
    const directory = signerDirectory('persist');
    const signer = new FileInstallationSigner(directory);
    const descriptor = await signer.generate(INSTALLATION_ID);

    expect(descriptor).toMatchObject({
      installation_id: INSTALLATION_ID,
      protection: 'development-file',
      assurance: 'software_key_development_only',
      private_key_exportable: true,
    });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory).sort()).toEqual(
      [DESCRIPTOR_FILENAME, PRIVATE_FILENAME].sort(),
    );
    expect(statSync(join(directory, PRIVATE_FILENAME)).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(join(directory, DESCRIPTOR_FILENAME)).mode & 0o777).toBe(
      0o600,
    );
    expect(() =>
      createPrivateKey({
        key: readFileSync(join(directory, PRIVATE_FILENAME)),
        format: 'der',
        type: 'pkcs8',
      }),
    ).not.toThrow();

    const descriptorBytes = readFileSync(
      join(directory, DESCRIPTOR_FILENAME),
      'utf8',
    );
    expect(descriptorBytes).toBe(canonicalJson(descriptor));
    const privateBytes = readFileSync(join(directory, PRIVATE_FILENAME));
    await expect(signer.generate(INSTALLATION_ID)).resolves.toEqual(descriptor);
    expect(readFileSync(join(directory, PRIVATE_FILENAME))).toEqual(
      privateBytes,
    );

    const restarted = new FileInstallationSigner(directory);
    await expect(restarted.inspect(INSTALLATION_ID)).resolves.toEqual(
      descriptor,
    );
    const message = Buffer.from('N=2 pilot message');
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
  });
});
