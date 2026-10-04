import { expect, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createAuditedPersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/audited-person-live-evidence-v1';
import { createSlackContextTransportV1 } from '@echo-brain/provider-slack-server/context/slack-context-transport-v1';
import { createSlackChannelLiveEvidenceReaderV1 } from '@echo-brain/provider-slack-server/context/slack-channel-live-evidence-reader-v1';
import type { PersonSlackLiveRuntimeFactoryV1 } from '../../src/application/ports/person-slack-live-runtime-v1.js';
import { fakeJiraCloudFetchV1, fakeJiraNangoV1 } from './fake-jira-v1.js';

export const SLACK_TEXT = 'Launchscope Slack message: customer support is ready.';
export const JIRA_TEXT = 'Launchscope Jira ticket: ship after the security review.';
export const SLACK_TEAM = 'TCROSSSOURCE';
export const SLACK_CHANNEL = 'CCROSSSOURCE';

/** Fake provider wire responses, exercised through the real Slack and Jira readers. */
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
  const calls: { method: string; query: Readonly<Record<string, string>> }[] = [];
  const slackFetch = vi.fn(async (url: string, init: RequestInit) => {
    const target = new URL(url);
    expect(target.origin).toBe('https://slack.com');
    expect(init.redirect).toBe('error');
    const method = target.pathname.split('/').at(-1)!;
    const query = Object.fromEntries(target.searchParams.entries());
    calls.push({ method, query });
    await beforeSlackResponse?.();
    if (method === 'auth.test') return Response.json({ ok: true, team_id: SLACK_TEAM, user_id: 'UBOTCROSS', url: 'https://crosssource.slack.com/' });
    if (method === 'conversations.info') {
      expect(query.channel).toBe(SLACK_CHANNEL);
      return Response.json({ ok: true, channel: { id: SLACK_CHANNEL, name: 'launchscope', is_member: true, is_private: false, is_im: false, is_mpim: false, context_team_id: SLACK_TEAM } });
    }
    if (method === 'conversations.history') {
      expect(query.channel).toBe(SLACK_CHANNEL);
      expect(Number(query.limit)).toBeLessThanOrEqual(15);
      if (revokeAfterRead) slackPermitted = false;
      const selected = messages.filter(message => (query.oldest === undefined || Number(message.ts) >= Number(query.oldest)) && (query.latest === undefined || Number(message.ts) <= Number(query.latest))).slice(0, Number(query.limit));
      return Response.json({ ok: true, messages: selected, has_more: false, response_metadata: { next_cursor: '' } });
    }
    if (method === 'chat.getPermalink') {
      expect(query.channel).toBe(SLACK_CHANNEL);
      expect(messages.some(message => message.ts === query.message_ts)).toBe(true);
      return Response.json({ ok: true, channel: SLACK_CHANNEL, permalink: `https://crosssource.slack.com/archives/${SLACK_CHANNEL}/p${query.message_ts!.replace('.', '')}` });
    }
    throw new Error('Unexpected synthetic Slack endpoint');
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
        const reader = createSlackChannelLiveEvidenceReaderV1({
          transport: createSlackContextTransportV1({ binding, fetch: slackFetch }),
          team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, expected_bot_user_id: 'UBOTCROSS', now: () => now,
        });
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
  return { slackFactory, slackFetch, slackCalls: calls, ts, jira, jiraFetch,
    beforeSlackResponse(callback: () => Promise<void>) { beforeSlackResponse = callback; },
    disconnectSlack() { slackGranted = false; }, denySlack() { slackPermitted = false; },
    revokeSlackDuringRead() { revokeAfterRead = true; }, denyJira() { jiraPermitted = false; } };
}
