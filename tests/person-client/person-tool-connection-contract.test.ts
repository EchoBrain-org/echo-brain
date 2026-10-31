import { describe, expect, it } from "vitest";
import {
  validatePersonToolAttemptStatusV1,
  validatePersonToolAttemptV1,
  validatePersonToolCommandV1,
  validatePersonToolConnectV1,
  validatePersonToolStateV1,
} from "@echo-brain/organization-api";

// The display name only labels failures, so one tool covers every tool.
const name = "Jira";
const contract = {
  validatePersonCommandV1: (value: unknown) => validatePersonToolCommandV1(value, name),
  validatePersonAttemptV1: (value: unknown) => validatePersonToolAttemptV1(value, name),
  validatePersonConnectV1: (value: unknown) => validatePersonToolConnectV1(value, name),
  validatePersonAttemptStatusV1: (value: unknown) => validatePersonToolAttemptStatusV1(value, name),
  validatePersonStateV1: (value: unknown, connected: boolean) => validatePersonToolStateV1(value, connected, name),
};

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const CONNECT = {
  schema_version: 1,
  attempt: ATTEMPT,
  connect_link: "https://connect.nango.dev/consent?opaque=private",
  expires_at: "2026-10-01T01:30:00.000Z",
};
const PENDING = {
  schema_version: 1,
  attempt: ATTEMPT,
  expires_at: "2026-10-01T01:30:00.000Z",
  status: "pending",
  failure_reason: null,
};

describe("Person tool connection contract V1", () => {
  it("uses the documented closed shapes", () => {
    expect(contract.validatePersonCommandV1({ schema_version: 1 })).toEqual({
      schema_version: 1,
    });
    expect(
      contract.validatePersonAttemptV1({ schema_version: 1, attempt: ATTEMPT }),
    ).toEqual({ schema_version: 1, attempt: ATTEMPT });
    expect(contract.validatePersonConnectV1(CONNECT)).toEqual(CONNECT);
    for (const status of [
      PENDING,
      { ...PENDING, status: "complete" },
      { ...PENDING, status: "cancelled" },
      { ...PENDING, status: "expired" },
      {
        ...PENDING,
        status: "failed",
        failure_reason: "provider_rejected",
      },
      {
        ...PENDING,
        status: "failed",
        failure_reason: "provider_unavailable",
      },
      {
        ...PENDING,
        status: "failed",
        failure_reason: "account_mismatch",
      },
    ]) {
      expect(contract.validatePersonAttemptStatusV1(status)).toEqual(status);
    }
    expect(contract.validatePersonStateV1({ schema_version: 1, connected: false }, false)).toEqual({
      schema_version: 1,
      connected: false,
    });
  });

  it("rejects extras, noncanonical attempts, unsafe links, and inconsistent status", () => {
    for (const [validate, value] of [
      [contract.validatePersonCommandV1, { schema_version: 1, extra: true }],
      [contract.validatePersonAttemptV1, { schema_version: 1, attempt: ATTEMPT, extra: true }],
      [contract.validatePersonConnectV1, { ...CONNECT, extra: true }],
      [contract.validatePersonAttemptStatusV1, { ...PENDING, extra: true }],
    ] as const) {
      expect(() => validate(value)).toThrow("unexpected shape");
    }
    expect(() =>
      contract.validatePersonStateV1(
        { schema_version: 1, connected: false, extra: true },
        false,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      contract.validatePersonAttemptV1({ schema_version: 1, attempt: "attempt-secret" }),
    ).toThrow("invalid");
    for (const link of [
      "http://connect.nango.dev/consent",
      "https://user:private@connect.nango.dev/consent",
      "https://connect.nango.dev/consent#private",
    ]) {
      expect(() =>
        contract.validatePersonConnectV1({ ...CONNECT, connect_link: link }),
      ).toThrow("invalid");
    }
    expect(() =>
      contract.validatePersonAttemptStatusV1({
        ...PENDING,
        failure_reason: "provider_rejected",
      }),
    ).toThrow("invalid");
    expect(() =>
      contract.validatePersonAttemptStatusV1({ ...PENDING, status: "failed" }),
    ).toThrow("invalid");
    expect(() => contract.validatePersonStateV1({ schema_version: 1, connected: true }, false)).toThrow(
      "invalid",
    );
  });

  it("never reflects an opaque connect locator in validation failures", () => {
    const locator = "https://connect.nango.dev/consent#opaque-private-locator";
    try {
      contract.validatePersonConnectV1({ ...CONNECT, connect_link: locator });
    } catch (error) {
      expect(String(error)).not.toContain(locator);
    }
  });
});
