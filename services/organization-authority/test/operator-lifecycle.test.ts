import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAuthorityDatabaseReadOnly } from '../src/adapters/persistence/sqlite/read-only-inspection.js';
import { openAuthorityDatabase } from '../src/adapters/persistence/sqlite/open-database.js';
import { authorityRuntimeFingerprint } from '../src/adapters/runtime/runtime-fingerprint.js';
import {
  acquireAuthorityRuntimeLock,
  authorityRuntimeLockPath,
  inspectAuthorityRuntimeLock,
} from '../src/adapters/runtime/singleton-runtime-lock.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from '../src/composition/operator-config.js';
import {
  initializeDevelopmentAuthority,
  inspectAuthorityServePreflight,
  inspectInitializedAuthorityState,
} from '../src/composition/operator-state.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import {
  inspectAuthorityRuntimeOwnership,
  inspectAuthorityStatus,
} from '../src/composition/status.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-authority-operator-')),
  );
  temporaryRoots.push(root);
  return root;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('test could not reserve a loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function stateSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath =
        prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        result[`${relativePath}/`] = mode(path).toString(8);
        visit(path, relativePath);
      } else {
        result[relativePath] = `${mode(path).toString(8)}:${createHash('sha256')
          .update(readFileSync(path))
          .digest('hex')}`;
      }
    }
  };
  visit(root);
  return result;
}

async function initializedFixture(): Promise<{
  root: string;
  configPath: string;
  stateDirectory: string;
  port: number;
}> {
  const root = temporaryRoot();
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  const port = await reserveLoopbackPort();
  await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
    port,
  });
  return { root, configPath, stateDirectory, port };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('organization authority operator lifecycle', () => {
  it('places runtime ownership in a private directory below the configured shared root', async () => {
    const fixture = await initializedFixture();
    const coordinationRoot = realpathSync(
      mkdtempSync('/tmp/echo-authority-coordination-'),
    );
    temporaryRoots.push(coordinationRoot);
    chmodSync(coordinationRoot, 0o1777);
    const previous = process.env.ECHO_AUTHORITY_COORDINATION_ROOT;
    process.env.ECHO_AUTHORITY_COORDINATION_ROOT = coordinationRoot;
    try {
      const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
      expect(dirname(lockPath)).not.toBe(fixture.stateDirectory);
      expect(dirname(dirname(lockPath))).toBe(coordinationRoot);
      expect(mode(dirname(lockPath))).toBe(0o700);
      const runtimeLock = await acquireAuthorityRuntimeLock(
        fixture.stateDirectory,
        `sha256:${'a'.repeat(64)}`,
      );
      await runtimeLock.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.ECHO_AUTHORITY_COORDINATION_ROOT;
      } else {
        process.env.ECHO_AUTHORITY_COORDINATION_ROOT = previous;
      }
    }
  });

  it('initializes private state once and writes a secret-free strict config last', async () => {
    const fixture = await initializedFixture();
    const firstConfig = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const adminToken = readFileSync(paths.admin_credential_path, 'utf8');
    const proxyToken = readFileSync(paths.proxy_credential_path, 'utf8');
    const configText = readFileSync(fixture.configPath, 'utf8');
    const manifestText = readFileSync(
      paths.initialization_manifest_path,
      'utf8',
    );
    const manifest = JSON.parse(manifestText) as {
      config_path: string;
      runtime_config: unknown;
    };

    expect(mode(fixture.configPath)).toBe(0o600);
    expect(mode(paths.state_directory)).toBe(0o700);
    expect(mode(paths.key_directory)).toBe(0o700);
    expect(mode(paths.credential_directory)).toBe(0o700);
    expect(mode(paths.admin_credential_path)).toBe(0o600);
    expect(mode(paths.proxy_credential_path)).toBe(0o600);
    expect(mode(paths.database_path)).toBe(0o600);
    expect(mode(paths.identity_path)).toBe(0o600);
    expect(mode(paths.initialization_manifest_path)).toBe(0o600);
    expect(manifest.config_path).toBe(fixture.configPath);
    expect(manifest.runtime_config).toEqual(firstConfig);
    expect(adminToken).not.toBe(proxyToken);
    expect(configText).not.toContain(adminToken);
    expect(configText).not.toContain(proxyToken);
    expect(manifestText).not.toContain(adminToken);
    expect(manifestText).not.toContain(proxyToken);

    const database = inspectAuthorityDatabaseReadOnly(paths.database_path);
    expect(database.tables).toHaveLength(8);
    expect(database.authority_id).toBe(firstConfig.authority.authority_id);
    expect(database.organization_id).toBe(
      firstConfig.organization.organization_id,
    );

    const repeated = await initializeDevelopmentAuthority({
      config_path: fixture.configPath,
      state_directory: fixture.stateDirectory,
      organization_display_name: 'Example Company',
      port: fixture.port,
    });
    expect(repeated.created).toBe(false);
    expect(repeated.authority_descriptor.authority_id).toBe(
      firstConfig.authority.authority_id,
    );
  });

  it('serializes concurrent initialization and safely completes a published state without config', async () => {
    const root = temporaryRoot();
    const configPath = join(root, 'authority.json');
    const stateDirectory = join(root, 'state');
    const port = await reserveLoopbackPort();
    const initialize = () =>
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port,
      });

    const concurrent = await Promise.allSettled([initialize(), initialize()]);
    expect(
      concurrent.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      concurrent.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    const original = readAuthorityRuntimeConfig(configPath);
    await inspectInitializedAuthorityState(configPath, original);

    unlinkSync(configPath);
    const differentConfigPath = join(root, 'different-authority.json');
    await expect(
      initializeDevelopmentAuthority({
        config_path: differentConfigPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    await expect(
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Different Company',
        port,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    const differentPort = port === 65_535 ? port - 1 : port + 1;
    await expect(
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port: differentPort,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    expect(existsSync(differentConfigPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);

    const recovered = await initialize();
    expect(recovered).toMatchObject({
      created: false,
      authority_descriptor: { authority_id: original.authority.authority_id },
    });
    expect(readAuthorityRuntimeConfig(configPath)).toEqual(original);
  });

  it('rejects copied or altered configs that are not the initialized intent', async () => {
    const fixture = await initializedFixture();
    const original = readAuthorityRuntimeConfig(fixture.configPath);
    const copiedConfigPath = join(fixture.root, 'copied-authority.json');
    writeFileSync(copiedConfigPath, readFileSync(fixture.configPath), {
      flag: 'wx',
      mode: 0o600,
    });

    const copiedStatus = await inspectAuthorityStatus(copiedConfigPath);
    expect(copiedStatus).toMatchObject({
      ok: false,
      initialized: false,
    });
    expect(copiedStatus.checks.at(-1)?.detail).toContain(
      'differ from the initialized intent',
    );
    await expect(
      inspectAuthorityRuntimeOwnership(copiedConfigPath),
    ).resolves.toMatchObject({ ok: false, initialized: false });
    await expect(
      inspectAuthorityServePreflight(copiedConfigPath, original),
    ).rejects.toThrow('differ from the initialized intent');
    await expect(
      runOrganizationAuthorityCli(
        ['serve', '--config', copiedConfigPath],
        {},
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow('differ from the initialized intent');

    const altered = {
      ...original,
      listener: {
        ...original.listener,
        port:
          original.listener.port === 65_535
            ? original.listener.port - 1
            : original.listener.port + 1,
      },
    };
    writeFileSync(
      fixture.configPath,
      `${JSON.stringify(altered, null, 2)}\n`,
      'utf8',
    );
    const alteredConfig = readAuthorityRuntimeConfig(fixture.configPath);
    const alteredStatus = await inspectAuthorityStatus(fixture.configPath);
    expect(alteredStatus).toMatchObject({
      ok: false,
      initialized: false,
    });
    expect(alteredStatus.checks.at(-1)?.detail).toContain(
      'differ from the initialized intent',
    );
    await expect(
      inspectAuthorityServePreflight(fixture.configPath, alteredConfig),
    ).rejects.toThrow('differ from the initialized intent');
  });

  it('requires a strict private initialization manifest on repeated init', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    chmodSync(paths.initialization_manifest_path, 0o644);
    const insecureStatus = await inspectAuthorityStatus(fixture.configPath);
    expect(insecureStatus).toMatchObject({ ok: false, initialized: false });
    expect(insecureStatus.checks.at(-1)?.detail).toContain('0600');
    chmodSync(paths.initialization_manifest_path, 0o600);

    const manifest = JSON.parse(
      readFileSync(paths.initialization_manifest_path, 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      paths.initialization_manifest_path,
      `${JSON.stringify({ ...manifest, unexpected: true })}\n`,
      'utf8',
    );

    await expect(
      initializeDevelopmentAuthority({
        config_path: fixture.configPath,
        state_directory: fixture.stateDirectory,
        organization_display_name: 'Example Company',
        port: fixture.port,
      }),
    ).rejects.toThrow('unsupported shape');
    const status = await inspectAuthorityStatus(fixture.configPath);
    expect(status).toMatchObject({ ok: false, initialized: false });
    expect(status.checks.at(-1)?.detail).toContain('unsupported shape');
  });

  it('reports cleanly stopped state without mutating authority files', async () => {
    const fixture = await initializedFixture();
    const before = stateSnapshot(fixture.root);
    const report = await inspectAuthorityStatus(fixture.configPath);
    const after = stateSnapshot(fixture.root);

    expect(report).toMatchObject({
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
    });
    expect(after).toEqual(before);
  });

  it('can prove runtime ownership inputs without opening SQLite', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    writeFileSync(paths.database_path, 'not a SQLite database', 'utf8');

    await expect(
      inspectAuthorityRuntimeOwnership(fixture.configPath),
    ).resolves.toMatchObject({
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
    });
    await expect(
      inspectAuthorityStatus(fixture.configPath),
    ).resolves.toMatchObject({
      ok: false,
      initialized: false,
    });
  });

  it('does not contact an unrelated listener while no runtime owner exists', async () => {
    const fixture = await initializedFixture();
    let requests = 0;
    const hostile = createHttpServer((_request, response) => {
      requests += 1;
      response.writeHead(200).end('unexpected');
    });
    await new Promise<void>((resolve, reject) => {
      hostile.once('error', reject);
      hostile.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: true,
        running: false,
        healthy: false,
      });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        hostile.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('rejects a lookalike owned listener without sending authority credentials', async () => {
    const fixture = await initializedFixture();
    const runtimeConfig = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      authorityRuntimeFingerprint(runtimeConfig),
    );
    const observedHeaders: Array<
      Record<string, string | string[] | undefined>
    > = [];
    const listener = createHttpServer((request, response) => {
      observedHeaders.push(request.headers);
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'proxy_identity_unavailable',
            message: 'trusted proxy identity is unavailable',
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: false,
        running: true,
        healthy: false,
      });
      expect(observedHeaders).toHaveLength(1);
      expect(
        observedHeaders[0]?.['x-echo-proxy-authorization'],
      ).toBeUndefined();
      expect(
        observedHeaders[0]?.['x-echo-authenticated-client-id'],
      ).toBeUndefined();
    } finally {
      await runtimeLock.release();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('rejects runtime ownership composed from different policy', async () => {
    const fixture = await initializedFixture();
    const canonical = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const alternateFingerprint = authorityRuntimeFingerprint({
      ...canonical,
      active_lease_ttl_ms: canonical.active_lease_ttl_ms - 1,
    });
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      alternateFingerprint,
    );
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: false,
        initialized: true,
        running: true,
        healthy: false,
      });
      expect(report.checks.at(-1)?.detail).toContain(
        'does not match the configured files or policy',
      );
    } finally {
      await runtimeLock.release();
    }
  });

  it('serves the pinned identity, reports healthy, and rejects a second owner', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    await inspectInitializedAuthorityState(fixture.configPath, config);
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtime = await startOrganizationAuthority(serveConfig);
    try {
      const lock = JSON.parse(
        readFileSync(authorityRuntimeLockPath(fixture.stateDirectory), 'utf8'),
      ) as { schema_version: number; guard_socket: string };
      expect(lock.schema_version).toBe(2);
      expect(
        statSync(join(fixture.stateDirectory, lock.guard_socket)).isSocket(),
      ).toBe(true);
      await expect(startOrganizationAuthority(serveConfig)).rejects.toThrow(
        'already running for this state directory',
      );
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: true,
        initialized: true,
        running: true,
        healthy: true,
        authority_id: config.authority.authority_id,
        organization_id: config.organization.organization_id,
      });
    } finally {
      await runtime.close();
    }
    const stopped = await inspectAuthorityStatus(fixture.configPath);
    expect(stopped, JSON.stringify(stopped)).toMatchObject({
      ok: true,
      running: false,
    });
    expect(
      readdirSync(fixture.stateDirectory).some((name) =>
        name.startsWith('.g-'),
      ),
    ).toBe(false);
  });

  it('abandons kernel ownership but preserves recovery state when shutdown fails', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtimeModule = new URL(
      '../dist/composition/runtime.js',
      import.meta.url,
    ).href;
    const configModule = new URL(
      '../dist/composition/operator-config.js',
      import.meta.url,
    ).href;
    const applicationModule = new URL(
      '../dist/application/organization-authority.js',
      import.meta.url,
    ).href;
    const lockModule = new URL(
      '../dist/adapters/runtime/singleton-runtime-lock.js',
      import.meta.url,
    ).href;
    const childOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const [{ startOrganizationAuthority }, { readAuthorityRuntimeConfig, resolveAuthorityServeConfig }, { OrganizationAuthorityApplication }, { inspectAuthorityRuntimeLock }] = await Promise.all([
          import(${JSON.stringify(runtimeModule)}),
          import(${JSON.stringify(configModule)}),
          import(${JSON.stringify(applicationModule)}),
          import(${JSON.stringify(lockModule)})
        ]);
        const config = readAuthorityRuntimeConfig(process.env.ECHO_TEST_AUTHORITY_CONFIG);
        const serveConfig = resolveAuthorityServeConfig(config);
        const runtime = await startOrganizationAuthority(serveConfig);
        OrganizationAuthorityApplication.prototype.close = function () {
          throw new Error('injected application shutdown failure');
        };
        let failure = null;
        try { await runtime.close(); }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
        const inspection = await inspectAuthorityRuntimeLock(config.state_dir);
        process.stdout.write(JSON.stringify({ failure, inspection }));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ECHO_TEST_AUTHORITY_CONFIG: fixture.configPath,
        },
        timeout: 15_000,
      },
    );
    const childResult = JSON.parse(childOutput) as {
      failure: string | null;
      inspection: { present: boolean; active: boolean };
    };
    expect(childResult.failure).toContain(
      'injected application shutdown failure',
    );
    expect(childResult.inspection).toMatchObject({
      present: true,
      active: true,
    });

    expect(
      await inspectAuthorityRuntimeLock(fixture.stateDirectory),
    ).toMatchObject({
      present: true,
      active: false,
    });
    const recovered = await startOrganizationAuthority(serveConfig);
    await recovered.close();
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('recovers a stale runtime lock even when its pid has been reused', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: `.g-${'a'.repeat(6)}`,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const contenders = await Promise.allSettled([
      startOrganizationAuthority(serveConfig),
      startOrganizationAuthority(serveConfig),
    ]);
    expect(
      contenders.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      contenders.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    const winner = contenders.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof startOrganizationAuthority>>
      > => result.status === 'fulfilled',
    );
    if (winner === undefined)
      throw new Error('stale-lock recovery had no owner');
    const runtime = winner.value;
    try {
      expect((await inspectAuthorityStatus(fixture.configPath)).healthy).toBe(
        true,
      );
    } finally {
      await runtime.close();
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(fixture.stateDirectory).some((name) =>
        name.includes('.prepare-'),
      ),
    ).toBe(false);
  });

  it('upgrades a proven-stale schema-1 TCP ownership lock', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const stalePort = await reserveLoopbackPort();
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_port: stalePort,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const lock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      `sha256:${'c'.repeat(64)}`,
    );
    try {
      const upgraded = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        schema_version: number;
      };
      expect(upgraded.schema_version).toBe(2);
    } finally {
      await lock.release();
    }
  });

  it('authenticates and preserves a live schema-1 TCP ownership lock', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const token = 'a'.repeat(64);
    const legacyGuard = createNetServer((socket) => {
      socket.once('data', (bytes) => {
        const line = bytes.toString('ascii').trimEnd();
        const nonce = line.slice(line.lastIndexOf(' ') + 1);
        const proof = createHmac('sha256', Buffer.from(token, 'hex'))
          .update('echo-organization-authority-kernel-guard-v1\0', 'utf8')
          .update(nonce, 'ascii')
          .digest('hex');
        socket.end(
          `echo-organization-authority-guard/1 proof ${proof}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyGuard.once('error', reject);
      legacyGuard.listen(0, '127.0.0.1', resolve);
    });
    const address = legacyGuard.address();
    if (address === null || typeof address === 'string') {
      throw new Error('legacy guard did not bind TCP');
    }
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token,
        guard_port: address.port,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const original = readFileSync(lockPath, 'utf8');
    try {
      await expect(
        acquireAuthorityRuntimeLock(
          fixture.stateDirectory,
          `sha256:${'c'.repeat(64)}`,
        ),
      ).rejects.toThrow('authenticated kernel ownership guard is active');
      expect(readFileSync(lockPath, 'utf8')).toBe(original);
    } finally {
      await new Promise<void>((resolve, reject) => {
        legacyGuard.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('fails closed on a wrong guard proof without replacing ownership state', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const guardSocket = `.g-${'a'.repeat(6)}`;
    const guardPath = join(fixture.stateDirectory, guardSocket);
    let challenges = 0;
    const unrelated = createNetServer((socket) => {
      socket.once('data', () => {
        challenges += 1;
        socket.end(
          `echo-organization-authority-guard/1 proof ${'0'.repeat(64)}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      unrelated.once('error', reject);
      unrelated.listen(guardPath, resolve);
    });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: guardSocket,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const originalLock = readFileSync(lockPath, 'utf8');

    try {
      await expect(
        inspectAuthorityRuntimeLock(fixture.stateDirectory),
      ).rejects.toThrow('could not be authenticated safely');

      const config = readAuthorityRuntimeConfig(fixture.configPath);
      const serveConfig = resolveAuthorityServeConfig(config);
      const contenders = await Promise.allSettled([
        startOrganizationAuthority(serveConfig),
        startOrganizationAuthority(serveConfig),
      ]);
      expect(
        contenders.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(2);
      expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
      expect(challenges).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        unrelated.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('fails closed when a guard accepts a challenge but gives no answer', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const guardSocket = `.g-${'a'.repeat(6)}`;
    const guardPath = join(fixture.stateDirectory, guardSocket);
    const sockets = new Set<Socket>();
    const silent = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      silent.once('error', reject);
      silent.listen(guardPath, resolve);
    });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: guardSocket,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const originalLock = readFileSync(lockPath, 'utf8');

    try {
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      await expect(
        startOrganizationAuthority(resolveAuthorityServeConfig(config)),
      ).rejects.toThrow('could not be authenticated safely');
      expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        silent.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('never recreates a missing initialized database while serving', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    unlinkSync(config.database_path);

    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow();
    expect(existsSync(config.database_path)).toBe(false);
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('never adopts an empty replacement database while serving', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    unlinkSync(config.database_path);
    openAuthorityDatabase(config.database_path).close();

    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow('must already contain initialized metadata');
    expect(() =>
      inspectAuthorityDatabaseReadOnly(config.database_path),
    ).toThrow('metadata is missing');
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('releases runtime ownership when the configured listener cannot bind', async () => {
    const fixture = await initializedFixture();
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      await expect(
        startOrganizationAuthority(resolveAuthorityServeConfig(config)),
      ).rejects.toThrow();
      expect(
        (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('enforces an absolute listener status deadline', async () => {
    const fixture = await initializedFixture();
    const runtimeConfig = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      authorityRuntimeFingerprint(runtimeConfig),
    );
    const intervals = new Set<NodeJS.Timeout>();
    const listener = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const interval = setInterval(() => response.write(' '), 100);
      intervals.add(interval);
      response.once('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const started = Date.now();
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(report).toMatchObject({
        ok: false,
        running: true,
        healthy: false,
      });
    } finally {
      for (const interval of intervals) clearInterval(interval);
      await runtimeLock.release();
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('serve preflight never recreates a missing signing identity', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const keyPath = join(
      config.signer.key_directory,
      'authority-development-key.v1.json',
    );
    unlinkSync(keyPath);
    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow('key file does not exist');
    expect(existsSync(keyPath)).toBe(false);
  });

  it('rejects unknown config fields and insecure config permissions', async () => {
    const fixture = await initializedFixture();
    const original = JSON.parse(
      readFileSync(fixture.configPath, 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      fixture.configPath,
      `${JSON.stringify({ ...original, inline_admin_token: 'forbidden' })}\n`,
      { mode: 0o600 },
    );
    expect(() => readAuthorityRuntimeConfig(fixture.configPath)).toThrow(
      'unexpected shape',
    );
    writeFileSync(fixture.configPath, `${JSON.stringify(original)}\n`);
    chmodSync(fixture.configPath, 0o644);
    expect(() => readAuthorityRuntimeConfig(fixture.configPath)).toThrow(
      '0600',
    );
  });

  it('exposes init and stopped status through strict JSON CLI commands', async () => {
    const root = temporaryRoot();
    const configPath = join(root, 'authority.json');
    const stateDirectory = join(root, 'state');
    const port = await reserveLoopbackPort();
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };
    expect(
      await runOrganizationAuthorityCli(
        [
          'init-development',
          '--config',
          configPath,
          '--state-dir',
          stateDirectory,
          '--organization-name',
          'Example Company',
          '--port',
          String(port),
        ],
        {},
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(output.shift()!)).toMatchObject({
      kind: 'echo-organization-authority-development-initialization',
      created: true,
    });
    expect(
      await runOrganizationAuthorityCli(
        ['status', '--config', configPath],
        {},
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(output.shift()!)).toMatchObject({
      kind: 'echo-organization-authority-status',
      initialized: true,
      running: false,
    });
    expect(errors).toEqual([]);
  });
});
