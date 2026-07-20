import { describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision } from '../../src/core/approval/approval-gate.js';
import type { DecisionBrief } from '../../src/core/contracts/delivery.js';
import type { CoreStateStore } from '../../src/core/storage/core-state-store.js';
import type { DecisionNodeState } from '../../src/product/approval/decision-node.js';
import { ApprovalProjectingCoreStateStore } from '../../src/product/federation/approval-projecting-core-state-store.js';
import type { FederatedRecordProjector } from '../../src/product/federation/record-projector.js';

const PROCESSING_KEY = 'processing-key-1';
const REVIEWED_AT = '2026-07-19T23:00:00.000Z';

const brief: DecisionBrief = {
  schema_version: 1,
  id: 'brief-1',
  meeting: {
    id: 'granola:primary:not-1',
    title: 'Founder planning',
    participants: [],
  },
  decisions: [
    {
      id: `decision:sha256:${'a'.repeat(64)}`,
      kind: 'decision',
      text: 'Ship the identity cutover',
      subject: null,
      confidence: 0.98,
      evidence: [],
      status: 'decided',
    },
  ],
  actions: [],
  rationales: [],
  provenance: {
    meeting_revision: 'rev-1',
    processor: {
      kind: 'decision-processor',
      adapter_id: 'llm',
      instance_id: 'ollama-qwen3-4b',
      version: '1.0.0',
    },
    generated_at: '2026-07-19T22:59:00.000Z',
  },
};

const approved: ApprovalDecision = {
  status: 'approved',
  reviewed_at: REVIEWED_AT,
  reviewed_by: 'founder',
  reason: 'Ready for seed-grade capture',
  approved_brief: brief,
};

const pending: ApprovalDecision = {
  status: 'pending',
  reviewed_at: null,
  reviewed_by: null,
  reason: null,
  approved_brief: null,
};

const rejected: ApprovalDecision = {
  status: 'rejected',
  reviewed_at: REVIEWED_AT,
  reviewed_by: 'founder',
  reason: 'Needs another pass',
  approved_brief: null,
};

function node(overrides: Partial<DecisionNodeState> = {}): DecisionNodeState {
  return {
    approval_id: 'b'.repeat(64),
    node_id: 'node-1',
    processing_key: PROCESSING_KEY,
    requested_at: '2026-07-19T22:58:00.000Z',
    requested_metadata: {},
    brief,
    alternatives: [],
    links: { parent: null, supersedes: null },
    status: 'approved',
    reviewed_at: REVIEWED_AT,
    reviewed_by: 'founder',
    reason: 'Ready for seed-grade capture',
    resolved_surface: 'slack-reactions',
    resolved_metadata: {},
    published: [],
    ...overrides,
  };
}

function delegate(
  getApproval: () => Promise<ApprovalDecision | undefined>,
): CoreStateStore & { close: () => void } {
  return {
    getSourceCursor: vi.fn(async () => undefined),
    setSourceCursor: vi.fn(async () => undefined),
    hasProcessed: vi.fn(async () => false),
    saveMeeting: vi.fn(async () => undefined),
    getDecisionSet: vi.fn(async () => undefined),
    saveDecisionSet: vi.fn(async () => undefined),
    getApproval,
    saveApproval: vi.fn(async () => undefined),
    saveDeliveryReceipt: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

function projector(
  projectApproved: FederatedRecordProjector['projectApproved'],
): Pick<FederatedRecordProjector, 'projectApproved'> {
  return { projectApproved };
}

describe('ApprovalProjectingCoreStateStore', () => {
  it.each([
    ['missing', undefined],
    ['pending', pending],
    ['rejected', rejected],
  ] as const)(
    'returns a %s cache entry without projection',
    async (_label, cached) => {
      const base = delegate(async () => cached);
      const decisionNodes = { getState: vi.fn(async () => node()) };
      const projectApproved = vi.fn(async () => []);
      const state = new ApprovalProjectingCoreStateStore(
        base,
        decisionNodes,
        projector(projectApproved),
      );

      await expect(state.getApproval(PROCESSING_KEY)).resolves.toBe(cached);
      expect(decisionNodes.getState).not.toHaveBeenCalled();
      expect(projectApproved).not.toHaveBeenCalled();
    },
  );

  it('projects the exact approved node before returning on every cached read', async () => {
    const order: string[] = [];
    const base = delegate(async () => {
      order.push('cache');
      return approved;
    });
    const storedNode = node();
    const decisionNodes = {
      getState: vi.fn(async () => {
        order.push('node');
        return storedNode;
      }),
    };
    const projectApproved = vi.fn(async (state: DecisionNodeState) => {
      order.push('project');
      expect(state).toBe(storedNode);
      return [];
    });
    const afterProjection = vi.fn(async (state: DecisionNodeState) => {
      order.push('copy');
      expect(state).toBe(storedNode);
    });
    const state = new ApprovalProjectingCoreStateStore(
      base,
      decisionNodes,
      projector(projectApproved),
      afterProjection,
    );

    const first = await state.getApproval(PROCESSING_KEY);
    order.push('returned');
    const second = await state.getApproval(PROCESSING_KEY);
    order.push('returned');

    expect(first).toBe(approved);
    expect(second).toBe(approved);
    expect(order).toEqual([
      'cache',
      'node',
      'project',
      'copy',
      'returned',
      'cache',
      'node',
      'project',
      'copy',
      'returned',
    ]);
    expect(decisionNodes.getState).toHaveBeenCalledTimes(2);
    expect(decisionNodes.getState).toHaveBeenNthCalledWith(1, PROCESSING_KEY);
    expect(projectApproved).toHaveBeenCalledTimes(2);
    expect(afterProjection).toHaveBeenCalledTimes(2);
  });

  it('withholds an approved cache when the post-projection copy gate fails', async () => {
    const base = delegate(async () => approved);
    const storedNode = node();
    const projectApproved = vi.fn(async () => []);
    const afterProjection = vi.fn(async () => {
      throw new Error('independent copy is unavailable');
    });
    const state = new ApprovalProjectingCoreStateStore(
      base,
      { getState: vi.fn(async () => storedNode) },
      projector(projectApproved),
      afterProjection,
    );

    await expect(state.getApproval(PROCESSING_KEY)).rejects.toThrow(
      'independent copy is unavailable',
    );
    expect(projectApproved).toHaveBeenCalledOnce();
    expect(afterProjection).toHaveBeenCalledOnce();
  });

  it('fails closed when an approved cache has no durable decision node', async () => {
    const base = delegate(async () => approved);
    const decisionNodes = { getState: vi.fn(async () => undefined) };
    const projectApproved = vi.fn(async () => []);
    const state = new ApprovalProjectingCoreStateStore(
      base,
      decisionNodes,
      projector(projectApproved),
    );

    await expect(state.getApproval(PROCESSING_KEY)).rejects.toThrow(
      'approved cache has no decision node',
    );
    expect(projectApproved).not.toHaveBeenCalled();
  });

  it.each([
    [
      'status',
      node({ status: 'pending', reviewed_at: null, reviewed_by: null }),
    ],
    ['reviewer', node({ reviewed_by: 'someone-else' })],
    ['reason', node({ reason: 'Different rationale' })],
    [
      'approved brief',
      node({ brief: { ...brief, id: 'different-approved-brief' } }),
    ],
  ])(
    'fails closed when the cached approval diverges by %s',
    async (_label, storedNode) => {
      const base = delegate(async () => approved);
      const decisionNodes = { getState: vi.fn(async () => storedNode) };
      const projectApproved = vi.fn(async () => []);
      const state = new ApprovalProjectingCoreStateStore(
        base,
        decisionNodes,
        projector(projectApproved),
      );

      await expect(state.getApproval(PROCESSING_KEY)).rejects.toThrow(
        'approved cache diverges from decision node',
      );
      expect(projectApproved).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the decision-node lookup returns another processing key', async () => {
    const base = delegate(async () => approved);
    const decisionNodes = {
      getState: vi.fn(async () => node({ processing_key: 'another-key' })),
    };
    const projectApproved = vi.fn(async () => []);
    const state = new ApprovalProjectingCoreStateStore(
      base,
      decisionNodes,
      projector(projectApproved),
    );

    await expect(state.getApproval(PROCESSING_KEY)).rejects.toThrow(
      'decision node processing key diverges',
    );
    expect(projectApproved).not.toHaveBeenCalled();
  });

  it('does not return approval when projection fails', async () => {
    const order: string[] = [];
    const base = delegate(async () => {
      order.push('cache');
      return approved;
    });
    const decisionNodes = {
      getState: vi.fn(async () => {
        order.push('node');
        return node();
      }),
    };
    const projectApproved = vi.fn(async () => {
      order.push('project');
      throw new Error('outbox append failed');
    });
    const state = new ApprovalProjectingCoreStateStore(
      base,
      decisionNodes,
      projector(projectApproved),
    );

    await expect(state.getApproval(PROCESSING_KEY)).rejects.toThrow(
      'outbox append failed',
    );
    expect(order).toEqual(['cache', 'node', 'project']);
  });

  it('keeps save and lifecycle behavior delegated', async () => {
    const base = delegate(async () => approved);
    const state = new ApprovalProjectingCoreStateStore(
      base,
      { getState: vi.fn(async () => node()) },
      projector(vi.fn(async () => [])),
    );

    await state.saveApproval(PROCESSING_KEY, approved);
    state.close();

    expect(base.saveApproval).toHaveBeenCalledWith(PROCESSING_KEY, approved);
    expect(base.close).toHaveBeenCalledOnce();
  });
});
