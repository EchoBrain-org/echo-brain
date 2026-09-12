import { Buffer } from 'node:buffer';
import type { PersonToolHostV1 } from '@echo-brain/organization-api';
import { validateOrganizationPersonSlackBrowserLinkAttemptRequest, validateOrganizationPersonSlackBrowserLinkBeginRequest } from '../organization-api/person-slack-browser-link.js';
import { SlackPersonAuthorityClient } from './slack-authority-client.js';
import { createPersonSlackIdentityLinkBeginRequest, createPersonSlackIdentityLinkCompleteRequest } from './slack-request-builders.js';

export class SlackPersonClient {
  constructor(private readonly host: PersonToolHostV1) {}

  disconnectSlack() {
    return this.host.withToolSession(async (session) => {
      const result = await new SlackPersonAuthorityClient(session.transport).disconnectSlack();
      if (result.organization_id !== session.identity.organization_id || result.membership_id !== session.identity.membership_id) {
        throw new Error('Connected tools did not match the current account');
      }
      return result;
    });
  }

  beginSlackIdentityLink(recipientUserId: string) {
    return this.host.withToolSession(async (session) => {
      const bytes = session.random_bytes(32);
      try {
        if (bytes.byteLength !== 32) throw new Error('Person client challenge generator returned the wrong size');
        const code = Buffer.from(bytes).toString('base64url');
        const response = await new SlackPersonAuthorityClient(session.transport).beginSlackIdentityLink(
          createPersonSlackIdentityLinkBeginRequest(session.request_id('psb'), code, recipientUserId),
        );
        return { ...response, challenge_code: code };
      } finally { bytes.fill(0); }
    });
  }

  completeSlackIdentityLink(input: { readonly challenge_attempt_id: string; readonly challenge_message_ts: string; readonly challenge_code: string }) {
    return this.host.withToolSession(async (session) => new SlackPersonAuthorityClient(session.transport).completeSlackIdentityLink(
      createPersonSlackIdentityLinkCompleteRequest(session.request_id('psc'), input),
    ));
  }

  beginSlackBrowserLink() {
    return this.host.withToolSession(async (session) => new SlackPersonAuthorityClient(session.transport).beginSlackBrowserLink(
      validateOrganizationPersonSlackBrowserLinkBeginRequest({ request_id: session.request_id('psb') }),
    ));
  }

  slackBrowserLinkStatus(attemptId: string) {
    return this.host.withToolSession(async (session) => new SlackPersonAuthorityClient(session.transport).slackBrowserLinkStatus(
      validateOrganizationPersonSlackBrowserLinkAttemptRequest({ attempt_id: attemptId }),
    ));
  }

  cancelSlackBrowserLink(attemptId: string) {
    return this.host.withToolSession(async (session) => new SlackPersonAuthorityClient(session.transport).cancelSlackBrowserLink(
      validateOrganizationPersonSlackBrowserLinkAttemptRequest({ attempt_id: attemptId }),
    ));
  }
}
