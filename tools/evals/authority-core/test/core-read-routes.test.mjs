import assert from "node:assert/strict";
import test from "node:test";
import { createCoreDeterministicStructuredGenerationPort } from "../core-read-routes.mjs";

const stepSchema = Object.freeze({ properties: Object.freeze({ parts: Object.freeze({}), actions: Object.freeze({}) }) });
const answerSchema = Object.freeze({ properties: Object.freeze({ sentences: Object.freeze({}), not_found: Object.freeze({}) }) });

const step = (port, prompt) => port.generate({ schema: stepSchema, user_prompt: JSON.stringify(prompt) });
const answer = (port, evidence) => port.generate({ schema: answerSchema, user_prompt: JSON.stringify({ question: "What did the team decide?", evidence }) });

test("deterministic agent searches, then completes a bounded inventory before reporting absence", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  const first = await step(port, { question: "What decision governs the active checkpoint?", step: 1, last_results: [] });
  assert.deepEqual(first.actions, [{ tool: "search", args: { query: "what decision governs the active checkpoint" } }]);
  const found = await step(port, { question: "What decision governs the active checkpoint?", step: 2, seen: [{ id: "E1", full: true }], last_results: [{ tool: "search", results: ["E1"] }] });
  assert.deepEqual(found.actions, [{ tool: "finish", args: {} }]);
  assert.deepEqual(found.parts[0].needs[0], { need: "the answer", status: "found", evidence: ["E1"] });
  const absentSearch = await step(port, { question: "What decision governs the active checkpoint?", step: 2, last_results: [{ tool: "search", results: [] }] });
  assert.deepEqual(absentSearch.actions, [{ tool: "list", args: { source: "meetings" } }]);
  assert.equal(absentSearch.parts[0].needs[0].status, "open");
  const missing = await step(port, { question: "What decision governs the active checkpoint?", step: 3, last_results: [{ tool: "list", items: [], more: false }] });
  assert.deepEqual(missing.actions, [{ tool: "finish", args: {} }]);
  assert.equal(missing.parts[0].needs[0].status, "not_found");
});

test("deterministic agent finishes on the highest-ranked full result, not the lowest id", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  // seen is in id order; the search's rank order lives only in last_results.
  const approved = (id) => ({ id, provenance: { kind: "approved_record" }, full: true });
  const found = await step(port, {
    question: "What decision governs the active checkpoint?", step: 2,
    seen: [approved("E1"), approved("E2")],
    last_results: [{ tool: "search", results: ["E2", "E1"] }],
  });
  assert.deepEqual(found.parts[0].needs[0].evidence, ["E2"]);
});

test("deterministic agent prefers a shown approved record item over a higher-ranked import", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  const seen = [{ id: "E1", provenance: { kind: "source_revision" }, full: true }, { id: "E2", provenance: { kind: "approved_record" }, full: true }];
  const found = await step(port, { question: "What decision governs the active checkpoint?", step: 2, seen, last_results: [{ tool: "search", results: ["E1", "E2"] }] });
  assert.deepEqual(found.parts[0].needs[0].evidence, ["E2"]);
  const importOnly = await step(port, { question: "What decision governs the active checkpoint?", step: 2, seen: [seen[0]], last_results: [{ tool: "search", results: ["E1"] }] });
  assert.deepEqual(importOnly.parts[0].needs[0].evidence, ["E1"]);
});

test("deterministic answer output is grounded in the current released evidence and id", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  const first = await answer(port, [{ id: "E1", text: "Use the durable checkpoint." }]);
  const second = await answer(port, [{ id: "E7", text: "Use the active release fence." }]);
  assert.deepEqual(first, { sentences: [{ text: "Use the durable checkpoint.", evidence: ["E1"] }], not_found: [] });
  assert.deepEqual(second, { sentences: [{ text: "Use the active release fence.", evidence: ["E7"] }], not_found: [] });
  await assert.rejects(answer(port, []), /no released evidence/);
  await assert.rejects(answer(port, [{ id: "", text: "unbound" }]), /invalid released evidence/);
});
