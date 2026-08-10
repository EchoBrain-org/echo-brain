import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE,
  ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
  ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
  OrganizationPermissionPilotLog,
  OrganizationPermissionPilotReader,
  OrganizationRecordIngest,
  OrganizationRecordLogStore,
  organizationPermissionPilotCommandSha256,
  projectOrganizationRecord,
  type JsonObject,
  type OrganizationPermissionPilotActivationCommandV1,
  type OrganizationPermissionPilotEligibilityProofV1,
} from '../src/index.js';
import {
  approvalEnvelope,
  fixedClock,
  recordingSigner,
  rejectionEnvelope,
  removeTemporaryDirectories,
  temporaryStateDirectory,
} from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const AUDIENCE = [
  {
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    label: 'Audrey',
  },
  {
    membership_id: 'mem_00000000-0000-4000-8000-000000000002',
    label: 'Zhenye',
  },
] as const;
const COMMAND: OrganizationPermissionPilotActivationCommandV1 = {
  schema_version: 1,
  kind: 'echo-organization-permission-pilot-activation-command',
  command_id: 'ppa_00000000-0000-4000-8000-000000000001',
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
  presentation_policy_id: ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
  audience: AUDIENCE,
  requested_at: '2026-08-10T12:00:00.000Z',
  reason: 'Activate the two-person founder-live permission pilot.',
};
const AUDIENCE_NOTICE_SHA256 =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

function proof(seed = 'b'): OrganizationPermissionPilotEligibilityProofV1 {
  return {
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id:
      ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    // The real digest is supplied from the stored marker by `appendQualified`.
    audience_notice_sha256: AUDIENCE_NOTICE_SHA256,
    message_presentation_sha256:
      `sha256:${seed.repeat(64)}` as `sha256:${string}`,
  };
}

function logPath(): string {
  return `${temporaryStateDirectory()}/record-log.sqlite`;
}

function openLog(path: string): OrganizationRecordLogStore {
  return OrganizationRecordLogStore.open(path, {
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
    clock: fixedClock(),
  });
}

function activate(path: string, command = COMMAND) {
  const pilot = OrganizationPermissionPilotLog.open(path, {
    organization_id: ORGANIZATION_ID,
    authority_id: AUTHORITY_ID,
  });
  try {
    return pilot.activate({
      command,
      command_sha256: organizationPermissionPilotCommandSha256(command),
      activated_at: '2026-08-10T12:00:01.000Z',
    });
  } finally {
    pilot.close();
  }
}

function qualifiedEnvelope(index: number): JsonObject {
  const base = approvalEnvelope({
    envelope_id: `ore_permission_${index}`,
    idempotency_key: index.toString(16).padStart(64, '0'),
    installation_id: INSTALLATION_ID,
    decision_text: `Pilot decision ${index}`,
  });
  const reviewer = base['reviewer'] as JsonObject;
  return {
    ...base,
    reviewer: {
      ...reviewer,
      authorization: {
        ...(reviewer['authorization'] as JsonObject),
        reason_code: ORGANIZATION_PERMISSION_PILOT_NOTICE_REASON_CODE,
      },
    },
  };
}

async function appendQualified(
  log: OrganizationRecordLogStore,
  index: number,
  audienceNoticeSha256: `sha256:${string}`,
  overrides: Partial<OrganizationPermissionPilotEligibilityProofV1> = {},
): Promise<void> {
  const envelope = qualifiedEnvelope(index);
  const eligibility = {
    ...proof(((index % 5) + 10).toString(16)),
    audience_notice_sha256: audienceNoticeSha256,
    ...overrides,
  } as OrganizationPermissionPilotEligibilityProofV1;
  const ingest = new OrganizationRecordIngest({
    log,
    authority: {
      async verifyEnvelope(value: unknown) {
        const candidate = value as JsonObject;
        return {
          envelope: candidate,
          envelope_id: candidate['envelope_id'] as string,
          event_type: 'approval' as const,
          idempotency_key: candidate['idempotency_key'] as string,
          installation_id: INSTALLATION_ID,
          permission_pilot_eligibility: eligibility,
        };
      },
    },
    receiptSigner: recordingSigner(),
    clock: fixedClock(20 + index),
  });
  await ingest.append(envelope);
}

function appendUnqualified(
  log: OrganizationRecordLogStore,
  envelope: JsonObject,
  recordedAt: string,
): void {
  const canonicalEnvelope = canonicalJson(envelope);
  log.append({
    envelope: {
      envelope,
      envelope_id: envelope['envelope_id'] as string,
      event_type: envelope['event_type'] as 'approval' | 'rejection',
      idempotency_key: envelope['idempotency_key'] as string,
      installation_id: INSTALLATION_ID,
    },
    canonical_envelope: canonicalEnvelope,
    envelope_sha256: sha256Digest(canonicalEnvelope),
    recorded_at: recordedAt,
  });
}

describe('organization permission pilot activation', () => {
  it('binds an empty log to the explicit zero/null sentinel', () => {
    const path = logPath();
    openLog(path).close();

    const result = activate(path);

    expect(result.created).toBe(true);
    expect(result.marker).toMatchObject({
      organization_id: ORGANIZATION_ID,
      effective_after_position: 0,
      effective_after_record_hash: null,
      audience: AUDIENCE,
    });
    expect(result.marker.audience_notice_sha256).toBe(
      sha256Digest(canonicalJson(result.marker.presentation_descriptor)),
    );
  });

  it('returns an exact retry unchanged after later appends and rejects another command', async () => {
    const path = logPath();
    openLog(path).close();
    const first = activate(path);
    const log = openLog(path);
    await appendQualified(log, 1, first.marker.audience_notice_sha256);
    log.close();

    const retry = activate(path);
    expect(retry).toEqual({ created: false, marker: first.marker });

    expect(() =>
      activate(path, {
        ...COMMAND,
        command_id: 'ppa_00000000-0000-4000-8000-000000000002',
      }),
    ).toThrow('already activated by a different command');
  });

  it('binds a nonempty verified head and keeps both new tables immutable', async () => {
    const path = logPath();
    const log = openLog(path);
    const legacy = approvalEnvelope({ installation_id: INSTALLATION_ID });
    const canonical = canonicalJson(legacy);
    log.append({
      envelope: {
        envelope: legacy,
        envelope_id: legacy['envelope_id'] as string,
        event_type: 'approval',
        idempotency_key: legacy['idempotency_key'] as string,
        installation_id: INSTALLATION_ID,
      },
      canonical_envelope: canonical,
      envelope_sha256: sha256Digest(canonical),
      recorded_at: '2026-08-10T11:59:00.000Z',
    });
    const head = log.rows()[0]!;
    log.close();

    const result = activate(path);
    expect(result.marker).toMatchObject({
      effective_after_position: 1,
      effective_after_record_hash: head.record_hash,
    });

    const reopened = openLog(path);
    await appendQualified(reopened, 2, result.marker.audience_notice_sha256);
    expect(() =>
      reopened.database.exec(
        `UPDATE organization_record_permission_pilot_activation SET activated_at = 'later'`,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      reopened.database.exec(
        `DELETE FROM organization_record_permission_pilot_eligibility`,
      ),
    ).toThrow(/cannot be deleted/);
    reopened.close();
  });
});

describe('organization permission pilot eligibility and reader', () => {
  it('rejects a verified eligibility claim when no activation marker exists', async () => {
    const path = logPath();
    const log = openLog(path);

    await expect(
      appendQualified(log, 1, AUDIENCE_NOTICE_SHA256),
    ).rejects.toThrow(/does not match the active post-boundary policy/);
    expect(log.rows()).toEqual([]);
    log.close();
  });

  it('keeps legacy post-activation approvals and rejections outside the qualified index', () => {
    const path = logPath();
    openLog(path).close();
    const marker = activate(path).marker;
    const log = openLog(path);

    appendUnqualified(
      log,
      approvalEnvelope({
        envelope_id: 'ore_permission_legacy_approval',
        idempotency_key: '1'.repeat(64),
        installation_id: INSTALLATION_ID,
      }),
      '2026-08-10T12:00:02.000Z',
    );
    appendUnqualified(
      log,
      rejectionEnvelope({
        envelope_id: 'ore_permission_legacy_rejection',
        idempotency_key: '2'.repeat(64),
        installation_id: INSTALLATION_ID,
      }),
      '2026-08-10T12:00:03.000Z',
    );

    expect(log.rows()).toHaveLength(2);
    expect(
      log.database
        .prepare(
          `SELECT position FROM organization_record_permission_pilot_eligibility`,
        )
        .all(),
    ).toEqual([]);
    expect(
      new OrganizationPermissionPilotReader(log.database, {
        organization_id: ORGANIZATION_ID,
      }).validateState(),
    ).toEqual({ activation: marker, eligible_records: [] });
    log.close();
  });

  it('indexes exact post-boundary notice proof and rejects a mismatched verified claim', async () => {
    const path = logPath();
    const initial = openLog(path);
    const legacy = approvalEnvelope({ installation_id: INSTALLATION_ID });
    const canonical = canonicalJson(legacy);
    initial.append({
      envelope: {
        envelope: legacy,
        envelope_id: legacy['envelope_id'] as string,
        event_type: 'approval',
        idempotency_key: legacy['idempotency_key'] as string,
        installation_id: INSTALLATION_ID,
      },
      canonical_envelope: canonical,
      envelope_sha256: sha256Digest(canonical),
      recorded_at: '2026-08-10T11:59:00.000Z',
    });
    initial.close();
    const marker = activate(path).marker;
    const log = openLog(path);
    await appendQualified(log, 2, marker.audience_notice_sha256);
    await expect(
      appendQualified(log, 3, `sha256:${'c'.repeat(64)}`),
    ).rejects.toThrow(/does not match the active post-boundary policy/);

    const pointers = log.database
      .prepare(
        `SELECT position, record_hash
         FROM organization_record_permission_pilot_eligibility`,
      )
      .all();
    expect(pointers).toEqual([
      { position: 2, record_hash: log.rows()[1]!.record_hash },
    ]);
    expect(log.rows()).toHaveLength(2);

    const reader = new OrganizationPermissionPilotReader(log.database, {
      organization_id: ORGANIZATION_ID,
    });
    const state = reader.validateState();
    expect(state.activation).toEqual(marker);
    expect(state.eligible_records).toHaveLength(1);
    expect(
      projectOrganizationRecord(state.eligible_records[0]!.row).atoms.map(
        ({ kind }) => kind,
      ),
    ).toEqual(['decision', 'action', 'rationale']);
    log.close();
  });

  it('rolls back the record when its qualified pointer cannot commit', async () => {
    const path = logPath();
    openLog(path).close();
    const marker = activate(path).marker;
    const log = openLog(path);
    log.database.exec(`
      CREATE TRIGGER test_permission_pilot_pointer_abort
      BEFORE INSERT ON organization_record_permission_pilot_eligibility
      BEGIN
        SELECT RAISE(ABORT, 'test pointer failure');
      END;
    `);

    await expect(
      appendQualified(log, 1, marker.audience_notice_sha256),
    ).rejects.toThrow('test pointer failure');
    expect(log.rows()).toEqual([]);
    log.close();
  });

  it('returns no more than the twenty newest records in descending position', async () => {
    const path = logPath();
    openLog(path).close();
    const marker = activate(path).marker;
    const log = openLog(path);
    for (let index = 1; index <= 21; index += 1) {
      await appendQualified(log, index, marker.audience_notice_sha256);
    }
    const reader = new OrganizationPermissionPilotReader(log.database, {
      organization_id: ORGANIZATION_ID,
    });
    reader.validateState();

    const newest = reader.readEligibleRecordsDescending();
    expect(newest).toHaveLength(20);
    expect(newest.map(({ row }) => row.position)).toEqual(
      Array.from({ length: 20 }, (_, index) => 21 - index),
    );
    log.close();
  });

  it('fails startup validation closed when the immutable marker is corrupted', () => {
    const path = logPath();
    openLog(path).close();
    activate(path);
    const log = openLog(path);
    log.database.exec(`
      DROP TRIGGER organization_record_permission_pilot_activation_immutable_update;
      UPDATE organization_record_permission_pilot_activation
      SET audience_notice_sha256 = 'sha256:${'0'.repeat(64)}';
    `);
    const reader = new OrganizationPermissionPilotReader(log.database, {
      organization_id: ORGANIZATION_ID,
    });
    expect(() => reader.validateState()).toThrow(/audience notice digest/);
    expect(reader.activation).toBeNull();
    log.close();
  });

  it('fails startup validation closed when an eligibility pointer is corrupted', async () => {
    const path = logPath();
    openLog(path).close();
    const marker = activate(path).marker;
    const log = openLog(path);
    await appendQualified(log, 1, marker.audience_notice_sha256);
    log.database.exec(`
      DROP TRIGGER organization_record_permission_pilot_eligibility_immutable_update;
      UPDATE organization_record_permission_pilot_eligibility
      SET audience_notice_sha256 = 'sha256:${'0'.repeat(64)}';
    `);
    const reader = new OrganizationPermissionPilotReader(log.database, {
      organization_id: ORGANIZATION_ID,
    });

    expect(() => reader.validateState()).toThrow(/differs from activation/);
    expect(reader.activation).toBeNull();
    log.close();
  });
});
