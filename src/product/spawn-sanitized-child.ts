import {
  default as childProcess,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, delimiter, join, resolve } from 'node:path';

const CREDENTIAL_KEY =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|GRANOLA|ANTHROPIC|OPENAI)/i;
const PROXY_KEY = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i;
const NPM_CONFIG_KEY = /^NPM_CONFIG_/i;

export const SANITIZED_CHILD_MARKER = 'ECHO_PRODUCT_SANITIZED_CHILD';

type ChildProcessMethod = (...args: unknown[]) => unknown;
type ChildProcessModule = Record<string, ChildProcessMethod>;

const GUARDED_METHODS = ['spawn', 'exec', 'execFile', 'fork'] as const;

export interface PublicNpmInstallConfigPaths {
  userconfig: string;
  globalconfig: string;
}

export function publicNpmInstallConfigPaths(
  workingDirectory: string,
): PublicNpmInstallConfigPaths {
  const configDirectory = join(resolve(workingDirectory), 'npm-no-config');
  return {
    userconfig: join(configDirectory, 'user.npmrc'),
    globalconfig: join(configDirectory, 'global.npmrc'),
  };
}

function assertPrivateDirectory(path: string, label: string): void {
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${label} must be an owner-private real directory`);
  }
}

function replaceWithEmptyPrivateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  const state = lstatSync(path);
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o777) !== 0o600 ||
    state.size !== 0
  ) {
    throw new Error('npm no-config file was not created safely');
  }
}

function preparePublicNpmInstallConfig(
  workingDirectory: string,
): PublicNpmInstallConfigPaths {
  const root = resolve(workingDirectory);
  assertPrivateDirectory(root, 'public npm working directory');
  const paths = publicNpmInstallConfigPaths(root);
  const configDirectory = dirname(paths.userconfig);
  try {
    mkdirSync(configDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateDirectory(configDirectory, 'public npm no-config directory');
  replaceWithEmptyPrivateFile(paths.userconfig);
  replaceWithEmptyPrivateFile(paths.globalconfig);
  return paths;
}

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

/**
 * The one product child environment allowed to reach the public internet.
 *
 * Internal-live installation needs npm lifecycle scripts so native dependencies
 * can install on a cold machine. It still receives no parent credentials,
 * proxies, custom registry, or npm configuration files. The caller must use a
 * private working directory, which becomes this child's isolated HOME/cache.
 */
export function publicNpmInstallEnvironment(
  workingDirectory: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configPaths = preparePublicNpmInstallConfig(workingDirectory);
  const env = sanitizedChildEnvironment({ HOME: workingDirectory }, base);
  for (const key of Object.keys(env)) {
    if (
      PROXY_KEY.test(key) ||
      NPM_CONFIG_KEY.test(key) ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_EXTRA_CA_CERTS' ||
      key === 'SSL_CERT_FILE' ||
      key === 'SSL_CERT_DIR'
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: workingDirectory,
    [SANITIZED_CHILD_MARKER]: '1',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: configPaths.userconfig,
    npm_config_globalconfig: configPaths.globalconfig,
    npm_config_cache: `${workingDirectory}/npm-cache`,
    npm_config_offline: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_always_auth: 'false',
    npm_config_strict_ssl: 'true',
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

export function spawnPublicNpmInstallChild(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { cwd: string },
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    ...options,
    env: publicNpmInstallEnvironment(options.cwd, options.env ?? process.env),
    stdio: 'pipe',
  });
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
