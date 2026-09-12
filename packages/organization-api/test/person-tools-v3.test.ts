import { describe, expect, it } from 'vitest';
import { validateOrganizationPersonToolsV3 } from '../src/person-tools-v3.js';

const tool = (tool_id = 'calendar') => ({ tool_id, display_name: 'Team calendar', availability: 'enabled', personal_status: 'linked', external_scope_id: 'tenant:team@example', external_subject_id: 'subject:42@example' });
const envelope = (tools: unknown[]) => ({ schema_version: 3, kind: 'echo-organization-person-tools', organization_id: 'org_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', tools });

describe('neutral Person tools v3', () => {
  it('admits two independent tools with opaque identities and an empty installation', () => {
    expect(validateOrganizationPersonToolsV3(envelope([tool(), tool('mail')])).tools).toHaveLength(2);
    expect(validateOrganizationPersonToolsV3(envelope([])).tools).toEqual([]);
  });
  it('rejects duplicate identities, unbounded lists, stale state and provider wire extensions', () => {
    for (const tools of [
      [tool(), tool()], Array.from({ length: 33 }, (_, index) => tool(`tool-${index}`)),
      [{ ...tool(), availability: 'unavailable' }], [{ ...tool(), personal_status: 'unlinked' }],
      [{ ...tool(), slack_team_id: 'T123' }], [{ ...tool(), external_subject_id: '\n' }],
    ]) expect(() => validateOrganizationPersonToolsV3(envelope(tools))).toThrow();
  });
});
