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
 * meeting text. The Authority V14 CHECK on
 * authority_live_source_held_extractions_v1.failure_stage lists exactly these values in order.
 * The last three come from the attempt ledger, not from an error.
 */
export const EXTRACTION_FAILURE_STAGES_V1 = [
  ...EXTRACTION_GROUNDING_FAILURE_STAGES,
  ...EXTRACTION_SCHEMA_FAILURE_STAGES.map(stage => `schema_${stage}` as const),
  'output_json',
  'output_contract',
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
  return error.message === EXTRACTION_OUTPUT_JSON_FAILURE_MESSAGE ? 'output_json' : error.code;
}
