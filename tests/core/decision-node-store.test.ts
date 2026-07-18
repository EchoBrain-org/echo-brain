import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/core/index.js';
import {
  DecisionNodeStore,
  decisionApprovalId,
} from '../../src/product/index.js';

const roots: string[] = [];

function request(): ApprovalRequest {
  return {
    processing_key: 'source:instance:item:revision:processor:instance:version',
    requested_at: '2026-07-16T20:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'source',
          instance_id: 'instance',
          version: '1',
        },
        external_id: 'item',
        canonical_revision: 'revision',
        observed_at: '2026-07-16T19:00:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-07-16T19:00:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: 'meeting-1',
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-07-16T19:30:00.000Z',
      signals: [],
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: {
        id: 'meeting-1',
        title: 'Planning',
        time: { actual_start_at: '2026-07-16T18:00:00.000Z' },
        participants: [],
      },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'revision',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'processor',
          instance_id: 'instance',
          version: '1',
        },
        generated_at: '2026-07-16T19:30:00.000Z',
      },
    },
  };
}

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('decision node store', () => {
  it('refuses a state root redirected through a final symlink', async () => {
    const parent = newRoot('decision-store-link-');
    const target = join(parent, 'target');
    const link = join(parent, 'state');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');

    await expect(new DecisionNodeStore(link).list()).rejects.toThrow(
      /direct directory/,
    );
  });

  it('stages once, remains pending, and preserves the first brief across retries', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });

    const staged = await store.ensureRequested(request());
    expect(staged.status).toBe('pending');
    expect(staged.brief.id).toBe('brief-1');
    const approvalId = decisionApprovalId(request().processing_key);
    expect(staged.approval_id).toBe(approvalId);
    const requestedPath = join(root, 'decisions', approvalId, 'requested.json');
    expect(statSync(requestedPath).mode & 0o777).toBe(0o600);

    // The core cycle recompiles the brief with a fresh id every pending
    // retry; the stored request must keep the originally staged brief.
    const retried = request();
    retried.brief = { ...retried.brief, id: 'brief-from-unapproved-retry' };
    const again = await store.ensureRequested(retried);
    expect(again.status).toBe('pending');
    expect(again.brief.id).toBe('brief-1');
    expect(again.node_id).toBe(staged.node_id);

    const resolved = await store.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'cli',
    });
    expect(resolved).toMatchObject({
      status: 'approved',
      reviewed_at: '2026-07-16T21:00:00.000Z',
      reviewed_by: 'operator',
      reason: null,
      resolved_surface: 'cli',
    });
    expect(resolved.brief.id).toBe('brief-1');
    expect(readFileSync(requestedPath, 'utf8')).not.toContain('undefined');
  });

  it('is first-resolution-wins with idempotent retries and conflicting rejections', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root);
    await store.ensureRequested(request());
    const approvalId = decisionApprovalId(request().processing_key);

    await store.resolve({
      approvalId,
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'revise',
      surface: 'cli',
    });
    // Identical retry returns the winner.
    const repeated = await store.resolve({
      approvalId,
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'revise',
      surface: 'slack',
    });
    expect(repeated.status).toBe('rejected');
    // A conflicting resolution fails.
    await expect(
      store.resolve({
        approvalId,
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'cli',
      }),
    ).rejects.toThrow(/already rejected/);
    await expect(
      store.resolve({
        approvalId: '../escape',
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'cli',
      }),
    ).rejects.toThrow(/64-character/);
  });

  it('records publications create-once per surface and folds them into state', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    await store.ensureRequested(request());

    const published = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });
    expect(published.published).toHaveLength(1);
    expect(published.published[0]).toMatchObject({
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });

    // A repeat publish keeps the originally recorded reference.
    const repeated = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '9999.999' },
    });
    expect(repeated.published).toHaveLength(1);
    expect(repeated.published[0]!.reference['message_ts']).toBe('1700.001');
  });

  it('resolves without any publication (the CLI can win first)', async () => {
    const root = newRoot('decision-store-');
    const store = new DecisionNodeStore(root);
    await store.ensureRequested(request());
    const resolved = await store.resolve({
      approvalId: decisionApprovalId(request().processing_key),
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'cli',
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.published).toHaveLength(0);
  });

  it('imports legacy manual approval records idempotently', async () => {
    const root = newRoot('decision-store-legacy-');
    const processingKey = request().processing_key;
    const approvalId = decisionApprovalId(processingKey);
    const legacyDirectory = join(root, 'approvals');
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(legacyDirectory, `${approvalId}.json`),
      `${JSON.stringify({
        schema_version: 1,
        approval_id: approvalId,
        processing_key: processingKey,
        status: 'approved',
        requested_at: '2026-07-15T20:00:00.000Z',
        reviewed_at: '2026-07-15T21:00:00.000Z',
        reviewed_by: 'operator',
        reason: 'ship it',
        brief: request().brief,
      })}\n`,
      { mode: 0o600 },
    );

    const store = new DecisionNodeStore(root);
    const [imported] = await store.list();
    expect(imported).toMatchObject({
      approval_id: approvalId,
      node_id: approvalId,
      status: 'approved',
      reviewed_at: '2026-07-15T21:00:00.000Z',
      reviewed_by: 'operator',
      reason: 'ship it',
      resolved_surface: 'cli',
    });

    // Re-initialization on a second store instance changes nothing.
    const second = new DecisionNodeStore(root);
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(imported);
  });
});
