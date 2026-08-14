import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import { createServer } from 'node:net';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  federationId,
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  createOrganizationRecordOrganizationMemberApprovalEnvelope,
  organizationAuthorityPinSha256,
  organizationMemberReadablePolicyContractSha256,
  organizationMemberReadableReleaseDraftSha256,
  organizationRecordEnvelopeId,
  organizationRecordOrganizationMemberIntent,
  projectOrganizationMemberReadableReleaseDraft,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  OrganizationRecordLogStore,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record/maintenance';
import type { JsonObject } from '@echo-brain/organization-record';
import {
  createOrganizationMemberEligibilityCapabilityChannel,
  deriveOrganizationMemberReadableEligibilityProof,
} from '@echo-brain/organization-record/append';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
} from '../src/composition/operator-config.js';
import {
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
  rebuildAuthorityReadableSearch,
  rebuildAuthorityDerivedRecordStore,
  verifyAuthorityReadableSearchBackup,
} from '../src/composition/operator-state.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import { validateReadableSearchGenerationPublishedAuditDetail } from '../src/application/readable-search-persistence.js';
import { organizationMemberReadableEnvelopeValidator } from '../src/composition/organization-member-envelope-validator.js';
import { recordBrief } from './support/record-ingest-fixture.js';

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
    });
  } finally {
    log.close();
  }
}

async function appendOrganizationMemberRecord(
  config: AuthorityRuntimeConfigV1,
): Promise<void> {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  const signingKey = {
    key_id: p256KeyId(publicBytes),
    algorithm: 'ecdsa-p256-sha256-der-low-s',
    public_key_spki_der_base64: publicBytes.toString('base64'),
  } as const;
  const authorityDescriptor = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    signing_key: signingKey,
  } as const;
  const pinned = verifyOrganizationAuthorityPin(
    authorityDescriptor,
    organizationAuthorityPinSha256(authorityDescriptor),
  );
  const approvalId = createHash('sha256')
    .update('stopped-rebuild-member-v3')
    .digest('hex');
  const brief = recordBrief();
  const evaluatedAt = '2026-08-08T12:00:00.000Z';
  const semanticIntentSha256 = sha256Digest('member semantic intent');
  const installationId = federationId('ins');
  const principalId = federationId('prn');
  const membershipId = federationId('mem');
  const releaseDraftSha256 = organizationMemberReadableReleaseDraftSha256(
    projectOrganizationMemberReadableReleaseDraft({
      approval_id: approvalId,
      brief,
    }),
  );
  const envelope = await createOrganizationRecordOrganizationMemberApprovalEnvelope(
    {
      envelope_id: organizationRecordEnvelopeId(),
      idempotency_key: approvalId,
      payload: {
        brief,
        source: {
          adapter_id: 'granola',
          instance_id: 'primary',
          external_id: 'stopped-rebuild-member-v3',
        },
        alternatives: [],
        links: null,
        reviewed_at: evaluatedAt,
        surface: 'slack-organization-member-readable-v1',
      },
      reviewer: {
        principal_id: principalId,
        membership_id: membershipId,
        reviewed_by: 'Ada Founder',
        authorization: {
          schema_version: 3,
          kind: 'echo-organization-authorization-evidence',
          policy_id: 'organization-member-readable-v1',
          policy_contract_sha256:
            organizationMemberReadablePolicyContractSha256(),
          authority_id: config.authority.authority_id,
          organization_id: config.organization.organization_id,
          enrollment_id: federationId('enr'),
          installation_id: installationId,
          request_id: `pcr_${randomUUID()}`,
          approval_id: approvalId,
          action: 'approve',
          request_sha256: sha256Digest('member request'),
          provider_event_sha256: sha256Digest('member provider event'),
          allowed: true,
          reason_code: 'active_organization_member_readable_notice_v1',
          principal_id: principalId,
          membership_id: membershipId,
          adapter_binding_id: federationId('bnd'),
          permission_grant_id: `pgr_${randomUUID()}`,
          evaluated_at: evaluatedAt,
          authorization_audit_event_id: `aud_${randomUUID()}`,
          authorization_audit_entry_sha256: sha256Digest('member audit entry'),
          release_draft_sha256: releaseDraftSha256,
          approval_presentation_sha256: sha256Digest('member presentation'),
          semantic_intent_sha256: semanticIntentSha256,
          message_presentation_sha256: sha256Digest('member provider presentation'),
        },
      },
      intent: organizationRecordOrganizationMemberIntent(
        semanticIntentSha256,
      ),
      submitter: {
        installation_id: installationId,
        submitted_at: evaluatedAt,
      },
      installation_signing_key: signingKey,
    },
    pinned,
    async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: keyPair.privateKey,
          dsaEncoding: 'der',
        }),
      ),
  );
  const document = envelope as unknown as JsonObject;
  const paths = authorityStatePaths(config.state_dir);
  const log = OrganizationRecordLogStore.open(paths.record_log_database_path, {
    organization_id: config.organization.organization_id,
    authority_id: config.authority.authority_id,
    organization_member_validator: organizationMemberReadableEnvelopeValidator({
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    }),
  });
  try {
    const canonicalEnvelope = canonicalJson(envelope);
    const envelopeSha256 = sha256Digest(canonicalEnvelope);
    const view = organizationMemberReadableEnvelopeValidator({
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    })(document);
    const proof = deriveOrganizationMemberReadableEligibilityProof({
      organization_id: config.organization.organization_id,
      canonical_envelope_sha256: envelopeSha256,
      envelope: view,
    });
    const channel = createOrganizationMemberEligibilityCapabilityChannel();
    log.append({
      envelope: {
        envelope: document,
        envelope_id: envelope.envelope_id,
        event_type: 'approval',
        idempotency_key: envelope.idempotency_key,
        installation_id: envelope.submitter.installation_id,
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: envelopeSha256,
      organization_member_eligibility: {
        capability: channel.issue(proof.preimage),
        channel,
      },
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

function generationPublicationAudits(databasePath: string): readonly {
  readonly occurred_at: string;
  readonly subject_id: string;
  readonly detail: unknown;
}[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database
      .prepare(
        `SELECT occurred_at, subject_id, detail_json
         FROM authority_audit_log
         WHERE action = 'permission.readable_search_generation_published'
         ORDER BY audit_sequence ASC`,
      )
      .all() as readonly {
        readonly occurred_at: string;
        readonly subject_id: string;
        readonly detail_json: string;
      }[]).map((row) => ({
      occurred_at: row.occurred_at,
      subject_id: row.subject_id,
      detail: parseCanonicalJson(row.detail_json),
    }));
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
  it('builds and atomically publishes an idempotent stopped readable-search generation', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const stdout: string[] = [];
    const code = await runOrganizationAuthorityCli(
      ['rebuild-readable-search', '--config', fixture.configPath],
      {},
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );
    expect(code).toBe(0);
    const first = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(first).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-authority-readable-search-rebuild',
      config_path: fixture.configPath,
      record_head_position: 0,
      record_head_hash: null,
    });
    expect(first.generation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.manifest_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(paths.state_directory, 'record-retrieval', 'generations', String(first.generation_id), 'manifest.json'))).toBe(true);

    const second = await rebuildAuthorityReadableSearch(fixture.configPath);
    expect(second.generation_id).toBe(first.generation_id);
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    const audits = generationPublicationAudits(paths.database_path);
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit).toMatchObject({
      subject_id: fixture.config.organization.organization_id,
    });
    const detail = validateReadableSearchGenerationPublishedAuditDetail(audit?.detail);
    expect(detail).toMatchObject({
      organization_id: fixture.config.organization.organization_id,
      publication: {
        generation_id: first.generation_id,
        manifest_sha256: first.manifest_sha256,
        record_head_position: 0,
        record_head_hash: null,
      },
      prior_generation: null,
      published_at: audit?.occurred_at,
    });
    await inspectAuthorityServePreflight(fixture.configPath, fixture.config);
  });

  it('reports a text-free not-built readable-search backup through the CLI', async () => {
    const fixture = await initializedFixture();
    const stdout: string[] = [];
    const code = await runOrganizationAuthorityCli(
      ['verify-readable-search-backup', '--config', fixture.configPath],
      {},
      { stdout: (value) => stdout.push(value), stderr: () => undefined },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(result).toEqual({
      schema_version: 1,
      kind: 'echo-organization-authority-readable-search-backup-verification',
      config_path: fixture.configPath,
      organization_id: fixture.config.organization.organization_id,
      status: 'not_built',
      generation_id: null,
      manifest_sha256: null,
      retrieval_contract_sha256: null,
      record_head_position: 0,
      record_head_hash: null,
    });
    expect(stdout[0]).toBe(`${canonicalJson(result as never)}\n`);
  });

  it('rejects an incomplete unreferenced finalized generation even without a pointer', async () => {
    const fixture = await initializedFixture();
    const generations = join(
      fixture.stateDirectory,
      'record-retrieval',
      'generations',
    );
    mkdirSync(generations, { recursive: true, mode: 0o700 });
    chmodSync(join(fixture.stateDirectory, 'record-retrieval'), 0o700);
    chmodSync(generations, 0o700);
    mkdirSync(join(generations, 'unreferenced-incomplete'), { mode: 0o700 });

    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/generation manifest/);
  });

  it('admits the exact active generation and rejects stale or corrupt backup state', async () => {
    const fixture = await initializedFixture();
    const built = await rebuildAuthorityReadableSearch(fixture.configPath);
    const verified = await verifyAuthorityReadableSearchBackup(fixture.configPath);
    expect(verified).toMatchObject({
      status: 'verified',
      generation_id: built.generation_id,
      manifest_sha256: built.manifest_sha256,
      record_head_position: built.record_head_position,
      record_head_hash: built.record_head_hash,
    });

    appendRecord(fixture.config, rejectionEnvelope(1));
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow('does not match the exact record head');

    const rebuilt = await rebuildAuthorityReadableSearch(fixture.configPath);
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).resolves.toMatchObject({
      status: 'verified',
      generation_id: rebuilt.generation_id,
    });
    const paths = authorityStatePaths(fixture.stateDirectory);
    const manifestPath = join(
      paths.state_directory,
      'record-retrieval',
      'generations',
      rebuilt.generation_id,
      'manifest.json',
    );
    writeFileSync(manifestPath, '{}', { mode: 0o600 });
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/manifest/);
  });

  it.each([
    ['staging directory', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      const directory = join(dirname(generationDirectory), '.staging');
      mkdirSync(directory, { mode: 0o700 });
    }],
    ['retrieval SQLite sidecar', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      writeFileSync(join(generationDirectory, 'unexpected.sqlite-wal'), 'stale', { mode: 0o600 });
    }],
    ['core SQLite sidecar', (_generationDirectory: string, paths: ReturnType<typeof authorityStatePaths>) => {
      writeFileSync(`${paths.database_path}-wal`, 'stale', { mode: 0o600 });
    }],
    ['wrong-mode retrieval file', (generationDirectory: string, _paths: ReturnType<typeof authorityStatePaths>) => {
      chmodSync(join(generationDirectory, 'manifest.json'), 0o644);
    }],
  ] as const)('rejects readable-search backup %s', async (_label, introduce) => {
    const fixture = await initializedFixture();
    const built = await rebuildAuthorityReadableSearch(fixture.configPath);
    const generationDirectory = join(
      fixture.stateDirectory,
      'record-retrieval',
      'generations',
      built.generation_id,
    );
    introduce(generationDirectory, authorityStatePaths(fixture.stateDirectory));
    await expect(
      verifyAuthorityReadableSearchBackup(fixture.configPath),
    ).rejects.toThrow(/staging directory|SQLite sidecar|0600/);
  });

  it('refuses readable-search backup verification while the authority owns the state', async () => {
    const fixture = await initializedFixture();
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(fixture.config),
    );
    try {
      await expect(
        verifyAuthorityReadableSearchBackup(fixture.configPath),
      ).rejects.toThrow('organization authority is already running');
    } finally {
      await runtime.close();
    }
  });

  it('replays a verified log idempotently without changing protected files', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    appendRecord(fixture.config, rejectionEnvelope(1));
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

  it('rebuilds a valid schema-v3 member record as the exact text-free exclusion', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    await appendOrganizationMemberRecord(fixture.config);

    const log = new Database(paths.record_log_database_path, {
      readonly: true,
    });
    expect(
      log
        .prepare(
          'SELECT log_position, atom_order FROM organization_member_readable_policy_fact ORDER BY atom_order',
        )
        .all(),
    ).toEqual([{ log_position: 1, atom_order: 0 }]);
    log.close();

    const rebuilt = await rebuildAuthorityDerivedRecordStore(
      fixture.configPath,
    );
    expect(rebuilt.head_position).toBe(1);
    const derived = new Database(paths.record_derived_database_path, {
      readonly: true,
    });
    try {
      expect(
        derived
          .prepare(
            `SELECT log_position, envelope_version, policy_id, outcome
               FROM organization_derived_member_readable_policy_exclusion`,
          )
          .all(),
      ).toEqual([
        {
          log_position: 1,
          envelope_version: 3,
          policy_id: 'organization-member-readable-v1',
          outcome: 'deferred-to-permission-aware-retrieval',
        },
      ]);
      expect(
        (
          derived
            .prepare('SELECT COUNT(*) AS count FROM organization_derived_atom')
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      derived.close();
    }
  });

  it.each(['missing', 'corrupt'] as const)(
    'recreates a %s derived database from the installed log',
    async (condition) => {
      const fixture = await initializedFixture();
      const paths = authorityStatePaths(fixture.stateDirectory);
      appendRecord(fixture.config, rejectionEnvelope(1));
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
    appendRecord(fixture.config, rejectionEnvelope(1));
    appendRecord(fixture.config, underivableEnvelope(2));
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
