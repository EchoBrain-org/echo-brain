import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalLocalPath, sha256Bytes } from './secure-local-files.js';
import { resolveProductStatePaths } from './paths.js';

/**
 * The retired founder-provenance fence.
 *
 * The product-local founder federation that once wrote identity documents,
 * bootstrap sessions, and the external cutover guard is deleted. Profiles it
 * left behind are preservation-only: their residue is detected by presence and
 * entry type alone and refused for all product work. Nothing here parses,
 * validates, recovers, or otherwise touches that material.
 */

export const RETIRED_FOUNDER_PROVENANCE_MESSAGE =
  'this state root holds founder identity or cutover material; the ' +
  'founder-provenance mode that produced it is retired. No product-work ' +
  'command, runtime start, or new processing cycle can resume on this ' +
  'profile. Inspection and quiescing stay available: validate-config, status, ' +
  'and service stop/status/uninstall. To move forward, run `echo-brain service ' +
  'stop`, preserve the fenced profile with a reviewed out-of-band procedure ' +
  'that does not mutate or reinterpret it, run `echo-brain service uninstall` ' +
  'with the old config to remove its LaunchAgent, then run `echo-brain ' +
  'bootstrap` onto a new founder-residue-free config and state path with the ' +
  'administrator-issued invitation and the Authority PIN from an independent ' +
  'trusted channel; that one command provisions the credentials, initializes, ' +
  'and enrolls the new installation.';

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

/**
 * The retired ceremony wrote its external guard beside the state root, named
 * by the digest of the canonical state path, so the guard outlives deletion of
 * the root itself. The derivation is frozen: guards already on disk must keep
 * being found.
 */
export function founderCutoverGuardPath(stateDirectory: string): string {
  const canonicalState = canonicalLocalPath(
    stateDirectory,
    'state directory',
    false,
  );
  return join(
    dirname(canonicalState),
    `.echo-founder-cutover.${sha256Bytes(`${canonicalState}\n`)}.v1.json`,
  );
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
 * This reads presence and entry type only -- `lstat`/`readdir`, never file
 * content -- and treats an unexpected entry, a symlink, or its own inspection
 * failure as residue, so refusing can never mutate the forensic founder state
 * it refuses. The retired mode's parsing and recovering readers are deleted;
 * there is no validated inspection to fall back to.
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
    // Already fail-closed on the root itself. Nothing below it is inspected:
    // descending would traverse the symlink (or non-directory) and could
    // derive findings from whatever it points at, which is neither this
    // root's material nor safe to touch.
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
 * an injected approval store or callback cannot resume the retired mode.
 *
 * It is deliberately NOT called by the inspection and quiescing commands,
 * which must stay usable on a fenced profile: `validate-config`, general
 * `status`, and `service stop`/`status`/`uninstall`. The service operations may
 * write; the distinction is product work, not writes. `src/product/cli.ts`
 * owns the exact dispatch policy. Preservation is an external reviewed
 * procedure, not a product command.
 *
 * This is a fail-closed gate on trusted in-process callers, not a sandbox: a
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
