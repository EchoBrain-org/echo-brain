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
import { founderCutoverGuardPath } from '../../src/product/retired-founder-provenance.js';

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

  it('refuses restore over an adjacent-guard target before any pre-backup or marker', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'pre-cutover');
    const cleanSource = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'clean-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    writeStateDatabase(stateDir, 'seed-live');
    // The guard content is never parsed; presence alone fences the path.
    const guardPath = founderCutoverGuardPath(stateDir);
    writeFileSync(guardPath, '{}', { mode: 0o600 });

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: cleanSource.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'reject-guarded-target',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'must-not-create-pre-backup',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(
      /restore target state holds retired founder-provenance material/,
    );
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'seed-live',
    );
    expect(existsSync(guardPath)).toBe(true);
    expect(existsSync(join(backupRoot, 'must-not-create-pre-backup'))).toBe(
      false,
    );
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('refuses restore over identity residue in the live target without touching it', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'before-residue');
    const cleanSource = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'clean-before-residue',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    const manifests = join(stateDir, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const residue = join(manifests, 'idm_founder.v1.json');
    writeFileSync(residue, '{}', { mode: 0o600 });

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: cleanSource.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'reject-identity-residue-target',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'must-not-create-residue-pre-backup',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(
      /restore target state holds retired founder-provenance material/,
    );
    expect(existsSync(residue)).toBe(true);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'before-residue',
    );
    expect(
      existsSync(join(backupRoot, 'must-not-create-residue-pre-backup')),
    ).toBe(false);
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('refuses a validated payload carrying founder residue before creating anything', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'founder-era');
    const sessionFile = join(
      stateDir,
      'bootstrap',
      'founder-identity',
      'session.123e4567-e89b-42d3-a456-426614174000.v1.json.1.tmp',
    );
    mkdirSync(join(sessionFile, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '{"never":"parsed"}\n', { mode: 0o600 });
    const pointerFile = join(stateDir, 'identity', 'active-identity-bundle.v1.json');
    mkdirSync(join(pointerFile, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(pointerFile, '{"never":"parsed"}\n', { mode: 0o600 });

    // Preservation stays available: the fenced profile still backs up, and
    // the payload keeps the residue byte-for-byte.
    const founderBackup = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'founder-payload',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    expect(founderBackup.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'bootstrap/founder-identity/session.123e4567-e89b-42d3-a456-426614174000.v1.json.1.tmp',
        'identity/active-identity-bundle.v1.json',
      ]),
    );
    expect(
      readFileSync(
        join(
          founderBackup.backupDirectory,
          'identity',
          'active-identity-bundle.v1.json',
        ),
        'utf8',
      ),
    ).toBe('{"never":"parsed"}\n');

    // The target path is now clean and even absent; only the incoming
    // validated payload carries the residue, and that alone refuses.
    rmSync(stateDir, { recursive: true, force: true });
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: founderBackup.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'reject-founder-payload',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'must-not-create-payload-pre-backup',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:00.000Z',
        canonicalConfigSha256: CONFIG_SHA,
      }),
    ).rejects.toThrow(
      /validated backup payload contains retired founder-provenance material/,
    );
    expect(existsSync(stateDir)).toBe(false);
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
    expect(
      validateProductStateBackup(founderBackup.backupDirectory).manifestSha256,
    ).toBe(founderBackup.evidence.manifest_sha256);
  });

  it('fails closed on interrupted-restore artifacts holding founder residue, then recovers after manual cleanup', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'known-good');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'interrupted-founder-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'live-before-crash');
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'interrupted-founder',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-interrupted-founder',
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
    const stageDirectory = join(root, '.echo-restore-interrupted-founder.staging');
    const replacedDirectory = join(
      root,
      '.echo-restore-interrupted-founder.replaced',
    );
    const markerPath = join(
      root,
      '.echo-restore-interrupted-founder.transaction.json',
    );
    expect(existsSync(stageDirectory)).toBe(true);
    expect(existsSync(replacedDirectory)).toBe(true);

    // Founder residue inside the staged payload: recovery would delete the
    // staging directory wholesale, so it must refuse without changing anything.
    const stagedResidue = join(stageDirectory, 'identity', 'manifests');
    mkdirSync(stagedResidue, { recursive: true, mode: 0o700 });
    writeFileSync(join(stagedResidue, 'idm_staged.v1.json'), '{}', {
      mode: 0o600,
    });
    await expect(restoreProductStateBackup(options)).rejects.toThrow(
      /interrupted restore staging holds retired founder-provenance material/,
    );
    expect(existsSync(join(stagedResidue, 'idm_staged.v1.json'))).toBe(true);
    expect(existsSync(replacedDirectory)).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    rmSync(join(stageDirectory, 'identity'), { recursive: true, force: true });

    // Founder residue inside the replaced original: recovery would rename it
    // back over the live path, so it must refuse without performing the rename.
    const replacedResidue = join(replacedDirectory, 'identity', 'manifests');
    mkdirSync(replacedResidue, { recursive: true, mode: 0o700 });
    writeFileSync(join(replacedResidue, 'idm_replaced.v1.json'), '{}', {
      mode: 0o600,
    });
    await expect(restoreProductStateBackup(options)).rejects.toThrow(
      /interrupted restore replaced state holds retired founder-provenance material/,
    );
    expect(existsSync(join(replacedResidue, 'idm_replaced.v1.json'))).toBe(
      true,
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    rmSync(join(replacedDirectory, 'identity'), {
      recursive: true,
      force: true,
    });

    // With the residue resolved manually, the clean topology recovers as ever.
    const recovered = await restoreProductStateBackup(options);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'known-good',
    );
    expect(recovered.evidence.pre_restore_backup).toMatchObject({
      backup_id: 'pre-interrupted-founder',
      reused: true,
    });
    expect(
      readdirSync(root).some((name) => name.startsWith('.echo-restore-')),
    ).toBe(false);
  });

  it('never reports recovery success for promoted founder state without recorded live state', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'promoted-payload');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'promoted-founder-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    // No live state at restore time, so the durable transaction records
    // had_live_state=false and the crash leaves only the promoted payload.
    rmSync(stateDir, { recursive: true, force: true });
    const options = {
      stateDir,
      backupDirectory: source.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: 'promoted-founder',
      restoredAt: RESTORED_AT,
      preRestoreBackupId: 'pre-promoted-founder',
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
    const markerPath = join(
      root,
      '.echo-restore-promoted-founder.transaction.json',
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'promoted-payload',
    );

    // Founder residue materialized in the promoted live root, as an older
    // restore of a founder payload would have left it. The retry must refuse
    // outright rather than verify the stage and report recovery success.
    const manifests = join(stateDir, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'idm_promoted.v1.json'), '{}', {
      mode: 0o600,
    });
    await expect(restoreProductStateBackup(options)).rejects.toThrow(
      /restore target state holds retired founder-provenance material/,
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(join(manifests, 'idm_promoted.v1.json'))).toBe(true);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'promoted-payload',
    );
  });

  it('re-checks the live target after the durable marker, before it is replaced', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'live-content');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'inflight-target-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });

    // Residue lands through the after_prepare_marker window and the injector
    // returns normally; restore must refuse before renaming the live root
    // into the replaced directory.
    const residue = join(stateDir, 'identity', 'manifests');
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: source.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'inflight-target',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'pre-inflight-target',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:04.000Z',
        canonicalConfigSha256: CONFIG_SHA,
        faultInjector(point) {
          if (point === 'after_prepare_marker') {
            mkdirSync(residue, { recursive: true, mode: 0o700 });
            writeFileSync(join(residue, 'idm_inflight.v1.json'), '{}', {
              mode: 0o600,
            });
          }
        },
      }),
    ).rejects.toThrow(
      /restore target state holds retired founder-provenance material/,
    );
    // Refused at the rename boundary: the live root, its residue, the durable
    // marker, and the fully staged payload are all left exactly in place.
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'live-content',
    );
    expect(existsSync(join(residue, 'idm_inflight.v1.json'))).toBe(true);
    expect(
      existsSync(join(root, '.echo-restore-inflight-target.transaction.json')),
    ).toBe(true);
    expect(existsSync(join(root, '.echo-restore-inflight-target.staging'))).toBe(
      true,
    );
    expect(
      existsSync(join(root, '.echo-restore-inflight-target.replaced')),
    ).toBe(false);
  });

  it('re-checks completed staging after the live root is replaced, before promotion', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'stage-payload');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'inflight-stage-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'original-live');

    const stageDirectory = join(root, '.echo-restore-inflight-stage.staging');
    const stagedResidue = join(stageDirectory, 'identity', 'manifests');
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: source.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'inflight-stage',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'pre-inflight-stage',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:05.000Z',
        canonicalConfigSha256: CONFIG_SHA,
        faultInjector(point) {
          if (point === 'after_live_replaced') {
            mkdirSync(stagedResidue, { recursive: true, mode: 0o700 });
            writeFileSync(join(stagedResidue, 'idm_staged.v1.json'), '{}', {
              mode: 0o600,
            });
          }
        },
      }),
    ).rejects.toThrow(
      /completed restore staging holds retired founder-provenance material/,
    );
    // Refused before promotion: the residue-bearing stage is never renamed
    // over the live path, and nothing is deleted or rolled back.
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(join(stagedResidue, 'idm_staged.v1.json'))).toBe(true);
    expect(
      readStateDatabase(
        join(root, '.echo-restore-inflight-stage.replaced', 'echo-brain.sqlite'),
      ),
    ).toBe('original-live');
    expect(
      existsSync(join(root, '.echo-restore-inflight-stage.transaction.json')),
    ).toBe(true);
  });

  it('re-checks the promoted root and adjacent guard before deleting the replaced original or marker', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'promoted-content');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'inflight-promoted-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'original-live');

    // The adjacent guard beside the final target appears through the
    // after_stage_promoted window and the injector returns normally; only the
    // promoted-state re-check can see it.
    const guardPath = founderCutoverGuardPath(stateDir);
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: source.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'inflight-promoted',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'pre-inflight-promoted',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:06.000Z',
        canonicalConfigSha256: CONFIG_SHA,
        faultInjector(point) {
          if (point === 'after_stage_promoted') {
            writeFileSync(guardPath, '{}', { mode: 0o600 });
          }
        },
      }),
    ).rejects.toThrow(
      /promoted restored state holds retired founder-provenance material/,
    );
    // Refused before the success-path deletions: the guard, the replaced
    // original, and the durable marker all survive.
    expect(existsSync(guardPath)).toBe(true);
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'promoted-content',
    );
    expect(
      readStateDatabase(
        join(
          root,
          '.echo-restore-inflight-promoted.replaced',
          'echo-brain.sqlite',
        ),
      ),
    ).toBe('original-live');
    expect(
      existsSync(
        join(root, '.echo-restore-inflight-promoted.transaction.json'),
      ),
    ).toBe(true);
  });

  it('re-checks the replaced original before deleting it after promotion', async () => {
    const root = temporaryRoot();
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    writeStateDatabase(stateDir, 'promoted-content');
    const source = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: 'inflight-replaced-source',
      createdAt: CREATED_AT,
      canonicalConfigSha256: CONFIG_SHA,
    });
    writeStateDatabase(stateDir, 'original-live');

    // Residue lands inside the replaced original through the
    // after_live_replaced window and the injector returns normally. Staging
    // and the promoted root stay clean, so only the pre-deletion re-check of
    // the replaced directory can stop its erasure.
    const replacedDirectory = join(
      root,
      '.echo-restore-inflight-replaced.replaced',
    );
    const replacedResidue = join(replacedDirectory, 'identity', 'manifests');
    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: source.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: 'inflight-replaced',
        restoredAt: RESTORED_AT,
        preRestoreBackupId: 'pre-inflight-replaced',
        preRestoreBackupCreatedAt: '2026-07-18T02:02:07.000Z',
        canonicalConfigSha256: CONFIG_SHA,
        faultInjector(point) {
          if (point === 'after_live_replaced') {
            mkdirSync(replacedResidue, { recursive: true, mode: 0o700 });
            writeFileSync(join(replacedResidue, 'idm_replaced.v1.json'), '{}', {
              mode: 0o600,
            });
          }
        },
      }),
    ).rejects.toThrow(
      /replaced original state holds retired founder-provenance material/,
    );
    // Refused at the deletion boundary: the promoted state, the replaced
    // original, its residue, and the durable marker all survive.
    expect(readStateDatabase(join(stateDir, 'echo-brain.sqlite'))).toBe(
      'promoted-content',
    );
    expect(
      readStateDatabase(join(replacedDirectory, 'echo-brain.sqlite')),
    ).toBe('original-live');
    expect(existsSync(join(replacedResidue, 'idm_replaced.v1.json'))).toBe(
      true,
    );
    expect(
      existsSync(
        join(root, '.echo-restore-inflight-replaced.transaction.json'),
      ),
    ).toBe(true);
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
