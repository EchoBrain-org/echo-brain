/**
 * The extraction model's own limits, from Anthropic's model table: both fixed processors run a Claude Sonnet model
 * (Claude Sonnet 4.6 through OpenRouter, Claude Sonnet 5.5 through a Claude account), and each reads a 1,000,000-token
 * context window and writes at most 128,000 tokens. Every extraction bound that depends on the model is computed from
 * these two numbers: the output allowance, the input a meeting may take, and a source's transcript keep.
 */
export const EXTRACTION_MODEL_CONTEXT_TOKENS_V1 = 1_000_000;
export const EXTRACTION_MODEL_MAX_OUTPUT_TOKENS_V1 = 128_000;
/** What one extraction call can read: the context window less the output allowance it keeps for the reply. */
export const EXTRACTION_MODEL_INPUT_TOKENS_V1 = EXTRACTION_MODEL_CONTEXT_TOKENS_V1 - EXTRACTION_MODEL_MAX_OUTPUT_TOKENS_V1;
