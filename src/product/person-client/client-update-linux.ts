import { join } from 'node:path';
import { rejectUpdate } from './client-update-contract.js';
import { installClientUpdateKit, type UpdateInstallerInput } from './client-update-kit.js';

export { extractClientUpdateKit as extractLinuxUpdateKit, validateClientUpdateRelease as validateLinuxUpdateRelease } from './client-update-kit.js';
export type { UpdateInstallerInput } from './client-update-kit.js';

export function installLinuxClientUpdate(input: UpdateInstallerInput, environment = process.env): void {
  if (input.artifact.platform !== 'linux' || input.artifact.architecture !== 'x64' || input.artifact.libc !== 'glibc' || input.artifact.installation !== 'cli-kit') rejectUpdate('adapter_unavailable');
  installClientUpdateKit(input, { ...environment, XDG_DATA_HOME: join(input.root, '../..') });
}
