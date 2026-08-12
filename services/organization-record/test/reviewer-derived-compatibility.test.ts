import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  projectOrganizationRecord,
  type JsonObject,
  type OrganizationRecordAlert,
} from '../src/index.js';
import {
  OrganizationRecordDerivedStore,
  OrganizationRecordFollower,
  OrganizationRecordLogReader,
} from '../src/append.js';
import type { OrganizationRecordLogRow } from '../src/application/contracts.js';
// Deep import on purpose: the channel is not on the public entry point.
import { createReviewerEligibilityCapabilityChannel } from '../src/application/reviewer-eligibility-capability.js';
import {
  organizationRecordEnvelopeIndex,
  organizationRecordFrame,
  organizationRecordHash,
} from '../src/application/record-frame.js';
import {
  approvalEnvelope,
  AUTHORITY_ID,
  fixedClock,
  openStores,
  ORGANIZATION_ID,
  removeTemporaryDirectories,
  reviewerView,
  temporaryStateDirectory,
  TEST_REVIEWER_VALIDATOR,
} from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

/**
 * Derived compatibility for envelope v2.
 *
 * Reviewer V1 never serves from the derived store, but the follower still has
 * to behave deterministically when the log gains a reviewer-v2 record. These
 * suites pin exactly what it does: one text-free exclusion row, empty broad v1
 * collections, an unchanged v1 projection, a halt on anything unknown, and the
 * same outcome after a restart or a stopped rebuild.
 */

const digest = (seed: string): `sha256:${string}` => canonicalSha256(seed);
const APPROVAL_ID = 'e'.repeat(64);

function reviewerEnvelope(overrides: Record<string, unknown> = {}): JsonObject {
  const semantic = digest('semantic-intent');
  return {
    schema_version: 2,
    kind: 'echo-organization-record-envelope',
    event_type: 'approval',
    envelope_id: 'rec_derived_1',
    idempotency_key: APPROVAL_ID,
    payload: {
      brief: {
        schema_version: 1,
        id: 'brief_derived',
        meeting: { id: 'mtg_derived', title: 'Pricing', participants: [] },
        decisions: [
          {
            id: 'signal-decision-1',
            kind: 'decision',
            text: 'Ship the reviewer pilot.',
            subject: null,
            confidence: null,
            evidence: [{ meeting_id: 'mtg_derived', block_id: 'b1' }],
            status: 'decided',
          },
        ],
        actions: [],
        rationales: [],
        provenance: {
          meeting_revision: 'rev-1',
          processor: {
            kind: 'decision-processor',
            adapter_id: 'structured-text',
            instance_id: 'default',
            version: '1.0.0',
          },
          generated_at: '2026-08-11T11:00:00.000Z',
        },
      },
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'granola-derived-1',
      },
      alternatives: [],
      links: null,
      reviewed_at: '2026-08-11T12:00:00.000Z',
      surface: 'slack-reviewer-v1',
    },
    reviewer: {
      principal_id: 'prn_reviewer_one',
      membership_id: 'mem_reviewer_one',
      reviewed_by: 'Reviewer One',
      authorization: {
        schema_version: 2,
        kind: 'echo-organization-authorization-evidence',
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        enrollment_id: 'enr_derived',
        installation_id: 'ins_alpha',
        request_id: 'pcr_derived',
        approval_id: APPROVAL_ID,
        action: 'approve',
        request_sha256: digest('request'),
        provider_event_sha256: digest('provider-event'),
        allowed: true,
        reason_code: 'active_reviewer_restricted_notice_v1',
        principal_id: 'prn_reviewer_one',
        membership_id: 'mem_reviewer_one',
        adapter_binding_id: 'bnd_derived',
        permission_grant_id: 'pgr_derived',
        evaluated_at: '2026-08-11T12:00:00.000Z',
        authorization_audit_event_id: 'aud_derived',
        authorization_audit_entry_sha256: digest('audit-entry'),
        reviewer_release_draft_sha256: digest('release-draft'),
        approval_presentation_sha256: digest('approval-presentation'),
        semantic_intent_sha256: semantic,
        message_presentation_sha256: digest('message-presentation'),
      },
    },
    intent: {
      schema_version: 1,
      visibility: 'restricted',
      policy_id: 'restricted-reviewer-v1',
      provenance: {
        kind: 'approval-surface-confirmation-v1',
        semantic_intent_sha256: semantic,
      },
    },
    submitter: {
      installation_id: 'ins_alpha',
      submitted_at: '2026-08-11T12:00:01.000Z',
    },
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'ab'.repeat(32)}`,
      signature_base64: 'MEQCIB3Rq6iZ0mUeSAMPLEsignaturebytes==',
    },
    ...overrides,
  } as unknown as JsonObject;
}

function context() {
  const stores = openStores();
  const alerts: OrganizationRecordAlert[] = [];
  const reader = new OrganizationRecordLogReader(stores.log.database);
  const follower = new OrganizationRecordFollower({
    logReader: reader,
    derived: stores.derived,
    alert: (alert) => alerts.push(alert),
    reviewerValidator: TEST_REVIEWER_VALIDATOR,
  });
  return { stores, alerts, reader, follower };
}

function appendReviewer(
  stores: ReturnType<typeof openStores>,
  envelope: JsonObject = reviewerEnvelope(),
): void {
  const view = reviewerView(envelope);
  const channel = createReviewerEligibilityCapabilityChannel();
  const capability = channel.issue({
    organization_id: ORGANIZATION_ID,
    envelope_id: view.envelope_id,
    idempotency_key: view.idempotency_key,
    installation_id: view.installation_id,
    canonical_envelope_sha256: canonicalSha256(envelope),
    reviewer_principal_id: view.reviewer_principal_id,
    reviewer_membership_id: view.reviewer_membership_id,
    reviewer_release_draft_sha256: view.reviewer_release_draft_sha256,
    approval_presentation_sha256: view.approval_presentation_sha256,
    semantic_intent_sha256: view.semantic_intent_sha256,
    message_presentation_sha256: view.message_presentation_sha256,
    authorization_audit_event_id: view.authorization_audit_event_id,
    authorization_audit_entry_sha256: view.authorization_audit_entry_sha256,
    evaluated_at: view.evaluated_at,
  });
  stores.log.append({
    envelope: { envelope, ...organizationRecordEnvelopeIndex(envelope) },
    canonical_envelope: canonicalJson(envelope),
    envelope_sha256: canonicalSha256(envelope),
    reviewer_eligibility: { capability, channel },
  });
}

/** Writes one log row directly, as a restore or corruption would leave it. */
function graftLogRow(
  stores: ReturnType<typeof openStores>,
  envelope: JsonObject,
  eventType: 'approval' | 'rejection',
): void {
  const canonical = canonicalJson(envelope);
  const envelopeSha256 = canonicalSha256(envelope);
  const recordedAt = '2026-08-11T12:00:02.000Z';
  const recordHash = organizationRecordHash(
    organizationRecordFrame({
      organization_id: ORGANIZATION_ID,
      position: 1,
      previous_record_hash: null,
      recorded_at: recordedAt,
      envelope_sha256: envelopeSha256,
    }),
  );
  stores.log.database
    .prepare(
      `INSERT INTO organization_record_log (
         position, envelope_id, event_type, installation_id, idempotency_key,
         canonical_envelope, envelope_sha256, receipt_payload,
         previous_record_hash, record_hash, recorded_at
       ) VALUES (1, 'rec_derived_1', ?, 'ins_alpha', ?, ?, ?, '{}', NULL, ?, ?)`,
    )
    .run(
      eventType,
      APPROVAL_ID,
      canonical,
      envelopeSha256,
      recordHash,
      recordedAt,
    );
}

function appendLegacy(stores: ReturnType<typeof openStores>): void {
  const envelope = approvalEnvelope();
  stores.log.append({
    envelope: { envelope, ...organizationRecordEnvelopeIndex(envelope) },
    canonical_envelope: canonicalJson(envelope),
    envelope_sha256: canonicalSha256(envelope),
  });
}

/** One synthetic stored row, so the projector can be called in isolation. */
function reviewerRow(
  envelope: JsonObject = reviewerEnvelope(),
  overrides: Partial<OrganizationRecordLogRow> = {},
): OrganizationRecordLogRow {
  return {
    position: 1,
    envelope_id: 'rec_derived_1',
    event_type: 'approval',
    installation_id: 'ins_alpha',
    idempotency_key: APPROVAL_ID,
    canonical_envelope: canonicalJson(envelope),
    envelope_sha256: canonicalSha256(envelope),
    receipt_payload: '{}',
    previous_record_hash: null,
    record_hash: digest('record'),
    recorded_at: '2026-08-11T12:00:02.000Z',
    ...overrides,
  };
}

describe('reviewer-v2 derived compatibility', () => {
  it('projects exactly one text-free exclusion and no broad v1 content', () => {
    const projection = projectOrganizationRecord(
      reviewerRow(),
      TEST_REVIEWER_VALIDATOR,
    );
    expect(projection.reviewer_policy_exclusions).toEqual([
      {
        log_position: 1,
        record_hash: digest('record'),
        envelope_version: 2,
        policy_id: 'restricted-reviewer-v1',
        outcome: 'deferred-to-permission-aware-retrieval',
      },
    ]);
    expect(projection.atoms).toEqual([]);
    expect(projection.meeting_snapshots).toEqual([]);
    expect(projection.participant_observations).toEqual([]);
    expect(projection.rejections).toEqual([]);
    expect(projection.edges).toEqual([]);
    // No released text, title, or subject anywhere in the projection.
    expect(JSON.stringify(projection)).not.toContain('Ship the reviewer pilot');
    expect(JSON.stringify(projection)).not.toContain('Pricing');
  });

  it('commits the exclusion row and the cursor together', async () => {
    const { stores, follower } = context();
    try {
      appendReviewer(stores);
      await follower.drain();
      expect(stores.derived.cursorPosition()).toBe(1);
      expect(stores.derived.reviewerPolicyExclusions()).toEqual([
        {
          log_position: 1,
          record_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as never,
          envelope_version: 2,
          policy_id: 'restricted-reviewer-v1',
          outcome: 'deferred-to-permission-aware-retrieval',
        },
      ]);
      expect(stores.derived.atoms()).toEqual([]);
      expect(stores.derived.meetingSnapshots()).toEqual([]);
      expect(stores.derived.edges()).toEqual([]);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('denies update and delete on a committed exclusion row', async () => {
    const { stores, follower } = context();
    try {
      appendReviewer(stores);
      await follower.drain();
      expect(() =>
        stores.derived.database
          .prepare(
            'UPDATE organization_derived_reviewer_policy_exclusion SET outcome = ?',
          )
          .run('something-else'),
      ).toThrow(/is immutable/);
      expect(() =>
        stores.derived.database
          .prepare('DELETE FROM organization_derived_reviewer_policy_exclusion')
          .run(),
      ).toThrow(/cannot be deleted/);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('keeps the v1 projection byte-identical beside a reviewer record', async () => {
    const control = context();
    let v1Only: string;
    try {
      appendLegacy(control.stores);
      await control.follower.drain();
      v1Only = canonicalJson({
        atoms: control.stores.derived.atoms(),
        meeting_snapshots: control.stores.derived.meetingSnapshots(),
        participant_observations:
          control.stores.derived.participantObservations(),
        rejections: control.stores.derived.rejections(),
        edges: control.stores.derived.edges(),
      });
    } finally {
      control.stores.log.close();
      control.stores.derived.close();
    }

    const mixed = context();
    try {
      appendLegacy(mixed.stores);
      appendReviewer(mixed.stores);
      await mixed.follower.drain();
      expect(
        canonicalJson({
          atoms: mixed.stores.derived.atoms(),
          meeting_snapshots: mixed.stores.derived.meetingSnapshots(),
          participant_observations:
            mixed.stores.derived.participantObservations(),
          rejections: mixed.stores.derived.rejections(),
          edges: mixed.stores.derived.edges(),
        }),
      ).toBe(v1Only);
      expect(mixed.stores.derived.reviewerPolicyExclusions()).toHaveLength(1);
    } finally {
      mixed.stores.log.close();
      mixed.stores.derived.close();
    }
  });

  it('halts on an unknown version, an unknown kind, and a v2 rejection', async () => {
    for (const [envelope, eventType] of [
      [reviewerEnvelope({ schema_version: 3 }), 'approval'],
      [reviewerEnvelope({ kind: 'echo-something-else' }), 'approval'],
      [reviewerEnvelope({ event_type: 'rejection' }), 'rejection'],
    ] as const) {
      const { stores, follower, alerts } = context();
      try {
        // Written directly: the append path refuses an unproved reviewer-v2
        // document, so a log can only hold one of these after a restore or a
        // corruption. The follower must still halt rather than skip it.
        graftLogRow(stores, envelope, eventType);
        await follower.drain();
        // Visible staleness is the designed behavior: the cursor stays put and
        // the operator is alerted rather than the record being skipped.
        expect(follower.halted).toBe(true);
        expect(stores.derived.cursorPosition()).toBe(0);
        expect(stores.derived.reviewerPolicyExclusions()).toEqual([]);
        expect(stores.derived.atoms()).toEqual([]);
        expect(stores.derived.edges()).toEqual([]);
        expect(alerts[0]?.kind).toBe('derive-halted');
      } finally {
        stores.log.close();
        stores.derived.close();
      }
    }
  });

  it('halts on every malformed v2 the closed validator rejects', async () => {
    const malformed: readonly [string, JsonObject][] = [
      [
        'wrong intent policy',
        reviewerEnvelope({
          intent: {
            schema_version: 1,
            visibility: 'restricted',
            policy_id: 'something-else-v1',
            provenance: {
              kind: 'approval-surface-confirmation-v1',
              semantic_intent_sha256: digest('semantic-intent'),
            },
          },
        }),
      ],
      [
        'unquoted semantic intent',
        reviewerEnvelope({
          intent: {
            schema_version: 1,
            visibility: 'restricted',
            policy_id: 'restricted-reviewer-v1',
            provenance: {
              kind: 'approval-surface-confirmation-v1',
              semantic_intent_sha256: digest('a-different-intent'),
            },
          },
        }),
      ],
      ['absent reviewer', reviewerEnvelope({ reviewer: null })],
      ['absent payload', reviewerEnvelope({ payload: 'not-an-object' })],
    ];
    for (const [label, envelope] of malformed) {
      const { stores, follower, alerts } = context();
      try {
        graftLogRow(stores, envelope, 'approval');
        await follower.drain();
        expect(follower.halted, label).toBe(true);
        expect(stores.derived.cursorPosition()).toBe(0);
        expect(stores.derived.reviewerPolicyExclusions()).toEqual([]);
        expect(stores.derived.atoms()).toEqual([]);
        expect(alerts[0]?.kind).toBe('derive-halted');
      } finally {
        stores.log.close();
        stores.derived.close();
      }
    }
  });

  it('binds the envelope event type to the indexed event type', () => {
    // The row column and the signed frame must be the same fact. A row whose
    // column says `rejection` cannot derive as the approval its bytes claim.
    expect(() =>
      projectOrganizationRecord(
        reviewerRow(reviewerEnvelope(), { event_type: 'rejection' }),
        TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/does not match its indexed event type/);
  });

  it('halts a v2 record when no closed validator is injected', () => {
    // Without the injected validator there is no reviewer reading at all.
    // Legacy derive stays live; reviewer-v2 halts rather than falling back.
    expect(() => projectOrganizationRecord(reviewerRow())).toThrow(
      /requires the injected closed reviewer validator/,
    );
  });

  it('rejects a mixed projection atomically at the write boundary', async () => {
    const { stores, follower } = context();
    try {
      appendReviewer(stores);
      const valid = projectOrganizationRecord(
        stores.log.rows()[0]!,
        TEST_REVIEWER_VALIDATOR,
      );
      const exclusion = valid.reviewer_policy_exclusions[0]!;
      for (const [label, mixed] of [
        [
          'exclusion beside a broad v1 edge',
          {
            ...valid,
            edges: [
              {
                edge_type: 'derived-from' as const,
                from_id: digest('atom'),
                to_id: valid.record_hash,
                log_position: valid.log_position,
              },
            ],
          },
        ],
        [
          'two exclusions for one record',
          { ...valid, reviewer_policy_exclusions: [exclusion, exclusion] },
        ],
        [
          'an exclusion that is not the fixed outcome',
          {
            ...valid,
            reviewer_policy_exclusions: [
              { ...exclusion, outcome: 'something-else' as never },
            ],
          },
        ],
        [
          'an exclusion pointing at another record',
          {
            ...valid,
            reviewer_policy_exclusions: [
              { ...exclusion, record_hash: digest('another-record') },
            ],
          },
        ],
      ] as const) {
        expect(() => stores.derived.commitRecord(mixed), label).toThrow();
        // Rolled back whole: no row, no edge, and the cursor never moved.
        expect(stores.derived.reviewerPolicyExclusions()).toEqual([]);
        expect(stores.derived.edges()).toEqual([]);
        expect(stores.derived.cursorPosition()).toBe(0);
      }
      // The genuine projection still commits cleanly afterwards.
      await follower.drain();
      expect(stores.derived.cursorPosition()).toBe(1);
      expect(stores.derived.reviewerPolicyExclusions()).toHaveLength(1);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('keeps a v1 projection free of any exclusion', async () => {
    const { stores, follower } = context();
    try {
      appendLegacy(stores);
      const projection = projectOrganizationRecord(
        stores.log.rows()[0]!,
        TEST_REVIEWER_VALIDATOR,
      );
      expect(projection.reviewer_policy_exclusions).toEqual([]);
      expect(projection.atoms.length).toBeGreaterThan(0);
      await follower.drain();
      expect(stores.derived.reviewerPolicyExclusions()).toEqual([]);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('reproduces the same outcome after a restart and a stopped rebuild', async () => {
    const { stores, follower, reader } = context();
    try {
      appendLegacy(stores);
      appendReviewer(stores);
      await follower.drain();
      const incremental = stores.derived.contentDigest();

      // Restart: a fresh follower over the same derived file changes nothing.
      const restarted = new OrganizationRecordFollower({
        logReader: reader,
        derived: stores.derived,
        reviewerValidator: TEST_REVIEWER_VALIDATOR,
      });
      await restarted.drain();
      expect(stores.derived.contentDigest()).toBe(incremental);

      // Stopped rebuild: a fresh derived store replayed from position zero.
      const rebuiltPath = join(temporaryStateDirectory(), 'rebuilt.sqlite');
      const rebuilt = OrganizationRecordDerivedStore.open(rebuiltPath, {
        organization_id: ORGANIZATION_ID,
        clock: fixedClock(900),
      });
      try {
        await new OrganizationRecordFollower({
          logReader: reader,
          derived: rebuilt,
          batchSize: 1,
          reviewerValidator: TEST_REVIEWER_VALIDATOR,
        }).drain();
        expect(rebuilt.cursorPosition()).toBe(2);
        expect(rebuilt.contentDigest()).toBe(incremental);
        expect(rebuilt.reviewerPolicyExclusions()).toEqual(
          stores.derived.reviewerPolicyExclusions(),
        );
      } finally {
        rebuilt.close();
      }
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('includes the exclusion collection under diagnostic schema 2', async () => {
    const { stores, follower } = context();
    try {
      appendReviewer(stores);
      await follower.drain();
      expect(stores.derived.contentDigest()).toBe(
        canonicalSha256({
          kind: 'echo-organization-record-derived-content',
          schema_version: 2,
          cursor_position: 1,
          atoms: [],
          meeting_snapshots: [],
          participant_observations: [],
          rejections: [],
          edges: [],
          reviewer_policy_exclusions:
            stores.derived.reviewerPolicyExclusions() as never,
        }),
      );
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });
});
