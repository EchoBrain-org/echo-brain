import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAgenticResearchV1, type AgenticAskAuditEntryV1 } from "../../src/answer-composition/agentic-ask-v1.js";
import { trimAgenticEvidenceBundleV1 } from "../../src/answer-composition/agentic-evidence-bundle-v1.js";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "../../src/answer-composition/agentic-trigger-definitions-v1.js";
import type { StructuredGenerationInput } from "../../src/answer-composition/structured-generation-v1.js";
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from "../../src/shared/evidence-desk-v2.js";

/**
 * The trimmed evidence bundle must stay today's research result. The snapshot
 * was recorded from the inline `researchResult()` before the bundle existed
 * (research trigger contract v1, Task 1.2); never regenerate it from the code
 * being verified. Task 4 re-recorded only the Sweep entry's goal, which is now
 * the Sweep definition's task text; the Ask entry is unchanged.
 */
const SNAPSHOT = "./__snapshots__/agentic-evidence-bundle-v1.research.json";
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };

function record(id: string, text: string | undefined = `Approved: ${id} was decided.`, extra: Partial<EvidenceDeskItemV2> = {}): EvidenceDeskItemV2 {
  return Object.freeze({
    id: `desk_${canonicalSha256({ id }).slice(7)}`,
    citation: { kind: "approved_record" as const, atom_id: canonicalSha256({ id }), record_sha256: canonicalSha256({ id, record: true }), policy_id: "organization-member-readable-person-v2" as const },
    kind: "decision" as const, ...(text === undefined ? {} : { text }), label: `Meeting ${id}`, visibility: "team" as const,
    occurred_at: "2026-10-05", receipt_sha256: canonicalSha256({ receipt: id }), ...extra,
  });
}
const result = (items: readonly EvidenceDeskItemV2[], extra: Partial<EvidenceDeskResultV2> = {}): EvidenceDeskResultV2 =>
  ({ items, truncated: false, receipt_digests: [canonicalSha256({ desk: items.map(item => item.id) })], ...extra });
const step = (needs: readonly { need: string; status: string; evidence?: readonly string[] }[], actions: readonly { tool: string; args?: Record<string, string> }[], question = "Part") =>
  ({ parts: [{ question, notes: "", needs: needs.map(need => ({ evidence: [], ...need })) }], actions: actions.map(action => ({ args: {}, ...action })) });

/** A pinned clock: model calls take 1 s and desk reads 7 ms, so every cost field is deterministic. */
function harness(replies: readonly unknown[], desk: Partial<EvidenceDeskPortV2>) {
  let clock = 0;
  const inputs: StructuredGenerationInput[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const timed = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) => async (...args: A) => { clock += 7; return operation(...args); };
  const base: EvidenceDeskPortV2 = {
    scope: { kind: "project", project_id: "prj_00000000-0000-4000-8000-000000000001" } as EvidenceDeskPortV2["scope"], live_sources: [],
    search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => ({ checked_at: `2026-10-06T00:00:${String(clock % 60_000).padStart(2, "0").slice(0, 2)}.000Z` }), ...desk,
  };
  const port: EvidenceDeskPortV2 = {
    ...base, search: timed(base.search), open: timed(base.open), list: timed(base.list),
    ...(base.openCitation === undefined ? {} : { openCitation: timed(base.openCitation) }),
  };
  const research = createAgenticResearchV1({
    desk: port, generation, audit: { append: entry => { audit.push(entry); } }, today: () => "2026-10-06", now_ms: () => clock,
    model: {
      async generate() { throw new Error("the gate prefers generate_with_observation"); },
      async generate_with_observation(input) {
        inputs.push(input);
        const reply = replies[inputs.length - 1];
        if (reply === undefined) throw new Error(`unscripted call ${inputs.length}`);
        clock += 1_000;
        return { value: reply, finish_reason: "stop" as const, provider_latency_ms: 1_000, usage: { input_tokens: 100 * inputs.length, output_tokens: 10, total_tokens: 100 * inputs.length + 10, cached_input_tokens: null, reasoning_tokens: null } };
      },
    },
  });
  return { research, inputs, audit };
}

const anchor = record("dashboard", "Approved: publish the dashboard by September 11.");
const followUp = record("owner", "Approved: Jules owns the dashboard.");
const owned = record("action-owned", "Jules will publish the dashboard.", { kind: "action", attributes: { owner: "Jules", due_at: "2026-09-11" } });
const unowned = record("action-unowned", "Someone checks the numbers.", { kind: "action", attributes: { due_at: "2026-09-12" } });
const { text: _listedText, ...listedOnly } = record("listed");

function sweepRun() {
  return harness([
    { not: "a step" },
    step([{ need: "dashboard published", status: "open" }], [{ tool: "list", args: { source: "meetings", kind: "action" } }, { tool: "search", args: { query: "dashboard numbers" } }], "Dashboard"),
    step([{ need: "dashboard published", status: "found", evidence: ["E1", "E3"] }], [{ tool: "finish" }], "Dashboard"),
  ], {
    openCitation: async input => result([JSON.stringify(input.citation) === JSON.stringify(anchor.citation) ? anchor : followUp]),
    list: async () => result([owned, unowned], { truncated: true, notice: "Meeting actions are cut short." }),
    search: async () => result([listedOnly]),
  });
}
const sweepTrigger = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === "sweep")!;
const sweep = { trigger: "sweep", brief: sweepTrigger.brief(sweepTrigger.parseEvent({ findings: [
  { finding: "Dashboard published", expected: "Published by September 11", citations: [anchor.citation, followUp.citation] },
] })) };

function askRun() {
  return harness([
    step([{ need: "dashboard date", status: "open" }], [{ tool: "search", args: { query: "dashboard" } }]),
    step([{ need: "dashboard date", status: "found", evidence: ["E1"] }], [{ tool: "finish" }]),
    { sentences: [{ text: "The dashboard is due September 11.", evidence: ["E1"] }], not_found: [] },
  ], { search: async () => result([anchor, listedOnly]) });
}

describe("evidence bundle", () => {
  it("keeps today's research result for a Sweep and an Ask run", async () => {
    const swept = await sweepRun().research.research(sweep);
    const ask = (await askRun().research.answerWithResearch({ question: "When is the dashboard due?" })).research;
    // Compared, never written: an update run must not re-record the baseline from new code.
    expect(`${JSON.stringify({ sweep: swept, ask }, null, 2)}\n`).toBe(readFileSync(new URL(SNAPSHOT, import.meta.url), "utf8"));
  });

  it("trims the full bundle to exactly today's research result", async () => {
    const recorded = JSON.parse(readFileSync(new URL(SNAPSHOT, import.meta.url), "utf8")) as { readonly sweep: unknown };
    const run = sweepRun();
    const bundle = await run.research.researchBundle(sweep);
    const trimmed = trimAgenticEvidenceBundleV1(bundle);
    expect(JSON.parse(JSON.stringify(trimmed))).toEqual(recorded.sweep);
    expect(trimmed).toEqual(await sweepRun().research.research(sweep));
    // The release step audits the trimmed bundle; it must hash the same as before.
    expect(run.audit[0]!.response_sha256).toBe(canonicalSha256(JSON.parse(JSON.stringify(trimmed))));
    const serialized = JSON.stringify(trimmed);
    for (const item of [anchor, followUp, owned, unowned]) {
      expect(serialized).not.toContain(item.id);
      expect(serialized).not.toContain(item.receipt_sha256);
    }
  });

  it("keeps server records, desk items and who it was gathered for in the full bundle only", async () => {
    const run = sweepRun();
    const bundle = await run.research.researchBundle(sweep);
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
  });
});
