import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../../src/processing/core/approval/approval-gate.js';
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
} from '../../../src/processing/core/contracts/adapter.js';
import type { DecisionSet } from '../../../src/processing/core/contracts/decision.js';
import type {
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../../src/processing/core/contracts/delivery.js';
import type {
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
} from '../../../src/processing/core/contracts/meeting.js';
import type {
  DecisionProcessorAdapter,
  DeliverySurfaceAdapter,
  MeetingSourceAdapter,
} from '../../../src/processing/core/ports/adapters.js';
import {
  meetingProcessingKey,
  runCoreCycle,
} from '../../../src/processing/core/processing/run-core-cycle.js';
import {
  AuthorityProcessingApprovalGate,
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

function setup(now = '2026-08-18T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-processing-'));
  directories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const bootstrap = new SqliteAuthorityProcessingStore(path, BINDING);
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

function validConfig(config: AdapterConfig): AdapterConfigValidation {
  return config.adapter_id.length > 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['adapter_id is required'] };
}

async function healthy(): Promise<AdapterHealth> {
  return { status: 'healthy', checked_at: '2026-08-18T00:00:00.000Z' };
}

describe('SqliteAuthorityProcessingStore', () => {
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
      { fileMustExist: true },
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

  it('applies exact own source/meeting exclusions atomically and stores no exclusion content', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    const exact = {
      scope: 'meeting' as const,
      source_adapter_id: SOURCE.adapter_id,
      source_instance_id: SOURCE.instance_id,
      external_id: meeting(1).provenance.external_id,
    };
    expect(await store.addOwnExclusion(exact)).toBe(true);
    expect(await store.addOwnExclusion(exact)).toBe(false);
    expect(await store.listOwnExclusions()).toEqual([exact]);
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
    expect(await store.addOwnExclusion(wholeSource)).toBe(true);
    expect(await store.admitAndSaveMeeting(meeting(3), 'excluded-three')).toBe(
      'excluded',
    );
    expect(await store.removeOwnExclusion(wholeSource)).toBe(true);
    expect(await store.removeOwnExclusion(exact)).toBe(true);
    expect(await store.listOwnExclusions()).toEqual([]);

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

  it('pages at 100 by the first actual request time and approval id', async () => {
    const context = setup();
    const store = context.create();
    await store.initialize();
    for (let index = 0; index < 105; index += 1) {
      const input = meeting(index + 1);
      const set = decisions(input);
      const processingKey = `pending-${index.toString().padStart(3, '0')}`;
      await store.admitAndSaveMeeting(input, processingKey);
      await store.saveDecisionSet(processingKey, input, set);
      await store.stageApprovalRequest(
        request(
          processingKey,
          input,
          set,
          new Date(Date.UTC(2026, 7, 18, 1, 0, 104 - index)).toISOString(),
        ),
      );
    }
    await store.admitAndSaveMeeting(meeting(106), 'raw-without-request');

    const first = await store.listPendingApprovals();
    expect(first).toHaveLength(100);
    expect(first[0]?.processing_key).toBe('pending-104');
    expect(first[99]?.processing_key).toBe('pending-005');
    const last = first.at(-1)!;
    const second = await store.listPendingApprovals({
      after: {
        requested_at: last.requested_at,
        approval_id: last.approval_id,
        processing_key: last.processing_key,
      },
    });
    expect(second.map(({ processing_key }) => processing_key)).toEqual([
      'pending-004',
      'pending-003',
      'pending-002',
      'pending-001',
      'pending-000',
    ]);
    expect(
      [...first, ...second].some(
        ({ processing_key }) => processing_key === 'raw-without-request',
      ),
    ).toBe(false);
    await expect(store.listPendingApprovals({ limit: 101 })).rejects.toThrow(
      '1 through 100',
    );
    store.close();
  });

  it('stages a normal core pending cycle and preserves the first request across retry ids and times', async () => {
    const context = setup();
    const store = context.create();
    const input = meeting();
    const source: MeetingSourceAdapter = {
      identity: SOURCE,
      validateConfig: validConfig,
      healthCheck: healthy,
      pull: async (_request: MeetingPullRequest): Promise<MeetingBatch> => ({
        meetings: [input],
      }),
    };
    const processor: DecisionProcessorAdapter = {
      identity: PROCESSOR,
      validateConfig: validConfig,
      healthCheck: healthy,
      extract: async () => decisions(input),
    };
    const gate = new AuthorityProcessingApprovalGate(store);
    const delivery: DeliverySurfaceAdapter = {
      identity: {
        kind: 'delivery-surface',
        adapter_id: 'delivery-alpha',
        instance_id: 'primary',
        version: '1.0.0',
      },
      destination: {
        adapter_id: 'delivery-alpha',
        instance_id: 'primary',
        external_id: 'channel-1',
      },
      validateConfig: validConfig,
      healthCheck: healthy,
      publish: async () => {
        throw new Error('pending approval must not publish');
      },
    };
    const processingKey = meetingProcessingKey(input, processor);

    const first = await runCoreCycle({
      meetingSource: source,
      decisionProcessor: processor,
      approvalGate: gate,
      deliverySurfaces: [delivery],
      state: store,
      now: () => '2026-08-18T02:00:00.000Z',
      createId: () => 'first-brief-id',
    });
    expect(first).toMatchObject({ ok: true, meetings_pending: 1 });
    const firstQueue = await store.listPendingApprovals();
    expect(firstQueue).toHaveLength(1);
    expect(firstQueue[0]).toMatchObject({
      processing_key: processingKey,
      requested_at: '2026-08-18T02:00:00.000Z',
      first_request: {
        requested_at: '2026-08-18T02:00:00.000Z',
        brief: { id: 'first-brief-id' },
      },
    });

    const retried = await runCoreCycle({
      meetingSource: source,
      decisionProcessor: processor,
      approvalGate: gate,
      deliverySurfaces: [delivery],
      state: store,
      now: () => '2026-08-18T03:00:00.000Z',
      createId: () => 'retry-brief-id',
    });
    expect(retried).toMatchObject({ ok: true, meetings_pending: 1 });
    const retryQueue = await store.listPendingApprovals();
    expect(retryQueue).toEqual(firstQueue);
    store.close();
  });
});
