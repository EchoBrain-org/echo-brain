import {
  default as childProcess,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_KEY =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|GRANOLA|ANTHROPIC|OPENAI)/i;

export const SANITIZED_CHILD_MARKER = 'ECHO_PRODUCT_SANITIZED_CHILD';

type ChildProcessMethod = (...args: unknown[]) => unknown;
type ChildProcessModule = Record<string, ChildProcessMethod>;

const GUARDED_METHODS = ['spawn', 'exec', 'execFile', 'fork'] as const;

function hasSanitizedEnvironment(args: readonly unknown[]): boolean {
  return args.some((argument) => {
    if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return false;
    const environment = (argument as { env?: NodeJS.ProcessEnv }).env;
    return environment?.[SANITIZED_CHILD_MARKER] === '1';
  });
}

export function sanitizedChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const requestedPath = overrides.PATH;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || CREDENTIAL_KEY.test(key) || key.startsWith('ECHO_')) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || CREDENTIAL_KEY.test(key) || key.startsWith('ECHO_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH:
      requestedPath ??
      [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    [SANITIZED_CHILD_MARKER]: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

export function spawnSanitizedChild(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    ...options,
    env: sanitizedChildEnvironment(options.env),
    stdio: 'pipe',
  });
}

export function spawnSanitizedChildSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  return spawnSync(command, [...args], {
    ...options,
    env: sanitizedChildEnvironment(options.env),
  });
}

export type BundledProductHelper = 'installation-signer';

const BUNDLED_PRODUCT_HELPERS: Readonly<Record<BundledProductHelper, URL>> =
  Object.freeze({
    'installation-signer': new URL(
      '../native/EchoBrainSigningHelper.app/Contents/MacOS/EchoBrainSigningHelper',
      import.meta.url,
    ),
  });

export function bundledProductHelperPath(helper: BundledProductHelper): string {
  return fileURLToPath(BUNDLED_PRODUCT_HELPERS[helper]);
}

export function bundledProductHelperAvailable(helper: BundledProductHelper): boolean {
  const path = bundledProductHelperPath(helper);
  if (!existsSync(path)) return false;
  const state = lstatSync(path);
  return (
    !state.isSymbolicLink() &&
    state.isFile() &&
    (state.mode & 0o111) !== 0 &&
    realpathSync(path) === path
  );
}

/** Launch one finite, package-owned native helper; arbitrary paths are forbidden. */
export function spawnBundledProductHelper(
  helper: BundledProductHelper,
): ChildProcessWithoutNullStreams {
  const path = bundledProductHelperPath(helper);
  if (!bundledProductHelperAvailable(helper)) {
    throw new Error(`bundled product helper is unavailable or unsafe: ${helper}`);
  }
  return spawnSanitizedChild(path, [], { cwd: fileURLToPath(new URL('../../', import.meta.url)) });
}

/**
 * Install the product-test worker guard at the one module allowed to touch
 * child_process. The marker is added only by spawnSanitizedChild's environment
 * construction; all other launches fail synchronously in the offending file.
 */
export function installSanitizedChildGuard(): () => void {
  const mutableModule = childProcess as unknown as ChildProcessModule;
  const originals = new Map<string, ChildProcessMethod>();

  for (const method of GUARDED_METHODS) {
    const original = mutableModule[method];
    originals.set(method, original);
    mutableModule[method] = (...args: unknown[]): unknown => {
      if (!hasSanitizedEnvironment(args)) {
        throw new Error(
          `product hermeticity guard blocked child_process.${method}; use spawnSanitizedChild`,
        );
      }
      return Reflect.apply(original, childProcess, args);
    };
  }
  syncBuiltinESMExports();

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [method, original] of originals) mutableModule[method] = original;
    syncBuiltinESMExports();
  };
}
