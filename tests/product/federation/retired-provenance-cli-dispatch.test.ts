import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../../src/core/index.js";
import { runProductCli } from "../../../src/product/cli.js";
import type { ProductCliDependencies } from "../../../src/product/cli.js";
import { resolveProductStatePaths } from "../../../src/product/paths.js";
import { founderCutoverGuardPath } from "../../../src/product/federation/cutover-fence.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
} from "./fixtures/founder-identity.js";

/**
 * Ordering, not just outcome.
 *
 * Every CLI branch that the early dispatch policy gates is driven here against
 * a fenced state root with every injectable seam instrumented. A branch passes
 * only if it refuses *and* touched none of them, and only if the state root and
 * its adjacent paths are byte-for-byte identical afterwards -- so a `mkdir`,
 * `chmod`, SQLite file, decision node, or lock artifact cannot hide inside an
 * already-present mode-0700 fixture directory.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface TouchLog {
  calls: string[];
  dependencies: ProductCliDependencies;
  out: () => string;
  err: () => string;
}

/**
 * Every injectable seam records its own name. None of them may fire on a
 * gated branch: the classifier, lifecycle-lock acquisition, operator
 * filesystem, credential resolvers, adapter factories, the top-level and
 * composition-level identity callbacks, approval capture/gate, the
 * caller-owned state and approval stores, the custom runtime (classifier,
 * components, deadline runner, identity callbacks), and signal handlers.
 */
function instrumented(): TouchLog {
  const calls: string[] = [];
  let stdout = "";
  let stderr = "";
  const record =
    <T>(name: string, value: T) =>
    (): T => {
      calls.push(name);
      return value;
    };
  const trap = (name: string): never => {
    calls.push(name);
    throw new Error(`seam ${name} must not run on a fenced state root`);
  };
  const ready = (name: string) => async () => {
    calls.push(name);
    return { ok: true, detail: "ready" };
  };
  return {
    calls,
    out: () => stdout,
    err: () => stderr,
    dependencies: {
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
      classifyStateFilesystem: async () => {
        calls.push("classifyStateFilesystem");
        return { kind: "local" as const, raw: "apfs" };
      },
      acquireLifecycleLock: async () => {
        calls.push("acquireLifecycleLock");
        return async () => undefined;
      },
      adapterFactories: new Proxy(
        {},
        {
          get: () => trap("adapterFactories"),
        },
      ) as never,
      process: {
        once: record("process.once", undefined),
        removeListener: record("process.removeListener", undefined),
      },
      now: () => {
        calls.push("now");
        return "2026-07-19T23:00:00.000Z";
      },
      // Every identity readiness callback, so no permissive "ready" answer is
      // invisible to this test.
      identityCheck: {
        credentialResolver: () => {
          calls.push("identityCheck.credentialResolver");
          return "token";
        },
        approvalCaptureReady: ready("identityCheck.approvalCaptureReady"),
        attributionStorageReady: ready(
          "identityCheck.attributionStorageReady",
        ),
        signedOutboxReady: ready("identityCheck.signedOutboxReady"),
        independentCopyReady: ready("identityCheck.independentCopyReady"),
        legacyBoundaryReady: ready("identityCheck.legacyBoundaryReady"),
      },
      operator: {
        fileSystem: new Proxy(
          {},
          { get: (_target, key) => trap(`operator.fileSystem.${String(key)}`) },
        ) as never,
        launchctl: new Proxy(
          {},
          { get: () => trap("operator.launchctl") },
        ) as never,
        resolveCredential: () => {
          calls.push("operator.resolveCredential");
          return "token";
        },
      },
      organization: {
        fetch: (async () => trap("organization.fetch")) as never,
        installationSigner: new Proxy(
          {},
          { get: () => trap("organization.installationSigner") },
        ) as never,
        createInstallationId: () => {
          calls.push("organization.createInstallationId");
          return "ins_forged";
        },
      },
      // The complete custom-composition surface: a permissive capture, an
      // auto-approving gate, a caller-owned state store and approval store, a
      // composition-scoped identity check, and the clock/id/teardown seams.
      composition: {
        approvalFederationCapture: new Proxy(
          {},
          { get: () => trap("composition.approvalFederationCapture") },
        ) as never,
        state: new Proxy(
          {},
          { get: () => trap("composition.state") },
        ) as never,
        approvals: new Proxy(
          {},
          { get: () => trap("composition.approvals") },
        ) as never,
        identityCheck: {
          credentialResolver: () => {
            calls.push("composition.identityCheck.credentialResolver");
            return "token";
          },
          approvalCaptureReady: ready(
            "composition.identityCheck.approvalCaptureReady",
          ),
          attributionStorageReady: ready(
            "composition.identityCheck.attributionStorageReady",
          ),
          signedOutboxReady: ready(
            "composition.identityCheck.signedOutboxReady",
          ),
          independentCopyReady: ready(
            "composition.identityCheck.independentCopyReady",
          ),
          legacyBoundaryReady: ready(
            "composition.identityCheck.legacyBoundaryReady",
          ),
        },
        approvalGate: {
          review: async (request) => {
            calls.push("composition.approvalGate.review");
            return {
              status: "approved" as const,
              reviewed_at: "2026-07-19T23:00:00.000Z",
              reviewed_by: "forged",
              reason: null,
              approved_brief: request.brief,
            };
          },
        },
        accessGate: {
          assertAuthorized: async () => {
            calls.push("composition.accessGate");
          },
        },
        now: () => {
          calls.push("composition.now");
          return "2026-07-19T23:00:00.000Z";
        },
        createId: () => {
          calls.push("composition.createId");
          return "forged-id";
        },
        closeResources: () => {
          calls.push("composition.closeResources");
        },
      },
      // Custom runtime wiring: with this present the `run` branch would take
      // the startProductRuntime path, so its classifier, components, deadline
      // runner, and identity callbacks must all stay untouched behind the gate.
      runtime: {
        classifyStateFilesystem: async () => {
          calls.push("runtime.classifyStateFilesystem");
          return { kind: "local" as const, raw: "apfs" };
        },
        adapterRegistry: new AdapterRegistry(),
        components: [
          {
            name: "instrumented-component",
            dependsOn: [],
            start: async () => trap("runtime.componentStart"),
          },
        ],
        withDeadline: (() => trap("runtime.withDeadline")) as never,
        identityCheck: {
          credentialResolver: () => {
            calls.push("runtime.identityCheck.credentialResolver");
            return "token";
          },
          approvalCaptureReady: ready(
            "runtime.identityCheck.approvalCaptureReady",
          ),
          attributionStorageReady: ready(
            "runtime.identityCheck.attributionStorageReady",
          ),
          signedOutboxReady: ready("runtime.identityCheck.signedOutboxReady"),
          independentCopyReady: ready(
            "runtime.identityCheck.independentCopyReady",
          ),
          legacyBoundaryReady: ready("runtime.identityCheck.legacyBoundaryReady"),
        },
      },
    },
  };
}

/**
 * Every path under the state root and its parent, recorded strongly enough to
 * detect any mutation these branches could make: file contents by SHA-256 (so a
 * same-size rewrite is caught), symlink targets, mode, and mtime/ctime (so a
 * chmod, a touch, or a create-then-restore is caught). Deterministic: the test
 * performs no writes between the two snapshots.
 */
function snapshot(stateDirectory: string): string[] {
  const parent = dirname(stateDirectory);
  const walk = (root: string, prefix: string): string[] => {
    const state = lstatSync(root, { throwIfNoEntry: false });
    if (state === undefined) return [`${prefix}: absent`];
    const stamp =
      `mode=${(state.mode & 0o777).toString(8)}` +
      ` mtime=${state.mtimeMs} ctime=${state.ctimeMs}`;
    if (state.isSymbolicLink()) {
      return [`${prefix}: link -> ${readlinkSync(root)} ${stamp}`];
    }
    if (state.isFile()) {
      const digest = createHash("sha256").update(readFileSync(root)).digest("hex");
      return [`${prefix}: file ${stamp} size=${state.size} sha256=${digest}`];
    }
    if (!state.isDirectory()) return [`${prefix}: other ${stamp}`];
    return [
      `${prefix}: dir ${stamp}`,
      ...readdirSync(root)
        .sort()
        .flatMap((entry) => walk(join(root, entry), `${prefix}/${entry}`)),
    ];
  };
  return readdirSync(parent)
    .sort()
    .flatMap((entry) =>
      walk(join(parent, entry), relative(parent, join(parent, entry))),
    );
}

/**
 * A fenced state root: leftover identity material under `identity/manifests`.
 * The observational gate checks presence, never content, so an unsigned
 * placeholder document fences exactly like the signed ones the retired mode
 * left behind; the guard-only variant is exercised by the onboard case below.
 * The runtime config lives outside `state_dir`, which the operator requires.
 */
function fencedProfile(): { stateDir: string; configPath: string } {
  const stateDir = createPrivateTestState(temporary, "echo-cli-dispatch-");
  const manifests = resolveProductStatePaths(stateDir).identityManifests;
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, "idm_founder.v1.json"), "{}", { mode: 0o600 });
  chmodSync(manifests, 0o700);
  const configPath = join(stateDir, "..", "runtime.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(manualRuntimeConfig(stateDir))}\n`,
    { mode: 0o600 },
  );
  return { stateDir, configPath };
}

const APPROVAL_ID = "a".repeat(64);

/** Every gated dispatch branch, by the argv it is reached through. */
const GATED: readonly (readonly [string, (configPath: string) => string[]])[] =
  [
    ["init", (c) => ["init", "--config", c]],
    ["reconfigure", (c) => ["reconfigure", "--config", c]],
    ["doctor", (c) => ["doctor", "--config", c]],
    ["organization enroll", (c) => [
      "organization",
      "enroll",
      "--config",
      c,
      "--invitation",
      "/tmp/echo-absent-invitation.json",
      "--authority-pin",
      `sha256:${"1".repeat(64)}`,
      "--allow-exportable-software-key",
    ]],
    ["organization status", (c) => ["organization", "status", "--config", c]],
    ["organization refresh", (c) => ["organization", "refresh", "--config", c]],
    ["organization rebind", (c) => [
      "organization",
      "rebind",
      "--config",
      c,
      "--authority-url",
      "https://authority.invalid",
      "--authority-pin",
      `sha256:${"1".repeat(64)}`,
    ]],
    ["organization slack-link-begin", (c) => [
      "organization",
      "slack-link-begin",
      "--config",
      c,
    ]],
    ["organization slack-link-complete", (c) => [
      "organization",
      "slack-link-complete",
      "--config",
      c,
      "--challenge-attempt",
      "cat_11111111-1111-4111-8111-111111111111",
      "--challenge-message-ts",
      "1752966000.000001",
    ]],
    ["approvals", (c) => ["approvals", "--config", c]],
    ["approve", (c) => [
      "approve",
      "--config",
      c,
      "--id",
      APPROVAL_ID,
      "--reviewer",
      "founder",
    ]],
    ["reject", (c) => [
      "reject",
      "--config",
      c,
      "--id",
      APPROVAL_ID,
      "--reviewer",
      "founder",
    ]],
    ["run-once", (c) => ["run-once", "--config", c]],
    ["run", (c) => ["run", "--config", c]],
    ["service-run", (c) => ["service-run", "--config", c]],
    ["service install", (c) => ["service", "install", "--config", c]],
    ["service start", (c) => ["service", "start", "--config", c]],
    ["service restart", (c) => ["service", "restart", "--config", c]],
  ];

interface ExceptionCase {
  argv: string[];
  /** Positive proof that dispatch passed the gate and reached this branch. */
  expectReached: (output: string, calls: readonly string[]) => void;
}

function lastJson(output: string): Record<string, unknown> {
  const lines = output.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

/**
 * Every declared state-path exception, each with a branch-specific downstream
 * sentinel. Some reach a real structured result; some reach the deliberately
 * injected operator-filesystem sentinel, which is equally good proof that
 * dispatch let the branch through. Help/version never touch a state path.
 */
const EXCEPTIONS: readonly (readonly [
  string,
  (configPath: string, stateDir: string) => ExceptionCase,
])[] = [
  [
    "validate-config",
    (c) => ({
      argv: ["validate-config", "--config", c],
      expectReached: (output, calls) => {
        expect(calls).toContain("classifyStateFilesystem");
        expect(lastJson(output)).toMatchObject({
          ok: true,
          command: "validate-config",
          maturity: "DEV",
          adapters_loaded: false,
        });
      },
    }),
  ],
  [
    "selftest",
    (c) => ({
      argv: ["selftest", "--config", c],
      expectReached: (output, calls) => {
        expect(calls).toContain("classifyStateFilesystem");
        // The in-memory SQLite selftest is downstream of dispatch and unique
        // to this branch.
        expect(lastJson(output)).toMatchObject({
          ok: true,
          command: "selftest",
          storage: {
            status: "ok",
            kind: "product-state-sqlite-memory",
            migrations: "loaded",
          },
        });
      },
    }),
  ],
  [
    "status",
    (c) => ({
      argv: ["status", "--config", c],
      expectReached: (output, calls) => {
        expect(calls).toContain("operator.fileSystem.lstat");
        expect(lastJson(output)).toMatchObject({
          command: "status",
          code: "invalid_operator_path",
        });
      },
    }),
  ],
  [
    "identity-check",
    (c) => ({
      argv: ["identity-check", "--config", c],
      expectReached: (output) => {
        // The full identity report is computed and returned: the retirement is
        // reported here, not refused at dispatch.
        expect(lastJson(output)).toMatchObject({
          command: "identity-check",
          kind: "echo-founder-identity-check",
          mode: "identity_enabled",
          operational_ready: false,
        });
      },
    }),
  ],
  [
    "backup",
    (c, stateDir) => ({
      argv: [
        "backup",
        "--config",
        c,
        "--backup-root",
        join(stateDir, "..", "backups"),
      ],
      expectReached: (output, calls) => {
        expect(calls).toContain("classifyStateFilesystem");
        expect(calls).toContain("operator.fileSystem.lstat");
        expect(lastJson(output)).toMatchObject({ command: "backup" });
      },
    }),
  ],
  [
    "restore",
    (c, stateDir) => ({
      argv: [
        "restore",
        "--config",
        c,
        "--backup",
        join(stateDir, "..", "backups", "some-backup"),
        "--backup-root",
        join(stateDir, "..", "backups"),
        "--id",
        "restore-1",
      ],
      expectReached: (output, calls) => {
        expect(calls).toContain("classifyStateFilesystem");
        expect(calls).toContain("operator.fileSystem.lstat");
        expect(lastJson(output)).toMatchObject({ command: "restore" });
      },
    }),
  ],
  ...(["stop", "status", "uninstall"] as const).map(
    (action) =>
      [
        `service ${action}`,
        (c: string) => ({
          argv: ["service", action, "--config", c],
          expectReached: (output: string, calls: readonly string[]) => {
            expect(calls).toContain("operator.fileSystem.lstat");
            expect(lastJson(output)).toMatchObject({
              command: "service",
              code: "invalid_operator_path",
            });
          },
        }),
      ] as const,
  ),
];

describe("retired-provenance CLI dispatch gate", () => {
  it.each(GATED)(
    "refuses %s before any injected seam or state change",
    async (_label, argv) => {
      const { stateDir, configPath } = fencedProfile();
      const before = snapshot(stateDir);
      const log = instrumented();

      const code = await runProductCli(argv(configPath), log.dependencies);

      expect(code).toBe(1);
      expect(log.err()).toMatch(/is retired/);
      expect(log.out()).toBe("");
      expect(log.calls).toEqual([]);
      expect(snapshot(stateDir)).toEqual(before);
    },
  );

  it("refuses onboard into a path whose adjacent cutover guard survived", async () => {
    // The state root itself is gone; only the adjacent guard remains. Onboard
    // takes its path from --state-dir, before any config exists, so this is the
    // one gated command whose target legitimately does not exist yet.
    const { stateDir, configPath } = fencedProfile();
    const parent = join(stateDir, "..");
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configPath, { force: true });
    writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });

    const before = snapshot(stateDir);
    const log = instrumented();
    const code = await runProductCli(
      [
        "onboard",
        "--config",
        join(parent, "onboarded.json"),
        "--state-dir",
        stateDir,
      ],
      log.dependencies,
    );

    expect(code).toBe(1);
    expect(log.err()).toMatch(/retired|cannot be inspected/);
    expect(log.calls).toEqual([]);
    // Onboard created neither the state root nor the config it was asked for.
    expect(lstatSync(stateDir, { throwIfNoEntry: false })).toBeUndefined();
    expect(snapshot(stateDir)).toEqual(before);
  });

  it.each(EXCEPTIONS)(
    "lets %s past the gate and reach its own downstream work",
    async (_label, build) => {
      const { stateDir, configPath } = fencedProfile();
      const log = instrumented();
      const argv = build(configPath, stateDir);

      await runProductCli(argv.argv, log.dependencies);

      // Positive proof: a branch-specific sentinel downstream of dispatch was
      // reached. Asserting only that the retirement message is absent would be
      // self-fulfilling, so each row names something that had to happen.
      argv.expectReached(`${log.out()}${log.err()}`, log.calls);
    },
  );
});
