import { describe, expect, it } from 'vitest';
import type {
  AcceptedOrganizationRecordV1,
  SubmitOrganizationRecordEnvelopeRequestV1,
} from '@echo-brain/organization-api';
import {
  ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationRecordEnvelopeAnyVersion,
  OrganizationRecordOrganizationMemberAuthorizationV3,
} from '@echo-brain/organization-protocol';
import type {
  AdapterConfig,
  AdapterHealth,
} from '../src/processing/core/contracts/adapter.js';
import type {
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../src/processing/core/contracts/delivery.js';
import type { DeliverySurfaceAdapter } from '../src/processing/core/ports/adapters.js';
import {
  OrganizationMemberRecordFirstDeliverySurface,
} from '../src/processing/record/adapters/organization-member-record-first-delivery.js';
import type {
  FrozenOrganizationRecordEnvelopeStore,
  OrganizationMemberRecordApprovalMetadata,
  OrganizationRecordAppendApplication,
} from '../src/processing/record/adapters/organization-member-record-first-delivery.js';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordEnvelopeBuildInput,
  OrganizationRecordEnvelopeBuilder,
} from '../src/processing/record/ports.js';

const APPROVAL_ID = 'a'.repeat(64);
const APPROVED_AT = '2026-08-19T12:00:00.000Z';
const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  enrollment: 'enr_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  request: 'pcr_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  binding: 'bnd_00000000-0000-4000-8000-000000000001',
  grant: 'pgr_00000000-0000-4000-8000-000000000001',
  audit: 'aud_00000000-0000-4000-8000-000000000001',
} as const;

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function authorization(): OrganizationRecordOrganizationMemberAuthorizationV3 {
  return {
    schema_version: 3,
    kind: 'echo-organization-authorization-evidence',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: digest('1'),
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    request_id: IDS.request,
    approval_id: APPROVAL_ID,
    action: 'approve',
    request_sha256: digest('2'),
    provider_event_sha256: digest('3'),
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: APPROVED_AT,
    authorization_audit_event_id: IDS.audit,
    authorization_audit_entry_sha256: digest('4'),
    release_draft_sha256: digest('5'),
    approval_presentation_sha256: digest('6'),
    semantic_intent_sha256: digest('7'),
    message_presentation_sha256: digest('8'),
  };
}

function metadata(): OrganizationMemberRecordApprovalMetadata {
  return {
    approval_id: APPROVAL_ID,
    source: {
      adapter_id: 'granola',
      instance_id: 'primary',
      external_id: 'meeting-1',
    },
    reviewed_by: 'Founder',
    submitted_at: APPROVED_AT,
    authorization: authorization(),
  };
}

function delivery(id = 'delivery-1'): DeliveryEnvelope {
  return {
    schema_version: 1,
    id,
    idempotency_key:
      'delivery:v1:["processing-key","brief-digest","slack","final","C012CHANNEL"]',
    destination: {
      adapter_id: 'slack',
      instance_id: 'final',
      external_id: 'C012CHANNEL',
    },
    brief: {
      schema_version: 1,
      id: 'brief-1',
      meeting: { id: 'meeting-1', title: 'Launch review', participants: [] },
      decisions: [],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: 'rev-1',
        processor: {
          kind: 'decision-processor',
          adapter_id: 'structured-text',
          instance_id: 'default',
          version: '1.0.0',
        },
        generated_at: '2026-08-19T11:00:00.000Z',
      },
    },
    approved_at: APPROVED_AT,
  };
}

class FrozenEnvelopeStore implements FrozenOrganizationRecordEnvelopeStore {
  private readonly values = new Map<string, BuiltOrganizationRecordEnvelope>();

  constructor(private readonly calls: string[]) {}

  async getOrCreate(
    idempotencyKey: string,
    create: () => Promise<BuiltOrganizationRecordEnvelope>,
  ): Promise<BuiltOrganizationRecordEnvelope> {
    const existing = this.values.get(idempotencyKey);
    if (existing !== undefined) {
      this.calls.push('freeze:hit');
      return existing;
    }
    this.calls.push('freeze:create');
    const created = await create();
    this.values.set(idempotencyKey, created);
    return created;
  }
}

interface HarnessOptions {
  readonly recordFailure?: Error;
  readonly slackFailures?: number;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const buildInputs: OrganizationRecordEnvelopeBuildInput[] = [];
  const recordRequests: SubmitOrganizationRecordEnvelopeRequestV1[] = [];
  let slackCalls = 0;
  const recordDocument = {
    schema_version: 3,
    kind: 'echo-organization-record-envelope',
    event_type: 'approval',
  } as unknown as OrganizationRecordEnvelopeAnyVersion;
  const built: BuiltOrganizationRecordEnvelope = {
    envelope_id: 'rec_00000000-0000-4000-8000-000000000001',
    idempotency_key: APPROVAL_ID,
    event_type: 'approval',
    envelope: recordDocument,
  };
  const builder: OrganizationRecordEnvelopeBuilder = {
    async build(input) {
      calls.push('build');
      buildInputs.push(input);
      return built;
    },
  };
  const records: OrganizationRecordAppendApplication = {
    async submitRecordEnvelope(request): Promise<AcceptedOrganizationRecordV1> {
      calls.push('record');
      recordRequests.push(request);
      if (options.recordFailure !== undefined) throw options.recordFailure;
      return {} as AcceptedOrganizationRecordV1;
    },
  };
  const config: AdapterConfig = {
    adapter_id: 'slack',
    instance_id: 'final',
    settings: {},
  };
  const finalDelivery: DeliverySurfaceAdapter = {
    identity: {
      kind: 'delivery-surface',
      adapter_id: 'slack',
      instance_id: 'final',
      version: '1.0.0',
    },
    destination: {
      adapter_id: 'slack',
      instance_id: 'final',
      external_id: 'C012CHANNEL',
    },
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async (): Promise<AdapterHealth> => ({
      status: 'healthy',
      checked_at: APPROVED_AT,
    }),
    async publish(envelope): Promise<DeliveryReceipt> {
      slackCalls += 1;
      calls.push(`slack:${envelope.id}`);
      if (slackCalls <= (options.slackFailures ?? 0)) {
        throw new Error('Slack unavailable');
      }
      return {
        schema_version: 1,
        envelope_id: envelope.id,
        status: 'delivered',
        external_id: 'slack:message:C012CHANNEL:1.000001',
        recorded_at: APPROVED_AT,
        retryable: false,
      };
    },
  };
  const surface = new OrganizationMemberRecordFirstDeliverySurface({
    approvalMetadata: {
      async findForDelivery() {
        calls.push('lookup');
        return metadata();
      },
    },
    recordEnvelopes: new FrozenEnvelopeStore(calls),
    recordEnvelopeBuilder: builder,
    records,
    finalDelivery,
  });
  return {
    built,
    buildInputs,
    calls,
    config,
    finalDelivery,
    recordRequests,
    surface,
  };
}

describe('organization-member record-first delivery', () => {
  it('builds and appends the readable record before final Slack delivery', async () => {
    const test = harness();
    const envelope = delivery();
    const receipt = await test.surface.publish(envelope);

    expect(test.calls).toEqual([
      'lookup',
      'freeze:create',
      'build',
      'record',
      'slack:delivery-1',
    ]);
    expect(test.buildInputs[0]).toMatchObject({
      event_type: 'approval',
      approval_id: APPROVAL_ID,
      source: metadata().source,
      meeting_id: 'meeting-1',
      brief: envelope.brief,
      alternatives: [],
      links: { parent: null, supersedes: null },
      reviewed_at: APPROVED_AT,
      reviewed_by: 'Founder',
      reason: null,
      surface: ORGANIZATION_MEMBER_READABLE_RECORD_SURFACE,
      authorization: metadata().authorization,
      submitted_at: APPROVED_AT,
    });
    expect(test.recordRequests[0]?.record_envelope).toBe(test.built.envelope);
    expect(receipt).toMatchObject({
      envelope_id: 'delivery-1',
      status: 'delivered',
    });
  });

  it('reuses the frozen record and repeats record-first ordering on a Slack retry', async () => {
    const test = harness({ slackFailures: 1 });
    await expect(test.surface.publish(delivery('delivery-1'))).rejects.toThrow(
      'Slack unavailable',
    );
    const receipt = await test.surface.publish(delivery('delivery-2'));

    expect(test.calls).toEqual([
      'lookup',
      'freeze:create',
      'build',
      'record',
      'slack:delivery-1',
      'lookup',
      'freeze:hit',
      'record',
      'slack:delivery-2',
    ]);
    expect(test.buildInputs).toHaveLength(1);
    expect(test.recordRequests).toHaveLength(2);
    expect(test.recordRequests[1]?.record_envelope).toBe(
      test.recordRequests[0]?.record_envelope,
    );
    expect(receipt.envelope_id).toBe('delivery-2');
  });

  it('never invokes Slack when record append fails', async () => {
    const test = harness({ recordFailure: new Error('record unavailable') });

    await expect(test.surface.publish(delivery())).rejects.toThrow(
      'record unavailable',
    );
    expect(test.calls).toEqual([
      'lookup',
      'freeze:create',
      'build',
      'record',
    ]);
  });
});
