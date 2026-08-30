import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  validateOrganizationPersonSlackIdentityLinkBeginRequest,
  validateOrganizationPersonSlackIdentityLinkCompleteRequest,
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
import { createSqliteSlackPersonIdentityLinkWorkflowV1 } from "./sqlite-slack-person-identity-link-repository-v1.js";
import type {
  PersonExternalIdentityRuntimeBundleV1,
  PersonExternalIdentityRuntimeInputV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "../../../person-external-identity-runtime.js";

const SLACK_IDENTITY_ROUTES_V1 = Object.freeze([
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
    begin(input: unknown, accessToken: string): Promise<unknown>;
    complete(input: unknown, accessToken: string): Promise<unknown>;
  };
}): PersonExternalIdentityLinkHttpApplicationV1 {
  return Object.freeze({
    routes: SLACK_IDENTITY_ROUTES_V1,
    async accept(request: PersonExternalIdentityHttpRequestV1) {
      const body = parseBody(request.raw_body);
      const token = accessToken(request.headers);
      if (request.route_id === "slack-begin") {
        return Object.freeze({
          status: 201 as const,
          body: await input.service.begin(
            validateOrganizationPersonSlackIdentityLinkBeginRequest(body),
            token,
          ),
        });
      }
      if (request.route_id === "slack-complete") {
        return Object.freeze({
          status: 200 as const,
          body: await input.service.complete(
            validateOrganizationPersonSlackIdentityLinkCompleteRequest(body),
            token,
          ),
        });
      }
      throw new AuthorityOperationError("not_found", "external identity route is unavailable");
    },
  });
}

function unavailableSlackIdentityApplication(): PersonExternalIdentityLinkHttpApplicationV1 {
  return Object.freeze({
    routes: SLACK_IDENTITY_ROUTES_V1,
    async accept() {
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
}): PersonExternalIdentityRuntimeBundleV1 {
  return Object.freeze({
    open(
      runtime: PersonExternalIdentityRuntimeInputV1,
    ): OpenedPersonExternalIdentityRuntimeV1 {
      if (input.identity_link_channel_id === undefined) {
        return Object.freeze({
          application: unavailableSlackIdentityApplication(),
          close: () => undefined,
        });
      }
      const database = openOrganizationControlDatabase(
        `${runtime.state_directory}/integrations.sqlite`,
        { fileMustExist: true },
      );
      try {
        const application = createSqliteSlackPersonIdentityLinkWorkflowV1({
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
                throw new Error("active clean Slack credential is unavailable");
              }
              return secrets.read(matches[0]!);
            },
          },
          authorization_fence: new ReadableSearchAuthorizationFence(),
        });
        return Object.freeze({
          application: createSlackExternalIdentityHttpApplicationV1({
            service: application,
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
