import { canonicalJson } from '@echo-brain/federation-protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OrganizationRecordIngest,
  organizationRecordFrame,
  organizationRecordHash,
  verifyOrganizationRecordChain,
  type JsonObject,
  type OrganizationRecordReceiptPayloadV1,
} from '../src/index.js';
import { OrganizationRecordIdempotencyConflictError } from '../src/application/errors.js';
import {
  acceptingVerifier,
  approvalEnvelope,
  AUTHORITY_ID,
  fixedClock,
  INSTALLATION_ALPHA,
  INSTALLATION_BETA,
  openStores,
  ORGANIZATION_ID,
  recordingSigner,
  rejectingVerifier,
  rejectionEnvelope,
  removeTemporaryDirectories,
} from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

/**
 * The golden two-record chain. These digests freeze the exact genesis frame
 * and its successor: a change to the frame shape, the canonicalization, or the
 * hashed field set breaks them, which is the point.
 */
const GOLDEN_CHAIN = {
  first_envelope_sha256:
    'sha256:2fa58263b753e0a3a2ec5bbd2dc887272051bbb515467797cec80519f9ae766a',
  first_record_hash:
    'sha256:1a64a348cc3f754498b8cf9db58e1734c7e7b920a3015976f22c73ba418c23b6',
  second_record_hash:
    'sha256:fe4a70cf8010ea08510f0a4041be8fa1e01137e548f7ae687bb71e2446bfbeb6',
} as const;

function ingest(overrides: Partial<{ clock: () => string }> = {}): {
  ingest: OrganizationRecordIngest;
  stores: ReturnType<typeof openStores>;
  signer: ReturnType<typeof recordingSigner>;
  verifier: ReturnType<typeof acceptingVerifier>;
  nudges: number[];
} {
  const stores = openStores(overrides.clock ?? fixedClock());
  const signer = recordingSigner();
  const verifier = acceptingVerifier();
  const nudges: number[] = [];
  return {
    stores,
    signer,
    verifier,
    nudges,
    ingest: new OrganizationRecordIngest({
      log: stores.log,
      authority: verifier,
      receiptSigner: signer,
      clock: fixedClock(500),
      onAppended: () => nudges.push(nudges.length + 1),
    }),
  };
}

describe('organization record append', () => {
  it('appends a golden two-record chain', async () => {
    const context = ingest();
    const first = await context.ingest.append(approvalEnvelope());
    const second = await context.ingest.append(
      rejectionEnvelope({ idempotency_key: 'b'.repeat(64) }),
    );

    expect(first.outcome).toBe('appended');
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);

    const rows = context.stores.log.rows();
    expect(rows[0]!.previous_record_hash).toBeNull();
    expect(rows[1]!.previous_record_hash).toBe(rows[0]!.record_hash);

    // The genesis frame, restated here so the golden values are readable.
    const genesis = organizationRecordFrame({
      organization_id: ORGANIZATION_ID,
      position: 1,
      previous_record_hash: null,
      recorded_at: rows[0]!.recorded_at,
      envelope_sha256: rows[0]!.envelope_sha256,
    });
    expect(genesis.kind).toBe('echo-organization-record-frame');
    expect(genesis.schema_version).toBe(1);
    expect(organizationRecordHash(genesis)).toBe(rows[0]!.record_hash);

    expect({
      first_envelope_sha256: rows[0]!.envelope_sha256,
      first_record_hash: rows[0]!.record_hash,
      second_record_hash: rows[1]!.record_hash,
    }).toEqual(GOLDEN_CHAIN);

    const verification = verifyOrganizationRecordChain(context.stores.log);
    expect(verification.failures).toEqual([]);
    expect(verification.records_verified).toBe(2);
    expect(verification.head_position).toBe(2);
    expect(verification.tail_truncation_detectable).toBe(false);
  });

  it('stores the deterministic receipt payload with the row and signs it once', async () => {
    const context = ingest();
    const result = await context.ingest.append(approvalEnvelope());
    const row = context.stores.log.rows()[0]!;

    expect(canonicalJson(result.receipt_payload as unknown as JsonObject)).toBe(
      row.receipt_payload,
    );
    expect(result.receipt_payload).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-record-receipt',
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      installation_id: INSTALLATION_ALPHA,
      position: 1,
      record_hash: row.record_hash,
      recorded_at: row.recorded_at,
    });
    expect(result.signed_receipt).toHaveProperty('integrity');
    expect(context.signer.calls).toBe(1);
  });

  it('binds the indexed columns to the bytes the digest covers', async () => {
    const context = ingest();
    const lying = {
      async verifyEnvelope(envelope: unknown) {
        return {
          envelope: envelope as JsonObject,
          envelope_id: 'ore_approval_1',
          event_type: 'approval' as const,
          idempotency_key: 'c'.repeat(64),
          installation_id: INSTALLATION_ALPHA,
        };
      },
    };
    const lyingIngest = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: lying,
      receiptSigner: context.signer,
      clock: fixedClock(500),
    });
    await expect(lyingIngest.append(approvalEnvelope())).rejects.toThrow(
      /does not match its own canonical bytes/,
    );
    expect(context.stores.log.rows()).toEqual([]);
  });

  it('refuses to persist a receipt that is not the committed payload', async () => {
    const context = ingest();
    // A signer that returns a well-formed, signed-looking document for a
    // *different* record. `putSignedReceipt` is create-once, so accepting this
    // would freeze a receipt no member could ever present against the log.
    const drifting = {
      async signReceipt(
        payload: OrganizationRecordReceiptPayloadV1,
      ): Promise<JsonObject> {
        const signed = await context.signer.signReceipt(payload);
        return { ...signed, position: (payload.position as number) + 1 };
      },
    };
    const malformed = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: context.verifier,
      receiptSigner: drifting,
      clock: fixedClock(500),
    });

    await expect(malformed.append(approvalEnvelope())).rejects.toThrow(
      /does not carry the committed receipt payload/,
    );

    // The append itself committed — that is the log, and it is truth. What must
    // not exist is the unusable receipt beside it, and a later retry with a
    // working signer must still be able to materialize the real one.
    const row = context.stores.log.rows().at(-1);
    expect(row?.position).toBe(1);
    expect(context.stores.log.readSignedReceipt(1)).toBeNull();
    const recovered = await context.ingest.append(approvalEnvelope());
    expect(recovered.outcome).toBe('duplicate');
    expect(
      (recovered.signed_receipt as unknown as { position: number }).position,
    ).toBe(1);
    expect(context.stores.log.readSignedReceipt(1)).not.toBeNull();
  });

  it('refuses a signed receipt with no integrity block', async () => {
    const context = ingest();
    const unsigned = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: context.verifier,
      receiptSigner: {
        async signReceipt(
          payload: OrganizationRecordReceiptPayloadV1,
        ): Promise<JsonObject> {
          return payload as unknown as JsonObject;
        },
      },
      clock: fixedClock(500),
    });

    await expect(unsigned.append(approvalEnvelope())).rejects.toThrow(
      /carries no integrity block/,
    );
    expect(context.stores.log.readSignedReceipt(1)).toBeNull();
  });

  it('never appends when verification rejects', async () => {
    const context = ingest();
    const rejecting = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: rejectingVerifier('installation access lease expired'),
      receiptSigner: context.signer,
    });
    await expect(rejecting.append(approvalEnvelope())).rejects.toThrow(
      /lease expired/,
    );
    expect(context.stores.log.rows()).toEqual([]);
    expect(context.signer.calls).toBe(0);
  });
});

describe('organization record idempotency', () => {
  it('returns the stored original for the same key and the same envelope', async () => {
    const context = ingest();
    const first = await context.ingest.append(approvalEnvelope());
    const replay = await context.ingest.append(approvalEnvelope());

    expect(replay.outcome).toBe('duplicate');
    expect(replay.position).toBe(first.position);
    expect(replay.record_hash).toBe(first.record_hash);
    expect(replay.recorded_at).toBe(first.recorded_at);
    expect(replay.receipt_payload).toEqual(first.receipt_payload);
    expect(replay.signed_receipt).toEqual(first.signed_receipt);
    expect(context.stores.log.rows()).toHaveLength(1);
    // Retries add zero duplicates and re-sign nothing.
    expect(context.signer.calls).toBe(1);
    expect(context.nudges).toHaveLength(1);
  });

  it('rejects the same key reused with a different envelope', async () => {
    const context = ingest();
    await context.ingest.append(approvalEnvelope());
    await expect(
      context.ingest.append(approvalEnvelope({ decision_text: 'A different decision' })),
    ).rejects.toBeInstanceOf(OrganizationRecordIdempotencyConflictError);
    expect(context.stores.log.rows()).toHaveLength(1);
  });

  it('scopes idempotency to the installation, not the organization', async () => {
    const context = ingest();
    const first = await context.ingest.append(approvalEnvelope());
    const second = await context.ingest.append(
      approvalEnvelope({
        envelope_id: 'ore_approval_beta',
        installation_id: INSTALLATION_BETA,
      }),
    );
    // The log unit is one member's human-approved act; cross-member semantic
    // deduplication is later interpretation, not append-time behavior.
    expect(second.outcome).toBe('appended');
    expect(second.position).toBe(2);
    expect(second.record_hash).not.toBe(first.record_hash);
  });
});

describe('organization record receipt materialization', () => {
  it('recovers a receipt lost after the append commit without appending again', async () => {
    const context = ingest();
    context.signer.failNext = true;
    await expect(context.ingest.append(approvalEnvelope())).rejects.toThrow(
      /signing key unavailable/,
    );

    // The append committed; only the signature is missing.
    expect(context.stores.log.rows()).toHaveLength(1);
    expect(context.stores.log.readSignedReceipt(1)).toBeNull();

    const retry = await context.ingest.append(approvalEnvelope());
    expect(retry.outcome).toBe('duplicate');
    expect(retry.position).toBe(1);
    expect(context.stores.log.rows()).toHaveLength(1);
    expect(context.stores.log.readSignedReceipt(1)).not.toBeNull();
    expect(context.signer.calls).toBe(1);
    expect(context.signer.failures).toBe(1);
  });

  it('recovers a lost receipt through an authority that now rejects', async () => {
    const context = ingest();
    context.signer.failNext = true;
    await expect(context.ingest.append(approvalEnvelope())).rejects.toThrow(
      /signing key unavailable/,
    );
    expect(context.stores.log.rows()).toHaveLength(1);
    expect(context.stores.log.readSignedReceipt(1)).toBeNull();

    // The lease expired, or the membership was revoked, between the append and
    // the retry. Resending the exact accepted bytes is not a new act, so it
    // must not be blocked forever behind a fresh authorization.
    const expired = rejectingVerifier('installation access lease expired');
    const afterExpiry = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: expired,
      receiptSigner: context.signer,
      clock: fixedClock(700),
    });

    const recovered = await afterExpiry.append(approvalEnvelope());
    expect(recovered.outcome).toBe('duplicate');
    expect(recovered.position).toBe(1);
    expect(recovered.record_hash).toBe(context.stores.log.rows()[0]!.record_hash);
    expect(recovered.signed_receipt).toHaveProperty('integrity');
    expect(context.stores.log.rows()).toHaveLength(1);
    expect(context.stores.log.readSignedReceipt(1)).not.toBeNull();
    expect(context.signer.calls).toBe(1);
  });

  it('recovers only exact content, and never weakens verification for an absent row', async () => {
    const context = ingest();
    await context.ingest.append(approvalEnvelope());

    const expired = new OrganizationRecordIngest({
      log: context.stores.log,
      authority: rejectingVerifier('installation access lease expired'),
      receiptSigner: context.signer,
      clock: fixedClock(700),
    });

    // Same key, different content: no recovery, and the rejection stands.
    await expect(
      expired.append(approvalEnvelope({ decision_text: 'A different decision' })),
    ).rejects.toThrow(/lease expired/);
    // A key the log has never accepted: full verification, undiminished.
    await expect(
      expired.append(
        approvalEnvelope({ envelope_id: 'ore_new', idempotency_key: 'c'.repeat(64) }),
      ),
    ).rejects.toThrow(/lease expired/);
    // A different installation reusing the same key is a different act.
    await expect(
      expired.append(approvalEnvelope({ installation_id: INSTALLATION_BETA })),
    ).rejects.toThrow(/lease expired/);

    expect(context.stores.log.rows()).toHaveLength(1);
  });

  it('keeps a materialized receipt create-once', async () => {
    const context = ingest();
    await context.ingest.append(approvalEnvelope());
    const stored = context.stores.log.readSignedReceipt(1)!;
    expect(context.stores.log.putSignedReceipt(1, '{"replaced":true}', 'later')).toBe(
      stored,
    );
  });
});

describe('organization record chain verification', () => {
  async function tamperedChain(): Promise<ReturnType<typeof openStores>> {
    const context = ingest();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());
    // Out-of-band mutation: the triggers stop ordinary code paths, so a
    // tamper test must first remove them, exactly like an attacker with
    // direct file access would.
    context.stores.log.database.exec(`
      DROP TRIGGER organization_record_log_immutable_update;
      DROP TRIGGER organization_record_log_immutable_delete;
    `);
    return context.stores;
  }

  it('detects a mutated envelope', async () => {
    const stores = await tamperedChain();
    stores.log.database.exec(
      `UPDATE organization_record_log SET canonical_envelope = '{"tampered":true}' WHERE position = 1`,
    );
    const verification = verifyOrganizationRecordChain(stores.log);
    expect(verification.failures.map((failure) => failure.kind)).toContain(
      'envelope_digest_mismatch',
    );
  });

  it('detects an index field that differs from the canonical envelope', async () => {
    const stores = await tamperedChain();
    stores.log.database.exec(
      `UPDATE organization_record_log SET event_type = 'rejection' WHERE position = 1`,
    );
    expect(
      verifyOrganizationRecordChain(stores.log).failures.map(
        (failure) => failure.kind,
      ),
    ).toContain('envelope_index_mismatch');
  });

  it('detects a mutated record hash and the broken successor link', async () => {
    const stores = await tamperedChain();
    stores.log.database.exec(
      `UPDATE organization_record_log SET record_hash = 'sha256:${'0'.repeat(64)}' WHERE position = 1`,
    );
    const kinds = verifyOrganizationRecordChain(stores.log).failures.map(
      (failure) => `${failure.position}:${failure.kind}`,
    );
    expect(kinds).toContain('1:record_hash_mismatch');
    expect(kinds).toContain('2:predecessor_mismatch');
  });

  it('detects reordering', async () => {
    const stores = await tamperedChain();
    const [first, second] = stores.log.rows();
    stores.log.database
      .prepare(`UPDATE organization_record_log SET recorded_at = ? WHERE position = ?`)
      .run(second!.recorded_at, 1);
    stores.log.database
      .prepare(`UPDATE organization_record_log SET recorded_at = ? WHERE position = ?`)
      .run(first!.recorded_at, 2);
    expect(
      verifyOrganizationRecordChain(stores.log).failures.map((failure) => failure.kind),
    ).toContain('record_hash_mismatch');
  });

  it('detects an interior deletion as a position gap', async () => {
    const context = ingest();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());
    await context.ingest.append(
      approvalEnvelope({ envelope_id: 'ore_approval_3', idempotency_key: 'd'.repeat(64) }),
    );
    context.stores.log.database.exec(`
      DROP TRIGGER organization_record_log_immutable_delete;
      DROP TRIGGER organization_record_signed_receipt_immutable_delete;
      DELETE FROM organization_record_signed_receipt WHERE position = 2;
      DELETE FROM organization_record_log WHERE position = 2;
    `);
    const failures = verifyOrganizationRecordChain(context.stores.log).failures;
    expect(failures.map((failure) => `${failure.position}:${failure.kind}`)).toEqual(
      expect.arrayContaining(['3:position_gap', '3:predecessor_mismatch']),
    );
  });

  it('reports a clean chain and its honest tail-truncation boundary', async () => {
    const context = ingest();
    const first = await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());

    expect(verifyOrganizationRecordChain(context.stores.log).failures).toEqual([]);

    // Truncate the tail. The surviving prefix is internally perfect, which is
    // exactly why walking cannot see the loss.
    context.stores.log.database.exec(`
      DROP TRIGGER organization_record_log_immutable_delete;
      DROP TRIGGER organization_record_signed_receipt_immutable_delete;
      DELETE FROM organization_record_signed_receipt WHERE position = 2;
      DELETE FROM organization_record_log WHERE position = 2;
    `);
    const afterTruncation = verifyOrganizationRecordChain(context.stores.log);
    expect(afterTruncation.failures).toEqual([]);
    expect(afterTruncation.head_position).toBe(1);
    expect(afterTruncation.head_record_hash).toBe(first.record_hash);
    expect(afterTruncation.tail_truncation_detectable).toBe(false);
  });
});
