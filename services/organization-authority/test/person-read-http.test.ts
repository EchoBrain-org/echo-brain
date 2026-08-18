import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
  ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from "@echo-brain/organization-api";
import { describe, expect, it, vi } from "vitest";
import type { PersonRecentDecisionsApplication } from "../src/application/person-read-recent-decisions.js";
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from "../src/presentation/http-server.js";
import type { OrganizationAuthorityHttpApplication } from "../src/presentation/organization-authority-http-application.js";
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from "../src/presentation/trusted-proxy-client-identity.js";

const PROXY_TOKEN = "test-proxy-origin-token-with-at-least-32-bytes";
const ACCESS_TOKEN = "A".repeat(43);
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";

function proxyHeaders(): Record<string, string> {
  return {
    connection: "close",
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash("sha256")
      .update("person-read-http-test")
      .digest("base64url")}`,
  };
}

function recentRequest() {
  return {
    schema_version: 2,
    kind: "echo-organization-person-recent-decisions-request",
    request_id: "rdr_00000000-0000-4000-8000-000000000001",
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: "POST",
    http_path: ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  } as const;
}

function reviewerRequest() {
  return {
    schema_version: 2,
    kind: "echo-organization-person-reviewer-recent-decisions-request",
    request_id: "rrd_00000000-0000-4000-8000-000000000001",
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: "POST",
    http_path: ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
  } as const;
}

function searchRequest() {
  return {
    schema_version: 2,
    kind: "echo-organization-person-readable-search-request",
    request_id: "osq_00000000-0000-4000-8000-000000000001",
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    subject_principal_id: PRINCIPAL_ID,
    http_method: "POST",
    http_path: ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
    query: "pricing",
  } as const;
}

function preparedSearch(body: Buffer) {
  return {
    status_code: 200 as const,
    handoff(send: (value: string) => void): void {
      send(body.toString("utf8"));
    },
  };
}

function server(options: {
  personRecentDecisions?: PersonRecentDecisionsApplication;
  personReadableSearch?: OrganizationAuthorityHttpServerOptions["personReadableSearch"];
}): Server {
  return createOrganizationAuthorityHttpServer({
    application: {} as OrganizationAuthorityHttpApplication,
    ...options,
    adminAuthenticator: { authenticate: () => false },
    clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
      PROXY_TOKEN,
    ),
  });
}

async function listen(http: Server): Promise<string> {
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function close(http: Server): Promise<void> {
  if (!http.listening) return;
  const closed = once(http, "close");
  http.close();
  await closed;
}

describe("Person read HTTP routes", () => {
  it("dispatches the three canonical V2 requests with the Bearer credential", async () => {
    const recentBody = Buffer.from('{"route":"recent"}', "utf8");
    const reviewerBody = Buffer.from('{"route":"reviewer"}', "utf8");
    const searchBody = Buffer.from('{"route":"search"}', "utf8");
    const recentDecisions = vi.fn(() => ({
      status_code: 200 as const,
      body: recentBody,
      item_references: [],
    }));
    const reviewerRecentDecisions = vi.fn(() => ({
      status_code: 200 as const,
      body: reviewerBody,
      returned_atom_ids: [],
      returned_record_hashes: [],
    }));
    const search = vi.fn(async () => preparedSearch(searchBody));
    const http = server({
      personRecentDecisions: { recentDecisions, reviewerRecentDecisions },
      personReadableSearch: { search },
    });
    const origin = await listen(http);
    try {
      for (const [path, request, expected] of [
        [
          ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
          recentRequest(),
          recentBody,
        ],
        [
          ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
          reviewerRequest(),
          reviewerBody,
        ],
        [
          ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
          searchRequest(),
          searchBody,
        ],
      ] as const) {
        const response = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            ...proxyHeaders(),
            authorization: `Bearer ${ACCESS_TOKEN}`,
            "content-type": "application/json",
          },
          body: canonicalJson(request),
        });
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
      }
      expect(recentDecisions).toHaveBeenCalledWith({
        request: recentRequest(),
        access_token: ACCESS_TOKEN,
      });
      expect(reviewerRecentDecisions).toHaveBeenCalledWith({
        request: reviewerRequest(),
        access_token: ACCESS_TOKEN,
      });
      expect(search).toHaveBeenCalledWith(searchRequest(), ACCESS_TOKEN, {
        signal: expect.any(AbortSignal),
      });
    } finally {
      await close(http);
    }
  });

  it("passes a missing or malformed Bearer credential to the audited start gate", async () => {
    const recentDecisions = vi.fn(() => ({
      status_code: 401 as const,
      body: Buffer.from(
        '{"error":{"code":"unauthorized","message":"authorization failed"}}',
        "utf8",
      ),
      item_references: [],
    }));
    const http = server({
      personRecentDecisions: {
        recentDecisions,
        reviewerRecentDecisions: vi.fn(),
      },
    });
    const origin = await listen(http);
    try {
      for (const authorization of [undefined, "Bearer malformed"]) {
        const response = await fetch(
          `${origin}${ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH}`,
          {
            method: "POST",
            headers: {
              ...proxyHeaders(),
              ...(authorization === undefined ? {} : { authorization }),
              "content-type": "application/json",
            },
            body: canonicalJson(recentRequest()),
          },
        );
        expect(response.status).toBe(401);
      }
      expect(recentDecisions).toHaveBeenCalledTimes(2);
      expect(recentDecisions).toHaveBeenNthCalledWith(1, {
        request: recentRequest(),
        access_token: "",
      });
      expect(recentDecisions).toHaveBeenNthCalledWith(2, {
        request: recentRequest(),
        access_token: "",
      });
    } finally {
      await close(http);
    }
  });

  it("rejects noncanonical bytes, query parameters, and wrong methods before dispatch", async () => {
    const recentDecisions = vi.fn();
    const http = server({
      personRecentDecisions: {
        recentDecisions,
        reviewerRecentDecisions: vi.fn(),
      },
    });
    const origin = await listen(http);
    try {
      const attempts = [
        fetch(`${origin}${ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH}`, {
          method: "POST",
          headers: { ...proxyHeaders(), "content-type": "application/json" },
          body: JSON.stringify(recentRequest(), null, 2),
        }),
        fetch(`${origin}${ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH}?q=1`, {
          method: "POST",
          headers: { ...proxyHeaders(), "content-type": "application/json" },
          body: canonicalJson(recentRequest()),
        }),
        fetch(`${origin}${ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH}`, {
          method: "GET",
          headers: proxyHeaders(),
        }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(400);
        expect(await response.text()).toBe(
          '{"error":{"code":"invalid_request","message":"request is invalid"}}',
        );
      }
      expect(recentDecisions).not.toHaveBeenCalled();
    } finally {
      await close(http);
    }
  });
});
