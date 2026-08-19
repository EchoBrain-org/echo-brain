import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GranolaApiClient,
  GranolaListParams,
  GranolaNoteDetail,
} from '../../../src/processing/adapters/meeting-sources/granola/index.js';
import { runOneAuthorityMeeting } from '../../../src/processing/live/run-one-meeting.js';
import {
  SqliteAuthorityProcessingStore,
  type AuthorityProcessingStoreBinding,
} from '../../../src/processing/storage/sqlite-authority-processing-store.js';

const directories: string[] = [];
const NOW = '2026-08-19T20:00:00.000Z';
const OWNER_EMAIL = 'founder@example.com';
const APPROVED_OWNER_EMAIL_SHA256: `sha256:${string}` =
  'sha256:35531035dc0c4138b65e3400b53734e8bfa6b52c540dba3b1555493c028d2416';
const DIFFERENT_OWNER_EMAIL_SHA256: `sha256:${string}` =
  'sha256:d1c93db2e577c8fe90d8ad1ca066ca481ebe50f6ad34cf63c453c0008629d830';
const CREDENTIAL = `grn_${'g'.repeat(36)}`;
const CREDENTIAL_REFERENCE =
  'aws-secrets-manager:us-west-2:echo/org1-prod/granola-organization-source:SecretString:api_key';
const BINDING: AuthorityProcessingStoreBinding = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  membership_type: 'employee',
  source_adapter_id: 'granola',
  source_instance_id: 'founder-canary',
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setupDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-one-meeting-'));
  directories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const bootstrap = new SqliteAuthorityProcessingStore(path, BINDING, {
    bindingMode: 'provision',
  });
  bootstrap.close();
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(`
    INSERT INTO authority_metadata (
      singleton, authority_id, organization_id, organization_display_name,
      authority_pin_sha256, descriptor_json, created_at, last_observed_at
    ) VALUES (
      1,
      'oau_00000000-0000-4000-8000-000000000001',
      '${BINDING.organization_id}',
      'One Meeting Company',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '{}', '${NOW}', '${NOW}'
    );
    INSERT INTO authority_principals (
      principal_id, organization_id, display_name, provisioned_at
    ) VALUES (
      '${BINDING.principal_id}', '${BINDING.organization_id}', 'Founder',
      '${NOW}'
    );
    INSERT INTO authority_memberships (
      membership_id, organization_id, principal_id, membership_type,
      status, provisioned_at, revoked_at, revocation_reason,
      admin_command_id, admin_command_sha256
    ) VALUES (
      '${BINDING.membership_id}', '${BINDING.organization_id}',
      '${BINDING.principal_id}', '${BINDING.membership_type}', 'active',
      '${NOW}', NULL, NULL,
      'adm_00000000-0000-4000-8000-000000000001',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
  `);
  database.close();
  return path;
}

const NOTE: GranolaNoteDetail = {
  id: 'canary-note',
  object: 'note',
  title: 'Founder canary',
  owner: { email: OWNER_EMAIL },
  created_at: '2026-08-19T19:00:00.000Z',
  updated_at: '2026-08-19T19:30:00.000Z',
  summary_text: 'Decision: keep the server batch bounded.',
  transcript: [
    {
      text: 'Decision: keep the server batch bounded.',
      speaker: { email: OWNER_EMAIL },
    },
  ],
};

class OneNoteGranolaClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  async listNotes(params: GranolaListParams) {
    this.listCalls.push(params);
    return {
      notes: [
        {
          id: NOTE.id,
          owner: NOTE.owner,
          created_at: NOTE.created_at,
          updated_at: NOTE.updated_at,
        },
      ],
      hasMore: true,
      cursor: 'next-page',
    };
  }

  async getNote(noteId: string) {
    this.detailCalls.push(noteId);
    return NOTE;
  }
}

class EmptyPageGranolaClient implements GranolaApiClient {
  readonly listCalls: GranolaListParams[] = [];
  readonly detailCalls: string[] = [];

  constructor(
    private readonly hasMore: boolean,
    private readonly cursor: string | null,
  ) {}

  async listNotes(params: GranolaListParams) {
    this.listCalls.push(params);
    return { notes: [], hasMore: this.hasMore, cursor: this.cursor };
  }

  async getNote(noteId: string): Promise<GranolaNoteDetail> {
    this.detailCalls.push(noteId);
    throw new Error('empty Granola page must not fetch note detail');
  }
}

function rowCount(database: Database.Database, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

describe('runOneAuthorityMeeting', () => {
  it('admits at most one owner meeting as pending and converges on retry', async () => {
    const databasePath = setupDatabase();
    const firstClient = new OneNoteGranolaClient();
    let ids = 0;
    const first = await runOneAuthorityMeeting(
      {
        database_path: databasePath,
        binding: BINDING,
        source_instance_id: BINDING.source_instance_id,
        owner_email: OWNER_EMAIL,
        approved_owner_email_sha256:
          APPROVED_OWNER_EMAIL_SHA256,
        granola_credential: CREDENTIAL,
        credential_scope: 'organization',
        credential_reference: CREDENTIAL_REFERENCE,
        decision_processor_instance_id: 'founder-structured-text',
      },
      {
        granola_client: firstClient,
        now: () => NOW,
        create_id: () => `one-meeting-${++ids}`,
      },
    );

    expect(first).toMatchObject({
      outcome: 'pending_created',
      source_binding: {
        owner: 'provisioned',
        configuration: 'provisioned',
      },
      ok: true,
      meetings_seen: 1,
      meetings_processed: 0,
      meetings_pending: 1,
      deliveries: 0,
      cursor_advanced: false,
      failure_count: 0,
    });
    expect(first.pending_approval_ids).toHaveLength(1);
    expect(firstClient.listCalls).toEqual([{ page_size: 1 }]);
    expect(firstClient.detailCalls).toEqual([NOTE.id]);

    const database = new Database(databasePath, { readonly: true });
    expect(rowCount(database, 'authority_processing_candidates')).toBe(1);
    expect(
      rowCount(
        database,
        'authority_processing_source_configuration_bindings',
      ),
    ).toBe(1);
    expect(rowCount(database, 'authority_processing_slots')).toBe(2);
    expect(rowCount(database, 'authority_processing_resolutions')).toBe(0);
    expect(rowCount(database, 'authority_processing_delivery_receipts')).toBe(0);
    expect(rowCount(database, 'authority_processing_source_cursors')).toBe(0);
    database.close();

    const retryClient = new OneNoteGranolaClient();
    const retried = await runOneAuthorityMeeting(
      {
        database_path: databasePath,
        binding: BINDING,
        source_instance_id: BINDING.source_instance_id,
        owner_email: OWNER_EMAIL,
        approved_owner_email_sha256:
          APPROVED_OWNER_EMAIL_SHA256,
        granola_credential: CREDENTIAL,
        credential_scope: 'organization',
        credential_reference: CREDENTIAL_REFERENCE,
        decision_processor_instance_id: 'founder-structured-text',
      },
      {
        granola_client: retryClient,
        now: () => NOW,
        create_id: () => `retry-${++ids}`,
      },
    );

    expect(retried).toMatchObject({
      outcome: 'pending_exists',
      source_binding: {
        owner: 'existing',
        configuration: 'existing',
      },
      ok: true,
      meetings_seen: 0,
      meetings_processed: 0,
      meetings_pending: 1,
      deliveries: 0,
      cursor_advanced: false,
      failure_count: 0,
    });
    expect(retried.pending_approval_ids).toEqual(first.pending_approval_ids);
    expect(retryClient.listCalls).toEqual([]);
    expect(retryClient.detailCalls).toEqual([]);
    const afterRetry = new Database(databasePath, { readonly: true });
    expect(rowCount(afterRetry, 'authority_processing_candidates')).toBe(1);
    expect(rowCount(afterRetry, 'authority_processing_slots')).toBe(2);
    afterRetry.close();

    const serialized = JSON.stringify(first);
    for (const secretOrContent of [
      CREDENTIAL,
      OWNER_EMAIL,
      NOTE.id,
      NOTE.title,
      NOTE.summary_text,
      NOTE.transcript![0]!.text,
    ]) {
      expect(serialized).not.toContain(secretOrContent);
    }
  });

  it('rejects source identity drift before another provider contact', async () => {
    const databasePath = setupDatabase();
    const firstClient = new OneNoteGranolaClient();
    await runOneAuthorityMeeting(
      {
        database_path: databasePath,
        binding: BINDING,
        source_instance_id: BINDING.source_instance_id,
        owner_email: OWNER_EMAIL,
        approved_owner_email_sha256:
          APPROVED_OWNER_EMAIL_SHA256,
        granola_credential: CREDENTIAL,
        credential_scope: 'organization',
        credential_reference: CREDENTIAL_REFERENCE,
        decision_processor_instance_id: 'founder-structured-text',
      },
      { granola_client: firstClient, now: () => NOW },
    );

    const driftedClient = new OneNoteGranolaClient();
    const differentEmail = 'different@example.com';
    await expect(
      runOneAuthorityMeeting(
        {
          database_path: databasePath,
          binding: BINDING,
          source_instance_id: BINDING.source_instance_id,
          owner_email: differentEmail,
          approved_owner_email_sha256:
            DIFFERENT_OWNER_EMAIL_SHA256,
          granola_credential: CREDENTIAL,
          credential_scope: 'organization',
          credential_reference: CREDENTIAL_REFERENCE,
          decision_processor_instance_id: 'founder-structured-text',
        },
        { granola_client: driftedClient, now: () => NOW },
      ),
    ).rejects.toThrow(
      'source configuration differs from its immutable binding',
    );
    expect(driftedClient.listCalls).toEqual([]);
    expect(driftedClient.detailCalls).toEqual([]);
  });

  it('advances through an empty provider page and resumes from its cursor', async () => {
    const databasePath = setupDatabase();
    const firstClient = new EmptyPageGranolaClient(true, 'next-page');
    const input = {
      database_path: databasePath,
      binding: BINDING,
      source_instance_id: BINDING.source_instance_id,
      owner_email: OWNER_EMAIL,
      approved_owner_email_sha256:
        APPROVED_OWNER_EMAIL_SHA256,
      granola_credential: CREDENTIAL,
      credential_scope: 'organization' as const,
      credential_reference: CREDENTIAL_REFERENCE,
      decision_processor_instance_id: 'founder-structured-text',
    };

    const first = await runOneAuthorityMeeting(input, {
      granola_client: firstClient,
      now: () => NOW,
    });

    expect(first).toMatchObject({
      outcome: 'no_meeting',
      source_binding: {
        owner: 'provisioned',
        configuration: 'provisioned',
      },
      ok: true,
      meetings_seen: 0,
      meetings_pending: 0,
      deliveries: 0,
      cursor_advanced: true,
      failure_count: 0,
    });
    expect(first.pending_approval_ids).toEqual([]);
    expect(firstClient.listCalls).toEqual([{ page_size: 1 }]);
    expect(firstClient.detailCalls).toEqual([]);

    const database = new Database(databasePath, { readonly: true });
    expect(rowCount(database, 'authority_processing_source_cursors')).toBe(1);
    database.close();

    const secondClient = new EmptyPageGranolaClient(false, null);
    const second = await runOneAuthorityMeeting(input, {
      granola_client: secondClient,
      now: () => NOW,
    });

    expect(second).toMatchObject({
      outcome: 'no_meeting',
      source_binding: {
        owner: 'existing',
        configuration: 'existing',
      },
      ok: true,
      meetings_seen: 0,
      meetings_pending: 0,
      deliveries: 0,
      cursor_advanced: true,
      failure_count: 0,
    });
    expect(secondClient.listCalls).toEqual([
      { cursor: 'next-page', page_size: 1 },
    ]);
    expect(secondClient.detailCalls).toEqual([]);
  });
});
