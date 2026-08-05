import { ActiveIdentityBundleStore } from './identity/active-identity-bundle-store.js';
import type { VerifiedActiveIdentityBundle } from './identity/active-identity-bundle-store.js';
import {
  FounderBootstrapSessionStore,
  validateFounderBootstrapSession,
  type FounderBootstrapSessionV1,
} from './bootstrap/bootstrap-session-store.js';
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
} from './foundation/canonical-json.js';
import { signedPayload } from './foundation/signed-document.js';

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
  assertPrivateOwnedRegularFile(path, 0o600, () => {
    fail('external cutover guard must be a private current-user file');
  });
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

export const RETIRED_FOUNDER_PROVENANCE_MESSAGE =
  'this state root holds founder identity or cutover material; the ' +
  'founder-provenance mode that produced it is retired. No product-work ' +
  'command, runtime start, or new processing cycle can resume on this ' +
  'profile. Diagnosis, preservation, and quiescing stay available: ' +
  'identity-check, validate-config, status, backup, restore, and ' +
  'service stop/status/uninstall. The cutover is irreversible and a backup ' +
  'stays bound to the state path it came from, so no restore crosses this ' +
  'fence. To move forward, in this order: `echo-brain service stop` (backup ' +
  'refuses while the service is loaded), `echo-brain backup`, then ' +
  '`echo-brain bootstrap` onto a new founder-residue-free config and state ' +
  'path with the administrator-issued invitation and the Authority PIN from ' +
  'an independent trusted channel; that one command provisions the ' +
  'credentials, initializes, and enrolls the new installation.';

export interface FounderProvenanceResidue {
  present: boolean;
  /** True when the state path itself could not be inspected at all. */
  uninspectable: boolean;
  findings: readonly string[];
}

/** Common base so every caller can catch one type and fail closed. */
export class FounderProvenanceGateError extends Error {
  constructor(
    message: string,
    readonly findings: readonly string[],
  ) {
    super(message);
    this.name = 'FounderProvenanceGateError';
  }
}

export class RetiredFounderProvenanceError extends FounderProvenanceGateError {
  readonly code = 'retired_founder_provenance';

  constructor(findings: readonly string[]) {
    super(
      `${RETIRED_FOUNDER_PROVENANCE_MESSAGE} [${findings.join('; ')}]`,
      findings,
    );
    this.name = 'RetiredFounderProvenanceError';
  }
}

/**
 * The state path cannot be inspected for founder residue, so nothing may
 * assume it is clean. Distinct from `RetiredFounderProvenanceError` because
 * claiming founder material exists would be a false statement about the root.
 */
export class FounderProvenanceInspectionError extends FounderProvenanceGateError {
  readonly code = 'founder_provenance_uninspectable';

  constructor(findings: readonly string[]) {
    super(
      'product state path cannot be inspected for retired founder-provenance ' +
        `material, so it is refused rather than assumed clean [${findings.join('; ')}]`,
      findings,
    );
    this.name = 'FounderProvenanceInspectionError';
  }
}

type LocalEntryKind = 'absent' | 'symlink' | 'directory' | 'file' | 'other';

const IDENTITY_SUBDIRECTORIES = new Set(['manifests', 'registries', 'policies']);

function entryKind(path: string): LocalEntryKind {
  const state = lstatSync(path, { throwIfNoEntry: false });
  if (state === undefined) return 'absent';
  if (state.isSymbolicLink()) return 'symlink';
  if (state.isDirectory()) return 'directory';
  if (state.isFile()) return 'file';
  return 'other';
}

function inspectBootstrapSessionResidue(directory: string): string[] {
  const kind = entryKind(directory);
  if (kind === 'absent') return [];
  if (kind !== 'directory') {
    return [`founder bootstrap session location is a ${kind}: ${directory}`];
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    return [
      `founder bootstrap session location is unreadable: ${(error as Error).message}`,
    ];
  }
  if (entries.length === 0) return [];
  // Any entry counts, including an interrupted `.tmp` write. Recovering it is
  // exactly what this preflight must not do.
  return [
    `founder bootstrap session material exists under ${directory} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`,
  ];
}

function inspectIdentityResidue(identityRoot: string): string[] {
  const rootKind = entryKind(identityRoot);
  if (rootKind === 'absent') return [];
  if (rootKind !== 'directory') {
    return [`identity location is a ${rootKind}: ${identityRoot}`];
  }
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(identityRoot, { withFileTypes: true });
  } catch (error) {
    return [`identity location is unreadable: ${(error as Error).message}`];
  }
  const findings: string[] = [];
  for (const entry of entries) {
    const child = join(identityRoot, entry.name);
    if (!IDENTITY_SUBDIRECTORIES.has(entry.name)) {
      // The active pointer and every staged or unexpected entry land here.
      findings.push(`identity material exists at ${child}`);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      findings.push(`identity subdirectory is not a plain directory: ${child}`);
      continue;
    }
    let documents: readonly string[];
    try {
      documents = readdirSync(child);
    } catch (error) {
      findings.push(
        `identity subdirectory is unreadable: ${(error as Error).message}`,
      );
      continue;
    }
    if (documents.length > 0) {
      findings.push(`signed identity documents exist under ${child}`);
    }
  }
  return findings;
}

/**
 * Observational-only preflight for retired founder-provenance material.
 *
 * Deliberately does NOT use `inspectFounderCutoverFence`,
 * `requiresFounderFederation`, or `FounderBootstrapSessionStore`: those
 * recover interrupted writes by rename/unlink and parse/validate documents, so
 * running them here would mutate forensic founder state before the product had
 * decided to refuse it. This reads presence and entry type only, and treats an
 * unexpected entry, a symlink, or its own inspection failure as residue.
 *
 * Validated, recovering inspection stays available to the backup guard, the
 * identity check, and legacy diagnostics, which need the parsed receipt.
 */
export function inspectFounderProvenanceResidue(
  stateDirectory: string,
): FounderProvenanceResidue {
  const findings: string[] = [];
  const uninspectable: string[] = [];
  let root = stateDirectory;
  let rootKind: LocalEntryKind;
  // `lstat` itself can fail (EACCES on the parent, EIO, ELOOP, a path that is
  // not a valid string for this platform). That must surface as a typed
  // inspection refusal, not as a raw filesystem error escaping the gate.
  try {
    root = resolve(stateDirectory);
    rootKind = entryKind(root);
  } catch (error) {
    return {
      present: true,
      uninspectable: true,
      findings: [
        `product state path could not be inspected: ${(error as Error).message}`,
      ],
    };
  }
  // A root that is a symlink or a non-directory cannot be canonicalized, so the
  // adjacent guard filename cannot be derived from it and nothing below can be
  // trusted. That is not founder residue, but it is never "clean" either: no
  // caller may proceed on it, and no caller may rely on some later validator.
  if (rootKind !== 'absent' && rootKind !== 'directory') {
    uninspectable.push(`product state path is a ${rootKind}: ${root}`);
  } else {
    try {
      // The external guard lives beside the state root and outlives its
      // deletion, so it is checked even when the root itself is gone.
      const guardPath = founderCutoverGuardPath(stateDirectory);
      const kind = entryKind(guardPath);
      if (kind !== 'absent') {
        findings.push(`external founder cutover guard exists at ${guardPath}`);
      }
    } catch (error) {
      uninspectable.push(
        `external founder cutover guard could not be inspected: ${(error as Error).message}`,
      );
    }
  }
  try {
    const paths = resolveProductStatePaths(stateDirectory);
    findings.push(
      ...inspectBootstrapSessionResidue(paths.founderIdentityBootstrap),
    );
    findings.push(...inspectIdentityResidue(paths.identityRoot));
  } catch (error) {
    uninspectable.push(
      `founder identity state could not be inspected: ${(error as Error).message}`,
    );
  }
  return {
    present: findings.length > 0 || uninspectable.length > 0,
    uninspectable: uninspectable.length > 0,
    findings: [...findings, ...uninspectable],
  };
}

/**
 * The one shared retirement gate for *product work*.
 *
 * Every entry point that starts the runtime, begins a processing cycle, or
 * otherwise creates directories, resolves adapters, resolves
 * credentials, contacts a provider or the organization Authority, reads or
 * mutates approvals, or invokes a caller-supplied callback calls this first, so
 * a custom identity check, approval capture, or approval store cannot resume
 * the retired mode.
 *
 * It is deliberately NOT called by the diagnosis, preservation, and quiescing
 * commands, which must stay usable on a fenced profile: `identity-check`,
 * `validate-config`, general `status`, `backup`, `restore`, and
 * `service stop`/`status`/`uninstall`. Several of those write; the distinction
 * is product work, not writes. `src/product/cli.ts` owns the exact dispatch
 * policy.
 *
 * This is a fail-closed gate on trusted in-process callers, not a sandbox: an
 * caller-supplied implementation that reaches past the documented seams and
 * touches the state root directly is outside what this can prevent.
 */
export function assertFounderProvenanceRetired(stateDirectory: string): void {
  const residue = inspectFounderProvenanceResidue(stateDirectory);
  if (!residue.present) return;
  // An uninspectable path is refused on its own terms rather than described as
  // founder material, but it is refused just as hard.
  throw residue.uninspectable
    ? new FounderProvenanceInspectionError(residue.findings)
    : new RetiredFounderProvenanceError(residue.findings);
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
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicCreate } from '../../infrastructure/filesystem/atomic-create.js';
import {
  assertOwnerControlledDirectory,
  assertPrivateOwnedRegularFile,
  canonicalLocalPath,
  pathEntryExists,
  readFileNoFollow,
} from '../secure-local-files.js';
import { resolveProductStatePaths } from '../paths.js';
