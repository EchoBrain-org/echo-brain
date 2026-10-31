import { readFileSync, writeFileSync } from "node:fs";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { replay, SCENARIOS, type Scenario } from "./fixtures/agentic-scenarios.js";

/**
 * Replay equivalence for the research split (research loop evaluation v1).
 * Scripted model replies and a pinned clock drive Ask end to end. The b108
 * fixture retains its output-level semantic control; the separate quality
 * baseline pins current prompt, model-input and audit fingerprints.
 *
 * Every fixture was recorded while these scenarios answered V4 (and
 * `live_ticket_and_page` V6). Ask now answers only V8, whose answer to each
 * scenario is the recorded one with its `schema_version` and `kind` alone
 * changed: the replay checks that the audit binds the V8 answer it released,
 * then fingerprints that answer, and the audit record, under the version the
 * scenario recorded. Every other byte is compared as recorded.
 */
const HISTORICAL_FIXTURE = new URL("./agentic-ask-golden.v1.json", import.meta.url);
const HISTORICAL_FIXTURE_SHA256 = "sha256:8aff56ec626c367b738acb98217c406e2be46ef255279ac6331227b3bcf0f417";
/** Current quality behavior is a separately reviewed baseline, never a rewrite of the historical control. */
const QUALITY_FIXTURE = new URL("./agentic-ask-quality-baseline.v1.json", import.meta.url);
/**
 * Scenarios the pinned fixtures still record but Ask no longer runs. The small-scope shortcut was removed unmeasured on
 * 2026-10-19; its recorded entries stay so the fixtures remain byte-identical.
 */
const RETIRED_SCENARIOS = new Set(["small_scope_preload"]);
const current = <T>(recorded: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(recorded).filter(([name]) => !RETIRED_SCENARIOS.has(name)));

/** The released V8 answer as the fixtures recorded it: in the scenario's recorded version, every other byte unchanged. */
function asRecorded(response: object, version: Scenario["recorded"]) {
  return { ...response, schema_version: version, kind: `echo-clean-person-answer-v${version}` };
}

async function run(name: string, scenario: Scenario) {
  const { response, inputs, audit } = await replay(name, scenario);
  const released = audit.at(-1)!;
  expect(response).toMatchObject({ schema_version: 8, kind: "echo-clean-person-answer-v8" });
  expect(released.response_sha256).toBe(canonicalSha256(response));
  const entry = { ...released, response_sha256: canonicalSha256(asRecorded(response, scenario.recorded)) };
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
    const recorded = current(JSON.parse(readFileSync(HISTORICAL_FIXTURE, "utf8")) as typeof observed);
    const semantic = (value: Awaited<ReturnType<typeof run>>) => ({ calls: value.calls, response_sha256: value.response_sha256, outcome: value.outcome });
    expect(Object.fromEntries(Object.entries(observed).map(([name, value]) => [name, semantic(value)])))
      .toEqual(Object.fromEntries(Object.entries(recorded).map(([name, value]) => [name, semantic(value)])));
  });

  it("reproduces the reviewed current quality baseline", async () => {
    const observed: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const [name, scenario] of Object.entries(SCENARIOS)) observed[name] = await run(name, scenario);
    if (process.env.ASK_QUALITY_BASELINE_WRITE === "1") writeFileSync(QUALITY_FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
    const recorded = current(JSON.parse(readFileSync(QUALITY_FIXTURE, "utf8")) as typeof observed);
    expect(observed).toEqual(recorded);
  });
});
