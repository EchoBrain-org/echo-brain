import { readFileSync, writeFileSync } from "node:fs";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { replay, SCENARIOS, type Scenario } from "./fixtures/agentic-scenarios.js";

/**
 * Replay equivalence for the research split (research loop evaluation v1).
 * Scripted model replies and a pinned clock drive Ask end to end. The b108
 * fixture retains its output-level semantic control; the Granola Phase 2
 * fixture pins every prompt, model input and audit fingerprint. GOLDEN_WRITE=1
 * rewrites only the latter after recording a reviewed Phase 2 baseline.
 */
const FIXTURE = new URL("./agentic-ask-golden.v1.json", import.meta.url);
/**
 * Full replay baseline captured from the clean Granola Phase 2 head
 * 5d5a4bdaee997eb3f15fcb16e88b6e174dc06c11. It carries the expanded source catalog,
 * so a research-loop refactor cannot silently remove or rewrite it.
 */
const GRANOLA_PHASE2_FIXTURE = new URL("./agentic-ask-granola-phase2.v1.json", import.meta.url);
/*
 * Record new full-fingerprint scenarios against the reviewed Phase 2 parent,
 * before the research refactor, using the identical replay harness. Never
 * regenerate expectations from the implementation being verified. The b108
 * fixture remains the historical output control.
 */

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
  it("preserves the b108 semantic replay control", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof observed;
    expect(Object.fromEntries(Object.entries(observed).map(([name, value]) => [name, {
      calls: value.calls, response_sha256: value.response_sha256, outcome: value.outcome,
    }]))).toEqual(Object.fromEntries(Object.entries(recorded).map(([name, value]) => [name, {
      calls: value.calls, response_sha256: value.response_sha256, outcome: value.outcome,
    }])));
  });

  it("reproduces every Phase 2 Granola fingerprint across the research refactor", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    if (process.env.GOLDEN_WRITE === "1") writeFileSync(GRANOLA_PHASE2_FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(GRANOLA_PHASE2_FIXTURE, "utf8")) as typeof observed;
    expect(observed).toEqual(recorded);
  });
});
