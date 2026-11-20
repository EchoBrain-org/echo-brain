import { AdapterError } from '../core/contracts/adapter.js';
import {
  EXTRACTION_GROUNDING_FAILURE_STAGES,
  EXTRACTION_OUTPUT_JSON_FAILURE_MESSAGE,
  EXTRACTION_SCHEMA_FAILURE_STAGES,
  extractionGroundingFailureStage,
  extractionSchemaFailureStage,
} from '../llm/llm-decision-processor.js';
import { EXTRACTION_ATTEMPT_FAILURE_CODES_V1 } from './extraction-attempt-store-v1.js';

/**
 * Why a held meeting's extraction failed. Structural codes only, never model output or
 * meeting text. The Authority V18 CHECK on
 * authority_live_source_held_extractions_v1.failure_stage lists exactly these values in order.
 * The last three come from the attempt ledger, not from an error.
 */
export const EXTRACTION_FAILURE_STAGES_V1 = [
  ...EXTRACTION_GROUNDING_FAILURE_STAGES,
  ...EXTRACTION_SCHEMA_FAILURE_STAGES.map(stage => `schema_${stage}` as const),
  'output_json',
  'output_contract',
  // The model's reply reached its own output limit: the meeting is too long for one extraction pass.
  'output_too_long',
  // The prompt passed the model's own context window: the meeting is too long for one extraction call.
  'input_too_long',
  ...EXTRACTION_ATTEMPT_FAILURE_CODES_V1,
  'interrupted',
  'output_not_saved',
  'not_recorded',
] as const;
export type ExtractionFailureStageV1 = typeof EXTRACTION_FAILURE_STAGES_V1[number];

export interface ExtractionFailureContextV1 {
  readonly aborted: boolean;
  /** The processor returned output, which then failed the canonical decision-set contract. */
  readonly received_output: boolean;
}

/** Pure: maps a failed extraction to an allowlisted stage and never returns error text. */
export function classifyExtractionFailureStageV1(
  error: unknown,
  context: ExtractionFailureContextV1,
): ExtractionFailureStageV1 {
  if (context.aborted) return 'cancelled';
  if (context.received_output) return 'output_contract';
  const grounding = extractionGroundingFailureStage(error);
  if (grounding !== undefined) return grounding;
  const schema = extractionSchemaFailureStage(error);
  if (schema !== undefined) return `schema_${schema}`;
  if (!(error instanceof AdapterError)) return 'unknown';
  // Read structurally: this layer may not import the provider port (llm-provider.ts).
  if ((error as { readonly observation?: { readonly stopReason?: unknown } }).observation?.stopReason === 'length') return 'output_too_long';
  if (error.name === 'ExtractionInputTooLongError') return 'input_too_long';
  return error.message === EXTRACTION_OUTPUT_JSON_FAILURE_MESSAGE ? 'output_json' : error.code;
}

/**
 * True only when a failed extraction earns its one free retry: it provably cost nothing (the processor adapter
 * declared the refusal unbilled, AdapterError.unbilled, and no output arrived) and the same request could succeed
 * later (AdapterError.retryable). A timeout, a transport failure, a cancel or any received output may have been
 * billed; a permanent refusal such as a meeting past the model's context window would be refused again.
 */
export function freeRetryExtractionFailureV1(error: unknown, context: ExtractionFailureContextV1): boolean {
  return !context.aborted && !context.received_output && error instanceof AdapterError && error.unbilled && error.retryable;
}
