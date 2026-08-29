import { isAbsolute, resolve } from "node:path";
import { createOpenRouterStructuredOutput } from "../answer-composition/openrouter-structured-output.js";
import { readPrivateAuthorityCredential } from "../adapters/security/private-file-credentials.js";
import {
  createLlmDecisionProcessor,
} from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import type { DecisionProcessorAdapter } from "../processing/core/ports/adapters.js";
import {
  evaluateSyntheticMeetingQualityV1,
  phaseOneSyntheticExtractionExpectationsV1,
  type SyntheticMeetingQualityEvaluationV1,
} from "../quality/synthetic-meeting-quality-evaluator-v1.js";
import {
  loadSyntheticReplayMeetingsV1,
  SyntheticMeetingSourceAdapterV1,
} from "../quality/synthetic-meeting-fixture-v1.js";
import {
  CLEAN_LAYER4_MODEL_V1,
  CLEAN_LAYER4_PROVIDER_V1,
  CLEAN_LAYER4_TIMEOUT_MS_V1,
} from "./clean-person-answer-route.js";
import { fixedCleanLlmProcessorConfigV1 } from "./clean-live-llm-processor-config.js";

const USAGE =
  "usage: echo-organization-authority-synthetic-quality run " +
  "--corpus <absolute-path> --llm-credential-file <absolute-path>";

export interface SyntheticMeetingQualityCliIoV1 {
  readonly stdout: (line: string) => void;
}

const PROCESS_IO: SyntheticMeetingQualityCliIoV1 = {
  stdout: (line) => process.stdout.write(line),
};

type StructuredOutput = ReturnType<typeof createOpenRouterStructuredOutput>;

/** Narrow seams keep tests offline while the default command uses real adapters. */
export interface SyntheticMeetingQualityCliDependenciesV1 {
  readonly read_credential?: (reference: string) => string;
  readonly load_corpus?: typeof loadSyntheticReplayMeetingsV1;
  readonly create_processor?: (
    config: AdapterConfig,
    credential: string,
  ) => DecisionProcessorAdapter;
  readonly create_structured_output?: (
    credential_reference: string,
    credential: string,
  ) => StructuredOutput;
}

interface ParsedFlagsV1 {
  readonly corpus_path: string;
  readonly llm_credential_file: string;
}

function absolutePath(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(USAGE);
  }
  return value;
}

function parse(argv: readonly string[]): ParsedFlagsV1 {
  if (argv[0] !== "run" || argv.length !== 5) throw new Error(USAGE);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--corpus" && name !== "--llm-credential-file") ||
      value === undefined ||
      values.has(name)
    ) {
      throw new Error(USAGE);
    }
    values.set(name, value);
  }
  return Object.freeze({
    corpus_path: absolutePath(values.get("--corpus")),
    llm_credential_file: absolutePath(values.get("--llm-credential-file")),
  });
}

function assertValidProcessor(
  processor: DecisionProcessorAdapter,
  config: AdapterConfig,
): void {
  if (!processor.validateConfig(config).ok) {
    throw new Error("synthetic quality processor configuration is invalid");
  }
}

function failed(io: SyntheticMeetingQualityCliIoV1, failure: "usage" | "evaluation"): number {
  io.stdout(`${JSON.stringify({
    schema_version: 1,
    kind: "echo-synthetic-meeting-quality-evaluation-failed-v1",
    failure,
  })}\n`);
  return 2;
}

/**
 * Local-only composition for evaluating an invented replay corpus with the
 * same fixed OpenRouter models used by the clean runtime. It opens no state,
 * delivery, provider-source, or staging connection; OpenRouter is the sole
 * network dependency and its credential never appears in output.
 */
export async function runSyntheticMeetingQualityCommandV1(
  argv: readonly string[],
  io: SyntheticMeetingQualityCliIoV1 = PROCESS_IO,
  dependencies: SyntheticMeetingQualityCliDependenciesV1 = {},
): Promise<number> {
  let flags: ParsedFlagsV1;
  try {
    flags = parse(argv);
  } catch {
    return failed(io, "usage");
  }

  try {
    const credentialReference = `file:${flags.llm_credential_file}`;
    const credential = (dependencies.read_credential ?? readPrivateAuthorityCredential)(
      credentialReference,
    );
    const processorConfig = fixedCleanLlmProcessorConfigV1(
      "synthetic-quality-eval",
      credentialReference,
    );
    const processor = dependencies.create_processor === undefined
      ? createLlmDecisionProcessor(processorConfig, {
          credentialResolver: (reference) =>
            reference === credentialReference ? credential : undefined,
        })
      : dependencies.create_processor(processorConfig, credential);
    assertValidProcessor(processor, processorConfig);
    const createStructuredOutput = dependencies.create_structured_output ??
      ((reference: string, resolvedCredential: string) =>
        createOpenRouterStructuredOutput({
          credential_ref: reference,
          credential_resolver: (candidate) =>
            candidate === reference ? resolvedCredential : undefined,
        }));
    const model = createStructuredOutput(credentialReference, credential);
    const meetings = await (dependencies.load_corpus ?? loadSyntheticReplayMeetingsV1)(
      flags.corpus_path,
    );
    const result: SyntheticMeetingQualityEvaluationV1 =
      await evaluateSyntheticMeetingQualityV1({
        source: new SyntheticMeetingSourceAdapterV1(meetings),
        processor,
        extraction_expectations: phaseOneSyntheticExtractionExpectationsV1,
        planner: model,
        answerer: model,
        provider: CLEAN_LAYER4_PROVIDER_V1,
        planner_model: CLEAN_LAYER4_MODEL_V1,
        answer_model: CLEAN_LAYER4_MODEL_V1,
        timeout_ms: CLEAN_LAYER4_TIMEOUT_MS_V1,
      });
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.passed ? 0 : 1;
  } catch {
    return failed(io, "evaluation");
  }
}
