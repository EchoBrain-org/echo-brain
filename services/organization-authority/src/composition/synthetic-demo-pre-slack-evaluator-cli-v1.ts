import { createOpenRouterDecisionProcessor } from "@echo-brain/provider-openrouter/llm/openrouter-decision-processor";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import type { AdapterConfig } from "@echo-brain/organization-processing/core/contracts/adapter";
import type { DecisionProcessorAdapter } from "@echo-brain/organization-processing/core/ports/adapters";
import { loadSyntheticDemoMeetingCorpusV1 } from "@echo-brain/provider-synthetic-demo/source/synthetic-demo-meeting-source-v1";
import { fixedOpenRouterDecisionProcessorConfigV1, OPENROUTER_DECISION_PROCESSOR_MODEL_V1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-config-v1";

import { evaluateNorthstarPreSlackExtractionV1, northstarExtractionFailureV1, northstarEvaluationWithFailureV1 } from "@echo-brain/provider-synthetic-demo/synthetic-demo-pre-slack-evaluator-v1";
export const NORTHSTAR_PRE_SLACK_QUALIFICATION_MODEL_V1 =
  OPENROUTER_DECISION_PROCESSOR_MODEL_V1;

const USAGE =
  "usage: node demo/evaluate-pre-slack.mjs " +
  "run --meetings-dir <absolute-path> --expectations <absolute-path> " +
  "--llm-credential-file <absolute-path> [--model <author/model-slug>]";

export interface NorthstarPreSlackEvaluatorDependenciesV1 {
  readonly read_credential?: (reference: string) => string;
  readonly create_processor?: (
    config: AdapterConfig,
    credential_reference: string,
    credential: string,
  ) => DecisionProcessorAdapter;
  readonly load_corpus?: typeof loadSyntheticDemoMeetingCorpusV1;
  readonly read_expectations?: (path: string) => Promise<unknown>;
}

export interface NorthstarPreSlackEvaluatorIoV1 {
  readonly stdout: (line: string) => void;
}

const PROCESS_IO: NorthstarPreSlackEvaluatorIoV1 = {
  stdout: (line) => process.stdout.write(line),
};

function absolutePath(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(USAGE);
  }
  return value;
}

interface ParsedFlagsV1 {
  readonly meetings_dir: string;
  readonly expectations: string;
  readonly llm_credential_file: string;
  readonly model?: string;
}

function modelSlug(value: string | undefined): string {
  if (value === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(value)) throw new Error(USAGE);
  return value;
}

function parse(argv: readonly string[]): ParsedFlagsV1 {
  if (argv[0] !== "run" || (argv.length !== 7 && argv.length !== 9)) throw new Error(USAGE);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--meetings-dir" && name !== "--expectations" && name !== "--llm-credential-file" && name !== "--model") ||
      value === undefined || values.has(name)
    ) throw new Error(USAGE);
    values.set(name, name === "--model" ? modelSlug(value) : absolutePath(value));
  }
  if (
    !values.has("--meetings-dir") ||
    !values.has("--expectations") ||
    !values.has("--llm-credential-file")
  ) throw new Error(USAGE);
  return Object.freeze({
    meetings_dir: values.get("--meetings-dir")!,
    expectations: values.get("--expectations")!,
    llm_credential_file: values.get("--llm-credential-file")!,
    ...(values.has("--model") ? { model: values.get("--model")! } : {}),
  });
}

function failed(io: NorthstarPreSlackEvaluatorIoV1, failure: "usage" | "evaluation"): number {
  io.stdout(`${JSON.stringify({
    schema_version: 1,
    kind: "echo-synthetic-demo-pre-slack-evaluation-failed-v1",
    failure,
  })}\n`);
  return 2;
}

/** Uses the production LLM decision processor but leaves every downstream system untouched. */
export async function runNorthstarPreSlackEvaluatorCommandV1(
  argv: readonly string[],
  io: NorthstarPreSlackEvaluatorIoV1 = PROCESS_IO,
  dependencies: NorthstarPreSlackEvaluatorDependenciesV1 = {},
): Promise<number> {
  let flags: ParsedFlagsV1;
  try {
    flags = parse(argv);
  } catch {
    return failed(io, "usage");
  }
  try {
    const credentialReference = `file:${flags.llm_credential_file}`;
    const credential = (dependencies.read_credential ?? readPrivateAuthorityCredential)(credentialReference);
    const defaultConfig = fixedOpenRouterDecisionProcessorConfigV1(
      "founder-llm-v1",
      credentialReference,
    );
    const model = flags.model ?? NORTHSTAR_PRE_SLACK_QUALIFICATION_MODEL_V1;
    const processorConfig: AdapterConfig = Object.freeze({
      ...defaultConfig,
      settings: Object.freeze({ ...defaultConfig.settings, model }),
    });
    const processor = dependencies.create_processor === undefined
      ? createOpenRouterDecisionProcessor(
        processorConfig,
        { credentialResolver: (reference) => reference === credentialReference ? credential : undefined },
      )
      : dependencies.create_processor(processorConfig, credentialReference, credential);
    if (!processor.validateConfig(processorConfig).ok) {
      throw new Error("Northstar pre-Slack processor configuration is invalid");
    }
    let health;
    try {
      health = await processor.healthCheck();
    } catch (error) {
      const result = northstarEvaluationWithFailureV1(northstarExtractionFailureV1(null, "decision_processor.health_check", error));
      io.stdout(`${JSON.stringify({ ...result, evaluated_model: model })}\n`);
      return 1;
    }
    if (health.status !== "healthy") {
      const result = northstarEvaluationWithFailureV1(northstarExtractionFailureV1(null, "decision_processor.health_check"));
      io.stdout(`${JSON.stringify({ ...result, evaluated_model: model })}\n`);
      return 1;
    }
    const corpus = await (dependencies.load_corpus ?? loadSyntheticDemoMeetingCorpusV1)(flags.meetings_dir);
    const oracle = await (dependencies.read_expectations ?? (async (path: string) => JSON.parse(readFileSync(path, "utf8"))))(flags.expectations);
    const result = await evaluateNorthstarPreSlackExtractionV1({
      meetings: corpus.meetings,
      expectations: oracle,
      processor,
    });
    io.stdout(`${JSON.stringify({ ...result, evaluated_model: model })}\n`);
    return result.passed ? 0 : 1;
  } catch {
    return failed(io, "evaluation");
  }
}
