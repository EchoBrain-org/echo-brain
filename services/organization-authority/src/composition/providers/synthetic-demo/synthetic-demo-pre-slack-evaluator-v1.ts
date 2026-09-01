import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readPrivateAuthorityCredential } from "../../../adapters/security/private-file-credentials.js";
import {
  createLlmDecisionProcessor,
  extractionGroundingFailureStage,
  extractionSchemaFailureStage,
  type ExtractionGroundingFailureStage,
  type ExtractionSchemaFailureStage,
} from "../../../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingDocument,
} from "../../../processing/core/contracts/validation.js";
import type { ExtractedSignal } from "../../../processing/core/contracts/decision.js";
import type { MeetingDocument } from "../../../processing/core/contracts/meeting.js";
import {
  AdapterError,
  type AdapterConfig,
  type AdapterErrorCode,
} from "../../../processing/core/contracts/adapter.js";
import type { DecisionProcessorAdapter } from "../../../processing/core/ports/adapters.js";
import {
  loadSyntheticDemoMeetingCorpusV1,
  syntheticDemoMeetingSourceIdentityV1,
} from "../../../processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";
import {
  fixedOpenRouterDecisionProcessorConfigV1,
  OPENROUTER_DECISION_PROCESSOR_MODEL_V1,
} from "../openrouter/openrouter-decision-processor-config-v1.js";

export const NORTHSTAR_PRE_SLACK_QUALIFICATION_MODEL_V1 =
  OPENROUTER_DECISION_PROCESSOR_MODEL_V1;

const USAGE =
  "usage: node demo/evaluate-pre-slack.mjs " +
  "run --meetings-dir <absolute-path> --expectations <absolute-path> " +
  "--llm-credential-file <absolute-path> [--model <author/model-slug>]";

interface ExpectedSignalV1 {
  readonly kind: "decision" | "action" | "rationale";
  readonly evidence_block_ids: readonly string[];
  readonly required_text_clauses: readonly (readonly string[])[];
  readonly due_date?: string;
}

interface ExpectedMeetingV1 {
  readonly meeting_id: string;
  readonly required_decisions: readonly ExpectedSignalV1[];
  readonly required_actions: readonly ExpectedSignalV1[];
  readonly required_rationales: readonly ExpectedSignalV1[];
  readonly must_not_be_current_decisions: readonly ExpectedSignalV1[];
}

export interface NorthstarPreSlackFindingV1 {
  readonly meeting_id: string;
  readonly expected_evidence_block_ids: readonly string[];
  readonly actual_evidence_block_ids?: readonly string[];
  readonly expected_value?: string;
  readonly actual_value?: string | null;
}

export interface NorthstarPreSlackEvaluationV1 {
  readonly schema_version: 1;
  readonly kind: "echo-synthetic-demo-pre-slack-evaluation-v1";
  readonly processed_meeting_count: number;
  /** U2 is intentionally absent: transcript-derived decision attribution is retired. */
  readonly u1_due_dates: readonly NorthstarPreSlackFindingV1[];
  readonly u3_complete_evidence: readonly NorthstarPreSlackFindingV1[];
  readonly u4_status_guards: readonly NorthstarPreSlackFindingV1[];
  /** U5 is intentionally absent: action assignment is deferred to PM tools. */
  readonly u6_required_coverage: readonly NorthstarPreSlackFindingV1[];
  /** Safe failures at the LLM/extraction boundary; never contains model output. */
  readonly extraction_failures: readonly NorthstarPreSlackExtractionFailureV1[];
  readonly passed: boolean;
}

export interface NorthstarPreSlackExtractionFailureV1 {
  readonly meeting_id: string | null;
  readonly step:
    | "decision_processor.health_check"
    | "decision_processor.extract"
    | "canonical_decision_set_validation";
  readonly reason:
    | "health_check_failed"
    | "invalid_json"
    | "invalid_schema"
    | "invalid_grounding"
    | "processor_failure";
  readonly code?: AdapterErrorCode;
  /** Allowlisted local parser stage; never model output or source text. */
  readonly schema_stage?: ExtractionSchemaFailureStage;
  /** Allowlisted local grounding check; never model output or source text. */
  readonly grounding_stage?: ExtractionGroundingFailureStage;
}

export interface NorthstarPreSlackEvaluatorInputV1 {
  readonly meetings: readonly MeetingDocument[];
  readonly expectations: unknown;
  readonly processor: DecisionProcessorAdapter;
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function requiredTextClauses(value: unknown): readonly (readonly string[])[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || !value.every((clause) => strings(clause) && clause.length > 0)) {
    throw new Error("Northstar expectations contain invalid required text clauses");
  }
  return Object.freeze(value.map((clause) => Object.freeze([...clause])));
}

function expectedSignal(value: unknown, kind: ExpectedSignalV1["kind"]): ExpectedSignalV1 {
  if (!isObject(value) || !strings(value.evidence_block_ids)) {
    throw new Error("Northstar expectations contain an invalid expected signal");
  }
  if (
    (kind === "action" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value.due_date))) ||
    (kind !== "action" && value.due_date !== undefined)
  ) {
    throw new Error("Northstar expectations contain an invalid expected signal");
  }
  return Object.freeze({
    kind,
    evidence_block_ids: Object.freeze([...value.evidence_block_ids]),
    required_text_clauses: requiredTextClauses(value.required_text_clauses),
    ...(typeof value.due_date === "string" ? { due_date: value.due_date } : {}),
  });
}

function expectations(value: unknown): readonly ExpectedMeetingV1[] {
  if (!isObject(value) || !Array.isArray(value.meeting_expectations)) {
    throw new Error("Northstar expectations must contain meeting_expectations");
  }
  const seen = new Set<string>();
  return Object.freeze(value.meeting_expectations.map((item) => {
    if (!isObject(item) || typeof item.meeting_id !== "string" || seen.has(item.meeting_id)) {
      throw new Error("Northstar expectations contain an invalid or duplicate meeting");
    }
    seen.add(item.meeting_id);
    const field = (name: string, kind: ExpectedSignalV1["kind"]): readonly ExpectedSignalV1[] => {
      if (!Array.isArray(item[name])) throw new Error("Northstar expectations contain an invalid signal list");
      return Object.freeze(item[name].map((signal) => expectedSignal(signal, kind)));
    };
    return Object.freeze({
      meeting_id: item.meeting_id,
      required_decisions: field("required_decisions", "decision"),
      required_actions: field("required_actions", "action"),
      required_rationales: field("required_rationales", "rationale"),
      must_not_be_current_decisions: field("must_not_be_current_decisions", "decision"),
    });
  }));
}

function evidenceIds(signal: ExtractedSignal): readonly string[] {
  return Object.freeze(signal.evidence.map((evidence) => evidence.block_id));
}

function overlap(expected: readonly string[], actual: readonly string[]): number {
  const actualSet = new Set(actual);
  return expected.filter((id) => actualSet.has(id)).length;
}

function includesExpectedEvidence(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((value) => actual.includes(value));
}

function bestCandidate(
  expected: ExpectedSignalV1,
  signals: readonly ExtractedSignal[],
  usedSignalIds: ReadonlySet<string>,
): ExtractedSignal | undefined {
  const candidates = signals
    .filter((signal) => signal.kind === expected.kind && !usedSignalIds.has(signal.id))
    .map((signal) => {
      const observed = normalizedText(signal.text);
      const matchedPhrases = expected.required_text_clauses
        .flat()
        .filter((phrase) => observed.includes(normalizedText(phrase))).length;
      return {
        signal,
        completeText: hasRequiredTextClauses(signal.text, expected.required_text_clauses),
        matchedPhrases,
        overlap: overlap(expected.evidence_block_ids, evidenceIds(signal)),
      };
    })
    .filter((candidate) => candidate.overlap > 0)
    .sort((left, right) =>
      Number(right.completeText) - Number(left.completeText) ||
      right.matchedPhrases - left.matchedPhrases ||
      right.overlap - left.overlap ||
      left.signal.id.localeCompare(right.signal.id),
    );
  return candidates[0]?.signal;
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function localDate(timestamp: string, timezone: string | undefined): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year === undefined || month === undefined || day === undefined
      ? parsed.toISOString().slice(0, 10)
      : `${year}-${month}-${day}`;
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

function hasRequiredTextClauses(actual: string, clauses: readonly (readonly string[])[]): boolean {
  const observed = normalizedText(actual);
  return clauses.every((clause) => clause.every((phrase) => observed.includes(normalizedText(phrase))));
}

function finding(
  meeting_id: string,
  expected: ExpectedSignalV1,
  actual?: ExtractedSignal,
  expected_value?: string,
  actual_value?: string | null,
): NorthstarPreSlackFindingV1 {
  return Object.freeze({
    meeting_id,
    expected_evidence_block_ids: Object.freeze([...expected.evidence_block_ids]),
    ...(actual === undefined ? {} : { actual_evidence_block_ids: evidenceIds(actual) }),
    ...(expected_value === undefined ? {} : { expected_value }),
    ...(actual_value === undefined ? {} : { actual_value }),
  });
}

function safeFailure(
  meeting_id: string | null,
  step: NorthstarPreSlackExtractionFailureV1["step"],
  error?: unknown,
): NorthstarPreSlackExtractionFailureV1 {
  const code = error instanceof AdapterError ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  const schemaStage = extractionSchemaFailureStage(error);
  const groundingStage = extractionGroundingFailureStage(error);
  const reason: NorthstarPreSlackExtractionFailureV1["reason"] =
    step === "decision_processor.health_check"
      ? "health_check_failed"
      : message === "LLM output was not valid JSON"
        ? "invalid_json"
        : schemaStage !== undefined || message === "LLM output did not match the extraction schema"
          ? "invalid_schema"
          : groundingStage !== undefined || message === "LLM output contained invalid or unsupported signal grounding"
            ? "invalid_grounding"
            : step === "canonical_decision_set_validation"
              ? "invalid_schema"
              : "processor_failure";
  return Object.freeze({
    meeting_id,
    step,
    reason,
    ...(code === undefined ? {} : { code }),
    ...(schemaStage === undefined ? {} : { schema_stage: schemaStage }),
    ...(groundingStage === undefined ? {} : { grounding_stage: groundingStage }),
  });
}

function passed(result: Omit<NorthstarPreSlackEvaluationV1, "passed">): boolean {
  return result.extraction_failures.length === 0 &&
    result.u1_due_dates.length === 0 &&
    result.u3_complete_evidence.length === 0 &&
    result.u4_status_guards.length === 0 &&
    result.u6_required_coverage.length === 0;
}

function evaluationWithFailure(
  failure: NorthstarPreSlackExtractionFailureV1,
): NorthstarPreSlackEvaluationV1 {
  const result = {
    schema_version: 1 as const,
    kind: "echo-synthetic-demo-pre-slack-evaluation-v1" as const,
    processed_meeting_count: 0,
    u1_due_dates: Object.freeze([]),
    u3_complete_evidence: Object.freeze([]),
    u4_status_guards: Object.freeze([]),
    u6_required_coverage: Object.freeze([]),
    extraction_failures: Object.freeze([failure]),
  };
  return Object.freeze({ ...result, passed: passed(result) });
}

/**
 * No-write Northstar oracle for the extraction boundary. It deliberately
 * validates canonical inputs and decision sets, but does not open state,
 * Slack, V4, retrieval, or answer composition.
 */
export async function evaluateNorthstarPreSlackExtractionV1(
  input: NorthstarPreSlackEvaluatorInputV1,
): Promise<NorthstarPreSlackEvaluationV1> {
  const expectedMeetings = expectations(input.expectations);
  if (expectedMeetings.length !== 4 || input.meetings.length !== 4) {
    throw new Error("Northstar pre-Slack evaluation requires exactly four meetings");
  }
  const expectedById = new Map(expectedMeetings.map((item) => [item.meeting_id, item]));
  const seen = new Set<string>();
  const u1: NorthstarPreSlackFindingV1[] = [];
  const u3: NorthstarPreSlackFindingV1[] = [];
  const u4: NorthstarPreSlackFindingV1[] = [];
  const u6: NorthstarPreSlackFindingV1[] = [];
  const extractionFailures: NorthstarPreSlackExtractionFailureV1[] = [];

  for (const meeting of input.meetings) {
    assertCanonicalMeetingDocument(meeting, syntheticDemoMeetingSourceIdentityV1);
    const expectedMeeting = expectedById.get(meeting.id);
    if (expectedMeeting === undefined || seen.has(meeting.id)) {
      throw new Error("Northstar pre-Slack evaluation received an unexpected meeting");
    }
    seen.add(meeting.id);
    let decisions;
    try {
      decisions = await input.processor.extract(meeting, {
        processor_version: input.processor.identity.version,
        input_fingerprint: `northstar-pre-slack:${meeting.id}`,
      });
    } catch (error) {
      extractionFailures.push(safeFailure(meeting.id, "decision_processor.extract", error));
      continue;
    }
    try {
      assertCanonicalDecisionSet(decisions, meeting, input.processor.identity);
    } catch (error) {
      extractionFailures.push(safeFailure(meeting.id, "canonical_decision_set_validation", error));
      continue;
    }

    const required = [
      ...expectedMeeting.required_decisions,
      ...expectedMeeting.required_actions,
      ...expectedMeeting.required_rationales,
    ];
    const usedSignalIds = new Set<string>();
    for (const expected of required) {
      const actual = bestCandidate(expected, decisions.signals, usedSignalIds);
      if (actual === undefined) {
        u6.push(finding(meeting.id, expected));
        continue;
      }
      usedSignalIds.add(actual.id);
      if (!hasRequiredTextClauses(actual.text, expected.required_text_clauses)) {
        u6.push(finding(
          meeting.id,
          expected,
          actual,
          expected.required_text_clauses.map((clause) => clause.join(" + ")).join("; "),
          actual.text,
        ));
        continue;
      }
      if (!includesExpectedEvidence(evidenceIds(actual), expected.evidence_block_ids)) {
        u3.push(finding(meeting.id, expected, actual));
      }
      if (expected.kind === "decision" && actual.kind === "decision" && actual.status !== "decided") {
        u4.push(finding(meeting.id, expected, actual, "decided", actual.status));
      }
      if (expected.kind === "action") {
        const action = actual as Extract<ExtractedSignal, { kind: "action" }>;
        const expectedDate = expected.due_date!;
        const actualDate = action.due_at === null
          ? null
          : localDate(action.due_at, meeting.time?.timezone);
        if (actualDate !== expectedDate) {
          u1.push(finding(meeting.id, expected, actual, expectedDate, actualDate));
        }
      }
    }
    for (const forbidden of expectedMeeting.must_not_be_current_decisions) {
      const forbiddenEvidence = new Set(forbidden.evidence_block_ids);
      const actual = decisions.signals.find((signal) => {
        if (signal.kind !== "decision" || signal.status !== "decided") return false;
        const actualEvidence = evidenceIds(signal);
        const citesForbiddenEvidence = actualEvidence.some((id) => forbiddenEvidence.has(id));
        return citesForbiddenEvidence &&
          (!usedSignalIds.has(signal.id) ||
            hasRequiredTextClauses(signal.text, forbidden.required_text_clauses));
      });
      if (actual !== undefined) u4.push(finding(meeting.id, forbidden, actual, "not decided", "decided"));
    }
  }
  if (seen.size !== expectedById.size) {
    throw new Error("Northstar expectations did not match every evaluated meeting");
  }
  const result = {
    schema_version: 1 as const,
    kind: "echo-synthetic-demo-pre-slack-evaluation-v1" as const,
    processed_meeting_count: seen.size,
    u1_due_dates: Object.freeze(u1),
    u3_complete_evidence: Object.freeze(u3),
    u4_status_guards: Object.freeze(u4),
    u6_required_coverage: Object.freeze(u6),
    extraction_failures: Object.freeze(extractionFailures),
  };
  return Object.freeze({
    ...result,
    passed: passed(result),
  });
}

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
      ? createLlmDecisionProcessor(
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
      const result = evaluationWithFailure(safeFailure(null, "decision_processor.health_check", error));
      io.stdout(`${JSON.stringify({ ...result, evaluated_model: model })}\n`);
      return 1;
    }
    if (health.status !== "healthy") {
      const result = evaluationWithFailure(safeFailure(null, "decision_processor.health_check"));
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
