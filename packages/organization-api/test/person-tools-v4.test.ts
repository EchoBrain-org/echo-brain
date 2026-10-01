import { describe, expect, it } from 'vitest';
import { organizationPersonToolV3FromV4, validateOrganizationPersonToolsV4 } from '../src/person-tools-v4.js';

const tool = (tool_id = 'calendar', organization_setup: unknown = null) => ({ tool_id, display_name: 'Team calendar', availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant:team@example', external_subject_id: 'subject:42@example', organization_setup });
const envelope = (tools: unknown[]) => ({ schema_version: 4, kind: 'echo-organization-person-tools', organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', tools });

describe('neutral Person tools v4', () => {
  it('admits two independent tools with opaque identities and an empty installation', () => {
    expect(validateOrganizationPersonToolsV4(envelope([tool(), tool('mail')])).tools).toHaveLength(2);
    expect(validateOrganizationPersonToolsV4(envelope([])).tools).toEqual([]);
  });
  it('admits every organization setup status and a null status', () => {
    for (const organization_setup of ['not_set_up', 'app_created', 'connected', 'needs_reinstall', null]) {
      expect(validateOrganizationPersonToolsV4(envelope([tool('calendar', organization_setup)])).tools).toHaveLength(1);
    }
  });
  it('rejects duplicate identities, unbounded lists, stale state, provider wire extensions, an invalid organization setup status and a v3 document', () => {
    for (const tools of [
      [tool(), tool()], Array.from({ length: 33 }, (_, index) => tool(`tool-${index}`)),
      [{ ...tool(), availability: 'unavailable' }], [{ ...tool(), personal_status: 'unlinked' }],
      [{ ...tool(), slack_team_id: 'T123' }], [{ ...tool(), external_subject_id: '\n' }],
      [tool('calendar', 'done')],
      [{ tool_id: 'calendar', display_name: 'Team calendar', availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant:team@example', external_subject_id: 'subject:42@example' }],
    ]) expect(() => validateOrganizationPersonToolsV4(envelope(tools))).toThrow();
    expect(() => validateOrganizationPersonToolsV4({ schema_version: 3, kind: 'echo-organization-person-tools', organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', tools: [] })).toThrow();
  });
});

describe('organizationPersonToolV3FromV4', () => {
  it('strips the organization setup status and keeps every v3 field', () => {
    const v4 = validateOrganizationPersonToolsV4(envelope([tool('calendar', 'connected')])).tools[0];
    expect(organizationPersonToolV3FromV4(v4)).toEqual({ tool_id: 'calendar', display_name: 'Team calendar', availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant:team@example', external_subject_id: 'subject:42@example' });
    expect(organizationPersonToolV3FromV4(v4)).not.toHaveProperty('organization_setup');
  });
});
