import { describe, expect, it } from "vitest";
import type { PersonToolVerbContextV1 } from "@echo-brain/organization-api";
import { createJiraPersonToolProviderV1 } from "../../src/person/jira-tool-provider.js";

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

function context(input: {
  readonly responses: readonly unknown[];
  readonly values?: Readonly<Record<string, string | boolean | undefined>>;
  readonly browser?: boolean;
}) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const prints: unknown[] = [];
  const opened: string[] = [];
  const sleeps: number[] = [];
  const queue = [...input.responses];
  const value: PersonToolVerbContextV1 = {
    host: {
      async withToolSession(operation) {
        return operation({
          identity: { organization_id: "org-test", membership_id: "membership-test" },
          request_id: () => "unused",
          random_bytes: () => new Uint8Array(),
          transport: {
            async json(request) {
              requests.push({ path: request.path, body: request.body });
              request.validate_request(request.body);
              return request.validate_response(queue.shift());
            },
            async getJson() {
              throw new Error("Jira tool does not use GET");
            },
          },
        });
      },
    },
    values: input.values ?? {},
    print: (printed) => prints.push(printed),
    read_interactive_line: async () => "",
    read_secret_line: async () => "",
    open_browser: async (url) => {
      opened.push(url);
      return input.browser ?? true;
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  };
  return { value, requests, prints, opened, sleeps };
}

describe("Person Jira tool provider", () => {
  it("opens consent, polls through pending, and never prints the opaque connect link", async () => {
    const fixture = context({
      responses: [CONNECT, PENDING, { ...PENDING, status: "complete" }],
    });
    const provider = createJiraPersonToolProviderV1();

    await provider.verbs.connect!.run(fixture.value);

    expect(fixture.opened).toEqual([CONNECT.connect_link]);
    expect(fixture.sleeps).toEqual([2_000, 2_000]);
    expect(fixture.requests.map((request) => request.path)).toEqual([
      "/v1/person/tools/jira/connect",
      "/v1/person/tools/jira/status",
      "/v1/person/tools/jira/status",
    ]);
    expect(JSON.stringify(fixture.prints)).not.toContain(CONNECT.connect_link);
    expect(fixture.prints).toContainEqual(
      expect.objectContaining({ phase: "connected", attempt: ATTEMPT }),
    );
  });

  it("cancels if the browser cannot open and supports no-wait, status, cancel, and disconnect", async () => {
    const provider = createJiraPersonToolProviderV1();
    const noBrowser = context({ responses: [CONNECT, { ...PENDING, status: "cancelled" }], browser: false });
    await expect(provider.verbs.connect!.run(noBrowser.value)).rejects.toMatchObject({
      reason: "browser_unavailable",
    });
    expect(noBrowser.requests.map((request) => request.path)).toEqual([
      "/v1/person/tools/jira/connect",
      "/v1/person/tools/jira/cancel",
    ]);

    const noWait = context({ responses: [CONNECT], values: { "no-wait": true } });
    await provider.verbs.connect!.run(noWait.value);
    expect(noWait.requests).toHaveLength(1);

    const status = context({ responses: [PENDING], values: { "attempt-id": ATTEMPT } });
    await provider.verbs.status!.run(status.value);
    expect(status.requests[0]).toMatchObject({
      path: "/v1/person/tools/jira/status",
      body: { schema_version: 1, attempt: ATTEMPT },
    });

    const cancel = context({ responses: [{ ...PENDING, status: "cancelled" }], values: { "attempt-id": ATTEMPT } });
    await provider.verbs.cancel!.run(cancel.value);
    expect(cancel.requests[0]!.path).toBe("/v1/person/tools/jira/cancel");

    const disconnect = context({ responses: [{ schema_version: 1, connected: false }] });
    await provider.verbs.disconnect!.run(disconnect.value);
    expect(disconnect.requests[0]!.path).toBe("/v1/person/tools/jira/disconnect");
  });

  it("rejects a valid-looking status response for a different attempt", async () => {
    const fixture = context({
      responses: [{ ...PENDING, attempt: "22222222-2222-4222-8222-222222222222" }],
      values: { "attempt-id": ATTEMPT },
    });
    const provider = createJiraPersonToolProviderV1();

    await expect(provider.verbs.status!.run(fixture.value)).rejects.toThrow(
      "did not match",
    );
  });
});
