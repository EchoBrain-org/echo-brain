import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
} from '@echo-brain/organization-record';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  ORGANIZATION_RECORD_LOG_DATABASE,
  OrganizationRecordLogStore,
  inspectOrganizationRecordDatabaseSchema,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record/maintenance';
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
  type AuthorityStatePaths,
} from '../src/composition/operator-config.js';
import {
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
  installAuthorityIntegrations,
  type AuthorityIntegrationsInstallationFaultPoint,
} from '../src/composition/operator-state.js';
import { inspectAuthorityDatabaseReadOnly } from '../src/adapters/persistence/sqlite/read-only-inspection.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import { authorityRuntimeFingerprint } from '../src/adapters/runtime/runtime-fingerprint.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Rewinds one authority to the only state maintenance may bootstrap: current
 * schema, integrations anchored, record store never installed. The anchor
 * columns are immutable by trigger, so the triggers come off and go straight
 * back on from the migration itself rather than being reimplemented here.
 */
function clearRecordInstallationAnchor(databasePath: string): void {
  const migration = readFileSync(
    new URL(
      '../migrations/0005_record_installation_anchor.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const database = new Database(databasePath);
  try {
    database.exec(`
      DROP TRIGGER authority_metadata_record_anchor_immutable;
      DROP TRIGGER authority_metadata_record_anchor_valid;
      UPDATE authority_metadata
      SET record_marker_sha256 = NULL, record_installed_at = NULL
      WHERE singleton = 1;
    `);
    database.exec(migration.slice(migration.indexOf('CREATE TRIGGER')));
  } finally {
    database.close();
  }
}

/**
 * One real chained append. The anchor rule is about a log that holds history,
 * so this uses the append path rather than an INSERT: a row the chain
 * verifier accepts is the thing that must never be silently replaced.
 */
function appendOneRecord(config: AuthorityRuntimeConfigV1): void {
  const paths = authorityStatePaths(config.state_dir);
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
  });
  try {
    const envelope = { kind: 'echo-organization-record-envelope' };
    const canonicalEnvelope = canonicalJson(envelope);
    log.append({
      envelope: {
        envelope: envelope as never,
        envelope_id: 'rec_00000000-0000-4000-8000-000000000001',
        event_type: 'approval',
        idempotency_key: 'a'.repeat(64),
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: sha256Digest(canonicalEnvelope),
    });
  } finally {
    log.close();
  }
}

function recordLogHeadPosition(databasePath: string): number {
  const database = openOrganizationRecordDatabase(
    databasePath,
    { readonly: true },
  );
  try {
    const row = database
      .prepare(
        `SELECT COALESCE(MAX(position), 0) AS head FROM organization_record_log`,
      )
      .get() as { head: number };
    return row.head;
  } finally {
    database.close();
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
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function initializedFixture(): Promise<{
  configPath: string;
  stateDirectory: string;
}> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-record-lifecycle-')),
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
  return { configPath, stateDirectory };
}

describe('organization record persistence lifecycle', () => {
  it('publishes both record databases as private 0600 files at initialization', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);

    for (const [path, definition] of [
      [paths.record_log_database_path, ORGANIZATION_RECORD_LOG_DATABASE],
      [
        paths.record_derived_database_path,
        ORGANIZATION_RECORD_DERIVED_DATABASE,
      ],
    ] as const) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // DELETE journaling, so a stopped database is inspectable read-only and
      // `state-backup` — which refuses WAL sidecars — keeps working.
      expect(existsSync(`${path}-wal`)).toBe(false);
      const database = openOrganizationRecordDatabase(path, {
        readonly: true,
      });
      try {
        expect(
          inspectOrganizationRecordDatabaseSchema(database, definition),
        ).toBe(definition === ORGANIZATION_RECORD_LOG_DATABASE ? 4 : 3);
      } finally {
        database.close();
      }
    }
    // The log and the derived graph never share a file.
    expect(paths.record_log_database_path).not.toBe(
      paths.record_derived_database_path,
    );
  });

  it('binds both record databases into the runtime fingerprint', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const before = authorityRuntimeFingerprint(serveConfig);

    // Replacing the file by inode is exactly what a swapped-in log looks like.
    const replacement = `${serveConfig.record_log_database_path}.replacement`;
    const database = new Database(replacement);
    database.close();
    chmodSync(replacement, 0o600);
    renameSync(replacement, serveConfig.record_log_database_path);

    expect(authorityRuntimeFingerprint(serveConfig)).not.toBe(before);
  });

  it('refuses to serve when a record database is missing', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    rmSync(serveConfig.record_log_database_path);

    // Serve never creates required production state: the fingerprint binds the
    // exact file identity, so an absent log is refused before anything opens.
    await expect(startOrganizationAuthority(serveConfig)).rejects.toThrow(
      /record-log\.sqlite/,
    );
    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow('record log database is missing');
  });

  it('refuses a record database that belongs to another organization', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    // A whole, schema-valid log bound to a different organization: the
    // realistic failure is a restored backup from another org, not a mutated
    // metadata row, which the immutability trigger already refuses.
    const foreign = join(fixture.stateDirectory, 'foreign-record-log.sqlite');
    OrganizationRecordLogStore.open(foreign, {
      organization_id: 'org_99999999-9999-4999-8999-999999999999',
      authority_id: config.authority.authority_id,
    }).close();
    rmSync(paths.record_log_database_path);
    renameSync(foreign, paths.record_log_database_path);

    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow('belongs to a different organization or authority');
  });

  it('serves, verifies the chain at startup, and closes both handles', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    await inspectAuthorityServePreflight(fixture.configPath, config);
    const serveConfig = resolveAuthorityServeConfig(config);

    const runtime = await startOrganizationAuthority(serveConfig);
    await runtime.close();

    // A clean shutdown leaves both files reopenable, which a leaked handle or
    // an unfinished transaction would prevent.
    for (const path of [
      serveConfig.record_log_database_path,
      serveConfig.record_derived_database_path,
    ] as const) {
      const database = openOrganizationRecordDatabase(path, {
        readonly: true,
      });
      database.close();
    }
  });

  it('refuses to serve on a log whose chain does not verify', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const database = new Database(serveConfig.record_log_database_path);
    try {
      // A first row whose record hash is fabricated. The triggers accept it —
      // they enforce ordering, not content — so only walking the chain catches
      // it, which is exactly why the host walks it at process start.
      database
        .prepare(
          `INSERT INTO organization_record_log (
             position, envelope_id, event_type, installation_id,
             idempotency_key, canonical_envelope, envelope_sha256,
             receipt_payload, previous_record_hash, record_hash, recorded_at
           ) VALUES (1, 'rec_00000000-0000-4000-8000-000000000000', 'approval',
             'ins_00000000-0000-4000-8000-000000000000', ?, '{}', ?, '{}',
             NULL, ?, '2026-08-08T12:00:00.000Z')`,
        )
        .run('a'.repeat(64), `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`);
    } finally {
      database.close();
    }

    await expect(startOrganizationAuthority(serveConfig)).rejects.toThrow(
      'chain verification failed',
    );
  });

  it('publishes the record installation marker and anchor at initialization', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const config = readAuthorityRuntimeConfig(fixture.configPath);

    expect(existsSync(paths.record_installation_marker_path)).toBe(true);
    expect(statSync(paths.record_installation_marker_path).mode & 0o777).toBe(
      0o600,
    );
    const marker = JSON.parse(
      readFileSync(paths.record_installation_marker_path, 'utf8'),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-authority-record-installation-marker',
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
      record_log_database_path: paths.record_log_database_path,
      record_derived_database_path: paths.record_derived_database_path,
    });
    // The anchor lives in `authority.sqlite`, outside both record databases and
    // outside the state-directory marker, so it survives their deletion.
    const inspected = inspectAuthorityDatabaseReadOnly(config.database_path);
    expect(inspected.record_marker_sha256).toBe(canonicalSha256(marker));
    expect(inspected.record_installed_at).toBe(marker['installed_at']);
  });

  it('bootstraps a provably pre-record legacy state through install-integrations', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    // A directory published before the record store existed: no databases, no
    // marker, and — decisively — no anchor promising one.
    clearRecordInstallationAnchor(paths.database_path);
    rmSync(paths.record_installation_marker_path);
    rmSync(paths.record_log_database_path);
    rmSync(paths.record_derived_database_path);

    await installAuthorityIntegrations(fixture.configPath);

    expect(existsSync(paths.record_log_database_path)).toBe(true);
    expect(existsSync(paths.record_derived_database_path)).toBe(true);
    expect(existsSync(paths.record_installation_marker_path)).toBe(true);
    expect(
      inspectAuthorityDatabaseReadOnly(paths.database_path)
        .record_marker_sha256,
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    await inspectAuthorityServePreflight(
      fixture.configPath,
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    // Idempotent: a second run adopts the anchored store rather than replacing
    // it.
    await installAuthorityIntegrations(fixture.configPath);
  });

  describe('an interrupted record-store installation resumes', () => {
    const faults: ReadonlyArray<
      readonly [AuthorityIntegrationsInstallationFaultPoint, boolean]
    > = [
      ['after_record_databases_published', false],
      ['after_record_marker_published', true],
    ];

    for (const [faultPoint, markerAfterFault] of faults) {
      it(`resumes after ${faultPoint}`, async () => {
        const fixture = await initializedFixture();
        const paths = authorityStatePaths(fixture.stateDirectory);
        clearRecordInstallationAnchor(paths.database_path);
        rmSync(paths.record_installation_marker_path);
        rmSync(paths.record_log_database_path);
        rmSync(paths.record_derived_database_path);

        await expect(
          installAuthorityIntegrations(fixture.configPath, {
            faultInjector: (observed) => {
              if (observed === faultPoint) throw new Error(`fault:${faultPoint}`);
            },
          }),
        ).rejects.toThrow(`fault:${faultPoint}`);

        // Publication is ordered databases, marker, anchor, so an interruption
        // leaves a prefix of that order and never an anchored half-install.
        expect(existsSync(paths.record_log_database_path)).toBe(true);
        expect(existsSync(paths.record_installation_marker_path)).toBe(
          markerAfterFault,
        );
        expect(
          inspectAuthorityDatabaseReadOnly(paths.database_path)
            .record_marker_sha256,
        ).toBeNull();

        await installAuthorityIntegrations(fixture.configPath);

        expect(existsSync(paths.record_installation_marker_path)).toBe(true);
        expect(
          inspectAuthorityDatabaseReadOnly(paths.database_path)
            .record_marker_sha256,
        ).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(
          readdirSync(paths.state_directory).filter((name) =>
            name.includes('.installing-'),
          ),
        ).toEqual([]);
        await inspectAuthorityServePreflight(
          fixture.configPath,
          readAuthorityRuntimeConfig(fixture.configPath),
        );
      });
    }

    it('refuses an unanchored half of the log and derived pair', async () => {
      const fixture = await initializedFixture();
      const paths = authorityStatePaths(fixture.stateDirectory);
      clearRecordInstallationAnchor(paths.database_path);
      rmSync(paths.record_installation_marker_path);
      rmSync(paths.record_derived_database_path);

      await expect(
        installAuthorityIntegrations(fixture.configPath),
      ).rejects.toThrow('only part of the record log/derived pair');
      expect(existsSync(paths.record_derived_database_path)).toBe(false);
    });
  });

  describe('an anchored record store is never recreated', () => {
    const deletions: ReadonlyArray<
      readonly [string, (paths: AuthorityStatePaths) => void]
    > = [
      [
        'the log alone',
        (paths) => rmSync(paths.record_log_database_path),
      ],
      [
        'both databases',
        (paths) => {
          rmSync(paths.record_log_database_path);
          rmSync(paths.record_derived_database_path);
        },
      ],
      [
        'the marker and both databases',
        (paths) => {
          rmSync(paths.record_installation_marker_path);
          rmSync(paths.record_log_database_path);
          rmSync(paths.record_derived_database_path);
        },
      ],
    ];

    for (const [label, remove] of deletions) {
      it(`refuses maintenance after ${label} is deleted`, async () => {
        const fixture = await initializedFixture();
        const config = readAuthorityRuntimeConfig(fixture.configPath);
        const paths = authorityStatePaths(fixture.stateDirectory);
        appendOneRecord(config);
        const headBefore = recordLogHeadPosition(
          paths.record_log_database_path,
        );
        expect(headBefore).toBe(1);

        remove(paths);
        await expect(
          installAuthorityIntegrations(fixture.configPath),
        ).rejects.toThrow(
          'organization record store was already installed but its marker, log, or derived database is missing',
        );

        // No replacement log: an empty one would look healthy while every
        // receipt already issued pointed at records it no longer holds.
        expect(existsSync(paths.record_log_database_path)).toBe(false);
        await expect(
          inspectAuthorityServePreflight(
            fixture.configPath,
            readAuthorityRuntimeConfig(fixture.configPath),
          ),
        ).rejects.toThrow();
      });
    }

    it('accepts maintenance again once the complete state is restored', async () => {
      const fixture = await initializedFixture();
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      const paths = authorityStatePaths(fixture.stateDirectory);
      appendOneRecord(config);
      const backup = readFileSync(paths.record_log_database_path);
      rmSync(paths.record_log_database_path);

      await expect(
        installAuthorityIntegrations(fixture.configPath),
      ).rejects.toThrow(/already installed/);

      writeFileSync(paths.record_log_database_path, backup, { mode: 0o600 });
      await installAuthorityIntegrations(fixture.configPath);

      // The restored log still holds its record; nothing was reset.
      expect(recordLogHeadPosition(paths.record_log_database_path)).toBe(1);
    });
  });

  it('treats a halted startup derivation as fatal', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    // A chain-valid row whose envelope derive cannot process. Ingest-time
    // payload validation should make this impossible; when it happens anyway
    // the follower must halt rather than skip, and the host must not come up
    // looking healthy on a stuck cursor.
    const envelopeId = 'rec_00000000-0000-4000-8000-000000000000';
    const installationId = 'ins_00000000-0000-4000-8000-000000000000';
    const idempotencyKey = 'a'.repeat(64);
    const canonicalEnvelope = canonicalJson({
      envelope_id: envelopeId,
      event_type: 'approval',
      idempotency_key: idempotencyKey,
      submitter: { installation_id: installationId },
      payload: null,
    });
    const envelopeSha256 = sha256Digest(canonicalEnvelope);
    const recordedAt = '2026-08-08T12:00:00.000Z';
    const recordHash = organizationRecordHash(
      organizationRecordFrame({
        organization_id: config.organization.organization_id,
        position: 1,
        previous_record_hash: null,
        recorded_at: recordedAt,
        envelope_sha256: envelopeSha256,
      }),
    );
    const database = new Database(serveConfig.record_log_database_path);
    try {
      database
        .prepare(
          `INSERT INTO organization_record_log (
             position, envelope_id, event_type, installation_id,
             idempotency_key, canonical_envelope, envelope_sha256,
             receipt_payload, previous_record_hash, record_hash, recorded_at
           ) VALUES (1, 'rec_00000000-0000-4000-8000-000000000000', 'approval',
             'ins_00000000-0000-4000-8000-000000000000', ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          idempotencyKey,
          canonicalEnvelope,
          envelopeSha256,
          canonicalJson(
            organizationRecordReceiptPayload({
              authority_id: config.authority.authority_id,
              organization_id: config.organization.organization_id,
              envelope_id: envelopeId,
              envelope_sha256: envelopeSha256,
              installation_id: installationId,
              idempotency_key: idempotencyKey,
              position: 1,
              record_hash: recordHash,
              recorded_at: recordedAt,
            }),
          ),
          recordHash,
          recordedAt,
        );
    } finally {
      database.close();
    }

    await expect(startOrganizationAuthority(serveConfig)).rejects.toThrow(
      'derive halted during startup catch-up',
    );
  });
});
