import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPrivateAuthorityCredentialFile } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';

/** The wrapper selects one member; executable and native home are never file-controlled. */
export function readPersonalClaudeSelectionV1(path: string | undefined, authorityUrl: string) {
  if (path === undefined) return undefined;
  try {
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (authorityUrl !== STAGING_AUTHORITY_ORIGIN_V1) throw new Error('not staging');
    const value = JSON.parse(readPrivateAuthorityCredentialFile(`file:${path}`, 1));
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'kind,membership_id' || value.kind !== 'echo-personal-claude-research-v1' ||
        typeof value.membership_id !== 'string' || !/^mem_[a-zA-Z0-9-]{1,100}$/u.test(value.membership_id)) throw new Error('invalid selection');
    const selection = { membership_id: value.membership_id as string,
      home_directory: join(dirname(path), 'claude-account'), executable_path: '/usr/local/bin/echo-claude-native' };
    return selection;
  } catch { throw new Error('Hosted personal Claude selection is invalid'); }
}
