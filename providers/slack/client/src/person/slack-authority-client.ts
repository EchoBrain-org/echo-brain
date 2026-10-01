import type { PersonToolTransportV1 } from '@echo-brain/organization-api';
import { ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH, validateOrganizationPersonTools, validateOrganizationPersonSlackDisconnectRequest, type OrganizationPersonToolsV2 } from "../organization-api/person-tools.js";
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, validateOrganizationPersonSlackIdentityLinkBeginRequest, validateOrganizationPersonSlackIdentityLinkBeginResponse, validateOrganizationPersonSlackIdentityLinkCompleteRequest, validateOrganizationPersonSlackIdentityLinkResult, type OrganizationPersonSlackIdentityLinkBeginRequestV2, type OrganizationPersonSlackIdentityLinkBeginResponseV2, type OrganizationPersonSlackIdentityLinkCompleteRequestV2, type OrganizationPersonSlackIdentityLinkResultV2 } from "../organization-api/person-slack-identity-link.js";
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1, validateOrganizationSlackInstallAttemptRequestV1, validateOrganizationSlackInstallBeginRequestV1, validateOrganizationSlackInstallBeginResponseV1, validateOrganizationSlackInstallStatusResponseV1, validateOrganizationSlackSetupRequestV1, validateOrganizationSlackSetupResponseV1, type OrganizationSlackInstallAttemptRequestV1, type OrganizationSlackInstallBeginRequestV1, type OrganizationSlackInstallBeginResponseV1, type OrganizationSlackInstallStatusResponseV1, type OrganizationSlackSetupRequestV1, type OrganizationSlackSetupResponseV1 } from "../organization-api/organization-slack-setup-v1.js";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH, validateOrganizationPersonSlackBrowserLinkAttemptRequest, validateOrganizationPersonSlackBrowserLinkBeginRequest, validateOrganizationPersonSlackBrowserLinkBeginResponse, validateOrganizationPersonSlackBrowserLinkStatusResponse, type OrganizationPersonSlackBrowserLinkAttemptRequestV1, type OrganizationPersonSlackBrowserLinkBeginRequestV1, type OrganizationPersonSlackBrowserLinkBeginResponseV1, type OrganizationPersonSlackBrowserLinkStatusResponseV1 } from "../organization-api/person-slack-browser-link.js";
const SLACK_TIMEOUT_MS = 75_000;
export type PersonSlackBrowserLinkBeginV1 = OrganizationPersonSlackBrowserLinkBeginResponseV1;
export type PersonSlackBrowserLinkStatusV1 = OrganizationPersonSlackBrowserLinkStatusResponseV1;
function validateSlackAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Slack browser authorization URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack browser authorization URL is invalid");
  }
  // The Authority is the only party that should select a browser destination.
  // Reject credentials, fragments, and arbitrary HTTPS origins before calling
  // the host browser. Slack's production OpenID path is deliberately exact.
  if (
    url.origin !== "https://slack.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== "/openid/connect/authorize"
  ) {
    throw new Error("Slack browser authorization URL is invalid");
  }
  return url.toString();
}

/** The connect link comes from Nango through the Authority; only a plain https page is opened. */
function validateSlackInstallBegin(value: unknown): OrganizationSlackInstallBeginResponseV1 {
  const response = validateOrganizationSlackInstallBeginResponseV1(value);
  let url: URL;
  try {
    url = new URL(response.connect_link);
  } catch {
    throw new Error("Slack connect link is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Slack connect link is invalid");
  }
  return response;
}

function validateSlackBrowserBegin(value: unknown): PersonSlackBrowserLinkBeginV1 {
  const response = validateOrganizationPersonSlackBrowserLinkBeginResponse(value);
  return Object.freeze({
    ...response,
    authorization_url: validateSlackAuthorizationUrl(response.authorization_url),
  });
}


export class SlackPersonAuthorityClient {
  constructor(private readonly transport: PersonToolTransportV1) {}
  disconnectSlack(): Promise<OrganizationPersonToolsV2> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH,
      body: {},
      validate_request: validateOrganizationPersonSlackDisconnectRequest,
      validate_response: validateOrganizationPersonTools,
      maximum_response_bytes: 4096,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  beginSlackIdentityLink(
    request: OrganizationPersonSlackIdentityLinkBeginRequestV2,
  ): Promise<OrganizationPersonSlackIdentityLinkBeginResponseV2> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackIdentityLinkBeginRequest,
      validate_response: validateOrganizationPersonSlackIdentityLinkBeginResponse,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  completeSlackIdentityLink(
    request: OrganizationPersonSlackIdentityLinkCompleteRequestV2,
  ): Promise<OrganizationPersonSlackIdentityLinkResultV2> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackIdentityLinkCompleteRequest,
      validate_response: validateOrganizationPersonSlackIdentityLinkResult,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  beginSlackBrowserLink(
    request: OrganizationPersonSlackBrowserLinkBeginRequestV1,
  ): Promise<PersonSlackBrowserLinkBeginV1> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackBrowserLinkBeginRequest,
      validate_response: validateSlackBrowserBegin,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  slackBrowserLinkStatus(
    request: OrganizationPersonSlackBrowserLinkAttemptRequestV1,
  ): Promise<PersonSlackBrowserLinkStatusV1> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackBrowserLinkAttemptRequest,
      validate_response: validateOrganizationPersonSlackBrowserLinkStatusResponse,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  cancelSlackBrowserLink(
    request: OrganizationPersonSlackBrowserLinkAttemptRequestV1,
  ): Promise<PersonSlackBrowserLinkStatusV1> {
    return this.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackBrowserLinkAttemptRequest,
      validate_response: validateOrganizationPersonSlackBrowserLinkStatusResponse,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
  }

  /** Owner only; the Authority re-checks. */
  setupSlackApp(request: OrganizationSlackSetupRequestV1): Promise<OrganizationSlackSetupResponseV1> {
    return this.transport.json({ path: ORGANIZATION_API_SLACK_SETUP_PATH_V1, body: request, timeout_ms: SLACK_TIMEOUT_MS,
      validate_request: validateOrganizationSlackSetupRequestV1, validate_response: validateOrganizationSlackSetupResponseV1 });
  }

  beginSlackInstall(request: OrganizationSlackInstallBeginRequestV1): Promise<OrganizationSlackInstallBeginResponseV1> {
    return this.transport.json({ path: ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, body: request, timeout_ms: SLACK_TIMEOUT_MS,
      validate_request: validateOrganizationSlackInstallBeginRequestV1, validate_response: validateSlackInstallBegin });
  }

  slackInstallStatus(request: OrganizationSlackInstallAttemptRequestV1): Promise<OrganizationSlackInstallStatusResponseV1> {
    return this.transport.json({ path: ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, body: request, timeout_ms: SLACK_TIMEOUT_MS,
      validate_request: validateOrganizationSlackInstallAttemptRequestV1, validate_response: validateOrganizationSlackInstallStatusResponseV1 });
  }

  cancelSlackInstall(request: OrganizationSlackInstallAttemptRequestV1): Promise<OrganizationSlackInstallStatusResponseV1> {
    return this.transport.json({ path: ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, body: request, timeout_ms: SLACK_TIMEOUT_MS,
      validate_request: validateOrganizationSlackInstallAttemptRequestV1, validate_response: validateOrganizationSlackInstallStatusResponseV1 });
  }
}
