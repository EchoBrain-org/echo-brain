import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/core/index.js';
import {
  DecisionNodeStore,
  decisionApprovalId,
  projectDecisionOrganizationRecord,
  type DecisionNodeState,
  type DecisionOrganizationRecordReceipt,
} from '../../src/product/index.js';

const roots: string[] = [];

function request(): ApprovalRequest {
  return {
    processing_key: 'source:instance:item:revision:processor:instance:version',
    requested_at: '2026-07-16T20:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'source',
          instance_id: 'instance',
          version: '1',
        },
        external_id: 'item',
        canonical_revision: 'revision',
        observed_at: '2026-07-16T19:00:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-07-16T19:00:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-07-16T19:30:00.000Z',
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: {
        id: 'meeting-1',
        title: 'Planning',
        time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'processor',
          instance_id: 'instance',
          version: '1',
        },
        generated_at: '2026-07-16T19:30:00.000Z',
      },
    },
  };
}

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('decision node store', () => {
  it('refuses a state root redirected through a final symlink', async () => {
    const parent = newRoot('decision-store-link-');
    const target = join(parent, 'target');
    const link = join(parent, 'state');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');

    // The shared retirement preflight refuses an uninspectable root before the
    // store's own path check can run. Either refusal is correct; what matters
    // is that a symlinked state root is never opened.
    await expect(new DecisionNodeStore(link).list()).rejects.toThrow(
      /cannot be inspected|direct directory/,
    );
  });

  it('stages once, remains pending, and preserves the first brief across retries', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });

    const staged = await store.ensureRequested(request());
    expect(staged.status).toBe('pending');
    expect(staged.brief.id).toBe('brief-1');
    const approvalId = decisionApprovalId(request().processing_key);
    expect(staged.approval_id).toBe(approvalId);
    const requestedPath = join(root, 'decisions', approvalId, 'requested.json');
    expect(statSync(requestedPath).mode & 0o777).toBe(0o600);

    // The core cycle recompiles the brief with a fresh id every pending
    // retry; the stored request must keep the originally staged brief.
    const retried = request();
    retried.brief = { ...retried.brief, id: 'brief-from-unapproved-retry' };
    const again = await store.ensureRequested(retried);
    expect(again.status).toBe('pending');
    expect(again.brief.id).toBe('brief-1');
    expect(again.node_id).toBe(staged.node_id);

    const resolved = await store.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'cli',
    });
    expect(resolved).toMatchObject({
      status: 'approved',
      reviewed_at: '2026-07-16T21:00:00.000Z',
      reviewed_by: 'operator',
      reason: null,
      resolved_surface: 'cli',
    });
    expect(resolved.brief.id).toBe('brief-1');
    expect(readFileSync(requestedPath, 'utf8')).not.toContain('undefined');
  });

  it('is first-resolution-wins with idempotent retries and conflicting rejections', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root);
    await store.ensureRequested(request());
    const approvalId = decisionApprovalId(request().processing_key);

    await store.resolve({
      approvalId,
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'revise',
      surface: 'cli',
    });
    // Identical retry returns the winner.
    const repeated = await store.resolve({
      approvalId,
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'revise',
      surface: 'slack',
    });
    expect(repeated.status).toBe('rejected');
    // A conflicting resolution fails.
    await expect(
      store.resolve({
        approvalId,
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'cli',
      }),
    ).rejects.toThrow(/already rejected/);
    await expect(
      store.resolve({
        approvalId: '../escape',
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'cli',
      }),
    ).rejects.toThrow(/64-character/);
  });

  it('serializes conflicting resolutions across independent store instances', async () => {
    const root = newRoot('decision-store-race-');
    const first = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const second = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:01.000Z',
    });
    await first.ensureRequested(request());
    const approvalId = decisionApprovalId(request().processing_key);

    const attempts = await Promise.allSettled([
      first.resolve({
        approvalId,
        status: 'approved',
        reviewedBy: 'slack-reviewer',
        surface: 'slack',
      }),
      second.resolve({
        approvalId,
        status: 'rejected',
        reviewedBy: 'cli-reviewer',
        surface: 'cli',
      }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    const [winner] = await new DecisionNodeStore(root).list();
    expect(winner!.status).toMatch(/^(approved|rejected)$/);
    expect(
      attempts.some(
        (attempt) =>
          attempt.status === 'fulfilled' &&
          attempt.value.status === winner!.status,
      ),
    ).toBe(true);
  });

  it('records publications create-once per surface and durably retains a superseding surface', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    await store.ensureRequested(request());

    const published = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });
    expect(published.published).toHaveLength(1);
    expect(published.published[0]).toMatchObject({
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });

    // A repeat publish keeps the originally recorded reference.
    const repeated = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '9999.999' },
    });
    expect(repeated.published).toHaveLength(1);
    expect(repeated.published[0]!.reference['message_ts']).toBe('1700.001');

    const replacement = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C123', message_ts: '1800.001' },
    });
    const [reloaded] = await new DecisionNodeStore(root).list();
    expect(reloaded?.published).toEqual(replacement.published);
    expect(replacement.published[0]).toMatchObject({
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C123', message_ts: '1800.001' },
    });
  });

  it('resolves without any publication (the CLI can win first)', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root);
    await store.ensureRequested(request());
    const resolved = await store.resolve({
      approvalId: decisionApprovalId(request().processing_key),
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'cli',
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.published).toHaveLength(0);
  });

  it('keeps ordinary nodes local while treating later federation-shaped fields as opaque', async () => {
    const root = newRoot('decision-store-local-metadata-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const staged = await store.ensureRequested(request());
    expect(staged.requested_metadata).toEqual({});

    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { federation: { opaque: 'publication' } },
    });
    const resolved = await store.resolve({
      approvalId: staged.approval_id,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'slack',
      metadata: { federation: { opaque: 'resolution' } },
    });

    expect(resolved.published[0]?.reference).toEqual({
      federation: { opaque: 'publication' },
    });
    expect(resolved.resolved_metadata).toEqual({
      federation: { opaque: 'resolution' },
    });
    expect((await store.getState(request().processing_key))?.status).toBe(
      'approved',
    );
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses every operation on historical requested federation metadata without writing later slots', async () => {
    const root = newRoot('decision-store-retired-federation-');
    const store = new DecisionNodeStore(root);
    await store.initialize();
    const approvalId = decisionApprovalId(request().processing_key);
    const nodeDirectory = join(root, 'decisions', approvalId);
    mkdirSync(nodeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(nodeDirectory, 'requested.json'),
      `${JSON.stringify({
        schema_version: 1,
        event_type: 'requested',
        node_id: 'historical-federated-node',
        processing_key: request().processing_key,
        requested_at: request().requested_at,
        brief: request().brief,
        alternatives: [],
        links: { parent: null, supersedes: null },
        metadata: { federation: { historical: true } },
      })}\n`,
      { mode: 0o600 },
    );

    const operations = [
      () => store.getState(request().processing_key),
      () => store.list(),
      () => store.ensureRequested(request()),
      () =>
        store.recordPublished({
          processingKey: request().processing_key,
          surface: 'terminal',
          reference: { output: 'must-not-be-written' },
        }),
      () =>
        store.resolve({
          approvalId,
          status: 'approved',
          reviewedBy: 'operator',
          surface: 'cli',
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(/retired federation metadata/);
    }
    expect(existsSync(join(nodeDirectory, 'published-terminal.json'))).toBe(
      false,
    );
    expect(existsSync(join(nodeDirectory, 'resolved.json'))).toBe(false);
  });

  it('refuses every operation, including reads, once founder identity material appears', async () => {
    const root = newRoot('decision-store-cutover-legacy-');
    const legacyStore = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const legacy = await legacyStore.ensureRequested(request());
    await legacyStore.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });
    await legacyStore.resolve({
      approvalId: legacy.approval_id,
      status: 'approved',
      reviewedBy: 'founder',
      surface: 'slack',
      metadata: {
        slack: {
          channel_id: 'C123',
          message_ts: '1700.001',
          reviewer_user_id: 'U123',
        },
      },
    });

    const manifests = join(root, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'cutover-marker.json'), '{}\n', {
      mode: 0o600,
    });
    const activeStore = new DecisionNodeStore(root);

    const retired = /retired/;
    await expect(
      activeStore.getState(request().processing_key),
    ).rejects.toThrow(retired);
    await expect(activeStore.list()).rejects.toThrow(retired);
    await expect(
      activeStore.recordPublished({
        processingKey: request().processing_key,
        surface: 'terminal',
        reference: { output: 'must-not-be-written' },
      }),
    ).rejects.toThrow(retired);
    await expect(
      activeStore.resolve({
        approvalId: legacy.approval_id,
        status: 'approved',
        reviewedBy: 'founder',
        surface: 'slack',
      }),
    ).rejects.toThrow(retired);
    const nativeRequest = request();
    nativeRequest.processing_key = `${nativeRequest.processing_key}:native`;
    await expect(activeStore.ensureRequested(nativeRequest)).rejects.toThrow(
      retired,
    );

    // Refused before anything was written.
    expect(
      existsSync(
        join(root, 'decisions', legacy.approval_id, 'published-terminal.json'),
      ),
    ).toBe(false);
    expect(existsSync(join(root, 'decisions', legacy.approval_id))).toBe(true);
  });

  it('refuses legacy decision mutation when identity material exists without capture hooks', async () => {
    const root = newRoot('decision-store-identity-guard-');
    const manifests = join(root, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'interrupted-bootstrap.json'), '{}\n', {
      mode: 0o600,
    });

    // The shared founder-provenance retirement gate refuses the root before
    // the local decision store creates or reads a node.
    await expect(
      new DecisionNodeStore(root).ensureRequested(request()),
    ).rejects.toThrow(/retired/);
  });

});

const RECORD_NOW = '2026-08-08T12:00:00.000Z';

function recordStore(root: string): DecisionNodeStore {
  return new DecisionNodeStore(root, { now: () => RECORD_NOW });
}

async function resolvedNode(
  store: DecisionNodeStore,
): Promise<DecisionNodeState> {
  await store.ensureRequested(request());
  return await store.resolve({
    approvalId: decisionApprovalId(request().processing_key),
    status: 'approved',
    reviewedBy: 'reviewer',
    surface: 'slack',
  });
}

function envelopeInput(
  approvalId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    approvalId,
    recordEventType: 'approval' as const,
    envelopeId: 'env_00000000-0000-4000-8000-000000000001',
    idempotencyKey: approvalId,
    envelopeSha256: `sha256:${'a'.repeat(64)}`,
    envelope: { schema_version: 1, event_type: 'approval' },
    ...overrides,
  };
}

// 70 canonical base64 bytes: the size and shape of a real P-256 DER signature.
const RECEIPT_SIGNATURE =
  'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4/wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMPK0djf5g==';

function receiptIntegrity(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    canonicalization: 'RFC8785',
    payload_sha256: `sha256:${'e'.repeat(64)}`,
    signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
    key_id: `sha256:${'f'.repeat(64)}`,
    signature_base64: RECEIPT_SIGNATURE,
    ...overrides,
  };
}

function receipt(
  approvalId: string,
  overrides: Record<string, unknown> = {},
): DecisionOrganizationRecordReceipt {
  return {
    schema_version: 1,
    kind: 'echo-organization-record-receipt',
    authority_id: 'aut_1',
    organization_id: 'org_1',
    envelope_id: 'env_00000000-0000-4000-8000-000000000001',
    envelope_sha256: `sha256:${'a'.repeat(64)}`,
    installation_id: 'ins_1',
    idempotency_key: approvalId,
    position: 7,
    record_hash: `sha256:${'b'.repeat(64)}`,
    recorded_at: RECORD_NOW,
    integrity: receiptIntegrity(),
    ...overrides,
  } as unknown as DecisionOrganizationRecordReceipt;
}

describe('decision node organization record state', () => {
  it('persists the typed source locator on new requested slots', async () => {
    const root = newRoot('decision-store-source-locator-');
    const staged = await recordStore(root).ensureRequested(request());

    expect(staged.source).toEqual({
      adapter_id: 'source',
      instance_id: 'instance',
      external_id: 'item',
    });
    const stored = JSON.parse(
      readFileSync(
        join(root, 'decisions', staged.approval_id, 'requested.json'),
        'utf8',
      ),
    ) as { source: unknown };
    expect(stored.source).toEqual(staged.source);
  });

  it('reports a node stored before the locator existed as an absent locator, not an empty one', async () => {
    const root = newRoot('decision-store-legacy-locator-');
    const store = recordStore(root);
    await store.initialize();
    const approvalId = decisionApprovalId(request().processing_key);
    const nodeDirectory = join(root, 'decisions', approvalId);
    mkdirSync(nodeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(nodeDirectory, 'requested.json'),
      `${JSON.stringify({
        schema_version: 1,
        event_type: 'requested',
        node_id: 'legacy-node',
        processing_key: request().processing_key,
        requested_at: request().requested_at,
        brief: request().brief,
        alternatives: [],
        links: { parent: null, supersedes: null },
        metadata: {},
      })}\n`,
      { mode: 0o600 },
    );

    const state = await store.getState(request().processing_key);
    expect(state?.source).toBeNull();
    expect(state?.organization_record.status).toBe('unresolved');
  });

  it('freezes the outbound envelope once and returns the frozen original on repeat', async () => {
    const root = newRoot('decision-store-envelope-once-');
    const store = recordStore(root);
    const node = await resolvedNode(store);
    expect(node.organization_record.status).toBe('pending');

    const frozen = await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id),
    );
    expect(frozen.envelope).toEqual({
      schema_version: 1,
      event_type: 'approval',
    });

    // A second build attempt never rewrites the slot: retries must resend the
    // same bytes under the same idempotency key.
    const again = await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id, {
        envelopeId: 'env_00000000-0000-4000-8000-000000000002',
        envelope: { schema_version: 1, event_type: 'rebuilt' },
      }),
    );
    expect(again).toEqual(frozen);

    const reloaded = await store.getState(request().processing_key);
    expect(reloaded?.organization_record.status).toBe('outbound');
    expect(reloaded?.organization_record.envelope?.envelope_id).toBe(
      frozen.envelope_id,
    );
  });

  it('refuses an envelope for an unresolved node and an idempotency key that is not the approval id', async () => {
    const root = newRoot('decision-store-envelope-guard-');
    const store = recordStore(root);
    const staged = await store.ensureRequested(request());

    await expect(
      store.createOrganizationRecordEnvelope(envelopeInput(staged.approval_id)),
    ).rejects.toThrow(/not eligible/);

    await store.resolve({
      approvalId: staged.approval_id,
      status: 'rejected',
      reviewedBy: 'reviewer',
      surface: 'slack',
    });
    await expect(
      store.createOrganizationRecordEnvelope(
        envelopeInput(staged.approval_id, { idempotencyKey: 'f'.repeat(64) }),
      ),
    ).rejects.toThrow(/idempotency key must be the approval id/);
  });

  it('binds the record event type to the immutable resolution for direct callers', async () => {
    const approvedRoot = newRoot('decision-store-bind-approved-');
    const approvedStore = recordStore(approvedRoot);
    const approved = await resolvedNode(approvedStore);

    // An approved decision can never be submitted as a rejection act.
    await expect(
      approvedStore.createOrganizationRecordEnvelope(
        envelopeInput(approved.approval_id, { recordEventType: 'rejection' }),
      ),
    ).rejects.toThrow(
      /event type must be 'approval' for a approved decision node/,
    );
    expect(
      existsSync(
        join(
          approvedRoot,
          'decisions',
          approved.approval_id,
          'organization-record-envelope.json',
        ),
      ),
    ).toBe(false);
    // The matching pairing still works.
    expect(
      (
        await approvedStore.createOrganizationRecordEnvelope(
          envelopeInput(approved.approval_id),
        )
      ).record_event_type,
    ).toBe('approval');
    // Create-once idempotency never becomes a way to assert the wrong act.
    await expect(
      approvedStore.createOrganizationRecordEnvelope(
        envelopeInput(approved.approval_id, { recordEventType: 'rejection' }),
      ),
    ).rejects.toThrow(/event type must be 'approval'/);

    const rejectedRoot = newRoot('decision-store-bind-rejected-');
    const rejectedStore = recordStore(rejectedRoot);
    await rejectedStore.ensureRequested(request());
    const rejected = await rejectedStore.resolve({
      approvalId: decisionApprovalId(request().processing_key),
      status: 'rejected',
      reviewedBy: 'reviewer',
      surface: 'slack',
    });

    // ...and a rejected decision can never be submitted as an approval act.
    await expect(
      rejectedStore.createOrganizationRecordEnvelope(
        envelopeInput(rejected.approval_id, { recordEventType: 'approval' }),
      ),
    ).rejects.toThrow(
      /event type must be 'rejection' for a rejected decision node/,
    );
    expect(
      (
        await rejectedStore.createOrganizationRecordEnvelope(
          envelopeInput(rejected.approval_id, {
            recordEventType: 'rejection',
          }),
        )
      ).record_event_type,
    ).toBe('rejection');
  });

  it('files a verified receipt create-once and refuses one bound to other bytes', async () => {
    const root = newRoot('decision-store-receipt-');
    const store = recordStore(root);
    const node = await resolvedNode(store);
    await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id),
    );

    await expect(
      store.recordOrganizationRecordReceipt({
        approvalId: node.approval_id,
        receipt: receipt(node.approval_id, {
          envelope_sha256: `sha256:${'c'.repeat(64)}`,
        }),
      }),
    ).rejects.toThrow(/does not bind this node's frozen envelope/);

    const published = await store.recordOrganizationRecordReceipt({
      approvalId: node.approval_id,
      receipt: receipt(node.approval_id),
    });
    expect(published.organization_record.status).toBe('published');
    expect(published.organization_record.receipt?.position).toBe(7);
    expect(
      projectDecisionOrganizationRecord(published),
    ).toMatchObject({
      status: 'published',
      position: 7,
      record_hash: `sha256:${'b'.repeat(64)}`,
    });

    // Create-once: refiling never overwrites the receipt slot.
    const again = await store.recordOrganizationRecordReceipt({
      approvalId: node.approval_id,
      receipt: receipt(node.approval_id, { position: 99 }),
    });
    expect(again.organization_record.receipt?.position).toBe(7);
    await expect(
      store.recordOrganizationRecordRejection({
        approvalId: node.approval_id,
        reasonCode: 'schema_invalid',
        reason: 'too late',
      }),
    ).rejects.toThrow(/already published/);
  });

  it('files a permanent rejection create-once and then refuses a receipt', async () => {
    const root = newRoot('decision-store-rejection-');
    const store = recordStore(root);
    const node = await resolvedNode(store);
    await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id),
    );

    const rejected = await store.recordOrganizationRecordRejection({
      approvalId: node.approval_id,
      reasonCode: 'signature_invalid',
      reason: 'installation signature did not verify',
    });
    expect(rejected.reason_code).toBe('signature_invalid');
    const again = await store.recordOrganizationRecordRejection({
      approvalId: node.approval_id,
      reasonCode: 'schema_invalid',
      reason: 'second opinion',
    });
    expect(again).toEqual(rejected);

    const state = await store.getState(request().processing_key);
    expect(state?.organization_record.status).toBe('rejected');
    expect(projectDecisionOrganizationRecord(state!)).toMatchObject({
      status: 'rejected',
      rejection_reason_code: 'signature_invalid',
    });
    await expect(
      store.recordOrganizationRecordReceipt({
        approvalId: node.approval_id,
        receipt: receipt(node.approval_id),
      }),
    ).rejects.toThrow(/already rejected/);
  });

  it('round-trips the whole signed receipt, integrity block included, through the slot file', async () => {
    const root = newRoot('decision-store-receipt-roundtrip-');
    const store = recordStore(root);
    const node = await resolvedNode(store);
    await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id),
    );
    const filed = receipt(node.approval_id);

    await store.recordOrganizationRecordReceipt({
      approvalId: node.approval_id,
      receipt: filed,
    });

    // Read back from disk through a fresh store: nothing is dropped, and the
    // signature is still there to present against the org log later.
    const reloaded = await recordStore(root).getState(request().processing_key);
    expect(reloaded?.organization_record.receipt).toEqual(filed);
    const slot = JSON.parse(
      readFileSync(
        join(
          root,
          'decisions',
          node.approval_id,
          'published-organization-record.json',
        ),
        'utf8',
      ),
    ) as { surface: string; reference: unknown };
    expect(slot.surface).toBe('organization-record');
    expect(slot.reference).toEqual(filed);
  });

  it.each([
    ['absent integrity block', { integrity: undefined }],
    ['unknown top-level key', { authority_key_id: `sha256:${'0'.repeat(64)}` }],
    ['non-digest record hash', { record_hash: 'not-a-digest' }],
    ['zero position', { position: 0 }],
    ['wrong kind', { kind: 'echo-organization-enrollment-receipt' }],
  ])(
    'refuses to file a receipt with %s, leaving no published slot',
    async (_label, overrides) => {
      const root = newRoot('decision-store-receipt-invalid-');
      const store = recordStore(root);
      const node = await resolvedNode(store);
      await store.createOrganizationRecordEnvelope(
        envelopeInput(node.approval_id),
      );

      await expect(
        store.recordOrganizationRecordReceipt({
          approvalId: node.approval_id,
          receipt: receipt(node.approval_id, overrides),
        }),
      ).rejects.toThrow(/invalid decision node event/);
      expect(
        existsSync(
          join(
            root,
            'decisions',
            node.approval_id,
            'published-organization-record.json',
          ),
        ),
      ).toBe(false);
    },
  );

  it('refuses to read back a node whose receipt slot was stripped of its signature', async () => {
    const root = newRoot('decision-store-receipt-stripped-');
    const store = recordStore(root);
    const node = await resolvedNode(store);
    await store.createOrganizationRecordEnvelope(
      envelopeInput(node.approval_id),
    );
    await store.recordOrganizationRecordReceipt({
      approvalId: node.approval_id,
      receipt: receipt(node.approval_id),
    });

    const slotPath = join(
      root,
      'decisions',
      node.approval_id,
      'published-organization-record.json',
    );
    const slot = JSON.parse(readFileSync(slotPath, 'utf8')) as {
      reference: Record<string, unknown>;
    };
    delete slot.reference['integrity'];
    rmSync(slotPath);
    writeFileSync(slotPath, `${JSON.stringify(slot)}\n`, { mode: 0o600 });

    // An unsigned receipt is never a readable state, so out-of-band tampering
    // is loud rather than silently downgrading the member's evidence.
    await expect(store.getState(request().processing_key)).rejects.toThrow(
      /receipt\.integrity/,
    );
  });

  it('refuses a receipt or rejection when no envelope was ever frozen', async () => {
    const root = newRoot('decision-store-no-envelope-');
    const store = recordStore(root);
    const node = await resolvedNode(store);

    await expect(
      store.recordOrganizationRecordReceipt({
        approvalId: node.approval_id,
        receipt: receipt(node.approval_id),
      }),
    ).rejects.toThrow(/no frozen organization record envelope/);
    await expect(
      store.recordOrganizationRecordRejection({
        approvalId: node.approval_id,
        reasonCode: 'schema_invalid',
        reason: 'nothing was sent',
      }),
    ).rejects.toThrow(/no frozen organization record envelope/);
  });
});

describe('decision node submitter enumeration', () => {
  it('returns healthy nodes with structured skips while list stays fail-closed', async () => {
    const root = newRoot('decision-store-submitter-list-');
    const store = recordStore(root);
    const healthy = await store.ensureRequested(request());

    // A historical federation node and a corrupt node both sit beside it.
    const federated = decisionApprovalId('federated-key');
    const corrupt = 'b'.repeat(64);
    for (const [approvalId, body] of [
      [
        federated,
        {
          schema_version: 1,
          event_type: 'requested',
          node_id: 'historical-federated-node',
          processing_key: 'federated-key',
          requested_at: request().requested_at,
          brief: request().brief,
          alternatives: [],
          links: { parent: null, supersedes: null },
          metadata: { federation: { historical: true } },
        },
      ],
      [corrupt, { schema_version: 1, event_type: 'requested' }],
    ] as const) {
      const directory = join(root, 'decisions', approvalId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(directory, 'requested.json'),
        `${JSON.stringify(body)}\n`,
        { mode: 0o600 },
      );
    }

    // Ordinary listing keeps refusing the whole directory: an operator asking
    // "what is in my store" must not be handed a silently partial answer.
    // (The exact federation refusal is pinned by the retirement test above.)
    await expect(store.list()).rejects.toThrow();

    const listing = await store.listForSubmission();
    expect(listing.nodes.map((node) => node.approval_id)).toEqual([
      healthy.approval_id,
    ]);
    expect(
      [...listing.skipped]
        .map((skip) => [skip.approval_id, skip.reason])
        .sort(),
    ).toEqual(
      [
        [federated, 'retired_federation'],
        [corrupt, 'unreadable'],
      ].sort(),
    );
  });
});
