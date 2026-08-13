import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { inspectAuthorityRuntimeLock } from '../adapters/runtime/singleton-runtime-lock.js';
import { authorityRuntimeFingerprint } from '../adapters/runtime/runtime-fingerprint.js';
import { verifyAuthorityRuntimeStatus } from '../adapters/runtime/runtime-status-proof.js';
import {
  AUTHORITY_RUNTIME_STATUS_NONCE_HEADER,
  AUTHORITY_RUNTIME_STATUS_PATH,
  validateAuthorityRuntimeStatus,
} from '../domain/runtime-status.js';
import {
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
  type AuthorityRuntimeConfigV1,
} from './operator-config.js';
import {
  inspectInitializedAuthorityFiles,
  inspectInitializedAuthorityState,
  resolveEffectiveAuthorityServeConfig,
} from './operator-state.js';

const MAX_STATUS_RESPONSE_BYTES = 64 * 1024;
const STATUS_DEADLINE_MS = 2_000;

export interface AuthorityStatusCheck {
  id: 'config' | 'initialized-state' | 'runtime-lock' | 'listener';
  ok: boolean;
  detail: string;
}

export interface AuthorityStatusReport {
  schema_version: 1;
  kind: 'echo-organization-authority-status';
  ok: boolean;
  initialized: boolean;
  running: boolean;
  healthy: boolean;
  config_path: string;
  state_dir: string | null;
  authority_id: string | null;
  organization_id: string | null;
  listener: string | null;
  checks: readonly AuthorityStatusCheck[];
}

interface ListenerProbe {
  ok: boolean;
  detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown status failure';
}

function listenerOrigin(config: AuthorityRuntimeConfigV1): string {
  const host = config.listener.host === '::1' ? '[::1]' : '127.0.0.1';
  return `http://${host}:${config.listener.port}`;
}

/**
 * Sends only a fresh nonce. The listener proves knowledge of the ephemeral
 * secret in the private runtime lock without transmitting that secret.
 */
async function probeListener(
  config: AuthorityRuntimeConfigV1,
  challengeSecret: string,
  runtimeFingerprint: `sha256:${string}`,
): Promise<ListenerProbe> {
  return await new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex');
    let settled = false;
    const finish = (result: ListenerProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const probe = request(
      {
        agent: false,
        host: config.listener.host,
        port: config.listener.port,
        method: 'GET',
        path: AUTHORITY_RUNTIME_STATUS_PATH,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          [AUTHORITY_RUNTIME_STATUS_NONCE_HEADER]: nonce,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > MAX_STATUS_RESPONSE_BYTES) {
            response.destroy(new Error('status response exceeds size limit'));
            return;
          }
          chunks.push(bytes);
        });
        response.once('error', (error) => {
          finish({
            ok: false,
            detail: `listener response failed: ${error.message}`,
          });
        });
        response.once('end', () => {
          try {
            const body = validateAuthorityRuntimeStatus(
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            );
            if (
              response.statusCode !== 200 ||
              body.authority_id !== config.authority.authority_id ||
              body.organization_id !== config.organization.organization_id ||
              body.nonce !== nonce ||
              !verifyAuthorityRuntimeStatus(
                body,
                challengeSecret,
                runtimeFingerprint,
              )
            ) {
              throw new Error(
                `listener did not prove the configured runtime identity (HTTP ${String(
                  response.statusCode ?? 'unknown',
                )})`,
              );
            }
            finish({
              ok: true,
              detail: 'listener proved the configured runtime identity',
            });
          } catch (error) {
            finish({
              ok: false,
              detail: `listener boundary check failed: ${errorMessage(error)}`,
            });
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      probe.destroy(new Error('status deadline exceeded'));
      finish({
        ok: false,
        detail: 'listener did not answer before the absolute status deadline',
      });
    }, STATUS_DEADLINE_MS);
    deadline.unref?.();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, detail: `listener probe failed: ${error.message}` });
    });
    probe.end();
  });
}

function baseReport(
  configPath: string,
  checks: readonly AuthorityStatusCheck[],
): AuthorityStatusReport {
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-status',
    ok: false,
    initialized: false,
    running: false,
    healthy: false,
    config_path: configPath,
    state_dir: null,
    authority_id: null,
    organization_id: null,
    listener: null,
    checks,
  };
}

async function inspectAuthorityStatusWithPolicy(
  configPath: string,
  inspectDatabaseState: boolean,
): Promise<AuthorityStatusReport> {
  const checks: AuthorityStatusCheck[] = [];
  let config: AuthorityRuntimeConfigV1;
  let runtimeFingerprint: `sha256:${string}`;
  try {
    config = readAuthorityRuntimeConfig(configPath);
    checks.push({ id: 'config', ok: true, detail: 'config is valid' });
  } catch (error) {
    checks.push({ id: 'config', ok: false, detail: errorMessage(error) });
    return baseReport(configPath, checks);
  }

  try {
    if (inspectDatabaseState)
      await inspectInitializedAuthorityState(configPath, config);
    else await inspectInitializedAuthorityFiles(configPath, config);
    runtimeFingerprint = authorityRuntimeFingerprint(
      inspectDatabaseState
        ? resolveEffectiveAuthorityServeConfig(configPath, config)
        : resolveAuthorityServeConfig(config),
    );
    checks.push({
      id: 'initialized-state',
      ok: true,
      detail: inspectDatabaseState
        ? 'key, credentials, identity, and database agree'
        : 'runtime fingerprint inputs are valid',
    });
  } catch (error) {
    checks.push({
      id: 'initialized-state',
      ok: false,
      detail: errorMessage(error),
    });
    return {
      ...baseReport(configPath, checks),
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
    };
  }

  let lock: Awaited<ReturnType<typeof inspectAuthorityRuntimeLock>>;
  try {
    lock = await inspectAuthorityRuntimeLock(config.state_dir);
  } catch (error) {
    checks.push({
      id: 'runtime-lock',
      ok: false,
      detail: errorMessage(error),
    });
    return {
      ...baseReport(configPath, checks),
      initialized: true,
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
    };
  }
  if (!lock.present) {
    checks.push({
      id: 'runtime-lock',
      ok: true,
      detail: 'no runtime owner is present',
    });
    checks.push({ id: 'listener', ok: true, detail: 'listener is stopped' });
    return {
      schema_version: 1,
      kind: 'echo-organization-authority-status',
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
      config_path: configPath,
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
      checks,
    };
  }
  if (!lock.active) {
    checks.push({
      id: 'runtime-lock',
      ok: false,
      detail: `stale runtime ownership remains for pid ${String(lock.pid)}`,
    });
    return {
      ...baseReport(configPath, checks),
      initialized: true,
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
    };
  }
  checks.push({
    id: 'runtime-lock',
    ok: true,
    detail: `runtime owner pid ${String(lock.pid)} is active`,
  });
  if (
    inspectDatabaseState &&
    lock.runtime_fingerprint_sha256 !== runtimeFingerprint
  ) {
    checks.push({
      id: 'listener',
      ok: false,
      detail: 'runtime ownership does not match the configured files or policy',
    });
    return {
      schema_version: 1,
      kind: 'echo-organization-authority-status',
      ok: false,
      initialized: true,
      running: true,
      healthy: false,
      config_path: configPath,
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
      checks,
    };
  }
  if (
    lock.challenge_secret === undefined ||
    lock.runtime_fingerprint_sha256 === undefined
  ) {
    checks.push({
      id: 'listener',
      ok: false,
      detail: 'runtime ownership has no complete challenge proof',
    });
    return {
      schema_version: 1,
      kind: 'echo-organization-authority-status',
      ok: false,
      initialized: true,
      running: true,
      healthy: false,
      config_path: configPath,
      state_dir: config.state_dir,
      authority_id: config.authority.authority_id,
      organization_id: config.organization.organization_id,
      listener: listenerOrigin(config),
      checks,
    };
  }
  const listener = await probeListener(
    config,
    lock.challenge_secret,
    // Ownership-only preflight intentionally does not open SQLite. In that
    // mode the authenticated lock names the exact fingerprint the live
    // listener must prove. Full status independently recomputes and compares
    // the activation-aware fingerprint above before reaching this probe.
    inspectDatabaseState
      ? runtimeFingerprint
      : lock.runtime_fingerprint_sha256,
  );
  checks.push({ id: 'listener', ok: listener.ok, detail: listener.detail });
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-status',
    ok: listener.ok,
    initialized: true,
    running: true,
    healthy: listener.ok,
    config_path: configPath,
    state_dir: config.state_dir,
    authority_id: config.authority.authority_id,
    organization_id: config.organization.organization_id,
    listener: listenerOrigin(config),
    checks,
  };
}

export async function inspectAuthorityStatus(
  configPath: string,
): Promise<AuthorityStatusReport> {
  return await inspectAuthorityStatusWithPolicy(configPath, true);
}

/**
 * Proves the configured live process without opening the authority database.
 * The authenticated ownership lock supplies the opaque runtime fingerprint;
 * the live listener must prove it with the lock challenge secret. Full status
 * separately owns SQLite and effective-policy validation.
 */
export async function inspectAuthorityRuntimeOwnership(
  configPath: string,
): Promise<AuthorityStatusReport> {
  return await inspectAuthorityStatusWithPolicy(configPath, false);
}

export function canonicalAuthorityStatus(
  report: AuthorityStatusReport,
): string {
  return canonicalJson(report as never);
}
