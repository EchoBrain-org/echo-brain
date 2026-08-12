import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  federationId,
} from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  reviewerQueryAuditExportBytes,
  reviewerQueryAuditExportDocument,
  reviewerQueryAuditOutputPathSha256,
} from '../src/application/reviewer-query-audit.js';
import {
  readableSearchQueryAuditExportBytes,
  readableSearchQueryAuditExportDocument,
  readableSearchQueryAuditOutputPathSha256,
} from '../src/application/readable-search-query-audit-maintenance.js';
import type {
  ReviewerQueryAuditExportCommandV1,
  ReviewerQueryAuditExpiryCommandV1,
} from '../src/application/reviewer-query-audit.js';
import type {
  ReadableSearchQueryAuditExportCommandV1,
  ReadableSearchQueryAuditExpiryCommandV1,
} from '../src/application/readable-search-query-audit-maintenance.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import {
  expireReviewerQueryAudit,
  expireReadableSearchQueryAudit,
  exportReadableSearchQueryAudit,
  exportReviewerQueryAudit,
  initializeDevelopmentAuthority,
} from '../src/composition/operator-state.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import { readAuthorityRuntimeConfig } from '../src/composition/operator-config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function privateCanonicalCommand(path: string, command: unknown): void {
  writeFileSync(path, canonicalJson(command as never), { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface OperatorFixture {
  readonly root: string;
  readonly state: string;
  readonly config: string;
  readonly output: string;
  readonly owner: StoredAuthorityMembership;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly last_observed_at: string;
}

async function operatorFixture(): Promise<OperatorFixture> {
  const root = realpathSync(
    mkdtempSync('/tmp/eqao-'),
  );
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const state = join(root, 'state');
  const config = join(root, 'authority.json');
  const initialized = await initializeDevelopmentAuthority({
    config_path: config,
    state_directory: state,
    organization_display_name: 'Example Company',
  });
  const runtimeConfig = readAuthorityRuntimeConfig(config);
  const database = new Database(runtimeConfig.database_path, { readonly: true });
  const previous = (
    database
      .prepare(
        'SELECT last_observed_at FROM authority_metadata WHERE singleton = 1',
      )
      .get() as { last_observed_at: string }
  ).last_observed_at;
  database.close();
  const configuredAt = plus(previous, 1);
  const repository = new SqliteOrganizationAuthorityRepository(
    runtimeConfig.database_path,
  );
  repository.initialize({
    descriptor: initialized.authority_descriptor,
    authority_pin_sha256: organizationAuthorityPinSha256(
      initialized.authority_descriptor,
    ),
    organization_display_name: 'Example Company',
    maximum_active_lease_ttl_ms: runtimeConfig.access.active_lease_ttl_ms,
    initialized_at: configuredAt,
  });
  const owner: StoredAuthorityMembership = {
    organization_id: initialized.authority_descriptor.organization_id,
    principal_id: federationId('prn'),
    membership_id: federationId('mem'),
    display_name: 'Owner',
    membership_type: 'owner',
    status: 'active',
    provisioned_at: plus(configuredAt, 1),
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${randomUUID()}`,
    admin_command_sha256: canonicalSha256({
      schema_version: 1,
      kind: 'test-owner-provisioning',
    }),
  };
  repository.write(owner.provisioned_at, (transaction) => {
    transaction.insertMembership(owner);
  });
  repository.close();
  return {
    root,
    state,
    config,
    output: join(root, 'reviewer-query-audit.json'),
    owner,
    authority_id: initialized.authority_descriptor.authority_id,
    organization_id: initialized.authority_descriptor.organization_id,
    last_observed_at: owner.provisioned_at,
  };
}

function revokeOperatorOwner(context: OperatorFixture, revokedAt: string): void {
  const database = new Database(readAuthorityRuntimeConfig(context.config).database_path);
  try {
    database
      .prepare(
        `UPDATE authority_memberships
           SET status = 'revoked', revoked_at = ?, revocation_reason = ?
         WHERE membership_id = ?`,
      )
      .run(revokedAt, 'owner access revoked after export', context.owner.membership_id);
  } finally {
    database.close();
  }
}

describe('reviewer query-audit stopped operator commands', () => {
  it('publishes exact create-once 0600 export bytes after its durable receipt', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const command: ReviewerQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-reviewer-query-audit-export-command',
      command_id: `qac_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded auditor export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: reviewerQueryAuditOutputPathSha256(context.output),
    };
    const commandPath = join(context.root, 'export-command.json');
    privateCanonicalCommand(commandPath, command);

    const first = await exportReviewerQueryAudit(
      context.config,
      commandPath,
      context.output,
      { now: () => observedAt },
    );
    expect(first.delivery_status).toBe('written');
    expect(lstatSync(context.output).mode & 0o777).toBe(0o600);
    expect(readFileSync(context.output)).toEqual(
      reviewerQueryAuditExportBytes(
        reviewerQueryAuditExportDocument(command, []),
      ),
    );

    const retry = await exportReviewerQueryAudit(
      context.config,
      commandPath,
      context.output,
      { now: () => plus(observedAt, 60 * 60 * 1000) },
    );
    expect(retry).toEqual({
      control_event: first.control_event,
      delivery_status: 'already_present',
    });
  });

  it('does not republish a deleted reviewer export when its owner was revoked after the first export', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const command: ReviewerQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-reviewer-query-audit-export-command',
      command_id: `qac_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded auditor export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: reviewerQueryAuditOutputPathSha256(context.output),
    };
    const commandPath = join(context.root, 'export-command.json');
    privateCanonicalCommand(commandPath, command);
    await exportReviewerQueryAudit(context.config, commandPath, context.output, {
      now: () => observedAt,
    });
    unlinkSync(context.output);
    revokeOperatorOwner(context, plus(observedAt, 1));

    await expect(
      exportReviewerQueryAudit(context.config, commandPath, context.output, {
        now: () => plus(observedAt, 60 * 60 * 1000),
      }),
    ).rejects.toThrow('exact current active owner');
    expect(existsSync(context.output)).toBe(false);
  });

  it('denies an already-present reviewer export when its owner was revoked after first delivery', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const command: ReviewerQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-reviewer-query-audit-export-command',
      command_id: `qac_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded auditor export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: reviewerQueryAuditOutputPathSha256(context.output),
    };
    const commandPath = join(context.root, 'export-command.json');
    privateCanonicalCommand(commandPath, command);
    const first = await exportReviewerQueryAudit(
      context.config,
      commandPath,
      context.output,
      { now: () => observedAt },
    );
    const retainedBytes = readFileSync(context.output);
    revokeOperatorOwner(context, plus(observedAt, 1));

    await expect(
      exportReviewerQueryAudit(context.config, commandPath, context.output, {
        now: () => plus(observedAt, 60 * 60 * 1000),
      }),
    ).rejects.toThrow('exact current active owner');
    // The pre-existing file may represent prior possession, but this invocation
    // received neither a success status nor a newly authorized disclosure.
    expect(first.delivery_status).toBe('written');
    expect(readFileSync(context.output)).toEqual(retainedBytes);
  });

  it('runs expiry without a caller cutoff and exact-retries its stored receipt', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const command: ReviewerQueryAuditExpiryCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-reviewer-query-audit-expiry-command',
      command_id: `qac_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'scheduled retention expiry',
    };
    const commandPath = join(context.root, 'expiry-command.json');
    privateCanonicalCommand(commandPath, command);
    const first = await expireReviewerQueryAudit(context.config, commandPath, {
      now: () => observedAt,
    });
    const retry = await expireReviewerQueryAudit(context.config, commandPath, {
      now: () => plus(observedAt, 24 * 60 * 60 * 1000),
    });
    expect(retry).toEqual(first);
    const detail = JSON.parse(first.control_event.detail_json) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ cutoff: observedAt, row_count: 0 });
    expect(Object.keys(command)).not.toContain('cutoff');
  });
});

describe('readable-search query-audit stopped operator commands', () => {
  it('routes both noun-first commands through the CLI only with their exact flags', async () => {
    const context = await operatorFixture();
    const now = new Date().toISOString();
    const output = join(context.root, 'cli-readable-search-audit.json');
    const exportCommand: ReadableSearchQueryAuditExportCommandV1 = {
      schema_version: 1, kind: 'echo-authority-readable-search-query-audit-export-command', command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id, organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id, owner_membership_id: context.owner.membership_id,
      requested_at: now, reason: 'cli readable audit export', from_inclusive: plus(now, -60_000), until_exclusive: now,
      output_path_sha256: readableSearchQueryAuditOutputPathSha256(output),
    };
    const exportPath = join(context.root, 'cli-readable-export.json'); privateCanonicalCommand(exportPath, exportCommand);
    const stdout: string[] = []; const stderr: string[] = [];
    const io = { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) };
    expect(await runOrganizationAuthorityCli(['readable-search-query-audit-export', '--config', context.config, '--command', exportPath, '--output', output], {}, io)).toBe(0);
    expect(stdout).toHaveLength(1); expect(stderr).toEqual([]);
    await expect(runOrganizationAuthorityCli(['readable-search-query-audit-export', '--config', context.config, '--command', exportPath], {}, io)).rejects.toThrow('usage:');
    const expiryCommand: ReadableSearchQueryAuditExpiryCommandV1 = {
      schema_version: 1, kind: 'echo-authority-readable-search-query-audit-expiry-command', command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id, organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id, owner_membership_id: context.owner.membership_id,
      requested_at: new Date().toISOString(), reason: 'cli readable audit expiry',
    };
    const expiryPath = join(context.root, 'cli-readable-expiry.json'); privateCanonicalCommand(expiryPath, expiryCommand);
    expect(await runOrganizationAuthorityCli(['readable-search-query-audit-expire', '--config', context.config, '--command', expiryPath], {}, io)).toBe(0);
    expect(stdout).toHaveLength(2);
  });

  it('requires the signed output path and publishes exact create-once 0600 bytes', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const output = join(context.root, 'readable-search-query-audit.json');
    const command: ReadableSearchQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-readable-search-query-audit-export-command',
      command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded readable audit export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: readableSearchQueryAuditOutputPathSha256(output),
    };
    const commandPath = join(context.root, 'readable-export-command.json');
    privateCanonicalCommand(commandPath, command);
    await expect(exportReadableSearchQueryAudit(context.config, commandPath, context.output, { now: () => observedAt })).rejects.toThrow('does not match the signed command');
    const first = await exportReadableSearchQueryAudit(context.config, commandPath, output, { now: () => observedAt });
    expect(first.delivery_status).toBe('written');
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output)).toEqual(readableSearchQueryAuditExportBytes(readableSearchQueryAuditExportDocument(command, [])));
    const retry = await exportReadableSearchQueryAudit(context.config, commandPath, output, { now: () => plus(observedAt, 60 * 60 * 1000) });
    expect(retry).toEqual({ control_event: first.control_event, delivery_status: 'already_present' });
    privateCanonicalCommand(commandPath, { ...command, reason: 'different command bytes' });
    await expect(exportReadableSearchQueryAudit(context.config, commandPath, output, { now: () => plus(observedAt, 90 * 60 * 1000) })).rejects.toThrow('different command bytes');
    privateCanonicalCommand(commandPath, command);
    writeFileSync(output, 'different retained bytes');
    chmodSync(output, 0o600);
    const unavailable = await exportReadableSearchQueryAudit(context.config, commandPath, output, { now: () => plus(observedAt, 2 * 60 * 60 * 1000) });
    expect(unavailable).toEqual({ control_event: first.control_event, delivery_status: 'unavailable' });
    expect(readFileSync(output, 'utf8')).toBe('different retained bytes');
  });

  it('does not republish a deleted readable-search export when its owner was revoked after the first export', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const output = join(context.root, 'readable-search-query-audit.json');
    const command: ReadableSearchQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-readable-search-query-audit-export-command',
      command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded readable audit export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: readableSearchQueryAuditOutputPathSha256(output),
    };
    const commandPath = join(context.root, 'readable-export-command.json');
    privateCanonicalCommand(commandPath, command);
    await exportReadableSearchQueryAudit(context.config, commandPath, output, {
      now: () => observedAt,
    });
    unlinkSync(output);
    revokeOperatorOwner(context, plus(observedAt, 1));

    await expect(
      exportReadableSearchQueryAudit(context.config, commandPath, output, {
        now: () => plus(observedAt, 60 * 60 * 1000),
      }),
    ).rejects.toThrow('exact current active owner');
    expect(existsSync(output)).toBe(false);
  });

  it('denies an already-present readable-search export when its owner was revoked after first delivery', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const output = join(context.root, 'readable-search-query-audit.json');
    const command: ReadableSearchQueryAuditExportCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-readable-search-query-audit-export-command',
      command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'bounded readable audit export',
      from_inclusive: plus(observedAt, -24 * 60 * 60 * 1000),
      until_exclusive: observedAt,
      output_path_sha256: readableSearchQueryAuditOutputPathSha256(output),
    };
    const commandPath = join(context.root, 'readable-export-command.json');
    privateCanonicalCommand(commandPath, command);
    const first = await exportReadableSearchQueryAudit(
      context.config,
      commandPath,
      output,
      { now: () => observedAt },
    );
    const retainedBytes = readFileSync(output);
    revokeOperatorOwner(context, plus(observedAt, 1));

    await expect(
      exportReadableSearchQueryAudit(context.config, commandPath, output, {
        now: () => plus(observedAt, 60 * 60 * 1000),
      }),
    ).rejects.toThrow('exact current active owner');
    // Existing bytes can evidence prior possession only. This call was denied.
    expect(first.delivery_status).toBe('written');
    expect(readFileSync(output)).toEqual(retainedBytes);
  });

  it('has no caller cutoff and exact-retries expiry', async () => {
    const context = await operatorFixture();
    const observedAt = plus(context.last_observed_at, 1);
    const command: ReadableSearchQueryAuditExpiryCommandV1 = {
      schema_version: 1,
      kind: 'echo-authority-readable-search-query-audit-expiry-command',
      command_id: `sqa_${randomUUID()}`,
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      owner_principal_id: context.owner.principal_id,
      owner_membership_id: context.owner.membership_id,
      requested_at: observedAt,
      reason: 'scheduled readable retention expiry',
    };
    const commandPath = join(context.root, 'readable-expiry-command.json');
    privateCanonicalCommand(commandPath, command);
    const first = await expireReadableSearchQueryAudit(context.config, commandPath, { now: () => observedAt });
    const retry = await expireReadableSearchQueryAudit(context.config, commandPath, { now: () => plus(observedAt, 24 * 60 * 60 * 1000) });
    expect(retry).toEqual(first);
    expect(Object.keys(command)).not.toContain('cutoff');
    expect(JSON.parse(first.control_event.detail_json)).toMatchObject({ cutoff: observedAt, row_count: 0 });
  });
});
