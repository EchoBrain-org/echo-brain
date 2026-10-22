import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routeDiagnosticAdapter } from "../run.mjs";

test("route diagnosis sends the production request to the requested host alone, even a host production ignores", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "echo-agentic-ask-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credentialFile = join(root, "openrouter-key");
  writeFileSync(credentialFile, `sk-or-v1-${"0".repeat(64)}`, { mode: 0o600 });
  const sent = [];
  const upstream = async (_url, init) => { sent.push(JSON.parse(String(init.body)).provider); return new Response("{}", { status: 503 }); };
  for (const route of ["friendli", "baidu"]) {
    const adapter = routeDiagnosticAdapter(credentialFile, route, new Set(), upstream);
    await assert.rejects(adapter.generate({ model: "deepseek/deepseek-v3.2", system_prompt: "s", user_prompt: "u", schema: { type: "object" }, max_output_tokens: 16, timeout_ms: 1_000 }));
  }
  // Production skips friendli and atlas-cloud for this model (ADR-0037). A route it ignores too would leave no host to serve the call.
  const production = { require_parameters: true, data_collection: "deny", sort: "throughput" };
  assert.deepEqual(sent, [
    { ...production, ignore: ["atlas-cloud"], only: ["friendli"], allow_fallbacks: false },
    { ...production, ignore: ["friendli", "atlas-cloud"], only: ["baidu"], allow_fallbacks: false },
  ]);
});
