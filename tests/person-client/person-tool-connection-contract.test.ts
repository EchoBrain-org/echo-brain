import { describe, expect, it } from "vitest";
import * as jira from "@echo-brain/provider-jira-client/organization-api/jira-person-connection-v1";
import * as confluence from "@echo-brain/provider-confluence-client/organization-api/confluence-person-connection-v1";

const contracts = [
  { id: "jira", name: "Jira",
    validatePersonCommandV1: jira.validatePersonJiraCommandV1,
    validatePersonAttemptV1: jira.validatePersonJiraAttemptV1,
    validatePersonConnectV1: jira.validatePersonJiraConnectV1,
    validatePersonAttemptStatusV1: jira.validatePersonJiraAttemptStatusV1,
    validatePersonStateV1: jira.validatePersonJiraStateV1,
    connect_path: jira.PERSON_JIRA_CONNECT_PATH_V1,
    status_path: jira.PERSON_JIRA_STATUS_PATH_V1,
    cancel_path: jira.PERSON_JIRA_CANCEL_PATH_V1,
    disconnect_path: jira.PERSON_JIRA_DISCONNECT_PATH_V1,
  },
  { id: "confluence", name: "Confluence",
    validatePersonCommandV1: confluence.validatePersonConfluenceCommandV1,
    validatePersonAttemptV1: confluence.validatePersonConfluenceAttemptV1,
    validatePersonConnectV1: confluence.validatePersonConfluenceConnectV1,
    validatePersonAttemptStatusV1: confluence.validatePersonConfluenceAttemptStatusV1,
    validatePersonStateV1: confluence.validatePersonConfluenceStateV1,
    connect_path: confluence.PERSON_CONFLUENCE_CONNECT_PATH_V1,
    status_path: confluence.PERSON_CONFLUENCE_STATUS_PATH_V1,
    cancel_path: confluence.PERSON_CONFLUENCE_CANCEL_PATH_V1,
    disconnect_path: confluence.PERSON_CONFLUENCE_DISCONNECT_PATH_V1,
  },
];

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

describe.each(contracts)("Person $name connection contract V1", contract => {
  it("uses the fixed Person-tool routes and documented closed shapes", () => {
    expect(contract.connect_path).toBe(`/v1/person/tools/${contract.id}/connect`);
    expect(contract.status_path).toBe(`/v1/person/tools/${contract.id}/status`);
    expect(contract.cancel_path).toBe(`/v1/person/tools/${contract.id}/cancel`);
    expect(contract.disconnect_path).toBe(`/v1/person/tools/${contract.id}/disconnect`);
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
