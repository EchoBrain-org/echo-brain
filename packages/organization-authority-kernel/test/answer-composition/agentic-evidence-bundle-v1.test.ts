import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import type { AgenticRendererV1 } from "../../src/answer-composition/agentic-renderer-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import { listed, need, part, record, researchHarness, result, step } from "./fixtures/agentic-scenarios.js";

const anchor = record("dashboard", "Approved: publish the dashboard by September 11.");
const followUp = record("owner", "Approved: Jules owns the dashboard.");
const owned = record("action-owned", "Jules will publish the dashboard.", { kind: "action", attributes: { owner: "Jules", due_at: "2026-09-11" } });
const unowned = record("action-unowned", "Someone checks the numbers.", { kind: "action", attributes: { due_at: "2026-09-12" } });
const listedOnly = listed("listed");
const sweepTrigger = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "sweep")!;
const sweep = { trigger: "sweep", brief: sweepTrigger.brief(sweepTrigger.parseEvent({ findings: [
  { finding: "Dashboard published", expected: "Published by September 11", citations: [anchor.citation, followUp.citation] },
] })) };

/** A Sweep run with a rejected first reply; the full bundle is what a renderer that only hands it back is given. */
async function sweepBundle(): Promise<AgenticEvidenceBundleV1> {
  const run = researchHarness([
    { not: "a step" },
    step([part("Dashboard", [need("dashboard published", "open")])], [{ tool: "list", args: { source: "meetings", kind: "action" } }, { tool: "search", args: { query: "dashboard numbers" } }]),
    step([part("Dashboard", [need("dashboard published", "found", ["E1", "E3"])])], [{ tool: "finish", args: {} }]),
  ], {
    openCitation: async input => result([JSON.stringify(input.citation) === JSON.stringify(anchor.citation) ? anchor : followUp]),
    list: async () => result([owned, unowned], { truncated: true, notice: "Meeting actions are cut short." }),
    search: async () => result([listedOnly]),
  });
  let given: AgenticEvidenceBundleV1 | undefined;
  const renderer: AgenticRendererV1<null, null> = { async render({ bundle }) { given = bundle; return { result: null, cited: [], outcome: "answered", fallbacks: 0, answer_sha256: canonicalSha256({}) }; } };
  await run.research.renderWithResearch({ ...sweep, renderer, trigger_input: null });
  return given!;
}

describe("evidence bundle", () => {
  it("keeps server records, desk items and who it was gathered for in the full bundle, and trims them all away", async () => {
    const bundle = await sweepBundle();
    expect(bundle.items.map(item => item.short)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect(bundle.items[0]).toMatchObject({ short: "E1", item: anchor, source: "meeting", full: true, opened: true, preloaded: true, cited_by_plan: true });
    expect(bundle.items[4]).toMatchObject({ short: "E5", item: listedOnly, full: false, opened: false, preloaded: false, query: "dashboard numbers", cited_by_plan: false });
    expect(bundle.items[4]!.touched).toBeGreaterThan(bundle.items[0]!.touched);
    expect(bundle.unreadable_starting).toEqual([]);
    expect(bundle.gathered_for).toEqual({ scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" }, checked_at: expect.any(String) });
    expect(bundle.server.receipts).toEqual(expect.arrayContaining([anchor.receipt_sha256, followUp.receipt_sha256, owned.receipt_sha256, listedOnly.receipt_sha256]));
    expect(bundle.server.invocation_digests).toHaveLength(3);
    expect(bundle.server.generations.map(value => value.role)).toEqual(["step", "step", "step"]);
    expect(bundle.coverage.notices).toEqual(["Meeting actions are cut short."]);
    expect(bundle.stop).toEqual({ reason: "finished", completed: true });
    expect(bundle.cost).toMatchObject({ rounds: 2, model_calls: 3, repairs: 1 });
    const trimmed = JSON.stringify(trimAgenticEvidenceBundleV1(bundle));
    for (const value of [anchor.id, unowned.id, listedOnly.receipt_sha256, ...bundle.server.invocation_digests]) expect(trimmed).not.toContain(value);
  });
});
