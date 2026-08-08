import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  type DecisionProcessorAdapter,
  type DeliverySurfaceAdapter,
  type MeetingSourceAdapter,
} from '../../src/core/index.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import type { ProductOrganizationRecordSweepReport } from '../../src/product/composition.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import { notifyOnResolve } from '../../src/product/default-adapters.js';
import type { ApprovalDecisionStore } from '../../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-record-sweep-')));
  directories.push(root);
  return join(root, 'state');
}

function config(stateDir: string) {
  return validateProductRuntimeConfig({
    schema_version: 1,
    lane: 'team-product',
    state_dir: stateDir,
    meeting_sources: [
      { adapter_id: 'fixture-meetings', instance_id: 'primary', settings: {} },
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

function registry(onPull?: () => void): AdapterRegistry {
  const validateConfig = () => ({ ok: true, errors: [] });
  const healthCheck = async () => ({
    status: 'healthy' as const,
    checked_at: '2026-08-08T12:00:00.000Z',
  });
  const meetingSource: MeetingSourceAdapter = {
    identity: {
      kind: 'meeting-source',
      adapter_id: 'fixture-meetings',
      instance_id: 'primary',
      version: '1.0.0',
    },
    validateConfig,
    healthCheck,
    pull: async () => {
      onPull?.();
      return { meetings: [] };
    },
  };
  const decisionProcessor: DecisionProcessorAdapter = {
    identity: {
      kind: 'decision-processor',
      adapter_id: 'fixture-processor',
      instance_id: 'primary',
      version: '1.0.0',
    },
    validateConfig,
    healthCheck,
    extract: async (meeting) => ({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: decisionProcessor.identity,
      generated_at: '2026-08-08T12:00:00.000Z',
      signals: [],
    }),
  };
  const deliverySurface: DeliverySurfaceAdapter = {
    identity: {
      kind: 'delivery-surface',
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      version: '1.0.0',
    },
    destination: {
      adapter_id: 'fixture-delivery',
      instance_id: 'team',
      external_id: 'synthetic-team',
    },
    validateConfig,
    healthCheck,
    publish: async (envelope) => ({
      schema_version: 1,
      envelope_id: envelope.id,
      status: 'delivered',
      external_id: 'synthetic-message',
      recorded_at: '2026-08-08T12:00:00.000Z',
      retryable: false,
    }),
  };
  const registered = new AdapterRegistry();
  registered.register(meetingSource);
  registered.register(decisionProcessor);
  registered.register(deliverySurface);
  return registered;
}

function sweepReport(
  overrides: Partial<ProductOrganizationRecordSweepReport> = {},
): ProductOrganizationRecordSweepReport {
  return {
    ok: true,
    examined: 0,
    excluded: 0,
    skipped: 0,
    published: 0,
    rejected: 0,
    retried: 0,
    alerts: [],
    ...overrides,
  };
}

describe('organization record submission sweep wiring', () => {
  it('sweeps once per cycle without a redundant startup sweep', async () => {
    const stateDir = stateDirectory();
    const sweeps: number[] = [];
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        organizationRecordSweep: async () => {
          sweeps.push(sweeps.length + 1);
          return sweepReport({ examined: 1, published: 1 });
        },
      },
    );
    try {
      expect(sweeps).toEqual([]);
      const first = await composition.runOnce();
      const second = await composition.runOnce();
      expect(sweeps).toEqual([1, 2]);
      expect(first.organization_record).toMatchObject({
        ok: true,
        detail: null,
        examined: 1,
        published: 1,
      });
      expect(second.organization_record).toEqual(first.organization_record);
    } finally {
      await composition.close();
    }
  });

  it('never lets a failed submission stop the local pipeline', async () => {
    const stateDir = stateDirectory();
    let attempts = 0;
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        organizationRecordSweep: async () => {
          attempts += 1;
          throw new Error('organization authority is unreachable');
        },
      },
    );
    try {
      const cycle = await composition.runOnce();

      // Organization ingest is a second egress path, never a gate: the local
      // cycle still reports ok, and the failure is visible beside it.
      expect(cycle.ok).toBe(true);
      expect(cycle.organization_record).toMatchObject({
        ok: false,
        detail: 'organization authority is unreachable',
        alerts: 0,
      });
      expect(attempts).toBe(1);
    } finally {
      await composition.close();
    }
  });

  it('bounds a hanging sweep without holding up local source work', async () => {
    const stateDir = stateDirectory();
    let sweepAborted = false;
    let pulledBeforeAbort = false;
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(() => {
        pulledBeforeAbort = !sweepAborted;
      }),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        organizationRecordSweepTimeoutMs: 25,
        organizationRecordSweep: async ({ signal }) => {
          signal?.addEventListener('abort', () => {
            sweepAborted = true;
          });
          return await new Promise<ProductOrganizationRecordSweepReport>(
            () => undefined,
          );
        },
      },
    );
    try {
      const startedAt = Date.now();
      const cycle = await composition.runOnce();

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(pulledBeforeAbort).toBe(true);
      expect(sweepAborted).toBe(true);
      expect(cycle.ok).toBe(true);
      expect(cycle.organization_record).toMatchObject({
        ok: false,
        detail: 'organization record sweep timed out after 25ms',
      });
    } finally {
      await composition.close();
    }
  });

  it('reports a non-throwing sweep that raised alerts as not ok', async () => {
    const stateDir = stateDirectory();
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        // The submitter never throws for a node it could not process: it
        // resolves with `ok: false` and the alerts. A seam that only watched
        // for a rejected promise reported this as a clean cycle.
        organizationRecordSweep: async () =>
          sweepReport({
            ok: false,
            examined: 2,
            skipped: 1,
            published: 1,
            alerts: [
              {
                code: 'authorization_evidence_invalid',
                approval_id: 'f'.repeat(64),
                detail: 'resolved metadata carries no authorization evidence',
              },
            ],
          }),
      },
    );
    try {
      const cycle = await composition.runOnce();

      expect(cycle.ok).toBe(true);
      expect(cycle.organization_record).toEqual({
        ok: false,
        detail:
          'authorization_evidence_invalid [ffffffffffff]: resolved metadata carries no authorization evidence',
        examined: 2,
        excluded: 0,
        skipped: 1,
        published: 1,
        rejected: 0,
        retried: 0,
        alerts: 1,
      });
    } finally {
      await composition.close();
    }
  });

  it('bounds the reported alert summary', async () => {
    const stateDir = stateDirectory();
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        organizationRecordSweep: async () =>
          sweepReport({
            ok: false,
            examined: 6,
            skipped: 6,
            alerts: Array.from({ length: 6 }, (_unused, index) => ({
              code: 'node_unreadable',
              approval_id: 'a'.repeat(64),
              detail: `node ${index} could not be read`,
            })),
          }),
      },
    );
    try {
      const cycle = await composition.runOnce();

      expect(cycle.organization_record?.alerts).toBe(6);
      expect(cycle.organization_record?.detail).toBe(
        'node_unreadable [aaaaaaaaaaaa]: node 0 could not be read; ' +
          'node_unreadable [aaaaaaaaaaaa]: node 1 could not be read; ' +
          'node_unreadable [aaaaaaaaaaaa]: node 2 could not be read; +3 more',
      );
    } finally {
      await composition.close();
    }
  });

  it('omits the record field entirely when no submitter is composed', async () => {
    const stateDir = stateDirectory();
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      { classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }) },
    );
    try {
      const cycle = await composition.runOnce();
      expect(cycle).not.toHaveProperty('organization_record');
    } finally {
      await composition.close();
    }
  });

  it('fires the post-resolve hook after persistence without risking resolution', async () => {
    let fired = 0;
    const resolvedView = {
      approval_id: 'a'.repeat(64),
      status: 'approved' as const,
      reviewed_at: '2026-08-08T12:00:00.000Z',
      reviewed_by: 'Ada Founder',
      reason: null,
      brief: {
        schema_version: 1 as const,
        id: 'brief-1',
        meeting: { id: 'meeting-1', participants: [] },
        decisions: [],
        actions: [],
        rationales: [],
        provenance: {
          meeting_revision: 'rev-1',
          processor: {
            kind: 'decision-processor' as const,
            adapter_id: 'fixture-processor',
            instance_id: 'primary',
            version: '1.0.0',
          },
          generated_at: '2026-08-08T12:00:00.000Z',
        },
      },
      published: [],
    };
    const calls: string[] = [];
    const store: ApprovalDecisionStore = {
      ensureRequested: async () => {
        calls.push('ensureRequested');
        return resolvedView;
      },
      recordPublished: async () => {
        calls.push('recordPublished');
        return resolvedView;
      },
      resolve: async () => {
        calls.push('resolve');
        return resolvedView;
      },
    };

    const wrapped = notifyOnResolve(store, () => {
      // The hook only runs after the durable write returned, and its failure
      // cannot roll that local resolution back.
      expect(calls).toEqual(['resolve']);
      fired += 1;
      throw new Error('sweep scheduling failed');
    });
    const resolved = await wrapped.resolve({
      approvalId: resolvedView.approval_id,
      status: 'approved',
      reviewedBy: 'Ada Founder',
      surface: 'slack-reactions',
    });

    expect(resolved).toBe(resolvedView);
    expect(fired).toBe(1);
    // Reading is untouched: only a terminal resolution offers ingest a turn.
    await wrapped.ensureRequested({} as never);
    expect(fired).toBe(1);
  });
});
