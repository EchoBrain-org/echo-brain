import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStagingSyntheticPersonalProviderV1 } from '../../../src/composition/staging/staging-synthetic-personal-provider-v1.js';

describe('staging custom meeting state selection', () => {
  it('refuses production before opening state and binds private durable storage to the Authority lineage', async () => {
    const state_directory = mkdtempSync(join(tmpdir(), 'echo-staging-provider-'));
    const coordinates = { authority_id: 'oau_test', organization_id: 'org_test', state_lineage_id: 'lineage_test' };
    const options = { state_directory, coordinates, authority_url: 'https://authority-staging.echobrain.org' };
    try {
      expect(() => openStagingSyntheticPersonalProviderV1({ ...options, authority_url: 'https://authority.echobrain.org' })).toThrow('staging Authority');
      const path = join(state_directory, 'staging-synthetic-meetings.sqlite');
      expect(existsSync(path)).toBe(false);
      const runtime = openStagingSyntheticPersonalProviderV1(options);
      const person = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test' };
      const meeting = { id: 'synthetic-custom-restart', title: 'Restart', notes: 'Decision: retain the proposal.', transcript: '' };
      (await runtime.provider.open(person, () => undefined)).submit!(meeting);
      runtime.close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => openStagingSyntheticPersonalProviderV1({ ...options, coordinates: { ...coordinates, state_lineage_id: 'other' } })).toThrow('lineage');
      const restarted = openStagingSyntheticPersonalProviderV1(options);
      try { await expect((await restarted.provider.open(person, () => undefined)).preview(meeting.id)).resolves.toMatchObject({ notes: meeting.notes }); }
      finally { restarted.close(); }
    } finally { rmSync(state_directory, { recursive: true, force: true }); }
  });
});
