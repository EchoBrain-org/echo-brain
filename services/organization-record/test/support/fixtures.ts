import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type {
  JsonObject,
  OrganizationRecordReceiptPayloadV1,
} from '../../src/index.js';
import type { VerifiedOrganizationRecordEnvelope } from '../../src/application/contracts.js';
import {
  organizationRecordEnvelopeIndex,
  OrganizationRecordDerivedStore,
  OrganizationRecordLogStore,
} from '../../src/index.js';

export const ORGANIZATION_ID = 'org_pilot';
export const AUTHORITY_ID = 'oau_pilot';
export const INSTALLATION_ALPHA = 'ins_alpha';
export const INSTALLATION_BETA = 'ins_beta';

const temporaryDirectories: string[] = [];

export function temporaryStateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-organization-record-'));
  temporaryDirectories.push(directory);
  return directory;
}

export function removeTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A clock that walks a fixed sequence, so every golden digest in these suites
 * is reproducible. Record time is injected precisely because it is inside the
 * hashed record frame.
 */
export function fixedClock(start = 0): () => string {
  let tick = start;
  return () => {
    const stamp = new Date(Date.UTC(2026, 7, 7, 12, 0, tick)).toISOString();
    tick += 1;
    return stamp;
  };
}

function integrity(payloadDigestSeed: string): JsonObject {
  return {
    canonicalization: 'RFC8785',
    payload_sha256: `sha256:${payloadDigestSeed.padEnd(64, '0')}`,
    signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
    key_id: `sha256:${'ab'.repeat(32)}`,
    signature_base64: 'MEQCIB3Rq6iZ0mUeSAMPLEsignaturebytes==',
  };
}

export interface ApprovalEnvelopeOptions {
  readonly envelope_id?: string;
  readonly idempotency_key?: string;
  readonly installation_id?: string;
  readonly meeting_id?: string;
  readonly meeting_revision?: string;
  readonly external_id?: string;
  readonly restricted?: boolean;
  readonly participants?: JsonObject[];
  readonly decision_text?: string;
  readonly supports_signal_ids?: string[];
}

/**
 * An approval envelope in the shape the protocol slice will own.
 *
 * The payload restates the exact `DecisionBrief` field paths core validates —
 * that duplication is deliberate in the design and is pinned by shared golden
 * fixtures rather than shared code.
 */
export function approvalEnvelope(options: ApprovalEnvelopeOptions = {}): JsonObject {
  const meetingId = options.meeting_id ?? 'mtg_roadmap';
  return {
    schema_version: 1,
    event_type: 'approval',
    envelope_id: options.envelope_id ?? 'ore_approval_1',
    idempotency_key: options.idempotency_key ?? 'a'.repeat(64),
    payload: {
      schema_version: 1,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: options.external_id ?? 'granola-meeting-1',
      },
      brief: {
        schema_version: 1,
        id: 'brief_1',
        meeting: {
          id: meetingId,
          title: 'Roadmap review',
          time: { scheduled_start_at: '2026-08-06T15:00:00.000Z' },
          participants: options.participants ?? [
            {
              id: 'p1',
              display_name: 'Zhen',
              identities: [{ kind: 'email', value: 'zhen@example.test' }],
              roles: ['organizer'],
              response_status: 'accepted',
              attendance: 'attended',
            },
            {
              id: 'p2',
              display_name: 'Sam',
              identities: [{ kind: 'email', value: 'sam@example.test' }],
              roles: ['invitee'],
              response_status: 'accepted',
              attendance: 'no_show',
            },
          ],
        },
        decisions: [
          {
            id: 's1',
            kind: 'decision',
            text: options.decision_text ?? 'Ship the record log first',
            subject: 'roadmap',
            confidence: 0.9,
            status: 'decided',
            evidence: [
              {
                meeting_id: meetingId,
                block_id: 'b1',
                quote: 'we ship the record log first',
              },
            ],
          },
        ],
        actions: [
          {
            id: 's2',
            kind: 'action',
            text: 'Draft the migration',
            subject: 'roadmap',
            confidence: null,
            owner: 'p2',
            due_at: '2026-08-14T00:00:00.000Z',
            evidence: [{ meeting_id: meetingId, block_id: 'b2' }],
          },
        ],
        rationales: [
          {
            id: 's3',
            kind: 'rationale',
            text: 'The derived graph is rebuildable, the log is not',
            subject: null,
            confidence: null,
            supports_signal_ids: options.supports_signal_ids ?? ['s1'],
            evidence: [{ meeting_id: meetingId, block_id: 'b3' }],
          },
        ],
        provenance: {
          meeting_revision: options.meeting_revision ?? 'rev-1',
          processor: {
            kind: 'decision-processor',
            adapter_id: 'structured-text',
            instance_id: 'primary',
            version: '1.0.0',
          },
          generated_at: '2026-08-06T16:00:00.000Z',
        },
      },
      alternatives: [],
      links: null,
      reviewed_at: '2026-08-06T16:30:00.000Z',
      surface: 'slack-reactions',
    },
    reviewer: {
      principal_id: 'prn_zhen',
      membership_id: 'mem_zhen',
      reviewed_by: 'Zhen',
      authorization: {
        evaluation_id: 'evl_approve_1',
        action: 'approve',
        decision: 'allowed',
        evaluated_at: '2026-08-06T16:29:00.000Z',
      },
    },
    intent: { restricted: options.restricted ?? true },
    submitter: {
      installation_id: options.installation_id ?? INSTALLATION_ALPHA,
      submitted_at: '2026-08-06T16:31:00.000Z',
    },
    integrity: integrity('11'),
  };
}

export interface RejectionEnvelopeOptions {
  readonly envelope_id?: string;
  readonly idempotency_key?: string;
  readonly installation_id?: string;
  readonly meeting_id?: string;
  readonly reason?: string | null;
  readonly reconsider_after?: string | null;
}

export function rejectionEnvelope(options: RejectionEnvelopeOptions = {}): JsonObject {
  return {
    schema_version: 1,
    event_type: 'rejection',
    envelope_id: options.envelope_id ?? 'ore_rejection_1',
    idempotency_key: options.idempotency_key ?? 'b'.repeat(64),
    payload: {
      schema_version: 1,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'granola-meeting-2',
      },
      meeting_id: options.meeting_id ?? 'mtg_pricing',
      rejected_at: '2026-08-06T17:00:00.000Z',
      reason: options.reason ?? 'Not a shared decision yet',
      reconsider_after: options.reconsider_after ?? '2026-09-01T00:00:00.000Z',
    },
    reviewer: {
      principal_id: 'prn_zhen',
      membership_id: 'mem_zhen',
      reviewed_by: 'Zhen',
      authorization: {
        evaluation_id: 'evl_reject_1',
        action: 'reject',
        decision: 'allowed',
        evaluated_at: '2026-08-06T16:59:00.000Z',
      },
    },
    intent: { restricted: true },
    submitter: {
      installation_id: options.installation_id ?? INSTALLATION_ALPHA,
      submitted_at: '2026-08-06T17:01:00.000Z',
    },
    integrity: integrity('22'),
  };
}

/**
 * A stand-in for the authority verification port.
 *
 * The real adapter runs the lease, signature, schema, and
 * authorization-evidence checks inside the authority application. This one
 * only produces the verified view, so these suites exercise the record core's
 * own behavior rather than re-testing the authority.
 */
export function acceptingVerifier(): {
  verifyEnvelope(envelope: unknown): Promise<VerifiedOrganizationRecordEnvelope>;
  calls: number;
} {
  const port = {
    calls: 0,
    async verifyEnvelope(envelope: unknown): Promise<VerifiedOrganizationRecordEnvelope> {
      port.calls += 1;
      const value = envelope as JsonObject;
      const index = organizationRecordEnvelopeIndex(value);
      return { envelope: value, ...index };
    },
  };
  return port;
}

export function rejectingVerifier(message: string): {
  verifyEnvelope(envelope: unknown): Promise<VerifiedOrganizationRecordEnvelope>;
} {
  return {
    async verifyEnvelope(): Promise<VerifiedOrganizationRecordEnvelope> {
      throw new Error(message);
    },
  };
}

/** A stand-in for the authority receipt signing key. */
export function recordingSigner(): {
  signReceipt(payload: OrganizationRecordReceiptPayloadV1): Promise<JsonObject>;
  calls: number;
  failures: number;
  failNext: boolean;
} {
  const port = {
    calls: 0,
    failures: 0,
    failNext: false,
    async signReceipt(payload: OrganizationRecordReceiptPayloadV1): Promise<JsonObject> {
      if (port.failNext) {
        port.failNext = false;
        port.failures += 1;
        throw new Error('signing key unavailable');
      }
      port.calls += 1;
      return {
        ...(payload as unknown as JsonObject),
        integrity: {
          canonicalization: 'RFC8785',
          payload_sha256: `sha256:${'cd'.repeat(32)}`,
          signature_algorithm: 'ecdsa-p256-sha256-der-low-s',
          key_id: `sha256:${'ef'.repeat(32)}`,
          signature_base64: Buffer.from(canonicalJson(payload)).toString('base64'),
        },
      };
    },
  };
  return port;
}

export interface RecordStores {
  readonly directory: string;
  readonly log: OrganizationRecordLogStore;
  readonly derived: OrganizationRecordDerivedStore;
  readonly logPath: string;
  readonly derivedPath: string;
}

/**
 * Separate clocks per database. The log clock spends tick 0 on the one-time
 * organization binding row, so record 1 is always recorded at tick 1 and the
 * golden chain digests below are stable.
 */
export function openStores(
  logClock: () => string = fixedClock(),
  derivedClock: () => string = fixedClock(100),
): RecordStores {
  const directory = temporaryStateDirectory();
  const logPath = join(directory, 'record-log.sqlite');
  const derivedPath = join(directory, 'record-derived.sqlite');
  return {
    directory,
    logPath,
    derivedPath,
    log: OrganizationRecordLogStore.open(logPath, {
      organization_id: ORGANIZATION_ID,
      authority_id: AUTHORITY_ID,
      clock: logClock,
    }),
    derived: OrganizationRecordDerivedStore.open(derivedPath, {
      organization_id: ORGANIZATION_ID,
      clock: derivedClock,
    }),
  };
}
