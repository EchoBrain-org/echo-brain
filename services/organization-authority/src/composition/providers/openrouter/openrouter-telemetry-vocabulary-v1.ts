import { createTelemetryVocabularyV1 } from "../../../shared/telemetry-vocabulary-v1.js";

/** Configured transport and model provenance owned by this provider. */
export const OPENROUTER_TELEMETRY_VOCABULARY_V1 = createTelemetryVocabularyV1({
  providers: ["openrouter"],
  models: ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v3.2"],
});
