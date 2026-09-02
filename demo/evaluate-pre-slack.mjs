#!/usr/bin/env node
/**
 * Fast, no-write Echo extraction gate. Build workspaces first so this
 * wrapper runs the compiled production decision processor.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const valueFor = (flag) => {
  const index = process.argv.slice(2).indexOf(flag);
  return index < 0 ? undefined : process.argv.slice(2)[index + 1];
};
const args = ["run", "--meetings-dir", resolve(here, "meetings"), "--expectations", resolve(here, "expectations.json")];
const credentialFile = valueFor("--llm-credential-file");
const model = valueFor("--model");
if (credentialFile !== undefined) {
  args.push("--llm-credential-file", credentialFile);
  if (model !== undefined) args.push("--model", model);
} else {
  process.stderr.write(
    "usage: node demo/evaluate-pre-slack.mjs --llm-credential-file <absolute-path> [--model <author/model-slug>]\n",
  );
  process.exitCode = 2;
}
if (process.exitCode === undefined) {
  const { runNorthstarPreSlackEvaluatorCommandV1 } = await import(
    "../services/organization-authority/dist/composition/providers/synthetic-demo/synthetic-demo-pre-slack-evaluator-v1.js"
  );
  process.exitCode = await runNorthstarPreSlackEvaluatorCommandV1(args);
}
