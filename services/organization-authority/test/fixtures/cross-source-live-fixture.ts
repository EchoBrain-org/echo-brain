import { vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import type { PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createHash } from 'node:crypto';
import type { PersonSlackLiveRuntimeFactoryV1 } from '../../src/application/ports/person-slack-live-runtime-v1.js';
import { fakeJiraCloudFetchV1, fakeJiraNangoV1 } from './fake-jira-v1.js';

export const SLACK_TEXT = 'Launchscope Slack message: customer support is ready.';
export const JIRA_TEXT = 'Launchscope Jira ticket: ship after the security review.';
export const SLACK_TEAM = 'TCROSSSOURCE';
export const SLACK_CHANNEL = 'CCROSSSOURCE';

/** An in-memory Slack reader beside fake Jira wire responses exercised through the real Jira reader. */
export function crossSourceLiveFixture(actor: { readonly organization_id: string; readonly owner_principal_id: string; readonly owner_membership_id: string }) {
  const now = new Date();
  const ts = `${Math.floor(now.getTime() / 1000) - 60}.000001`;
  const messages = [SLACK_TEXT, 'Launchscope Slack message: monitoring is ready.', 'Launchscope Slack message: the runbook is ready.'].map((text, index) => ({
    type: 'message', ts: `${Math.floor(now.getTime() / 1000) - 60 * (index + 1)}.000001`, user: 'UAUTHORCROSS', text,
  }));
  let slackGranted = true;
  let slackPermitted = true;
  let revokeAfterRead = false;
  let jiraPermitted = true;
  let beforeSlackResponse: (() => Promise<void>) | undefined;
  const calls: { method: string }[] = [];
  /** Every Slack reader call, so tests can prove a refused source was never read. */
  const slackRead = vi.fn(async (method: string) => {
    calls.push({ method });
    await beforeSlackResponse?.();
  });
  const slackFactory: PersonSlackLiveRuntimeFactoryV1 = sessions => ({
    application: {
      async source(input) {
        const person = sessions.authenticateAccess({ access_token: input.access_token });
        if (!slackGranted) return undefined;
        const requireCurrent = () => {
          const current = sessions.authenticateAccess({ access_token: input.access_token });
          if (!slackPermitted || !slackGranted || current.organization_id !== actor.organization_id || current.principal_id !== actor.owner_principal_id || current.membership_id !== actor.owner_membership_id || current.membership_type !== 'owner' || current.person_state_sha256 !== person.person_state_sha256 || current.session_state_sha256 !== person.session_state_sha256) {
            throw new AuthorityOperationError('unauthorized', 'Synthetic Slack read permission was revoked');
          }
        };
        requireCurrent();
        const binding = { organization_id: actor.organization_id, principal_id: person.principal_id, membership_id: person.membership_id,
          tool_id: 'slack', external_scope_id: SLACK_TEAM, external_subject_id: 'UHUMANCROSS',
          read_grant_sha256: canonicalSha256({ fixture: 'explicit-fixed-public-channel-policy', channel: SLACK_CHANNEL, membership: person.membership_id }) };
        const reader = inMemorySlackReader(binding, messages, slackRead, () => { if (revokeAfterRead) slackPermitted = false; });
        return createAuditedPersonLiveEvidenceSourceV1({ actor: binding, read_grant_sha256: binding.read_grant_sha256,
          access: { tool_id: 'slack', external_scope_id: SLACK_TEAM, external_subject_id: binding.external_subject_id, identity_status: 'linked', read_status: 'connected', read_capabilities: ['live_evidence'] },
          authorization: { assertCurrent: requireCurrent }, reader, audit: input.audit });
      },
    },
    close() {},
  });
  const jira = fakeJiraNangoV1();
  const baseJiraFetch = fakeJiraCloudFetchV1();
  const jiraFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseJiraFetch(input, init);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/issue/bulkfetch')) return jiraPermitted ? response : Response.json({ issues: [], issueErrors: [] });
    if (!path.endsWith('/issue/10001')) return response;
    if (!jiraPermitted) return Response.json({ errorMessages: ['Synthetic issue permission denied'] }, { status: 403 });
    const body = await response.json() as { fields: { summary: string; description: unknown } };
    body.fields.summary = 'Launchscope security review';
    body.fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: JIRA_TEXT }] }] };
    return Response.json(body);
  });
  return { slackFactory, slackRead, slackCalls: calls, ts, jira, jiraFetch,
    beforeSlackResponse(callback: () => Promise<void>) { beforeSlackResponse = callback; },
    disconnectSlack() { slackGranted = false; }, denySlack() { slackPermitted = false; },
    revokeSlackDuringRead() { revokeAfterRead = true; }, denyJira() { jiraPermitted = false; } };
}

type SlackFixtureMessage = { readonly ts: string; readonly user: string; readonly text: string };

/** A fixed public channel's messages: at most two released per call, inventory without text, exact re-checks on revalidate. */
function inMemorySlackReader(
  binding: PersonConnectorReadBindingV1, messages: readonly SlackFixtureMessage[],
  read: (method: string) => Promise<void>, afterProviderRead: () => void,
): PersonLiveEvidenceReaderV1<PersonSlackMessageCitationV1> {
  const citation = (message: SlackFixtureMessage): PersonSlackMessageCitationV1 => Object.freeze({
    kind: 'slack_message', team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, message_ts: message.ts,
    permalink: `https://crosssource.slack.com/archives/${SLACK_CHANNEL}/p${message.ts.replace('.', '')}`,
    text_sha256: `sha256:${createHash('sha256').update(message.text, 'utf8').digest('hex')}`,
  });
  const issued = new Map<string, SlackFixtureMessage>();
  const value = (message: SlackFixtureMessage, text: boolean): PersonLiveEvidenceValueV1<PersonSlackMessageCitationV1> => {
    issued.set(canonicalSha256(citation(message)), message);
    return Object.freeze({ citation: citation(message), handle: `slack_handle_${message.ts}`, label: '#launchscope', visibility: 'team',
      occurred_at: new Date(Number(message.ts.split('.')[0]) * 1000).toISOString().slice(0, 10), ...(text ? { text: message.text } : {}) });
  };
  return Object.freeze({
    binding,
    validateCitation(raw: unknown) {
      const message = issued.get(canonicalSha256(raw));
      if (message === undefined) throw new AuthorityOperationError('unauthorized', 'Slack citation was not issued by this request');
      return Object.freeze({ citation: citation(message), tool_id: 'slack', external_scope_id: SLACK_TEAM, coordinates: Object.freeze({ object_id: message.ts, container_id: SLACK_CHANNEL }) });
    },
    async search(input: { readonly query: string; readonly limit: number }) {
      await read('search');
      const terms = input.query.toLowerCase().split(/\s+/u);
      const found = messages.filter(message => terms.every(term => message.text.toLowerCase().includes(term))).slice(0, Math.min(input.limit, 2));
      afterProviderRead();
      return Object.freeze({ items: Object.freeze(found.map(message => value(message, true))), truncated: true });
    },
    async list(input: { readonly limit: number }) {
      await read('list');
      afterProviderRead();
      return Object.freeze({ items: Object.freeze(messages.slice(0, Math.min(input.limit, 2)).map(message => value(message, false))), truncated: false });
    },
    async open(input: { readonly handle: string }) {
      await read('open');
      const message = messages.find(candidate => `slack_handle_${candidate.ts}` === input.handle);
      if (message === undefined) throw new AuthorityOperationError('not_found', 'Slack item is not available');
      afterProviderRead();
      return Object.freeze({ items: Object.freeze([value(message, true)]), truncated: false });
    },
    async revalidate(input: { readonly citations: readonly PersonSlackMessageCitationV1[] }) {
      await read('revalidate');
      for (const cited of input.citations) if (!issued.has(canonicalSha256(cited))) throw new AuthorityOperationError('unauthorized', 'Slack citation is no longer visible');
    },
  });
}
