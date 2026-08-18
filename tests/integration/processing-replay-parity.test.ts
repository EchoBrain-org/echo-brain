import { Buffer } from 'node:buffer';
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  organizationAuthorityPinSha256,
  validateOrganizationRecordEnvelope,
  verifyOrganizationAuthorityPin,
  type CanonicalPayloadSigner,
  type OrganizationAuthorityDescriptorV1,
} from '@echo-brain/organization-protocol';
import {
  AdapterRegistry,
  approvedBriefDigest,
  meetingProcessingKey,
  type AdapterConfig,
  type AdapterHealth,
  type ApprovalDecision,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import { createStructuredTextDecisionProcessor } from '@echo-brain/organization-authority/processing/adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import { decisionApprovalId } from '@echo-brain/organization-authority/processing/approval/decision-node.js';
import type { ApprovalOutcomeEvent } from '@echo-brain/organization-authority/processing/approval/approval-outcome-instrument.js';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '@echo-brain/organization-authority/processing/record/protocol-record-envelope-builder.js';
import type {
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordEnvelopeBuildInput,
} from '@echo-brain/organization-authority/processing/record/ports.js';
import {
  ManifestSyntheticApprovalGate,
  SYNTHETIC_REPLAY_CLOCK,
  SyntheticDeliveryCapture,
  SyntheticMonotonicCoreStateStore,
  createSyntheticReplayHarness,
  syntheticObservationId,
  type SyntheticReplayManifest,
  type SyntheticReviewDirective,
} from '@echo-brain/organization-authority/processing/replay/synthetic-replay.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';

const corpusPath = new URL(
  '../product/fixtures/phase1-synthetic-replay-corpus.v1.json',
  import.meta.url,
);
const directories: string[] = [];

type Outcome = 'accept' | 'edit' | 'reject';

interface CorpusEntry {
  batch: { meetings: MeetingDocument[] };
  metadata: {
    fixture_id: string;
    meeting_type: string;
    reviewer_capacity_eligible: false;
  };
  resolution: {
    outcome: Outcome;
    instructions:
      | { operation: 'accept' | 'reject' }
      | {
          operation: 'replace';
          target: 'decision[0].text';
          replacement: string;
        };
  };
}

interface SyntheticCorpus {
  manifest: { corpus_kind: 'synthetic' };
  batches: CorpusEntry[];
}

interface GeneratedKey {
  descriptor: P256SigningKeyDescriptor;
  privateKey: KeyObject;
  sign: CanonicalPayloadSigner;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function generatedKey(): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(der)) throw new Error('unexpected key export');
  return {
    descriptor: {
      key_id: p256KeyId(der),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: der.toString('base64'),
    },
    privateKey,
    sign: async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: privateKey,
          dsaEncoding: 'der',
        }),
      ),
  };
}

function fixedId(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

function loadCorpus(): SyntheticCorpus {
  return JSON.parse(readFileSync(corpusPath, 'utf8')) as SyntheticCorpus;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function replayManifest(corpus: SyntheticCorpus): SyntheticReplayManifest {
  return {
    observations: Object.fromEntries(
      corpus.batches.map((entry) => {
        const meeting = entry.batch.meetings[0]!;
        let directive: SyntheticReviewDirective;
        if (entry.resolution.outcome === 'edit') {
          if (entry.resolution.instructions.operation !== 'replace') {
            throw new Error('synthetic edit has no replacement instruction');
          }
          directive = {
            disposition: 'edit',
            instructions: entry.resolution.instructions,
          };
        } else {
          directive = { disposition: entry.resolution.outcome };
        }
        return [syntheticObservationId(meeting), directive];
      }),
    ),
  };
}

function validConfig(_config: AdapterConfig) {
  return { ok: true as const, errors: [] };
}

async function healthy(): Promise<AdapterHealth> {
  return { status: 'healthy', checked_at: SYNTHETIC_REPLAY_CLOCK };
}

function machineStateDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-replay-parity-')));
  directories.push(root);
  return join(root, 'state');
}

function nextSyntheticId(): () => string {
  let next = 0;
  return () => `synthetic-id-${String(++next).padStart(6, '0')}`;
}

function approvalOutcome(decision: ApprovalDecision | null): Outcome | null {
  if (decision === null || decision.status === 'pending') return null;
  if (decision.status === 'rejected') return 'reject';
  return decision.reason === 'synthetic edit' ? 'edit' : 'accept';
}

function authorizationEvidence(input: {
  approvalId: string;
  action: 'approve' | 'reject';
  index: number;
}): OrganizationRecordAuthorizationEvidence {
  return {
    schema_version: 1,
    kind: 'echo-organization-authorization-evidence',
    authority_id: fixedId('oau', 1),
    organization_id: fixedId('org', 1),
    enrollment_id: fixedId('enr', 1),
    installation_id: fixedId('ins', 1),
    request_id: `pcr_00000000-0000-4000-8000-${String(input.index + 1).padStart(12, '0')}`,
    approval_id: input.approvalId,
    action: input.action,
    request_sha256: canonicalSha256(`synthetic-request-${input.index}`),
    provider_event_sha256: canonicalSha256(
      `synthetic-provider-event-${input.index}`,
    ),
    allowed: true,
    reason_code: 'synthetic_replay_allow',
    principal_id: fixedId('prn', 1),
    membership_id: fixedId('mem', 1),
    adapter_binding_id: fixedId('bnd', 1),
    permission_grant_id: `pgr_00000000-0000-4000-8000-${String(input.index + 1).padStart(12, '0')}`,
    evaluated_at: SYNTHETIC_REPLAY_CLOCK,
  };
}

describe('Phase 1 direct-versus-machine synthetic replay parity', () => {
  it('matches the full deterministic key chain and reports the limits of shared-engine wiring parity', async () => {
    const corpus = deepFreeze(loadCorpus());
    const corpusBefore = digest(corpus);
    const meetings = corpus.batches.map((entry) => entry.batch.meetings[0]!);
    const manifest = replayManifest(corpus);
    const forbiddenFetch = vi.fn(() => {
      throw new Error('network use is forbidden during synthetic replay');
    });
    vi.stubGlobal('fetch', forbiddenFetch);

    const direct = createSyntheticReplayHarness(manifest);
    const directResult = await direct.run(meetings);

    const machineState = new SyntheticMonotonicCoreStateStore();
    const machineGate = new ManifestSyntheticApprovalGate(manifest);
    const machineDelivery = new SyntheticDeliveryCapture();
    const machineOutcomeEvents: ApprovalOutcomeEvent[] = [];
    const source: MeetingSourceAdapter = {
      identity: meetings[0]!.provenance.source,
      validateConfig: validConfig,
      healthCheck: healthy,
      pull: async () => ({
        meetings,
        next_cursor: 'synthetic-corpus-complete',
      }),
    };
    const processor = createStructuredTextDecisionProcessor(
      {
        adapter_id: 'structured-text',
        instance_id: 'synthetic-replay',
        settings: {},
      },
      { now: () => SYNTHETIC_REPLAY_CLOCK },
    );
    const registry = new AdapterRegistry();
    registry.register(source);
    registry.register(processor);
    registry.register(machineDelivery);
    const config = validateProductRuntimeConfig({
      schema_version: 1,
      lane: 'team-product',
      state_dir: machineStateDirectory(),
      meeting_sources: [
        { adapter_id: 'synthetic-source', instance_id: 'fixture', settings: {} },
      ],
      decision_processor: {
        adapter_id: 'structured-text',
        instance_id: 'synthetic-replay',
        settings: {},
      },
      delivery_surfaces: [
        {
          adapter_id: 'synthetic-delivery-capture',
          instance_id: 'offline',
          settings: {},
        },
      ],
      approval_mode: 'manual',
    });
    const composition = await prepareProductComposition(config, registry, {
      classifyStateFilesystem: async () => ({ kind: 'local', raw: 'fixture' }),
      state: machineState,
      approvalGate: machineGate,
      approvalOutcomeInstrumentation: {
        instrument: {
          record: async (event) => void machineOutcomeEvents.push(event),
        },
        classification: {
          synthetic: true,
          reviewer_capacity_eligible: false,
        },
      },
      now: () => SYNTHETIC_REPLAY_CLOCK,
      createId: nextSyntheticId(),
    });

    try {
      const machineResult = await composition.runOnce();
      expect(machineResult).toMatchObject({
        ok: true,
        meetings_seen: 30,
        meetings_processed: 24,
        meetings_rejected: 6,
        meetings_pending: 0,
        meetings_dead_lettered: 0,
        deliveries: 24,
      });
      expect(machineResult.sources[0]?.result).toMatchObject({
        cursor_advanced: true,
        failures: [],
        dead_letters: [],
      });
      expect(await machineState.getSourceCursor(source.identity)).toBe(
        'synthetic-corpus-complete',
      );

      expect(directResult.snapshots).toHaveLength(30);
      expect(directResult.events).toHaveLength(30);
      expect(machineGate.events).toHaveLength(30);
      expect(machineOutcomeEvents).toHaveLength(30);
      expect(machineOutcomeEvents.map((event) => event.outcome)).toEqual(
        corpus.batches.map((entry) => entry.resolution.outcome),
      );
      expect(
        machineOutcomeEvents.every(
          (event, index) =>
            event.synthetic &&
            !event.reviewer_capacity_eligible &&
            event.decision_type === corpus.batches[index]!.metadata.meeting_type &&
            event.source.external_id ===
              corpus.batches[index]!.batch.meetings[0]!.provenance.external_id,
        ),
      ).toBe(true);
      expect(directResult.events.map((event) => event.disposition)).toEqual(
        corpus.batches.map((entry) => entry.resolution.outcome),
      );
      expect(machineGate.events.map((event) => event.disposition)).toEqual(
        corpus.batches.map((entry) => entry.resolution.outcome),
      );
      expect(
        directResult.events.every(
          (event) =>
            event.synthetic && !event.reviewer_capacity_eligible,
        ),
      ).toBe(true);

      const parityReport = [];
      for (const [index, entry] of corpus.batches.entries()) {
        const meeting = entry.batch.meetings[0]!;
        const directSnapshot = directResult.snapshots[index]!;
        const processingKey = meetingProcessingKey(meeting, processor);
        const approvalId = decisionApprovalId(processingKey);
        const machineDecisions =
          (await machineState.getDecisionSet(
            processingKey,
            meeting,
            processor.identity,
          )) ??
          null;
        const machineApproval =
          (await machineState.getApproval(processingKey)) ?? null;
        const directDecisionDigest = digest(directSnapshot.decision_set);
        const machineDecisionDigest = digest(machineDecisions);
        const directApprovalDigest =
          directSnapshot.approval?.status === 'approved'
            ? approvedBriefDigest(directSnapshot.approval.approved_brief)
            : null;
        const machineApprovalDigest =
          machineApproval?.status === 'approved'
            ? approvedBriefDigest(machineApproval.approved_brief)
            : null;

        expect(directSnapshot.processing_key).toBe(processingKey);
        expect(directSnapshot.approval_id).toBe(approvalId);
        expect(machineDecisionDigest).toBe(directDecisionDigest);
        expect(machineApprovalDigest).toBe(directApprovalDigest);
        expect(approvalOutcome(directSnapshot.approval)).toBe(
          entry.resolution.outcome,
        );
        expect(approvalOutcome(machineApproval)).toBe(entry.resolution.outcome);
        expect(await machineState.hasProcessed(processingKey)).toBe(true);

        const machineDeliveryKeys = [...machineDelivery.envelopes.values()]
          .filter(
            (envelope) =>
              envelope.brief.meeting.id === meeting.id &&
              envelope.brief.provenance.meeting_revision ===
                meeting.provenance.canonical_revision,
          )
          .map((envelope) => envelope.idempotency_key);
        expect(machineDeliveryKeys).toEqual(
          directSnapshot.delivery_idempotency_keys,
        );

        parityReport.push({
          fixture_id: entry.metadata.fixture_id,
          processing_key: processingKey,
          approval_id: approvalId,
          decision_set_sha256: directDecisionDigest,
          approved_brief_sha256: directApprovalDigest,
          disposition: entry.resolution.outcome,
          delivery_idempotency_keys:
            directSnapshot.delivery_idempotency_keys,
        });
      }

      // This frozen report is the non-self-referential drift alarm. The
      // direct-vs-machine assertions above are intentionally described as
      // composition/wiring parity because both paths share the relocated core
      // and deterministic processor implementation.
      expect(digest(parityReport)).toBe(
        '19d7bea0d63e6ae2d94526fae3d62deb8406b93a06dc38e0e6f0f15cac8aab87',
      );

      const attemptsBeforeReplay = machineDelivery.attempts;
      const replay = await composition.runOnce();
      expect(replay).toMatchObject({
        ok: true,
        meetings_seen: 30,
        meetings_processed: 0,
        meetings_rejected: 0,
        deliveries: 0,
      });
      expect(replay.sources[0]?.result?.meetings_skipped).toBe(30);
      expect(machineGate.events).toHaveLength(30);
      expect(machineOutcomeEvents).toHaveLength(30);
      expect(machineDelivery.attempts).toBe(attemptsBeforeReplay);

      const authorityKey = generatedKey();
      const authorityDescriptor: OrganizationAuthorityDescriptorV1 = {
        schema_version: 1,
        kind: 'echo-organization-authority',
        authority_id: fixedId('oau', 1),
        organization_id: fixedId('org', 1),
        signing_key: authorityKey.descriptor,
      };
      const installationKey = generatedKey();
      let envelopeSequence = 0;
      const builder = new ProtocolOrganizationRecordEnvelopeBuilder({
        pinnedAuthority: verifyOrganizationAuthorityPin(
          authorityDescriptor,
          organizationAuthorityPinSha256(authorityDescriptor),
        ),
        installationSigningKey: installationKey.descriptor,
        sign: installationKey.sign,
        nextEnvelopeId: () => fixedId('rec', ++envelopeSequence),
      });
      for (const [index, entry] of corpus.batches.entries()) {
        const meeting = entry.batch.meetings[0]!;
        const snapshot = directResult.snapshots[index]!;
        const approval = snapshot.approval;
        if (approval === null || approval.status === 'pending') {
          throw new Error('synthetic replay left an unresolved approval');
        }
        const action = approval.status === 'approved' ? 'approve' : 'reject';
        const input: OrganizationRecordEnvelopeBuildInput = {
          event_type:
            approval.status === 'approved' ? 'approval' : 'rejection',
          approval_id: snapshot.approval_id,
          source: {
            adapter_id: meeting.provenance.source.adapter_id,
            instance_id: meeting.provenance.source.instance_id,
            external_id: meeting.provenance.external_id,
          },
          meeting_id: meeting.id,
          brief:
            approval.status === 'approved' ? approval.approved_brief : null,
          alternatives: [],
          links: { parent: null, supersedes: null },
          reviewed_at: approval.reviewed_at,
          reviewed_by: approval.reviewed_by,
          reason: approval.reason,
          surface: 'synthetic-replay',
          authorization: authorizationEvidence({
            approvalId: snapshot.approval_id,
            action,
            index,
          }),
          submitted_at: SYNTHETIC_REPLAY_CLOCK,
        };
        const built = await builder.build(input);
        const validated = validateOrganizationRecordEnvelope(built.envelope);
        expect(built.idempotency_key).toBe(snapshot.approval_id);
        expect(validated.idempotency_key).toBe(snapshot.approval_id);
        expect(validated.event_type).toBe(input.event_type);
      }

      expect(envelopeSequence).toBe(30);
      expect(forbiddenFetch).not.toHaveBeenCalled();
      expect(digest(corpus)).toBe(corpusBefore);
    } finally {
      await composition.close();
    }
  });
});
