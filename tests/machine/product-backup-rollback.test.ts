import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProductStateBackup,
  productStatePathIdentity,
  restoreProductStateBackup,
  validateProductStateBackup,
} from '../../src/product/state-backup.js';
import { canonicalLocalPath } from '../../src/product/secure-local-files.js';
import { acquireProductLifecycleLock } from '../../src/product/lifecycle-lock.js';
import { founderCutoverGuardPath } from '../../src/product/federation/cutover-fence.js';
import { canonicalJson } from '../../src/product/federation/foundation/canonical-json.js';

const CONFIG_SHA = 'c'.repeat(64);
const CREATED_AT = '2026-07-18T01:02:03.000Z';
const RESTORED_AT = '2026-07-18T02:03:04.000Z';
const roots: string[] = [];

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'echo-product-recovery-'));
  roots.push(root);
  return root;
}

function makeWritable(path: string): void {
  const state = lstatSync(path, { throwIfNoEntry: false });
  if (state === undefined || state.isSymbolicLink()) return;
  if (state.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (state.isFile()) {
    chmodSync(path, 0o600);
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    if (existsSync(root)) {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function writeStateDatabase(
  stateDir: string,
  value: string,
  keepOpen = false,
): Database.Database | undefined {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = new Database(join(stateDir, 'echo-brain.sqlite'));
  database.pragma('journal_mode = WAL');
  database.pragma('wal_autocheckpoint = 0');
  database.exec(
    'CREATE TABLE IF NOT EXISTS recovery_probe (value TEXT NOT NULL)',
  );
  database.exec('DELETE FROM recovery_probe');
  database.prepare('INSERT INTO recovery_probe (value) VALUES (?)').run(value);
  if (keepOpen) return database;
  database.close();
  return undefined;
}

function readStateDatabase(databasePath: string): string {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      database.prepare('SELECT value FROM recovery_probe').get() as {
        value: string;
      }
    ).value;
  } finally {
    database.close();
  }
}

describe('product state backup and restore', () => {
  it('captures committed WAL state through SQLite backup and emits only redacted evidence', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const database = writeStateDatabase(stateDir, 'committed-in-wal', true)!;
    writeFileSync(join(stateDir, 'checkpoint.json'), '{"cursor":7}\n', {
      mode: 0o600,
    });
    expect(existsSync(join(stateDir, 'echo-brain.sqlite-wal'))).toBe(true);

    try {
      const created = await createProductStateBackup({
        stateDir,
        backupRoot: join(root, 'backups'),
        backupId: 'wal-snapshot',
        createdAt: CREATED_AT,
        canonicalConfigSha256: CONFIG_SHA,
      });
      expect(
        readStateDatabase(join(created.backupDirectory, 'echo-brain.sqlite')),
      ).toBe('committed-in-wal');
      expect(created.manifest.files.map((file) => file.path)).toEqual([
        'checkpoint.json',
        'echo-brain.sqlite',
      ]);
      expect(
        created.manifest.files.find((file) => file.role === 'sqlite'),
      ).toMatchObject({
        path: 'echo-brain.sqlite',
        mode: 0o600,
      });
      expect(created.evidence).toMatchObject({
        operation: 'backup',
        backup_id: 'wal-snapshot',
        canonical_config_sha256: CONFIG_SHA,
        contains_secrets: true,
        reused: false,
      });
      expect(created.manifest.contains_secrets).toBe(true);
      expect(created.evidence.source_state_path_sha256).toBe(
        productStatePathIdentity(
          canonicalLocalPath(stateDir, 'test state directory', true),
        ),
      );
      const serializedEvidence = JSON.stringify(created.evidence);
      expect(serializedEvidence).not.toContain(stateDir);
      expect(serializedEvidence).not.toContain('committed-in-wal');
      expect(serializedEvidence).not.toContain('cursor');
      expect(
        validateProductStateBackup(created.backupDirectory).manifestSha256,
      ).toBe(created.evidence.manifest_sha256);

      const retried = await createProductStateBackup({
        stateDir,
        backupRoot: join(root, 'backups'),
        backupId: 'wal-snapshot',
        createdAt: CREATED_AT,
        canonicalConfigSha256: CONFIG_SHA,
      });
      expect(retried.evidence.reused).toBe(true);
      expect(retried.evidence.manifest_sha256).toBe(
        created.evidence.manifest_sha256,
      );
    } finally {
      database.close();
    }
  });

  it('fails closed when an active runtime holds the state lease', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    writeStateDatabase(stateDir, 'live');
    const release = await acquireProductLifecycleLock(stateDir, 'runtime');
    try {
      await expect(
        createProductStateBackup({
          stateDir,
          backupRoot: join(root, 'backups'),
          backupId: 'unsafe',
          createdAt: CREATED_AT,
          canonicalConfigSha256: CONFIG_SHA,
        }),
      ).rejects.toMatchObject({ code: 'busy' });
      expect(existsSync(join(root, 'backups'))).toBe(false);
    } finally {
      await release();
    }
  });

  it('recovers identified backup staging and preserves mismatched staging', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'prepared-backup');
    mkdirSync(backupRoot, { mode: 0o700 });
    const stateIdentity = productStatePathIdentity(
      canonicalLocalPath(stateDir, 'test state directory', true),
    );
    const preparation = (backupId: string, configHash = CONFIG_SHA) => ({
      schema_version: 1,
      kind: 'echo-product-state-backup-preparation',
      backup_id: backupId,
      created_at: CREATED_AT,
      source_state_path_sha256: stateIdentity,
      canonical_config_sha256: configHash,
    });

    mkdirSync(join(backupRoot, '.interrupted.creating'), { mode: 0o700 });
    writeFileSync(
      join(backupRoot, '.interrupted.creating', 'partial'),
      'partial',
      { mode: 0o600 },
    );
    writeFileSync(
      join(backupRoot, '.interrupted.creating.transaction.json'),
      `${JSON.stringify(preparation('interrupted'), null, 2)}\n`,
      { mode: 0o600 },
    );
    const recovered = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'interrupted',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    expect(recovered.evidence.reused).toBe(false);
    expect(existsSync(join(backupRoot, '.interrupted.creating'))).toBe(false);
    expect(
      existsSync(join(backupRoot, '.interrupted.creating.transaction.json')),
    ).toBe(false);

    mkdirSync(join(backupRoot, '.collision.creating'), { mode: 0o700 });
    writeFileSync(
      join(backupRoot, '.collision.creating.transaction.json'),
      `${JSON.stringify(preparation('collision', 'd'.repeat(64)), null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(
      createProductStateBackup({
        stateDir,
        backupRoot,
        backupId: 'collision',
        createdAt: CREATED_AT,
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(/belongs to a different backup operation/);
    expect(existsSync(join(backupRoot, '.collision.creating'))).toBe(true);
  });

  it('rejects symlinks instead of following them into a snapshot', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    mkdirSync(stateDir);
    const outside = join(root, 'outside-secret');
    writeFileSync(outside, 'never-copy-me');
    symlinkSync(outside, join(stateDir, 'secret-link'));

    await expect(
      createProductStateBackup({
        stateDir,
        backupRoot: join(root, 'backups'),
        backupId: 'symlink-attempt',
        createdAt: CREATED_AT,
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(/forbidden symlink/);
    expect(existsSync(join(root, 'backups', 'symlink-attempt'))).toBe(false);
  });

  it('refuses non-private backup roots and validates ownership modes on reuse', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'private-only');
    mkdirSync(backupRoot, { mode: 0o700 });
    chmodSync(backupRoot, 0o755);

    await expect(
      createProductStateBackup({
        stateDir,
        backupRoot,
        backupId: 'private-snapshot',
        createdAt: CREATED_AT,
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(/backup root must be private/);
    expect(existsSync(join(backupRoot, 'private-snapshot'))).toBe(false);

    chmodSync(backupRoot, 0o700);
    const created = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'private-snapshot',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    chmodSync(created.backupDirectory, 0o755);
    expect(() => validateProductStateBackup(created.backupDirectory)).toThrow(
      /backup directory must be private/,
    );
  });

  it('runs SQLite quick_check even when hashes describe a corrupt snapshot', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    writeStateDatabase(stateDir, 'healthy');
    const created = await createProductStateBackup({
      stateDir,
      backupRoot: join(root, 'backups'),
      backupId: 'corrupt-snapshot',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    const databasePath = join(created.backupDirectory, 'echo-brain.sqlite');
    const corruptBytes = Buffer.from('not a SQLite database\n');
    writeFileSync(databasePath, corruptBytes, { mode: 0o600 });
    const manifestPath = join(created.backupDirectory, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    const databaseEntry = manifest.files.find(
      (file) => file.path === 'echo-brain.sqlite',
    )!;
    databaseEntry.size = corruptBytes.byteLength;
    databaseEntry.sha256 = sha256(corruptBytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    expect(() => validateProductStateBackup(created.backupDirectory)).toThrow(
      /failed SQLite quick_check/,
    );
  });

  it('restores verified state only after taking an automatic backup of live state', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    writeStateDatabase(stateDir, 'before-change');
    writeFileSync(join(stateDir, 'status.txt'), 'before-change', {
      mode: 0o600,
    });
    const backupRoot = join(root, 'backups');
    const original = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'known-good',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    writeStateDatabase(stateDir, 'current-live');
    writeFileSync(join(stateDir, 'status.txt'), 'current-live', {
      mode: 0o600,
    });
    const restored = await restoreProductStateBackup({
      stateDir,
      backupDirectory: original.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'restore-known-good',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-restore-known-good',
      preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
      canonicalConfigSha256: CONFIG_SHA,
    });

    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'before-change',
    );
    expect(readFileSync(join(stateDir, 'status.txt'), 'utf8')).toBe(
      'before-change',
    );
    expect(restored.evidence.contains_secrets).toBe(true);
    expect(restored.evidence.pre_restore_backup).toMatchObject({
      backup_id: 'pre-restore-known-good',
      reused: false,
    });
    const safetyBackup = validateProductStateBackup(
      join(backupRoot, 'pre-restore-known-good'),
    );
    expect(
      readStateDatabase(
        join(safetyBackup.backupDirectory, 'echo-brain.sqlite'),
      ),
    ).toBe('current-live');
    expect(
      readFileSync(join(safetyBackup.backupDirectory, 'status.txt'), 'utf8'),
    ).toBe('current-live');
  });

  it('rejects restoring a pre-cutover backup over an irreversible founder cutover', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'pre-cutover');
    const preCutover = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'pre-cutover-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    writeStateDatabase(stateDir, 'seed-live');
    const guardPath = founderCutoverGuardPath(stateDir);
    writeFileSync(
      guardPath,
      canonicalJson({
        schema_version: 1,
        kind: 'echo-founder-cutover-guard',
        state_path_sha256: `sha256:${productStatePathIdentity(
          canonicalLocalPath(stateDir, 'state directory', true),
        )}`,
        session_id: '123e4567-e89b-42d3-a456-426614174000',
        plan_sha256: `sha256:${'a'.repeat(64)}`,
        installation_key_id: `sha256:${'b'.repeat(64)}`,
      }),
      { mode: 0o600 },
    );

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: preCutover.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'reject-pre-cutover-downgrade',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'must-not-create-pre-backup',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(/irreversible founder identity cutover/);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'seed-live',
    );
    expect(existsSync(guardPath)).toBe(true);
    expect(existsSync(join(backupRoot, 'must-not-create-pre-backup'))).toBe(
      false,
    );
  });

  it('backs up the complete local cutover and independent-copy evidence without copying a private signing key', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'seed-cutover');

    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const evidence = new Map<string, string>([
      [
        `bootstrap/founder-identity/session.${sessionId}.v1.json`,
        '{"kind":"echo-founder-bootstrap-session","phase":"complete","signing_key":{"protection":"secure-enclave","public_key_spki_der_base64":"PUBLIC-ONLY"}}\n',
      ],
      [
        `bootstrap/legacy-classification/report.${sessionId}.v1.json`,
        '{"kind":"echo-founder-legacy-classification-report","ok":true}\n',
      ],
      [
        'federation/independent-copy/target.v1.json',
        '{"kind":"echo-founder-independent-copy-target","volume_id":"encrypted-volume"}\n',
      ],
      [
        `federation/independent-copy/intents/intent.ins_founder.1.${'a'.repeat(64)}.v1.json`,
        '{"kind":"echo-founder-independent-copy-intent","sequence":{"last":1}}\n',
      ],
      [
        `federation/independent-copy/receipts/receipt.ins_founder.1.${'a'.repeat(64)}.v1.json`,
        '{"kind":"echo-founder-independent-copy-receipt","sequence":{"last":1}}\n',
      ],
    ]);
    for (const [relativePath, bytes] of evidence) {
      const path = join(stateDir, relativePath);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 });
    }

    const privateKeySentinel = 'PRIVATE-SIGNING-KEY-MUST-NOT-BE-EXPORTED';
    const secureEnclaveMaterial = join(root, 'secure-enclave-private-key');
    writeFileSync(secureEnclaveMaterial, privateKeySentinel, { mode: 0o600 });

    const created = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'seed-cutover-evidence',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    const backedUpPaths = created.manifest.files.map((file) => file.path);
    expect(backedUpPaths).toEqual(expect.arrayContaining([...evidence.keys()]));
    expect(backedUpPaths).not.toContain('secure-enclave-private-key');
    for (const relativePath of evidence.keys()) {
      expect(
        readFileSync(join(created.backupDirectory, relativePath), 'utf8'),
      ).toBe(evidence.get(relativePath));
    }
    expect(
      created.manifest.files.some((file) =>
        readFileSync(join(created.backupDirectory, file.path)).includes(
          privateKeySentinel,
        ),
      ),
    ).toBe(false);

    expect(readFileSync(secureEnclaveMaterial, 'utf8')).toBe(
      privateKeySentinel,
    );
  });

  it('verifies the requested backup before touching or pre-backing up live state', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    writeStateDatabase(stateDir, 'known-good');
    writeFileSync(join(stateDir, 'status.txt'), 'known-good', { mode: 0o600 });
    const created = await createProductStateBackup({
      stateDir,
      backupRoot: join(root, 'restore-sources'),
      backupId: 'tampered',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeFileSync(join(created.backupDirectory, 'status.txt'), 'tampered');
    writeStateDatabase(stateDir, 'still-live');
    writeFileSync(join(stateDir, 'status.txt'), 'still-live', { mode: 0o600 });

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: created.backupDirectory,
        automaticBackupRoot: join(root, 'automatic-backups'),
        operationId: 'reject-tampered',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'must-not-exist',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(/failed verification/);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'still-live',
    );
    expect(readFileSync(join(stateDir, 'status.txt'), 'utf8')).toBe(
      'still-live',
    );
    expect(existsSync(join(root, 'automatic-backups'))).toBe(false);
  });

  it('recovers a crash after live state is replaced, then safely retries', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'known-good');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'crash-source-one',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'live-before-crash');
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'crash-after-replaced',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-crash-after-replaced',
      preRestoreBackupCreatedAt: '2026-07-18T02:02:01.000Z',
      canonicalConfigSha256: CONFIG_SHA,
    };

    await expect(
      restoreProductStateBackup({
        ...options,
        faultInjector(point) {
          if (point === 'after_live_replaced')
            throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow(/simulated crash/);
    expect(existsSync(stateDir)).toBe(false);
    expect(
      existsSync(join(root, '.echo-restore-crash-after-replaced.replaced')),
    ).toBe(true);
    expect(
      existsSync(
        join(root, '.echo-restore-crash-after-replaced.transaction.json'),
      ),
    ).toBe(true);
    const transactionBytes = readFileSync(
      join(root, '.echo-restore-crash-after-replaced.transaction.json'),
      'utf8',
    );
    expect(transactionBytes).not.toContain(stateDir);
    expect(transactionBytes).not.toContain('live-before-crash');
    expect(transactionBytes).not.toContain('known-good');

    const recovered = await restoreProductStateBackup(options);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'known-good',
    );
    expect(recovered.evidence.pre_restore_backup).toMatchObject({
      backup_id: 'pre-crash-after-replaced',
      reused: true,
    });
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('recovers a crash after the durable restore preparation but before staging', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'prepared-known-good');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'prepared-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'prepared-live');
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'prepared-restore',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-prepared-restore',
      preRestoreBackupCreatedAt: '2026-07-18T02:02:01.500Z',
      canonicalConfigSha256: CONFIG_SHA,
    };
    await expect(
      restoreProductStateBackup({
        ...options,
        faultInjector(point) {
          if (point === 'after_prepare_marker') {
            throw new Error('simulated pre-stage crash');
          }
        },
      }),
    ).rejects.toThrow(/simulated pre-stage crash/);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'prepared-live',
    );
    expect(
      existsSync(join(root, '.echo-restore-prepared-restore.transaction.json')),
    ).toBe(true);
    expect(
      existsSync(join(root, '.echo-restore-prepared-restore.staging')),
    ).toBe(false);

    const recovered = await restoreProductStateBackup(options);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'prepared-known-good',
    );
    expect(recovered.evidence.pre_restore_backup).toMatchObject({
      backup_id: 'pre-prepared-restore',
      reused: true,
    });
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('recognizes and completes a promoted restore after a crash', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'known-good');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'crash-source-two',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'live-before-promotion');
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'crash-after-promoted',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-crash-after-promoted',
      preRestoreBackupCreatedAt: '2026-07-18T02:02:02.000Z',
      canonicalConfigSha256: CONFIG_SHA,
    };

    await expect(
      restoreProductStateBackup({
        ...options,
        faultInjector(point) {
          if (point === 'after_stage_promoted')
            throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow(/simulated crash/);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'known-good',
    );
    expect(
      existsSync(join(root, '.echo-restore-crash-after-promoted.replaced')),
    ).toBe(true);

    const recovered = await restoreProductStateBackup({
      ...options,
      operationId: 'new-cli-retry-id',
      restoredAt: '2026-07-18T02:04:05.000Z',
      preRestoreBackupId: 'new-cli-pre-restore-id',
      preRestoreBackupCreatedAt: '2026-07-18T02:04:00.000Z',
    });
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'known-good',
    );
    expect(recovered.evidence).toMatchObject({
      operation_id: 'crash-after-promoted',
      restored_at: RESTORED_AT,
      restored_backup_id: 'crash-source-two',
    });
    expect(recovered.evidence.pre_restore_backup).toMatchObject({
      backup_id: 'pre-crash-after-promoted',
      reused: true,
    });
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('fails closed with recovery guidance when transaction markers are ambiguous', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'known-good');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'ambiguous-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'live-before-ambiguity');
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'ambiguous-original',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-ambiguous-original',
      preRestoreBackupCreatedAt: '2026-07-18T02:02:03.000Z',
      canonicalConfigSha256: CONFIG_SHA,
    };
    await expect(
      restoreProductStateBackup({
        ...options,
        faultInjector(point) {
          if (point === 'after_stage_promoted')
            throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    const originalMarker = join(
      root,
      '.echo-restore-ambiguous-original.transaction.json',
    );
    const duplicate = JSON.parse(readFileSync(originalMarker, 'utf8')) as {
      operation_id: string;
    };
    duplicate.operation_id = 'ambiguous-duplicate';
    writeFileSync(
      join(root, '.echo-restore-ambiguous-duplicate.transaction.json'),
      `${JSON.stringify(duplicate, null, 2)}\n`,
      { mode: 0o600 },
    );

    await expect(
      restoreProductStateBackup({
        ...options,
        operationId: 'fresh-retry',
        restoredAt: '2026-07-18T02:05:00.000Z',
      }),
    ).rejects.toThrow(/recovery is ambiguous; stop the service/);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'known-good',
    );
    expect(
      existsSync(join(root, '.echo-restore-ambiguous-original.replaced')),
    ).toBe(true);
  });
});
