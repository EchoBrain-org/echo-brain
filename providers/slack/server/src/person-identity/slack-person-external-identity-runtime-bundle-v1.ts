import { validateOrganizationPersonTools } from '@echo-brain/provider-slack-client/organization-api/person-tools';
import type { OrganizationPersonToolV4 } from '@echo-brain/organization-api';
import { observeCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import { ORGANIZATION_API_PERSON_TOOLS_PATH, ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH } from "@echo-brain/provider-slack-client/organization-api/person-tools";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CALLBACK_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-browser-link";
import { ORGANIZATION_API_SLACK_APP_CREDENTIALS_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_RECIPE_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from "@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { SlackOrganizationSetupWorkflowV1, type SlackOrganizationSetupOptionsV1 } from "../organization-setup/slack-organization-setup-workflow-v1.js";
import { SlackWebIdentityProviderV1, type SlackIdentityProviderV1 } from "../organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { createSlackBotTokenSourceV1, type SlackBotTokenSourceV1 } from "../organization-control-plane/application/slack-bot-token-source-v1.js";
import type { SlackConnectionHealthV1 } from "../organization-control-plane/application/slack-connection-health-v1.js";
import type { StoredSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { ReadableSearchAuthorizationFence } from "@echo-brain/organization-authority-kernel/application/readable-search-authorization-fence";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  ProviderHttpRequestV1,
  ProviderHttpApplicationV1,
  ProviderHttpResponseV1,
} from "@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1";
import { createSqliteSlackPersonIdentityLinkWorkflowV1, createSqliteSlackPersonIdentityLinkRepositoryV1, type CreateSqliteSlackPersonIdentityLinkWorkflowV1Input } from "./sqlite-slack-person-identity-link-repository-v1.js";
import { SlackPersonBrowserIdentityLinkWorkflowV1 } from "./slack-person-browser-identity-link-workflow-v1.js";
import type { SlackBrowserIdentityProvider } from "../adapters/oidc/slack-browser-identity-provider.js";
import type {
  PersonExternalIdentityRuntimeBundleV1,
  PersonExternalIdentityRuntimeInputV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";

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

/** Owner-only organization setup; mounted only when setup options are provided. */
const SLACK_ORGANIZATION_SETUP_ROUTES_V1 = Object.freeze([
  Object.freeze({ route_id: "slack-setup", method: "POST" as const, path: ORGANIZATION_API_SLACK_SETUP_PATH_V1 }),
  Object.freeze({ route_id: "slack-app-credentials", method: "POST" as const, path: ORGANIZATION_API_SLACK_APP_CREDENTIALS_PATH_V1 }),
  Object.freeze({ route_id: "slack-recipe", method: "GET" as const, path: ORGANIZATION_API_SLACK_RECIPE_PATH_V1 }),
  Object.freeze({ route_id: "slack-install-begin", method: "POST" as const, path: ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1 }),
  Object.freeze({ route_id: "slack-install-status", method: "POST" as const, path: ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1 }),
  Object.freeze({ route_id: "slack-install-cancel", method: "POST" as const, path: ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1 }),
]);
const SLACK_ORGANIZATION_SETUP_ROUTE_IDS_V1 = new Set<string>(SLACK_ORGANIZATION_SETUP_ROUTES_V1.map((route) => route.route_id));

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

async function acceptOrganizationSetupRouteV1(
  setup: SlackOrganizationSetupWorkflowV1 | undefined,
  request: ProviderHttpRequestV1,
  token: string,
): Promise<ProviderHttpResponseV1 | undefined> {
  if (!SLACK_ORGANIZATION_SETUP_ROUTE_IDS_V1.has(request.route_id)) return undefined;
  if (setup === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
  if (request.route_id === "slack-recipe") return Object.freeze({ status: 200 as const, body: await setup.recipe(token) });
  const body = parseBody(request.raw_body);
  switch (request.route_id) {
    case "slack-setup": return Object.freeze({ status: 201 as const, body: await setup.setup(body, token) });
    case "slack-app-credentials": return Object.freeze({ status: 201 as const, body: await setup.appCredentials(body, token) });
    case "slack-install-begin": return Object.freeze({ status: 201 as const, body: await setup.beginInstall(body, token) });
    case "slack-install-status": return Object.freeze({ status: 200 as const, body: await setup.installStatus(body, token) });
    default: return Object.freeze({ status: 200 as const, body: await setup.cancelInstall(body, token) });
  }
}

export function createSlackExternalIdentityHttpApplicationV1(input: {
  readonly service: {
    tools(accessToken: string): Promise<unknown>;
    begin(input: unknown, accessToken: string): Promise<unknown>;
    complete(input: unknown, accessToken: string): Promise<unknown>;
    disconnect(input: unknown, accessToken: string): Promise<unknown>;
  };
  readonly browser?: SlackPersonBrowserIdentityLinkWorkflowV1;
  readonly setup?: SlackOrganizationSetupWorkflowV1;
}): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([
      ...SLACK_IDENTITY_ROUTES_V1,
      ...(input.browser === undefined ? [] : SLACK_BROWSER_IDENTITY_ROUTES_V1),
      ...(input.setup === undefined ? [] : SLACK_ORGANIZATION_SETUP_ROUTES_V1),
    ]),
    async accept(request: ProviderHttpRequestV1) {
      if (request.route_id === "slack-browser-callback") {
        if (input.browser === undefined) throw new AuthorityOperationError("not_found", "external identity route is unavailable");
        await input.browser.callback(request.query ?? new URLSearchParams());
        return Object.freeze({ status: 200 as const, body: "<!doctype html><meta charset=\"utf-8\"><title>ECHO</title><p>Return to ECHO to finish connecting. ECHO will show the connection status.</p>", content_type: "text/html" as const });
      }
      const token = accessToken(request.headers);
      if (request.route_id === "tools") return { status: 200 as const, body: await input.service.tools(token) };
      const setupResponse = await acceptOrganizationSetupRouteV1(input.setup, request, token);
      if (setupResponse !== undefined) return setupResponse;
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

function unavailableSlackIdentityApplication(runtime: PersonExternalIdentityRuntimeInputV1): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: SLACK_IDENTITY_ROUTES_V1,
    async accept(request: ProviderHttpRequestV1) {
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
  /** Absent: the legacy local-secret source. */
  readonly bot_token_source?: SlackBotTokenSourceV1;
  /** Marked when Slack keeps rejecting the bot token after one refresh. */
  readonly connection_health?: SlackConnectionHealthV1;
  /** Present only when Nango is configured: mounts the owner setup routes. */
  readonly organization_setup?: SlackOrganizationSetupOptionsV1;
}): PersonExternalIdentityRuntimeBundleV1 {
  return Object.freeze({
    open(
      runtime: PersonExternalIdentityRuntimeInputV1,
    ): OpenedPersonExternalIdentityRuntimeV1 {
      if (input.identity_link_channel_id === undefined) {
        return Object.freeze({
          application: unavailableSlackIdentityApplication(runtime),
          tools: async () => [],
          close: () => undefined,
        });
      }
      const health = input.connection_health;
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
            // The default legacy source opens the secret store per read, as before.
            readActiveSlackBotToken: (connection, options) =>
              (input.bot_token_source ?? createSlackBotTokenSourceV1({
                secrets: new FileOrganizationSecretStore(`${runtime.state_directory}/secrets`),
              })).botToken(connection, options),
            ...(health === undefined ? {} : {
              onActiveSlackBotTokenRejected: (connection: StoredSlackConnectionV1) =>
                health.markNeedsReinstall(connection.state_sha256),
            }),
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
        const setup = input.organization_setup === undefined ? undefined : new SlackOrganizationSetupWorkflowV1({
          ...input.organization_setup,
          database,
          secrets: new FileOrganizationSecretStore(`${runtime.state_directory}/secrets`),
          authority_id: runtime.authority_id,
          organization_id: runtime.organization_id,
          state_lineage_id: runtime.state_lineage_id,
          authentication: runtime.authentication,
          verifier: input.organization_setup.verifier ?? workflowInput.slack,
        });
        return Object.freeze({
          application: createSlackExternalIdentityHttpApplicationV1({
            service: application,
            ...(browser === undefined ? {} : { browser }),
            ...(setup === undefined ? {} : { setup }),
          }),
          tools: async (token: string): Promise<readonly OrganizationPersonToolV4[]> => {
            const current = validateOrganizationPersonTools(await application.tools(token));
            const organizationSetup = setup?.organizationSetupForCaller(token) ?? null;
            const tools = current.tools.map(tool => Object.freeze({
              tool_id: 'slack', display_name: 'Slack', availability: tool.availability,
              personal_status: tool.personal_status, external_scope_id: tool.workspace_id,
              external_subject_id: tool.account_id, organization_setup: organizationSetup,
            }));
            // With setup mounted, Slack is listed before any connection exists so an owner can set it up.
            if (tools.length > 0 || setup === undefined) return tools;
            return [Object.freeze({ tool_id: 'slack', display_name: 'Slack', availability: 'unavailable' as const,
              personal_status: 'unavailable' as const, external_scope_id: null, external_subject_id: null, organization_setup: organizationSetup })];
          },
          close: () => database.close(),
        });
      } catch (error) {
        database.close();
        throw error;
      }
    },
  });
}
