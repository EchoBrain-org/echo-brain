import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@echo-brain/organization-authority/processing/core/index.js';
import {
  DecisionNodeStore,
  decisionApprovalId,
  type SlackApprovalPresentationContract,
} from '../../src/product/index.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-contract-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const PROCESSING_KEY =
  'source:instance:item:revision:processor:instance:version';
const APPROVAL_ID = decisionApprovalId(PROCESSING_KEY);
const CONTRACT_FILE =
  'presentation-contract-slack-authority-v1.json';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function request(): ApprovalRequest {
  const brief = {
    schema_version: 1 as const,
    id: 'brief-1',
    meeting: {
      id: 'meeting-1',
      title: 'Planning',
      time: { actual_start_at: '2026-08-11T10:00:00.000Z' },
      participants: [],
    },
    decisions: [],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'revision',
      processor: {
        kind: 'decision-processor' as const,
        adapter_id: 'processor',
        instance_id: 'instance',
        version: '1',
      },
      generated_at: '2026-08-11T10:30:00.000Z',
    },
  };
  return {
    processing_key: PROCESSING_KEY,
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: 'meeting-1',
      title: 'Planning',
      time: { actual_start_at: '2026-08-11T10:00:00.000Z' },
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
        observed_at: '2026-08-11T10:15:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-11T10:15:00.000Z',
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
      generated_at: '2026-08-11T10:30:00.000Z',
      signals: [],
    },
    brief,
  } as unknown as ApprovalRequest;
}

function contract(
  overrides: Partial<SlackApprovalPresentationContract> = {},
): SlackApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'restricted-reviewer-v1',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'default',
    adapter_version: '1.0.0',
    channel_id: 'C012CHANNEL',
    reviewer_slack_user_id: 'U012REVIEWER',
    reviewer_name: 'Reviewer One',
    credential_ref: 'env:ECHO_SLACK_BOT_TOKEN',
    credential_fingerprint_sha256: digest('1'),
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    reviewer_release_draft_sha256: digest('2'),
    approval_presentation_sha256: digest('3'),
    ...overrides,
  };
}

async function stagedStore(): Promise<DecisionNodeStore> {
  const store = new DecisionNodeStore(newRoot());
  await store.ensureRequested(request());
  return store;
}

describe('reviewer approval presentation contract', () => {
  it('freezes the publication mode once, before any provider request', async () => {
    const store = await stagedStore();
    const frozen = await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: contract(),
    });
    expect(frozen.mode).toBe('restricted-reviewer-v1');
    expect(store.readApprovalPresentationContract(APPROVAL_ID)).toEqual(
      contract(),
    );

    const path = join(store.directory, APPROVAL_ID, CONTRACT_FILE);
    expect(existsSync(path)).toBe(true);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      event_type: string;
      surface: string;
      presentation_contract: Record<string, unknown>;
    };
    expect(stored.event_type).toBe('approval-presentation-contract');
    expect(stored.surface).toBe('slack-authority-v1');
    // The slot stores digests and a non-secret reference, never token bytes
    // and never a second copy of the title or item text.
    expect(Object.keys(stored.presentation_contract).sort()).toEqual(
      [
        'schema_version',
        'kind',
        'mode',
        'adapter_id',
        'adapter_instance_id',
        'adapter_version',
        'channel_id',
        'reviewer_slack_user_id',
        'reviewer_name',
        'credential_ref',
        'credential_fingerprint_sha256',
        'approve_reaction',
        'reject_reaction',
        'reviewer_release_draft_sha256',
        'approval_presentation_sha256',
      ].sort(),
    );
  });

  it('accepts the identical retry and refuses any changed contract', async () => {
    const store = await stagedStore();
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: contract(),
    });
    await expect(
      store.freezeApprovalPresentationContract({
        approvalId: APPROVAL_ID,
        contract: contract(),
      }),
    ).resolves.toEqual(contract());

    for (const changed of [
      { approve_reaction: 'heavy_check_mark' },
      { reject_reaction: 'no_entry' },
      { adapter_instance_id: 'second' },
      { channel_id: 'C099OTHER' },
      { reviewer_slack_user_id: 'U099OTHER' },
      { credential_ref: 'env:OTHER_TOKEN' },
      { credential_fingerprint_sha256: digest('9') },
      { reviewer_release_draft_sha256: digest('8') },
      { approval_presentation_sha256: digest('7') },
    ] satisfies Partial<SlackApprovalPresentationContract>[]) {
      await expect(
        store.freezeApprovalPresentationContract({
          approvalId: APPROVAL_ID,
          contract: contract(changed),
        }),
      ).rejects.toThrow('already froze a different approval presentation');
    }
  });

  it('refuses a malformed or non-reviewer contract before writing', async () => {
    const store = await stagedStore();
    for (const invalid of [
      { mode: 'ordinary-v1' },
      { mode: 'pilot-member-readable-v1' },
      { approve_reaction: 'white_check_mark', reject_reaction: 'white_check_mark' },
      { credential_ref: 'ECHO_SLACK_BOT_TOKEN' },
      { reviewer_slack_user_id: 'not-a-slack-user' },
      { credential_fingerprint_sha256: 'sha256:zz' },
    ] as Partial<SlackApprovalPresentationContract>[]) {
      await expect(
        store.freezeApprovalPresentationContract({
          approvalId: APPROVAL_ID,
          contract: contract(invalid),
        }),
      ).rejects.toThrow(/invalid decision node event/);
    }
    expect(store.readApprovalPresentationContract(APPROVAL_ID)).toBeNull();
  });

  it('omits requested-only crash windows and lists frozen unresolved cards', async () => {
    const store = await stagedStore();
    expect(store.listUnresolvedApprovalPresentationContracts()).toEqual([]);
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: contract(),
    });
    expect(store.listUnresolvedApprovalPresentationContracts()).toEqual([
      { approval_id: APPROVAL_ID, contract: contract() },
    ]);
    await store.resolve({
      approvalId: APPROVAL_ID,
      status: 'approved',
      reviewedBy: 'Reviewer One',
      surface: 'slack-reactions',
    });
    expect(store.listUnresolvedApprovalPresentationContracts()).toEqual([]);
  });
});
