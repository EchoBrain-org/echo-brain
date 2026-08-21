import { describe, expect, it, vi } from 'vitest';
import {
  approvedBriefDigest,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DecisionBrief,
} from '../../../src/processing/core/index.js';
import {
  InstrumentedApprovalGate,
  type ApprovalOutcomeEvent,
} from '../../../src/processing/approval/approval-outcome-instrument.js';

const processor = {
  kind: 'decision-processor' as const,
  adapter_id: 'structured-text',
  instance_id: 'primary',
  version: '1.0.0',
};

function approvalRequest(
  processingKey = 'processing-key-1',
): ApprovalRequest {
  const brief: DecisionBrief = {
    schema_version: 1,
    id: 'brief-1',
    meeting: { id: 'meeting-1', participants: [] },
    decisions: [
      {
        id: 'decision-1',
        kind: 'decision',
        text: 'Ship the bounded migration.',
        subject: null,
        confidence: 1,
        evidence: [{ meeting_id: 'meeting-1', block_id: 'notes-1' }],
        status: 'decided',
      },
    ],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'revision-1',
      processor,
      generated_at: '2026-08-18T18:00:00.000Z',
    },
  };
  return {
    processing_key: processingKey,
    requested_at: '2026-08-18T18:01:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      context: { meeting_type: 'decision-review' },
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'granola',
          instance_id: 'primary',
          version: '1.0.0',
        },
        external_id: 'source-meeting-1',
        canonical_revision: 'revision-1',
        observed_at: '2026-08-18T17:00:00.000Z',
        normalizer_version: '1.0.0',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision-1',
      processor,
      generated_at: '2026-08-18T18:00:00.000Z',
      signals: brief.decisions,
    },
    brief,
  };
}

function approved(brief: DecisionBrief): ApprovalDecision {
  return {
    status: 'approved',
    reviewed_at: '2026-08-18T18:02:00.000Z',
    reviewed_by: 'Reviewer One',
    reason: null,
    approved_brief: brief,
  };
}

function rejected(): ApprovalDecision {
  return {
    status: 'rejected',
    reviewed_at: '2026-08-18T18:02:00.000Z',
    reviewed_by: 'Reviewer One',
    reason: 'Not releasable.',
    approved_brief: null,
  };
}

describe('approval outcome instrumentation', () => {
  it.each(['accept', 'edit', 'reject'] as const)(
    'records a canonically classified %s with complete source and type tags',
    async (outcome) => {
      const request = approvalRequest(`processing-${outcome}`);
      const editedBrief: DecisionBrief = {
        ...request.brief,
        decisions: [
          {
            ...request.brief.decisions[0]!,
            text: 'Ship only after the explicit review gate.',
          },
        ],
      };
      const decision =
        outcome === 'reject'
          ? rejected()
          : approved(outcome === 'edit' ? editedBrief : request.brief);
      const gate: ApprovalGate = { review: vi.fn(async () => decision) };
      const events: ApprovalOutcomeEvent[] = [];
      const instrumented = new InstrumentedApprovalGate(
        gate,
        { record: async (event) => void events.push(event) },
        { synthetic: false, reviewer_capacity_eligible: true },
      );

      await expect(instrumented.review(request)).resolves.toEqual(decision);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        schema_version: 1,
        processing_key: request.processing_key,
        meeting_id: 'meeting-1',
        meeting_revision: 'revision-1',
        source: {
          adapter_id: 'granola',
          instance_id: 'primary',
          external_id: 'source-meeting-1',
        },
        decision_type: 'decision-review',
        outcome,
        requested_brief_sha256: approvedBriefDigest(request.brief),
        approved_brief_sha256:
          outcome === 'reject'
            ? null
            : approvedBriefDigest(
                outcome === 'edit' ? editedBrief : request.brief,
              ),
        reviewed_at: '2026-08-18T18:02:00.000Z',
        reviewed_by: 'Reviewer One',
        synthetic: false,
        reviewer_capacity_eligible: true,
      });
    },
  );

  it('does not emit for pending reviews and allows the gate to be polled again', async () => {
    const pending: ApprovalDecision = {
      status: 'pending',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      approved_brief: null,
    };
    const review = vi.fn(async () => pending);
    const record = vi.fn(async () => undefined);
    const gate = new InstrumentedApprovalGate(
      { review },
      { record },
      { synthetic: true, reviewer_capacity_eligible: false },
    );
    const request = approvalRequest();
    request.meeting.context = undefined;

    await gate.review(request);
    await gate.review(request);

    expect(review).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
  });

  it('coalesces concurrent resolution and emits exactly once per processing key', async () => {
    const request = approvalRequest();
    let release!: (decision: ApprovalDecision) => void;
    const review = vi.fn(
      async () =>
        await new Promise<ApprovalDecision>((resolve) => {
          release = resolve;
        }),
    );
    const record = vi.fn(async () => undefined);
    const gate = new InstrumentedApprovalGate(
      { review },
      { record },
      { synthetic: true, reviewer_capacity_eligible: false },
    );

    const first = gate.review(request);
    const second = gate.review(request);
    expect(review).toHaveBeenCalledTimes(1);
    release(approved(request.brief));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await gate.review(request);
    expect(review).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('surfaces instrument failures and retries recording without resolving again', async () => {
    const request = approvalRequest();
    const review = vi.fn(async () => approved(request.brief));
    const record = vi
      .fn<(event: ApprovalOutcomeEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error('metric store unavailable'))
      .mockResolvedValue(undefined);
    const gate = new InstrumentedApprovalGate(
      { review },
      { record },
      { synthetic: false, reviewer_capacity_eligible: true },
    );

    await expect(gate.review(request)).rejects.toThrow(
      'metric store unavailable',
    );
    await expect(gate.review(request)).resolves.toMatchObject({
      status: 'approved',
    });
    await gate.review(request);

    expect(review).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0]).toEqual(record.mock.calls[0]![0]);
  });

  it('fails closed on an untyped resolved meeting', async () => {
    const request = approvalRequest();
    request.meeting.context = undefined;
    const review = vi.fn(async () => approved(request.brief));
    const record = vi.fn(async () => undefined);
    const gate = new InstrumentedApprovalGate(
      { review },
      { record },
      { synthetic: false, reviewer_capacity_eligible: true },
    );

    await expect(gate.review(request)).rejects.toThrow(
      'resolved approval outcome requires meeting.context.meeting_type',
    );
    request.meeting.context = { meeting_type: 'decision-review' };
    await expect(gate.review(request)).resolves.toMatchObject({
      status: 'approved',
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('refuses to count synthetic resolutions as reviewer capacity', () => {
    expect(
      () =>
        new InstrumentedApprovalGate(
          { review: async () => rejected() },
          { record: async () => undefined },
          { synthetic: true, reviewer_capacity_eligible: true },
        ),
    ).toThrow('synthetic approval outcomes cannot be reviewer-capacity eligible');
  });
});
