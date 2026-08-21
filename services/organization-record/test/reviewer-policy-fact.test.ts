import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { afterAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { JsonObject } from '../src/index.js';
import {
  MAX_REVIEWER_POLICY_FACTS,
  ReviewerPolicyFactError,
  deriveReviewerRestrictedEligibilityProof,
  projectReviewerPolicyFacts,
  readReviewerRestrictedEnvelope,
  reviewerRestrictedEligibilityProofSha256,
  reviewerSignalIdSha256,
  type OrganizationRecordReviewerPolicyFactRow,
  type ReviewerRestrictedEligibilityProofPreimage,
} from '../src/application/reviewer-policy-fact.js';
import { OrganizationRecordIngest } from '../src/application/record-ingest.js';
import { verifyReviewerFactAdmission } from '../src/log/reviewer-fact-admission.js';
// Deep imports on purpose: the eligibility channel and the read session are
// not on the public entry point, so only in-workspace code can reach them.
import {
  createReviewerEligibilityCapabilityChannel,
  type ReviewerEligibilityCapabilityChannel,
} from '../src/application/reviewer-eligibility-capability.js';
import { openReviewerReadSession } from '../src/retrieve/reviewer-policy-reader.js';
import { OrganizationRecordLogStore } from '../src/log/record-log-store.js';
import {
  organizationRecordEnvelopeIndex,
  organizationRecordFrame,
  organizationRecordHash,
  organizationRecordReceiptPayload,
} from '../src/application/record-frame.js';
import type { VerifiedOrganizationRecordEnvelope } from '../src/application/contracts.js';
import {
  approvalEnvelope,
  AUTHORITY_ID,
  fixedClock,
  INSTALLATION_ALPHA,
  openStores,
  ORGANIZATION_ID,
  recordingSigner,
  rejectionEnvelope,
  removeTemporaryDirectories,
  reviewerView,
  temporaryStateDirectory,
  TEST_REVIEWER_VALIDATOR,
} from './support/fixtures.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

afterAll(removeTemporaryDirectories);

const REVIEWER_PRINCIPAL = 'prn_reviewer_one';
const REVIEWER_MEMBERSHIP = 'mem_reviewer_one';
const OTHER_PRINCIPAL = 'prn_reviewer_two';
const OTHER_MEMBERSHIP = 'mem_reviewer_two';
const AUDIT_EVENT_ID = 'aud_reviewer_one';
const EVALUATED_AT = '2026-08-11T12:00:00.000Z';
const APPROVAL_ID = 'c'.repeat(64);

const digest = (seed: string): `sha256:${string}` => canonicalSha256(seed);

interface ReviewerEnvelopeOptions {
  readonly envelope_id?: string;
  readonly idempotency_key?: string;
  readonly installation_id?: string;
  readonly principal_id?: string;
  readonly membership_id?: string;
  readonly signals?: { id: string; kind: string; text: string }[];
  readonly semantic_intent_sha256?: string;
  readonly audit_event_id?: string;
  readonly evaluated_at?: string;
  readonly reason_code?: string;
  readonly organization_id?: string;
}

/** A reviewer-v2 approval in the shape the protocol slice owns. */
function reviewerEnvelope(options: ReviewerEnvelopeOptions = {}): JsonObject {
  const semantic = options.semantic_intent_sha256 ?? digest('semantic-intent');
  const evaluatedAt = options.evaluated_at ?? EVALUATED_AT;
  const signals = options.signals ?? [
    { id: 'signal-decision-1', kind: 'decision', text: 'Ship the pilot.' },
    { id: 'signal-action-1', kind: 'action', text: 'Draft the runbook.' },
  ];
  const byKind = (kind: string) =>
    signals
      .filter((signal) => signal.kind === kind)
      .map((signal) => ({
        id: signal.id,
        kind: signal.kind,
        text: signal.text,
        subject: null,
        confidence: null,
        evidence: [{ meeting_id: 'mtg_reviewer', block_id: 'block-1' }],
        ...(kind === 'decision' ? { status: 'decided' } : {}),
        ...(kind === 'action' ? { owner: null, due_at: null } : {}),
        ...(kind === 'rationale' ? { supports_signal_ids: [] } : {}),
      }));
  return {
    schema_version: 2,
    kind: 'echo-organization-record-envelope',
    event_type: 'approval',
    envelope_id: options.envelope_id ?? 'rec_reviewer_1',
    idempotency_key: options.idempotency_key ?? APPROVAL_ID,
    payload: {
      brief: {
        schema_version: 1,
        id: 'brief_reviewer',
        meeting: { id: 'mtg_reviewer', title: 'Pricing', participants: [] },
        decisions: byKind('decision'),
        actions: byKind('action'),
        rationales: byKind('rationale'),
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
        external_id: 'granola-reviewer-1',
      },
      alternatives: [],
      links: null,
      reviewed_at: evaluatedAt,
      surface: 'slack-reviewer-v1',
    },
    reviewer: {
      principal_id: options.principal_id ?? REVIEWER_PRINCIPAL,
      membership_id: options.membership_id ?? REVIEWER_MEMBERSHIP,
      reviewed_by: 'Reviewer One',
      authorization: {
        schema_version: 2,
        kind: 'echo-organization-authorization-evidence',
        authority_id: AUTHORITY_ID,
        organization_id: options.organization_id ?? ORGANIZATION_ID,
        enrollment_id: 'enr_reviewer',
        installation_id: options.installation_id ?? INSTALLATION_ALPHA,
        request_id: 'pcr_reviewer',
        approval_id: options.idempotency_key ?? APPROVAL_ID,
        action: 'approve',
        request_sha256: digest('request'),
        provider_event_sha256: digest('provider-event'),
        allowed: true,
        reason_code:
          options.reason_code ?? 'active_reviewer_restricted_notice_v1',
        principal_id: options.principal_id ?? REVIEWER_PRINCIPAL,
        membership_id: options.membership_id ?? REVIEWER_MEMBERSHIP,
        adapter_binding_id: 'bnd_reviewer',
        permission_grant_id: 'pgr_reviewer',
        evaluated_at: evaluatedAt,
        authorization_audit_event_id: options.audit_event_id ?? AUDIT_EVENT_ID,
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
      installation_id: options.installation_id ?? INSTALLATION_ALPHA,
      submitted_at: '2026-08-11T12:00:01.000Z',
    },
    integrity: {
      canonicalization: 'RFC8785',
      payload_sha256: digest('payload'),
      signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
      key_id: `sha256:${'ab'.repeat(32)}`,
      signature_base64: 'MEQCIB3Rq6iZ0mUeSAMPLEsignaturebytes==',
    },
  };
}

function proofPreimage(
  envelope: JsonObject,
  overrides: Partial<ReviewerRestrictedEligibilityProofPreimage> = {},
): ReviewerRestrictedEligibilityProofPreimage {
  const view = reviewerView(envelope);
  return {
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
    ...overrides,
  };
}

function verifiedEnvelope(
  envelope: JsonObject,
): VerifiedOrganizationRecordEnvelope {
  return { envelope, ...organizationRecordEnvelopeIndex(envelope) };
}

interface AppendedReviewerRecord {
  readonly log: OrganizationRecordLogStore;
  readonly database: Database.Database;
  readonly channel: ReviewerEligibilityCapabilityChannel;
  readonly envelope: JsonObject;
}

function openReviewerLog(
  beforeAppendCommit?: () => void,
  clock: () => string = fixedClock(),
): OrganizationRecordLogStore {
  return OrganizationRecordLogStore.open(
    join(temporaryStateDirectory(), 'record-log.sqlite'),
    {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      clock,
      reviewer_validator: TEST_REVIEWER_VALIDATOR,
      ...(beforeAppendCommit === undefined ? {} : { beforeAppendCommit }),
    },
  );
}

function appendReviewerRecord(
  options: {
    envelope?: JsonObject;
    log?: OrganizationRecordLogStore;
    channel?: ReviewerEligibilityCapabilityChannel;
    preimage?: ReviewerRestrictedEligibilityProofPreimage;
  } = {},
): AppendedReviewerRecord {
  const envelope = options.envelope ?? reviewerEnvelope();
  const log = options.log ?? openReviewerLog();
  const channel =
    options.channel ?? createReviewerEligibilityCapabilityChannel();
  const capability = channel.issue(
    options.preimage ?? proofPreimage(envelope),
  );
  log.append({
    envelope: verifiedEnvelope(envelope),
    canonical_envelope: canonicalJson(envelope),
    envelope_sha256: canonicalSha256(envelope),    reviewer_eligibility: { capability, channel },
  });
  return { log, database: log.database, channel, envelope };
}

/**
 * Commits a reviewer-v2 record without presenting an eligibility capability.
 *
 * This is exactly the incoherent state the contract says must never be
 * repaired and must never be readable: a canonical reviewer record whose facts
 * were not co-committed. Producing it directly is how these suites exercise
 * admission without fighting the immutability triggers that make the healthy
 * path safe.
 */
function appendReviewerRecordWithoutFacts(
  log: OrganizationRecordLogStore,
  envelope: JsonObject = reviewerEnvelope(),
): void {
  // The append path refuses this now: a reviewer-v2 document without a live
  // capability appends neither record nor facts. A restored or corrupted
  // database can still hold one, so these suites write the row directly --
  // which is exactly how such a state reaches a running Authority.
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
  const view = reviewerView(envelope);
  log.database
    .prepare(
      `INSERT INTO organization_record_log (
         position, envelope_id, event_type, installation_id, idempotency_key,
         canonical_envelope, envelope_sha256, receipt_payload,
         previous_record_hash, record_hash, recorded_at
       ) VALUES (1, ?, 'approval', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      view.envelope_id,
      view.installation_id,
      view.idempotency_key,
      canonical,
      envelopeSha256,
      canonicalJson(
        organizationRecordReceiptPayload({
          authority_id: AUTHORITY_ID,
          organization_id: ORGANIZATION_ID,
          envelope_id: view.envelope_id,
          envelope_sha256: envelopeSha256,
          installation_id: view.installation_id,
          idempotency_key: view.idempotency_key,
          position: 1,
          record_hash: recordHash,
          recorded_at: recordedAt,
        }),
      ),
      recordHash,
      recordedAt,
    );
}

function headRecordHash(database: Database.Database): `sha256:${string}` {
  const row = database
    .prepare(
      'SELECT record_hash FROM organization_record_log ORDER BY position DESC LIMIT 1',
    )
    .get() as { record_hash: `sha256:${string}` };
  return row.record_hash;
}

/** Inserts one fact directly, to build states the append path cannot produce. */
function graftFact(
  database: Database.Database,
  overrides: Partial<OrganizationRecordReviewerPolicyFactRow>,
): void {
  const envelope = reviewerView(reviewerEnvelope());
  const row: OrganizationRecordReviewerPolicyFactRow = {
    reviewer_principal_id: REVIEWER_PRINCIPAL,
    reviewer_membership_id: REVIEWER_MEMBERSHIP,
    log_position: 1,
    record_hash: headRecordHash(database),
    atom_order: 0,
    signal_id_sha256: digest('grafted-signal'),
    atom_id: digest('grafted-atom'),
    semantic_intent_sha256: envelope.semantic_intent_sha256,
    authorization_audit_event_id: envelope.authorization_audit_event_id,
    authorization_audit_entry_sha256: envelope.authorization_audit_entry_sha256,
    authorization_proof_sha256: digest('proof'),
    ...overrides,
  };
  database
    .prepare(
      `INSERT INTO organization_record_reviewer_policy_fact (
         reviewer_principal_id, reviewer_membership_id, log_position,
         record_hash, atom_order, signal_id_sha256, atom_id,
         semantic_intent_sha256, authorization_audit_event_id,
         authorization_audit_entry_sha256, authorization_proof_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.reviewer_principal_id,
      row.reviewer_membership_id,
      row.log_position,
      row.record_hash,
      row.atom_order,
      row.signal_id_sha256,
      row.atom_id,
      row.semantic_intent_sha256,
      row.authorization_audit_event_id,
      row.authorization_audit_entry_sha256,
      row.authorization_proof_sha256,
    );
}

function committedFacts(
  database: Database.Database,
): OrganizationRecordReviewerPolicyFactRow[] {
  return database
    .prepare(
      `SELECT * FROM organization_record_reviewer_policy_fact
       ORDER BY log_position, atom_order`,
    )
    .all() as OrganizationRecordReviewerPolicyFactRow[];
}

describe('reviewer public export surface', () => {
  it('publishes no capability, session, or raw-store constructor', async () => {
    const entry = (await import('../src/index.js')) as Record<string, unknown>;
    // Anything that mints append authority or takes a database handle would
    // let a composition reach protected content without the contract's fence.
    for (const forbidden of [
      'createReviewerEligibilityCapabilityChannel',
      'openReviewerReadSession',
      'REVIEWER_FACT_SELECT_SQL',
      'insertReviewerPolicyFacts',
      'reviewerPolicyFactsForAppend',
      'readReviewerPolicyFactsAtPosition',
      'verifyReviewerFactAdmission',
      'OrganizationRecordLogStore',
      'OrganizationRecordDerivedStore',
      'openOrganizationRecordDatabase',
      'openAndMigrateOrganizationRecordDatabase',
    ]) {
      expect(Object.keys(entry)).not.toContain(forbidden);
    }
    const reviewer = (await import('../src/reviewer.js')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(reviewer)).toEqual([
      'reviewerRestrictedEligibilityProofSha256',
    ]);
  });
});

describe('reviewer policy fact migration', () => {
  it('creates an empty table and backfills nothing', () => {
    const stores = openStores();
    try {
      expect(committedFacts(stores.log.database)).toEqual([]);
      // The migration cannot invent facts for records that predate it.
      stores.log.append({
        envelope: verifiedEnvelope(approvalEnvelope()),
        canonical_envelope: canonicalJson(approvalEnvelope()),
        envelope_sha256: canonicalSha256(approvalEnvelope()),      });
      expect(committedFacts(stores.log.database)).toEqual([]);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('binds the composite foreign key to one exact canonical row', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const row = committedFacts(database)[0] as OrganizationRecordReviewerPolicyFactRow;
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_record_reviewer_policy_fact (
               reviewer_principal_id, reviewer_membership_id, log_position,
               record_hash, atom_order, signal_id_sha256, atom_id,
               semantic_intent_sha256, authorization_audit_event_id,
               authorization_audit_entry_sha256, authorization_proof_sha256
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.reviewer_principal_id,
            row.reviewer_membership_id,
            row.log_position,
            digest('another-record'),
            9,
            digest('another-signal'),
            digest('another-atom'),
            row.semantic_intent_sha256,
            row.authorization_audit_event_id,
            row.authorization_audit_entry_sha256,
            row.authorization_proof_sha256,
          ),
      ).toThrow(/FOREIGN KEY|not bound to an exact verified reviewer-v2/);
    } finally {
      log.close();
    }
  });

  it('denies update and delete on a committed fact', () => {
    const { log, database } = appendReviewerRecord();
    try {
      expect(() =>
        database
          .prepare(
            `UPDATE organization_record_reviewer_policy_fact
             SET reviewer_principal_id = ?`,
          )
          .run(OTHER_PRINCIPAL),
      ).toThrow(/is immutable/);
      expect(() =>
        database
          .prepare('DELETE FROM organization_record_reviewer_policy_fact')
          .run(),
      ).toThrow(/cannot be deleted/);
    } finally {
      log.close();
    }
  });

  it('rejects a duplicate order, duplicate signal, and duplicate atom', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const row = committedFacts(database)[0] as OrganizationRecordReviewerPolicyFactRow;
      const insert = (
        overrides: Partial<OrganizationRecordReviewerPolicyFactRow>,
      ): void => {
        const next = { ...row, ...overrides };
        database
          .prepare(
            `INSERT INTO organization_record_reviewer_policy_fact (
               reviewer_principal_id, reviewer_membership_id, log_position,
               record_hash, atom_order, signal_id_sha256, atom_id,
               semantic_intent_sha256, authorization_audit_event_id,
               authorization_audit_entry_sha256, authorization_proof_sha256
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            next.reviewer_principal_id,
            next.reviewer_membership_id,
            next.log_position,
            next.record_hash,
            next.atom_order,
            next.signal_id_sha256,
            next.atom_id,
            next.semantic_intent_sha256,
            next.authorization_audit_event_id,
            next.authorization_audit_entry_sha256,
            next.authorization_proof_sha256,
          );
      };
      // Same order, new identities.
      expect(() =>
        insert({ atom_id: digest('x'), signal_id_sha256: digest('y') }),
      ).toThrow(/UNIQUE/);
      // Same signal digest, new order and atom.
      expect(() => insert({ atom_order: 5, atom_id: digest('z') })).toThrow(
        /UNIQUE/,
      );
      // Same atom id.
      expect(() =>
        insert({ atom_order: 6, signal_id_sha256: digest('w') }),
      ).toThrow(/UNIQUE|PRIMARY KEY/);
    } finally {
      log.close();
    }
  });

  it('refuses a fact whose reviewer, semantic digest, or reason contradicts its record', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const row = committedFacts(database)[0] as OrganizationRecordReviewerPolicyFactRow;
      for (const mutation of [
        { reviewer_principal_id: OTHER_PRINCIPAL },
        { reviewer_membership_id: OTHER_MEMBERSHIP },
        { semantic_intent_sha256: digest('other-semantic') },
        { authorization_audit_event_id: 'aud_other' },
        { authorization_audit_entry_sha256: digest('other-entry') },
      ]) {
        const next = { ...row, ...mutation, atom_order: 8, atom_id: digest(
          `mutated-${Object.keys(mutation)[0] as string}`,
        ), signal_id_sha256: digest(`sig-${Object.keys(mutation)[0] as string}`) };
        expect(() =>
          database
            .prepare(
              `INSERT INTO organization_record_reviewer_policy_fact (
                 reviewer_principal_id, reviewer_membership_id, log_position,
                 record_hash, atom_order, signal_id_sha256, atom_id,
                 semantic_intent_sha256, authorization_audit_event_id,
                 authorization_audit_entry_sha256, authorization_proof_sha256
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              next.reviewer_principal_id,
              next.reviewer_membership_id,
              next.log_position,
              next.record_hash,
              next.atom_order,
              next.signal_id_sha256,
              next.atom_id,
              next.semantic_intent_sha256,
              next.authorization_audit_event_id,
              next.authorization_audit_entry_sha256,
              next.authorization_proof_sha256,
            ),
        ).toThrow(/not bound to an exact verified reviewer-v2 approval/);
      }
    } finally {
      log.close();
    }
  });
});

describe('reviewer eligibility capability', () => {
  it('is single-use and burns itself even on a mismatched attempt', () => {
    const channel = createReviewerEligibilityCapabilityChannel();
    const envelope = reviewerEnvelope();
    const preimage = proofPreimage(envelope);
    const capability = channel.issue(preimage);
    const expectation = {
      organization_id: preimage.organization_id,
      envelope_id: preimage.envelope_id,
      idempotency_key: preimage.idempotency_key,
      installation_id: preimage.installation_id,
      canonical_envelope_sha256: preimage.canonical_envelope_sha256,
    };
    const consumed = channel.consume(capability, expectation);
    expect(consumed.authorization_proof_sha256).toBe(
      reviewerRestrictedEligibilityProofSha256(preimage),
    );
    expect(() => channel.consume(capability, expectation)).toThrow(
      /already consumed/,
    );

    const second = channel.issue(preimage);
    expect(() =>
      channel.consume(second, { ...expectation, envelope_id: 'rec_other' }),
    ).toThrow(/minted for another append attempt/);
    // Spent before the comparison: a rejected attempt cannot be retried.
    expect(() => channel.consume(second, expectation)).toThrow(
      /already consumed/,
    );
  });

  it('rejects forged, serialized, and cross-channel capabilities', () => {
    const channel = createReviewerEligibilityCapabilityChannel();
    const other = createReviewerEligibilityCapabilityChannel();
    const envelope = reviewerEnvelope();
    const preimage = proofPreimage(envelope);
    const expectation = {
      organization_id: preimage.organization_id,
      envelope_id: preimage.envelope_id,
      idempotency_key: preimage.idempotency_key,
      installation_id: preimage.installation_id,
      canonical_envelope_sha256: preimage.canonical_envelope_sha256,
    };
    const genuine = channel.issue(preimage);

    for (const impostor of [
      {},
      { ...preimage },
      JSON.parse(JSON.stringify(genuine)) as unknown,
      Object.create(genuine as object) as unknown,
      null,
      'capability',
    ]) {
      expect(() =>
        channel.consume(
          impostor as Parameters<typeof channel.consume>[0],
          expectation,
        ),
      ).toThrow(/not a live capability|forged or belongs to another channel/);
    }
    // Another channel never honors this channel's capability.
    expect(() => other.consume(genuine, expectation)).toThrow(
      /forged or belongs to another channel/,
    );
    // The genuine one is still unspent: a forged attempt cannot burn it.
    expect(() => channel.consume(genuine, expectation)).not.toThrow();
  });

  it('never lets the private token or a constructor escape', () => {
    const channel = createReviewerEligibilityCapabilityChannel();
    const capability = channel.issue(proofPreimage(reviewerEnvelope()));
    expect(Object.keys(capability as object)).toEqual([]);
    expect(JSON.stringify(capability)).toBe('{}');
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(channel).sort()).toEqual(['consume', 'issue']);
  });

  it('refuses to mint from a malformed durable preimage', () => {
    const channel = createReviewerEligibilityCapabilityChannel();
    const envelope = reviewerEnvelope();
    for (const override of [
      { organization_id: 'not-an-org' },
      { evaluated_at: 'yesterday' },
      { semantic_intent_sha256: 'sha256:short' as `sha256:${string}` },
      { authorization_audit_event_id: 'evt_wrong_family' },
    ]) {
      expect(() =>
        channel.issue(proofPreimage(envelope, override)),
      ).toThrow(ReviewerPolicyFactError);
    }
  });
});

describe('reviewer fact append atomicity', () => {
  it('co-commits the canonical record and its complete ordered facts', () => {
    const { log, database, envelope } = appendReviewerRecord();
    try {
      const facts = committedFacts(database);
      const view = reviewerView(envelope);
      expect(facts).toHaveLength(view.signals.length);
      expect(facts.map((fact) => fact.atom_order)).toEqual([0, 1]);
      expect(facts.map((fact) => fact.signal_id_sha256)).toEqual(
        view.signals.map((signal) => reviewerSignalIdSha256(signal.id)),
      );
      // Eleven text-free columns and nothing else.
      expect(Object.keys(facts[0] as object).sort()).toEqual(
        [
          'atom_id',
          'atom_order',
          'authorization_audit_entry_sha256',
          'authorization_audit_event_id',
          'authorization_proof_sha256',
          'log_position',
          'record_hash',
          'reviewer_membership_id',
          'reviewer_principal_id',
          'semantic_intent_sha256',
          'signal_id_sha256',
        ].sort(),
      );
      expect(JSON.stringify(facts)).not.toContain('Ship the pilot');
    } finally {
      log.close();
    }
  });

  it('rolls the record back with its facts when the commit fails', () => {
    let fail = true;
    const log = openReviewerLog(() => {
      if (fail) throw new Error('injected pre-commit failure');
    });
    try {
      expect(() => appendReviewerRecord({ log })).toThrow(
        /injected pre-commit failure/,
      );
      expect(
        log.database
          .prepare('SELECT COUNT(*) AS total FROM organization_record_log')
          .get(),
      ).toEqual({ total: 0 });
      expect(committedFacts(log.database)).toEqual([]);

      // A later attempt with a fresh capability succeeds cleanly.
      fail = false;
      appendReviewerRecord({ log });
      expect(committedFacts(log.database)).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it('rolls back when the capability is stale, spent, or cross-append', () => {
    const log = openReviewerLog();
    try {
      const envelope = reviewerEnvelope();
      const channel = createReviewerEligibilityCapabilityChannel();
          const append = (
        capability: ReturnType<ReviewerEligibilityCapabilityChannel['issue']>,
      ): void => {
        log.append({
          envelope: verifiedEnvelope(envelope),
          canonical_envelope: canonicalJson(envelope),
          envelope_sha256: canonicalSha256(envelope),          reviewer_eligibility: { capability, channel },
        });
      };
      // Minted for another envelope entirely.
      const crossAppend = channel.issue(
        proofPreimage(reviewerEnvelope({ envelope_id: 'rec_reviewer_2' })),
      );
      expect(() => append(crossAppend)).toThrow(
        /minted for another append attempt/,
      );
      // Already spent.
      const spent = channel.issue(proofPreimage(envelope));
      channel.consume(spent, {
        organization_id: ORGANIZATION_ID,
        envelope_id: 'rec_reviewer_1',
        idempotency_key: APPROVAL_ID,
        installation_id: INSTALLATION_ALPHA,
        canonical_envelope_sha256: canonicalSha256(envelope),
      });
      expect(() => append(spent)).toThrow(/already consumed/);
      expect(
        log.database
          .prepare('SELECT COUNT(*) AS total FROM organization_record_log')
          .get(),
      ).toEqual({ total: 0 });
      expect(committedFacts(log.database)).toEqual([]);
    } finally {
      log.close();
    }
  });

  it('requires a live capability for every reviewer-v2 append and duplicate', () => {
    const log = openReviewerLog();
    try {
      const envelope = reviewerEnvelope();
      const bare = {
        envelope: verifiedEnvelope(envelope),
        canonical_envelope: canonicalJson(envelope),
        envelope_sha256: canonicalSha256(envelope),      };
      // Insert path.
      expect(() => log.append(bare)).toThrow(
        /requires a live Authority-minted eligibility capability/,
      );
      // Commit one properly, then prove the duplicate path is gated too: a
      // resend without a capability cannot recover the receipt.
      appendReviewerRecord({ log });
      expect(() => log.append(bare)).toThrow(
        /requires a live Authority-minted eligibility capability/,
      );
      // And a consumed capability cannot serve a duplicate either.
      const channel = createReviewerEligibilityCapabilityChannel();
      const capability = channel.issue(proofPreimage(envelope));
      channel.consume(capability, {
        organization_id: ORGANIZATION_ID,
        envelope_id: 'rec_reviewer_1',
        idempotency_key: APPROVAL_ID,
        installation_id: INSTALLATION_ALPHA,
        canonical_envelope_sha256: canonicalSha256(envelope),
      });
      expect(() =>
        log.append({ ...bare, reviewer_eligibility: { capability, channel } }),
      ).toThrow(/already consumed/);
    } finally {
      log.close();
    }
  });

  it('refuses reviewer eligibility on a v1, rejection, or unknown envelope', () => {
    const stores = openStores();
    try {
      const legacy = approvalEnvelope();
      const channel = createReviewerEligibilityCapabilityChannel();
      expect(() =>
        stores.log.append({
          envelope: verifiedEnvelope(legacy),
          canonical_envelope: canonicalJson(legacy),
          envelope_sha256: canonicalSha256(legacy),          reviewer_eligibility: {
            capability: channel.issue(proofPreimage(reviewerEnvelope())),
            channel,
          },
        }),
      ).toThrow(/presented for a non-reviewer envelope/);
      expect(
        stores.log.database
          .prepare('SELECT COUNT(*) AS total FROM organization_record_log')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('re-derives the stored bytes and digest instead of trusting them', () => {
    const log = openReviewerLog();
    try {
      const envelope = reviewerEnvelope();
      const other = reviewerEnvelope({ envelope_id: 'rec_reviewer_9' });
      // Bytes that are not this envelope's canonicalization.
      expect(() =>
        log.append({
          envelope: verifiedEnvelope(envelope),
          canonical_envelope: canonicalJson(other),
          envelope_sha256: canonicalSha256(other),        }),
      ).toThrow(/do not bind their digest/);
      // Correct bytes, a digest of something else.
      expect(() =>
        log.append({
          envelope: verifiedEnvelope(envelope),
          canonical_envelope: canonicalJson(envelope),
          envelope_sha256: canonicalSha256(other),        }),
      ).toThrow(/do not bind their digest/);
      expect(
        log.database
          .prepare('SELECT COUNT(*) AS total FROM organization_record_log')
          .get(),
      ).toEqual({ total: 0 });
    } finally {
      log.close();
    }
  });

  it('refuses evidence that describes another envelope', () => {
    const log = openReviewerLog();
    try {
      const envelope = reviewerEnvelope();
      expect(() =>
        appendReviewerRecord({
          log,
          envelope,
          preimage: proofPreimage(envelope, {
            reviewer_principal_id: OTHER_PRINCIPAL,
          }),
        }),
      ).toThrow(/does not describe this exact canonical envelope/);
      expect(committedFacts(log.database)).toEqual([]);
    } finally {
      log.close();
    }
  });

  it('reproves a schema-v2 duplicate instead of taking the receipt shortcut', () => {
    const { log, database, envelope } = appendReviewerRecord();
    try {
          const channel = createReviewerEligibilityCapabilityChannel();
      const duplicate = log.append({
        envelope: verifiedEnvelope(envelope),
        canonical_envelope: canonicalJson(envelope),
        envelope_sha256: canonicalSha256(envelope),        reviewer_eligibility: {
          capability: channel.issue(proofPreimage(envelope)),
          channel,
        },
      });
      expect(duplicate.outcome).toBe('duplicate');
      expect(committedFacts(database)).toHaveLength(2);

      // A duplicate whose evidence no longer matches cannot return the row.
      const wrong = createReviewerEligibilityCapabilityChannel();
      expect(() =>
        log.append({
          envelope: verifiedEnvelope(envelope),
          canonical_envelope: canonicalJson(envelope),
          envelope_sha256: canonicalSha256(envelope),          reviewer_eligibility: {
            capability: wrong.issue(
              proofPreimage(envelope, {
                semantic_intent_sha256: digest('other-semantic'),
              }),
            ),
            channel: wrong,
          },
        }),
      ).toThrow(/does not describe this exact canonical envelope/);
    } finally {
      log.close();
    }
  });

  it('leaves legacy and rejection appends untouched by the fact plane', async () => {
    const stores = openStores();
    const signer = recordingSigner();
    try {
      const ingest = new OrganizationRecordIngest({
        log: stores.log,
        authority: {
          async verifyEnvelope(envelope: unknown) {
            return verifiedEnvelope(envelope as JsonObject);
          },
        },
        receiptSigner: signer,
      });
      await ingest.append(approvalEnvelope());
      expect(committedFacts(stores.log.database)).toEqual([]);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });
});

describe('reviewer append coordinator', () => {
  function reviewerProof(envelope: JsonObject) {
    const view = reviewerView(envelope);
    return {
      policy_id: 'restricted-reviewer-v1' as const,
      reviewer_principal_id: view.reviewer_principal_id,
      reviewer_membership_id: view.reviewer_membership_id,
      reviewer_release_draft_sha256: view.reviewer_release_draft_sha256,
      approval_presentation_sha256: view.approval_presentation_sha256,
      semantic_intent_sha256: view.semantic_intent_sha256,
      message_presentation_sha256: view.message_presentation_sha256,
      authorization_audit_event_id: view.authorization_audit_event_id,
      authorization_audit_entry_sha256: view.authorization_audit_entry_sha256,
      evaluated_at: view.evaluated_at,
    };
  }

  it('mints one capability per attempt and co-commits the facts', async () => {
    const stores = openStores();
    try {
      const ingest = new OrganizationRecordIngest({
        log: stores.log,
        authority: {
          async verifyEnvelope(value: unknown) {
            const envelope = value as JsonObject;
            return {
              envelope,
              ...organizationRecordEnvelopeIndex(envelope),
              reviewer_restricted_proof: reviewerProof(envelope),
            };
          },
        },
        receiptSigner: recordingSigner(),
        reviewerValidator: TEST_REVIEWER_VALIDATOR,
      });
      const first = await ingest.append(reviewerEnvelope());
      expect(first.outcome).toBe('appended');
      expect(committedFacts(stores.log.database)).toHaveLength(2);

      // A schema-v2 duplicate is reproved, never short-circuited: the port is
      // called again before the existing row may be returned.
      let verifications = 0;
      const reproving = new OrganizationRecordIngest({
        log: stores.log,
        authority: {
          async verifyEnvelope(value: unknown) {
            verifications += 1;
            const envelope = value as JsonObject;
            return {
              envelope,
              ...organizationRecordEnvelopeIndex(envelope),
              reviewer_restricted_proof: reviewerProof(envelope),
            };
          },
        },
        receiptSigner: recordingSigner(),
        reviewerValidator: TEST_REVIEWER_VALIDATOR,
      });
      const duplicate = await reproving.append(reviewerEnvelope());
      expect(duplicate.outcome).toBe('duplicate');
      expect(verifications).toBe(1);
      expect(committedFacts(stores.log.database)).toHaveLength(2);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('refuses a reviewer-v2 append when the authority returns no reviewer proof', async () => {
    const stores = openStores();
    try {
      const ingest = new OrganizationRecordIngest({
        log: stores.log,
        authority: {
          async verifyEnvelope(value: unknown) {
            const envelope = value as JsonObject;
            return { envelope, ...organizationRecordEnvelopeIndex(envelope) };
          },
        },
        receiptSigner: recordingSigner(),
        reviewerValidator: TEST_REVIEWER_VALIDATOR,
      });
      // Neither record nor facts: a reviewer-v2 document is only appendable
      // with a live capability, so an unproved one cannot reach the log at all.
      await expect(ingest.append(reviewerEnvelope())).rejects.toThrow(
        /requires a live Authority-minted eligibility capability/,
      );
      expect(
        stores.log.database
          .prepare('SELECT COUNT(*) AS total FROM organization_record_log')
          .get(),
      ).toEqual({ total: 0 });
      expect(committedFacts(stores.log.database)).toEqual([]);
      expect(
        verifyReviewerFactAdmission(stores.log.database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        }).admitted,
      ).toBe(true);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });
});

describe('reviewer fact reader boundary', () => {
  it('selects only this reviewer facts, in exact order, capped at ten', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const session = openReviewerReadSession(database, {
        caller: {
          reviewer_principal_id: REVIEWER_PRINCIPAL,
          reviewer_membership_id: REVIEWER_MEMBERSHIP,
        },
        request_sha256: digest('request-1'),
        limit: MAX_REVIEWER_POLICY_FACTS,
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      const facts = session.readFacts();
      expect(facts.map((fact) => fact.atom_order)).toEqual([0, 1]);

      const stranger = openReviewerReadSession(database, {
        caller: {
          reviewer_principal_id: OTHER_PRINCIPAL,
          reviewer_membership_id: OTHER_MEMBERSHIP,
        },
        request_sha256: digest('request-2'),
        limit: MAX_REVIEWER_POLICY_FACTS,
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(stranger.readFacts()).toEqual([]);

      // A replacement membership for the same principal inherits nothing.
      const replacement = openReviewerReadSession(database, {
        caller: {
          reviewer_principal_id: REVIEWER_PRINCIPAL,
          reviewer_membership_id: OTHER_MEMBERSHIP,
        },
        request_sha256: digest('request-3'),
        limit: MAX_REVIEWER_POLICY_FACTS,
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(replacement.readFacts()).toEqual([]);
    } finally {
      log.close();
    }
  });

  it('uses the exact composite index and reads no content column', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT reviewer_principal_id, log_position, atom_order
           FROM organization_record_reviewer_policy_fact
           INDEXED BY organization_record_reviewer_policy_fact_by_reviewer
           WHERE reviewer_principal_id = ? AND reviewer_membership_id = ?
           ORDER BY log_position DESC, atom_order ASC
           LIMIT 10`,
        )
        .all(REVIEWER_PRINCIPAL, REVIEWER_MEMBERSHIP) as { detail: string }[];
      expect(plan.map((step) => step.detail).join(' ')).toContain(
        'organization_record_reviewer_policy_fact_by_reviewer',
      );
      // The fact table physically holds no content column to leak.
      const columns = (
        database
          .prepare(
            `SELECT name FROM pragma_table_info('organization_record_reviewer_policy_fact')`,
          )
          .all() as { name: string }[]
      ).map((column) => column.name);
      expect(columns).not.toContain('text');
      expect(columns).not.toContain('canonical_envelope');
      expect(columns).toHaveLength(11);
    } finally {
      log.close();
    }
  });

  it('releases content only through a live binding of its own ordered facts', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const open = () =>
        openReviewerReadSession(database, {
          caller: {
            reviewer_principal_id: REVIEWER_PRINCIPAL,
            reviewer_membership_id: REVIEWER_MEMBERSHIP,
          },
          request_sha256: digest('request-1'),
          limit: MAX_REVIEWER_POLICY_FACTS,
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        });

      const session = open();
      const facts = session.readFacts();
      session.readAuthorizationReferences();
      const binding = session.bindResolvedFacts(facts);
      const items = session.readBoundCanonicalRecords(binding);
      expect(items).toEqual([
        { kind: 'decision', text: 'Ship the pilot.' },
        { kind: 'action', text: 'Draft the runbook.' },
      ]);
      // Single use in every direction.
      expect(() => session.readFacts()).toThrow(/cannot move from/);
      expect(() => session.readBoundCanonicalRecords(binding)).toThrow(
        /cannot move from/,
      );

      // A different session's binding is worthless here.
      const first = open();
      const second = open();
      const firstFacts = first.readFacts();
      const secondFacts = second.readFacts();
      first.readAuthorizationReferences();
      second.readAuthorizationReferences();
      second.bindResolvedFacts(secondFacts);
      const foreign = first.bindResolvedFacts(firstFacts);
      expect(() => second.readBoundCanonicalRecords(foreign)).toThrow(
        /issued by another session or request/,
      );
    } finally {
      log.close();
    }
  });

  it('refuses partial, reordered, copied, and forged bindings', () => {
    const { log, database } = appendReviewerRecord();
    try {
      const open = () =>
        openReviewerReadSession(database, {
          caller: {
            reviewer_principal_id: REVIEWER_PRINCIPAL,
            reviewer_membership_id: REVIEWER_MEMBERSHIP,
          },
          request_sha256: digest('request-1'),
          limit: MAX_REVIEWER_POLICY_FACTS,
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        });

      for (const mutate of [
        (facts: readonly OrganizationRecordReviewerPolicyFactRow[]) =>
          facts.slice(0, 1),
        (facts: readonly OrganizationRecordReviewerPolicyFactRow[]) =>
          [...facts].reverse(),
        (facts: readonly OrganizationRecordReviewerPolicyFactRow[]) =>
          facts.map((fact) => ({ ...fact })),
        (facts: readonly OrganizationRecordReviewerPolicyFactRow[]) =>
          JSON.parse(JSON.stringify(facts)) as typeof facts,
      ]) {
        const session = open();
        const facts = session.readFacts();
        session.readAuthorizationReferences();
        expect(() => session.bindResolvedFacts(mutate(facts))).toThrow(
          /must quote this session ordered facts exactly/,
        );
      }

      const session = open();
      const facts = session.readFacts();
      session.readAuthorizationReferences();
      session.bindResolvedFacts(facts);
      expect(() =>
        session.readBoundCanonicalRecords(
          {} as Parameters<typeof session.readBoundCanonicalRecords>[0],
        ),
      ).toThrow(/issued by another session or request/);
    } finally {
      log.close();
    }
  });

  it('denies the whole request when a selected fact stops reprojecting', () => {
    const log = openReviewerLog();
    const { database } = log;
    try {
      // A reviewer record whose facts were never co-committed, then a fact
      // grafted on afterwards. It satisfies every check SQLite can make and
      // still cannot reproject: the reader must deny the whole request.
      appendReviewerRecordWithoutFacts(log);
      graftFact(database, {
        atom_order: 0,
        signal_id_sha256: digest('a-signal-this-record-never-released'),
        atom_id: digest('an-atom-this-record-never-derived'),
      });

      const session = openReviewerReadSession(database, {
        caller: {
          reviewer_principal_id: REVIEWER_PRINCIPAL,
          reviewer_membership_id: REVIEWER_MEMBERSHIP,
        },
        request_sha256: digest('request-1'),
        limit: MAX_REVIEWER_POLICY_FACTS,
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      const facts = session.readFacts();
      session.readAuthorizationReferences();
      const binding = session.bindResolvedFacts(facts);
      expect(() => session.readBoundCanonicalRecords(binding)).toThrow(
        /does not reproject from its canonical record/,
      );
    } finally {
      log.close();
    }
  });
});

describe('reviewer log-fact integrity admission', () => {
  it('admits a healthy log across a restart and offers no repair', () => {
    const directory = temporaryStateDirectory();
    const path = join(directory, 'record-log.sqlite');
    const first = OrganizationRecordLogStore.open(path, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      clock: fixedClock(),
      reviewer_validator: TEST_REVIEWER_VALIDATOR,
    });
    appendReviewerRecord({ log: first });
    first.close();

    // Restart against the same file.
    const restarted = OrganizationRecordLogStore.open(path, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      clock: fixedClock(),
      reviewer_validator: TEST_REVIEWER_VALIDATOR,
    });
    try {
      const admission = verifyReviewerFactAdmission(restarted.database, {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(admission).toMatchObject({
        admitted: true,
        reviewer_records_verified: 1,
        reviewer_facts_verified: 2,
        failures: [],
      });
      // Admission is a verifier, not a writer: it repairs nothing.
      expect(committedFacts(restarted.database)).toHaveLength(2);
    } finally {
      restarted.close();
    }
  });

  it('admits an empty log and a log of legacy records only', () => {
    const stores = openStores();
    try {
      expect(
        verifyReviewerFactAdmission(stores.log.database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        }).admitted,
      ).toBe(true);
      stores.log.append({
        envelope: verifiedEnvelope(approvalEnvelope()),
        canonical_envelope: canonicalJson(approvalEnvelope()),
        envelope_sha256: canonicalSha256(approvalEnvelope()),      });
      expect(
        verifyReviewerFactAdmission(stores.log.database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        }),
      ).toMatchObject({ admitted: true, reviewer_records_verified: 0 });
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('refuses admission for missing and incomplete facts, and repairs neither', () => {
    const log = openReviewerLog();
    const { database } = log;
    try {
      // A reviewer record that committed with no facts at all.
      appendReviewerRecordWithoutFacts(log);
      const missing = verifyReviewerFactAdmission(database, {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(missing.admitted).toBe(false);
      expect(missing.failures[0]).toMatchObject({
        position: 1,
        kind: 'facts_missing',
      });
      // The verifier writes nothing: no backfill, no reconstruction.
      expect(committedFacts(database)).toEqual([]);

      // One of two facts present is incomplete, not repairable.
      const expected = projectReviewerPolicyFacts({
        envelope: reviewerView(reviewerEnvelope()),
        log_position: 1,
        record_hash: headRecordHash(database),
        organization_id: ORGANIZATION_ID,
        canonical_envelope_sha256: canonicalSha256(reviewerEnvelope()),
      });
      graftFact(database, expected[0] as OrganizationRecordReviewerPolicyFactRow);
      const incomplete = verifyReviewerFactAdmission(database, {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(incomplete.admitted).toBe(false);
      expect(incomplete.failures[0]).toMatchObject({
        position: 1,
        kind: 'facts_incomplete',
      });
      expect(committedFacts(database)).toHaveLength(1);
    } finally {
      log.close();
    }
  });

  it('refuses admission when committed facts do not reproject from their record', () => {
    const log = openReviewerLog();
    const { database } = log;
    try {
      appendReviewerRecordWithoutFacts(log);
      // Two facts that pass every SQL guard and still derive from nothing this
      // record released.
      graftFact(database, {
        atom_order: 0,
        signal_id_sha256: digest('unreleased-signal-0'),
        atom_id: digest('underived-atom-0'),
      });
      graftFact(database, {
        atom_order: 1,
        signal_id_sha256: digest('unreleased-signal-1'),
        atom_id: digest('underived-atom-1'),
      });
      const admission = verifyReviewerFactAdmission(database, {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(admission.admitted).toBe(false);
      expect(admission.failures[0]).toMatchObject({
        position: 1,
        kind: 'facts_mismatched',
      });
      expect(committedFacts(database)).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it('refuses an orphan fact at insert and stays unadmitted', () => {
    const log = openReviewerLog();
    const { database } = log;
    try {
      appendReviewerRecordWithoutFacts(log);
      graftFact(database, { atom_order: 0 });
      // A fact that names a position and hash no canonical row holds.
      expect(() =>
        graftFact(database, {
          atom_order: 2,
          record_hash: digest('no-such-record'),
          atom_id: digest('orphan-atom'),
          signal_id_sha256: digest('orphan-signal'),
        }),
      ).toThrow(/FOREIGN KEY|not bound to an exact verified reviewer-v2/);
      expect(
        verifyReviewerFactAdmission(database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        }).admitted,
      ).toBe(false);
    } finally {
      log.close();
    }
  });
});

describe('reviewer authorization proof recomputation', () => {
  /** The proof digest the canonical envelope actually derives. */
  function derivedProof(envelope: JsonObject = reviewerEnvelope()): string {
    return deriveReviewerRestrictedEligibilityProof({
      organization_id: ORGANIZATION_ID,
      canonical_envelope_sha256: canonicalSha256(envelope),
      envelope: reviewerView(envelope),
    }).authorization_proof_sha256;
  }

  it('writes only the independently derived digest at append', () => {
    const { log, database, envelope } = appendReviewerRecord();
    try {
      const expected = derivedProof(envelope);
      expect(
        committedFacts(database).map((fact) => fact.authorization_proof_sha256),
      ).toEqual([expected, expected]);
      // The preimage is closed: it never quotes its own output.
      expect(
        JSON.stringify(proofPreimage(envelope)),
      ).not.toContain('authorization_proof_sha256');
    } finally {
      log.close();
    }
  });

  it('rejects a consistent forged proof digest at admission and at read', () => {
    const log = openReviewerLog();
    const { database } = log;
    try {
      appendReviewerRecordWithoutFacts(log);
      // The whole record's fact set agrees on one forged digest, so nothing
      // internal to the table contradicts it. Only an independent derivation
      // from the canonical envelope can catch this.
      const forged = digest('a-forged-but-perfectly-consistent-proof');
      const projected = projectReviewerPolicyFacts({
        envelope: reviewerView(reviewerEnvelope()),
        log_position: 1,
        record_hash: headRecordHash(database),
        organization_id: ORGANIZATION_ID,
        canonical_envelope_sha256: canonicalSha256(reviewerEnvelope()),
      });
      expect(forged).not.toBe(derivedProof());
      for (const row of projected) {
        graftFact(database, { ...row, authorization_proof_sha256: forged });
      }
      expect(committedFacts(database)).toHaveLength(2);

      const admission = verifyReviewerFactAdmission(database, {
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      expect(admission.admitted).toBe(false);
      expect(admission.failures.map((failure) => failure.kind)).toContain(
        'facts_mismatched',
      );
      expect(admission.audit_expectations).toEqual([]);

      const session = openReviewerReadSession(database, {
        caller: {
          reviewer_principal_id: REVIEWER_PRINCIPAL,
          reviewer_membership_id: REVIEWER_MEMBERSHIP,
        },
        request_sha256: digest('request-1'),
        limit: MAX_REVIEWER_POLICY_FACTS,
        organization_id: ORGANIZATION_ID,
        authority_id: AUTHORITY_ID,
        reviewer_validator: TEST_REVIEWER_VALIDATOR,
      });
      const facts = session.readFacts();
      session.readAuthorizationReferences();
      const binding = session.bindResolvedFacts(facts);
      expect(() => session.readBoundCanonicalRecords(binding)).toThrow(
        /does not reproject from its canonical record/,
      );
    } finally {
      log.close();
    }
  });

  it('rejects tampered canonical bytes and a tampered envelope digest', () => {
    for (const tamper of [
      `UPDATE organization_record_log SET canonical_envelope = '{"tampered":true}'`,
      `UPDATE organization_record_log SET envelope_sha256 = '${digest('elsewhere')}'`,
      // Valid JSON that is not its own RFC 8785 canonicalization.
      `UPDATE organization_record_log SET canonical_envelope = ' {"b":1,"a":2}'`,
    ]) {
      const { log, database } = appendReviewerRecord();
      try {
        database.exec(`
          DROP TRIGGER organization_record_log_immutable_update;
        `);
        database.exec(tamper);

        const admission = verifyReviewerFactAdmission(database, {
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        });
        expect(admission.admitted, tamper).toBe(false);

        const session = openReviewerReadSession(database, {
          caller: {
            reviewer_principal_id: REVIEWER_PRINCIPAL,
            reviewer_membership_id: REVIEWER_MEMBERSHIP,
          },
          request_sha256: digest('request-1'),
          limit: MAX_REVIEWER_POLICY_FACTS,
          organization_id: ORGANIZATION_ID,
          authority_id: AUTHORITY_ID,
          reviewer_validator: TEST_REVIEWER_VALIDATOR,
        });
        const facts = session.readFacts();
        session.readAuthorizationReferences();
        const binding = session.bindResolvedFacts(facts);
        let released: unknown;
        expect(() => {
          released = session.readBoundCanonicalRecords(binding);
        }, tamper).toThrow();
        // Nothing was released before the byte and digest checks ran.
        expect(released).toBeUndefined();
      } finally {
        log.close();
      }
    }
  });
});

describe('transaction-owned record time', () => {
  /** A clock that counts every sample and stamps a distinct second. */
  function countingClock(): { tick: () => string; calls: number } {
    const counter = {
      calls: 0,
      tick: (): string => {
        const stamp = new Date(
          Date.UTC(2026, 7, 11, 12, 0, counter.calls),
        ).toISOString();
        counter.calls += 1;
        return stamp;
      },
    };
    return counter;
  }

  it('samples once for a new append and never for a duplicate', () => {
    const clock = countingClock();
    const log = openReviewerLog(undefined, () => clock.tick());
    try {
      // Tick 0 is spent on the one-time organization binding row.
      expect(clock.calls).toBe(1);
      const { envelope } = appendReviewerRecord({ log });
      expect(clock.calls).toBe(2);
      const appended = log.rows()[0]!;
      expect(appended.recorded_at).toBe('2026-08-11T12:00:01.000Z');

      // A schema-v2 duplicate still consumes a fresh capability and reproves
      // the committed fact set, and still stamps no new record time.
      const fresh = createReviewerEligibilityCapabilityChannel();
      const duplicate = log.append({
        envelope: verifiedEnvelope(envelope),
        canonical_envelope: canonicalJson(envelope),
        envelope_sha256: canonicalSha256(envelope),
        reviewer_eligibility: {
          capability: fresh.issue(proofPreimage(envelope)),
          channel: fresh,
        },
      });
      expect(duplicate.outcome).toBe('duplicate');
      expect(duplicate.row.recorded_at).toBe(appended.recorded_at);
      expect(clock.calls).toBe(2);
      expect(committedFacts(log.database)).toHaveLength(2);
    } finally {
      log.close();
    }
  });

  it('samples nothing on a legacy duplicate or an idempotency conflict', () => {
    const clock = countingClock();
    const stores = openStores(() => clock.tick());
    try {
      const legacy = approvalEnvelope();
      const append = (value: JsonObject): void => {
        stores.log.append({
          envelope: verifiedEnvelope(value),
          canonical_envelope: canonicalJson(value),
          envelope_sha256: canonicalSha256(value),
        });
      };
      expect(clock.calls).toBe(1);
      append(legacy);
      expect(clock.calls).toBe(2);
      append(legacy);
      expect(clock.calls).toBe(2);
      expect(() =>
        append(approvalEnvelope({ decision_text: 'Something else' })),
      ).toThrow();
      expect(clock.calls).toBe(2);
      expect(stores.log.rows()).toHaveLength(1);
    } finally {
      stores.log.close();
      stores.derived.close();
    }
  });

  it('samples once and rolls back when the commit fails', () => {
    const clock = countingClock();
    let fail = true;
    const log = openReviewerLog(
      () => {
        if (fail) throw new Error('injected pre-commit failure');
      },
      () => clock.tick(),
    );
    try {
      expect(clock.calls).toBe(1);
      expect(() => appendReviewerRecord({ log })).toThrow(
        /injected pre-commit failure/,
      );
      // The sample happened inside the transaction that rolled back, so the
      // value it produced is gone with the record.
      expect(clock.calls).toBe(2);
      expect(log.rows()).toEqual([]);
      expect(committedFacts(log.database)).toEqual([]);

      fail = false;
      appendReviewerRecord({ log });
      expect(clock.calls).toBe(3);
      expect(log.rows()[0]!.recorded_at).toBe('2026-08-11T12:00:02.000Z');
    } finally {
      log.close();
    }
  });

  it('takes no recorded_at from any caller', () => {
    const log = openReviewerLog();
    try {
      const envelope = reviewerEnvelope();
      const channel = createReviewerEligibilityCapabilityChannel();
      log.append({
        envelope: verifiedEnvelope(envelope),
        canonical_envelope: canonicalJson(envelope),
        envelope_sha256: canonicalSha256(envelope),
        // @ts-expect-error `recorded_at` is not an append input.
        recorded_at: '1999-01-01T00:00:00.000Z',
        reviewer_eligibility: {
          capability: channel.issue(proofPreimage(envelope)),
          channel,
        },
      });
      expect(log.rows()[0]!.recorded_at).not.toBe('1999-01-01T00:00:00.000Z');
    } finally {
      log.close();
    }
  });
});

describe('reviewer fact projector', () => {
  it('is the one shared derivation every caller reuses', () => {
    const envelope = reviewerEnvelope();
    const view = reviewerView(envelope);
    const rows = projectReviewerPolicyFacts({
      envelope: view,
      log_position: 1,
      record_hash: digest('record'),
      organization_id: ORGANIZATION_ID,
      canonical_envelope_sha256: canonicalSha256(envelope),
    });
    expect(rows.map((row) => row.atom_order)).toEqual([0, 1]);
    expect(rows[0]?.atom_id).toBe(
      canonicalSha256({
        kind: 'echo-organization-record-atom',
        record_hash: digest('record'),
        signal_id: 'signal-decision-1',
      }),
    );
    // The proof digest is derived, never accepted. There is no input a caller
    // could use to feed a stored digest back as the projector's expectation.
    expect(rows.map((row) => row.authorization_proof_sha256)).toEqual([
      reviewerRestrictedEligibilityProofSha256(proofPreimage(envelope)),
      reviewerRestrictedEligibilityProofSha256(proofPreimage(envelope)),
    ]);
  });

  it('refuses an unknown version, a rejection, and an out-of-bounds package', () => {
    expect(() =>
      readReviewerRestrictedEnvelope(
        approvalEnvelope() as unknown as JsonObject,
        TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/kind or schema version is unsupported/);
    expect(() =>
      readReviewerRestrictedEnvelope(
        {
          ...reviewerEnvelope(),
          event_type: 'rejection',
        },
        TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/admits approval only/);
    expect(() =>
      readReviewerRestrictedEnvelope(
        reviewerEnvelope({
          signals: Array.from({ length: 11 }, (_unused, index) => ({
            id: `signal-decision-${index}`,
            kind: 'decision',
            text: `Decision ${index}.`,
          })),
        }),
        TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/must release 1 to 10 signals/);
    expect(() =>
      readReviewerRestrictedEnvelope(
        reviewerEnvelope({ reason_code: 'active_membership_and_direct_grant' }),
        TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/is not the closed allow/);
  });

  it('names its gates: v1, rejection, and unknown are separately refused', () => {
    // Each of these is a distinct closed gate, exercised by the exact document
    // that should trip it and no other.
    const gates: readonly [string, JsonObject, RegExp][] = [
      // Dispatch, before any field is interpreted.
      [
        'schema-v1 approval',
        approvalEnvelope() as unknown as JsonObject,
        /kind or schema version is unsupported/,
      ],
      [
        'schema-v1 rejection',
        rejectionEnvelope() as unknown as JsonObject,
        /kind or schema version is unsupported/,
      ],
      [
        'unknown version',
        reviewerEnvelope() as JsonObject,
        /kind or schema version is unsupported/,
      ],
      [
        'unknown kind',
        { ...reviewerEnvelope(), kind: 'echo-something-else' },
        /kind or schema version is unsupported/,
      ],
      // Closed validation, once the pair selected the reviewer family.
      [
        'v2 rejection',
        { ...reviewerEnvelope(), event_type: 'rejection' },
        /admits approval only/,
      ],
      [
        'another organization',
        reviewerEnvelope({ organization_id: 'org_somewhere_else' }),
        /does not name this organization/,
      ],
    ];
    for (const [label, document, expected] of gates) {
      const value =
        label === 'unknown version'
          ? ({ ...document, schema_version: 3 } as JsonObject)
          : document;
      expect(
        () => readReviewerRestrictedEnvelope(value, TEST_REVIEWER_VALIDATOR),
        label,
      ).toThrow(expected);
    }
  });

  it('refuses reviewer-v2 handling with no injected validator at all', () => {
    expect(() =>
      readReviewerRestrictedEnvelope(
        reviewerEnvelope(),
        undefined as unknown as typeof TEST_REVIEWER_VALIDATOR,
      ),
    ).toThrow(/requires the injected closed reviewer validator/);
  });

  it('keeps the record workspace free of an organization-protocol edge', async () => {
    // The closed validator is injected precisely so this edge never exists.
    // If it ever appears, the port has stopped being the only reviewer-v2
    // reading this workspace has.
    const workspace = fileURLToPath(new URL('..', import.meta.url));
    const sources: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts')) sources.push(path);
      }
    };
    await walk(join(workspace, 'src'));
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) {
      expect(await readFile(path, 'utf8'), path).not.toContain(
        '@echo-brain/organization-protocol',
      );
    }
    const manifest = JSON.parse(
      await readFile(join(workspace, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(
      '@echo-brain/organization-protocol',
    );
  });
});
