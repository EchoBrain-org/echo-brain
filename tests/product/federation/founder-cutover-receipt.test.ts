import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalProductConfigSha256 } from "../../../src/product/lifecycle-lock.js";
import {
  createProductStateBackup,
  restoreProductStateBackup,
} from "../../../src/product/state-backup.js";
import {
  assertFounderCutoverGuardMatchesSession,
  founderCutoverGuardPath,
  inspectFounderCutoverFence,
  readFounderCutoverGuard,
  requiresFounderFederation,
} from "../../../src/product/federation/cutover-fence.js";
import { FounderBootstrapSessionStore } from "../../../src/product/federation/bootstrap/bootstrap-session-store.js";
import { resolveProductStatePaths } from "../../../src/product/paths.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
} from "./fixtures/founder-identity.js";
import {
  founderBootstrapSessionPath,
  signedFounderBootstrapSession,
  writeFencedFounderState,
} from "./fixtures/founder-bootstrap-session.js";

/**
 * Positive coverage for the retained *validating* inspection path.
 *
 * The observational preflight in `assertFounderProvenanceRetired` deliberately
 * never parses a receipt, so it cannot pin most of this. The backup downgrade
 * guard and the identity check still do parse one, and that is what keeps a
 * pre-cutover backup from silently replacing an irreversible cutover. For a
 * guardless root with only reversible residue -- identity material or a
 * precommit session -- the downgrade guard falls back to the observational
 * inspector so a clean same-path backup cannot erase the residue either.
 *
 * These build genuinely valid signed sessions rather than restoring the
 * retired ceremony.
 */

const temporary: string[] = [];
const OTHER_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-cutover-receipt-");
}

function backupRootFor(stateDirectory: string): string {
  return join(dirname(stateDirectory), "backups");
}

function configSha(stateDirectory: string): string {
  return canonicalProductConfigSha256(manualRuntimeConfig(stateDirectory));
}

describe("valid signed bootstrap receipts", () => {
  it("detects a committing receipt and keeps the profile fenced", async () => {
    const stateDir = privateState();
    const built = await writeFencedFounderState(stateDir, {
      phase: "committing",
    });

    const fence = inspectFounderCutoverFence(stateDir);
    expect(fence.state).toBe("committing");
    expect(fence.session?.session_id).toBe(built.session.session_id);
    expect(requiresFounderFederation(stateDir)).toBe(true);

    const guard = readFounderCutoverGuard(stateDir);
    expect(guard).not.toBeNull();
    expect(() =>
      assertFounderCutoverGuardMatchesSession(guard!, built.session),
    ).not.toThrow();
  });

  it("detects a complete receipt and stays fenced with no external guard", async () => {
    const stateDir = privateState();
    const built = await writeFencedFounderState(stateDir, {
      phase: "complete",
      withGuard: false,
    });

    expect(readFounderCutoverGuard(stateDir)).toBeNull();
    expect(inspectFounderCutoverFence(stateDir).state).toBe("complete");
    // The guardless path: the irreversible receipt alone keeps it fenced.
    expect(requiresFounderFederation(stateDir)).toBe(true);
    expect(built.session.result).not.toBeNull();
  });

  it("rejects a guard that names a different session", async () => {
    const stateDir = privateState();
    const built = await writeFencedFounderState(stateDir, {
      phase: "complete",
    });
    const other = await signedFounderBootstrapSession({
      phase: "complete",
      sessionId: OTHER_SESSION_ID,
      signer: built.signer,
      signingKey: built.signingKey,
    });

    expect(() =>
      assertFounderCutoverGuardMatchesSession(
        readFounderCutoverGuard(stateDir)!,
        other.session,
      ),
    ).toThrow(/does not match the bootstrap receipt/);
  });

  it("fails closed when a stored receipt becomes malformed", async () => {
    const stateDir = privateState();
    const built = await writeFencedFounderState(stateDir, {
      phase: "complete",
    });
    writeFileSync(
      founderBootstrapSessionPath(stateDir, built.session.session_id),
      "{}",
      { mode: 0o600 },
    );

    expect(() => inspectFounderCutoverFence(stateDir)).toThrow();
    expect(() => requiresFounderFederation(stateDir)).toThrow();
  });
});

describe("backup downgrade protection over a valid receipt", () => {
  it("accepts a restore whose backup carries the identical cutover", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    await writeFencedFounderState(stateDir, { phase: "complete" });
    const sentinel = join(stateDir, "recovery-sentinel.txt");
    writeFileSync(sentinel, "trusted\n", { mode: 0o600 });

    const matching = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "matching-cutover",
      createdAt: "2026-07-19T23:01:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });
    writeFileSync(sentinel, "mutated\n", { mode: 0o600 });

    await restoreProductStateBackup({
      stateDir,
      backupDirectory: matching.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: "restore-matching-cutover",
      restoredAt: "2026-07-19T23:03:00.000Z",
      preRestoreBackupId: "pre-restore-matching-cutover",
      preRestoreBackupCreatedAt: "2026-07-19T23:02:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });

    expect(readFileSync(sentinel, "utf8")).toBe("trusted\n");
    expect(inspectFounderCutoverFence(stateDir).state).toBe("complete");
  });

  it("accepts an identical-cutover restore through the guardless comparison", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    await writeFencedFounderState(stateDir, { phase: "complete" });
    const sentinel = join(stateDir, "recovery-sentinel.txt");
    writeFileSync(sentinel, "trusted\n", { mode: 0o600 });

    const matching = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "guardless-matching-cutover",
      createdAt: "2026-07-19T23:01:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });
    writeFileSync(sentinel, "mutated\n", { mode: 0o600 });
    // Without the adjacent guard the backup guard falls back to comparing the
    // stored receipts directly; an identical cutover must still be accepted.
    rmSync(founderCutoverGuardPath(stateDir));

    await restoreProductStateBackup({
      stateDir,
      backupDirectory: matching.backupDirectory,
      automaticBackupRoot: backupRoot,
      operationId: "restore-guardless-matching-cutover",
      restoredAt: "2026-07-19T23:03:00.000Z",
      preRestoreBackupId: "pre-restore-guardless-matching-cutover",
      preRestoreBackupCreatedAt: "2026-07-19T23:02:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });

    expect(readFileSync(sentinel, "utf8")).toBe("trusted\n");
    expect(inspectFounderCutoverFence(stateDir).state).toBe("complete");
  });

  it("rejects a pre-cutover restore even when the external guard is gone", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    const preCutover = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "pre-cutover",
      createdAt: "2026-07-19T22:58:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });

    const built = await writeFencedFounderState(stateDir, {
      phase: "complete",
    });
    // Deleting the adjacent guard must not reopen the downgrade: the stored
    // irreversible receipt alone still has to reject a pre-cutover backup.
    rmSync(founderCutoverGuardPath(stateDir));
    expect(readFounderCutoverGuard(stateDir)).toBeNull();

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: preCutover.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-missing-guard-downgrade",
        restoredAt: "2026-07-19T23:05:00.000Z",
        preRestoreBackupId: "must-not-create-missing-guard-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:04:00.000Z",
        canonicalConfigSha256: configSha(stateDir),
      }),
    ).rejects.toThrow(/irreversible founder identity cutover/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(built.session.session_id)
        .phase,
    ).toBe("complete");
    // The refusal promises no safety backup was taken.
    expect(
      existsSync(join(backupRoot, "must-not-create-missing-guard-pre-backup")),
    ).toBe(false);
  });

  it("rejects a restore whose backup carries a different cutover session", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    const first = await writeFencedFounderState(stateDir, {
      phase: "complete",
    });

    // A backup of this same state path, taken while session A was current.
    const sessionA = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "cutover-session-a",
      createdAt: "2026-07-19T23:01:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });

    // The live root now carries a different irreversible session, and the
    // adjacent guard is gone, so only the stored receipts can catch it.
    rmSync(founderBootstrapSessionPath(stateDir, first.session.session_id));
    const second = await signedFounderBootstrapSession({
      phase: "complete",
      sessionId: OTHER_SESSION_ID,
      signer: first.signer,
      signingKey: first.signingKey,
    });
    new FounderBootstrapSessionStore(stateDir).write(second.session);
    rmSync(founderCutoverGuardPath(stateDir));
    expect(readFounderCutoverGuard(stateDir)).toBeNull();

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: sessionA.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-mismatched-cutover",
        restoredAt: "2026-07-19T23:07:00.000Z",
        preRestoreBackupId: "must-not-create-mismatched-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:06:00.000Z",
        canonicalConfigSha256: configSha(stateDir),
      }),
    ).rejects.toThrow(/irreversible founder identity cutover/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(second.session.session_id)
        .session_id,
    ).toBe(OTHER_SESSION_ID);
    expect(
      existsSync(join(backupRoot, "must-not-create-mismatched-pre-backup")),
    ).toBe(false);
  });

  it("rejects a clean same-path restore over identity-only residue", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    const clean = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "clean-before-identity-residue",
      createdAt: "2026-07-19T22:58:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });
    // Identity material with no session and no guard: fence state 'none', yet
    // still retired founder-provenance residue the restore must not erase.
    const manifests = resolveProductStatePaths(stateDir).identityManifests;
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const residue = join(manifests, "idm_founder.v1.json");
    writeFileSync(residue, "{}", { mode: 0o600 });
    expect(inspectFounderCutoverFence(stateDir).state).toBe("none");
    // A guard-named sibling of the backup directory makes the *backup* look
    // fenced to the observational inspector, but restore never copies it. It
    // must not launder the clean payload past the refusal.
    writeFileSync(founderCutoverGuardPath(clean.backupDirectory), "{}", {
      mode: 0o600,
    });

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: clean.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-identity-residue-erasure",
        restoredAt: "2026-07-19T23:05:00.000Z",
        preRestoreBackupId: "must-not-create-identity-residue-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:04:00.000Z",
        canonicalConfigSha256: configSha(stateDir),
      }),
    ).rejects.toThrow(/erase retired founder-provenance material/);
    expect(existsSync(residue)).toBe(true);
    expect(
      existsSync(
        join(backupRoot, "must-not-create-identity-residue-pre-backup"),
      ),
    ).toBe(false);
  });

  it("rejects a clean same-path restore over a valid precommit session", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    const clean = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "clean-before-precommit",
      createdAt: "2026-07-19T22:58:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });
    const built = await writeFencedFounderState(stateDir, {
      phase: "ready_for_confirmation",
      withGuard: false,
    });
    expect(readFounderCutoverGuard(stateDir)).toBeNull();
    expect(inspectFounderCutoverFence(stateDir).state).toBe("precommit");

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: clean.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-precommit-erasure",
        restoredAt: "2026-07-19T23:05:00.000Z",
        preRestoreBackupId: "must-not-create-precommit-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:04:00.000Z",
        canonicalConfigSha256: configSha(stateDir),
      }),
    ).rejects.toThrow(/erase retired founder-provenance material/);
    expect(
      new FounderBootstrapSessionStore(stateDir).read(built.session.session_id)
        .phase,
    ).toBe("ready_for_confirmation");
    expect(
      existsSync(join(backupRoot, "must-not-create-precommit-pre-backup")),
    ).toBe(false);
  });

  it("rejects a restore when the live receipt is malformed", async () => {
    const stateDir = privateState();
    const backupRoot = backupRootFor(stateDir);
    const preCutover = await createProductStateBackup({
      stateDir,
      backupRoot,
      backupId: "pre-cutover-malformed",
      createdAt: "2026-07-19T22:58:00.000Z",
      canonicalConfigSha256: configSha(stateDir),
    });
    const built = await writeFencedFounderState(stateDir, {
      phase: "complete",
    });
    rmSync(founderCutoverGuardPath(stateDir));
    writeFileSync(
      founderBootstrapSessionPath(stateDir, built.session.session_id),
      "{}",
      { mode: 0o600 },
    );

    await expect(
      restoreProductStateBackup({
        stateDir,
        backupDirectory: preCutover.backupDirectory,
        automaticBackupRoot: backupRoot,
        operationId: "reject-malformed-cutover",
        restoredAt: "2026-07-19T23:09:00.000Z",
        preRestoreBackupId: "must-not-create-malformed-pre-backup",
        preRestoreBackupCreatedAt: "2026-07-19T23:08:00.000Z",
        canonicalConfigSha256: configSha(stateDir),
      }),
    ).rejects.toThrow(/bootstrap session|canonical|shape|signature/i);
    expect(
      existsSync(join(backupRoot, "must-not-create-malformed-pre-backup")),
    ).toBe(false);
  });
});
