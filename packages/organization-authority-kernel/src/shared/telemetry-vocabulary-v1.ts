/** Finite deployment configuration, never learned from requests or responses. */
export interface TelemetryVocabularyV1 {
  readonly providers: readonly string[];
  readonly models: readonly string[];
}

function labels(values: readonly string[], maximum: number): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum ||
      values.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(value))) {
    throw new TypeError("invalid bounded telemetry vocabulary");
  }
  const admitted = [...new Set([...values, "other"])];
  if (admitted.length > maximum) throw new TypeError("invalid bounded telemetry vocabulary");
  return Object.freeze(admitted);
}

export function createTelemetryVocabularyV1(input: TelemetryVocabularyV1): TelemetryVocabularyV1 {
  return Object.freeze({ providers: labels(input.providers, 8), models: labels(input.models, 16) });
}

export const EMPTY_TELEMETRY_VOCABULARY_V1 = createTelemetryVocabularyV1({ providers: [], models: [] });

export function telemetryLabelV1(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "other";
}
