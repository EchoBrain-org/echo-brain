import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProductStatePaths } from "../../src/product/paths.js";
import {
  FounderProvenanceGateError,
  FounderProvenanceInspectionError,
  RetiredFounderProvenanceError,
  assertFounderProvenanceRetired,
  founderCutoverGuardPath,
  inspectFounderProvenanceResidue,
} from "../../src/product/retired-founder-provenance.js";
import { createPrivateTestState } from "./fixtures/retired-provenance.js";

/**
 * The residue matrix for the presence-only retirement detector.
 *
 * The founder-provenance mode and every reader that could parse, validate, or
 * recover its state are deleted. What survives is this detector and its
 * refusal, so these tests pin what counts as residue, that inspection never
 * mutates anything, and that inspection failures surface as typed refusals
 * rather than raw filesystem errors. Residue is always placeholder bytes at
 * the frozen state-layout paths: the detector reads presence and entry type
 * only, so a placeholder fences exactly like the signed documents the retired
 * mode left behind.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-retired-residue-");
}

describe("retired founder-provenance residue matrix", () => {
  it("keeps a pristine or empty-scaffold state root clean", () => {
    const pristine = privateState();
    expect(inspectFounderProvenanceResidue(pristine)).toEqual({
      present: false,
      uninspectable: false,
      findings: [],
    });
    expect(() => assertFounderProvenanceRetired(pristine)).not.toThrow();

    // Empty preparation directories are harmless: bootstrap never started.
    const scaffold = privateState();
    const paths = resolveProductStatePaths(scaffold);
    mkdirSync(paths.founderIdentityBootstrap, { recursive: true, mode: 0o700 });
    for (const name of ["manifests", "registries", "policies"]) {
      mkdirSync(join(paths.identityRoot, name), {
        recursive: true,
        mode: 0o700,
      });
    }
    expect(inspectFounderProvenanceResidue(scaffold)).toEqual({
      present: false,
      uninspectable: false,
      findings: [],
    });
    expect(() => assertFounderProvenanceRetired(scaffold)).not.toThrow();
  });

  it("detects the adjacent external guard alone through its frozen derivation", () => {
    const stateDir = privateState();
    // The derivation is frozen so guards already on disk keep being found:
    // detection must round-trip through the same path production.
    const guardPath = founderCutoverGuardPath(stateDir);
    expect(basename(guardPath)).toMatch(
      /^\.echo-founder-cutover\.[0-9a-f]{64}\.v1\.json$/,
    );
    writeFileSync(guardPath, "{}", { mode: 0o600 });

    const residue = inspectFounderProvenanceResidue(stateDir);
    expect(residue.present).toBe(true);
    expect(residue.uninspectable).toBe(false);
    expect(residue.findings.join(" ")).toMatch(
      /external founder cutover guard exists/,
    );

    // The guard survives deletion of the state root and still fences the path.
    rmSync(stateDir, { recursive: true, force: true });
    expect(inspectFounderProvenanceResidue(stateDir).present).toBe(true);
  });

  it("detects identity documents, the active pointer, and stray identity entries", () => {
    const documentState = privateState();
    const manifests = join(
      resolveProductStatePaths(documentState).identityRoot,
      "manifests",
    );
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    writeFileSync(join(manifests, "idm_founder.v1.json"), "{}", {
      mode: 0o600,
    });
    expect(
      inspectFounderProvenanceResidue(documentState).findings.join(" "),
    ).toMatch(/signed identity documents exist/);

    const pointerState = privateState();
    const pointerRoot = resolveProductStatePaths(pointerState).identityRoot;
    mkdirSync(pointerRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(pointerRoot, "active-identity-bundle.v1.json"), "{}", {
      mode: 0o600,
    });
    expect(
      inspectFounderProvenanceResidue(pointerState).findings.join(" "),
    ).toMatch(/identity material exists/);

    const strayState = privateState();
    const strayRoot = resolveProductStatePaths(strayState).identityRoot;
    mkdirSync(strayRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(strayRoot, "unexpected.json"), "{}", { mode: 0o600 });
    expect(
      inspectFounderProvenanceResidue(strayState).findings.join(" "),
    ).toMatch(/identity material exists/);
  });

  it("treats a symlinked identity subdirectory as residue without following it", () => {
    const stateDir = privateState();
    const identityRoot = resolveProductStatePaths(stateDir).identityRoot;
    mkdirSync(join(identityRoot, "manifests"), {
      recursive: true,
      mode: 0o700,
    });
    symlinkSync("/etc", join(identityRoot, "registries"), "dir");
    const residue = inspectFounderProvenanceResidue(stateDir);
    expect(residue.present).toBe(true);
    expect(residue.findings.join(" ")).toMatch(/not a plain directory/);
  });

  it("detects bootstrap session entries, including an interrupted .tmp, without touching them", () => {
    const stateDir = privateState();
    const sessions = resolveProductStatePaths(stateDir).founderIdentityBootstrap;
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    // An interrupted temporary write is exactly the entry the deleted session
    // store used to recover by rename. Any entry counts, and recovering it is
    // exactly what the detector must not do.
    const interrupted = join(
      sessions,
      "session.123e4567-e89b-42d3-a456-426614174000.v1.json.1." +
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp",
    );
    const bytes = '{"phase":"committing","never":"parsed"}';
    writeFileSync(interrupted, bytes, { mode: 0o600 });

    const residue = inspectFounderProvenanceResidue(stateDir);
    expect(residue.present).toBe(true);
    expect(residue.findings.join(" ")).toMatch(/bootstrap session material/);
    expect(() => assertFounderProvenanceRetired(stateDir)).toThrow(
      /is retired/,
    );

    // Untouched: same single entry, same bytes, nothing renamed or created.
    expect(readdirSync(sessions)).toEqual([basename(interrupted)]);
    expect(readFileSync(interrupted, "utf8")).toBe(bytes);
  });

  it("treats a non-directory bootstrap location as residue", () => {
    const stateDir = privateState();
    const paths = resolveProductStatePaths(stateDir);
    mkdirSync(join(stateDir, "bootstrap"), { recursive: true, mode: 0o700 });
    writeFileSync(paths.founderIdentityBootstrap, "not a directory", {
      mode: 0o600,
    });
    expect(
      inspectFounderProvenanceResidue(stateDir).findings.join(" "),
    ).toMatch(/founder bootstrap session location is a file/);
  });

  it("fails closed on an unreadable identity directory", () => {
    const stateDir = privateState();
    const identityRoot = resolveProductStatePaths(stateDir).identityRoot;
    mkdirSync(identityRoot, { recursive: true, mode: 0o700 });
    chmodSync(identityRoot, 0o000);
    try {
      const residue = inspectFounderProvenanceResidue(stateDir);
      expect(residue.present).toBe(true);
      expect(residue.findings.join(" ")).toMatch(/identity location is unreadable/);
      expect(() => assertFounderProvenanceRetired(stateDir)).toThrow(
        FounderProvenanceGateError,
      );
    } finally {
      chmodSync(identityRoot, 0o700);
    }
  });

  it("refuses an uninspectable state path with a typed error, not a raw fs error", () => {
    // A regular file where the state root should be: inspectable, but never
    // clean, and not founder material either.
    const parent = privateState();
    const fileRoot = join(parent, "state-is-a-file");
    writeFileSync(fileRoot, "not a state root", { mode: 0o600 });
    const fileResidue = inspectFounderProvenanceResidue(fileRoot);
    expect(fileResidue).toMatchObject({ present: true, uninspectable: true });
    expect(fileResidue.findings.join(" ")).toMatch(/state path is a file/);

    // ENOTDIR: `lstat` itself throws because a path component is a regular
    // file. That must surface as the typed inspection refusal.
    const throughFile = join(fileRoot, "state");
    const throwingResidue = inspectFounderProvenanceResidue(throughFile);
    expect(throwingResidue).toMatchObject({
      present: true,
      uninspectable: true,
    });
    expect(throwingResidue.findings.join(" ")).toMatch(
      /could not be inspected/,
    );

    for (const path of [fileRoot, throughFile]) {
      let failure: unknown;
      try {
        assertFounderProvenanceRetired(path);
      } catch (error) {
        failure = error;
      }
      expect(failure, path).toBeInstanceOf(FounderProvenanceInspectionError);
      expect(failure, path).toBeInstanceOf(FounderProvenanceGateError);
      expect((failure as Error).message, path).toMatch(/cannot be inspected/);
    }
  });

  it("refuses a symlinked state root without deriving findings from its target", () => {
    // The fenced path is replaced by a symlink to a directory that itself
    // holds identity-like sentinel material. The refusal must come from the
    // root's own entry kind alone: descending through the symlink would
    // attribute the target's contents to this root and touch material that
    // is not its own.
    const stateDir = privateState();
    writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });
    const decoy = join(stateDir, "..", "decoy-target-root");
    const decoyManifests = join(decoy, "identity", "manifests");
    mkdirSync(decoyManifests, { recursive: true, mode: 0o700 });
    const sentinel = join(decoyManifests, "idm_target.v1.json");
    writeFileSync(sentinel, "{}", { mode: 0o600 });
    const decoySessions = join(decoy, "bootstrap", "founder-identity");
    mkdirSync(decoySessions, { recursive: true, mode: 0o700 });
    writeFileSync(join(decoySessions, "session.target.v1.json.1.tmp"), "{}", {
      mode: 0o600,
    });
    rmSync(stateDir, { recursive: true, force: true });
    symlinkSync(decoy, stateDir, "dir");

    const residue = inspectFounderProvenanceResidue(stateDir);
    expect(residue).toMatchObject({ present: true, uninspectable: true });
    // Exactly one finding, about the root itself. Nothing derived from the
    // symlink target may appear in the report.
    expect(residue.findings).toHaveLength(1);
    expect(residue.findings[0]).toMatch(/product state path is a symlink/);
    expect(residue.findings.join(" ")).not.toMatch(
      /identity material|signed identity documents|bootstrap session/,
    );
    expect(residue.findings.join(" ")).not.toContain(decoy);
    // The target's sentinel material is untouched.
    expect(readFileSync(sentinel, "utf8")).toBe("{}");
  });

  it("throws the runbook-bearing retirement refusal and preserves its findings", () => {
    const stateDir = privateState();
    const manifests = join(
      resolveProductStatePaths(stateDir).identityRoot,
      "manifests",
    );
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const residueFile = join(manifests, "idm_founder.v1.json");
    writeFileSync(residueFile, "{}", { mode: 0o600 });
    const before = lstatSync(residueFile).mtimeMs;

    let failure: unknown;
    try {
      assertFounderProvenanceRetired(stateDir);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RetiredFounderProvenanceError);
    expect(failure).toBeInstanceOf(FounderProvenanceGateError);
    const retired = failure as RetiredFounderProvenanceError;
    expect(retired.code).toBe("retired_founder_provenance");
    expect(retired.message).toMatch(/is retired/);
    // The runbook: quiesce, preserve, then fresh central bootstrap.
    expect(retired.message).toMatch(/echo-brain service stop/);
    expect(retired.message).toMatch(/echo-brain backup/);
    expect(retired.message).toMatch(/echo-brain bootstrap/);
    expect(retired.findings.join(" ")).toMatch(/signed identity documents/);
    expect(lstatSync(residueFile).mtimeMs).toBe(before);
  });
});
