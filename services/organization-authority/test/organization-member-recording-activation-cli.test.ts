import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';

const operatorState = vi.hoisted(() => ({
  activateOrganizationMemberRecording: vi.fn(),
}));

vi.mock('../src/composition/operator-state.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/composition/operator-state.js')
  >()),
  activateOrganizationMemberRecording:
    operatorState.activateOrganizationMemberRecording,
}));

import { runOrganizationAuthorityCli } from '../src/composition/cli.js';

describe('organization-member recording activation CLI', () => {
  it('exposes the additive command and delegates only the exact config-command pair', async () => {
    const result = {
      schema_version: 1,
      kind: 'echo-organization-member-recording-activation',
      created: true,
      config_path: '/private/authority.json',
      state_dir: '/private/state',
      authority_id: 'oau_00000000-0000-4000-8000-000000000001',
      organization_id: 'org_00000000-0000-4000-8000-000000000002',
      effective_policy: {
        schema_version: 1,
        kind: 'organization-recording-policy-v1',
        decision_processor_adapter_instance_id: 'adapter_decision',
        approval_surface_adapter_instance_id: 'adapter_slack',
        presentation_mode: 'organization-member-readable-v1',
        policy_contract_sha256: `sha256:${'a'.repeat(64)}`,
      },
      activation: {
        command_id: 'rpa_00000000-0000-4000-8000-000000000003',
      },
    };
    operatorState.activateOrganizationMemberRecording.mockResolvedValueOnce(
      result,
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await runOrganizationAuthorityCli(
        [
          'activate-organization-member-recording',
          '--config',
          '/private/authority.json',
          '--command',
          '/private/activation.json',
        ],
        {},
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
      ),
    ).toBe(0);
    expect(
      operatorState.activateOrganizationMemberRecording,
    ).toHaveBeenCalledWith(
      '/private/authority.json',
      '/private/activation.json',
    );
    expect(stdout).toEqual([`${canonicalJson(result as never)}\n`]);
    expect(stderr).toEqual([]);

    await expect(
      runOrganizationAuthorityCli(
        [
          'activate-organization-member-recording',
          '--config',
          '/private/authority.json',
        ],
        {},
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow(
      'echo-organization-authority activate-organization-member-recording --config <absolute-path> --command <absolute-json-path>',
    );
    await expect(
      runOrganizationAuthorityCli(
        [
          'activate-organization-member-recording',
          '--config',
          '/private/authority.json',
          '--command',
          '/private/activation.json',
          '--output',
          '/private/result.json',
        ],
        {},
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow(
      'echo-organization-authority activate-organization-member-recording --config <absolute-path> --command <absolute-json-path>',
    );
  });
});
