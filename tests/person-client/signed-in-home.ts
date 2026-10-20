import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';

/**
 * A new home signed in to `authority` as one synthetic employee, whose access is fresh at `now` for ten minutes and who
 * may refresh for a week. The caller removes it.
 */
export function signedInHome(options: { readonly prefix: string; readonly now: string; readonly authority?: string; readonly display_name?: string }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), options.prefix)));
  const after = (minutes: number) => new Date(Date.parse(options.now) + minutes * 60_000).toISOString();
  new PersonSessionStore(home).install(options.authority ?? 'https://authority.example.test', 'oau_00000000-0000-4000-8000-000000000001', {
    organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    display_name: options.display_name ?? 'Maya Chen', membership_type: 'employee', identity_binding_id: 'oib_00000000-0000-4000-8000-000000000001',
    session_family_id: 'psf_00000000-0000-4000-8000-000000000001', access_token: 'A'.repeat(43), refresh_token: 'R'.repeat(43),
    access_expires_at: after(10), refresh_expires_at: after(7 * 24 * 60), hard_reauthentication_at: after(7 * 24 * 60),
  });
  return home;
}
