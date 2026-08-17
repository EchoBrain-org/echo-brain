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
import { AdapterRegistry } from "@echo-brain/organization-authority/processing/core/index.js";
import type {
  DecisionProcessorAdapter,
  DeliverySurfaceAdapter,
  MeetingSourceAdapter,
} from "@echo-brain/organization-authority/processing/core/index.js";
import { prepareProductComposition } from "../../src/product/composition.js";
import { DecisionNodeStore } from "../../src/product/approval/decision-node-store.js";
import { resolveProductStatePaths } from "../../src/product/paths.js";
import { founderCutoverGuardPath } from "../../src/product/retired-founder-provenance.js";
import {
  createPrivateTestState,
  manualRuntimeConfig,
} from "./fixtures/retired-provenance.js";

/**
 * The retirement gate has to hold at the retained *public* seams, not only in
 * the CLI. `prepareProductComposition` and `DecisionNodeStore` still accept
 * caller-supplied approval and state stores, which must not bypass the retired
 * founder-provenance refusal.
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
  const manifests = join(
    resolveProductStatePaths(stateDirectory).identityRoot,
    "manifests",
  );
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, "idm_founder.v1.json"), "{}", { mode: 0o600 });
  return stateDirectory;
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
  it("refuses prepareProductComposition before the classifier or approval store runs", async () => {
    const stateDir = withFounderIdentityMaterial(privateState());
    const calls: string[] = [];
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
          approvals,
          accessGate: {
            async assertAuthorized() {
              calls.push("accessGate");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "retired_founder_provenance" });

    expect(classified).toBe(false);
    expect(calls).toEqual([]);
    // Nothing was created inside the fenced state root.
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
    expect(existsSync(resolveProductStatePaths(stateDir).database)).toBe(false);
  });

  it("re-checks residue created during classification before access or adapters", async () => {
    const stateDir = privateState();
    const calls: string[] = [];

    await expect(
      prepareProductComposition(
        manualRuntimeConfig(stateDir),
        new AdapterRegistry(),
        {
          classifyStateFilesystem: async () => {
            calls.push("classifier");
            withFounderIdentityMaterial(stateDir);
            return { kind: "local", raw: "apfs" };
          },
          accessGate: {
            async assertAuthorized() {
              calls.push("accessGate");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "retired_founder_provenance" });

    expect(calls).toEqual(["classifier"]);
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
    expect(existsSync(resolveProductStatePaths(stateDir).database)).toBe(false);
  });

  it("refuses a guard-only state path replaced by a symlink", async () => {
    // The fenced path is deleted and replaced by a symlink to a clean
    // directory. The adjacent cutover guard cannot be derived from an
    // uncanonicalizable root, so the preflight must refuse on its own rather
    // than defer to a later validator.
    const stateDir = privateState();
    writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });
    const decoy = join(stateDir, "..", "decoy-clean-root");
    mkdirSync(decoy, { mode: 0o700 });
    rmSync(stateDir, { recursive: true, force: true });
    symlinkSync(decoy, stateDir, "dir");

    const calls: string[] = [];
    let classified = false;
    await expect(
      prepareProductComposition(
        manualRuntimeConfig(stateDir),
        new AdapterRegistry(),
        {
          classifyStateFilesystem: async () => {
            classified = true;
            return { kind: "local", raw: "apfs" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "retired_founder_provenance",
      message: expect.stringMatching(/cannot be inspected/),
    });
    expect(classified).toBe(false);
    expect(calls).toEqual([]);
    // The decoy target was never opened.
    expect(readdirSync(decoy)).toEqual([]);
  });

  it("re-checks the fence on every cycle, not only at construction", async () => {
    const stateDir = privateState();
    const calls: string[] = [];
    const { registry, config } = stubAdapterProfile(stateDir, calls);
    const composition = await prepareProductComposition(config, registry, {
      classifyStateFilesystem: async () => ({ kind: "local", raw: "apfs" }),
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
      // composition. This writes the guard file directly, because what the
      // next cycle must react to is the file's presence, whoever produced it.
      // The next cycle must refuse before the access gate.
      calls.length = 0;
      writeFileSync(founderCutoverGuardPath(stateDir), "{}", { mode: 0o600 });

      await expect(composition.runOnce()).rejects.toMatchObject({
        code: "retired_founder_provenance",
      });
      expect(calls).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("refuses a fresh DecisionNodeStore initialize before anything is written", async () => {
    // The single fresh-store sentinel. The populated-store read/mutation
    // matrix lives in tests/product/decision-node-store.test.ts.
    const stateDir = withFounderIdentityMaterial(privateState());
    const store = new DecisionNodeStore(stateDir);

    await expect(store.initialize()).rejects.toThrow(/is retired/);

    // initialize() is refused before it creates the decision directories.
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
  });

});
