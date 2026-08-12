import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { JsonObject } from '@echo-brain/federation-protocol';
import {
  createOrganizationIngestExclusion,
  OrganizationRecordSubmitter,
  type BuiltOrganizationRecordEnvelope,
  type OrganizationRecordCandidateNode,
  type OrganizationRecordEnvelopeBuildInput,
  type OrganizationRecordFrozenEnvelope,
  type OrganizationIngestExclusionConfig,
  type OrganizationRecordNodeListing,
  type OrganizationRecordNodeStore,
  type OrganizationRecordSubmission,
  type OrganizationRecordSubmissionResult,
  type VerifiedOrganizationRecordReceipt,
} from '../../src/product/organization/record/index.js';

const APPROVAL_ID = 'a'.repeat(64);
const INSTALLATION_ID = 'ins_0000000000000001';
const NOW = '2026-08-08T12:00:00.000Z';

function evidence(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    schema_version: 1,
    kind: 'echo-organization-authorization-evidence',
    authority_id: 'aut_1',
    organization_id: 'org_1',
    enrollment_id: 'enr_1',
    installation_id: INSTALLATION_ID,
    request_id: 'pcr_1',
    approval_id: APPROVAL_ID,
    action: 'approve',
    request_sha256: `sha256:${'1'.repeat(64)}`,
    provider_event_sha256: `sha256:${'2'.repeat(64)}`,
    allowed: true,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: 'prn_1',
    membership_id: 'mem_1',
    adapter_binding_id: 'bnd_1',
    permission_grant_id: 'pgr_1',
    evaluated_at: NOW,
    ...overrides,
  };
}

function node(
  overrides: Partial<OrganizationRecordCandidateNode> = {},
): OrganizationRecordCandidateNode {
  return {
    approval_id: APPROVAL_ID,
    status: 'approved',
    reviewed_at: '2026-08-08T11:00:00.000Z',
    reviewed_by: 'Reviewer Name',
    reason: null,
    resolved_surface: 'slack',
    resolved_metadata: { authorization: evidence() },
    brief: { meeting: { id: 'meeting-1' } },
    alternatives: [],
    links: { parent: null, supersedes: null },
    source: {
      adapter_id: 'granola',
      instance_id: 'primary',
      external_id: 'meeting-external-1',
    },
    organization_record: { status: 'pending', envelope: null },
    ...overrides,
  };
}

interface StoreCalls {
  created: unknown[];
  receipts: unknown[];
  rejections: unknown[];
}

function fakeStore(
  listing: OrganizationRecordNodeListing,
): OrganizationRecordNodeStore & { calls: StoreCalls } {
  const calls: StoreCalls = { created: [], receipts: [], rejections: [] };
  return {
    calls,
    async listForSubmission() {
      return listing;
    },
    async createOrganizationRecordEnvelope(input) {
      calls.created.push(input);
      return {
        record_event_type: input.recordEventType,
        envelope_id: input.envelopeId,
        idempotency_key: input.idempotencyKey,
        envelope_sha256: input.envelopeSha256,
        envelope: input.envelope,
      };
    },
    async recordOrganizationRecordReceipt(input) {
      calls.receipts.push(input);
      return undefined;
    },
    async recordOrganizationRecordRejection(input) {
      calls.rejections.push(input);
      return undefined;
    },
  };
}

function envelopeValue(marker = 'approval'): JsonObject {
  return { schema_version: 1, event_type: marker, payload: { id: APPROVAL_ID } };
}

function fakeBuilder(envelope: JsonObject = envelopeValue()) {
  const inputs: OrganizationRecordEnvelopeBuildInput[] = [];
  return {
    inputs,
    async build(
      input: OrganizationRecordEnvelopeBuildInput,
    ): Promise<BuiltOrganizationRecordEnvelope> {
      inputs.push(input);
      return {
        envelope_id: 'env_1',
        idempotency_key: input.approval_id,
        event_type: input.event_type,
        envelope,
      };
    },
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
  envelope: JsonObject,
  overrides: Record<string, unknown> = {},
): VerifiedOrganizationRecordReceipt {
  return {
    schema_version: 1,
    kind: 'echo-organization-record-receipt',
    authority_id: 'aut_1',
    organization_id: 'org_1',
    envelope_id: 'env_1',
    envelope_sha256: canonicalSha256(envelope),
    installation_id: INSTALLATION_ID,
    idempotency_key: APPROVAL_ID,
    position: 3,
    record_hash: `sha256:${'d'.repeat(64)}`,
    recorded_at: NOW,
    integrity: receiptIntegrity(),
    ...overrides,
  } as unknown as VerifiedOrganizationRecordReceipt;
}

function fakeClient(
  ...results: OrganizationRecordSubmissionResult[]
): {
  sent: OrganizationRecordSubmission[];
  submitRecord(
    submission: OrganizationRecordSubmission,
  ): Promise<OrganizationRecordSubmissionResult>;
} {
  const sent: OrganizationRecordSubmission[] = [];
  let index = 0;
  return {
    sent,
    async submitRecord(submission) {
      sent.push(submission);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result === undefined) throw new Error('no result configured');
      return result;
    },
  };
}

function submitter(options: {
  store: OrganizationRecordNodeStore;
  builder: { build: (input: OrganizationRecordEnvelopeBuildInput) => Promise<BuiltOrganizationRecordEnvelope> };
  client: {
    submitRecord: (
      submission: OrganizationRecordSubmission,
    ) => Promise<OrganizationRecordSubmissionResult>;
  };
  exclusions?: Partial<OrganizationIngestExclusionConfig>;
}): OrganizationRecordSubmitter {
  const exclusions = options.exclusions ?? {};
  return new OrganizationRecordSubmitter({
    nodes: options.store,
    envelopes: options.builder,
    client: options.client,
    installationId: INSTALLATION_ID,
    exclusion: createOrganizationIngestExclusion({
      sources: exclusions.sources ?? [],
      meetings: exclusions.meetings ?? [],
    }),
    now: () => NOW,
  });
}

describe('organization record submitter', () => {
  it('builds, freezes, sends, and files a verified receipt for an authorized approval', async () => {
    const envelope = envelopeValue();
    const store = fakeStore({ nodes: [node()], skipped: [] });
    const builder = fakeBuilder(envelope);
    const client = fakeClient({ outcome: 'accepted', receipt: receipt(envelope) });

    const result = await submitter({ store, builder, client }).sweep();

    expect(result).toMatchObject({
      ok: true,
      examined: 1,
      published: 1,
      excluded: 0,
      skipped: 0,
      rejected: 0,
      retried: 0,
    });
    expect(builder.inputs[0]).toMatchObject({
      event_type: 'approval',
      approval_id: APPROVAL_ID,
      meeting_id: 'meeting-1',
      reviewed_by: 'Reviewer Name',
      surface: 'slack',
      submitted_at: NOW,
    });
    expect(builder.inputs[0]?.authorization).toEqual(evidence());
    expect(store.calls.created).toEqual([
      {
        approvalId: APPROVAL_ID,
        recordEventType: 'approval',
        envelopeId: 'env_1',
        idempotencyKey: APPROVAL_ID,
        envelopeSha256: canonicalSha256(envelope),
        envelope,
      },
    ]);
    expect(client.sent).toHaveLength(1);
    expect(store.calls.receipts).toEqual([
      { approvalId: APPROVAL_ID, receipt: receipt(envelope) },
    ]);
  });

  it('sends a rejection envelope for a rejected node whose evidence authorized the reject action', async () => {
    const envelope = envelopeValue('rejection');
    const store = fakeStore({
      nodes: [
        node({
          status: 'rejected',
          reason: 'not now',
          resolved_metadata: { authorization: evidence({ action: 'reject' }) },
        }),
      ],
      skipped: [],
    });
    const builder = fakeBuilder(envelope);
    const client = fakeClient({ outcome: 'accepted', receipt: receipt(envelope) });

    const result = await submitter({ store, builder, client }).sweep();

    expect(result.published).toBe(1);
    expect(builder.inputs[0]).toMatchObject({
      event_type: 'rejection',
      reason: 'not now',
      brief: null,
    });
  });

  it.each([
    ['absent evidence', {}, /carries no authorization evidence/],
    [
      'denied evidence',
      { authorization: evidence({ allowed: false }) },
      /not an allow decision/,
    ],
    [
      'evidence for another approval',
      { authorization: evidence({ approval_id: 'b'.repeat(64) }) },
      /belongs to another approval/,
    ],
    [
      'evidence authorizing the other action',
      { authorization: evidence({ action: 'reject' }) },
      /does not record the 'approve' action/,
    ],
    [
      'evidence missing a verified principal',
      { authorization: evidence({ principal_id: '' }) },
      /missing principal_id/,
    ],
    [
      'evidence issued to another installation',
      { authorization: evidence({ installation_id: 'ins_other' }) },
      /was issued to another installation/,
    ],
    [
      'evidence with a malformed request digest',
      { authorization: evidence({ request_sha256: 'sha256:short' }) },
      /request_sha256 is not a sha256 digest/,
    ],
  ])(
    'skips a node with %s, building and sending nothing',
    async (_label, metadata, expected) => {
      const store = fakeStore({
        nodes: [node({ resolved_metadata: metadata as JsonObject })],
        skipped: [],
      });
      const builder = fakeBuilder();
      const client = fakeClient({ outcome: 'retry', reason: 'unused' });

      const result = await submitter({ store, builder, client }).sweep();

      expect(result).toMatchObject({ ok: false, skipped: 1, published: 0 });
      expect(result.alerts[0]).toMatchObject({
        code: 'authorization_evidence_invalid',
        approval_id: APPROVAL_ID,
      });
      expect(result.alerts[0]?.detail).toMatch(expected);
      expect(builder.inputs).toHaveLength(0);
      expect(store.calls.created).toHaveLength(0);
      expect(client.sent).toHaveLength(0);
    },
  );

  it('produces no envelope of either event type for an excluded source or meeting', async () => {
    const builder = fakeBuilder();
    const client = fakeClient({ outcome: 'retry', reason: 'unused' });
    const store = fakeStore({
      nodes: [
        node(),
        node({
          approval_id: 'c'.repeat(64),
          status: 'rejected',
          resolved_metadata: {
            authorization: evidence({
              approval_id: 'c'.repeat(64),
              action: 'reject',
            }),
          },
          source: {
            adapter_id: 'granola',
            instance_id: 'other',
            external_id: 'excluded-meeting',
          },
        }),
      ],
      skipped: [],
    });

    const result = await submitter({
      store,
      builder,
      client,
      exclusions: {
        sources: [{ adapter_id: 'granola', instance_id: 'primary' }],
        meetings: [
          {
            source: { adapter_id: 'granola', instance_id: 'other' },
            external_id: 'excluded-meeting',
          },
        ],
      },
    }).sweep();

    expect(result).toMatchObject({ ok: true, examined: 2, excluded: 2 });
    expect(builder.inputs).toHaveLength(0);
    expect(store.calls.created).toHaveLength(0);
    expect(client.sent).toHaveLength(0);
  });

  it('re-checks exclusion before resending an already frozen envelope', async () => {
    const envelope = envelopeValue();
    const frozen: OrganizationRecordFrozenEnvelope = {
      record_event_type: 'approval',
      envelope_id: 'env_1',
      idempotency_key: APPROVAL_ID,
      envelope_sha256: canonicalSha256(envelope),
      envelope,
    };
    const store = fakeStore({
      nodes: [node({ organization_record: { status: 'outbound', envelope: frozen } })],
      skipped: [],
    });
    const builder = fakeBuilder(envelope);
    const client = fakeClient({ outcome: 'accepted', receipt: receipt(envelope) });

    const result = await submitter({
      store,
      builder,
      client,
      exclusions: {
        sources: [{ adapter_id: 'granola', instance_id: 'primary' }],
      },
    }).sweep();

    expect(result).toMatchObject({ excluded: 1, published: 0 });
    expect(client.sent).toHaveLength(0);
  });

  it('resends the exact frozen bytes after a transient failure without rebuilding', async () => {
    const envelope = envelopeValue();
    const digest = canonicalSha256(envelope);
    const store = fakeStore({ nodes: [node()], skipped: [] });
    const builder = fakeBuilder(envelope);
    const transient = fakeClient({ outcome: 'retry', reason: 'connection reset' });

    const first = await submitter({ store, builder, client: transient }).sweep();
    expect(first).toMatchObject({ retried: 1, published: 0, ok: true });
    // A transient failure creates no terminal slot.
    expect(store.calls.receipts).toHaveLength(0);
    expect(store.calls.rejections).toHaveLength(0);

    // The next cycle finds the node outbound and resends the frozen bytes.
    const frozen: OrganizationRecordFrozenEnvelope = {
      record_event_type: 'approval',
      envelope_id: 'env_1',
      idempotency_key: APPROVAL_ID,
      envelope_sha256: digest,
      envelope,
    };
    const second = fakeStore({
      nodes: [node({ organization_record: { status: 'outbound', envelope: frozen } })],
      skipped: [],
    });
    const rebuilder = fakeBuilder({ schema_version: 1, event_type: 'rebuilt' });
    const accepting = fakeClient({
      outcome: 'accepted',
      receipt: receipt(envelope),
    });

    const retry = await submitter({
      store: second,
      builder: rebuilder,
      client: accepting,
    }).sweep();

    expect(retry.published).toBe(1);
    expect(rebuilder.inputs).toHaveLength(0);
    expect(second.calls.created).toHaveLength(0);
    expect(accepting.sent).toEqual([
      {
        envelope_id: 'env_1',
        idempotency_key: APPROVAL_ID,
        envelope_sha256: digest,
        envelope,
      },
    ]);
    expect(transient.sent[0]?.envelope_sha256).toBe(digest);
  });

  it('refuses to send a frozen envelope whose bytes no longer match its pinned digest', async () => {
    const tampered: OrganizationRecordFrozenEnvelope = {
      record_event_type: 'approval',
      envelope_id: 'env_1',
      idempotency_key: APPROVAL_ID,
      envelope_sha256: canonicalSha256(envelopeValue()),
      envelope: { schema_version: 1, event_type: 'tampered' },
    };
    const store = fakeStore({
      nodes: [
        node({ organization_record: { status: 'outbound', envelope: tampered } }),
      ],
      skipped: [],
    });
    const client = fakeClient({ outcome: 'retry', reason: 'unused' });

    const result = await submitter({
      store,
      builder: fakeBuilder(),
      client,
    }).sweep();

    expect(result.alerts[0]?.code).toBe('envelope_digest_mismatch');
    expect(client.sent).toHaveLength(0);
  });

  it('files a permanent rejection loudly and never files an unbound receipt', async () => {
    const envelope = envelopeValue();
    const rejecting = fakeStore({ nodes: [node()], skipped: [] });
    const rejected = await submitter({
      store: rejecting,
      builder: fakeBuilder(envelope),
      client: fakeClient({
        outcome: 'rejected',
        reason_code: 'schema_invalid',
        reason: 'payload failed validation',
      }),
    }).sweep();

    expect(rejected).toMatchObject({ ok: false, rejected: 1 });
    expect(rejecting.calls.rejections).toEqual([
      {
        approvalId: APPROVAL_ID,
        reasonCode: 'schema_invalid',
        reason: 'payload failed validation',
      },
    ]);
    expect(rejected.alerts[0]).toMatchObject({ code: 'permanently_rejected' });

    const unbound = fakeStore({ nodes: [node()], skipped: [] });
    const mismatched = await submitter({
      store: unbound,
      builder: fakeBuilder(envelope),
      client: fakeClient({
        outcome: 'accepted',
        receipt: receipt(envelope, { installation_id: 'ins_other' }),
      }),
    }).sweep();

    expect(mismatched.alerts[0]).toMatchObject({
      code: 'receipt_binding_mismatch',
    });
    expect(mismatched.alerts[0]?.detail).toMatch(
      /belongs to another installation/,
    );
    expect(unbound.calls.receipts).toHaveLength(0);
  });

  it('reports skipped legacy nodes as alerts without stalling the rest of the sweep', async () => {
    const envelope = envelopeValue();
    const store = fakeStore({
      nodes: [node(), node({ approval_id: 'e'.repeat(64), source: null })],
      skipped: [
        {
          approval_id: 'f'.repeat(64),
          reason: 'retired_federation',
          detail: 'decision node uses retired federation metadata',
        },
        {
          approval_id: '0'.repeat(64),
          reason: 'unreadable',
          detail: 'invalid decision node event (node_id)',
        },
      ],
    });

    const runner = submitter({
      store,
      builder: fakeBuilder(envelope),
      client: fakeClient({ outcome: 'accepted', receipt: receipt(envelope) }),
    });
    const result = await runner.sweep();

    // The healthy node still lands.
    expect(result.published).toBe(1);
    expect(result.alerts.map((alert) => alert.code)).toEqual([
      'retired_federation_node',
      'node_unreadable',
      'source_locator_missing',
    ]);

    const repeated = await runner.sweep();
    expect(repeated.ok).toBe(false);
    expect(repeated.alerts.map((alert) => alert.code)).toEqual([
      'retired_federation_node',
      'node_unreadable',
      'source_locator_missing',
    ]);
  });

  it.each([
    ['absent integrity block', { integrity: undefined }, /no integrity block/],
    [
      'wrong signature algorithm',
      { integrity: receiptIntegrity({ signature_algorithm: 'ed25519' }) },
      /signature algorithm is unsupported/,
    ],
    [
      'empty signature',
      { integrity: receiptIntegrity({ signature_base64: '' }) },
      /carries no signature/,
    ],
  ])(
    'never files a receipt with %s',
    async (_label, overrides, expected) => {
      const envelope = envelopeValue();
      const store = fakeStore({ nodes: [node()], skipped: [] });

      const result = await submitter({
        store,
        builder: fakeBuilder(envelope),
        client: fakeClient({
          outcome: 'accepted',
          receipt: receipt(envelope, overrides),
        }),
      }).sweep();

      expect(result.alerts[0]).toMatchObject({
        code: 'receipt_binding_mismatch',
      });
      expect(result.alerts[0]?.detail).toMatch(expected);
      expect(store.calls.receipts).toHaveLength(0);
      // The node stays outbound and loud, so the next cycle can retry.
      expect(store.calls.rejections).toHaveLength(0);
    },
  );

  it('contains a throwing envelope builder to its own node', async () => {
    const envelope = envelopeValue();
    const store = fakeStore({
      nodes: [
        node({
          approval_id: 'c'.repeat(64),
          resolved_metadata: {
            authorization: evidence({ approval_id: 'c'.repeat(64) }),
          },
        }),
        node(),
      ],
      skipped: [],
    });
    const failing = {
      async build(input: OrganizationRecordEnvelopeBuildInput) {
        if (input.approval_id !== APPROVAL_ID) {
          throw new Error('installation signing key is unavailable');
        }
        return {
          envelope_id: 'env_1',
          idempotency_key: input.approval_id,
          event_type: input.event_type,
          envelope,
        };
      },
    };

    const result = await submitter({
      store,
      builder: failing,
      client: fakeClient({ outcome: 'accepted', receipt: receipt(envelope) }),
    }).sweep();

    // The healthy node still lands even though the first node threw.
    expect(result).toMatchObject({ ok: false, examined: 2, published: 1 });
    expect(result.alerts).toEqual([
      {
        code: 'submit_failed',
        approval_id: 'c'.repeat(64),
        detail: 'installation signing key is unavailable',
      },
    ]);
  });

  it('treats an unresolved node as nothing to do and a terminal node as complete', async () => {
    const frozen: OrganizationRecordFrozenEnvelope = {
      record_event_type: 'approval',
      envelope_id: 'env_1',
      idempotency_key: APPROVAL_ID,
      envelope_sha256: canonicalSha256(envelopeValue()),
      envelope: envelopeValue(),
    };
    const store = fakeStore({
      nodes: [
        node({
          status: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          resolved_surface: null,
          resolved_metadata: null,
          organization_record: { status: 'unresolved', envelope: null },
        }),
        node({
          approval_id: 'c'.repeat(64),
          organization_record: { status: 'published', envelope: frozen },
        }),
        node({
          approval_id: 'd'.repeat(64),
          organization_record: { status: 'rejected', envelope: frozen },
        }),
      ],
      skipped: [],
    });
    const client = fakeClient({ outcome: 'retry', reason: 'unused' });

    const result = await submitter({
      store,
      builder: fakeBuilder(),
      client,
    }).sweep();

    expect(result).toMatchObject({ ok: true, examined: 3, published: 0 });
    expect(result).toMatchObject({ excluded: 0, skipped: 0, retried: 0 });
    expect(client.sent).toHaveLength(0);
  });
});

const REVIEWER_EVALUATED_AT = '2026-08-08T11:30:00.000Z';

function reviewerEvidence(overrides: JsonObject = {}): JsonObject {
  return {
    ...evidence({
      schema_version: 2,
      reason_code: 'active_reviewer_restricted_notice_v1',
      evaluated_at: REVIEWER_EVALUATED_AT,
      authorization_audit_event_id: 'aud_1',
      authorization_audit_entry_sha256: `sha256:${'3'.repeat(64)}`,
      reviewer_release_draft_sha256: `sha256:${'4'.repeat(64)}`,
      approval_presentation_sha256: `sha256:${'5'.repeat(64)}`,
      semantic_intent_sha256: `sha256:${'6'.repeat(64)}`,
      message_presentation_sha256: `sha256:${'7'.repeat(64)}`,
    }),
    ...overrides,
  };
}

function reviewerNode(
  overrides: Partial<OrganizationRecordCandidateNode> = {},
): OrganizationRecordCandidateNode {
  return node({
    reviewed_at: REVIEWER_EVALUATED_AT,
    resolved_surface: 'slack-reviewer-v1',
    resolved_metadata: { authorization: reviewerEvidence() },
    ...overrides,
  });
}

describe('organization record submitter reviewer gating', () => {
  it('builds a reviewer envelope from complete schema-v2 evidence', async () => {
    const envelope = envelopeValue();
    const store = fakeStore({ nodes: [reviewerNode()], skipped: [] });
    const builder = fakeBuilder(envelope);
    const client = fakeClient({
      outcome: 'accepted',
      receipt: receipt(envelope),
    });

    const result = await submitter({ store, builder, client }).sweep();

    expect(result).toMatchObject({ skipped: 0 });
    expect(builder.inputs).toHaveLength(1);
    expect(builder.inputs[0]?.surface).toBe('slack-reviewer-v1');
    expect(builder.inputs[0]?.reviewed_at).toBe(REVIEWER_EVALUATED_AT);
  });

  it.each([
    [
      'a reviewer rejection',
      reviewerNode({
        status: 'rejected',
        resolved_metadata: {
          authorization: reviewerEvidence({ action: 'reject' }),
        },
      }),
      /cannot record a rejection/,
    ],
    [
      'reviewer evidence on the landed schema-v1 surface',
      reviewerNode({ resolved_surface: 'slack' }),
      /requires the reviewer resolution surface/,
    ],
    [
      'a resolution time that contradicts the evidence',
      reviewerNode({ reviewed_at: '2026-08-08T11:31:00.000Z' }),
      /does not match its authorization evidence/,
    ],
    [
      'reviewer evidence missing its audit event id',
      reviewerNode({
        resolved_metadata: {
          authorization: reviewerEvidence({
            authorization_audit_event_id: '',
          }),
        },
      }),
      /missing authorization_audit_event_id/,
    ],
    [
      'reviewer evidence with a malformed proof digest',
      reviewerNode({
        resolved_metadata: {
          authorization: reviewerEvidence({
            semantic_intent_sha256: 'sha256:short',
          }),
        },
      }),
      /semantic_intent_sha256 is not a sha256 digest/,
    ],
    [
      'the reviewer reason on schema-v1 evidence',
      node({
        resolved_metadata: {
          authorization: evidence({
            reason_code: 'active_reviewer_restricted_notice_v1',
          }),
        },
      }),
      /requires schema version 2 evidence/,
    ],
  ])(
    'skips %s, building and sending nothing',
    async (_label, candidate, expected) => {
      const store = fakeStore({ nodes: [candidate], skipped: [] });
      const builder = fakeBuilder();
      const client = fakeClient({ outcome: 'retry', reason: 'unused' });

      const result = await submitter({ store, builder, client }).sweep();

      expect(result).toMatchObject({ ok: false, skipped: 1, published: 0 });
      expect(result.alerts[0]).toMatchObject({
        code: 'authorization_evidence_invalid',
      });
      expect(result.alerts[0]?.detail).toMatch(expected);
      expect(builder.inputs).toHaveLength(0);
      expect(client.sent).toHaveLength(0);
    },
  );
});
