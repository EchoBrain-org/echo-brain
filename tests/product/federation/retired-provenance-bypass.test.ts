import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../../src/core/index.js";
import type {
  DecisionProcessorAdapter,
  DeliverySurfaceAdapter,
  MeetingSourceAdapter,
} from "../../../src/core/index.js";
import { prepareProductComposition } from "../../../src/product/composition.js";
import { startProductRuntime } from "../../../src/product/runtime.js";
import { DecisionNodeStore } from "../../../src/product/approval/decision-node-store.js";
import type { DecisionNodeFederationCapture } from "../../../src/product/approval/decision-node-store.js";
import { resolveProductStatePaths } from "../../../src/product/paths.js";
import { founderCutoverGuardPath } from "../../../src/product/federation/cutover-fence.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
} from "./fixtures/founder-identity.js";

/**
 * The retirement gate has to hold at the retained *public* seams, not only in
 * the CLI. `prepareProductComposition`, `startProductRuntime`, and
 * `DecisionNodeStore` all still accept caller-supplied identity checks,
 * approval stores, approval captures, and runtime components; every one of
 * those is a way to hand the product a "ready" answer for a state root the
 * retired founder-provenance mode left behind.
 *
 * Each case below supplies the most permissive seam it can and proves the
 * refusal happens *before* that seam is consulted and before anything is
 * written.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function privateState(): string {
  return createPrivateTestState(temporary, "echo-retired-bypass-");
}

/**
 * Leftover identity material under the state root. The observational gate
 * checks presence, never content, so an unsigned placeholder document is
 * exactly as fencing as the signed documents the retired mode left behind.
 */
function withFounderIdentityMaterial(stateDirectory: string): string {
  const manifests = resolveProductStatePaths(stateDirectory).identityManifests;
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, "idm_founder.v1.json"), "{}", { mode: 0o600 });
  return stateDirectory;
}

/**
 * An identity check that answers "ready" to everything it is asked. Every
 * callback logs itself, so a pre-gate consultation cannot go unnoticed.
 */
function permissiveIdentityCheck(calls: string[]) {
  const ready = (name: string) => async () => {
    calls.push(name);
    return { ok: true, detail: "ready" };
  };
  return {
    approvalCaptureReady: ready("approvalCaptureReady"),
    attributionStorageReady: ready("attributionStorageReady"),
    signedOutboxReady: ready("signedOutboxReady"),
    independentCopyReady: ready("independentCopyReady"),
    legacyBoundaryReady: ready("legacyBoundaryReady"),
    credentialResolver: () => {
      calls.push("credentialResolver");
      return "token";
    },
  };
}

/** A capture that accepts and validates everything. */
function permissiveCapture(calls: string[]): DecisionNodeFederationCapture {
  return {
    async captureRequested() {
      calls.push("captureRequested");
      return { federation: { forged: true } };
    },
    async validateRequested() {
      calls.push("validateRequested");
    },
    async capturePublished({ reference }) {
      calls.push("capturePublished");
      return reference;
    },
    async validatePublished() {
      calls.push("validatePublished");
    },
    async captureResolved({ legacyMetadata }) {
      calls.push("captureResolved");
      return legacyMetadata;
    },
    async validateResolved() {
      calls.push("validateResolved");
    },
  };
}

/**
 * A composable profile whose adapters are inert stubs, so a successful cycle
 * proves the gate ran, not that the adapters worked. Each stub records itself,
 * which is how the refusing cycle proves no provider was contacted.
 */
function stubAdapterProfile(stateDirectory: string, calls: string[]) {
  const registry = new AdapterRegistry();
  const validateConfig = () => ({ ok: true, errors: [] });
  const healthCheck = async () => ({
    status: "healthy" as const,
    checked_at: "2026-07-19T23:00:00.000Z",
  });
  const meetingSource: MeetingSourceAdapter = {
    identity: {
      kind: "meeting-source",
      adapter_id: "fixture-meetings",
      instance_id: "primary",
      version: "1.0.0",
    },
    validateConfig,
    healthCheck,
    pull: async () => {
      calls.push("meetingSource.pull");
      return { meetings: [] };
    },
  };
  const decisionProcessor: DecisionProcessorAdapter = {
    identity: {
      kind: "decision-processor",
      adapter_id: "fixture-processor",
      instance_id: "primary",
      version: "1.0.0",
    },
    validateConfig,
    healthCheck,
    extract: async (meeting) => ({
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: decisionProcessor.identity,
      generated_at: "2026-07-19T23:00:00.000Z",
      signals: [],
    }),
  };
  const deliverySurface: DeliverySurfaceAdapter = {
    identity: {
      kind: "delivery-surface",
      adapter_id: "fixture-delivery",
      instance_id: "team",
      version: "1.0.0",
    },
    destination: {
      adapter_id: "fixture-delivery",
      instance_id: "team",
      external_id: "synthetic-team",
    },
    validateConfig,
    healthCheck,
    publish: async (envelope) => ({
      schema_version: 1 as const,
      envelope_id: envelope.id,
      status: "delivered" as const,
      external_id: "synthetic-message",
      recorded_at: "2026-07-19T23:00:00.000Z",
      retryable: false,
    }),
  };
  registry.register(meetingSource);
  registry.register(decisionProcessor);
  registry.register(deliverySurface);
  const base = manualRuntimeConfig(stateDirectory);
  return {
    registry,
    config: {
      ...base,
      meeting_sources: [
        { adapter_id: "fixture-meetings", instance_id: "primary", settings: {} },
      ],
      decision_processor: {
        adapter_id: "fixture-processor",
        instance_id: "primary",
        settings: {},
      },
      delivery_surfaces: [
        { adapter_id: "fixture-delivery", instance_id: "team", settings: {} },
      ],
    },
  };
}

describe("retired founder provenance cannot be revived through a public seam", () => {
  it("refuses prepareProductComposition before the classifier, identity check, or approval store runs", async () => {
    const stateDir = withFounderIdentityMaterial(privateState());
    const calls: string[] = [];
    const captureCalls: string[] = [];
    let classified = false;
    const approvals = new DecisionNodeStore(join(stateDir, "unused-approvals"));

    await expect(
      prepareProductComposition(
        manualRuntimeConfig(stateDir),
        new AdapterRegistry(),
        {
          classifyStateFilesystem: async () => {
            classified = true;
            return { kind: "local", raw: "apfs" };
          },
          identityCheck: permissiveIdentityCheck(calls),
          approvalFederationCapture: permissiveCapture(captureCalls),
          approvals,
          accessGate: {
            async assertAuthorized() {
              calls.push("accessGate");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "identity_not_operationally_ready" });

    expect(classified).toBe(false);
    expect(calls).toEqual([]);
    expect(captureCalls).toEqual([]);
    // Nothing was created inside the fenced state root.
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
    expect(existsSync(resolveProductStatePaths(stateDir).database)).toBe(false);
  });

  it("refuses startProductRuntime before components or adapters are resolved", async () => {
    const stateDir = withFounderIdentityMaterial(privateState());
    const calls: string[] = [];
    let classified = false;

    const result = await startProductRuntime(manualRuntimeConfig(stateDir), {
      adapterRegistry: new AdapterRegistry(),
      classifyStateFilesystem: async () => {
        classified = true;
        return { kind: "local", raw: "apfs" };
      },
      identityCheck: permissiveIdentityCheck(calls),
      components: [
        {
          name: "must-not-start",
          dependsOn: [],
          start: async () => {
            calls.push("componentStart");
            return { stop: async () => undefined };
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(
      "identity_not_operationally_ready",
    );
    expect(result.ok === false && result.error.message).toMatch(/is retired/);
    expect(classified).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a guard-only state path replaced by a symlink, at both public seams", async () => {
    // The fenced path is deleted and replaced by a symlink to a clean
    // directory. The adjacent cutover guard cannot be derived from an
    // uncanonicalizable root, so the preflight must refuse on its own rather
    // than defer to a later validator -- `startProductRuntime` has none.
    const stateDir = privateState();
    writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });
    const decoy = join(stateDir, "..", "decoy-clean-root");
    mkdirSync(decoy, { mode: 0o700 });
    rmSync(stateDir, { recursive: true, force: true });
    symlinkSync(decoy, stateDir, "dir");

    const calls: string[] = [];
    let classified = false;
    const result = await startProductRuntime(manualRuntimeConfig(stateDir), {
      adapterRegistry: new AdapterRegistry(),
      classifyStateFilesystem: async () => {
        classified = true;
        return { kind: "local", raw: "apfs" };
      },
      identityCheck: permissiveIdentityCheck(calls),
      components: [
        {
          name: "must-not-start",
          dependsOn: [],
          start: async () => {
            calls.push("componentStart");
            return { stop: async () => undefined };
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(
      "identity_not_operationally_ready",
    );
    expect(result.ok === false && result.error.message).toMatch(
      /cannot be inspected/,
    );
    expect(classified).toBe(false);
    expect(calls).toEqual([]);

    let compositionClassified = false;
    await expect(
      prepareProductComposition(
        manualRuntimeConfig(stateDir),
        new AdapterRegistry(),
        {
          classifyStateFilesystem: async () => {
            compositionClassified = true;
            return { kind: "local", raw: "apfs" };
          },
          identityCheck: permissiveIdentityCheck(calls),
        },
      ),
    ).rejects.toMatchObject({ code: "identity_not_operationally_ready" });
    expect(compositionClassified).toBe(false);
    expect(calls).toEqual([]);
    // The decoy target was never opened.
    expect(readdirSync(decoy)).toEqual([]);
  });

  it("re-checks the fence on every cycle, not only at construction", async () => {
    const stateDir = privateState();
    const calls: string[] = [];
    const captureCalls: string[] = [];
    const { registry, config } = stubAdapterProfile(stateDir, calls);
    const composition = await prepareProductComposition(config, registry, {
      classifyStateFilesystem: async () => ({ kind: "local", raw: "apfs" }),
      identityCheck: permissiveIdentityCheck(calls),
      approvalFederationCapture: permissiveCapture(captureCalls),
      accessGate: {
        async assertAuthorized() {
          calls.push("accessGate");
        },
      },
    });
    try {
      // Built on a clean root, so the first cycle is allowed through.
      await composition.runOnce();
      expect(calls).toContain("accessGate");

      // The adjacent external cutover guard appears underneath the live
      // composition. This writes the guard file directly rather than through
      // `commitFounderCutoverGuard`, because what the next cycle must react to
      // is the file's presence, whoever produced it. The next cycle must refuse
      // before the access gate.
      calls.length = 0;
      captureCalls.length = 0;
      writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });

      await expect(composition.runOnce()).rejects.toMatchObject({
        code: "identity_not_operationally_ready",
      });
      expect(calls).toEqual([]);
      expect(captureCalls).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("refuses a fresh DecisionNodeStore initialize before a permissive capture runs or anything is written", async () => {
    // The single fresh-store sentinel. The populated-store read/mutation
    // matrix lives in tests/product/decision-node-store.test.ts.
    const stateDir = withFounderIdentityMaterial(privateState());
    const captureCalls: string[] = [];
    const store = new DecisionNodeStore(stateDir, {
      federationCapture: permissiveCapture(captureCalls),
    });

    await expect(store.initialize()).rejects.toThrow(/is retired/);

    expect(captureCalls).toEqual([]);
    // initialize() is refused before it creates the decision directories.
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
  });

});
