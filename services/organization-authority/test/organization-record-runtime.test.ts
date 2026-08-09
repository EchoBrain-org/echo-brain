import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  openOrganizationRecordDatabase,
  organizationRecordCanonicalEnvelope,
  organizationRecordEnvelopeIndex,
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
  OrganizationRecordLogStore,
} from '@echo-brain/organization-record';
import { AuthorityOperationError } from '../src/domain/errors.js';
import {
  approvalId,
  createRecordIngestFixture,
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

async function openFixture(): Promise<RecordIngestFixture> {
  fixture = await createRecordIngestFixture();
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
      recorded_at: '2026-08-08T12:00:00.000Z',
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
