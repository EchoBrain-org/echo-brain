import {
  existsSync,
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

    // The shared retirement preflight refuses an uninspectable root before the
    // store's own path check can run. Either refusal is correct; what matters
    // is that a symlinked state root is never opened.
    await expect(new DecisionNodeStore(link).list()).rejects.toThrow(
      /cannot be inspected|direct directory/,
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

  it('serializes conflicting resolutions across independent store instances', async () => {
    const root = newRoot('decision-store-race-');
    const first = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const second = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:01.000Z',
    });
    await first.ensureRequested(request());
    const approvalId = decisionApprovalId(request().processing_key);

    const attempts = await Promise.allSettled([
      first.resolve({
        approvalId,
        status: 'approved',
        reviewedBy: 'slack-reviewer',
        surface: 'slack',
      }),
      second.resolve({
        approvalId,
        status: 'rejected',
        reviewedBy: 'cli-reviewer',
        surface: 'cli',
      }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    const [winner] = await new DecisionNodeStore(root).list();
    expect(winner!.status).toMatch(/^(approved|rejected)$/);
    expect(
      attempts.some(
        (attempt) =>
          attempt.status === 'fulfilled' &&
          attempt.value.status === winner!.status,
      ),
    ).toBe(true);
  });

  it('records publications create-once per surface and durably retains a superseding surface', async () => {
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

    const replacement = await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C123', message_ts: '1800.001' },
    });
    const [reloaded] = await new DecisionNodeStore(root).list();
    expect(reloaded?.published).toEqual(replacement.published);
    expect(replacement.published[0]).toMatchObject({
      surface: 'slack-authority-v1',
      reference: { channel_id: 'C123', message_ts: '1800.001' },
    });
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

  it('keeps ordinary nodes local while treating later federation-shaped fields as opaque', async () => {
    const root = newRoot('decision-store-local-metadata-');
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const staged = await store.ensureRequested(request());
    expect(staged.requested_metadata).toEqual({});

    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { federation: { opaque: 'publication' } },
    });
    const resolved = await store.resolve({
      approvalId: staged.approval_id,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'slack',
      metadata: { federation: { opaque: 'resolution' } },
    });

    expect(resolved.published[0]?.reference).toEqual({
      federation: { opaque: 'publication' },
    });
    expect(resolved.resolved_metadata).toEqual({
      federation: { opaque: 'resolution' },
    });
    expect((await store.getState(request().processing_key))?.status).toBe(
      'approved',
    );
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses every operation on historical requested federation metadata without writing later slots', async () => {
    const root = newRoot('decision-store-retired-federation-');
    const store = new DecisionNodeStore(root);
    await store.initialize();
    const approvalId = decisionApprovalId(request().processing_key);
    const nodeDirectory = join(root, 'decisions', approvalId);
    mkdirSync(nodeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(nodeDirectory, 'requested.json'),
      `${JSON.stringify({
        schema_version: 1,
        event_type: 'requested',
        node_id: 'historical-federated-node',
        processing_key: request().processing_key,
        requested_at: request().requested_at,
        brief: request().brief,
        alternatives: [],
        links: { parent: null, supersedes: null },
        metadata: { federation: { historical: true } },
      })}\n`,
      { mode: 0o600 },
    );

    const operations = [
      () => store.getState(request().processing_key),
      () => store.list(),
      () => store.ensureRequested(request()),
      () =>
        store.recordPublished({
          processingKey: request().processing_key,
          surface: 'terminal',
          reference: { output: 'must-not-be-written' },
        }),
      () =>
        store.resolve({
          approvalId,
          status: 'approved',
          reviewedBy: 'operator',
          surface: 'cli',
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(/retired federation metadata/);
    }
    expect(existsSync(join(nodeDirectory, 'published-terminal.json'))).toBe(
      false,
    );
    expect(existsSync(join(nodeDirectory, 'resolved.json'))).toBe(false);
  });

  it('refuses every operation, including reads, once founder identity material appears', async () => {
    const root = newRoot('decision-store-cutover-legacy-');
    const legacyStore = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });
    const legacy = await legacyStore.ensureRequested(request());
    await legacyStore.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });
    await legacyStore.resolve({
      approvalId: legacy.approval_id,
      status: 'approved',
      reviewedBy: 'founder',
      surface: 'slack',
      metadata: {
        slack: {
          channel_id: 'C123',
          message_ts: '1700.001',
          reviewer_user_id: 'U123',
        },
      },
    });

    const manifests = join(root, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'cutover-marker.json'), '{}\n', {
      mode: 0o600,
    });
    const activeStore = new DecisionNodeStore(root);

    const retired = /retired/;
    await expect(
      activeStore.getState(request().processing_key),
    ).rejects.toThrow(retired);
    await expect(activeStore.list()).rejects.toThrow(retired);
    await expect(
      activeStore.recordPublished({
        processingKey: request().processing_key,
        surface: 'terminal',
        reference: { output: 'must-not-be-written' },
      }),
    ).rejects.toThrow(retired);
    await expect(
      activeStore.resolve({
        approvalId: legacy.approval_id,
        status: 'approved',
        reviewedBy: 'founder',
        surface: 'slack',
      }),
    ).rejects.toThrow(retired);
    const nativeRequest = request();
    nativeRequest.processing_key = `${nativeRequest.processing_key}:native`;
    await expect(activeStore.ensureRequested(nativeRequest)).rejects.toThrow(
      retired,
    );

    // Refused before anything was written.
    expect(
      existsSync(
        join(root, 'decisions', legacy.approval_id, 'published-terminal.json'),
      ),
    ).toBe(false);
    expect(existsSync(join(root, 'decisions', legacy.approval_id))).toBe(true);
  });

  it('refuses legacy decision mutation when identity material exists without capture hooks', async () => {
    const root = newRoot('decision-store-identity-guard-');
    const manifests = join(root, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'interrupted-bootstrap.json'), '{}\n', {
      mode: 0o600,
    });

    // The shared founder-provenance retirement gate refuses the root before
    // the local decision store creates or reads a node.
    await expect(
      new DecisionNodeStore(root).ensureRequested(request()),
    ).rejects.toThrow(/retired/);
  });

});
