import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSha256,
  sha256Digest,
} from "../src/canonical/canonical-json.js";

const MIXED_CASE_KEYS = {
  A_id: 1,
  a_id: 2,
  T0BFX: 3,
  t0bfx: 4,
  User: 5,
  user: 6,
};

const CODE_UNIT_ORDER =
  '{"A_id":1,"T0BFX":3,"User":5,"a_id":2,"t0bfx":4,"user":6}';

/** The ordering the replaced localeCompare fork would produce: the
 * differential oracle the code-unit pins below must diverge from. */
function localeOrdered(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right, "en-US"),
      ),
    ),
  );
}

describe("canonical JSON key ordering", () => {
  it("sorts mixed-case keys by code unit, not by localeCompare", () => {
    expect(canonicalJson(MIXED_CASE_KEYS)).toBe(CODE_UNIT_ORDER);
    expect(localeOrdered(MIXED_CASE_KEYS)).toBe(
      '{"a_id":2,"A_id":1,"t0bfx":4,"T0BFX":3,"user":6,"User":5}',
    );
    expect(canonicalJson(MIXED_CASE_KEYS)).not.toBe(
      localeOrdered(MIXED_CASE_KEYS),
    );
  });

  it("applies the same ordering to an object nested inside an array", () => {
    expect(canonicalJson([{ ...MIXED_CASE_KEYS }])).toBe(
      `[${CODE_UNIT_ORDER}]`,
    );
    expect(canonicalJson([{ ...MIXED_CASE_KEYS }])).not.toBe(
      `[${localeOrdered(MIXED_CASE_KEYS)}]`,
    );
  });

  it("emits identical bytes whatever the insertion order", () => {
    const reversed: Record<string, number> = {};
    for (const key of ["user", "User", "t0bfx", "T0BFX", "a_id", "A_id"]) {
      reversed[key] = MIXED_CASE_KEYS[key as keyof typeof MIXED_CASE_KEYS];
    }
    expect(Object.keys(reversed)).not.toEqual(Object.keys(MIXED_CASE_KEYS));
    expect(canonicalJson(reversed)).toBe(canonicalJson(MIXED_CASE_KEYS));
    expect(canonicalSha256(reversed)).toBe(canonicalSha256(MIXED_CASE_KEYS));
  });
});

describe("string digest semantics", () => {
  it("canonicalSha256 hashes the quoted string, sha256Digest the raw bytes", () => {
    expect(sha256Digest("identity-state:cat_example")).toBe(
      "sha256:054845ea1059c21ad6204d737272a09c1826f307d33310a33c37a7a8378c1142",
    );
    expect(canonicalSha256("identity-state:cat_example")).toBe(
      "sha256:2485f9060adee018a22982477380b5cb256658177795f17c1a80f37cf6c80c47",
    );
    expect(canonicalSha256("identity-state:cat_example")).not.toBe(
      sha256Digest("identity-state:cat_example"),
    );
    expect(canonicalSha256("identity-state:cat_example")).toBe(
      sha256Digest('"identity-state:cat_example"'),
    );
  });
});

describe("canonical JSON rejections", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  let deep: unknown = 1;
  for (let index = 0; index < 129; index += 1) deep = { n: deep };
  class Evidence {
    constructor(readonly method: string) {}
  }

  it.each([
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["an unpaired surrogate in a string value", { a: "x\udc00y" }],
    ["an unpaired surrogate in a key", { "\ud800": 1 }],
    ["a cycle", cyclic],
    ["nesting beyond depth 128", deep],
    ["a class instance", new Evidence("slack_auth_test")],
    ["undefined", { a: undefined }],
  ])("rejects %s with CanonicalJsonError", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("accepts nesting at exactly depth 128", () => {
    let value: unknown = 1;
    for (let index = 0; index < 128; index += 1) value = { n: value };
    expect(() => canonicalJson(value)).not.toThrow();
  });
});

/**
 * A fixture in the seven-key shape adapter bindings persist. The IDs are test
 * values, not a live row; the digest freezes the canonicalizer over the shape.
 * The scope pins below are live persisted values.
 */
const SLACK_PUBLIC_CONFIGURATION_SHAPE = {
  approve_reaction: "white_check_mark",
  channel_id: "C123CHANNEL",
  reject_reaction: "x",
  slack_app_id: "A123APP",
  slack_bot_id: "B123BOT",
  slack_bot_user_id: "U123BOT",
  slack_enterprise_id: null,
};

describe("golden pins", () => {
  it("freezes the public_configuration shape digest", () => {
    expect(canonicalSha256(SLACK_PUBLIC_CONFIGURATION_SHAPE)).toBe(
      "sha256:f784ef1cb7ad88fb5764d68495195abd8533dea1661c51a9cbc72fd8113714ed",
    );
  });

  it("reproduces the persisted granted_scopes digests", () => {
    expect(canonicalSha256(["users:read"])).toBe(
      "sha256:038753d0d9333f34d035d2c5eda8a0300767ac825232ec385ee2259a3dad1b77",
    );
    expect(
      canonicalSha256([
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "incoming-webhook",
        "reactions:read",
        "users:read",
      ]),
    ).toBe(
      "sha256:57f5e550938e0937c9aeba38451147bc294ccf254219dc07eff043be37d8e850",
    );
  });
});
