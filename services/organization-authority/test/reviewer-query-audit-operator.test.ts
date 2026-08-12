import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import type {
  ReviewerQueryAuditExportCommandV1,
  ReviewerQueryAuditExpiryCommandV1,
} from '../src/application/reviewer-query-audit.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import {
  expireReviewerQueryAudit,
  exportReviewerQueryAudit,
  initializeDevelopmentAuthority,
} from '../src/composition/operator-state.js';
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
