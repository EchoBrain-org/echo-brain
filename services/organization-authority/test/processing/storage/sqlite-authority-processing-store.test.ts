import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../../src/processing/core/approval/approval-gate.js';
import type { DecisionSet } from '../../../src/processing/core/contracts/decision.js';
import type {
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../../src/processing/core/contracts/delivery.js';
import type { MeetingDocument } from '../../../src/processing/core/contracts/meeting.js';
import type {
  ApprovalDecisionStore,
  FrozenOrganizationMemberApprovalPresentationContract,
  FrozenSlackApprovalPresentationContract,
} from '../../../src/processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import type { FrozenOrganizationRecordEnvelopeStore } from '../../../src/processing/record/adapters/resolved-organization-record-act-writer.js';
import type { BuiltOrganizationRecordEnvelope } from '../../../src/processing/record/ports.js';
import type { SlackStoredDelivery } from '../../../src/processing/adapters/delivery-surfaces/slack/slack-delivery-receipt-store.js';
import {
  SqliteAuthorityProcessingStore,
  type AuthorityProcessingStoreBinding,
} from '../../../src/processing/storage/sqlite-authority-processing-store.js';

const directories: string[] = [];
const BINDING: AuthorityProcessingStoreBinding = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  membership_type: 'employee',
  source_adapter_id: 'source-alpha',
  source_instance_id: 'primary',
};
const SOURCE = {
  kind: 'meeting-source' as const,
  adapter_id: BINDING.source_adapter_id,
  instance_id: BINDING.source_instance_id,
  version: '1.0.0',
};
const PROCESSOR = {
  kind: 'decision-processor' as const,
  adapter_id: 'processor-alpha',
  instance_id: 'primary',
  version: '2.0.0',
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function meeting(index = 1): MeetingDocument {
  return {
    schema_version: 1,
    id: `meeting-${index}`,
    title: `Private meeting ${index}`,
    capture: {
      state: 'complete',
      components: [{ kind: 'transcript', state: 'available' }],
    },
    participants: [{ id: 'participant-1', display_name: 'Member' }],
    content: [
      {
        id: 'block-1',
        kind: 'transcript',
        text: `Decision evidence ${index}`,
      },
    ],
    artifacts: [],
    provenance: {
      source: SOURCE,
      external_id: `external-${index}`,
      canonical_revision: 'revision-1',
      observed_at: '2026-08-18T00:00:00.000Z',
      normalizer_version: '1.0.0',
    },
  };
}

function decisions(input: MeetingDocument, suffix = ''): DecisionSet {
  return {
    schema_version: 1,
    meeting_id: input.id,
    meeting_revision: input.provenance.canonical_revision,
    processor: PROCESSOR,
    generated_at: '2026-08-18T00:01:00.000Z',
    signals: [
      {
        id: `decision-${input.id}${suffix}`,
        kind: 'decision',
        text: `Keep the first bytes${suffix}`,
        subject: null,
        confidence: 1,
        status: 'decided',
        evidence: [{ meeting_id: input.id, block_id: 'block-1' }],
      },
    ],
  };
}

function brief(input: MeetingDocument, set: DecisionSet, id = 'brief-1'): DecisionBrief {
  return {
    schema_version: 1,
    id,
    meeting: {
      id: input.id,
      title: input.title,
      participants: input.participants,
    },
    decisions: set.signals.filter(
      (signal): signal is Extract<typeof signal, { kind: 'decision' }> =>
        signal.kind === 'decision',
    ),
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: set.meeting_revision,
      processor: set.processor,
      generated_at: set.generated_at,
    },
  };
}

function request(
  processingKey: string,
  input: MeetingDocument,
  set: DecisionSet,
  requestedAt: string,
  briefId = 'brief-1',
): ApprovalRequest {
  return {
    processing_key: processingKey,
    meeting: input,
    decisions: set,
    brief: brief(input, set, briefId),
    requested_at: requestedAt,
  };
}

const SHA256_A = `sha256:${'a'.repeat(64)}`;
const SHA256_B = `sha256:${'b'.repeat(64)}`;

function slackAttempt(
  idempotencyKey = 'delivery:test:slack:team-decisions',
): SlackStoredDelivery & { readonly status: 'unknown' } {
  return {
    schema_version: 1,
    record_type: 'echo-brain.slack-delivery',
    idempotency_key: idempotencyKey,
    status: 'unknown',
    channel_id: null,
    message_ts: null,
    recorded_at: '2026-08-18T00:02:00.000Z',
    message: 'Slack delivery outcome could not be confirmed',
  };
}

function slackDelivered(
  idempotencyKey = 'delivery:test:slack:team-decisions',
): SlackStoredDelivery & { readonly status: 'delivered' } {
  return {
    schema_version: 1,
    record_type: 'echo-brain.slack-delivery',
    idempotency_key: idempotencyKey,
    status: 'delivered',
    channel_id: 'C123',
    message_ts: '1700.100000',
    recorded_at: '2026-08-18T00:02:00.000Z',
  };
}

function reviewerPresentationContract(
  overrides: Partial<FrozenSlackApprovalPresentationContract> = {},
): FrozenSlackApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'restricted-reviewer-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'team-decisions',
    adapter_version: '1.0.0',
    channel_id: 'C123',
    reviewer_slack_user_id: 'U123',
    reviewer_name: 'Reviewer',
    credential_ref: 'file:/private/slack-token',
    credential_fingerprint_sha256: SHA256_A,
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    reviewer_release_draft_sha256: SHA256_A,
    approval_presentation_sha256: SHA256_B,
    ...overrides,
  };
}

function organizationMemberPresentationContract(): FrozenOrganizationMemberApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'organization-member-readable-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'team-decisions',
    adapter_version: '1.0.0',
    channel_id: 'C123',
    reviewer_slack_user_id: 'U123',
    reviewer_name: 'Reviewer',
    credential_ref: 'file:/private/slack-token',
    credential_fingerprint_sha256: SHA256_A,
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: SHA256_A,
    release_draft_sha256: SHA256_A,
    approval_presentation_sha256: SHA256_B,
  };
}

function signedRecordEnvelope(
  approvalId: string,
  envelopeId = 'rec_00000000-0000-4000-8000-000000000001',
  signature = 'signed-envelope-bytes',
  eventType: 'approval' | 'rejection' = 'approval',
): BuiltOrganizationRecordEnvelope {
  return {
    envelope_id: envelopeId,
    idempotency_key: approvalId,
    event_type: eventType,
    envelope: {
      schema_version: eventType === 'approval' ? 3 : 1,
      kind: 'echo-organization-record-envelope',
      envelope_id: envelopeId,
      idempotency_key: approvalId,
      event_type: eventType,
      integrity: { signature_der_base64: signature },
    } as unknown as BuiltOrganizationRecordEnvelope['envelope'],
  };
}

function setup(now = '2026-08-18T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-processing-'));
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
      'Processing Company',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '{}',
      '2026-08-18T00:00:00.000Z',
      '2026-08-18T00:00:00.000Z'
    );
    INSERT INTO authority_principals (
      principal_id, organization_id, display_name, provisioned_at
    ) VALUES (
      '${BINDING.principal_id}', '${BINDING.organization_id}', 'Member',
      '2026-08-18T00:00:00.000Z'
    );
    INSERT INTO authority_memberships (
      membership_id, organization_id, principal_id, membership_type,
      status, provisioned_at, revoked_at, revocation_reason,
      admin_command_id, admin_command_sha256
    ) VALUES (
      '${BINDING.membership_id}', '${BINDING.organization_id}',
      '${BINDING.principal_id}', '${BINDING.membership_type}', 'active',
      '2026-08-18T00:00:00.000Z', NULL, NULL,
      'adm_00000000-0000-4000-8000-000000000001',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
  `);
  database.close();
  let current = now;
  const create = () =>
    new SqliteAuthorityProcessingStore(path, BINDING, {
      bindingMode: 'provision',
      fileMustExist: true,
      now: () => current,
    });
  return {
    path,
    create,
    setNow(value: string) {
      current = value;
    },
  };
}

async function resolvedRecordFixture(status: 'approved' | 'rejected' = 'approved') {
  const context = setup();
  const store = context.create();
  const input = meeting();
  const set = decisions(input);
  const processingKey = `recovery-record-${Math.random()}`;
  await store.admitAndSaveMeeting(input, processingKey);
  await store.saveDecisionSet(processingKey, input, set);
  const staged = await store.ensureRequested(
    request(processingKey, input, set, '2026-08-18T00:01:00.000Z', 'recovery-brief'),
  );
  await store.resolve({
    approvalId: staged.approval_id,
    status,
    reviewedBy: 'Reviewer',
    surface: 'slack-authority-v1',
    metadata: {},
    reviewedAt: '2026-08-18T00:02:00.000Z',
  });
  return { context, store, processingKey, approvalId: staged.approval_id };
}

function revokeSourceCustodian(path: string): void {
  const revoke = new Database(path);
  revoke
    .prepare(
      `UPDATE authority_memberships
          SET status = 'revoked', revoked_at = ?, revocation_reason = ?
        WHERE membership_id = ?`,
    )
    .run(
      '2026-08-18T00:03:00.000Z',
      'source custody ended after terminal resolution',
      BINDING.membership_id,
    );
  revoke.close();
}

function setMemberExclusionFixture(
  path: string,
  selector:
    | {
        readonly scope: 'source';
        readonly source_adapter_id: string;
        readonly source_instance_id: string;
      }
    | {
        readonly scope: 'meeting';
        readonly source_adapter_id: string;
        readonly source_instance_id: string;
        readonly external_id: string;
      },
  excluded: boolean,
): void {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  const externalId = selector.scope === 'source' ? '' : selector.external_id;
  if (excluded) {
    database
      .prepare(
        `INSERT INTO authority_processing_member_exclusions (
           organization_id, principal_id, membership_id, membership_type,
           source_adapter_id, source_instance_id, scope_kind, external_id,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (
           membership_id, source_adapter_id, source_instance_id,
           scope_kind, external_id
         ) DO NOTHING`,
      )
      .run(
        BINDING.organization_id,
        BINDING.principal_id,
        BINDING.membership_id,
        BINDING.membership_type,
        selector.source_adapter_id,
        selector.source_instance_id,
        selector.scope,
        externalId,
        '2026-08-18T00:00:00.000Z',
      );
  } else {
    database
      .prepare(
        `DELETE FROM authority_processing_member_exclusions
          WHERE membership_id = ? AND source_adapter_id = ?
            AND source_instance_id = ? AND scope_kind = ? AND external_id = ?`,
      )
      .run(
        BINDING.membership_id,
        selector.source_adapter_id,
        selector.source_instance_id,
        selector.scope,
        externalId,
      );
  }
  database.close();
}

describe('SqliteAuthorityProcessingStore', () => {
  it('atomically activates one exact live source and returns the persisted cursor on retry', async () => {
    const context = setup();
    const sourceConfiguration = {
      owner_email_sha256: `sha256:${'c'.repeat(64)}` as const,
      credential_scope: 'organization' as const,
      credential_reference_sha256: `sha256:${'d'.repeat(64)}` as const,
    };
    const first = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
      now: () => '2026-08-18T04:00:00.000Z',
    });
    const cursor = 'live-only-cursor';
    await expect(first.activateLiveSource(SOURCE, (at) => {
      expect(at).toBe('2026-08-18T04:00:00.000Z');
      return cursor;
    }, (value) => expect(value).toBe(cursor))).resolves.toMatchObject({
      outcome: 'activated', cursor,
      source_binding: { owner_binding: 'provisioned', configuration_binding: 'provisioned' },
    });
    first.close();

    const retried = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
      now: () => { throw new Error('must not sample a second cutoff'); },
    });
    await expect(retried.activateLiveSource(SOURCE, () => {
      throw new Error('must not create a second cursor');
    }, (value) => expect(value).toBe(cursor))).resolves.toMatchObject({
      outcome: 'already_activated', cursor,
      source_binding: { owner_binding: 'existing', configuration_binding: 'existing' },
    });
    retried.close();
  });

  it('refuses changed source ownership or unfinished historical state during activation', async () => {
    const context = setup();
    const sourceConfiguration = {
      owner_email_sha256: `sha256:${'c'.repeat(64)}` as const,
      credential_scope: 'organization' as const,
      credential_reference_sha256: `sha256:${'d'.repeat(64)}` as const,
    };
    const first = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
    });
    await first.initialize();
    await first.admitAndSaveMeeting(meeting(), 'unfinished-before-activation');
    first.close();
    const activation = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
    });
    await expect(activation.activateLiveSource(SOURCE, () => 'cursor', () => undefined)).rejects.toThrow('zero unfinished candidates');
    activation.close();
  });

  it('rolls back activation when an existing cursor is not live-only', async () => {
    const context = setup();
    const sourceConfiguration = {
      owner_email_sha256: `sha256:${'c'.repeat(64)}` as const,
      credential_scope: 'organization' as const,
      credential_reference_sha256: `sha256:${'d'.repeat(64)}` as const,
    };
    const seeded = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
    });
    await seeded.initialize();
    await seeded.setSourceCursor(SOURCE, 'initial-history-pagination-cursor');
    seeded.close();
    const activation = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', sourceConfiguration, fileMustExist: true,
    });
    await expect(activation.activateLiveSource(SOURCE, () => 'new-live-cursor', () => {
      throw new Error('not a live-only cursor');
    })).rejects.toThrow('not a live-only cursor');
    activation.close();
    const database = new Database(context.path, { readonly: true });
    expect(database.prepare(
      'SELECT cursor FROM authority_processing_source_cursors',
    ).get()).toEqual({ cursor: 'initial-history-pagination-cursor' });
    database.close();
  });

  it('rolls back a missing configuration when prior source state exists', async () => {
    const context = setup();
    const seeded = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision', fileMustExist: true,
    });
    await seeded.initialize();
    await seeded.setSourceCursor(SOURCE, 'unconfigured-source-state');
    seeded.close();
    const activation = new SqliteAuthorityProcessingStore(context.path, BINDING, {
      bindingMode: 'provision',
      sourceConfiguration: {
        owner_email_sha256: `sha256:${'c'.repeat(64)}`,
        credential_scope: 'organization',
        credential_reference_sha256: `sha256:${'d'.repeat(64)}`,
      },
      fileMustExist: true,
    });
    await expect(activation.activateLiveSource(SOURCE, () => 'new-live-cursor', () => undefined)).rejects.toThrow(
      'cannot be retroactively bound',
    );
    activation.close();
    const database = new Database(context.path, { readonly: true });
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM authority_processing_source_configuration_bindings',
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it('atomically claims Slack delivery once across independent store handles', async () => {
    const context = setup();
    const first = context.create();
    const second = context.create();
    const attempt = slackAttempt();

    const [firstClaim, secondClaim] = await Promise.all([
      first.claim(attempt),
      second.claim(attempt),
    ]);

    expect(firstClaim).toEqual({ kind: 'claimed' });
    expect(secondClaim).toEqual({ kind: 'existing', record: attempt });
    const database = new Database(context.path, { readonly: true });
    expect(
      database
        .prepare(
          `SELECT idempotency_key, status, channel_id, message_ts, message
             FROM authority_processing_slack_delivery_attempts`,
        )
        .all(),
    ).toEqual([
      {
        idempotency_key: attempt.idempotency_key,
        status: 'unknown',
        channel_id: null,
        message_ts: null,
        message: attempt.message,
      },
    ]);
    database.close();
    first.close();
    second.close();
  });

  it('recovers unknown and delivered Slack outcomes across store restarts', async () => {
    const context = setup();
    const attempt = slackAttempt();
    const delivered = slackDelivered();
    const first = context.create();
    await expect(first.claim(attempt)).resolves.toEqual({ kind: 'claimed' });
    first.close();

    const second = context.create();
    await expect(second.claim(attempt)).resolves.toEqual({
      kind: 'existing',
      record: attempt,
    });
    await second.recordOutcome(delivered);
    await second.recordOutcome(delivered);
    second.close();

    const restarted = context.create();
    await expect(restarted.claim(attempt)).resolves.toEqual({
      kind: 'existing',
      record: delivered,
    });
    await expect(
      restarted.clearAttempt(attempt.idempotency_key),
    ).rejects.toThrow('not an active unknown claim');
    await expect(
      restarted.recordOutcome({ ...delivered, message_ts: '1700.200000' }),
    ).rejects.toThrow('conflicts with durable state');
    restarted.close();
  });

  it('finishes an initialized Slack attempt after its source custodian is revoked', async () => {
    const context = setup();
    const store = context.create();
    const attempt = slackAttempt('delivery:test:revoked-after-claim');
    const delivered = slackDelivered(attempt.idempotency_key);
    await expect(store.claim(attempt)).resolves.toEqual({ kind: 'claimed' });

    const revoke = new Database(context.path);
    revoke.pragma('foreign_keys = ON');
    revoke
      .prepare(
        `UPDATE authority_memberships
            SET status = 'revoked', revoked_at = ?, revocation_reason = ?
          WHERE membership_id = ?`,
      )
      .run(
        '2026-08-18T00:03:00.000Z',
        'source custody ended after approval',
        BINDING.membership_id,
      );
    revoke.close();

    await expect(store.recordOutcome(delivered)).resolves.toBeUndefined();
    await expect(store.claim(attempt)).resolves.toEqual({
      kind: 'existing',
      record: delivered,
    });
    await expect(store.healthCheck()).resolves.toBeUndefined();
    store.close();
  });

  it('clears only a known-no-write unknown attempt and permits a fresh claim', async () => {
    const context = setup();
    const store = context.create();
    const attempt = slackAttempt('delivery:test:known-no-write');
    await store.healthCheck();
    await expect(store.claim(attempt)).resolves.toEqual({ kind: 'claimed' });
    await store.clearAttempt(attempt.idempotency_key);
    await expect(store.claim(attempt)).resolves.toEqual({ kind: 'claimed' });
    store.close();
  });

  it('requires an existing exact binding without claiming unknown or cross-owned sources', async () => {
    const context = setup();
    const owner = context.create();
    await owner.initialize();

    const unknown = new SqliteAuthorityProcessingStore(
      context.path,
      { ...BINDING, source_instance_id: 'unknown' },
      { bindingMode: 'require-existing', fileMustExist: true },
    );
    await expect(unknown.initialize()).rejects.toThrow(
      'not bound to the exact active membership',
    );
    unknown.close();

    const database = new Database(context.path);
    database.pragma('foreign_keys = ON');
    database.exec(`
      INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES (
        'prn_00000000-0000-4000-8000-000000000002',
        '${BINDING.organization_id}', 'Other Member',
        '2026-08-18T00:00:00.000Z'
      );
      INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type,
        status, provisioned_at, revoked_at, revocation_reason,
        admin_command_id, admin_command_sha256
      ) VALUES (
        'mem_00000000-0000-4000-8000-000000000002',
        '${BINDING.organization_id}',
        'prn_00000000-0000-4000-8000-000000000002', 'employee', 'active',
        '2026-08-18T00:00:00.000Z', NULL, NULL,
        'adm_00000000-0000-4000-8000-000000000002',
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      );
    `);
    database.close();

    const crossOwner = new SqliteAuthorityProcessingStore(
      context.path,
      {
        ...BINDING,
        principal_id: 'prn_00000000-0000-4000-8000-000000000002',
        membership_id: 'mem_00000000-0000-4000-8000-000000000002',
      },
      { bindingMode: 'require-existing', fileMustExist: true },
    );
    await expect(crossOwner.initialize()).rejects.toThrow(
      'not bound to the exact active membership',
    );
    crossOwner.close();

    const inspect = new Database(context.path, { readonly: true });
    expect(
      inspect
        .prepare(
          `SELECT source_adapter_id, source_instance_id, membership_id
             FROM authority_processing_source_owner_bindings`,
        )
        .all(),
    ).toEqual([
      {
        source_adapter_id: BINDING.source_adapter_id,
        source_instance_id: BINDING.source_instance_id,
        membership_id: BINDING.membership_id,
      },
    ]);
    inspect.close();
    owner.close();
  });

  it('keeps one exact source owner and fails reads/admission after owner revocation', async () => {
    const context = setup();
    const owner = context.create();
    await owner.initialize();
    await owner.admitAndSaveMeeting(meeting(1), 'owned-before-revocation');

    const database = new Database(context.path);
    database.pragma('foreign_keys = ON');
    database.exec(`
      INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES (
        'prn_00000000-0000-4000-8000-000000000002',
        '${BINDING.organization_id}', 'Other Member',
        '2026-08-18T00:00:00.000Z'
      );
      INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type,
        status, provisioned_at, revoked_at, revocation_reason,
        admin_command_id, admin_command_sha256
      ) VALUES (
        'mem_00000000-0000-4000-8000-000000000002',
        '${BINDING.organization_id}',
        'prn_00000000-0000-4000-8000-000000000002', 'employee', 'active',
        '2026-08-18T00:00:00.000Z', NULL, NULL,
        'adm_00000000-0000-4000-8000-000000000002',
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      );
    `);
    database.close();

    const other = new SqliteAuthorityProcessingStore(
      context.path,
      {
        ...BINDING,
        principal_id: 'prn_00000000-0000-4000-8000-000000000002',
        membership_id: 'mem_00000000-0000-4000-8000-000000000002',
      },
      { bindingMode: 'require-existing', fileMustExist: true },
    );
    await expect(other.initialize()).rejects.toThrow(
      'not bound to the exact active membership',
    );
    other.close();

    const revoke = new Database(context.path);
    revoke.pragma('foreign_keys = ON');
    revoke
      .prepare(
        `UPDATE authority_memberships
            SET status = 'revoked', revoked_at = ?, revocation_reason = ?
          WHERE membership_id = ?`,
      )
      .run(
        '2026-08-18T00:05:00.000Z',
        'membership ended',
        BINDING.membership_id,
      );
    revoke.close();
    await expect(
      owner.admitAndSaveMeeting(meeting(2), 'owned-after-revocation'),
    ).rejects.toThrow('not bound to the exact active membership');
    await expect(owner.getCandidate('owned-before-revocation')).rejects.toThrow(
      'not bound to the exact active membership',
    );
    owner.close();
  });

  it('keeps the first valid state across independent store handles', async () => {
    const context = setup();
    const first = context.create();
    const second = context.create();
    await Promise.all([first.initialize(), second.initialize()]);
    const input = meeting();
    const processingKey = 'processing-race';

    await expect(first.admitAndSaveMeeting(input, processingKey)).resolves.toBe(
      'saved',
    );
    await expect(second.admitAndSaveMeeting(input, processingKey)).resolves.toBe(
      'saved',
    );
    await expect(
      second.admitAndSaveMeeting(
        { ...input, title: 'Conflicting bytes' },
        processingKey,
      ),
    ).rejects.toThrow('different raw candidate');

    const set = decisions(input);
    await first.saveDecisionSet(processingKey, input, set);
    await second.saveDecisionSet(processingKey, input, set);
    const firstRequestId = await first.stageApprovalRequest(
      request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:00.000Z',
        'first-racing-brief',
      ),
    );
    const secondRequestId = await second.stageApprovalRequest(
      request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:01.000Z',
        'second-racing-brief',
      ),
    );
    expect(firstRequestId).toBe(secondRequestId);
    expect((await first.getCandidate(processingKey))?.first_request).toMatchObject({
      requested_at: '2026-08-18T00:01:00.000Z',
      brief: { id: 'first-racing-brief' },
    });

    const winner = {
      status: 'approved' as const,
      resolved_at: '2026-08-18T00:02:00.000Z',
      document: { status: 'approved', winner: 'first' },
    };
    const loser = {
      status: 'rejected' as const,
      resolved_at: '2026-08-18T00:02:01.000Z',
      document: { status: 'rejected', winner: 'second' },
    };
    await expect(first.resolveCandidate(processingKey, winner)).resolves.toBeUndefined();
    await expect(second.resolveCandidate(processingKey, loser)).rejects.toThrow(
      'different terminal resolution',
    );
    await expect(first.resolveCandidate(processingKey, winner)).resolves.toBeUndefined();
    await expect(second.resolveCandidate(processingKey, loser)).rejects.toThrow(
      'different terminal resolution',
    );
    first.close();
    second.close();
  });

  it('resumes an unprocessed candidate after a source adapter version upgrade', async () => {
    const context = setup();
    const store = context.create();
    const original = meeting();
    const upgraded: MeetingDocument = {
      ...original,
      provenance: {
        ...original.provenance,
        source: { ...original.provenance.source, version: '1.1.0' },
      },
    };
    const processingKey = 'source-version-upgrade';
    await store.initialize();
    await store.admitAndSaveMeeting(original, processingKey);
    await store.saveDecisionSet(processingKey, original, decisions(original));

    await expect(
      store.admitAndSaveMeeting(upgraded, processingKey),
    ).resolves.toBe('saved');
    await expect(
      store.getDecisionSet(processingKey, upgraded, PROCESSOR),
    ).resolves.toBeDefined();
    expect((await store.getCandidate(processingKey))?.meeting).toEqual(original);
    store.close();
  });

  it('resumes an unprocessed candidate after the source observes it again', async () => {
    const context = setup();
    const store = context.create();
    const original = meeting();
    const observedAgain: MeetingDocument = {
      ...original,
      provenance: {
        ...original.provenance,
        observed_at: '2026-08-18T00:05:00.000Z',
      },
    };
    const processingKey = 'source-observed-again';
    await store.initialize();
    await store.admitAndSaveMeeting(original, processingKey);
    await store.saveDecisionSet(processingKey, original, decisions(original));

    await expect(
      store.admitAndSaveMeeting(observedAgain, processingKey),
    ).resolves.toBe('saved');
    await expect(
      store.getDecisionSet(processingKey, observedAgain, PROCESSOR),
    ).resolves.toBeDefined();
    expect((await store.getCandidate(processingKey))?.meeting).toEqual(original);
    store.close();
  });

  it('enforces persisted exact source and meeting exclusions during first admission', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    const exact = {
      scope: 'meeting' as const,
      source_adapter_id: SOURCE.adapter_id,
      source_instance_id: SOURCE.instance_id,
      external_id: meeting(1).provenance.external_id,
    };
    setMemberExclusionFixture(context.path, exact, true);
    expect(await store.admitAndSaveMeeting(meeting(1), 'excluded-one')).toBe(
      'excluded',
    );
    expect(await store.admitAndSaveMeeting(meeting(2), 'saved-two')).toBe(
      'saved',
    );
    expect(await store.getCandidate('excluded-one')).toBeUndefined();
    expect(await store.getCandidate('saved-two')).toMatchObject({
      processing_key: 'saved-two',
      first_decision: null,
      first_request: null,
    });

    const wholeSource = {
      scope: 'source' as const,
      source_adapter_id: SOURCE.adapter_id,
      source_instance_id: SOURCE.instance_id,
    };
    setMemberExclusionFixture(context.path, wholeSource, true);
    expect(await store.admitAndSaveMeeting(meeting(3), 'excluded-three')).toBe(
      'excluded',
    );
    setMemberExclusionFixture(context.path, wholeSource, false);
    setMemberExclusionFixture(context.path, exact, false);

    const database = new Database(context.path, { readonly: true });
    const columns = database.pragma(
      'table_info(authority_processing_member_exclusions)',
    ) as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      'organization_id',
      'principal_id',
      'membership_id',
      'membership_type',
      'source_adapter_id',
      'source_instance_id',
      'scope_kind',
      'external_id',
      'created_at',
    ]);
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM authority_processing_candidates')
        .get(),
    ).toEqual({ count: 1 });
    database.close();
    store.close();
  });

  it('applies exclusions only to first admission and lets an admitted exact candidate continue', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    const first = meeting(1);
    const firstExclusion = {
      scope: 'meeting' as const,
      source_adapter_id: SOURCE.adapter_id,
      source_instance_id: SOURCE.instance_id,
      external_id: first.provenance.external_id,
    };

    setMemberExclusionFixture(context.path, firstExclusion, true);
    await expect(
      store.admitAndSaveMeeting(first, 'excluded-before-admission'),
    ).resolves.toBe('excluded');
    await expect(
      store.getCandidate('excluded-before-admission'),
    ).resolves.toBeUndefined();

    const second = meeting(2);
    await expect(
      store.admitAndSaveMeeting(second, 'admitted-before-exclusion'),
    ).resolves.toBe('saved');
    setMemberExclusionFixture(
      context.path,
      {
        ...firstExclusion,
        external_id: second.provenance.external_id,
      },
      true,
    );
    await expect(
      store.admitAndSaveMeeting(second, 'admitted-before-exclusion'),
    ).resolves.toBe('saved');
    await expect(
      store.getCandidate('admitted-before-exclusion'),
    ).resolves.toMatchObject({
      processing_key: 'admitted-before-exclusion',
      meeting: second,
    });
    await expect(
      store.saveDecisionSet(
        'admitted-before-exclusion',
        second,
        decisions(second),
      ),
    ).resolves.toBeUndefined();
    store.close();
  });

  it('retains pending and unresolved-delivery candidates, cleans only processed terminals after 30 days, and keeps markers', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    await store.admitAndSaveMeeting(meeting(1), 'processed-terminal');
    await store.resolveCandidate('processed-terminal', {
      status: 'rejected',
      resolved_at: '2026-08-18T00:00:00.000Z',
      document: { status: 'rejected' },
    });
    await store.markProcessed('processed-terminal');

    await store.admitAndSaveMeeting(meeting(2), 'pending-raw');
    await store.admitAndSaveMeeting(meeting(3), 'approved-unresolved-delivery');
    await store.resolveCandidate('approved-unresolved-delivery', {
      status: 'approved',
      resolved_at: '2026-08-18T00:00:00.000Z',
      document: { status: 'approved' },
    });

    expect(
      await store.cleanupTerminalCandidates({
        now: '2026-09-16T23:59:59.999Z',
      }),
    ).toEqual([]);
    expect(
      await store.cleanupTerminalCandidates({
        now: '2026-09-17T00:00:00.000Z',
      }),
    ).toEqual(['processed-terminal']);
    expect(await store.getCandidate('processed-terminal')).toBeUndefined();
    expect(await store.hasProcessed('processed-terminal')).toBe(true);
    expect(await store.getCandidate('pending-raw')).toBeDefined();
    expect(await store.getCandidate('approved-unresolved-delivery')).toBeDefined();
    await expect(
      store.cleanupTerminalCandidates({
        now: '2026-09-17T00:00:00.000Z',
        limit: 101,
      }),
    ).rejects.toThrow('1 through 100');
    store.close();
  });

  it('terminally skips a frozen empty decision set and hides an older pending request', async () => {
    const context = setup();
    const store = context.create();
    const input = meeting();
    const empty = { ...decisions(input), signals: [] };
    const processingKey = 'empty-decision-set';
    await store.initialize();
    await store.admitAndSaveMeeting(input, processingKey);
    await store.saveDecisionSet(processingKey, input, empty);
    await store.stageApprovalRequest(
      request(
        processingKey,
        input,
        empty,
        '2026-08-18T00:01:00.000Z',
      ),
    );
    await expect(store.markProcessed(processingKey)).resolves.toBeUndefined();
    await expect(store.markProcessed(processingKey)).resolves.toBeUndefined();
    expect(await store.hasProcessed(processingKey)).toBe(true);
    expect(await store.countUnfinishedCandidates()).toBe(0);
    expect(
      await store.cleanupTerminalCandidates({
        now: '2026-09-16T23:59:59.999Z',
      }),
    ).toEqual([]);
    expect(
      await store.cleanupTerminalCandidates({
        now: '2026-09-17T00:00:00.000Z',
      }),
    ).toEqual([processingKey]);
    expect(await store.getCandidate(processingKey)).toBeUndefined();
    expect(await store.hasProcessed(processingKey)).toBe(true);

    const unresolved = meeting(2);
    await store.admitAndSaveMeeting(unresolved, 'non-empty-unresolved');
    await store.saveDecisionSet(
      'non-empty-unresolved',
      unresolved,
      decisions(unresolved),
    );
    await expect(store.markProcessed('non-empty-unresolved')).rejects.toThrow(
      'terminal resolution or empty decision set',
    );
    store.close();
  });

  it('keeps content-free receipt observations so an unknown outcome can converge to delivered', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    const input = meeting();
    const set = decisions(input);
    const processingKey = 'receipt-convergence';
    await store.admitAndSaveMeeting(input, processingKey);
    await store.saveDecisionSet(processingKey, input, set);
    const envelope: DeliveryEnvelope = {
      schema_version: 1,
      id: 'envelope-1',
      idempotency_key: 'delivery-key-1',
      destination: {
        adapter_id: 'delivery-alpha',
        instance_id: 'primary',
        external_id: 'channel-1',
      },
      brief: brief(input, set),
      approved_at: '2026-08-18T00:02:00.000Z',
    };
    const unknown: DeliveryReceipt = {
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'unknown',
      external_id: null,
      recorded_at: '2026-08-18T00:03:00.000Z',
      retryable: true,
      message: 'provider did not confirm delivery',
    };
    const delivered: DeliveryReceipt = {
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: 'message-1',
      recorded_at: '2026-08-18T00:04:00.000Z',
      retryable: false,
    };
    await store.saveDeliveryReceipt(processingKey, envelope, unknown);
    await store.saveDeliveryReceipt(processingKey, envelope, delivered);
    await store.saveDeliveryReceipt(processingKey, envelope, delivered);
    store.close();

    const database = new Database(context.path, { readonly: true });
    expect(
      database
        .prepare(
          `SELECT status, retryable
             FROM authority_processing_delivery_receipts
            ORDER BY receipt_sequence`,
        )
        .all(),
    ).toEqual([
      { status: 'unknown', retryable: 1 },
      { status: 'delivered', retryable: 0 },
    ]);
    const columns = database.pragma(
      'table_info(authority_processing_delivery_receipts)',
    ) as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        'envelope_json',
        'receipt_json',
        'message',
        'external_id',
      ]),
    );
    database.close();
  });

  it('implements the Slack store port with create-once contracts and publications', async () => {
    const context = setup();
    const store = context.create();
    const slackStore: ApprovalDecisionStore = store;
    const input = meeting();
    const set = decisions(input);
    const processingKey = 'slack-store-contract';
    await store.admitAndSaveMeeting(input, processingKey);
    await store.saveDecisionSet(processingKey, input, set);
    const staged = await slackStore.ensureRequested(
      request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:00.000Z',
        'slack-brief',
      ),
    );
    expect(staged).toMatchObject({
      status: 'pending',
      brief: { id: 'slack-brief' },
      published: [],
    });

    const reviewer = reviewerPresentationContract();
    await expect(
      slackStore.freezeApprovalPresentationContract?.({
        approvalId: staged.approval_id,
        contract: reviewer,
      }),
    ).resolves.toEqual(reviewer);
    await expect(
      slackStore.freezeApprovalPresentationContract?.({
        approvalId: staged.approval_id,
        contract: reviewer,
      }),
    ).resolves.toEqual(reviewer);
    expect(
      slackStore.readApprovalPresentationContract?.(staged.approval_id),
    ).toEqual(reviewer);
    expect(
      store.readFrozenApprovalPresentationContract(staged.approval_id),
    ).toEqual(reviewer);
    await expect(
      slackStore.freezeApprovalPresentationContract?.({
        approvalId: staged.approval_id,
        contract: reviewerPresentationContract({ reviewer_name: 'Changed' }),
      }),
    ).rejects.toThrow('different bytes');

    const published = await slackStore.recordPublished({
      processingKey,
      surface: 'slack-authority-v1',
      reference: { channel: 'C123', message_ts: '1700000000.000001' },
    });
    expect(published.published).toEqual([
      {
        surface: 'slack-authority-v1',
        reference: { channel: 'C123', message_ts: '1700000000.000001' },
      },
    ]);
    await expect(
      slackStore.recordPublished({
        processingKey,
        surface: 'slack-authority-v1',
        reference: { channel: 'C123', message_ts: '1700000000.000001' },
      }),
    ).resolves.toEqual(published);
    await expect(
      slackStore.recordPublished({
        processingKey,
        surface: 'slack-authority-v1',
        reference: { channel: 'C123', message_ts: '1700000000.000002' },
      }),
    ).rejects.toThrow('already published different bytes');

    const secondInput = meeting(2);
    const secondSet = decisions(secondInput);
    const secondKey = 'slack-store-organization-member-contract';
    await store.admitAndSaveMeeting(secondInput, secondKey);
    await store.saveDecisionSet(secondKey, secondInput, secondSet);
    const second = await slackStore.ensureRequested(
      request(
        secondKey,
        secondInput,
        secondSet,
        '2026-08-18T00:01:01.000Z',
      ),
    );
    const organizationMember = organizationMemberPresentationContract();
    await expect(
      store.freezeApprovalPresentationContract({
        approvalId: second.approval_id,
        contract: organizationMember,
      }),
    ).resolves.toEqual(organizationMember);
    expect(
      store.readFrozenApprovalPresentationContract(second.approval_id),
    ).toEqual(organizationMember);
    expect(store.readApprovalPresentationContract(second.approval_id)).toBeNull();
    store.close();
  });

  it('resolves Slack approval once with durable authorization metadata', async () => {
    const context = setup();
    const store = context.create();
    const slackStore: ApprovalDecisionStore = store;
    const input = meeting();
    const set = decisions(input);
    const processingKey = 'slack-store-resolution';
    await store.admitAndSaveMeeting(input, processingKey);
    await store.saveDecisionSet(processingKey, input, set);
    const staged = await slackStore.ensureRequested(
      request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:00.000Z',
        'approved-slack-brief',
      ),
    );
    const metadata = {
      authorization: {
        schema_version: 1,
        kind: 'person-slack-approval-evidence',
        identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
      },
    } as const;
    context.setNow('2026-08-18T00:02:00.000Z');
    const resolved = await slackStore.resolve({
      approvalId: staged.approval_id,
      status: 'approved',
      reviewedBy: 'Reviewer',
      reason: 'Confirmed in the Slack thread',
      surface: 'slack-organization-member-readable-v1',
      metadata,
    });
    expect(resolved).toMatchObject({
      approval_id: staged.approval_id,
      status: 'approved',
      reviewed_at: '2026-08-18T00:02:00.000Z',
      reviewed_by: 'Reviewer',
      reason: 'Confirmed in the Slack thread',
      brief: { id: 'approved-slack-brief' },
    });
    expect(await store.getApproval(processingKey)).toEqual({
      status: 'approved',
      reviewed_at: '2026-08-18T00:02:00.000Z',
      reviewed_by: 'Reviewer',
      reason: 'Confirmed in the Slack thread',
      approved_brief: request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:00.000Z',
        'approved-slack-brief',
      ).brief,
    });
    expect(store.readApprovalResolutionMetadata(staged.approval_id)).toEqual({
      approval_id: staged.approval_id,
      surface: 'slack-organization-member-readable-v1',
      metadata,
      resolved_at: '2026-08-18T00:02:00.000Z',
    });

    context.setNow('2026-08-18T00:03:00.000Z');
    await expect(
      slackStore.resolve({
        approvalId: staged.approval_id,
        status: 'approved',
        reviewedBy: 'Reviewer',
        reason: 'Confirmed in the Slack thread',
        surface: 'slack-organization-member-readable-v1',
        metadata,
      }),
    ).resolves.toEqual(resolved);
    await expect(
      slackStore.resolve({
        approvalId: staged.approval_id,
        status: 'approved',
        reviewedBy: 'Reviewer',
        reason: 'Confirmed in the Slack thread',
        surface: 'slack-organization-member-readable-v1',
        metadata: { authorization: { changed: true } },
      }),
    ).rejects.toThrow('different resolution metadata');
    await expect(
      slackStore.resolve({
        approvalId: staged.approval_id,
        status: 'rejected',
        reviewedBy: 'Reviewer',
        reason: 'Changed outcome',
        surface: 'slack',
        metadata,
      }),
    ).rejects.toThrow('different terminal resolution');
    const reopened = context.create();
    await reopened.initialize();
    expect(reopened.readApprovalResolutionMetadata(staged.approval_id)).toEqual({
      approval_id: staged.approval_id,
      surface: 'slack-organization-member-readable-v1',
      metadata,
      resolved_at: '2026-08-18T00:02:00.000Z',
    });
    reopened.close();
  });

  it('freezes one signed record envelope across concurrent retries and restarts', async () => {
    const context = setup();
    const store = context.create();
    const recordStore: FrozenOrganizationRecordEnvelopeStore = store;
    const input = meeting();
    const set = decisions(input);
    const processingKey = 'frozen-record-envelope';
    await store.admitAndSaveMeeting(input, processingKey);
    await store.saveDecisionSet(processingKey, input, set);
    const staged = await store.ensureRequested(
      request(
        processingKey,
        input,
        set,
        '2026-08-18T00:01:00.000Z',
        'frozen-record-brief',
      ),
    );
    await store.resolve({
      approvalId: staged.approval_id,
      status: 'approved',
      reviewedBy: 'Reviewer',
      surface: 'slack-authority-v1',
      metadata: {},
      reviewedAt: '2026-08-18T00:02:00.000Z',
    });
    const first = signedRecordEnvelope(staged.approval_id);
    const divergent = signedRecordEnvelope(
      staged.approval_id,
      'rec_00000000-0000-4000-8000-000000000002',
      'different-signed-envelope-bytes',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCreates = 0;
    let secondCreates = 0;
    const firstRetry = recordStore.getOrCreate(staged.approval_id, async () => {
      firstCreates += 1;
      await gate;
      return first;
    });
    const concurrentRetry = recordStore.getOrCreate(
      staged.approval_id,
      async () => {
        secondCreates += 1;
        return divergent;
      },
    );
    release();
    const [created, concurrent] = await Promise.all([
      firstRetry,
      concurrentRetry,
    ]);
    expect(created).toEqual(first);
    expect(concurrent).toEqual(first);
    expect(firstCreates).toBe(1);
    expect(secondCreates).toBe(0);
    expect(
      store.readFrozenOrganizationRecordEnvelope(staged.approval_id),
    ).toEqual(first);
    await expect(
      store.freezeOrganizationRecordEnvelope({
        approvalId: staged.approval_id,
        record: first,
      }),
    ).resolves.toEqual(first);
    await expect(
      store.freezeOrganizationRecordEnvelope({
        approvalId: staged.approval_id,
        record: divergent,
      }),
    ).rejects.toThrow('different frozen record envelope');
    const reopened = context.create();
    const reopenedPort: FrozenOrganizationRecordEnvelopeStore = reopened;
    let restartCreates = 0;
    await expect(
      reopenedPort.getOrCreate(staged.approval_id, async () => {
        restartCreates += 1;
        return divergent;
      }),
    ).resolves.toEqual(first);
    expect(restartCreates).toBe(0);
    reopened.close();

    store.close();
  });

  it('rejects a frozen record event that conflicts with the terminal decision', async () => {
    const approved = await resolvedRecordFixture();
    await expect(
      (approved.store as FrozenOrganizationRecordEnvelopeStore).getOrCreate(
        approved.approvalId,
        async () => signedRecordEnvelope(approved.approvalId, undefined, undefined, 'rejection'),
      ),
    ).rejects.toThrow('does not match terminal resolution');
    approved.store.close();

    const rejected = await resolvedRecordFixture('rejected');
    await expect(
      (rejected.store as FrozenOrganizationRecordEnvelopeStore).getOrCreate(
        rejected.approvalId,
        async () => signedRecordEnvelope(rejected.approvalId),
      ),
    ).rejects.toThrow('does not match terminal resolution');
    rejected.store.close();
  });

  it('freezes the first terminal record after custody is revoked in an initialized store', async () => {
    const { context, store, processingKey, approvalId: id } = await resolvedRecordFixture();
    const first = signedRecordEnvelope(id);
    revokeSourceCustodian(context.path);
    await expect(
      (store as FrozenOrganizationRecordEnvelopeStore).getOrCreate(id, async () => first),
    ).resolves.toEqual(first);
    expect(store.readTerminalRecordAct(processingKey)).toMatchObject({
      decision: { status: 'approved' },
    });
    await expect(store.getCandidate(processingKey)).rejects.toThrow(
      'not bound to the exact active membership',
    );
    store.close();
  });

  it('reopens only terminal-record recovery after custody revocation', async () => {
    const { context, store, processingKey, approvalId: id } = await resolvedRecordFixture();
    const first = signedRecordEnvelope(id);
    expect(() => store.listTerminalRecordRecoveryPage()).toThrow(
      'terminal-record recovery is not initialized',
    );
    revokeSourceCustodian(context.path);
    store.close();
    const recovered = context.create();
    await recovered.initializeTerminalRecordRecovery();
    expect(recovered.listTerminalRecordRecoveryPage()).toEqual([
      {
        resolved_at: '2026-08-18T00:02:00.000Z',
        processing_key: processingKey,
      },
    ]);
    await expect(
      (recovered as FrozenOrganizationRecordEnvelopeStore).getOrCreate(id, async () => first),
    ).resolves.toEqual(first);
    await expect(
      (recovered as FrozenOrganizationRecordEnvelopeStore).getOrCreate(
        id,
        async () => signedRecordEnvelope(id, 'rec_00000000-0000-4000-8000-000000000002'),
      ),
    ).resolves.toEqual(first);
    await expect(recovered.getCandidate(processingKey)).rejects.toThrow(
      'cannot enter normal processing mode',
    );
    await expect(recovered.getApproval(processingKey)).rejects.toThrow(
      'cannot enter normal processing mode',
    );
    await expect(
      recovered.saveApproval(processingKey, {
        status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        reason: null,
        approved_brief: null,
      }),
    ).rejects.toThrow('cannot enter normal processing mode');
    await expect(recovered.markProcessed(processingKey)).rejects.toThrow(
      'cannot enter normal processing mode',
    );
    await expect(recovered.getSourceCursor(SOURCE)).rejects.toThrow(
      'cannot enter normal processing mode',
    );
    await expect(
      recovered.setSourceCursor(SOURCE, 'recovery-must-not-move-cursor'),
    ).rejects.toThrow('cannot enter normal processing mode');
    recovered.close();
  });

  it('enumerates only complete unprocessed terminal acts for the exact source', async () => {
    const {
      context,
      store,
      processingKey: eligibleKey,
    } = await resolvedRecordFixture();

    const pendingMeeting = meeting(2);
    const pendingDecisions = decisions(pendingMeeting);
    await store.admitAndSaveMeeting(pendingMeeting, 'recovery-pending');
    await store.saveDecisionSet(
      'recovery-pending',
      pendingMeeting,
      pendingDecisions,
    );
    await store.ensureRequested(
      request(
        'recovery-pending',
        pendingMeeting,
        pendingDecisions,
        '2026-08-18T00:01:01.000Z',
      ),
    );

    const missingMetadataMeeting = meeting(3);
    const missingMetadataDecisions = decisions(missingMetadataMeeting);
    const missingMetadataRequest = request(
      'recovery-missing-metadata',
      missingMetadataMeeting,
      missingMetadataDecisions,
      '2026-08-18T00:01:02.000Z',
    );
    await store.admitAndSaveMeeting(
      missingMetadataMeeting,
      'recovery-missing-metadata',
    );
    await store.saveDecisionSet(
      'recovery-missing-metadata',
      missingMetadataMeeting,
      missingMetadataDecisions,
    );
    await store.ensureRequested(missingMetadataRequest);
    await store.saveApproval('recovery-missing-metadata', {
      status: 'approved',
      reviewed_at: '2026-08-18T00:02:02.000Z',
      reviewed_by: 'Reviewer',
      reason: null,
      approved_brief: missingMetadataRequest.brief,
    });

    const processedMeeting = meeting(4);
    const processedDecisions = decisions(processedMeeting);
    await store.admitAndSaveMeeting(processedMeeting, 'recovery-processed');
    await store.saveDecisionSet(
      'recovery-processed',
      processedMeeting,
      processedDecisions,
    );
    const processed = await store.ensureRequested(
      request(
        'recovery-processed',
        processedMeeting,
        processedDecisions,
        '2026-08-18T00:01:03.000Z',
      ),
    );
    await store.resolve({
      approvalId: processed.approval_id,
      status: 'approved',
      reviewedBy: 'Reviewer',
      surface: 'slack-authority-v1',
      metadata: {},
      reviewedAt: '2026-08-18T00:02:03.000Z',
    });
    await store.markProcessed('recovery-processed');

    const foreignBinding: AuthorityProcessingStoreBinding = {
      ...BINDING,
      principal_id: 'prn_00000000-0000-4000-8000-000000000002',
      membership_id: 'mem_00000000-0000-4000-8000-000000000002',
      source_instance_id: 'foreign',
    };
    const database = new Database(context.path);
    database.exec(`
      INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES (
        '${foreignBinding.principal_id}', '${BINDING.organization_id}',
        'Foreign Source Owner', '2026-08-18T00:00:00.000Z'
      );
      INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type,
        status, provisioned_at, revoked_at, revocation_reason,
        admin_command_id, admin_command_sha256
      ) VALUES (
        '${foreignBinding.membership_id}', '${BINDING.organization_id}',
        '${foreignBinding.principal_id}', 'employee', 'active',
        '2026-08-18T00:00:00.000Z', NULL, NULL,
        'adm_00000000-0000-4000-8000-000000000002',
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      );
    `);
    database.close();
    const foreign = new SqliteAuthorityProcessingStore(
      context.path,
      foreignBinding,
      { bindingMode: 'provision', fileMustExist: true },
    );
    const foreignMeeting: MeetingDocument = {
      ...meeting(5),
      provenance: {
        ...meeting(5).provenance,
        source: { ...SOURCE, instance_id: 'foreign' },
      },
    };
    const foreignDecisions = decisions(foreignMeeting);
    await foreign.admitAndSaveMeeting(foreignMeeting, 'recovery-foreign');
    await foreign.saveDecisionSet(
      'recovery-foreign',
      foreignMeeting,
      foreignDecisions,
    );
    const foreignRequest = await foreign.ensureRequested(
      request(
        'recovery-foreign',
        foreignMeeting,
        foreignDecisions,
        '2026-08-18T00:01:04.000Z',
      ),
    );
    await foreign.resolve({
      approvalId: foreignRequest.approval_id,
      status: 'approved',
      reviewedBy: 'Reviewer',
      surface: 'slack-authority-v1',
      metadata: {},
      reviewedAt: '2026-08-18T00:02:04.000Z',
    });
    foreign.close();

    revokeSourceCustodian(context.path);
    store.close();
    const recovery = context.create();
    await recovery.initializeTerminalRecordRecovery();
    expect(recovery.listTerminalRecordRecoveryPage()).toEqual([
      {
        resolved_at: '2026-08-18T00:02:00.000Z',
        processing_key: eligibleKey,
      },
    ]);
    recovery.close();
  });

});
