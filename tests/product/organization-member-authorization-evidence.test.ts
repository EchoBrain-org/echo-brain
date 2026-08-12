import { describe, expect, it } from 'vitest';
import {
  validateOrganizationMemberAuthorizationEvidence,
} from '../../src/product/approval/organization-member-authorization-evidence.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function evidence(): Record<string, unknown> {
  return {
    schema_version: 3,
    kind: 'echo-organization-authorization-evidence',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: digest('0'),
    authority_id: 'oau_00000000-0000-4000-8000-000000000001',
    organization_id: 'org_00000000-0000-4000-8000-000000000001',
    enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
    installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    approval_id: 'a'.repeat(64),
    action: 'approve',
    request_sha256: digest('1'),
    provider_event_sha256: digest('2'),
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
    permission_grant_id: 'pgr_00000000-0000-4000-8000-000000000001',
    evaluated_at: '2026-08-11T12:00:00.000Z',
    authorization_audit_event_id:
      'aud_00000000-0000-4000-8000-000000000001',
    authorization_audit_entry_sha256: digest('3'),
    release_draft_sha256: digest('4'),
    approval_presentation_sha256: digest('5'),
    semantic_intent_sha256: digest('6'),
    message_presentation_sha256: digest('7'),
  };
}

describe('organization-member authorization evidence', () => {
  it('returns a detached frozen snapshot of the exact closed allow proof', () => {
    const input = evidence();
    const validated = validateOrganizationMemberAuthorizationEvidence(input);
    input['policy_contract_sha256'] = digest('f');
    expect(validated.policy_contract_sha256).toBe(digest('0'));
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it.each([
    ['missing field', (value: Record<string, unknown>) => delete value['policy_id']],
    ['extra field', (value: Record<string, unknown>) => { value['extra'] = true; }],
    ['wrong policy', (value: Record<string, unknown>) => { value['policy_id'] = 'restricted-reviewer-v1'; }],
    ['wrong literal', (value: Record<string, unknown>) => { value['allowed'] = false; }],
    ['bad identifier', (value: Record<string, unknown>) => { value['membership_id'] = 'mem_bad'; }],
    ['bad digest', (value: Record<string, unknown>) => { value['policy_contract_sha256'] = digest('A'); }],
    ['bad time', (value: Record<string, unknown>) => { value['evaluated_at'] = '2026-08-11T12:00:00Z'; }],
    [
      'non-enumerable field',
      (value: Record<string, unknown>) => {
        Object.defineProperty(value, 'extra', { value: true });
      },
    ],
    [
      'accessor field',
      (value: Record<string, unknown>) => {
        Object.defineProperty(value, 'policy_id', { get: () => 'organization-member-readable-v1' });
      },
    ],
    [
      'symbol field',
      (value: Record<string, unknown>) => {
        Object.defineProperty(value, Symbol('extra'), { value: true, enumerable: true });
      },
    ],
  ])('rejects a %s', (_label, mutate) => {
    const value = evidence();
    mutate(value);
    expect(() => validateOrganizationMemberAuthorizationEvidence(value)).toThrow();
  });
});
