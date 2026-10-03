import { Buffer } from 'node:buffer';
import type { PersonToolHostV1, PersonToolJsonRequestV1, PersonToolSessionV1 } from '@echo-brain/organization-api';
import { ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH, validateOrganizationPersonTools, validateOrganizationPersonSlackDisconnectRequest, type OrganizationPersonToolsV2 } from "../organization-api/person-tools.js";
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256, validateOrganizationPersonSlackIdentityLinkBeginRequest, validateOrganizationPersonSlackIdentityLinkBeginResponse, validateOrganizationPersonSlackIdentityLinkCompleteRequest, validateOrganizationPersonSlackIdentityLinkResult } from "../organization-api/person-slack-identity-link.js";
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1, validateOrganizationSlackInstallAttemptRequestV1, validateOrganizationSlackInstallBeginRequestV1, validateOrganizationSlackInstallBeginResponseV1, validateOrganizationSlackInstallStatusResponseV1, validateOrganizationSlackSetupRequestV1, validateOrganizationSlackSetupResponseV1, type OrganizationSlackInstallBeginResponseV1 } from "../organization-api/organization-slack-setup-v1.js";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH, ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH, validateOrganizationPersonSlackBrowserLinkAttemptRequest, validateOrganizationPersonSlackBrowserLinkBeginRequest, validateOrganizationPersonSlackBrowserLinkBeginResponse, validateOrganizationPersonSlackBrowserLinkStatusResponse, type OrganizationPersonSlackBrowserLinkBeginResponseV1 } from "../organization-api/person-slack-browser-link.js";
const SLACK_TIMEOUT_MS = 75_000;
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

function validateSlackBrowserBegin(value: unknown): OrganizationPersonSlackBrowserLinkBeginResponseV1 {
  const response = validateOrganizationPersonSlackBrowserLinkBeginResponse(value);
  return Object.freeze({
    ...response,
    authorization_url: validateSlackAuthorizationUrl(response.authorization_url),
  });
}

/** One Authority call inside the host's tool session, which checks the current account. */
function slackJson<T>(host: PersonToolHostV1, request: (session: PersonToolSessionV1) => PersonToolJsonRequestV1<T>): Promise<T> {
  return host.withToolSession((session) => session.transport.json({ timeout_ms: SLACK_TIMEOUT_MS, ...request(session) }));
}

export function disconnectSlack(host: PersonToolHostV1): Promise<OrganizationPersonToolsV2> {
  return host.withToolSession(async (session) => {
    const result = await session.transport.json({
      path: ORGANIZATION_API_PERSON_SLACK_DISCONNECT_PATH,
      body: {},
      validate_request: validateOrganizationPersonSlackDisconnectRequest,
      validate_response: validateOrganizationPersonTools,
      maximum_response_bytes: 4096,
      timeout_ms: SLACK_TIMEOUT_MS,
    });
    if (result.organization_id !== session.identity.organization_id || result.membership_id !== session.identity.membership_id) {
      throw new Error('Connected tools did not match the current account');
    }
    return result;
  });
}

export function beginSlackIdentityLink(host: PersonToolHostV1, recipientUserId: string) {
  return host.withToolSession(async (session) => {
    const bytes = session.random_bytes(32);
    try {
      if (bytes.byteLength !== 32) throw new Error('Person client challenge generator returned the wrong size');
      const code = Buffer.from(bytes).toString('base64url');
      const response = await session.transport.json({
        path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
        body: { request_id: session.request_id('psb'), recipient_user_id: recipientUserId,
          challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code) },
        validate_request: validateOrganizationPersonSlackIdentityLinkBeginRequest,
        validate_response: validateOrganizationPersonSlackIdentityLinkBeginResponse,
        timeout_ms: SLACK_TIMEOUT_MS,
      });
      return { ...response, challenge_code: code };
    } finally { bytes.fill(0); }
  });
}

export function completeSlackIdentityLink(host: PersonToolHostV1, input: { readonly challenge_attempt_id: string; readonly challenge_message_ts: string; readonly challenge_code: string }) {
  return slackJson(host, (session) => ({ path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH, body: { request_id: session.request_id('psc'), ...input },
    validate_request: validateOrganizationPersonSlackIdentityLinkCompleteRequest, validate_response: validateOrganizationPersonSlackIdentityLinkResult }));
}

export function beginSlackBrowserLink(host: PersonToolHostV1) {
  return slackJson(host, (session) => ({ path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, body: { request_id: session.request_id('psb') },
    validate_request: validateOrganizationPersonSlackBrowserLinkBeginRequest, validate_response: validateSlackBrowserBegin }));
}

export function slackBrowserLinkStatus(host: PersonToolHostV1, attemptId: string) {
  return slackJson(host, () => ({ path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_STATUS_PATH, body: { attempt_id: attemptId },
    validate_request: validateOrganizationPersonSlackBrowserLinkAttemptRequest, validate_response: validateOrganizationPersonSlackBrowserLinkStatusResponse }));
}

export function cancelSlackBrowserLink(host: PersonToolHostV1, attemptId: string) {
  return slackJson(host, () => ({ path: ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_CANCEL_PATH, body: { attempt_id: attemptId },
    validate_request: validateOrganizationPersonSlackBrowserLinkAttemptRequest, validate_response: validateOrganizationPersonSlackBrowserLinkStatusResponse }));
}

/** Owner only; the Authority re-checks. */
export function setupSlackApp(host: PersonToolHostV1, configurationToken: string) {
  return slackJson(host, (session) => ({ path: ORGANIZATION_API_SLACK_SETUP_PATH_V1, body: { request_id: session.request_id('oss'), configuration_token: configurationToken },
    validate_request: validateOrganizationSlackSetupRequestV1, validate_response: validateOrganizationSlackSetupResponseV1 }));
}

export function beginSlackInstall(host: PersonToolHostV1) {
  return slackJson(host, (session) => ({ path: ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, body: { request_id: session.request_id('osi') },
    validate_request: validateOrganizationSlackInstallBeginRequestV1, validate_response: validateSlackInstallBegin }));
}

export function slackInstallStatus(host: PersonToolHostV1, attemptId: string) {
  return slackJson(host, () => ({ path: ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, body: { attempt_id: attemptId },
    validate_request: validateOrganizationSlackInstallAttemptRequestV1, validate_response: validateOrganizationSlackInstallStatusResponseV1 }));
}

export function cancelSlackInstall(host: PersonToolHostV1, attemptId: string) {
  return slackJson(host, () => ({ path: ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, body: { attempt_id: attemptId },
    validate_request: validateOrganizationSlackInstallAttemptRequestV1, validate_response: validateOrganizationSlackInstallStatusResponseV1 }));
}
