// The Phase 5 driver must start from a clean checkout without executing
// gitignored workspace or repository build output before attestation.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '@echo-brain/organization-api';
import { describe, expect, it } from 'vitest';
import { collectExecutedModuleClosure } from '../../tools/lib/module-closure.mjs';
import {
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH as PHASE5_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH as PHASE5_AUTHORITY_DESCRIPTOR_PATH,
  TRUSTED_PROXY_AUTHORIZATION_HEADER as PHASE5_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER as PHASE5_PROXY_CLIENT_ID_HEADER,
} from '../../tools/phase5/organization-api-contract.mjs';
import {
  CEREMONY_ALLOWED_EXTERNAL_DYNAMIC_IMPORTS,
  CEREMONY_ALLOWED_EXTERNAL_PACKAGES,
  CEREMONY_ENTRY_POINTS,
  CEREMONY_SOURCE_PATHS,
} from '../../tools/phase5/run-one-machine.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const REHEARSAL_SCRIPT = 'organization:phase5-rehearse';
const DRIVER_PATH = 'tools/phase5/run-one-machine.mjs';
const CONTRACT_PATH = 'tools/phase5/organization-api-contract.mjs';
const FAULT_INJECTOR_PATH = 'tools/phase5/rehearsal-fault-injection.mjs';
const FAULT_INJECTOR_SCHEMA_PATH =
  'src/product/organization/state/rehearsal-corrupt-access-state.mjs';

interface RootManifest {
  scripts: Record<string, string>;
}

function repositoryFile(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

function ceremonyClosure(): string[] {
  return collectExecutedModuleClosure({
    projectRoot: REPO,
    entryPoints: CEREMONY_ENTRY_POINTS,
    allowedExternalPackages: CEREMONY_ALLOWED_EXTERNAL_PACKAGES,
    allowedExternalDynamicImports:
      CEREMONY_ALLOWED_EXTERNAL_DYNAMIC_IMPORTS,
  });
}

describe('phase 5 rehearsal entry points', () => {
  it('executes no mutable repository build output', () => {
    const closure = ceremonyClosure();
    expect(closure).toContain(CONTRACT_PATH);
    expect(closure).toContain(FAULT_INJECTOR_PATH);
    expect(closure).toContain(FAULT_INJECTOR_SCHEMA_PATH);
    expect(
      closure.filter(
        (path) =>
          path.startsWith('dist/') ||
          /^packages\/[^/]+\/dist\//.test(path),
      ),
    ).toEqual([]);
    expect(closure.filter((path) => !CEREMONY_SOURCE_PATHS.includes(path))).toEqual(
      [],
    );
  });

  it('keeps the tracked ceremony contract equal to the organization API', () => {
    expect(PHASE5_ADMIN_OVERVIEW_PATH).toBe(
      ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
    );
    expect(PHASE5_AUTHORITY_DESCRIPTOR_PATH).toBe(
      ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
    );
    expect(PHASE5_PROXY_AUTHORIZATION_HEADER).toBe(
      TRUSTED_PROXY_AUTHORIZATION_HEADER,
    );
    expect(PHASE5_PROXY_CLIENT_ID_HEADER).toBe(
      TRUSTED_PROXY_CLIENT_ID_HEADER,
    );
  });

  it('runs the driver directly without producing mutable build inputs first', () => {
    const manifest = JSON.parse(repositoryFile('package.json')) as RootManifest;
    expect(manifest.scripts[REHEARSAL_SCRIPT]).toBe(`node ${DRIVER_PATH}`);
  });
});
