import { describe, expect, it } from "vitest";
import {
  PERSON_CONFLUENCE_CANCEL_PATH_V1,
  PERSON_CONFLUENCE_CONNECT_PATH_V1,
  PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
  PERSON_CONFLUENCE_STATUS_PATH_V1,
  validatePersonConfluenceAttemptStatusV1,
  validatePersonConfluenceAttemptV1,
  validatePersonConfluenceCommandV1,
  validatePersonConfluenceConnectV1,
  validatePersonConfluenceStateV1,
} from "../../src/organization-api/confluence-person-connection-v1.js";

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

describe("Person Confluence connection contract V1", () => {
  it("uses the fixed Person-tool routes and documented closed shapes", () => {
    expect(PERSON_CONFLUENCE_CONNECT_PATH_V1).toBe("/v1/person/tools/confluence/connect");
    expect(PERSON_CONFLUENCE_STATUS_PATH_V1).toBe("/v1/person/tools/confluence/status");
    expect(PERSON_CONFLUENCE_CANCEL_PATH_V1).toBe("/v1/person/tools/confluence/cancel");
    expect(PERSON_CONFLUENCE_DISCONNECT_PATH_V1).toBe("/v1/person/tools/confluence/disconnect");
    expect(validatePersonConfluenceCommandV1({ schema_version: 1 })).toEqual({
      schema_version: 1,
    });
    expect(
      validatePersonConfluenceAttemptV1({ schema_version: 1, attempt: ATTEMPT }),
    ).toEqual({ schema_version: 1, attempt: ATTEMPT });
    expect(validatePersonConfluenceConnectV1(CONNECT)).toEqual(CONNECT);
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
      expect(validatePersonConfluenceAttemptStatusV1(status)).toEqual(status);
    }
    expect(validatePersonConfluenceStateV1({ schema_version: 1, connected: false }, false)).toEqual({
      schema_version: 1,
      connected: false,
    });
  });

  it("rejects extras, noncanonical attempts, unsafe links, and inconsistent status", () => {
    for (const [validate, value] of [
      [validatePersonConfluenceCommandV1, { schema_version: 1, extra: true }],
      [validatePersonConfluenceAttemptV1, { schema_version: 1, attempt: ATTEMPT, extra: true }],
      [validatePersonConfluenceConnectV1, { ...CONNECT, extra: true }],
      [validatePersonConfluenceAttemptStatusV1, { ...PENDING, extra: true }],
    ] as const) {
      expect(() => validate(value)).toThrow("unexpected shape");
    }
    expect(() =>
      validatePersonConfluenceStateV1(
        { schema_version: 1, connected: false, extra: true },
        false,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      validatePersonConfluenceAttemptV1({ schema_version: 1, attempt: "attempt-secret" }),
    ).toThrow("invalid");
    for (const link of [
      "http://connect.nango.dev/consent",
      "https://user:private@connect.nango.dev/consent",
      "https://connect.nango.dev/consent#private",
    ]) {
      expect(() =>
        validatePersonConfluenceConnectV1({ ...CONNECT, connect_link: link }),
      ).toThrow("invalid");
    }
    expect(() =>
      validatePersonConfluenceAttemptStatusV1({
        ...PENDING,
        failure_reason: "provider_rejected",
      }),
    ).toThrow("invalid");
    expect(() =>
      validatePersonConfluenceAttemptStatusV1({ ...PENDING, status: "failed" }),
    ).toThrow("invalid");
    expect(() => validatePersonConfluenceStateV1({ schema_version: 1, connected: true }, false)).toThrow(
      "invalid",
    );
  });

  it("never reflects an opaque connect locator in validation failures", () => {
    const locator = "https://connect.nango.dev/consent#opaque-private-locator";
    try {
      validatePersonConfluenceConnectV1({ ...CONNECT, connect_link: locator });
    } catch (error) {
      expect(String(error)).not.toContain(locator);
    }
  });
});
