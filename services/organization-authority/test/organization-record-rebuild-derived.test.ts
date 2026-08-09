import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  OrganizationRecordLogStore,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
} from '../src/composition/operator-config.js';
import {
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
  rebuildAuthorityDerivedRecordStore,
} from '../src/composition/operator-state.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';

const roots: string[] = [];
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fileIdentity(path: string): Record<string, number | string> {
  const state = statSync(path);
  return {
    dev: state.dev,
    ino: state.ino,
    size: state.size,
    mtime_ms: state.mtimeMs,
    ctime_ms: state.ctimeMs,
    mode: state.mode & 0o777,
    uid: state.uid,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function rejectionEnvelope(index: number): Record<string, unknown> {
  return {
    schema_version: 1,
    event_type: 'rejection',
    envelope_id: `rec_00000000-0000-4000-8000-00000000000${index}`,
    idempotency_key: String(index).repeat(64),
    payload: {
      schema_version: 1,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: `granola-meeting-${index}`,
      },
      meeting_id: `mtg_${index}`,
      rejected_at: '2026-08-08T12:00:00.000Z',
      reason: 'Not a shared decision yet',
      reconsider_after: null,
    },
    reviewer: { principal_id: 'prn_ada', reviewed_by: 'Ada Founder' },
    intent: { restricted: true },
    submitter: { installation_id: INSTALLATION_ID },
  };
}

function underivableEnvelope(index: number): Record<string, unknown> {
  const envelope = rejectionEnvelope(index);
  return { ...envelope, payload: null };
}

function appendRecord(
  config: AuthorityRuntimeConfigV1,
  index: number,
  envelope: Record<string, unknown>,
): void {
  const paths = authorityStatePaths(config.state_dir);
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
  });
  try {
    const canonicalEnvelope = canonicalJson(envelope as never);
    log.append({
      envelope: {
        envelope: envelope as never,
        envelope_id: envelope['envelope_id'] as string,
        event_type: envelope['event_type'] as 'approval' | 'rejection',
        idempotency_key: envelope['idempotency_key'] as string,
        installation_id: INSTALLATION_ID,
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: sha256Digest(canonicalEnvelope),
      recorded_at: `2026-08-08T12:00:0${index}.000Z`,
    });
  } finally {
    log.close();
  }
}

function derivedCursorPosition(databasePath: string): number {
  const database = openOrganizationRecordDatabase(
    databasePath,
    ORGANIZATION_RECORD_DERIVED_DATABASE,
    { readonly: true },
  );
  try {
    return (
      database
        .prepare(
          `SELECT last_position FROM organization_derived_cursor WHERE singleton = 1`,
        )
        .get() as { last_position: number }
    ).last_position;
  } finally {
    database.close();
  }
}

function rebuildingLeftovers(stateDirectory: string): string[] {
  return readdirSync(stateDirectory).filter((name) =>
    name.includes('.rebuilding-'),
  );
}

function expectNoRecordSidecars(
  paths: ReturnType<typeof authorityStatePaths>,
): void {
  for (const databasePath of [
    paths.record_log_database_path,
    paths.record_derived_database_path,
  ]) {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      expect(existsSync(`${databasePath}${suffix}`)).toBe(false);
    }
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no loopback port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function initializedFixture(): Promise<{
  configPath: string;
  config: AuthorityRuntimeConfigV1;
  stateDirectory: string;
}> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-record-rebuild-')),
  );
  chmodSync(root, 0o700);
  roots.push(root);
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
    port: await reserveLoopbackPort(),
  });
  return {
    configPath,
    config: readAuthorityRuntimeConfig(configPath),
    stateDirectory,
  };
}

describe('organization record rebuild-derived', () => {
  it('replays a verified log idempotently without changing protected files', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    appendRecord(fixture.config, 1, rejectionEnvelope(1));
    const protectedBefore = {
      log: fileIdentity(paths.record_log_database_path),
      authority: fileIdentity(paths.database_path),
      marker: fileIdentity(paths.record_installation_marker_path),
    };
    const derivedBefore = fileIdentity(paths.record_derived_database_path);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOrganizationAuthorityCli(
      ['rebuild-derived', '--config', fixture.configPath],
      {},
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const first = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(first).toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-record-derived-rebuild',
      config_path: fixture.configPath,
      record_derived_database_path: paths.record_derived_database_path,
      head_position: 1,
      derived_content_sha256: first['derived_content_sha256'],
    });
    expect(first['derived_content_sha256']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stdout[0]).toBe(`${canonicalJson(first as never)}\n`);

    const second = await rebuildAuthorityDerivedRecordStore(fixture.configPath);
    expect(second.derived_content_sha256).toBe(first['derived_content_sha256']);
    expect({
      log: fileIdentity(paths.record_log_database_path),
      authority: fileIdentity(paths.database_path),
      marker: fileIdentity(paths.record_installation_marker_path),
    }).toEqual(protectedBefore);
    expect(fileIdentity(paths.record_derived_database_path)).not.toEqual(
      derivedBefore,
    );
    expect(derivedCursorPosition(paths.record_derived_database_path)).toBe(1);
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
    expectNoRecordSidecars(paths);
    await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
  });

  it.each(['missing', 'corrupt'] as const)(
    'recreates a %s derived database from the installed log',
    async (condition) => {
      const fixture = await initializedFixture();
      const paths = authorityStatePaths(fixture.stateDirectory);
      appendRecord(fixture.config, 1, rejectionEnvelope(1));
      const logBefore = fileIdentity(paths.record_log_database_path);
      if (condition === 'missing') {
        unlinkSync(paths.record_derived_database_path);
      } else {
        writeFileSync(paths.record_derived_database_path, 'not sqlite');
      }

      const result = await rebuildAuthorityDerivedRecordStore(
        fixture.configPath,
      );

      expect(result.head_position).toBe(1);
      expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
      expect(derivedCursorPosition(paths.record_derived_database_path)).toBe(1);
      expect(statSync(paths.record_derived_database_path).mode & 0o777).toBe(
        0o600,
      );
      await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
    },
  );

  it('refuses while the authority owns the state', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(fixture.config),
    );
    const derivedBefore = fileIdentity(paths.record_derived_database_path);
    try {
      await expect(
        rebuildAuthorityDerivedRecordStore(fixture.configPath),
      ).rejects.toThrow('organization authority is already running');
    } finally {
      await runtime.close();
    }
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
  });

  it('refuses an invalid log before replacing the derived database', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const database = new Database(paths.record_log_database_path);
    try {
      database
        .prepare(
          `INSERT INTO organization_record_log (
             position, envelope_id, event_type, installation_id,
             idempotency_key, canonical_envelope, envelope_sha256,
             receipt_payload, previous_record_hash, record_hash, recorded_at
           ) VALUES (1, 'rec_00000000-0000-4000-8000-000000000000', 'rejection',
             'ins_00000000-0000-4000-8000-000000000000', ?, '{}', ?, '{}',
             NULL, ?, '2026-08-08T12:00:00.000Z')`,
        )
        .run(
          'a'.repeat(64),
          `sha256:${'b'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
        );
    } finally {
      database.close();
    }
    const logBefore = fileIdentity(paths.record_log_database_path);
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow('chain verification failed');

    expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });

  it('cleans staging and preserves the target when projection halts', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    appendRecord(fixture.config, 1, rejectionEnvelope(1));
    appendRecord(fixture.config, 2, underivableEnvelope(2));
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow(
      /derive halted while rebuilding at cursor 1:.*position 2/,
    );

    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });

  it.each([
    ['log', '-journal'],
    ['log', '-wal'],
    ['log', '-shm'],
    ['derived', '-journal'],
    ['derived', '-wal'],
    ['derived', '-shm'],
  ] as const)('refuses a canonical %s%s sidecar', async (target, suffix) => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const databasePath =
      target === 'log'
        ? paths.record_log_database_path
        : paths.record_derived_database_path;
    writeFileSync(`${databasePath}${suffix}`, 'stale', { mode: 0o600 });
    const logBefore = fileIdentity(paths.record_log_database_path);
    const derivedBefore = fileIdentity(paths.record_derived_database_path);

    await expect(
      rebuildAuthorityDerivedRecordStore(fixture.configPath),
    ).rejects.toThrow('has SQLite sidecar');

    expect(fileIdentity(paths.record_log_database_path)).toEqual(logBefore);
    expect(fileIdentity(paths.record_derived_database_path)).toEqual(
      derivedBefore,
    );
    expect(rebuildingLeftovers(paths.state_directory)).toEqual([]);
  });
});
