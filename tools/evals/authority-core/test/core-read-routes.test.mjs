import assert from "node:assert/strict";
import test from "node:test";
import { createCoreDeterministicStructuredGenerationPort } from "../core-read-routes.mjs";

const answerSchema = Object.freeze({
  properties: Object.freeze({ status: Object.freeze({}), citations: Object.freeze({}) }),
});
const plannerSchema = Object.freeze({
  properties: Object.freeze({ queries: Object.freeze({}) }),
});

async function answer(port, sources) {
  return await port.generate({
    schema: answerSchema,
    user_prompt: JSON.stringify({ question: "What did the team decide?", sources }),
  });
}

test("deterministic answer output is grounded in the current released evidence and alias", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  const first = await answer(port, [{ citation_id: "a1", text: "Use the durable checkpoint." }]);
  const second = await answer(port, [{ citation_id: "a7", text: "Use the active release fence." }]);
  assert.deepEqual(first, {
    status: "answered",
    answer: "Use the durable checkpoint.",
    citations: ["a1"],
  });
  assert.deepEqual(second, {
    status: "answered",
    answer: "Use the active release fence.",
    citations: ["a7"],
  });
  assert.notDeepEqual(first, second);
});

test("deterministic generation rejects malformed or absent evidence and derives planner text from its question", async () => {
  const port = createCoreDeterministicStructuredGenerationPort();
  await assert.rejects(answer(port, []), /no released evidence/);
  await assert.rejects(answer(port, [{ citation_id: "", text: "unbound" }]), /invalid released evidence/);
  const plan = await port.generate({
    schema: plannerSchema,
    user_prompt: JSON.stringify({ question: "What decision governs the active checkpoint?" }),
  });
  assert.deepEqual(plan, { queries: ["the active checkpoint"] });
});
