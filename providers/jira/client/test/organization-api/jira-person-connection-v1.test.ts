import { describe, expect, it } from "vitest";
import {
  PERSON_JIRA_CANCEL_PATH_V1,
  PERSON_JIRA_CONNECT_PATH_V1,
  PERSON_JIRA_DISCONNECT_PATH_V1,
  PERSON_JIRA_STATUS_PATH_V1,
  validatePersonJiraAttemptStatusV1,
  validatePersonJiraAttemptV1,
  validatePersonJiraCommandV1,
  validatePersonJiraConnectV1,
  validatePersonJiraStateV1,
} from "../../src/organization-api/jira-person-connection-v1.js";

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

describe("Person Jira connection contract V1", () => {
  it("uses the fixed Person-tool routes and documented closed shapes", () => {
    expect(PERSON_JIRA_CONNECT_PATH_V1).toBe("/v1/person/tools/jira/connect");
    expect(PERSON_JIRA_STATUS_PATH_V1).toBe("/v1/person/tools/jira/status");
    expect(PERSON_JIRA_CANCEL_PATH_V1).toBe("/v1/person/tools/jira/cancel");
    expect(PERSON_JIRA_DISCONNECT_PATH_V1).toBe("/v1/person/tools/jira/disconnect");
    expect(validatePersonJiraCommandV1({ schema_version: 1 })).toEqual({
      schema_version: 1,
    });
    expect(
      validatePersonJiraAttemptV1({ schema_version: 1, attempt: ATTEMPT }),
    ).toEqual({ schema_version: 1, attempt: ATTEMPT });
    expect(validatePersonJiraConnectV1(CONNECT)).toEqual(CONNECT);
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
      expect(validatePersonJiraAttemptStatusV1(status)).toEqual(status);
    }
    expect(validatePersonJiraStateV1({ schema_version: 1, connected: false }, false)).toEqual({
      schema_version: 1,
      connected: false,
    });
  });

  it("rejects extras, noncanonical attempts, unsafe links, and inconsistent status", () => {
    for (const [validate, value] of [
      [validatePersonJiraCommandV1, { schema_version: 1, extra: true }],
      [validatePersonJiraAttemptV1, { schema_version: 1, attempt: ATTEMPT, extra: true }],
      [validatePersonJiraConnectV1, { ...CONNECT, extra: true }],
      [validatePersonJiraAttemptStatusV1, { ...PENDING, extra: true }],
    ] as const) {
      expect(() => validate(value)).toThrow("unexpected shape");
    }
    expect(() =>
      validatePersonJiraStateV1(
        { schema_version: 1, connected: false, extra: true },
        false,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      validatePersonJiraAttemptV1({ schema_version: 1, attempt: "attempt-secret" }),
    ).toThrow("invalid");
    for (const link of [
      "http://connect.nango.dev/consent",
      "https://user:private@connect.nango.dev/consent",
      "https://connect.nango.dev/consent#private",
    ]) {
      expect(() =>
        validatePersonJiraConnectV1({ ...CONNECT, connect_link: link }),
      ).toThrow("invalid");
    }
    expect(() =>
      validatePersonJiraAttemptStatusV1({
        ...PENDING,
        failure_reason: "provider_rejected",
      }),
    ).toThrow("invalid");
    expect(() =>
      validatePersonJiraAttemptStatusV1({ ...PENDING, status: "failed" }),
    ).toThrow("invalid");
    expect(() => validatePersonJiraStateV1({ schema_version: 1, connected: true }, false)).toThrow(
      "invalid",
    );
  });

  it("never reflects an opaque connect locator in validation failures", () => {
    const locator = "https://connect.nango.dev/consent#opaque-private-locator";
    try {
      validatePersonJiraConnectV1({ ...CONNECT, connect_link: locator });
    } catch (error) {
      expect(String(error)).not.toContain(locator);
    }
  });
});
