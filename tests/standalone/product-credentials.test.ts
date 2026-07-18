import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createProductCredentialResolver,
  credentialPathIsWithin,
  isServiceSafeCredentialReference,
  readPrivateCredentialFile,
} from '../../src/product/credentials.js';
import {
  loadProductRuntimeConfig,
  ProductConfigError,
  validateProductRuntimeConfig,
} from '../../src/product/config.js';

const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'echo-brain-credentials-')),
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(credentialRef: string) {
  return {
    schema_version: 1,
    lane: 'team-product',
    state_dir: join(root, 'state'),
    meeting_sources: [
      {
        adapter_id: 'granola',
        instance_id: 'primary',
        credential_ref: credentialRef,
        settings: {},
      },
    ],
    decision_processor: {
      adapter_id: 'structured-text',
      instance_id: 'primary',
      settings: {},
    },
    communication_channels: [
      {
        adapter_id: 'jsonl-outbox',
        instance_id: 'primary',
        settings: { path: join(root, 'outbox.jsonl') },
      },
    ],
    approval_mode: 'manual',
  };
}

describe('product credential references', () => {
  it('resolves environment and private canonical file references', () => {
    const credentialPath = join(root, 'granola-api-key');
    writeFileSync(credentialPath, 'grn_test\n', { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
    const resolver = createProductCredentialResolver({ API_TOKEN: 'from-env' });

    expect(resolver('env:API_TOKEN')).toBe('from-env');
    expect(resolver(`file:${credentialPath}`)).toBe('grn_test');
    expect(isServiceSafeCredentialReference(`file:${credentialPath}`)).toBe(
      true,
    );
    expect(isServiceSafeCredentialReference('env:API_TOKEN')).toBe(false);
    expect(isServiceSafeCredentialReference('file:')).toBe(false);
    expect(credentialPathIsWithin(credentialPath, root)).toBe(true);
    expect(
      isServiceSafeCredentialReference(
        `file:${credentialPath}`,
        join(root, 'elsewhere'),
      ),
    ).toBe(false);
    expect(readFileSync(credentialPath, 'utf8')).toBe('grn_test\n');
  });

  it('rejects a FIFO without blocking while opening it', () => {
    const fifo = join(root, 'credential-fifo');
    const created = spawnSync('/usr/bin/mkfifo', [fifo], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    expect(created.status, created.stderr).toBe(0);
    const started = performance.now();
    expect(() => readPrivateCredentialFile(fifo)).toThrow(/regular file/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('rejects permissive files and symlinked credential paths', () => {
    const permissive = join(root, 'permissive-token');
    writeFileSync(permissive, 'secret', { mode: 0o644 });
    chmodSync(permissive, 0o644);
    const resolver = createProductCredentialResolver({});
    expect(() => resolver(`file:${permissive}`)).toThrow(/group or world/);

    const target = join(root, 'target-token');
    const link = join(root, 'linked-token');
    writeFileSync(target, 'secret', { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => resolver(`file:${link}`)).toThrow();
  });

  it('validates file reference paths before runtime', () => {
    expect(
      validateProductRuntimeConfig(config(`file:${join(root, 'token')}`)),
    ).toMatchObject({ lane: 'team-product' });

    expect(() =>
      validateProductRuntimeConfig(config('file:/tmp/../unsafe-token')),
    ).toThrow(ProductConfigError);
  });

  it('rejects indirect, non-regular, and oversized runtime config files', () => {
    const fifo = join(root, 'runtime-fifo');
    const created = spawnSync('/usr/bin/mkfifo', [fifo], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    expect(created.status, created.stderr).toBe(0);
    expect(() => loadProductRuntimeConfig(fifo)).toThrow(/regular file/);

    const realConfig = join(root, 'real-runtime.json');
    const linkedConfig = join(root, 'linked-runtime.json');
    writeFileSync(
      realConfig,
      `${JSON.stringify(config('env:GRANOLA_API_KEY'))}\n`,
    );
    symlinkSync(realConfig, linkedConfig);
    expect(() => loadProductRuntimeConfig(linkedConfig)).toThrow(/cannot read/);

    const oversized = join(root, 'oversized-runtime.json');
    writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(() => loadProductRuntimeConfig(oversized)).toThrow(/file size/);
  });
});
