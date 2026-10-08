import { readFileSync, writeFileSync } from "node:fs";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { replay, SCENARIOS, type Scenario } from "./fixtures/agentic-scenarios.js";

/**
 * Replay equivalence for the research split (research loop evaluation v1).
 * Scripted model replies and a pinned clock drive Ask end to end. The b108
 * fixture retains its output-level semantic control; the Granola Phase 2
 * fixture is an immutable historical full-fingerprint control. The separate
 * quality baseline pins current prompt, model-input and audit fingerprints.
 */
const HISTORICAL_FIXTURE = new URL("./agentic-ask-golden.v1.json", import.meta.url);
const HISTORICAL_FIXTURE_SHA256 = "sha256:8aff56ec626c367b738acb98217c406e2be46ef255279ac6331227b3bcf0f417";
/**
 * Full replay baseline captured from the clean Granola Phase 2 head
 * 5d5a4bdaee997eb3f15fcb16e88b6e174dc06c11. It carries the expanded source catalog,
 * so a research-loop refactor cannot silently remove or rewrite it.
 */
const GRANOLA_PHASE2_FIXTURE = new URL("./agentic-ask-granola-phase2.v1.json", import.meta.url);
/** Current quality behavior is a separately reviewed baseline, never a rewrite of Phase 2. */
const QUALITY_FIXTURE = new URL("./agentic-ask-quality-baseline.v1.json", import.meta.url);
const GRANOLA_PHASE2_HISTORICAL_SHA256 = "sha256:74eb19f50284fd33ca09c5cc030531dc97c02f84816af4d2e07434de0fe8db93";

async function run(name: string, scenario: Scenario) {
  const { response, inputs, audit } = await replay(name, scenario);
  const entry = audit.at(-1)!;
  return {
    calls: inputs.length,
    prompt_sha256: entry.prompt_sha256,
    response_sha256: entry.response_sha256,
    model_inputs_sha256: canonicalSha256(inputs.map(({ signal: _signal, ...input }) => input)),
    outcome: response.outcome,
    audit_sha256: canonicalSha256(JSON.parse(JSON.stringify(entry))),
  };
}

describe("agentic Ask golden replay", () => {
  it("retains the historical b108 output control", () => {
    const recorded = JSON.parse(readFileSync(HISTORICAL_FIXTURE, "utf8"));
    expect(canonicalSha256(recorded)).toBe(HISTORICAL_FIXTURE_SHA256);
  });

  it("preserves the b108 semantic response replay", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    const recorded = JSON.parse(readFileSync(HISTORICAL_FIXTURE, "utf8")) as typeof observed;
    const semantic = (value: Awaited<ReturnType<typeof run>>) => ({ calls: value.calls, response_sha256: value.response_sha256, outcome: value.outcome });
    expect(Object.fromEntries(Object.entries(observed).map(([name, value]) => [name, semantic(value)])))
      .toEqual(Object.fromEntries(Object.entries(recorded).map(([name, value]) => [name, semantic(value)])));
  });

  it("retains the historical Granola Phase 2 control", () => {
    const recorded = JSON.parse(readFileSync(GRANOLA_PHASE2_FIXTURE, "utf8"));
    expect(canonicalSha256(recorded)).toBe(GRANOLA_PHASE2_HISTORICAL_SHA256);
  });

  it("reproduces the reviewed current quality baseline", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    if (process.env.ASK_QUALITY_BASELINE_WRITE === "1") writeFileSync(QUALITY_FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(QUALITY_FIXTURE, "utf8")) as typeof observed;
    expect(observed).toEqual(recorded);
  });
});
