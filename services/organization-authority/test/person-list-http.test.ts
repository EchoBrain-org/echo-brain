import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSON_LIST_PATH_V1, PERSON_OPEN_PATH_V1, type PersonListResponseV1, type PersonOpenResponseV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import {
  createOrganizationAuthorityHttpServer,
  type OrganizationAuthorityHttpServerOptions,
} from "../src/presentation/organization-authority-http-server.js";
import type { PersonListHttpApplicationV1 } from "../src/presentation/person-list-http-application-v1.js";

const NOTE_REF = `note:ctx_${"a".repeat(64)}` as const;
const listed: PersonListResponseV1 = {
  schema_version: 1, kind: "echo-person-list-v1", scope: { kind: "mine" },
  items: [{ ref: NOTE_REF, kind: "note", title: "Pricing memo", added_at: "2026-09-21T18:00:00.000Z", visibility: "only_me", projects: [] }],
  next_cursor: null,
};
const opened: PersonOpenResponseV1 = {
  schema_version: 1, kind: "echo-person-open-v1", ref: NOTE_REF, item: listed.items[0] as never, text: "Annual plans first.", next_cursor: null,
};

const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

function options(application: PersonListHttpApplicationV1 | undefined): OrganizationAuthorityHttpServerOptions {
  // No person_answer_v3: listing and opening never wait for an answer model.
  return {
    descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: "https://issuer.example",
    ...(application === undefined ? {} : { person_list: application }),
  };
}

async function start(application: PersonListHttpApplicationV1 | undefined): Promise<string> {
  const server = createOrganizationAuthorityHttpServer(options(application));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

/** `null` sends no authorization header. */
function post(origin: string, path: string, body: unknown, authorization: string | null = "Bearer fixture-token"): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...(authorization === null ? {} : { authorization }), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function failure(response: Response, status: number, code: string): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: { code, message: "request failed" } });
  return text;
}

describe("person list and open HTTP transport", () => {
  it("serves list and open without an answer model, passing the bearer, the request and a signal", async () => {
    const application = {
      list: vi.fn(async () => listed),
      open: vi.fn(async () => opened),
    } satisfies PersonListHttpApplicationV1;
    const origin = await start(application);
    const list = await post(origin, PERSON_LIST_PATH_V1, { schema_version: 1, mine: true });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual(listed);
    expect(application.list).toHaveBeenCalledWith({ access_token: "fixture-token", request: { schema_version: 1, mine: true }, signal: expect.any(AbortSignal) });
    const open = await post(origin, PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF });
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual(opened);
    expect(application.open).toHaveBeenCalledWith({ access_token: "fixture-token", request: { schema_version: 1, ref: NOTE_REF }, signal: expect.any(AbortSignal) });
  });

  it("answers unavailable when the list is not composed", async () => {
    const origin = await start(undefined);
    await failure(await post(origin, PERSON_LIST_PATH_V1, { schema_version: 1 }), 503, "unavailable");
    await failure(await post(origin, PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF }), 503, "unavailable");
  });

  it("refuses a malformed body or a missing bearer before the application runs", async () => {
    const application = { list: vi.fn(async () => listed), open: vi.fn(async () => opened) };
    const origin = await start(application);
    for (const body of [
      "{", { schema_version: 1, mine: true, project_id: "prj_11111111-1111-4111-8111-111111111111" }, { schema_version: 1, mine: false },
      { schema_version: 1, limit: 25 }, { schema_version: 1, scope: { kind: "global" } }, { schema_version: 1, cursor: "a=b" }, { schema_version: 2 },
    ]) await failure(await post(origin, PERSON_LIST_PATH_V1, body), 400, "invalid_request");
    for (const body of [
      { schema_version: 1, ref: `record:${"a".repeat(64)}` }, { schema_version: 1, ref: NOTE_REF, cursor: "AAAA" },
      { schema_version: 1, ref: ` ${NOTE_REF}` }, { schema_version: 1, ref: NOTE_REF, scope: { kind: "global" } },
    ]) await failure(await post(origin, PERSON_OPEN_PATH_V1, body), 400, "invalid_request");
    await failure(await post(origin, PERSON_LIST_PATH_V1, { schema_version: 1 }, null), 401, "unauthorized");
    await failure(await post(origin, PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF }, "Basic token"), 401, "unauthorized");
    expect((await fetch(`${origin}${PERSON_LIST_PATH_V1}?mine=true`, { method: "POST", headers: { authorization: "Bearer fixture-token" }, body: "{}" })).status).toBe(404);
    expect((await fetch(`${origin}${PERSON_LIST_PATH_V1}`, { headers: { authorization: "Bearer fixture-token" } })).status).toBe(404);
    expect(application.list).not.toHaveBeenCalled();
    expect(application.open).not.toHaveBeenCalled();
  });

  it("maps each Authority failure to its status, with one exact not_found body", async () => {
    let error: unknown;
    const origin = await start({ list: async () => { throw error; }, open: async () => { throw error; } });
    const cases: readonly [unknown, number, string][] = [
      [new AuthorityOperationError("not_found", "item is not available"), 404, "not_found"],
      [new AuthorityOperationError("unauthorized", "person authentication failed"), 401, "unauthorized"],
      [new AuthorityOperationError("unavailable", "person list is unavailable"), 503, "unavailable"],
      [new AuthorityOperationError("invalid_output", "request failed"), 502, "invalid_output"],
      [new AuthorityOperationError("invalid_request", "request failed"), 400, "invalid_request"],
      [new TypeError("bug"), 500, "internal"],
    ];
    for (const [value, status, code] of cases) {
      error = value;
      await failure(await post(origin, PERSON_LIST_PATH_V1, { schema_version: 1 }), status, code);
      await failure(await post(origin, PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF }), status, code);
    }
    error = new AuthorityOperationError("not_found", "item is not available");
    const body = await failure(await post(origin, PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF }), 404, "not_found");
    expect(body).toBe('{"error":{"code":"not_found","message":"request failed"}}');
  });

  it("reserves both paths from provider ingress", () => {
    for (const key of ["private_approval_interaction_ingress", "person_external_identity_link", "person_tools"] as const) {
      for (const path of [PERSON_LIST_PATH_V1, PERSON_OPEN_PATH_V1]) {
        expect(() => createOrganizationAuthorityHttpServer({
          ...options(undefined),
          [key]: { routes: [{ route_id: "collision", method: "POST", path }], accept: async () => ({ status: 200, body: {} }) },
        })).toThrow("collides with Authority route");
      }
    }
  });

  it("aborts the route's signal when the client disconnects", async () => {
    for (const [path, body] of [[PERSON_LIST_PATH_V1, { schema_version: 1 }], [PERSON_OPEN_PATH_V1, { schema_version: 1, ref: NOTE_REF }]] as const) {
      let started!: () => void;
      let observed!: () => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const abortedPromise = new Promise<void>((resolve) => { observed = resolve; });
      const hang = ({ signal }: { readonly signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        started();
        signal?.addEventListener("abort", () => { observed(); reject(new Error("client disconnected")); }, { once: true });
      });
      const origin = await start({ list: hang, open: hang });
      const request = httpRequest(`${origin}${path}`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" } });
      request.on("error", () => undefined);
      request.end(JSON.stringify(body));
      await startedPromise;
      request.destroy();
      await abortedPromise;
    }
  });
});
