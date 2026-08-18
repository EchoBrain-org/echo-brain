import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdapterRegistry,
  type ApprovalGate,
  type DecisionProcessorAdapter,
  type DeliverySurfaceAdapter,
  type MeetingDocument,
  type MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import type {
  ApprovalOutcomeEvent,
  ApprovalOutcomeInstrument,
} from '@echo-brain/organization-authority/processing/approval/approval-outcome-instrument.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';

const directories: string[] = [];
const now = '2026-08-18T19:00:00.000Z';

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'meeting-1',
  title: 'Migration review',
  capture: {
    state: 'complete',
    components: [{ kind: 'notes', state: 'available' }],
  },
  participants: [],
  content: [
    {
      id: 'notes-1',
      kind: 'note',
      text: 'Decision: finish the bounded migration.',
    },
  ],
  artifacts: [],
  context: { meeting_type: 'decision-review' },
  provenance: {
    source: {
      kind: 'meeting-source',
      adapter_id: 'fixture-source',
      instance_id: 'primary',
      version: '1.0.0',
    },
    external_id: 'source-meeting-1',
    canonical_revision: 'revision-1',
    observed_at: now,
    normalizer_version: '1.0.0',
  },
};

function registerAdapters(): AdapterRegistry {
  const registry = new AdapterRegistry();
  const validateConfig = () => ({ ok: true as const, errors: [] });
  const healthCheck = async () => ({
    status: 'healthy' as const,
    checked_at: now,
  });
  const source: MeetingSourceAdapter = {
    identity: meeting.provenance.source,
    validateConfig,
    healthCheck,
    pull: async () => ({ meetings: [meeting] }),
  };
  const processor: DecisionProcessorAdapter = {
    identity: {
      kind: 'decision-processor',
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      version: '1.0.0',
    },
    validateConfig,
    healthCheck,
    extract: async (input) => ({
      schema_version: 1,
      meeting_id: input.id,
      meeting_revision: input.provenance.canonical_revision,
      processor: processor.identity,
      generated_at: now,
      signals: [
        {
          id: 'decision-1',
          kind: 'decision',
          text: 'Finish the bounded migration.',
          subject: 'migration',
          confidence: 1,
          status: 'decided',
          evidence: [{ meeting_id: input.id, block_id: 'notes-1' }],
        },
      ],
    }),
  };
  const delivery: DeliverySurfaceAdapter = {
    identity: {
      kind: 'delivery-surface',
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      version: '1.0.0',
    },
    destination: {
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      external_id: 'fixture-destination',
    },
    validateConfig,
    healthCheck,
    publish: async (envelope) => ({
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: 'delivered-message-1',
      recorded_at: now,
      retryable: false,
    }),
  };
  registry.register(source);
  registry.register(processor);
  registry.register(delivery);
  return registry;
}

function config(stateDirectory: string) {
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDirectory,
    meeting_sources: [
      { adapter_id: 'fixture-source', instance_id: 'primary', settings: {} },
    ],
    decision_processor: {
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      settings: {},
    },
    delivery_surfaces: [
      { adapter_id: 'fixture-delivery', instance_id: 'team', settings: {} },
    ],
    approval_mode: 'manual',
  });
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe('product approval-outcome wiring', () => {
  it('wraps the configured approval gate on the actual composition path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-approval-instrument-'));
    directories.push(root);
    const review = vi.fn<ApprovalGate['review']>(async (request) => ({
      status: 'approved',
      reviewed_at: now,
      reviewed_by: 'Synthetic Resolver',
      reason: 'Synthetic edit',
      approved_brief: {
        ...request.brief,
        decisions: [
          {
            ...request.brief.decisions[0]!,
            text: 'Finish only after the explicit review checkpoint.',
          },
        ],
      },
    }));
    const events: ApprovalOutcomeEvent[] = [];
    const instrument: ApprovalOutcomeInstrument = {
      record: async (event) => void events.push(event),
    };
    let ids = 0;
    const composition = await prepareProductComposition(
      config(join(root, 'state')),
      registerAdapters(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        approvalGate: { review },
        approvalOutcomeInstrumentation: {
          instrument,
          classification: {
            synthetic: true,
            reviewer_capacity_eligible: false,
          },
        },
        now: () => now,
        createId: () => `generated-${++ids}`,
      },
    );

    try {
      await expect(composition.runOnce()).resolves.toMatchObject({
        ok: true,
        meetings_seen: 1,
        meetings_processed: 1,
        deliveries: 1,
      });
    } finally {
      await composition.close();
    }

    expect(review).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        meeting_id: 'meeting-1',
        source: {
          adapter_id: 'fixture-source',
          instance_id: 'primary',
          external_id: 'source-meeting-1',
        },
        decision_type: 'decision-review',
        outcome: 'edit',
        synthetic: true,
        reviewer_capacity_eligible: false,
      }),
    ]);
  });

  it('retains compatibility when no outcome instrument is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'echo-approval-no-instrument-'));
    directories.push(root);
    const review = vi.fn<ApprovalGate['review']>(async () => ({
      status: 'rejected',
      reviewed_at: now,
      reviewed_by: 'Reviewer One',
      reason: 'Hold.',
      approved_brief: null,
    }));
    const composition = await prepareProductComposition(
      config(join(root, 'state')),
      registerAdapters(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        approvalGate: { review },
        now: () => now,
        createId: () => 'generated-id',
      },
    );

    try {
      await expect(composition.runOnce()).resolves.toMatchObject({
        ok: true,
        meetings_seen: 1,
        meetings_rejected: 1,
        deliveries: 0,
      });
    } finally {
      await composition.close();
    }
    expect(review).toHaveBeenCalledTimes(1);
  });
});
