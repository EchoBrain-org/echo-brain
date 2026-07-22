import { describe, expect, it } from "vitest";
import { assertExactFounderBootstrapSessionShape } from "../../../src/product/federation/bootstrap/bootstrap-session-exact-shape.js";
import {
  completeBootstrapSessionShapeFixture as completeSession,
  exactSessionBindings as fullBindings,
  EXACT_SESSION_AT as AT,
  setFixturePath as setAtPath,
  type JsonRecord,
} from "./fixtures/founder-identity.js";

function cloneSession(): JsonRecord {
  return structuredClone(completeSession());
}

type MutationCase = readonly [
  name: string,
  path: readonly (string | number)[],
  value: unknown,
];

const POISON_FIXTURES = [
  [
    "credential token",
    ["request", "connection_seeds", 0, "credential_guard", "token"],
    "xoxb-secret",
  ],
  [
    "raw nonce on challenge ticket",
    ["challenge", "raw_nonce"],
    "one-time-secret",
  ],
  [
    "raw nonce in verification evidence",
    ["verification", "evidence_input", "challenge", "nonce"],
    "one-time-secret",
  ],
  [
    "Granola notes",
    ["provider_observations", "granola", "evidence", "notes"],
    [{ id: "not-secret-but-not-allowed" }],
  ],
  [
    "Granola title",
    ["provider_observations", "granola", "evidence", "title"],
    "Private meeting title",
  ],
  [
    "Granola owner",
    ["provider_observations", "granola", "evidence", "owner"],
    { name: "Employee" },
  ],
  [
    "Granola transcript",
    ["provider_observations", "granola", "evidence", "transcript"],
    "Raw meeting transcript",
  ],
  [
    "signing private key",
    ["signing_key", "private_key"],
    "private-key-material",
  ],
  ["integrity secret", ["integrity", "secret"], "hidden-material"],
  [
    "adapter configuration api_key",
    ["request", "bindings", 0, "configuration_snapshot", "api_key"],
    "granola-secret",
  ],
  [
    "provider raw response inside the committed registry",
    [
      "commit",
      "plan",
      "registry",
      "connections",
      0,
      "generations",
      0,
      "provider_identity",
      "raw_response",
    ],
    { token: "provider-secret" },
  ],
  [
    "temporal field in the founder-confirmed binding summary",
    ["confirmation", "summary", "configuration", "bindings", 0, "created_at"],
    AT,
  ],
  [
    "activation timestamp in the founder-confirmed cutover summary",
    ["confirmation", "summary", "cutover", "activation_at"],
    AT,
  ],
  [
    "meeting content on the completion result",
    ["result", "meeting"],
    { title: "Not completion evidence" },
  ],
] as const satisfies readonly MutationCase[];

describe("Founder bootstrap persisted-session exact shape", () => {
  it("accepts the complete Founder Live session shape", () => {
    expect(() =>
      assertExactFounderBootstrapSessionShape(completeSession()),
    ).not.toThrow();
  });

  it.each(POISON_FIXTURES)("rejects %s", (_name, path, value) => {
    const session = cloneSession();
    setAtPath(session, path, value);
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /unsupported key/,
    );
  });

  it.each([
    "https://token@example.test/v1",
    "https://example.test/v1?token=secret",
    "https://example.test/v1#secret",
  ])("rejects a Granola base URL carrying authority data: %s", (baseUrl) => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 0, "configuration_snapshot", "base_url"],
      baseUrl,
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /must not contain credentials, query, or hash/,
    );
  });

  it("accepts the other finite bundled adapter configuration shapes", () => {
    const llm = cloneSession();
    setAtPath(llm, ["request", "bindings", 1, "adapter_id"], "llm");
    setAtPath(llm, ["request", "bindings", 1, "configuration_snapshot"], {
      model: "qwen3:4b",
      base_url: "http://127.0.0.1:11434",
      request_timeout_ms: 240_000,
      prompt_version: "decision-extraction-v2",
      output_schema_version: "decision-extraction-schema-v2",
    });
    expect(() => assertExactFounderBootstrapSessionShape(llm)).not.toThrow();

    const missingPromptVersion = JSON.parse(JSON.stringify(llm)) as JsonRecord;
    const missingLlmSnapshot = (
      (missingPromptVersion["request"] as JsonRecord)[
        "bindings"
      ] as JsonRecord[]
    )[1]!["configuration_snapshot"] as JsonRecord;
    delete missingLlmSnapshot["prompt_version"];
    expect(() =>
      assertExactFounderBootstrapSessionShape(missingPromptVersion),
    ).toThrow(/prompt_version/);

    const wrongPromptVersion = JSON.parse(JSON.stringify(llm)) as JsonRecord;
    const wrongLlmSnapshot = (
      (wrongPromptVersion["request"] as JsonRecord)["bindings"] as JsonRecord[]
    )[1]!["configuration_snapshot"] as JsonRecord;
    wrongLlmSnapshot["prompt_version"] = "operator-supplied";
    expect(() =>
      assertExactFounderBootstrapSessionShape(wrongPromptVersion),
    ).toThrow(/unsupported value/);

    const missingSchemaVersion = JSON.parse(JSON.stringify(llm)) as JsonRecord;
    const missingSchemaSnapshot = (
      (missingSchemaVersion["request"] as JsonRecord)[
        "bindings"
      ] as JsonRecord[]
    )[1]!["configuration_snapshot"] as JsonRecord;
    delete missingSchemaSnapshot["output_schema_version"];
    expect(() =>
      assertExactFounderBootstrapSessionShape(missingSchemaVersion),
    ).toThrow(/output_schema_version/);

    const jsonl = cloneSession();
    setAtPath(jsonl, ["request", "bindings", 2, "adapter_id"], "jsonl-outbox");
    setAtPath(jsonl, ["request", "bindings", 2, "configuration_snapshot"], {
      path: "/private/echo/outbox.jsonl",
      destination_id: "local",
    });
    expect(() => assertExactFounderBootstrapSessionShape(jsonl)).not.toThrow();
  });

  it("requires an exact one-person Slack reviewer snapshot", () => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 3, "configuration_snapshot", "reviewer", "token"],
      "xoxb-secret",
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /reviewer has unsupported key 'token'/,
    );
  });

  it("rejects adapters outside the finite bundled Founder Live set", () => {
    const session = cloneSession();
    setAtPath(
      session,
      ["request", "bindings", 1, "adapter_id"],
      "remote-processor",
    );
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /outside the bundled Founder Live set/,
    );
  });

  it("caps the persisted binding snapshot", () => {
    const session = cloneSession();
    const excessive = Array.from({ length: 33 }, () =>
      structuredClone(fullBindings()[0]),
    );
    setAtPath(session, ["request", "bindings"], excessive);
    expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
      /between 4 and 32 items/,
    );
  });

  it.each([
    ["connection seed count", ["request", "connection_seeds"], []],
    ["binding count", ["request", "bindings"], []],
    ["audience count", ["request", "publication", "audience", "subjects"], []],
    [
      "identity claim count",
      ["commit", "plan", "manifest", "identity_claims"],
      [],
    ],
    ["connection count", ["commit", "plan", "registry", "connections"], []],
    [
      "connection generation count",
      ["commit", "plan", "registry", "connections", 0, "generations"],
      [],
    ],
    [
      "native record requirement count",
      [
        "commit",
        "plan",
        "manifest",
        "legacy_cutover",
        "native_records_require",
      ],
      [],
    ],
  ] satisfies readonly MutationCase[])(
    "bounds the Founder Live %s",
    (_name, path, value) => {
      const session = cloneSession();
      setAtPath(session, path, value);
      expect(() => assertExactFounderBootstrapSessionShape(session)).toThrow(
        /must contain between/,
      );
    },
  );
});
