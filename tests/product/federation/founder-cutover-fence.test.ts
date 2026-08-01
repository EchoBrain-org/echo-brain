import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProductCli } from "../../../src/product/cli.js";
import { resolveProductStatePaths } from "../../../src/product/paths.js";
import { canonicalJson } from "../../../src/product/federation/foundation/canonical-json.js";
import { AdapterRegistry } from "../../../src/core/index.js";
import { prepareProductComposition } from "../../../src/product/composition.js";
import {
  assertFounderProvenanceRetired,
  FounderProvenanceInspectionError,
  founderCutoverGuardPath,
  inspectFounderCutoverFence,
  inspectFounderProvenanceResidue,
  readFounderCutoverGuard,
  requiresFounderFederation,
} from "../../../src/product/federation/cutover-fence.js";
import { checkFounderIdentity } from "../../../src/product/federation/bootstrap/identity-check.js";
import { FounderBootstrapSessionStore } from "../../../src/product/federation/bootstrap/bootstrap-session-store.js";
import { signedFounderBootstrapSession } from "./fixtures/founder-bootstrap-session.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
} from "./fixtures/founder-identity.js";

/**
 * The founder-provenance product surface is retired: no supported command or
 * runtime path creates founder identity or cutover material, though the
 * low-level bootstrap/guard/session APIs still compile, which is how these
 * tests build the residue. What must survive is the detector and the refusal:
 * this file pins the observational inspector itself -- what counts as residue,
 * that inspection never mutates, that its failures surface as typed refusals --
 * and that identity-check reports the retired mode instead of hiding it. The
 * decision store's own refusal is pinned at its layer, in
 * retired-provenance-bypass.test.ts (fresh store) and
 * tests/product/decision-node-store.test.ts (populated store).
 *
 * These cases moved here from the deleted bootstrap-ceremony suite and build
 * the same fenced state roots directly, from the retained primitives.
 */

const temporary: string[] = [];
const GUARD_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-founder-cutover-fence-");
}

/** The external guard survives loss of `<state>/identity` by design. */
function writeCutoverGuard(
  stateDirectory: string,
  overrides: Record<string, unknown> = {},
): string {
  const path = founderCutoverGuardPath(stateDirectory);
  const durable = readFounderCutoverGuard(stateDirectory);
  writeFileSync(
    path,
    canonicalJson({
      schema_version: 1,
      kind: "echo-founder-cutover-guard",
      // Only this state path's own digest is accepted; borrow it from the
      // production reader rather than recomputing it in the test.
      state_path_sha256:
        durable?.state_path_sha256 ?? guardStatePathDigest(stateDirectory),
      session_id: GUARD_SESSION_ID,
      plan_sha256: `sha256:${"a".repeat(64)}`,
      installation_key_id: `sha256:${"b".repeat(64)}`,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}

/**
 * `founderCutoverGuardPath` embeds the state-path digest in the filename, so
 * the accepted value can be read back off the path the production code picks.
 */
function guardStatePathDigest(stateDirectory: string): `sha256:${string}` {
  const filename = founderCutoverGuardPath(stateDirectory).split("/").at(-1)!;
  return `sha256:${filename.slice(
    ".echo-founder-cutover.".length,
    ".echo-founder-cutover.".length + 64,
  )}`;
}

function writeIdentityMaterial(stateDirectory: string): void {
  const manifests = resolveProductStatePaths(stateDirectory).identityManifests;
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, "interrupted-bootstrap.json"), "{}", {
    mode: 0o600,
  });
}

function writeRuntimeConfig(stateDirectory: string): string {
  const configPath = join(stateDirectory, "runtime.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(manualRuntimeConfig(stateDirectory))}\n`,
    { mode: 0o600 },
  );
  return configPath;
}

function cliStreams() {
  let stdout = "";
  let stderr = "";
  return {
    dependencies: {
      classifyStateFilesystem: async () => ({
        kind: "local" as const,
        raw: "apfs",
      }),
      stdout: {
        write: (value: string | Uint8Array) => (
          (stdout += value.toString()), true
        ),
      },
      stderr: {
        write: (value: string | Uint8Array) => (
          (stderr += value.toString()), true
        ),
      },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe("founder seed cutover fence", () => {
  it("keeps a pristine state root in rehearsal mode", () => {
    const stateDir = privateState();
    expect(inspectFounderCutoverFence(stateDir)).toEqual({
      state: "none",
      session: null,
    });
    expect(readFounderCutoverGuard(stateDir)).toBeNull();
    expect(requiresFounderFederation(stateDir)).toBe(false);
  });

  it("stays fenced on the external guard alone, without identity or sessions", async () => {
    const stateDir = privateState();
    writeCutoverGuard(stateDir);
    expect(inspectFounderCutoverFence(stateDir).state).toBe("none");
    expect(requiresFounderFederation(stateDir)).toBe(true);

    const report = await checkFounderIdentity(stateDir);
    expect(report).toMatchObject({
      mode: "identity_enabled",
      foundation_ok: false,
      operational_ready: false,
      seed_grade_ready: false,
    });
    expect(
      report.checks.find((item) => item.id === "active-bundle"),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("irreversible founder cutover"),
    });
  });

  it("stays fenced on leftover identity material without a pointer", async () => {
    const stateDir = privateState();
    writeIdentityMaterial(stateDir);
    expect(requiresFounderFederation(stateDir)).toBe(true);
    expect(await checkFounderIdentity(stateDir)).toMatchObject({
      mode: "identity_enabled",
      foundation_ok: false,
      operational_ready: false,
    });
  });

  it("refuses a guard written for another state path", () => {
    const stateDir = privateState();
    writeCutoverGuard(stateDir, {
      state_path_sha256: `sha256:${"c".repeat(64)}`,
    });
    expect(() => readFounderCutoverGuard(stateDir)).toThrow(
      /belongs to another state path/,
    );
    expect(() => requiresFounderFederation(stateDir)).toThrow(
      /belongs to another state path/,
    );
  });

  it("fails closed on a malformed guard or bootstrap receipt", () => {
    const guardState = privateState();
    writeFileSync(founderCutoverGuardPath(guardState), "{}", { mode: 0o600 });
    expect(() => requiresFounderFederation(guardState)).toThrow(
      /invalid shape/,
    );

    const sessionState = privateState();
    const sessions = join(
      resolveProductStatePaths(sessionState).bootstrapRoot,
      "founder-identity",
    );
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sessions, "session.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.v1.json"),
      "{}",
      { mode: 0o600 },
    );
    expect(() => inspectFounderCutoverFence(sessionState)).toThrow();
    expect(() => requiresFounderFederation(sessionState)).toThrow();
  });

  it("refuses a recoverable interrupted write without performing its rename", async () => {
    const stateDir = privateState();
    const sessions = resolveProductStatePaths(stateDir).founderIdentityBootstrap;
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    // A *valid* signed revision-1 session in a temporary file with no canonical
    // file beside it. This is exactly the state the session store recovers by
    // renaming, so the fixture proves the preflight declines a real mutation
    // rather than merely failing to parse rubbish.
    const built = await signedFounderBootstrapSession({ phase: "complete" });
    const temporary = join(
      sessions,
      `session.${built.session.session_id}.v1.json.1.` +
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp",
    );
    const bytes = canonicalJson(built.session);
    writeFileSync(temporary, bytes, { mode: 0o600 });

    const residue = inspectFounderProvenanceResidue(stateDir);
    expect(residue.present).toBe(true);
    expect(residue.findings.join(" ")).toMatch(/bootstrap session material/);
    expect(() => assertFounderProvenanceRetired(stateDir)).toThrow(/is retired/);

    // Untouched: same single entry, same bytes, no canonical file created.
    expect(readdirSync(sessions)).toEqual([basename(temporary)]);
    expect(readFileSync(temporary, "utf8")).toBe(bytes);

    // The store's own recovering reader does perform the rename, which is what
    // makes the preceding assertions meaningful.
    new FounderBootstrapSessionStore(stateDir).list();
    expect(readdirSync(sessions)).toEqual([
      `session.${built.session.session_id}.v1.json`,
    ]);
  });

  it("refuses a redundant interrupted write without performing its unlink", async () => {
    const stateDir = privateState();
    const built = await signedFounderBootstrapSession({ phase: "complete" });
    const store = new FounderBootstrapSessionStore(stateDir);
    store.write(built.session);
    const sessions = resolveProductStatePaths(stateDir).founderIdentityBootstrap;
    // A temporary write at the same revision with identical bytes: the store
    // recovers this one by unlinking it.
    const temporary = join(
      sessions,
      `session.${built.session.session_id}.v1.json.1.` +
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp",
    );
    writeFileSync(temporary, canonicalJson(built.session), { mode: 0o600 });
    const before = readdirSync(sessions).sort();

    expect(() => assertFounderProvenanceRetired(stateDir)).toThrow(/is retired/);
    expect(readdirSync(sessions).sort()).toEqual(before);

    store.list();
    expect(readdirSync(sessions)).toEqual([
      `session.${built.session.session_id}.v1.json`,
    ]);
  });

  it("refuses an uninspectable state path instead of leaking a raw fs error", async () => {
    // A regular file where the state root should be: inspectable, but never
    // clean, and not founder material either.
    const parent = privateState();
    const fileRoot = join(parent, "state-is-a-file");
    writeFileSync(fileRoot, "not a state root", { mode: 0o600 });
    const fileResidue = inspectFounderProvenanceResidue(fileRoot);
    expect(fileResidue).toMatchObject({ present: true, uninspectable: true });
    expect(fileResidue.findings.join(" ")).toMatch(/state path is a file/);

    // ENOTDIR: `lstat` itself throws rather than reporting "absent", because a
    // path component is a regular file. The gate must convert that into its own
    // typed refusal.
    const throughFile = join(fileRoot, "state");
    const throwingResidue = inspectFounderProvenanceResidue(throughFile);
    expect(throwingResidue).toMatchObject({
      present: true,
      uninspectable: true,
    });
    expect(throwingResidue.findings.join(" ")).toMatch(/could not be inspected/);

    for (const path of [fileRoot, throughFile]) {
      let failure: unknown;
      try {
        assertFounderProvenanceRetired(path);
      } catch (error) {
        failure = error;
      }
      expect(failure, path).toBeInstanceOf(FounderProvenanceInspectionError);
      expect((failure as Error).message, path).toMatch(/cannot be inspected/);
    }

    // And the typed ProductRuntimeFailure mapping is preserved at the public
    // composition seam rather than a raw ENOTDIR escaping.
    await expect(
      prepareProductComposition(
        manualRuntimeConfig(throughFile),
        new AdapterRegistry(),
        {
          classifyStateFilesystem: async () => {
            throw new Error("classifier must not run");
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "ProductRuntimeFailure",
      code: "identity_not_operationally_ready",
    });
  });

  it("treats a symlinked or unexpected identity entry as residue", () => {
    const linkState = privateState();
    const identityRoot = resolveProductStatePaths(linkState).identityRoot;
    mkdirSync(join(identityRoot, "manifests"), {
      recursive: true,
      mode: 0o700,
    });
    symlinkSync("/etc", join(identityRoot, "registries"), "dir");
    const residue = inspectFounderProvenanceResidue(linkState);
    expect(residue.present).toBe(true);
    expect(residue.findings.join(" ")).toMatch(/not a plain directory/);

    const strayState = privateState();
    const strayRoot = resolveProductStatePaths(strayState).identityRoot;
    mkdirSync(strayRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(strayRoot, "unexpected.json"), "{}", { mode: 0o600 });
    expect(
      inspectFounderProvenanceResidue(strayState).findings.join(" "),
    ).toMatch(/identity material exists/);
  });

  it("keeps a pristine or empty-scaffold state root out of the way", () => {
    const stateDir = privateState();
    const paths = resolveProductStatePaths(stateDir);
    // Empty preparation directories are harmless: bootstrap never started.
    mkdirSync(paths.founderIdentityBootstrap, { recursive: true, mode: 0o700 });
    for (const name of ["manifests", "registries", "policies"]) {
      mkdirSync(join(paths.identityRoot, name), {
        recursive: true,
        mode: 0o700,
      });
    }
    expect(inspectFounderProvenanceResidue(stateDir)).toEqual({
      present: false,
      uninspectable: false,
      findings: [],
    });
    expect(() => assertFounderProvenanceRetired(stateDir)).not.toThrow();
  });

  it("still reports the retired mode through identity-check instead of hiding it", async () => {
    const stateDir = privateState();
    writeCutoverGuard(stateDir);
    const configPath = writeRuntimeConfig(stateDir);
    const streams = cliStreams();
    expect(
      await runProductCli(
        ["identity-check", "--config", configPath],
        streams.dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(streams.err())).toMatchObject({
      ok: false,
      mode: "identity_enabled",
      operational_ready: false,
      unsupported_mode: expect.stringContaining("is retired"),
    });
  });
});
