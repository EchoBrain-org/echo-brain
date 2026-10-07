import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { trimAgenticEvidenceBundleV1, type AgenticEvidenceBundleV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { callRendererModelV1, type AgenticRendererV1 } from "../../src/answer-composition/agentic-renderer-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationJsonSchema } from "../../src/answer-composition/structured-generation-v1.js";
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

/**
 * A Sweep run with a rejected first reply on a pinned clock (model calls 1 s, desk reads 7 ms) and a model that
 * reports usage. Its renderer keeps the full bundle it is given and makes one answer call of its own.
 */
async function sweepRun() {
  let clock = 0;
  const replies = [
    { not: "a step" },
    step([part("Dashboard", [need("dashboard published", "open")])], [{ tool: "list", args: { source: "meetings", kind: "action" } }, { tool: "search", args: { query: "dashboard numbers" } }]),
    step([part("Dashboard", [need("dashboard published", "found", ["E1", "E3"])])], [{ tool: "finish", args: {} }]),
    { rendered: true },
  ];
  const run = researchHarness((_input, index) => { clock += 1_000; return replies[index]; }, {
    openCitation: async input => { clock += 7; return result([JSON.stringify(input.citation) === JSON.stringify(anchor.citation) ? anchor : followUp]); },
    list: async () => { clock += 7; return result([owned, unowned], { truncated: true, notice: "Meeting actions are cut short." }); },
    search: async () => { clock += 7; return result([listedOnly]); },
  }, { now_ms: () => clock, usage: call => ({ input_tokens: 100 * call, output_tokens: 10, total_tokens: 100 * call + 10, cached_input_tokens: null, reasoning_tokens: null }) });
  let bundle: AgenticEvidenceBundleV1 | undefined;
  const renderer: AgenticRendererV1<null, null> = {
    async render(input) {
      bundle = input.bundle;
      await callRendererModelV1(input, { role: "answer", span: "research_render" }, "Render.", {}, { type: "object" } as unknown as StructuredGenerationJsonSchema, value => value);
      return { result: null, cited: [], outcome: "answered", fallbacks: 0, answer_sha256: canonicalSha256({}) };
    },
  };
  await run.research.renderWithResearch({ ...sweep, renderer, trigger_input: null });
  return { bundle: bundle!, audit: run.audit };
}

describe("evidence bundle", () => {
  it("keeps server records, desk items and who it was gathered for in the full bundle, and trims them all away", async () => {
    const { bundle } = await sweepRun();
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
    const trimmed = JSON.stringify(trimAgenticEvidenceBundleV1(bundle));
    for (const value of [anchor.id, unowned.id, listedOnly.receipt_sha256, ...bundle.server.invocation_digests]) expect(trimmed).not.toContain(value);
  });

  it("gives the evaluation each item's details, the inventories read and research's own cost", async () => {
    const { bundle, audit } = await sweepRun();
    const view = trimAgenticEvidenceBundleV1(bundle);
    expect(view.items.map(item => [item.id, item.date, item.date_kind, item.attributes])).toEqual([
      ["E1", "2026-10-01", "unspecified", undefined],
      ["E2", "2026-10-01", "unspecified", undefined],
      ["E3", "2026-10-01", "unspecified", { owner: "Jules", due_at: "2026-09-11" }],
      // A meeting action with no recorded owner says so, so no model fills one in.
      ["E4", "2026-10-01", "unspecified", { due_at: "2026-09-12", owner: "none recorded" }],
      ["E5", "2026-10-01", "unspecified", undefined],
    ]);
    expect(view.items[4]).not.toHaveProperty("text");
    expect(view.coverage.inventories).toEqual([{ source: "meetings", shown_count: 2, more: false, available: false, truncated: true }]);
    // Research's three step calls only; the renderer's answer call is not research cost. Desk time is wall time: the list and search overlap.
    expect(view.cost).toEqual({ rounds: 2, model_calls: 3, repairs: 1, fallbacks: 0, input_tokens: 600, output_tokens: 30, total_tokens: 630, model_ms: 3_000, desk_ms: 28, elapsed_ms: 3_028 });
    // The audit sums every call of the request, the renderer's included.
    expect(audit).toEqual([expect.objectContaining({ model_calls: 4, generation_usage: { input_tokens: 1_000, output_tokens: 40, total_tokens: 1_040 }, finish_reason_counts: { stop: 4 } })]);
    expect(audit[0]!.generations.map(entry => entry.role)).toEqual(["step", "step", "step", "answer"]);
  });
});
