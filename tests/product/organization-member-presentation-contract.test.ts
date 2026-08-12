import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, JsonObject } from '../../src/core/index.js';
import {
  DecisionNodeStore,
  ORGANIZATION_MEMBER_READABLE_SURFACE,
  RESTRICTED_REVIEWER_SURFACE,
} from '../../src/product/approval/decision-node-store.js';
import type {
  OrganizationMemberSlackApprovalPresentationContract,
  SlackApprovalPresentationContract,
} from '../../src/product/approval/decision-node.js';
import { decisionApprovalId } from '../../src/product/approval/decision-node.js';

const roots: string[] = [];
const PROCESSING_KEY =
  'source:instance:item:revision:processor:instance:version';
const APPROVAL_ID = decisionApprovalId(PROCESSING_KEY);
const EVALUATED_AT = '2026-08-11T12:00:00.000Z';
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function request(): ApprovalRequest {
  return {
    processing_key: PROCESSING_KEY,
    requested_at: '2026-08-11T11:00:00.000Z',
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
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: { id: 'meeting-1', title: 'Planning', participants: [] },
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
        generated_at: '2026-08-11T10:30:00.000Z',
      },
    },
  } as unknown as ApprovalRequest;
}

function memberContract(
  overrides: Partial<OrganizationMemberSlackApprovalPresentationContract> = {},
): OrganizationMemberSlackApprovalPresentationContract {
  return {
    schema_version: 1,
    kind: 'echo-slack-approval-presentation-contract',
    mode: 'organization-member-readable-v1',
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
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: digest('2'),
    release_draft_sha256: digest('3'),
    approval_presentation_sha256: digest('4'),
    ...overrides,
  };
}

function reviewerContract(): SlackApprovalPresentationContract {
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
    reviewer_release_draft_sha256: digest('3'),
    approval_presentation_sha256: digest('4'),
  };
}

function memberEvidence(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    schema_version: 3,
    kind: 'echo-organization-authorization-evidence',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: digest('2'),
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    approval_id: APPROVAL_ID,
    action: 'approve',
    request_sha256: digest('5'),
    provider_event_sha256: digest('6'),
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
    permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
    evaluated_at: EVALUATED_AT,
    authorization_audit_event_id:
      'aud_00000000-0000-4000-8000-000000000001',
    authorization_audit_entry_sha256: digest('7'),
    release_draft_sha256: digest('3'),
    approval_presentation_sha256: digest('4'),
    semantic_intent_sha256: digest('8'),
    message_presentation_sha256: digest('9'),
    ...overrides,
  } as JsonObject;
}

function reviewerEvidence(): JsonObject {
  return {
    schema_version: 2,
    kind: 'echo-organization-authorization-evidence',
  };
}

async function stagedStore(): Promise<DecisionNodeStore> {
  const root = mkdtempSync(join(tmpdir(), 'member-contract-'));
  roots.push(root);
  const store = new DecisionNodeStore(root);
  await store.ensureRequested(request());
  return store;
}

describe('organization-member approval presentation contract', () => {
  it('freezes only the exact schema-v3 organization-member contract shape', async () => {
    const store = await stagedStore();
    for (const invalid of [
      {
        ...memberContract(),
        reviewer_release_draft_sha256: digest('f'),
      },
      Object.defineProperty(memberContract(), Symbol('extra'), {
        value: true,
        enumerable: true,
      }),
    ]) {
      await expect(
        store.freezeApprovalPresentationContract({
          approvalId: APPROVAL_ID,
          contract: invalid as OrganizationMemberSlackApprovalPresentationContract,
        }),
      ).rejects.toThrow(/presentation_contract/);
    }

    const frozen = await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: memberContract(),
    });
    expect(frozen).toEqual(memberContract());
    expect(store.readFrozenApprovalPresentationContract(APPROVAL_ID)).toEqual(
      memberContract(),
    );
    expect(store.listUnresolvedFrozenApprovalPresentationContracts()).toEqual([
      { approval_id: APPROVAL_ID, contract: memberContract() },
    ]);
    // The historical reviewer-only listing remains narrow, so old reviewer
    // callers cannot reinterpret a schema-v3 slot as their own contract.
    expect(store.listUnresolvedApprovalPresentationContracts()).toEqual([
      { approval_id: APPROVAL_ID, contract: null },
    ]);
  });

  it('binds the schema-v3 evidence to the organization-member surface and frozen contract', async () => {
    const store = await stagedStore();
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: memberContract(),
    });

    const resolved = await store.resolve({
      approvalId: APPROVAL_ID,
      status: 'approved',
      reviewedBy: 'Reviewer One',
      reviewedAt: EVALUATED_AT,
      surface: ORGANIZATION_MEMBER_READABLE_SURFACE,
      metadata: { authorization: memberEvidence() },
    });
    expect(resolved).toMatchObject({
      status: 'approved',
      reviewed_at: EVALUATED_AT,
      reviewed_by: 'Reviewer One',
      resolved_surface: ORGANIZATION_MEMBER_READABLE_SURFACE,
    });
  });

  it.each([
    ['reviewer evidence on the organization-member surface', reviewerEvidence()],
    ['wrong approval', memberEvidence({ approval_id: 'b'.repeat(64) })],
    ['wrong evaluated time', memberEvidence({ evaluated_at: '2026-08-11T12:01:00.000Z' })],
    ['wrong policy contract', memberEvidence({ policy_contract_sha256: digest('f') })],
    ['wrong release digest', memberEvidence({ release_draft_sha256: digest('f') })],
    ['wrong presentation digest', memberEvidence({ approval_presentation_sha256: digest('f') })],
  ])('refuses %s', async (_label, authorization) => {
    const store = await stagedStore();
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: memberContract(),
    });
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        reviewedAt: EVALUATED_AT,
        surface: ORGANIZATION_MEMBER_READABLE_SURFACE,
        metadata: { authorization },
      }),
    ).rejects.toThrow();
  });

  it('refuses a reviewer label that differs from the frozen contract', async () => {
    const store = await stagedStore();
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: memberContract(),
    });
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer Two',
        reviewedAt: EVALUATED_AT,
        surface: ORGANIZATION_MEMBER_READABLE_SURFACE,
        metadata: { authorization: memberEvidence() },
      }),
    ).rejects.toThrow(/does not bind its frozen presentation contract/);
  });

  it('refuses schema-v3 evidence on the reviewer surface', async () => {
    const store = await stagedStore();
    await store.freezeApprovalPresentationContract({
      approvalId: APPROVAL_ID,
      contract: reviewerContract(),
    });
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        reviewedAt: EVALUATED_AT,
        surface: RESTRICTED_REVIEWER_SURFACE,
        metadata: { authorization: memberEvidence() },
      }),
    ).rejects.toThrow(/cross-version evidence or presentation contract/);
  });
});
