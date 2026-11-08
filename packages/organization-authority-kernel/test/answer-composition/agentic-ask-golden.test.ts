import { readFileSync, writeFileSync } from "node:fs";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { replay, SCENARIOS, type Scenario } from "./fixtures/agentic-scenarios.js";

/**
 * Replay equivalence for the research split (research loop evaluation v1).
 * Scripted model replies and a pinned clock drive Ask end to end. The reviewed
 * quality baseline pins every scenario's prompt, model-input, released answer
 * and audit fingerprints, after the replay checks that the audit binds the V8
 * answer Ask released.
 */
const QUALITY_FIXTURE = new URL("./agentic-ask-quality-baseline.v1.json", import.meta.url);

async function run(name: string, scenario: Scenario) {
  const { response, inputs, audit } = await replay(name, scenario);
  const released = audit.at(-1)!;
  expect(response).toMatchObject({ schema_version: 8, kind: "echo-clean-person-answer-v8" });
  expect(released.response_sha256).toBe(canonicalSha256(response));
  return {
    calls: inputs.length,
    prompt_sha256: released.prompt_sha256,
    response_sha256: released.response_sha256,
    model_inputs_sha256: canonicalSha256(inputs.map(({ signal: _signal, ...input }) => input)),
    outcome: response.outcome,
    audit_sha256: canonicalSha256(JSON.parse(JSON.stringify(released))),
  };
}

describe("agentic Ask golden replay", () => {
  it("reproduces the reviewed current quality baseline", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    if (process.env.ASK_QUALITY_BASELINE_WRITE === "1") writeFileSync(QUALITY_FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    expect(observed).toEqual(JSON.parse(readFileSync(QUALITY_FIXTURE, "utf8")));
  });
});
