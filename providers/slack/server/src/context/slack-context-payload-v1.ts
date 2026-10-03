import type { ContextCaptureContentV1 } from '@echo-brain/organization-processing/core';
import { SLACK_CONTEXT_BOT_V1, SLACK_CONTEXT_TS_V1, SLACK_CONTEXT_USER_V1, requireSlackContextResponseV1,
  slackContextFailureV1, slackContextRecordV1, slackContextStringV1, slackContextTimestampIsoV1, slackContextTimestampMicrosV1 } from './slack-context-validation-v1.js';

/** A message's exact provider coordinates stay distinct from any ECHO person or truth. */
export function parseSlackContextMessageV1(value: unknown, input: {
  readonly team_id: string;
  readonly channel_id: string;
  readonly workspace_origin: string;
  readonly permalink: unknown;
}): { readonly external_id: string; readonly content: ContextCaptureContentV1 } {
  const message = slackContextRecordV1(value);
  if (message.type !== 'message' || (message.channel !== undefined && message.channel !== input.channel_id) ||
      (message.team !== undefined && message.team !== input.team_id)) slackContextFailureV1('invalid_output');
  const ts = slackContextStringV1(message.ts, 19, SLACK_CONTEXT_TS_V1);
  const sentAt = slackContextTimestampIsoV1(ts);
  const channelRef = `slack:team:${input.team_id}:channel:${input.channel_id}`;
  let authorRef: string | undefined;
  if (message.user !== undefined) authorRef = `slack:team:${input.team_id}:user:${slackContextStringV1(message.user, 64, SLACK_CONTEXT_USER_V1)}`;
  if (message.bot_id !== undefined) {
    const bot = slackContextStringV1(message.bot_id, 64, SLACK_CONTEXT_BOT_V1);
    authorRef ??= `slack:team:${input.team_id}:bot:${bot}`;
  }
  const threadTs = message.thread_ts === undefined ? undefined : slackContextStringV1(message.thread_ts, 19, SLACK_CONTEXT_TS_V1);
  if (threadTs !== undefined && slackContextTimestampMicrosV1(threadTs) > slackContextTimestampMicrosV1(ts)) slackContextFailureV1('invalid_output');
  let updatedAt: string | undefined;
  if (message.edited !== undefined) {
    const edited = slackContextRecordV1(message.edited);
    slackContextStringV1(edited.user, 64, SLACK_CONTEXT_USER_V1);
    if (slackContextTimestampMicrosV1(edited.ts) < slackContextTimestampMicrosV1(ts)) slackContextFailureV1('invalid_output');
    updatedAt = slackContextTimestampIsoV1(edited.ts);
  }

  // Slack owns permalink construction (including thread query parameters).
  // Validate its authenticated response; never request or synthesize this URL.
  const response = requireSlackContextResponseV1(input.permalink);
  if (response.channel !== input.channel_id) slackContextFailureV1('invalid_output');
  const pointer = slackContextStringV1(response.permalink, 2048);
  let url: URL;
  try { url = new URL(pointer); } catch { slackContextFailureV1('invalid_output'); }
  const expectedPath = `/archives/${input.channel_id}/p${ts.replace('.', '')}`;
  if (url.origin !== input.workspace_origin || url.pathname !== expectedPath || url.protocol !== 'https:' ||
      url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '' || url.href !== pointer) slackContextFailureV1('invalid_output');
  const query = [...url.searchParams.entries()];
  if (query.length !== 0 && (threadTs === undefined || query.length !== 2 ||
      url.searchParams.getAll('thread_ts').length !== 1 || url.searchParams.getAll('cid').length !== 1 ||
      url.searchParams.get('thread_ts') !== threadTs || url.searchParams.get('cid') !== input.channel_id)) slackContextFailureV1('invalid_output');

  return {
    external_id: `message:${ts}`,
    content: {
      schema_version: 1, kind: 'echo-context-capture-v1',
      label: `Slack message ${ts} in ${input.channel_id}`,
      provenance: { origin_ref: pointer, ...(updatedAt === undefined ? {} : { source_updated_at: updatedAt }) },
      payload: { schema_version: 1, kind: 'message', channel_ref: channelRef, sent_at: sentAt,
        ...(threadTs === undefined ? {} : { thread_ref: `${channelRef}:message:${threadTs}` }),
        ...(authorRef === undefined ? {} : { author_ref: authorRef }) },
      representation: { kind: 'pointer', pointer },
    },
  };
}
