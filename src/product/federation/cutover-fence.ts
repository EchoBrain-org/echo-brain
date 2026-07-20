import { ActiveIdentityBundleStore } from './active-identity-bundle-store.js';
import type { VerifiedActiveIdentityBundle } from './active-identity-bundle-store.js';
import {
  FounderBootstrapSessionStore,
  validateFounderBootstrapSession,
  type FounderBootstrapSessionV1,
} from './bootstrap-session-store.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './canonical-json.js';
import { signedPayload } from './signed-document.js';

export type FounderCutoverFenceState =
  'none' | 'precommit' | 'committing' | 'complete';

export type FounderCutoverFenceInspection =
  | Readonly<{
      state: 'none';
      session: null;
    }>
  | Readonly<{
      state: Exclude<FounderCutoverFenceState, 'none'>;
      session: FounderBootstrapSessionV1;
    }>;

export interface FounderCutoverSessionReader {
  list(): readonly FounderBootstrapSessionV1[];
}

export interface FounderIdentityMaterialReader {
  hasActiveBundle(): boolean;
  hasIdentityMaterial(): boolean;
}

export interface FounderCutoverReceiptOptions {
  /**
   * Recovery-only allowance for the crash window after the active pointer is
   * durable but before the bootstrap session advances to `complete`.
   */
  allowCommittingFinalization?: boolean;
}

export interface FounderCutoverGuardV1 {
  schema_version: 1;
  kind: 'echo-founder-cutover-guard';
  state_path_sha256: `sha256:${string}`;
  session_id: string;
  plan_sha256: `sha256:${string}`;
  installation_key_id: `sha256:${string}`;
}

function statePathDigest(stateDirectory: string): `sha256:${string}` {
  return sha256Digest(
    `${canonicalLocalPath(stateDirectory, 'state directory', false)}\n`,
  );
}

export function founderCutoverGuardPath(stateDirectory: string): string {
  const canonicalState = canonicalLocalPath(
    stateDirectory,
    'state directory',
    false,
  );
  return join(
    dirname(canonicalState),
    `.echo-founder-cutover.${statePathDigest(canonicalState).slice('sha256:'.length)}.v1.json`,
  );
}

function guardForSession(
  stateDirectory: string,
  session: FounderBootstrapSessionV1,
  plannedCommitSha256?: `sha256:${string}`,
): FounderCutoverGuardV1 {
  const verified = validateFounderBootstrapSession(session);
  const planSha256 =
    verified.phase === 'ready_for_confirmation'
      ? plannedCommitSha256
      : verified.commit?.plan_sha256;
  if (
    (verified.phase !== 'ready_for_confirmation' &&
      verified.phase !== 'committing' &&
      verified.phase !== 'complete') ||
    planSha256 === undefined ||
    !/^sha256:[0-9a-f]{64}$/.test(planSha256) ||
    verified.signing_key === null
  ) {
    fail('cannot bind an external guard to a reversible bootstrap session');
  }
  return {
    schema_version: 1,
    kind: 'echo-founder-cutover-guard',
    state_path_sha256: statePathDigest(stateDirectory),
    session_id: verified.session_id,
    plan_sha256: planSha256,
    installation_key_id: verified.signing_key.key_id,
  };
}

function assertGuard(value: unknown): FounderCutoverGuardV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('external cutover guard is not an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'schema_version',
    'kind',
    'state_path_sha256',
    'session_id',
    'plan_sha256',
    'installation_key_id',
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record['schema_version'] !== 1 ||
    record['kind'] !== 'echo-founder-cutover-guard' ||
    typeof record['state_path_sha256'] !== 'string' ||
    typeof record['session_id'] !== 'string' ||
    typeof record['plan_sha256'] !== 'string' ||
    typeof record['installation_key_id'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record['state_path_sha256']) ||
    !/^sha256:[0-9a-f]{64}$/.test(record['plan_sha256']) ||
    !/^sha256:[0-9a-f]{64}$/.test(record['installation_key_id'])
  ) {
    fail('external cutover guard has an invalid shape');
  }
  return value as FounderCutoverGuardV1;
}

export function readFounderCutoverGuard(
  stateDirectory: string,
): FounderCutoverGuardV1 | null {
  const path = founderCutoverGuardPath(stateDirectory);
  if (!pathEntryExists(path)) return null;
  const state = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (state.mode & 0o777) !== 0o600 ||
    currentUid === undefined ||
    state.uid !== currentUid
  ) {
    fail('external cutover guard must be a private current-user file');
  }
  const guard = assertGuard(
    parseCanonicalJson(
      readFileNoFollow(path, 'founder cutover guard').toString('utf8'),
    ),
  );
  if (guard.state_path_sha256 !== statePathDigest(stateDirectory)) {
    fail('external cutover guard belongs to another state path');
  }
  return guard;
}

export function commitFounderCutoverGuard(
  stateDirectory: string,
  session: FounderBootstrapSessionV1,
  plannedCommitSha256?: `sha256:${string}`,
): FounderCutoverGuardV1 {
  const guard = guardForSession(
    stateDirectory,
    session,
    plannedCommitSha256,
  );
  const path = founderCutoverGuardPath(stateDirectory);
  assertOwnerControlledDirectory(dirname(path), 'cutover guard parent');
  atomicCreate({ filePath: path, content: canonicalJson(guard), mode: 0o600 });
  const durable = readFounderCutoverGuard(stateDirectory);
  if (durable === null || canonicalJson(durable) !== canonicalJson(guard)) {
    fail('external cutover guard conflicts with this bootstrap session');
  }
  return durable;
}

export function assertFounderCutoverGuardMatchesSession(
  guard: FounderCutoverGuardV1,
  session: FounderBootstrapSessionV1,
): void {
  const verified = validateFounderBootstrapSession(session);
  if (
    (verified.phase !== 'committing' && verified.phase !== 'complete') ||
    verified.commit === null ||
    verified.signing_key === null ||
    guard.session_id !== verified.session_id ||
    guard.plan_sha256 !== verified.commit.plan_sha256 ||
    guard.installation_key_id !== verified.signing_key.key_id
  ) {
    fail('external cutover guard does not match the bootstrap receipt');
  }
}

function fail(message: string): never {
  throw new Error(`founder seed cutover fence is invalid: ${message}`);
}

function sessionFenceState(
  session: FounderBootstrapSessionV1,
): Exclude<FounderCutoverFenceState, 'none'> {
  return session.phase === 'committing' || session.phase === 'complete'
    ? session.phase
    : 'precommit';
}

/**
 * Inspect the exact-validated, independently stored bootstrap receipt.
 *
 * `committing` is the irreversible fence: the ceremony writes that signed
 * revision before it creates the active identity pointer, and the ceremony
 * cannot abort afterwards. Keeping this evidence below `bootstrap/` means
 * deleting `<state>/identity` cannot silently restore rehearsal mode.
 */
export function inspectFounderCutoverFence(
  stateDirectory: string,
  reader: FounderCutoverSessionReader = new FounderBootstrapSessionStore(
    stateDirectory,
  ),
): FounderCutoverFenceInspection {
  const sessions = [...reader.list()].sort((left, right) =>
    left.session_id.localeCompare(right.session_id),
  );
  const irreversible = sessions.filter(
    (session) => session.phase === 'committing' || session.phase === 'complete',
  );
  if (irreversible.length > 1) {
    fail('multiple irreversible bootstrap sessions exist');
  }
  if (sessions.length > 1) {
    fail('multiple founder bootstrap sessions exist');
  }
  const session = sessions[0];
  if (session === undefined) return { state: 'none', session: null };
  // The production store already performs this exact-shape and signature
  // validation. Re-validating also keeps injected readers fail closed.
  const verified = validateFounderBootstrapSession(session);
  return { state: sessionFenceState(verified), session: verified };
}

/**
 * The one production predicate for deciding whether disposable rehearsal is
 * still permitted. Any irreversible session survives loss of `identity/` and
 * therefore keeps the profile fail-closed.
 */
export function requiresFounderFederation(
  stateDirectory: string,
  identity: FounderIdentityMaterialReader = new ActiveIdentityBundleStore(
    stateDirectory,
  ),
  sessions?: FounderCutoverSessionReader,
): boolean {
  const fence = inspectFounderCutoverFence(stateDirectory, sessions);
  const guard = readFounderCutoverGuard(stateDirectory);
  if (guard !== null) {
    if (
      fence.state !== 'none' &&
      (fence.session.session_id !== guard.session_id ||
        fence.session.signing_key?.key_id !== guard.installation_key_id)
    ) {
      fail('external cutover guard conflicts with bootstrap state');
    }
    return true;
  }
  if (fence.state === 'committing' || fence.state === 'complete') return true;
  return identity.hasActiveBundle() || identity.hasIdentityMaterial();
}

function assertSessionPlanMatchesActiveBundle(
  session: FounderBootstrapSessionV1,
  active: VerifiedActiveIdentityBundle,
): void {
  if (session.signing_key === null || session.commit === null) {
    fail('irreversible bootstrap session lacks its signed commit plan');
  }
  const plan = session.commit.plan;
  const signingKey = session.signing_key;
  const expectedManifest = {
    ...plan.manifest,
    installation: {
      ...plan.manifest.installation,
      signing_key: {
        key_id: signingKey.key_id,
        algorithm: signingKey.algorithm,
        public_key_spki_der_base64: signingKey.public_key_spki_der_base64,
        protection: signingKey.protection,
        assurance: signingKey.assurance,
      },
    },
  };
  const expectedPolicy = {
    ...plan.policy,
    issued_by: {
      installation_id: plan.ids.installation_id,
      key_id: signingKey.key_id,
    },
  };
  if (
    canonicalJson(signedPayload(active.manifest)) !==
      canonicalJson(expectedManifest) ||
    canonicalJson(signedPayload(active.connectionRegistry)) !==
      canonicalJson(plan.registry) ||
    canonicalJson(signedPayload(active.publicationPolicy)) !==
      canonicalJson(expectedPolicy)
  ) {
    fail('bootstrap commit plan does not match the active identity documents');
  }
  const pointer = active.pointer;
  if (
    pointer.manifest.manifest_id !== plan.ids.manifest_id ||
    pointer.connection_registry.registry_id !== plan.ids.registry_id ||
    pointer.connection_registry.revision !== 1 ||
    pointer.default_publication_policy.policy_id !== plan.ids.policy_id ||
    pointer.default_publication_policy.version !== 1 ||
    pointer.active_installation_id !== plan.ids.installation_id ||
    pointer.activated_at !== plan.manifest.created_at ||
    pointer.activation_reason !== 'founder-bootstrap'
  ) {
    fail('bootstrap commit plan does not match the active identity pointer');
  }
}

/**
 * Prove that exactly one irreversible bootstrap receipt names the verified
 * active founder bundle. A `committing` receipt is accepted only by the
 * explicit crash-finalization path; normal seed readiness requires `complete`.
 */
export function assertFounderCutoverReceiptMatchesActiveBundle(
  stateDirectory: string,
  active: VerifiedActiveIdentityBundle,
  options: FounderCutoverReceiptOptions = {},
  reader?: FounderCutoverSessionReader,
): FounderBootstrapSessionV1 {
  const fence = inspectFounderCutoverFence(stateDirectory, reader);
  if (fence.state === 'none' || fence.state === 'precommit') {
    fail('the active identity bundle has no irreversible bootstrap receipt');
  }
  if (
    fence.state === 'committing' &&
    options.allowCommittingFinalization !== true
  ) {
    fail('bootstrap commit is incomplete and must be finalized');
  }
  const session = validateFounderBootstrapSession(fence.session);
  const guard = readFounderCutoverGuard(stateDirectory);
  if (guard === null) {
    fail('irreversible bootstrap receipt has no external cutover guard');
  }
  assertFounderCutoverGuardMatchesSession(guard, session);
  assertSessionPlanMatchesActiveBundle(session, active);
  if (fence.state === 'complete') {
    const result = session.result;
    if (
      result === null ||
      result.organization_id !== active.manifest.organization.organization_id ||
      result.installation_id !== active.manifest.installation.installation_id ||
      result.manifest_id !== active.manifest.manifest_id ||
      result.active_bundle_sha256 !== canonicalSha256(active.pointer)
    ) {
      fail('completed bootstrap receipt does not match the active bundle');
    }
  }
  return session;
}
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicCreate } from '../../infrastructure/filesystem/atomic-create.js';
import {
  assertOwnerControlledDirectory,
  canonicalLocalPath,
  pathEntryExists,
  readFileNoFollow,
} from '../secure-local-files.js';
