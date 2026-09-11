import { observeCoreRuntimeV1 } from "../../../../shared/core-runtime-observation-v1.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_TOOLS_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH,
  ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH,
  ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH,
  ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH,
  ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH,
} from "@echo-brain/organization-api";
import {
  FileOrganizationSecretStore,
  SlackWebIdentityProviderV1,
  type SlackIdentityProviderV1,
} from "@echo-brain/organization-control-plane/slack-external-identity-integration-v1";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { ReadableSearchAuthorizationFence } from "../../../../application/readable-search-authorization-fence.js";
import { AuthorityOperationError } from "../../../../domain/errors.js";
import type {
  PersonExternalIdentityHttpRequestV1,
  PersonExternalIdentityLinkHttpApplicationV1,
} from "../../../../presentation/person-external-identity-link-http-application.js";
import {
  createSqliteSlackPersonIdentityLinkWorkflowV1,
  createSqliteSlackPersonIdentityLinkRepositoryV1,
  type CreateSqliteSlackPersonIdentityLinkWorkflowV1Input,
} from "./sqlite-slack-person-identity-link-repository-v1.js";
import { SlackPersonBrowserIdentityLinkWorkflowV1 } from "./slack-person-browser-identity-link-workflow-v1.js";
import type { SlackBrowserIdentityProvider } from "../../../../adapters/oidc/slack-browser-identity-provider.js";
import type {
  PersonExternalIdentityRuntimeBundleV1,
  PersonExternalIdentityRuntimeInputV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "../../../person-external-identity-runtime.js";

const SLACK_IDENTITY_ROUTES_V1 = Object.freeze([
  Object.freeze({ route_id: "tools", method: "GET" as const, path: ORGANIZATION_API_PERSON_TOOLS_PATH }),
  Object.freeze({ route_id: "slack-disconnect", method: "POST" as const, path: ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH }),
  Object.freeze({
    route_id: "slack-begin",
    method: "POST" as const,
    path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  }),
  Object.freeze({
    route_id: "slack-complete",
    method: "POST" as const,
    path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  }),
]);

const SLACK_BROWSER_IDENTITY_ROUTES_V1 = Object.freeze([
  Object.freeze({ route_id: "slack-browser-begin", method: "POST" as const, path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH }),
  Object.freeze({ route_id: "slack-browser-status", method: "POST" as const, path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH }),
  Object.freeze({ route_id: "slack-browser-cancel", method: "POST" as const, path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH }),
  Object.freeze({
    route_id: "slack-browser-callback",
    method: "GET" as const,
    path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH,
    accepts_query: true as const,
  }),
]);

function parseBody(raw: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
  } catch {
    throw new AuthorityOperationError("invalid_request", "request body is invalid");
  }
}

function accessToken(headers: Readonly<Record<string, string | undefined>>): string {
  const value = headers.authorization;
  if (value === undefined || !value.startsWith("Bearer ")) {
    throw new AuthorityOperationError("unauthorized", "person authentication failed");
  }
  return value.slice("Bearer ".length);
}

export function createSlackExternalIdentityHttpApplicationV1(input: {
  readonly service: {
    tools(accessToken: string): Promise<unknown>;
    begin(input: unknown, accessToken: string): Promise<unknown>;
    complete(input: unknown, accessToken: string): Promise<unknown>;
    disconnect(input: unknown, accessToken: string): Promise<unknown>;
  };
  readonly browser?: SlackPersonBrowserIdentityLinkWorkflowV1;
}): PersonExternalIdentityLinkHttpApplicationV1 {
  return Object.freeze({
    routes: input.browser === undefined ? SLACK_IDENTITY_ROUTES_V1 : Object.freeze([...SLACK_IDENTITY_ROUTES_V1, ...SLACK_BROWSER_IDENTITY_ROUTES_V1]),
    async accept(request: PersonExternalIdentityHttpRequestV1) {
      if (request.route_id === "slack-browser-callback") {
        if (input.browser === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
        await input.browser.callback(request.query ?? new URLSearchParams());
        return Object.freeze({ status: 200 as const, body: "<!doctype html><meta charset=\"utf-8\"><title>ECHO</title><p>Return to ECHO to finish connecting. ECHO will show the connection status.</p>", content_type: "text/html" as const });
      }
      const token = accessToken(request.headers);
      if (request.route_id === "tools") return { status: 200 as const, body: await input.service.tools(token) };
      const body = parseBody(request.raw_body);
      if (request.route_id === "slack-disconnect") {
        return Object.freeze({ status: 200 as const, body: await input.service.disconnect(body, token) });
      }
      if (request.route_id === "slack-browser-begin") {
        if (input.browser === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
        return Object.freeze({ status: 201 as const, body: await input.browser.begin(body, token) });
      }
      if (request.route_id === "slack-browser-status") {
        if (input.browser === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
        return Object.freeze({ status: 200 as const, body: await input.browser.status(body, token) });
      }
      if (request.route_id === "slack-browser-cancel") {
        if (input.browser === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
        return Object.freeze({ status: 200 as const, body: await input.browser.cancel(body, token) });
      }
      if (request.route_id === "slack-begin") {
        return Object.freeze({
          status: 201 as const,
          body: await input.service.begin(
            body,
            token,
          ),
        });
      }
      if (request.route_id === "slack-complete") {
        return Object.freeze({
          status: 200 as const,
          body: await input.service.complete(
            body,
            token,
          ),
        });
      }
      throw new AuthorityOperationError("not_found", "external identity route is unavailable");
    },
  });
}

function unavailableSlackIdentityApplication(runtime: PersonExternalIdentityRuntimeInputV1): PersonExternalIdentityLinkHttpApplicationV1 {
  return Object.freeze({
    routes: SLACK_IDENTITY_ROUTES_V1,
    async accept(request: PersonExternalIdentityHttpRequestV1) {
      if (request.route_id === "tools") {
        return observeCoreRuntimeV1("person_tools_status", async () => {
          const auth = runtime.authentication.authenticateAccess({ access_token: accessToken(request.headers) });
          if (auth.organization_id !== runtime.organization_id) throw new AuthorityOperationError("unauthorized", "person authentication failed");
          return { status: 200 as const, body: { schema_version: 2, kind: "echo-organization-person-tools", organization_id: auth.organization_id, membership_id: auth.membership_id, tools: [] } };
        });
      }
      throw new AuthorityOperationError("unavailable", "external identity is unavailable");
    },
  });
}

/**
 * Slack-owned composition for the existing Person-to-Slack identity-link
 * protocol. Its channel, control database, provider client, and token lookup
 * never enter the generic Person runtime.
 */
export function createSlackPersonExternalIdentityRuntimeBundleV1(input: {
  readonly identity_link_channel_id?: string;
  readonly provider?: SlackIdentityProviderV1;
  readonly browser_provider?: SlackBrowserIdentityProvider;
}): PersonExternalIdentityRuntimeBundleV1 {
  return Object.freeze({
    open(
      runtime: PersonExternalIdentityRuntimeInputV1,
    ): OpenedPersonExternalIdentityRuntimeV1 {
      if (input.identity_link_channel_id === undefined) {
        return Object.freeze({
          application: unavailableSlackIdentityApplication(runtime),
          close: () => undefined,
        });
      }
      const database = openOrganizationControlDatabase(
        `${runtime.state_directory}/integrations.sqlite`,
        { fileMustExist: true },
      );
      try {
        const workflowInput = {
          database,
          authority_id: runtime.authority_id,
          organization_id: runtime.organization_id,
          state_lineage_id: runtime.state_lineage_id,
          // The control-plane V2 contract retains this legacy field name.
          approval_channel_id: input.identity_link_channel_id,
          authentication: runtime.authentication,
          membership_type: runtime.membership_type,
          slack: input.provider ?? new SlackWebIdentityProviderV1(),
          slack_token_access: {
            readActiveSlackBotToken: ({ state }) => {
              const secrets = new FileOrganizationSecretStore(
                `${runtime.state_directory}/secrets`,
              );
              const matches = secrets
                .listReferences()
                .filter(
                  (reference) =>
                    canonicalSha256(reference) ===
                    state.credential_reference_sha256,
                );
              if (matches.length !== 1) {
                throw new Error("active Slack credential is unavailable");
              }
              return secrets.read(matches[0]!);
            },
          },
          authorization_fence: new ReadableSearchAuthorizationFence(),
        } satisfies CreateSqliteSlackPersonIdentityLinkWorkflowV1Input;
        const repository = createSqliteSlackPersonIdentityLinkRepositoryV1(workflowInput);
        const browser = input.browser_provider === undefined ? undefined : new SlackPersonBrowserIdentityLinkWorkflowV1({
          authority_id: runtime.authority_id,
          organization_id: runtime.organization_id,
          authentication: runtime.authentication,
          repository,
          browser_provider: input.browser_provider,
        });
        const application = createSqliteSlackPersonIdentityLinkWorkflowV1({
          ...workflowInput,
          invalidate_browser_attempts: browser === undefined
            ? undefined
            : (membershipId) => browser.invalidateMembership(membershipId),
        });
        return Object.freeze({
          application: createSlackExternalIdentityHttpApplicationV1({
            service: application,
            ...(browser === undefined ? {} : { browser }),
          }),
          close: () => database.close(),
        });
      } catch (error) {
        database.close();
        throw error;
      }
    },
  });
}
