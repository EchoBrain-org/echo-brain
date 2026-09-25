import { join } from 'node:path';
import { rejectUpdate } from './client-update-contract.js';
import { installClientUpdateKit, type UpdateInstallerInput } from './client-update-kit.js';

/** The standalone CLI never replaces the legacy app's paired command. */
export function installMacosClientUpdate(input: UpdateInstallerInput, environment = process.env): void {
  if (input.artifact.platform !== 'darwin' || input.artifact.architecture !== 'arm64' || input.artifact.libc !== null || input.artifact.installation !== 'cli-kit') rejectUpdate('adapter_unavailable');
  if (!environment.HOME || input.root !== join(environment.HOME, 'Library/Application Support/ECHO/cli')) rejectUpdate('unsafe_installation');
  installClientUpdateKit(input, environment);
}
