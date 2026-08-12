import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  organizationRecordCanonicalEnvelope,
  organizationRecordEnvelopeIndex,
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
} from '@echo-brain/organization-record';
import { OrganizationRecordLogStore } from '@echo-brain/organization-record/append';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  openOrganizationRecordDatabase,
} from '@echo-brain/organization-record/maintenance';
import { AuthorityOperationError } from '../src/domain/errors.js';
import { openOrganizationRecordRuntime } from '../src/composition/organization-record.js';
import {
  approvalId,
  createRecordIngestFixture,
  type CreateRecordIngestFixtureOptions,
  type RecordIngestFixture,
} from './support/record-ingest-fixture.js';

let fixture: RecordIngestFixture | undefined;

afterEach(async () => {
  const open = fixture;
  fixture = undefined;
  // A test that already proved close() rejects has handled its own teardown;
  // swallowing here would hide a stop failure from every other test.
  await open?.close().catch(() => undefined);
});

async function openFixture(
  options: CreateRecordIngestFixtureOptions = {},
): Promise<RecordIngestFixture> {
  fixture = await createRecordIngestFixture(options);
  return fixture;
}

/**
 * A second connection to the same log file, which is how an operator tool or a
 * crashed sibling reaches it. Appending here never nudges the running
 * follower, so what the runtime does about the row is entirely up to its own
 * catch-up.
 */
function appendOutsideTheRuntime(
  test: RecordIngestFixture,
  envelope: unknown,
): void {
  const log = OrganizationRecordLogStore.open(test.recordLogDatabasePath, {
    organization_id: test.organizationId,
    authority_id: test.authorityId,
  });
  try {
    const index = organizationRecordEnvelopeIndex(
      envelope as Record<string, never>,
    );
    log.append({
      envelope: {
        envelope: envelope as never,
        envelope_id: index.envelope_id,
        event_type: index.event_type,
        idempotency_key: index.idempotency_key,
        installation_id: index.installation_id,
      },
      canonical_envelope: organizationRecordCanonicalEnvelope(
        envelope as Record<string, never>,
      ),
      envelope_sha256: sha256Digest(
        organizationRecordCanonicalEnvelope(envelope as Record<string, never>),
      ),
    });
  } finally {
    log.close();
  }
}

/** A chain-valid row at position 1 whose envelope derive cannot process. */
function appendUnderivableRecord(test: RecordIngestFixture): void {
  const canonicalEnvelope = canonicalJson({ kind: 'not-a-record-envelope' });
  const envelopeSha256 = sha256Digest(canonicalEnvelope);
  const recordedAt = '2026-08-08T12:00:00.000Z';
  const recordHash = organizationRecordHash(
    organizationRecordFrame({
      organization_id: test.organizationId,
      position: 1,
      previous_record_hash: null,
      recorded_at: recordedAt,
      envelope_sha256: envelopeSha256,
    }),
  );
  const database = new Database(test.recordLogDatabasePath);
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
        'a'.repeat(64),
        canonicalEnvelope,
        envelopeSha256,
        canonicalJson(
          organizationRecordReceiptPayload({
            authority_id: test.authorityId,
            organization_id: test.organizationId,
            envelope_id: 'rec_00000000-0000-4000-8000-000000000000',
            envelope_sha256: envelopeSha256,
            installation_id: 'ins_00000000-0000-4000-8000-000000000000',
            idempotency_key: 'a'.repeat(64),
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
          `SELECT COALESCE(MAX(last_position), 0) AS position
           FROM organization_derived_cursor`,
        )
        .get() as { position: number }
    ).position;
  } finally {
    database.close();
  }
}

describe('organization record runtime lifecycle', () => {
  it('keeps the permission pilot inactive when no marker exists', async () => {
    const test = await openFixture();

    expect(test.runtime.permissionPilotHealth).toEqual({ kind: 'absent' });
    expect(test.runtime.readPermissionPilotEligibleRecords()).toEqual([]);
  });

  it('caches a valid stopped-state activation without inventing eligible rows', async () => {
    const test = await openFixture({ activatePermissionPilot: true });

    expect(test.runtime.permissionPilotHealth).toMatchObject({
      kind: 'ready',
      activation: {
        organization_id: test.organizationId,
        effective_after_position: 0,
        effective_after_record_hash: null,
      },
    });
    expect(test.runtime.readPermissionPilotEligibleRecords()).toEqual([]);
  });

  it('keeps append operational while a corrupted startup marker degrades the pilot', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const initialHealth = test.runtime.permissionPilotHealth;
    if (initialHealth.kind !== 'ready') {
      throw new Error('expected an active pilot marker');
    }
    await test.runtime.close();
    const database = new Database(test.recordLogDatabasePath);
    try {
      const triggerSql = (
        database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type = 'trigger'
               AND name = 'organization_record_permission_pilot_activation_immutable_update'`,
          )
          .get() as { sql: string }
      ).sql;
      database.exec(
        `DROP TRIGGER organization_record_permission_pilot_activation_immutable_update`,
      );
      database
        .prepare(
          `UPDATE organization_record_permission_pilot_activation
           SET audience_notice_sha256 = ?`,
        )
        .run(`sha256:${'0'.repeat(64)}`);
      database.exec(triggerSql);
    } finally {
      database.close();
    }
    const alerts: string[] = [];
    const reopened = await openOrganizationRecordRuntime({
      authority: test.application,
      evidence: test.integrations,
      organization_id: test.organizationId,
      authority_id: test.authorityId,
      record_log_database_path: test.recordLogDatabasePath,
      record_derived_database_path: test.recordDerivedDatabasePath,
      alert: (alert) => alerts.push(`${alert.kind}:${alert.message}`),
    });
    try {
      expect(reopened.permissionPilotHealth).toMatchObject({
        kind: 'degraded',
        failure: expect.any(Error),
      });
      expect(() => reopened.readPermissionPilotEligibleRecords()).toThrow(
        /selection is unavailable/,
      );
      expect(alerts).toEqual([
        expect.stringMatching(/^permission-pilot-inactive:/),
      ]);

      const noticeId = approvalId('notice-with-corrupted-pilot-marker');
      await expect(
        reopened.submitRecordEnvelope({
          record_envelope: await test.approvalEnvelope({
            approval_id: noticeId,
            authorization: test.authorize({
              approval_id: noticeId,
              action: 'approve',
              permission_pilot_eligibility: {
                policy_id: initialHealth.activation.policy_id,
                presentation_policy_id:
                  initialHealth.activation.presentation_policy_id,
                audience_notice_sha256:
                  initialHealth.activation.audience_notice_sha256,
                message_presentation_sha256: sha256Digest(
                  'queued-notice-presentation',
                ),
              },
            }),
          }),
        }),
      ).rejects.toMatchObject({
        name: 'AuthorityOperationError',
        code: 'unavailable',
      });
      expect(reopened.verifyChain().head_position).toBeNull();

      const id = approvalId('approval-with-corrupted-pilot-marker');
      const accepted = await reopened.submitRecordEnvelope({
        record_envelope: await test.approvalEnvelope({
          approval_id: id,
          authorization: test.authorize({ approval_id: id, action: 'approve' }),
        }),
      });
      expect(accepted.record_receipt.position).toBe(1);
    } finally {
      await reopened.close();
    }
  });

  it('degrades startup on a corrupted eligibility pointer without returning a hidden empty result', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const health = test.runtime.permissionPilotHealth;
    if (health.kind !== 'ready') throw new Error('expected an active pilot marker');
    const id = approvalId('approval-before-pointer-corruption');
    const proof = {
      policy_id: health.activation.policy_id,
      presentation_policy_id: health.activation.presentation_policy_id,
      audience_notice_sha256: health.activation.audience_notice_sha256,
      message_presentation_sha256: sha256Digest('pointer-presentation'),
    };
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({
          approval_id: id,
          action: 'approve',
          permission_pilot_eligibility: proof,
        }),
      }),
    });
    await test.runtime.close();
    const database = new Database(test.recordLogDatabasePath);
    try {
      const triggerSql = (
        database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type = 'trigger'
               AND name = 'organization_record_permission_pilot_eligibility_immutable_update'`,
          )
          .get() as { sql: string }
      ).sql;
      database.exec(
        `DROP TRIGGER organization_record_permission_pilot_eligibility_immutable_update`,
      );
      database
        .prepare(
          `UPDATE organization_record_permission_pilot_eligibility
           SET audience_notice_sha256 = ?`,
        )
        .run(`sha256:${'0'.repeat(64)}`);
      database.exec(triggerSql);
    } finally {
      database.close();
    }

    const reopened = await openOrganizationRecordRuntime({
      authority: test.application,
      evidence: test.integrations,
      organization_id: test.organizationId,
      authority_id: test.authorityId,
      record_log_database_path: test.recordLogDatabasePath,
      record_derived_database_path: test.recordDerivedDatabasePath,
      alert: () => undefined,
    });
    try {
      expect(reopened.permissionPilotHealth).toMatchObject({
        kind: 'degraded',
        failure: expect.any(Error),
      });
      expect(() => reopened.readPermissionPilotEligibleRecords()).toThrow(
        /selection is unavailable/,
      );
    } finally {
      await reopened.close();
    }
  });

  it('degrades startup when indexed eligibility no longer has exact audited notice evidence', async () => {
    const test = await openFixture({ activatePermissionPilot: true });
    const health = test.runtime.permissionPilotHealth;
    if (health.kind !== 'ready') throw new Error('expected an active pilot marker');
    const id = approvalId('approval-before-audit-corruption');
    const proof = {
      policy_id: health.activation.policy_id,
      presentation_policy_id: health.activation.presentation_policy_id,
      audience_notice_sha256: health.activation.audience_notice_sha256,
      message_presentation_sha256: sha256Digest('audited-presentation'),
    };
    await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({
          approval_id: id,
          action: 'approve',
          permission_pilot_eligibility: proof,
        }),
      }),
    });
    await test.runtime.close();
    vi.spyOn(
      test.integrations,
      'findAllowedApprovalAuthorizationEvidence',
    ).mockReturnValue({
      status: 'matched',
      permission_pilot_eligibility: {
        ...proof,
        message_presentation_sha256: sha256Digest('different-presentation'),
      },
    });

    const reopened = await openOrganizationRecordRuntime({
      authority: test.application,
      evidence: test.integrations,
      organization_id: test.organizationId,
      authority_id: test.authorityId,
      record_log_database_path: test.recordLogDatabasePath,
      record_derived_database_path: test.recordDerivedDatabasePath,
      alert: () => undefined,
    });
    try {
      expect(reopened.permissionPilotHealth).toMatchObject({
        kind: 'degraded',
        failure: expect.objectContaining({
          message: expect.stringMatching(/no exact audited notice evidence/),
        }),
      });
      expect(() => reopened.readPermissionPilotEligibleRecords()).toThrow(
        /selection is unavailable/,
      );
    } finally {
      await reopened.close();
    }
  });

  it('stops ingest and reports a failure when derive halts after start', async () => {
    const test = await openFixture();
    // Startup catch-up already succeeded on an empty log; this row arrives
    // afterwards, which is the case the startup-only rule never covered.
    appendUnderivableRecord(test);
    const id = approvalId('approval-post-start-halt');
    const accepted = await test.runtime.submitRecordEnvelope({
      record_envelope: await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({ approval_id: id, action: 'approve' }),
      }),
    });
    expect(accepted.record_receipt.position).toBe(2);

    const progress = await test.runtime.follower.drain();

    expect(progress.halted).toBe(true);
    expect(test.runtime.fatalFailure?.message).toContain(
      'organization record derive halted',
    );
    // Refusing is the honest answer: the log would still accept the append,
    // but nothing would ever derive it and the member would hold a receipt for
    // a record the organization cannot read. Retryable, so the frozen envelope
    // survives the restart.
    const next = approvalId('approval-after-halt');
    await expect(
      test.runtime.submitRecordEnvelope({
        record_envelope: await test.approvalEnvelope({
          approval_id: next,
          authorization: test.authorize({
            approval_id: next,
            action: 'approve',
          }),
        }),
      }),
    ).rejects.toBeInstanceOf(AuthorityOperationError);
    expect(test.runtime.verifyChain().head_position).toBe(2);
    // Re-observing the halted follower never signals the host twice.
    await test.runtime.follower.drain();
    expect(test.fatalFailures).toHaveLength(1);
    expect(test.fatalFailures[0]?.message).toContain('derive halted');
  });

  it('drains outstanding derivation before closing its handles', async () => {
    const test = await openFixture();
    const id = approvalId('approval-close-drain');
    // Appended through a second connection, so the running follower is never
    // nudged and the cursor is genuinely behind at close time.
    appendOutsideTheRuntime(
      test,
      await test.approvalEnvelope({
        approval_id: id,
        authorization: test.authorize({ approval_id: id, action: 'approve' }),
      }),
    );
    expect(derivedCursorPosition(test.recordDerivedDatabasePath)).toBe(0);

    await test.runtime.close();

    // A stopped state that is behind its own log is a projection nobody knows
    // is stale. Close is the last chance to catch up while both handles are
    // still open.
    expect(derivedCursorPosition(test.recordDerivedDatabasePath)).toBe(1);
  });

  it('fails the stop when the chain no longer verifies', async () => {
    const test = await openFixture();
    const database = new Database(test.recordLogDatabasePath);
    try {
      // A fabricated first row: the triggers enforce ordering, not content, so
      // only walking the chain catches it. Close is the pre-backup walk, and a
      // stop that succeeded is precisely the claim the state is safe to copy.
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
        .run(
          'a'.repeat(64),
          `sha256:${'b'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
        );
    } finally {
      database.close();
    }

    const failure = await test.runtime
      .close()
      .then(() => null, (error: unknown) => error);

    // A fabricated row breaks both halves of the stop — derive cannot project
    // it and the chain walk cannot account for it — so the stop reports both
    // rather than picking one.
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors
        .map((error: unknown) => (error as Error).message)
        .join('; '),
    ).toMatch(/chain verification failed at close/);

    // Both handles still closed: leaving a file locked by a process that is
    // already stopping helps nobody, and the rejection is what tells the
    // operator the stopped state is not backup-safe.
    const reopened = new Database(test.recordLogDatabasePath);
    reopened.close();
  });
});
