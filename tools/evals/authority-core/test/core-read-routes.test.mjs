import assert from "node:assert/strict";
import test from "node:test";
import { createCoreDeterministicStructuredGenerationPort } from "../core-read-routes.mjs";

const stepSchema = Object.freeze({ properties: Object.freeze({ parts: Object.freeze({}), actions: Object.freeze({}) }) });
const answerSchema = Object.freeze({ properties: Object.freeze({ sentences: Object.freeze({}), not_found: Object.freeze({}) }) });

const step = (port, prompt) => port.generate({ schema: stepSchema, user_prompt: JSON.stringify(prompt) });
const answer = (port, evidence) => port.generate({ schema: answerSchema, user_prompt: JSON.stringify({ question: "What did the team decide?", evidence }) });

test("deterministic agent searches the question once, then finishes on a fully shown result", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  const first = await step(port, { question: "What decision governs the active checkpoint?", step: 1, last_results: [] });
  assert.deepEqual(first.actions, [{ tool: "search", args: { query: "what decision governs the active checkpoint" } }]);
  const found = await step(port, { question: "What decision governs the active checkpoint?", step: 2, last_results: [{ tool: "search", results: [{ id: "E1", full: true }] }] });
  assert.deepEqual(found.actions, [{ tool: "finish", args: {} }]);
  assert.deepEqual(found.parts[0].needs[0], { need: "the answer", status: "found", evidence: ["E1"] });
  const missing = await step(port, { question: "What decision governs the active checkpoint?", step: 2, last_results: [{ tool: "search", results: [] }] });
  assert.equal(missing.parts[0].needs[0].status, "not_found");
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
