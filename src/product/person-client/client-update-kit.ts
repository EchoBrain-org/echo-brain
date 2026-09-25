import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ClientUpdateArtifact, type ClientUpdateManifest, rejectUpdate, updateDigest, UPDATE_ARTIFACT_LIMIT } from './client-update-contract.js';
import { readUpdateFile, safeUpdateDirectory } from './client-update-files.js';

const KIT_FILES = ['Start-ECHO.sh', 'node', 'release.json', 'kit-manifest.v1.json', 'person-client.tgz', 'build-identity.v1.json', 'verify-person-onboarding-kit.mjs', 'clean-v1-release.mjs'];
const PREFIX = 'echo-person-onboarding-kit/';

/** Extract flat known entries as bytes. ZIP paths and symlinks never reach the filesystem. */
export function extractClientUpdateKit(archive: string, destination: string): void {
  let entries: string[];
  try {
    entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: 10_000 }).trim().split('\n');
  } catch { return rejectUpdate('invalid_archive'); }
  if (new Set(entries).size !== entries.length ||
      entries.some(name => name !== PREFIX && !KIT_FILES.some(file => name === PREFIX + file)) ||
      KIT_FILES.some(file => !entries.includes(PREFIX + file))) rejectUpdate('invalid_archive');
  mkdirSync(destination, { mode: 0o700 });
  let total = 0;
  for (const file of KIT_FILES) {
    let bytes: Buffer;
    try {
      bytes = execFileSync('unzip', ['-p', archive, PREFIX + file], { maxBuffer: UPDATE_ARTIFACT_LIMIT, timeout: 30_000 });
    } catch { return rejectUpdate('invalid_archive'); }
    total += bytes.length;
    if (total > UPDATE_ARTIFACT_LIMIT) rejectUpdate('invalid_archive');
    writeFileSync(join(destination, file), bytes, { flag: 'wx', mode: ['Start-ECHO.sh', 'node'].includes(file) ? 0o700 : 0o600 });
  }
}

export function validateClientUpdateRelease(kit: string, manifest: ClientUpdateManifest): void {
  const raw = readUpdateFile(join(kit, 'release.json'), 16 * 1024);
  if (updateDigest(raw) !== manifest.release_sha256) rejectUpdate('release_mismatch');
  let release: Record<string, any>;
  try { release = JSON.parse(raw.toString('utf8')); } catch { return rejectUpdate('release_mismatch'); }
  if (release.release_id !== manifest.release_id || release.source_sha !== manifest.source_sha ||
      release.person_client?.version !== manifest.product_version) rejectUpdate('release_mismatch');
  // Keep the updater capability across future releases. The signed kit still
  // undergoes its existing runtime/client/manifest checks in the installer.
  let entries: string;
  try { entries = execFileSync('tar', ['-tzf', join(kit, 'person-client.tgz')], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 }); }
  catch { return rejectUpdate('invalid_archive'); }
  if (!entries.split('\n').includes('package/dist/client-update-cli.js')) rejectUpdate('updater_missing');
}

export interface UpdateInstallerInput {
  root: string;
  archive: string;
  manifest: ClientUpdateManifest;
  artifact: ClientUpdateArtifact;
  expected_wrapper_sha256: string;
}
export function installClientUpdateKit(input: UpdateInstallerInput, environment = process.env): void {
  safeUpdateDirectory(input.root);
  const temporary = mkdtempSync(join(input.root, 'updater', '.install-'));
  let preserveRecovery = false;
  try {
    const kit = join(temporary, 'kit');
    // Defense in depth for direct callers; verify before reading archive entries.
    const archiveBytes = readFileSync(input.archive);
    if (archiveBytes.length !== input.artifact.bytes || updateDigest(archiveBytes) !== input.artifact.sha256) rejectUpdate('artifact_mismatch');
    extractClientUpdateKit(input.archive, kit);
    validateClientUpdateRelease(kit, input.manifest);
    const result = spawnSync('/bin/bash', [join(kit, 'Start-ECHO.sh'), '--install-only', '--expected-wrapper-sha256', input.expected_wrapper_sha256], {
      // root has already been resolved from the installed package and validated.
      env: environment,
      stdio: 'ignore', timeout: 180_000,
    });
    if (result.error || result.signal) {
      preserveRecovery = true;
      rejectUpdate('installation_outcome_unknown');
    }
    if (result.status !== 0) rejectUpdate('installation_failed');
  } finally { if (!preserveRecovery) rmSync(temporary, { recursive: true, force: true }); }
}
