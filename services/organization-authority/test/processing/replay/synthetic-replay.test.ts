import { describe, expect, it, vi } from 'vitest';
import {
  meetingProcessingKey,
  runCoreCycle,
  type MeetingDocument,
} from '../../../src/processing/core/index.js';
import {
  ManifestSyntheticApprovalGate,
  SyntheticDeliveryCapture,
  SyntheticMonotonicCoreStateStore,
  SyntheticResolvedActWriter,
  createSyntheticReplayHarness,
  syntheticObservationId,
  type SyntheticReplayManifest,
  type SyntheticReviewDirective,
} from '../../../src/processing/replay/synthetic-replay.js';
import { createStructuredTextDecisionProcessor } from '../../../src/processing/adapters/decision-processors/structured-text/structured-text-decision-processor.js';

function meeting(
  externalId: string,
  revision = 'revision-1',
  decisionText = 'use the authority-owned migration seam.',
): MeetingDocument {
  return {
    schema_version: 1,
    id: `meeting-${externalId}-${revision}`,
    title: `Synthetic meeting ${externalId}`,
    time: { actual_start_at: '2026-08-17T23:00:00.000Z' },
    capture: { state: 'complete', components: [{ kind: 'transcript', state: 'available' }] },
    participants: [{ id: 'synthetic-reviewer', display_name: 'Synthetic Reviewer' }],
    content: [{
      id: 'transcript-1',
      kind: 'transcript',
      text: `Decision: ${decisionText}\nAction: run synthetic replay.`,
    }],
    artifacts: [],
    context: { meeting_type: 'decision-review' },
    provenance: {
      source: { kind: 'meeting-source', adapter_id: 'synthetic-replay', instance_id: 'offline', version: '1.0.0' },
      external_id: externalId,
      canonical_revision: revision,
      observed_at: '2026-08-18T00:00:00.000Z',
      normalizer_version: '1.0.0',
      source_updated_at: '2026-08-17T23:00:00.000Z',
    },
  };
}

function manifestFor(
  ...entries: Array<[MeetingDocument, 'accept' | 'edit' | 'reject']>
): SyntheticReplayManifest {
  return {
    observations: Object.fromEntries(entries.map(([value, disposition]) => [
      syntheticObservationId(value),
      disposition === 'edit'
        ? {
            disposition,
            instructions: {
              operation: 'replace',
              target: 'decision[0].text',
              replacement: `Edited ${value.id}`,
            },
          }
        : { disposition },
    ])) as Record<string, SyntheticReviewDirective>,
  };
}

describe('offline synthetic replay harness', () => {
  it('uses the real structured-text processor and records each accept/edit/reject path as ineligible synthetic work', async () => {
    const accepted = meeting('accept');
    const edited = meeting('edit');
    const rejected = meeting('reject');
    const harness = createSyntheticReplayHarness(manifestFor(
      [accepted, 'accept'], [edited, 'edit'], [rejected, 'reject'],
    ));
    const result = await harness.run([accepted, edited, rejected]);

    expect(result.events.map((event) => event.disposition)).toEqual(['accept', 'edit', 'reject']);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: {
          adapter_id: 'synthetic-replay',
          instance_id: 'offline',
          external_id: 'accept',
        },
        decision_type: 'decision-review',
      }),
    ]));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ synthetic: true, reviewer_capacity_eligible: false }),
    ]));
    expect(result.snapshots.map((snapshot) => snapshot.result.meetings_rejected)).toEqual([0, 0, 1]);
    expect(result.snapshots[1]?.approval).toMatchObject({
      status: 'approved',
      approved_brief: {
        decisions: [{ text: `Edited ${edited.id}` }],
      },
    });
    expect(result.snapshots[1]?.approval_digest).not.toBeNull();
    expect(result.snapshots.map((snapshot) => snapshot.approval_id)).toEqual(
      result.events.map((event) => event.approval_id),
    );
    expect(result.snapshots.map((snapshot) => snapshot.delivery_idempotency_keys.length)).toEqual([1, 1, 0]);
    expect(result.unique_deliveries).toBe(2);
  });

  it('keeps same-revision replays frozen and creates a distinct card for a changed revision without changing the old digest', async () => {
    const first = meeting('revision-pair', 'revision-1');
    const changed = meeting(
      'revision-pair',
      'revision-2',
      'use the changed authority-owned migration seam.',
    );
    const harness = createSyntheticReplayHarness(manifestFor([first, 'accept'], [changed, 'edit']));
    const firstRun = await harness.run([first]);
    const oldDigest = firstRun.snapshots[0]!.approval_digest;
    const firstDeliveryAttempts = firstRun.delivery_attempts;
    const replay = await harness.run([first]);
    const changedRun = await harness.run([changed]);

    expect(replay.events).toHaveLength(1);
    expect(replay.snapshots[0]!.result.meetings_skipped).toBe(1);
    expect(replay.delivery_attempts).toBe(firstDeliveryAttempts);
    expect(replay.snapshots[0]!.approval_digest).toBe(oldDigest);
    expect(changedRun.events).toHaveLength(2);
    expect(changedRun.snapshots[0]!.approval_digest).not.toBe(oldDigest);
    expect(changedRun.snapshots[0]!.processing_key).not.toBe(firstRun.snapshots[0]!.processing_key);
    expect(new Set(harness.gate.events.map((event) => event.card_id))).toHaveLength(2);
  });

  it('is offline: a forbidden global fetch is never called', async () => {
    const value = meeting('offline');
    const fetch = vi.fn(() => { throw new Error('network use is forbidden'); });
    vi.stubGlobal('fetch', fetch);
    try {
      await createSyntheticReplayHarness(manifestFor([value, 'accept'])).run([value]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has one winning card, resolution, event, and idempotent capture across 100 forced two-contender core races', async () => {
    for (let trial = 0; trial < 100; trial += 1) {
      const value = meeting(`race-${trial}`);
      const processor = createStructuredTextDecisionProcessor(
        { adapter_id: 'structured-text', instance_id: 'synthetic-replay', settings: {} },
        { now: () => '2026-08-18T00:00:00.000Z' },
      );
      const state = new SyntheticMonotonicCoreStateStore();
      const gate = new ManifestSyntheticApprovalGate(manifestFor([value, 'accept']));
      const delivery = new SyntheticDeliveryCapture();
      let arrivals = 0;
      let release!: () => void;
      const bothContendersArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = {
        identity: value.provenance.source,
        validateConfig: () => ({ ok: true, errors: [] }),
        healthCheck: async () => ({ status: 'healthy' as const, checked_at: '2026-08-18T00:00:00.000Z' }),
        pull: async () => {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothContendersArrived;
          return { meetings: [value] };
        },
      };
      let nextId = 0;
      const resolvedActWriter = new SyntheticResolvedActWriter();
      const cycle = () => runCoreCycle({
        meetingSource: source,
        decisionProcessor: processor,
          deliverySurfaces: [delivery],
          resolvedActWriter,
        approvalGate: gate,
        state,
        now: () => '2026-08-18T00:00:00.000Z',
        createId: () => `race-${trial}-${++nextId}`,
      });
      const results = await Promise.all([cycle(), cycle()]);
      const key = meetingProcessingKey(value, processor);
      expect(arrivals).toBe(2);
      expect(await state.getApproval(key)).toMatchObject({ status: 'approved' });
      expect(gate.events).toHaveLength(1);
      expect(new Set(gate.events.map((event) => event.card_id))).toHaveLength(1);
      expect(new Set(gate.events.map((event) => event.resolution_id))).toHaveLength(1);
      // The core does not own a durable delivery-claim primitive yet, so both
      // contenders may invoke publish. The capture proves the narrower Band-B
      // property: one card/resolution and one idempotency-keyed artifact.
      expect(results.map((result) => result.deliveries)).toEqual([1, 1]);
      expect(delivery.attempts).toBe(2);
      expect(delivery.envelopes.size).toBe(1);
      expect(resolvedActWriter.attempts).toBe(2);
      expect(resolvedActWriter.acts.size).toBe(1);
    }
  });
});
