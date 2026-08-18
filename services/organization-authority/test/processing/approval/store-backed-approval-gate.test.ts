import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../../src/processing/core/index.js';
import type { DecisionNodeState } from '../../../src/processing/approval/decision-node.js';
import {
  StoreBackedApprovalGate,
  type DecisionNodeRequestStore,
} from '../../../src/processing/approval/store-backed-approval-gate.js';

const processor = {
  kind: 'decision-processor' as const,
  adapter_id: 'structured-text',
  instance_id: 'default',
  version: '1.0.0',
};

const request: ApprovalRequest = {
  processing_key: 'source:primary:item:revision:structured-text:default:1.0.0',
  requested_at: '2026-08-18T18:00:00.000Z',
  meeting: {
    schema_version: 1,
    id: 'meeting-1',
    title: 'Planning',
    capture: { state: 'complete', components: [] },
    participants: [],
    content: [],
    artifacts: [],
    provenance: {
      source: {
        kind: 'meeting-source',
        adapter_id: 'source',
        instance_id: 'primary',
        version: '1.0.0',
      },
      external_id: 'item',
      canonical_revision: 'revision',
      observed_at: '2026-08-18T17:00:00.000Z',
      normalizer_version: '1.0.0',
    },
  },
  decisions: {
    schema_version: 1,
    meeting_id: 'meeting-1',
    meeting_revision: 'revision',
    processor,
    generated_at: '2026-08-18T17:30:00.000Z',
    signals: [],
  },
  brief: {
    schema_version: 1,
    id: 'brief-1',
    meeting: { id: 'meeting-1', title: 'Planning', participants: [] },
    decisions: [],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'revision',
      processor,
      generated_at: '2026-08-18T17:30:00.000Z',
    },
  },
};

function node(
  status: DecisionNodeState['status'],
): DecisionNodeState {
  const resolved = status === 'pending' ? null : '2026-08-18T18:05:00.000Z';
  return {
    approval_id: 'a'.repeat(64),
    node_id: 'node-1',
    processing_key: request.processing_key,
    requested_at: request.requested_at,
    requested_metadata: {},
    brief: request.brief,
    alternatives: [],
    links: { parent: null, supersedes: null },
    source: null,
    status,
    reviewed_at: resolved,
    reviewed_by: resolved === null ? null : 'Reviewer One',
    reason: status === 'rejected' ? 'Not yet.' : null,
    resolved_surface: resolved === null ? null : 'test',
    resolved_metadata: resolved === null ? null : {},
    published: [],
    organization_record: {
      status: 'unresolved',
      envelope: null,
      receipt: null,
      rejection: null,
    },
  };
}

class FakeRequestStore implements DecisionNodeRequestStore {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly state: DecisionNodeState) {}

  async ensureRequested(candidate: ApprovalRequest): Promise<DecisionNodeState> {
    this.requests.push(candidate);
    return this.state;
  }
}

describe('store-backed approval gate', () => {
  it.each([
    ['pending', null],
    ['approved', request.brief],
    ['rejected', null],
  ] as const)('projects the stored %s node', async (status, approvedBrief) => {
    const store = new FakeRequestStore(node(status));
    const decision = await new StoreBackedApprovalGate(store).review(request);

    expect(store.requests).toEqual([request]);
    expect(decision.status).toBe(status);
    expect(decision.approved_brief).toBe(approvedBrief);
    expect(decision.reviewed_at).toBe(
      status === 'pending' ? null : '2026-08-18T18:05:00.000Z',
    );
  });
});
