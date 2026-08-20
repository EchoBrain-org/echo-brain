import { describe, expect, it } from 'vitest';
import type { ApprovalDecision } from '../src/processing/core/approval/approval-gate.js';
import type { ResolvedActWriter } from '../src/processing/core/ports/adapters.js';
import {
  ResolvedOrganizationRecordActWriter,
  type FrozenOrganizationRecordEnvelopeStore,
  type ResolvedOrganizationRecordMetadata,
} from '../src/processing/record/adapters/resolved-organization-record-act-writer.js';
import type {
  BuiltOrganizationRecordEnvelope,
  OrganizationRecordEnvelopeBuildInput,
} from '../src/processing/record/ports.js';

const APPROVAL_ID = 'a'.repeat(64);
const reviewedAt = '2026-08-20T12:00:00.000Z';
const meeting = { id: 'meeting-1' } as Parameters<ResolvedActWriter['write']>[0]['meeting'];
const decisions = {} as Parameters<ResolvedActWriter['write']>[0]['decisions'];

function decision(status: 'approved' | 'rejected'): Exclude<ApprovalDecision, { status: 'pending' }> {
  return status === 'approved'
    ? { status, reviewed_at: reviewedAt, reviewed_by: 'Founder', reason: null, approved_brief: {} as never }
    : { status, reviewed_at: reviewedAt, reviewed_by: 'Founder', reason: 'not approved', approved_brief: null };
}

function metadata(schema: 1 | 2 | 3): ResolvedOrganizationRecordMetadata {
  return {
    approval_id: APPROVAL_ID,
    meeting_id: 'meeting-1',
    source: { adapter_id: 'granola', instance_id: 'primary', external_id: 'meeting-1' },
    reviewed_by: 'Founder',
    submitted_at: reviewedAt,
    surface: schema === 3 ? 'organization-member-readable' : schema === 2 ? 'slack-reviewer-v1' : 'slack-authority-v1',
    authorization: {
      schema_version: schema,
      kind: 'echo-organization-authorization-evidence',
      approval_id: APPROVAL_ID,
    } as never,
  };
}

function harness(current: ResolvedOrganizationRecordMetadata | null, failFirstAppend = false) {
  const frozen = new Map<string, BuiltOrganizationRecordEnvelope>();
  const inputs: OrganizationRecordEnvelopeBuildInput[] = [];
  const submitted: unknown[] = [];
  let appendAttempts = 0;
  const store: FrozenOrganizationRecordEnvelopeStore = {
    async getOrCreate(key, create) {
      const existing = frozen.get(key);
      if (existing !== undefined) return existing;
      const built = await create();
      frozen.set(key, built);
      return built;
    },
  };
  const writer = new ResolvedOrganizationRecordActWriter({
    metadata: { async findForResolvedAct() { return current; } },
    recordEnvelopes: store,
    recordEnvelopeBuilder: {
      async build(input) {
        inputs.push(input);
        return {
          envelope_id: `rec-${inputs.length}`,
          idempotency_key: input.approval_id,
          event_type: input.event_type,
          envelope: {
            schema_version: input.authorization.schema_version,
            kind: 'echo-organization-record-envelope',
            envelope_id: `rec-${inputs.length}`,
            idempotency_key: input.approval_id,
            event_type: input.event_type,
          },
        } as BuiltOrganizationRecordEnvelope;
      },
    },
    installationAccess: { async ensureCurrentInstallationAccess() {} },
    records: {
      async submitRecordEnvelope(request) {
        submitted.push(request.record_envelope);
        appendAttempts += 1;
        if (failFirstAppend && appendAttempts === 1) throw new Error('append crashed');
        return {} as never;
      },
    },
  });
  return { writer, inputs, submitted };
}

describe('resolved organization record act writer', () => {
  it.each([
    [3, 'approved', 'approval'],
    [2, 'approved', 'approval'],
    [1, 'rejected', 'rejection'],
  ] as const)('uses existing schema-v%s protocol builder inputs for %s', async (schema, status, eventType) => {
    const test = harness(metadata(schema));
    await test.writer.write({ processing_key: 'processing-key', meeting, decisions, decision: decision(status) });
    expect(test.inputs).toHaveLength(1);
    expect(test.inputs[0]).toMatchObject({ event_type: eventType, authorization: { schema_version: schema } });
    expect(test.submitted).toHaveLength(1);
  });

  it('retries an append crash with the exact frozen envelope', async () => {
    const test = harness(metadata(3), true);
    const input = { processing_key: 'processing-key', meeting, decisions, decision: decision('approved') } as const;
    await expect(test.writer.write(input)).rejects.toThrow('append crashed');
    await expect(test.writer.write(input)).resolves.toBeUndefined();
    expect(test.inputs).toHaveLength(1);
    expect(test.submitted).toHaveLength(2);
    expect(test.submitted[1]).toBe(test.submitted[0]);
  });

  it('denies missing independently-resolved metadata before append', async () => {
    const test = harness(null);
    await expect(test.writer.write({ processing_key: 'processing-key', meeting, decisions, decision: decision('approved') })).rejects.toThrow('metadata is unavailable');
    expect(test.inputs).toHaveLength(0);
    expect(test.submitted).toHaveLength(0);
  });

  it('denies a caller meeting that differs from the stored terminal act', async () => {
    const test = harness(metadata(3));
    await expect(test.writer.write({
      processing_key: 'processing-key',
      meeting: { id: 'different-meeting' } as typeof meeting,
      decisions,
      decision: decision('approved'),
    })).rejects.toThrow('does not bind this meeting');
    expect(test.inputs).toHaveLength(0);
  });
});
