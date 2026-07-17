import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/core/index.js';
import { ManualApprovalQueue } from '../../src/product/manual-approval.js';

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

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('manual approval queue', () => {
  it('refuses a state root redirected through a final symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'approval-queue-link-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const link = join(parent, 'state');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');

    expect(() => new ManualApprovalQueue(link).list()).toThrow(/direct directory/);
  });

  it('stages once, remains pending, and resumes with an explicit approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-queue-'));
    roots.push(root);
    const queue = new ManualApprovalQueue(root, {
      now: () => '2026-07-16T21:00:00.000Z',
    });

    expect(await queue.review(request())).toEqual({
      status: 'pending',
      reviewed_at: null,
      reviewed_by: null,
      reason: null,
      approved_brief: null,
    });
    const [pending] = queue.list();
    expect(pending).toMatchObject({ status: 'pending', brief: { id: 'brief-1' } });
    const path = join(queue.directory, `${pending!.approval_id}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await queue.resolve({
      approvalId: pending!.approval_id,
      status: 'approved',
      reviewedBy: 'operator',
    });
    const retried = request();
    retried.brief = { ...retried.brief, id: 'brief-from-unapproved-retry' };
    expect(await queue.review(retried)).toEqual({
      status: 'approved',
      reviewed_at: '2026-07-16T21:00:00.000Z',
      reviewed_by: 'operator',
      reason: null,
      approved_brief: request().brief,
    });
    expect(readFileSync(path, 'utf8')).not.toContain('undefined');
  });

  it('rejects traversal-shaped ids and conflicting second resolutions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-queue-'));
    roots.push(root);
    const queue = new ManualApprovalQueue(root);
    await queue.review(request());
    const [pending] = queue.list();
    await queue.resolve({
      approvalId: pending!.approval_id,
      status: 'rejected',
      reviewedBy: 'operator',
      reason: 'revise',
    });
    await expect(
      queue.resolve({
        approvalId: pending!.approval_id,
        status: 'approved',
        reviewedBy: 'operator',
      }),
    ).rejects.toThrow(/already rejected/);
    await expect(
      queue.resolve({
        approvalId: '../escape',
        status: 'approved',
        reviewedBy: 'operator',
      }),
    ).rejects.toThrow(/64-character/);
  });

  it('allows only one winner across concurrent conflicting resolutions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-queue-'));
    roots.push(root);
    const queue = new ManualApprovalQueue(root);
    await queue.review(request());
    const [pending] = queue.list();
    const results = await Promise.allSettled([
      queue.resolve({
        approvalId: pending!.approval_id,
        status: 'approved',
        reviewedBy: 'first-reviewer',
      }),
      queue.resolve({
        approvalId: pending!.approval_id,
        status: 'rejected',
        reviewedBy: 'second-reviewer',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
    expect(['approved', 'rejected']).toContain(queue.list()[0]!.status);
  });
});
