import { readFileSync } from 'node:fs';
import { createTelemetryVocabularyV1 } from '@echo-brain/organization-authority-kernel/shared/telemetry-vocabulary-v1';

/** The deployed writer and historical Explorer reader use the same provider-owned asset. */
export const OPENROUTER_TELEMETRY_VOCABULARY_V1 = createTelemetryVocabularyV1(
  JSON.parse(readFileSync(new URL('../assets/telemetry-vocabulary.v1.json', import.meta.url), 'utf8')),
);
