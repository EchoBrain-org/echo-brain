import { createTelemetryVocabularyV1 } from "../../src/shared/telemetry-vocabulary-v1.js";

export const TELEMETRY_FIXTURE_VOCABULARY_V1 = createTelemetryVocabularyV1({
  providers: ["openrouter", "openai", "anthropic", "ollama"],
  models: ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v3.2"],
});
