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
  type DecisionNodeFederationCapture,
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

    // Once the first-open migration completes, later legacy records are ignored.
    const ignoredProcessingKey = `${processingKey}:late`;
    const ignoredApprovalId = decisionApprovalId(ignoredProcessingKey);
    writeFileSync(
      join(legacyDirectory, `${ignoredApprovalId}.json`),
      `${JSON.stringify({
        schema_version: 1,
        approval_id: ignoredApprovalId,
        processing_key: ignoredProcessingKey,
        status: 'pending',
        requested_at: '2026-07-15T22:00:00.000Z',
        reviewed_at: null,
        reviewed_by: null,
        reason: null,
        brief: request().brief,
      })}\n`,
      { mode: 0o600 },
    );
    expect(await new DecisionNodeStore(root).list()).toEqual([imported]);
  });

  it('captures and exposes immutable federation slot metadata without changing node identity', async () => {
    const root = newRoot('decision-store-federation-');
    const calls: string[] = [];
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        calls.push('capture-requested');
        return { federation: { candidate_context_sha256: 'sha256:candidate' } };
      },
      async validateRequested() {
        calls.push('validate-requested');
      },
      async capturePublished({ reference }) {
        calls.push('capture-published');
        return {
          slack: reference,
          federation: { rendered_blocks_sha256: 'sha256:blocks' },
        };
      },
      async validatePublished() {
        calls.push('validate-published');
      },
      async captureResolved() {
        calls.push('capture-resolved');
        return { federation: { assurance: 'provider_challenge_observed' } };
      },
      async validateResolved() {
        calls.push('validate-resolved');
      },
    };
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
      federationCapture: capture,
    });
    const first = await store.ensureRequested(request());
    const approvalId = decisionApprovalId(request().processing_key);
    expect(first.approval_id).toBe(approvalId);
    expect(first.requested_metadata).toEqual({
      federation: { candidate_context_sha256: 'sha256:candidate' },
    });
    expect(calls).toEqual([
      'capture-requested',
      'validate-requested',
      'validate-requested',
    ]);
    calls.length = 0;

    await store.ensureRequested(request());
    expect(calls).toEqual(['validate-requested', 'validate-requested']);
    calls.length = 0;
    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
      presentationEvidence: { rendered_blocks_sha256: 'sha256:blocks' },
    });
    expect(calls).toEqual([
      'validate-requested',
      'capture-published',
      'validate-published',
      'validate-requested',
      'validate-published',
    ]);
    calls.length = 0;
    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: 'ignored' },
    });
    expect(calls).toEqual(['validate-requested', 'validate-published']);
    calls.length = 0;
    const resolved = await store.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'slack',
      resolutionEvidence: { reviewer_user_id: 'U123' },
    });
    expect(resolved.resolved_metadata).toEqual({
      federation: { assurance: 'provider_challenge_observed' },
    });
    expect(calls).toEqual([
      'validate-requested',
      'validate-published',
      'capture-resolved',
      'validate-resolved',
      'validate-requested',
      'validate-published',
      'validate-resolved',
    ]);
    calls.length = 0;
    await store.resolve({
      approvalId,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'slack',
    });
    expect(calls).toEqual([
      'validate-requested',
      'validate-published',
      'validate-resolved',
    ]);
  });

  it('cannot read stored federation metadata without federation validation', async () => {
    const root = newRoot('decision-store-federation-reader-guard-');
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate_context_sha256: 'sha256:candidate' } };
      },
      async validateRequested() {},
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {},
      async captureResolved({ legacyMetadata }) {
        return legacyMetadata;
      },
      async validateResolved() {},
    };
    await new DecisionNodeStore(root, {
      federationCapture: capture,
    }).ensureRequested(request());

    await expect(
      new DecisionNodeStore(root).getState(request().processing_key),
    ).rejects.toThrow(
      /stored federated approval cannot be read without identity capture validation/,
    );
  });

  it('lists structurally federated nodes without reclassifying legacy nodes', async () => {
    const root = newRoot('decision-store-federated-list-');
    const legacy = await new DecisionNodeStore(root).ensureRequested(request());
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate: true } };
      },
      async validateRequested() {},
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {},
      async captureResolved({ legacyMetadata }) {
        return legacyMetadata;
      },
      async validateResolved() {},
    };
    const nativeRequest = request();
    nativeRequest.processing_key = `${nativeRequest.processing_key}:native`;
    const activeStore = new DecisionNodeStore(root, {
      federationCapture: capture,
    });
    const native = await activeStore.ensureRequested(nativeRequest);

    expect(
      (await activeStore.listFederated()).map((item) => item.approval_id),
    ).toEqual([native.approval_id]);
    expect(native.approval_id).not.toBe(legacy.approval_id);
  });

  it('keeps DEV.6 nodes readable but immutable after identity activation', async () => {
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
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate: true } };
      },
      async validateRequested() {},
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {},
      async captureResolved({ legacyMetadata }) {
        return legacyMetadata;
      },
      async validateResolved() {},
    };
    const activeStore = new DecisionNodeStore(root, {
      federationCapture: capture,
    });

    await expect(
      activeStore.getState(request().processing_key),
    ).resolves.toMatchObject({
      approval_id: legacy.approval_id,
      status: 'approved',
      requested_metadata: {},
    });
    await expect(activeStore.list()).resolves.toHaveLength(1);
    await expect(activeStore.listFederated()).resolves.toEqual([]);

    await expect(
      activeStore.recordPublished({
        processingKey: request().processing_key,
        surface: 'terminal',
        reference: { output: 'must-not-be-written' },
      }),
    ).rejects.toThrow(/pre-cutover decision node is immutable/);
    await expect(
      activeStore.resolve({
        approvalId: legacy.approval_id,
        status: 'approved',
        reviewedBy: 'founder',
        surface: 'slack',
      }),
    ).rejects.toThrow(/pre-cutover decision node is immutable/);
    expect(
      existsSync(
        join(root, 'decisions', legacy.approval_id, 'published-terminal.json'),
      ),
    ).toBe(false);

    const nativeRequest = request();
    nativeRequest.processing_key = `${nativeRequest.processing_key}:native`;
    const native = await activeStore.ensureRequested(nativeRequest);
    expect(
      (await activeStore.listFederated()).map((item) => item.approval_id),
    ).toEqual([native.approval_id]);
  });

  it('leaves no decision-node residue when requested federation capture fails', async () => {
    for (const failingStage of ['capture', 'validate'] as const) {
      const root = newRoot(`decision-store-request-${failingStage}-`);
      const approvalId = decisionApprovalId(request().processing_key);
      const capture: DecisionNodeFederationCapture = {
        async captureRequested() {
          if (failingStage === 'capture') throw new Error('capture failed');
          return { federation: { candidate: true } };
        },
        async validateRequested() {
          if (failingStage === 'validate') throw new Error('validate failed');
        },
        async capturePublished({ reference }) {
          return reference;
        },
        async validatePublished() {},
        async captureResolved({ legacyMetadata }) {
          return legacyMetadata;
        },
        async validateResolved() {},
      };
      const store = new DecisionNodeStore(root, { federationCapture: capture });

      await expect(store.ensureRequested(request())).rejects.toThrow(
        new RegExp(`${failingStage} failed`),
      );
      expect(existsSync(join(root, 'decisions', approvalId))).toBe(false);
      expect(existsSync(join(root, 'decisions', '.locks', approvalId))).toBe(
        false,
      );
    }
  });

  it('does not create a publication slot when federation validation fails', async () => {
    const root = newRoot('decision-store-publication-reject-');
    let rejectPublication = false;
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate: true } };
      },
      async validateRequested() {},
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {
        if (rejectPublication) throw new Error('publication evidence invalid');
      },
      async captureResolved({ legacyMetadata }) {
        return legacyMetadata;
      },
      async validateResolved() {},
    };
    const store = new DecisionNodeStore(root, { federationCapture: capture });
    const staged = await store.ensureRequested(request());
    rejectPublication = true;

    await expect(
      store.recordPublished({
        processingKey: request().processing_key,
        surface: 'slack',
        reference: { channel_id: 'C123', message_ts: '1700.001' },
      }),
    ).rejects.toThrow(/publication evidence invalid/);
    expect(
      existsSync(
        join(root, 'decisions', staged.approval_id, 'published-slack.json'),
      ),
    ).toBe(false);
    rejectPublication = false;
    expect((await store.getState(request().processing_key))?.status).toBe(
      'pending',
    );
  });

  it('revalidates every existing federation slot before returning a node', async () => {
    const root = newRoot('decision-store-existing-validation-');
    let failingStage: 'requested' | 'published' | 'resolved' | null = null;
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate: true } };
      },
      async validateRequested() {
        if (failingStage === 'requested') throw new Error('requested corrupt');
      },
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {
        if (failingStage === 'published') throw new Error('published corrupt');
      },
      async captureResolved({ legacyMetadata }) {
        return legacyMetadata;
      },
      async validateResolved() {
        if (failingStage === 'resolved') throw new Error('resolved corrupt');
      },
    };
    const store = new DecisionNodeStore(root, { federationCapture: capture });
    const staged = await store.ensureRequested(request());
    await store.recordPublished({
      processingKey: request().processing_key,
      surface: 'slack',
      reference: { channel_id: 'C123', message_ts: '1700.001' },
    });
    await store.resolve({
      approvalId: staged.approval_id,
      status: 'approved',
      reviewedBy: 'operator',
      surface: 'slack',
    });

    for (const stage of ['requested', 'published', 'resolved'] as const) {
      failingStage = stage;
      await expect(store.ensureRequested(request())).rejects.toThrow(
        new RegExp(`${stage} corrupt`),
      );
    }

    failingStage = 'published';
    await expect(
      store.recordPublished({
        processingKey: request().processing_key,
        surface: 'terminal',
        reference: { output: 'must-not-be-written' },
      }),
    ).rejects.toThrow(/published corrupt/);
    expect(
      existsSync(
        join(root, 'decisions', staged.approval_id, 'published-terminal.json'),
      ),
    ).toBe(false);

    failingStage = 'resolved';
    await expect(
      store.resolve({
        approvalId: staged.approval_id,
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'slack',
      }),
    ).rejects.toThrow(/resolved corrupt/);

    failingStage = null;
    expect((await store.getState(request().processing_key))?.status).toBe(
      'approved',
    );
  });

  it('refuses legacy decision mutation when identity material exists without capture hooks', async () => {
    const root = newRoot('decision-store-identity-guard-');
    const manifests = join(root, 'identity', 'manifests');
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, 'interrupted-bootstrap.json'), '{}\n', {
      mode: 0o600,
    });

    await expect(
      new DecisionNodeStore(root).ensureRequested(request()),
    ).rejects.toThrow(/identity-enabled decision capture is unavailable/);
  });

  it('does not create a resolution slot when federation validation fails', async () => {
    const root = newRoot('decision-store-federation-reject-');
    const capture: DecisionNodeFederationCapture = {
      async captureRequested() {
        return { federation: { candidate_context_sha256: 'sha256:candidate' } };
      },
      async validateRequested() {},
      async capturePublished({ reference }) {
        return reference;
      },
      async validatePublished() {},
      async captureResolved() {
        return { federation: { actor: 'untrusted' } };
      },
      async validateResolved() {
        throw new Error('actor evidence is invalid');
      },
    };
    const store = new DecisionNodeStore(root, {
      now: () => '2026-07-16T21:00:00.000Z',
      federationCapture: capture,
    });
    const staged = await store.ensureRequested(request());

    await expect(
      store.resolve({
        approvalId: staged.approval_id,
        status: 'approved',
        reviewedBy: 'operator',
        surface: 'cli',
      }),
    ).rejects.toThrow(/actor evidence is invalid/);
    expect(
      existsSync(join(root, 'decisions', staged.approval_id, 'resolved.json')),
    ).toBe(false);
    capture.validateResolved = async () => {};
    expect((await store.getState(request().processing_key))?.status).toBe(
      'pending',
    );
  });
});
