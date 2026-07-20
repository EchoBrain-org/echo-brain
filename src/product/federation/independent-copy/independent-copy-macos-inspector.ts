import { lstatSync } from 'node:fs';
import {
  assertDisjointPaths,
  canonicalLocalPath,
  pathIsWithin,
} from '../../secure-local-files.js';
import { spawnSanitizedChild } from '../../spawn-sanitized-child.js';
import {
  bytewiseCompare,
  failIndependentCopy as fail,
  type IndependentCopyPlatformInspector,
  type IndependentCopyTargetInspection,
  isRecord,
  type MacOsEncryptedVolumeInspectorOptions,
  NON_BLANK_IDENTITY,
} from './independent-copy-documents.js';

const MAX_PLATFORM_OUTPUT_BYTES = 1024 * 1024;

export function assertIndependentCopyInspection(
  inspection: IndependentCopyTargetInspection,
  stateDirectory: string,
  targetRoot: string,
): void {
  if (
    inspection.canonical_root !== targetRoot ||
    inspection.mounted !== true ||
    inspection.encrypted !== true ||
    inspection.target_media !== 'external-physical' ||
    inspection.assurance !== 'platform_verified'
  ) {
    fail(
      'platform inspection did not verify the requested mounted encrypted target',
    );
  }
  if (
    !NON_BLANK_IDENTITY.test(inspection.volume_id) ||
    !NON_BLANK_IDENTITY.test(inspection.state_filesystem_device_id) ||
    !NON_BLANK_IDENTITY.test(inspection.target_filesystem_device_id) ||
    inspection.state_physical_device_ids.length === 0 ||
    inspection.target_physical_device_ids.length === 0 ||
    inspection.state_physical_device_ids.some(
      (identity) => !NON_BLANK_IDENTITY.test(identity),
    ) ||
    inspection.target_physical_device_ids.some(
      (identity) => !NON_BLANK_IDENTITY.test(identity),
    )
  ) {
    fail('platform inspection returned an invalid filesystem identity');
  }
  if (
    inspection.state_filesystem_device_id ===
    inspection.target_filesystem_device_id
  ) {
    fail('independent-copy target must use a different filesystem/device');
  }
  const statePhysicalDevices = new Set(inspection.state_physical_device_ids);
  if (
    inspection.target_physical_device_ids.some((identity) =>
      statePhysicalDevices.has(identity),
    )
  ) {
    fail(
      'independent-copy target must use a different physical storage device',
    );
  }
  const mountPoint = canonicalLocalPath(
    inspection.canonical_mount_point,
    'independent-copy mount point',
    true,
  );
  if (
    mountPoint !== inspection.canonical_mount_point ||
    !pathIsWithin(targetRoot, mountPoint, true)
  ) {
    fail(
      'independent-copy target is not contained by its inspected mount point',
    );
  }
  assertDisjointPaths(
    stateDirectory,
    targetRoot,
    'state directory',
    'independent-copy target',
  );
}

async function collectSpawnedChild(
  child: ReturnType<typeof spawnSanitizedChild>,
  label: string,
  input?: Buffer,
): Promise<Buffer> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolve(value ?? Buffer.alloc(0));
      else reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${label} timed out`));
    }, 10_000);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PLATFORM_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error(`${label} produced excessive output`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_PLATFORM_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `${label} failed (${signal ?? String(code)}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function readDiskUtilityPlist(targetRoot: string): Promise<Buffer> {
  return collectSpawnedChild(
    spawnSanitizedChild('/usr/sbin/diskutil', ['info', '-plist', targetRoot]),
    '/usr/sbin/diskutil',
  );
}

function convertPropertyListToJson(plist: Buffer): Promise<Buffer> {
  return collectSpawnedChild(
    spawnSanitizedChild('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      '-',
    ]),
    '/usr/bin/plutil',
    plist,
  );
}

async function readDiskUtilityInfo(
  path: string,
): Promise<Record<string, unknown>> {
  const plist = await readDiskUtilityPlist(path);
  const json = await convertPropertyListToJson(plist);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    fail('macOS volume inspection returned invalid JSON');
  }
  if (!isRecord(parsed)) fail('macOS volume inspection returned no object');
  return parsed;
}

function wholeDiskIdentity(value: string): string {
  const normalized = value.startsWith('/dev/') ? value.slice(5) : value;
  const match = /^(disk[0-9]+)(?:s[0-9]+)*$/u.exec(normalized);
  if (match === null) {
    fail('macOS volume inspection returned an invalid disk identity');
  }
  return match[1]!;
}

function physicalDeviceIdentities(
  info: Record<string, unknown>,
): readonly string[] {
  const physicalStores = info['APFSPhysicalStores'];
  const identities: string[] = [];
  if (Array.isArray(physicalStores)) {
    for (const store of physicalStores) {
      if (!isRecord(store) || typeof store['APFSPhysicalStore'] !== 'string') {
        fail('macOS volume inspection returned an invalid APFS physical store');
      }
      identities.push(wholeDiskIdentity(store['APFSPhysicalStore']));
    }
  }
  if (identities.length === 0) {
    const fallback =
      typeof info['ParentWholeDisk'] === 'string'
        ? info['ParentWholeDisk']
        : info['DeviceIdentifier'];
    if (typeof fallback !== 'string') {
      fail('macOS volume inspection returned no physical disk identity');
    }
    identities.push(wholeDiskIdentity(fallback));
  }
  return [...new Set(identities)].sort(bytewiseCompare);
}

function assertExternalPhysicalBackingStore(
  expectedWholeDisk: string,
  info: Record<string, unknown>,
): void {
  const deviceIdentifier = info['DeviceIdentifier'];
  const busProtocol = info['BusProtocol'];
  const virtualOrPhysical = info['VirtualOrPhysical'];
  if (
    typeof deviceIdentifier !== 'string' ||
    wholeDiskIdentity(deviceIdentifier) !== expectedWholeDisk ||
    deviceIdentifier.replace(/^\/dev\//, '') !== expectedWholeDisk ||
    info['Internal'] !== false ||
    info['DiskImage'] === true ||
    typeof busProtocol !== 'string' ||
    /disk[ -]?image|virtual|loop/i.test(busProtocol) ||
    virtualOrPhysical !== 'Physical' ||
    (Array.isArray(info['APFSPhysicalStores']) &&
      info['APFSPhysicalStores'].length > 0) ||
    typeof info['IOKitSize'] !== 'number' ||
    !Number.isSafeInteger(info['IOKitSize']) ||
    info['IOKitSize'] <= 0
  ) {
    fail(
      `target backing store ${expectedWholeDisk} is not proven external physical media`,
    );
  }
}

/** macOS-only verifier. Unknown plist shapes fail closed. */
export class MacOsEncryptedVolumeInspector implements IndependentCopyPlatformInspector {
  private readonly platform: string;
  private readonly filesystemDeviceId: (path: string) => string;
  private readonly diskUtilityInfo: (
    path: string,
  ) => Promise<Record<string, unknown>>;

  constructor(options: MacOsEncryptedVolumeInspectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.filesystemDeviceId =
      options.filesystemDeviceId ?? ((path) => String(lstatSync(path).dev));
    this.diskUtilityInfo = options.readDiskUtilityInfo ?? readDiskUtilityInfo;
  }

  async inspect(input: {
    state_directory: string;
    target_root: string;
  }): Promise<IndependentCopyTargetInspection> {
    if (this.platform !== 'darwin') {
      fail('protected independent copies require the macOS volume inspector');
    }
    const stateDirectory = canonicalLocalPath(
      input.state_directory,
      'state directory',
      true,
    );
    const targetRoot = canonicalLocalPath(
      input.target_root,
      'independent-copy target',
      true,
    );
    const stateDevice = this.filesystemDeviceId(stateDirectory);
    const targetDevice = this.filesystemDeviceId(targetRoot);
    if (stateDevice === targetDevice) {
      fail('independent-copy target is on the state filesystem/device');
    }
    const [stateInfo, parsed] = await Promise.all([
      this.diskUtilityInfo(stateDirectory),
      this.diskUtilityInfo(targetRoot),
    ]);
    const mountPoint = parsed['MountPoint'];
    const volumeId = parsed['VolumeUUID'];
    const mounted = parsed['Mounted'] !== false;
    const encrypted =
      parsed['Encryption'] === true ||
      parsed['Encrypted'] === true ||
      parsed['FileVault'] === true;
    if (
      typeof mountPoint !== 'string' ||
      typeof volumeId !== 'string' ||
      mounted !== true ||
      !encrypted ||
      parsed['Internal'] !== false
    ) {
      fail(
        'target is not a mounted encrypted external volume with a stable VolumeUUID',
      );
    }
    const canonicalMountPoint = canonicalLocalPath(
      mountPoint,
      'independent-copy mount point',
      true,
    );
    const statePhysicalDeviceIds = physicalDeviceIdentities(stateInfo);
    const targetPhysicalDeviceIds = physicalDeviceIdentities(parsed);
    const targetBackingStores = await Promise.all(
      targetPhysicalDeviceIds.map((deviceId) =>
        this.diskUtilityInfo(deviceId),
      ),
    );
    targetBackingStores.forEach((info, index) =>
      assertExternalPhysicalBackingStore(targetPhysicalDeviceIds[index]!, info),
    );
    const inspection: IndependentCopyTargetInspection = {
      canonical_root: targetRoot,
      canonical_mount_point: canonicalMountPoint,
      volume_id: volumeId.toLowerCase(),
      state_filesystem_device_id: stateDevice,
      target_filesystem_device_id: targetDevice,
      state_physical_device_ids: statePhysicalDeviceIds,
      target_physical_device_ids: targetPhysicalDeviceIds,
      target_media: 'external-physical',
      mounted: true,
      encrypted: true,
      assurance: 'platform_verified',
    };
    assertIndependentCopyInspection(inspection, stateDirectory, targetRoot);
    return inspection;
  }
}
