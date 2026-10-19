import { createTelemetryVocabularyV1 } from "@echo-brain/organization-authority-kernel/shared/telemetry-vocabulary-v1";

export const TELEMETRY_FIXTURE_VOCABULARY_V1 = createTelemetryVocabularyV1({
  providers: ["openrouter", "openai", "anthropic", "ollama"],
  models: ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5.5", "deepseek/deepseek-v3.2"],
});
