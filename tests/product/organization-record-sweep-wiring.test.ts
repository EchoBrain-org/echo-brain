import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  type DecisionProcessorAdapter,
  type DeliverySurfaceAdapter,
  type MeetingSourceAdapter,
} from '@echo-brain/organization-authority/processing/core/index.js';
import { prepareProductComposition } from '../../src/product/composition.js';
import type { ProductOrganizationRecordSweepReport } from '../../src/product/composition.js';
import { createOrganizationRecordSweepCoordinator } from '../../src/product/cli.js';
import { validateProductRuntimeConfig } from '../../src/product/config.js';
import { notifyOnResolve } from '../../src/product/default-adapters.js';
import type { OrganizationRecordSweepResult } from '../../src/product/organization/index.js';
import type { ApprovalDecisionStore } from '@echo-brain/organization-authority/processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function organizationSweepReport(
  overrides: Partial<OrganizationRecordSweepResult> = {},
): OrganizationRecordSweepResult {
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
  it('coalesces a resolution during the cycle sweep into one follow-up publication', async () => {
    const firstSweepStarted = deferred();
    const releaseFirstSweep = deferred();
    const followUpPublished = deferred();
    const resolvedNodes = new Set<string>();
    const publishedNodes: string[][] = [];
    const receivedSignals: Array<AbortSignal | undefined> = [];
    let sweepCount = 0;
    const cycleSignal = new AbortController().signal;
    const coordinator = createOrganizationRecordSweepCoordinator(
      async ({ signal }) => {
        sweepCount += 1;
        receivedSignals.push(signal);
        // A real sweep enumerates the durable nodes it can see at its own start.
        // Keeping this snapshot proves the cycle pass cannot publish a node that
        // resolves after it began.
        const visibleNodes = [...resolvedNodes];
        if (sweepCount === 1) {
          firstSweepStarted.resolve();
          await releaseFirstSweep.promise;
        }
        publishedNodes.push(visibleNodes);
        if (sweepCount === 2) followUpPublished.resolve();
        return organizationSweepReport({
          examined: visibleNodes.length,
          published: visibleNodes.length,
        });
      },
    );
    const sweep = coordinator.sweep.bind(coordinator);

    const cycle = sweep({ signal: cycleSignal });
    await firstSweepStarted.promise;

    // This is the production `afterDecisionResolved` callback: the resolution
    // is durable before the callback reaches the shared sweep scheduler.
    resolvedNodes.add('yen-approved-node');
    const callbackSweep = sweep({});
    expect(callbackSweep).toBe(cycle);
    // Concurrent resolver callbacks stay in the same bounded burst. They do
    // not queue one pass each and cannot make the scheduler spin indefinitely.
    expect(sweep({})).toBe(cycle);
    releaseFirstSweep.resolve();

    await expect(cycle).resolves.toMatchObject({ examined: 1, published: 1 });
    await followUpPublished.promise;
    expect(publishedNodes).toEqual([[], ['yen-approved-node']]);
    expect(sweepCount).toBe(2);
    // The first pass is bound to the caller's deadline, while the follow-up
    // receives a fresh composition-lifetime signal rather than that deadline.
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0]).not.toBeUndefined();
    expect(receivedSignals[1]).not.toBe(cycleSignal);
    expect(receivedSignals[1]?.aborted).toBe(false);
  });

  it('drains an abortable callback sweep before composition close returns', async () => {
    const stateDir = stateDirectory();
    const sweepStarted = deferred();
    const sweepAborted = deferred();
    const releaseAbortedSweep = deferred();
    let observedSignal: AbortSignal | undefined;
    const coordinator = createOrganizationRecordSweepCoordinator(
      async ({ signal }) => {
        observedSignal = signal;
        sweepStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              sweepAborted.resolve();
              void releaseAbortedSweep.promise.then(() => reject(signal.reason));
            },
            { once: true },
          );
        });
        return organizationSweepReport();
      },
    );
    const composition = await prepareProductComposition(
      config(stateDir),
      registry(),
      {
        classifyStateFilesystem: async () => ({ kind: 'local', raw: 'apfs' }),
        closeResources: () => coordinator.close(),
      },
    );
    const callbackBatch = coordinator.sweep({});
    void callbackBatch.catch(() => undefined);
    await sweepStarted.promise;

    let closeFinished = false;
    const close = Promise.resolve(composition.close()).then(() => {
      closeFinished = true;
    });
    await sweepAborted.promise;
    expect(observedSignal?.aborted).toBe(true);
    expect(closeFinished).toBe(false);
    releaseAbortedSweep.resolve();

    await close;
    await expect(callbackBatch).rejects.toThrow(
      'organization record sweep coordinator is closing',
    );
    await expect(coordinator.sweep({})).rejects.toThrow(
      'organization record sweep coordinator is closed',
    );
  });

  it('keeps a queued follow-up serialized behind a late aborted cycle sweep', async () => {
    const firstSweepStarted = deferred();
    const firstSweepAborted = deferred();
    const releaseFirstSweep = deferred();
    const parent = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    let sweepCount = 0;
    const coordinator = createOrganizationRecordSweepCoordinator(
      async ({ signal }) => {
        sweepCount += 1;
        signals.push(signal);
        if (sweepCount === 1) {
          firstSweepStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                firstSweepAborted.resolve();
                void releaseFirstSweep.promise.then(() => reject(signal.reason));
              },
              { once: true },
            );
          });
          return organizationSweepReport();
        }
        return organizationSweepReport({ examined: 1, published: 1 });
      },
    );

    const cycle = coordinator.sweep({ signal: parent.signal });
    void cycle.catch(() => undefined);
    await firstSweepStarted.promise;
    // A resolver callback while the physical cycle pass is still late must
    // join its outer batch, not run beside it.
    expect(coordinator.sweep({})).toBe(cycle);
    parent.abort(new Error('cycle deadline elapsed'));
    await firstSweepAborted.promise;
    expect(sweepCount).toBe(1);
    releaseFirstSweep.resolve();

    await expect(cycle).rejects.toThrow('cycle deadline elapsed');
    expect(sweepCount).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('bounds a signal-free background sweep with the coordinator deadline', async () => {
    const aborted = deferred();
    const coordinator = createOrganizationRecordSweepCoordinator(
      async ({ signal }) =>
        await new Promise<OrganizationRecordSweepResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      { timeoutMs: 25 },
    );

    const background = coordinator.sweep({});
    await aborted.promise;
    await expect(background).rejects.toThrow(
      'organization record sweep timed out after 25ms',
    );
  });

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
    const hookStarted = deferred();
    const slowHook = new Promise<void>(() => undefined);
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
      async freezeApprovalPresentationContract(input) {
        expect(this).toBe(store);
        calls.push('freezeApprovalPresentationContract');
        return input.contract;
      },
      readApprovalPresentationContract() {
        expect(this).toBe(store);
        calls.push('readApprovalPresentationContract');
        return null;
      },
      resolve: async () => {
        calls.push('resolve');
        return resolvedView;
      },
    };

    const wrapped = notifyOnResolve(store, () => {
      // The hook only runs after the durable write returned, and its failure
      // cannot roll that local resolution back. It is intentionally detached:
      // an unavailable authority must not consume Slack's action deadline.
      expect(calls).toEqual(['resolve']);
      fired += 1;
      hookStarted.resolve();
      return slowHook;
    });
    const resolved = await wrapped.resolve({
      approvalId: resolvedView.approval_id,
      status: 'approved',
      reviewedBy: 'Ada Founder',
      surface: 'slack-reactions',
    });
    await hookStarted.promise;

    expect(resolved).toBe(resolvedView);
    expect(fired).toBe(1);
    const failedHook = notifyOnResolve(store, () => {
      throw new Error('sweep scheduling failed');
    });
    await expect(
      failedHook.resolve({
        approvalId: resolvedView.approval_id,
        status: 'approved',
        reviewedBy: 'Ada Founder',
        surface: 'slack-reactions',
      }),
    ).resolves.toBe(resolvedView);
    const presentationContract = {
      schema_version: 1,
      kind: 'echo-slack-approval-presentation-contract',
      mode: 'restricted-reviewer-v1',
    } as never;
    await expect(
      wrapped.freezeApprovalPresentationContract?.({
        approvalId: resolvedView.approval_id,
        contract: presentationContract,
      }),
    ).resolves.toBe(presentationContract);
    expect(
      wrapped.readApprovalPresentationContract?.(resolvedView.approval_id),
    ).toBeNull();
    // Reading is untouched: only a terminal resolution offers ingest a turn.
    await wrapped.ensureRequested({} as never);
    expect(fired).toBe(1);
    expect(calls).toEqual([
      'resolve',
      'resolve',
      'freezeApprovalPresentationContract',
      'readApprovalPresentationContract',
      'ensureRequested',
    ]);
  });
});
