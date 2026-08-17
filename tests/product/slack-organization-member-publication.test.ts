import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdapterConfig, ApprovalRequest, JsonObject } from '@echo-brain/organization-authority/processing/core/index.js';
import {
  createSlackReactionsApprovalSurface,
  type ApprovalActionAuthorizer,
  type ApprovalDecisionStore,
  type ApprovalDecisionStoreView,
  type FrozenOrganizationMemberApprovalPresentationContract,
  type FrozenSlackApprovalPresentationContract,
  type OrganizationMemberApprovalActionAuthorizationRequest,
} from '@echo-brain/organization-authority/processing/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import { validateOrganizationMemberAuthorizationEvidence } from '../../src/product/approval/organization-member-authorization-evidence.js';
import {
  organizationMemberApprovalPresentationRenderer,
} from '../../src/product/organization/record/adapters/organization-member-presentation-renderer.js';
import { assertReviewerDisplayName } from '../../src/product/approval/reviewer-authorization-evidence.js';

const REVIEWER = 'U012REVIEWER';
const EVALUATED_AT = '2026-08-11T12:00:00.000Z';
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const processingKey = 'source:instance:item:revision:processor:instance:version';
const approvalId = createHash('sha256').update(processingKey).digest('hex');

function request(): ApprovalRequest {
  return {
    processing_key: processingKey,
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: { schema_version: 1, id: 'meeting-1', title: 'Pricing review', capture: { state: 'complete', components: [] }, participants: [], content: [], artifacts: [], provenance: { source: { kind: 'meeting-source', adapter_id: 'source', instance_id: 'instance', version: '1' }, external_id: 'item', canonical_revision: 'revision', observed_at: '2026-08-11T10:15:00.000Z', normalizer_version: '1', source_updated_at: '2026-08-11T10:15:00.000Z' } },
    decisions: { schema_version: 1, meeting_id: 'meeting-1', meeting_revision: 'revision', processor: { kind: 'decision-processor', adapter_id: 'processor', instance_id: 'instance', version: '1' }, generated_at: '2026-08-11T10:30:00.000Z', signals: [] },
    brief: { schema_version: 1, id: 'brief-1', meeting: { id: 'meeting-1', title: 'Pricing review', participants: [] }, decisions: [{ id: 'signal-decision-1', kind: 'decision', text: 'Ship the member-readable release.', subject: null, confidence: null, evidence: [{ meeting_id: 'meeting-1', block_id: 'block-1' }], status: 'decided' }], actions: [], rationales: [], provenance: { meeting_revision: 'revision', processor: { kind: 'decision-processor', adapter_id: 'processor', instance_id: 'instance', version: '1' }, generated_at: '2026-08-11T10:30:00.000Z' } },
  } as unknown as ApprovalRequest;
}

function evidence(input: OrganizationMemberApprovalActionAuthorizationRequest): JsonObject {
  return {
    schema_version: 3, kind: 'echo-organization-authorization-evidence',
    policy_id: input.policy_id, policy_contract_sha256: input.policy_contract_sha256,
    authority_id: 'oau_00000000-0000-4000-8000-000000000001', organization_id: 'org_00000000-0000-4000-8000-000000000001', enrollment_id: 'enr_00000000-0000-4000-8000-000000000001', installation_id: 'ins_00000000-0000-4000-8000-000000000001', request_id: 'pcr_00000000-0000-4000-8000-000000000001', approval_id: input.approval_id, action: 'approve', request_sha256: digest('1'), provider_event_sha256: digest('2'), allowed: true, reason_code: 'active_organization_member_readable_notice_v1', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001', permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001', evaluated_at: EVALUATED_AT, authorization_audit_event_id: 'aud_00000000-0000-4000-8000-000000000001', authorization_audit_entry_sha256: digest('3'), release_draft_sha256: input.release_draft_sha256, approval_presentation_sha256: input.approval_presentation_sha256, semantic_intent_sha256: digest('4'), message_presentation_sha256: digest('5'),
  };
}

class MemberStore implements ApprovalDecisionStore {
  view: ApprovalDecisionStoreView | undefined;
  contract: FrozenOrganizationMemberApprovalPresentationContract | null = null;
  readonly resolutions: Array<Parameters<ApprovalDecisionStore['resolve']>[0]> = [];
  async ensureRequested(input: ApprovalRequest): Promise<ApprovalDecisionStoreView> {
    this.view ??= { approval_id: approvalId, status: 'pending', reviewed_at: null, reviewed_by: null, reason: null, brief: input.brief, published: [] };
    return this.view;
  }
  async recordPublished(input: { processingKey: string; surface: string; reference: JsonObject }): Promise<ApprovalDecisionStoreView> {
    const view = this.view!;
    this.view = { ...view, published: [...view.published, { surface: input.surface, reference: input.reference }] };
    return this.view;
  }
  async resolve(input: Parameters<ApprovalDecisionStore['resolve']>[0]): Promise<ApprovalDecisionStoreView> {
    this.resolutions.push(input); const view = this.view!;
    this.view = { ...view, status: input.status, reviewed_at: input.reviewedAt ?? null, reviewed_by: input.reviewedBy, reason: input.reason ?? null };
    return this.view;
  }
  async freezeApprovalPresentationContract(input: { approvalId: string; contract: FrozenSlackApprovalPresentationContract }): Promise<FrozenSlackApprovalPresentationContract>;
  async freezeApprovalPresentationContract(input: { approvalId: string; contract: FrozenOrganizationMemberApprovalPresentationContract }): Promise<FrozenOrganizationMemberApprovalPresentationContract>;
  async freezeApprovalPresentationContract(input: { approvalId: string; contract: FrozenSlackApprovalPresentationContract | FrozenOrganizationMemberApprovalPresentationContract }): Promise<FrozenSlackApprovalPresentationContract | FrozenOrganizationMemberApprovalPresentationContract> {
    this.contract ??= input.contract as FrozenOrganizationMemberApprovalPresentationContract;
    return this.contract;
  }
  readFrozenApprovalPresentationContract(): FrozenOrganizationMemberApprovalPresentationContract | null { return this.contract; }
}

function fetchWithApproval(
  postBodies: Record<string, unknown>[],
  reactionName = 'white_check_mark',
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url instanceof Request ? url.url : url).split('/').pop()!.split('?')[0];
    const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    if (method === 'chat.postMessage') { const body = JSON.parse(String(init?.body)) as Record<string, unknown>; postBodies.push(body); return json({ ok: true, channel: 'C012CHANNEL', ts: '1700.100000', message: { ts: '1700.100000', text: body.text, blocks: body.blocks } }); }
    if (method === 'reactions.get') return json({ ok: true, message: { ts: '1700.100000', text: postBodies[0]?.text, blocks: postBodies[0]?.blocks, reactions: [{ name: reactionName, users: [REVIEWER], count: 1 }] } });
    if (method === 'conversations.replies') return json({ ok: true, messages: [{ ts: '1700.100000', user: 'U012BOTUSER', text: 'card' }] });
    if (method === 'auth.test') return json({ ok: true, team_id: 'T012ABCDEF', enterprise_id: null, user_id: 'U012BOTUSER', bot_id: 'B012BOTID' }, { 'x-oauth-scopes': 'chat:write,users:read' });
    if (method === 'bots.info') return json({ ok: true, bot: { id: 'B012BOTID', user_id: 'U012BOTUSER', app_id: 'A012APPID', deleted: false } });
    return json({ ok: false, error: 'unknown_method' });
  }) as typeof fetch;
}

describe('slack organization-member publication', () => {
  it('posts the exact protocol renderer result and resolves only with schema-v3 evidence', async () => {
    const store = new MemberStore(); const bodies: Record<string, unknown>[] = [];
    const memberRequests: OrganizationMemberApprovalActionAuthorizationRequest[] = [];
    const legacy: ApprovalActionAuthorizer = { authorize: async () => ({ allowed: true, evidence: { schema_version: 1 } }) };
    const surface = createSlackReactionsApprovalSurface({ kind: 'approval-surface', adapter_id: 'slack-reactions', instance_id: 'default', credential_ref: 'env:SLACK_BOT_TOKEN', settings: { channel_id: 'C012CHANNEL', reviewer: { slack_user_id: REVIEWER, name: 'Reviewer One' }, approve_reaction: 'white_check_mark', reject_reaction: 'x', presentation_mode: 'organization-member-readable-v1' } } as unknown as AdapterConfig, {
      store, approvalActionAuthorizer: legacy,
      organizationMemberApprovalActionAuthorizer: { authorizeOrganizationMemberApproval: async (input) => { memberRequests.push(input); return { allowed: true, evidence: evidence(input) }; } },
      organizationMemberAuthorizationEvidenceValidator: validateOrganizationMemberAuthorizationEvidence,
      reviewerDisplayNameValidator: assertReviewerDisplayName,
      organizationMemberPresentationRenderer: organizationMemberApprovalPresentationRenderer,
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' }, fetchImpl: fetchWithApproval(bodies), now: () => '2026-08-11T13:00:00.000Z',
    });
    const result = await surface.review(request());
    expect(result.status).toBe('approved');
    expect(store.contract?.mode).toBe('organization-member-readable-v1');
    expect(store.contract?.policy_id).toBe('organization-member-readable-v1');
    expect(String(bodies[0]?.text)).toContain('Any person using an enrolled installation');
    expect(bodies[0]?.mrkdwn).toBe(false);
    expect(memberRequests[0]?.policy_contract_sha256).toBe(store.contract?.policy_contract_sha256);
    expect(store.resolutions[0]).toMatchObject({ surface: 'slack-organization-member-readable-v1', reviewedAt: EVALUATED_AT, metadata: { authorization: evidence(memberRequests[0]!) } });
  });

  it('keeps organization-member rejection on the schema-v1 authorization path', async () => {
    const store = new MemberStore(); const bodies: Record<string, unknown>[] = [];
    const legacyRequests: Array<Parameters<ApprovalActionAuthorizer['authorize']>[0]> = [];
    let memberAuthorizationCalls = 0;
    const legacyEvidence = { schema_version: 1, action: 'reject' };
    const legacy: ApprovalActionAuthorizer = {
      authorize: async (input) => {
        legacyRequests.push(input);
        return { allowed: true, evidence: legacyEvidence };
      },
    };
    const surface = createSlackReactionsApprovalSurface({ kind: 'approval-surface', adapter_id: 'slack-reactions', instance_id: 'default', credential_ref: 'env:SLACK_BOT_TOKEN', settings: { channel_id: 'C012CHANNEL', reviewer: { slack_user_id: REVIEWER, name: 'Reviewer One' }, approve_reaction: 'white_check_mark', reject_reaction: 'x', presentation_mode: 'organization-member-readable-v1' } } as unknown as AdapterConfig, {
      store, approvalActionAuthorizer: legacy,
      organizationMemberApprovalActionAuthorizer: { authorizeOrganizationMemberApproval: async () => { memberAuthorizationCalls += 1; throw new Error('member approval path must not authorize a rejection'); } },
      organizationMemberAuthorizationEvidenceValidator: validateOrganizationMemberAuthorizationEvidence,
      reviewerDisplayNameValidator: assertReviewerDisplayName,
      organizationMemberPresentationRenderer: organizationMemberApprovalPresentationRenderer,
      environment: { SLACK_BOT_TOKEN: 'xoxb-test' }, fetchImpl: fetchWithApproval(bodies, 'x'), now: () => '2026-08-11T13:00:00.000Z',
    });

    const result = await surface.review(request());

    expect(result.status).toBe('rejected');
    expect(memberAuthorizationCalls).toBe(0);
    expect(legacyRequests).toEqual([
      expect.objectContaining({
        approval_id: approvalId,
        action: 'reject',
        reaction_name: 'x',
      }),
    ]);
    expect(store.resolutions[0]).toMatchObject({
      status: 'rejected',
      surface: 'slack',
      metadata: { authorization: legacyEvidence },
    });
  });
});
