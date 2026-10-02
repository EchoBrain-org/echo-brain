import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'vitest';
import { prepare, preflight } from '../../tools/connector-rehearsal.mjs';

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'echo-connector-rehearsal-'));
  directories.push(value);
  return value;
}

function prepared(): string {
  const parent = directory();
  const root = join(parent, 'rehearsal');
  prepare(root);
  return root;
}

function write(path: string, contents: string, permissions = 0o600): void {
  writeFileSync(path, contents, { mode: permissions });
  chmodSync(path, permissions);
}

interface RehearsalConfig {
  authority_url: string;
  organization_name: string;
  owner_name: string;
  owner_email: string;
  oidc: { config_file: string; client_secret_file: string | null };
  nango: { secret_key_file: string; slack_integration_key: string; jira_integration_key: string };
  jira: { cloud_id: string; project: string };
  granola: { credential_file: string; owner_email_file: string };
  openrouter: { credential_file: string };
}

function ready(root: string, authorityUrl = 'https://connector-rehearsal.example'): { configPath: string; config: RehearsalConfig } {
  const configPath = join(root, 'connector-rehearsal.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as RehearsalConfig;
  config.authority_url = authorityUrl;
  config.organization_name = 'Connector rehearsal';
  config.owner_name = 'Rehearsal Owner';
  config.owner_email = 'owner@example.com';
  config.jira.cloud_id = '12345678-1234-1234-1234-123456789abc';
  config.jira.project = 'ECHO';
  write(config.oidc.config_file, JSON.stringify({
    issuer: 'https://issuer.example', client_id: 'client',
    redirect_uri: `${authorityUrl}/v2/session/oidc/callback`, tenant: { kind: 'issuer' },
    id_token_algorithms: ['RS256'], client_authentication: 'none',
  }));
  for (const path of [
    config.nango.secret_key_file,
    config.granola.credential_file,
    config.granola.owner_email_file,
    config.openrouter.credential_file,
  ]) write(path, 'private-value');
  write(configPath, `${JSON.stringify(config)}\n`);
  return { configPath, config };
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('connector rehearsal preparation', () => {
  it('creates only the isolated boundary and a nonsecret template', () => {
    const root = prepared();
    const output = preflight(root);
    assert.equal(output.status, 'prepared');
    assert.equal(output.qualified, false);
    assert.ok(output.missing_inputs?.includes('authority_url'));
    assert.throws(() => readFileSync(join(root, 'state')));
    const template = readFileSync(join(root, 'connector-rehearsal.json'), 'utf8');
    assert.ok(!template.includes('nango_connect_session'));
    assert.ok(!template.includes('xoxb-'));
  });

  it('rejects an existing or unsafe target root', () => {
    const parent = directory();
    const existing = join(parent, 'existing');
    mkdirSync(existing);
    write(join(existing, 'file'), 'x');
    assert.throws(() => prepare(existing), /must be new/);
    assert.throws(() => prepare('/'), /absolute canonical path/);
  });

  it('rejects symlinked rehearsal roots', () => {
    const root = prepared();
    const alias = join(directory(), 'alias');
    symlinkSync(root, alias);
    assert.throws(() => preflight(alias), /symbolic links/);
  });

  it('rejects a reserved state entry and bootstrap-incompatible owner or OIDC metadata', () => {
    const root = prepared();
    const missingState = join(root, 'missing-state');
    symlinkSync(missingState, join(root, 'state'));
    assert.throws(() => preflight(root), /state directory must remain absent/);
    rmSync(join(root, 'state'));

    const { configPath, config } = ready(root);
    config.owner_email = 'owner.@example.com';
    write(configPath, `${JSON.stringify(config)}\n`);
    assert.throws(() => preflight(root), /owner_email is invalid/);

    config.owner_email = 'owner@example.com';
    write(config.oidc.config_file, JSON.stringify({
      issuer: 'https://issuer.example', client_id: 'client',
      redirect_uri: 'https://connector-rehearsal.example/v2/session/oidc/callback', tenant: 'issuer',
      id_token_algorithms: ['RS256'], client_authentication: 'none',
    }));
    write(configPath, `${JSON.stringify(config)}\n`);
    assert.throws(() => preflight(root), /OIDC tenant constraint is invalid/);
  });

  it('reports missing 0600 inputs without reading their contents', () => {
    const root = prepared();
    const { config } = ready(root);
    chmodSync(config.nango.secret_key_file, 0o644);
    const output = preflight(root);
    assert.equal(output.status, 'prepared');
    assert.deepEqual(output.missing_inputs, ['nango.secret_key_file']);
    const result = spawnSync(process.execPath, ['tools/connector-rehearsal.mjs', 'preflight', '--directory', root], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('private-value'));
  });

  it('becomes configuration-ready only after bounded metadata checks pass', () => {
    const root = prepared();
    ready(root);
    assert.deepEqual(preflight(root), {
      schema_version: 1,
      kind: 'echo-connector-rehearsal-status-v1',
      status: 'configuration_ready',
      directory: root,
      qualified: false,
      missing_inputs: [],
    });
  });

  it('refuses the known staging origin and localhost-like callbacks', () => {
    const root = prepared();
    ready(root, 'https://authority-staging.echobrain.org');
    assert.throws(() => preflight(root), /not a permitted rehearsal origin/);
    const local = prepared();
    ready(local, 'https://localhost');
    assert.throws(() => preflight(local), /not a permitted rehearsal origin/);
  });
});
