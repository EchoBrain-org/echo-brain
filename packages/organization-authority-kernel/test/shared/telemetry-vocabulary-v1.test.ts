import { describe, expect, it } from "vitest";
import { createTelemetryVocabularyV1 } from "../../src/shared/telemetry-vocabulary-v1.js";
import { observeCoreModelMetadataV1, observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../src/shared/core-runtime-observation-v1.js";

describe("deployment telemetry vocabulary", () => {
  it("snapshots configuration, caps the final label set, and accepts its own normalized output", () => {
    const providers = ["fixture"];
    const vocabulary = createTelemetryVocabularyV1({ providers, models: ["model"] });
    providers.push("request-content");
    expect(vocabulary.providers).toEqual(["fixture", "other"]);
    expect(Object.isFrozen(vocabulary.providers)).toBe(true);
    const maximum = createTelemetryVocabularyV1({ providers: Array.from({ length: 7 }, (_, i) => `p${i}`), models: [] });
    expect(createTelemetryVocabularyV1(maximum)).toEqual(maximum);
    expect(() => createTelemetryVocabularyV1({ providers: Array.from({ length: 8 }, (_, i) => `p${i}`), models: [] })).toThrow("bounded");
    expect(() => createTelemetryVocabularyV1({ providers: [], models: ["private prompt"] })).toThrow("bounded");
    expect(() => createTelemetryVocabularyV1({ providers: [], models: Array.from({ length: 16 }, (_, i) => `m${i}`) })).toThrow("bounded");
  });

  it("isolates concurrent provider scopes and never learns labels from model responses", async () => {
    const observations: CoreRuntimeObservationV1[] = [];
    await Promise.all(["fixture-a", "fixture-b"].map((provider) => observeCoreRuntimeV1("model_call", async () => {
      await Promise.resolve();
      observeCoreModelMetadataV1({ provider, model: "untrusted-response-content" });
    }, { vocabulary: { providers: [provider], models: [] }, observer: (event) => { observations.push(event); } })));
    expect(observations.filter((event) => event.event === "succeeded").map(({ provider, model }) => ({ provider, model })))
      .toEqual([{ provider: "fixture-a", model: "other" }, { provider: "fixture-b", model: "other" }]);
  });
});
