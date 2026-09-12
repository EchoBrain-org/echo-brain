import type { PersonToolCommandV1 } from '@echo-brain/organization-api';
import { SlackPersonClient } from './slack-person-client.js';

function requiredText(values: Readonly<Record<string, string | boolean | undefined>>, option: string): string {
  const value = values[option];
  if (typeof value !== 'string') throw new Error(`missing --${option}`);
  return value;
}

async function beginSlackBrowserConnect(
  client: SlackPersonClient,
  opener: (url: string) => boolean | Promise<boolean>,
) {
  const begun = await client.beginSlackBrowserLink();
  let opened = false;
  try {
    opened = await opener(begun.authorization_url);
  } catch {
    opened = false;
  }
  if (!opened) {
    // A browser connection that never opened is not useful and should not
    // remain a pending authorization on the Authority.
    try {
      await client.cancelSlackBrowserLink(begun.attempt_id);
    } catch {
      // Preserve the browser-launch error. The Authority still bounds expiry.
    }
    throw new Error("Slack authorization browser could not be opened");
  }
  return begun;
}


const definitions = [
  ['slack-link-begin', ['slack-user'], 'Start a private-DM Slack link.'],
  ['slack-link', ['slack-user'], 'Legacy private-DM Slack linking command.'],
  ['slack-link-complete', ['challenge-attempt', 'challenge-message-ts'], 'Complete a private-DM Slack link.'],
  ['slack-connect-begin', [], 'Open Slack browser connection.'],
  ['slack-connect-status', ['attempt-id'], 'Read Slack browser connection status.'],
  ['slack-connect-cancel', ['attempt-id'], 'Cancel a pending Slack browser connection.'],
  ['slack-disconnect', [], 'Remove your personal Slack link.'],
] as const;

export function createSlackPersonCommandsV1(): readonly PersonToolCommandV1[] {
  return Object.freeze(definitions.map(([name, required, description]) => Object.freeze({
    name, description,
    options: Object.freeze(Object.fromEntries(required.map(key => [key, { type: 'string' as const }]))),
    requires: required,
    async run({ host, values, print, read_input: readInput, read_interactive_line: readInteractiveLine, open_browser }: Parameters<PersonToolCommandV1['run']>[0]) {
      const client = new SlackPersonClient(host);
      switch (name) {
      case "slack-link-begin":
        print( { ok: true, ...(await client.beginSlackIdentityLink(requiredText(values, "slack-user"))) });
        break;
      case "slack-link": {
        const begun = await client.beginSlackIdentityLink(requiredText(values, "slack-user"));
        // Retain the code and opaque challenge handles in memory. The person
        // copies the code into Slack, then confirms with one empty line.
        print( {
          ok: true,
          phase: "reply-in-slack",
          challenge_code: begun.challenge_code,
          expires_at: begun.expires_at,
          instruction:
            "Reply with challenge_code in the Slack thread, then press Enter here to confirm.",
        });
        const acknowledgement = await readInteractiveLine();
        if (acknowledgement.trim().length !== 0) {
          throw new Error(
            "Person Slack identity-link confirmation must be an empty Enter acknowledgement",
          );
        }
        print( {
          ok: true,
          phase: "linked",
          result: await client.completeSlackIdentityLink({
            challenge_attempt_id: begun.challenge_attempt_id,
            challenge_message_ts: begun.challenge_message_ts,
            challenge_code: begun.challenge_code,
          }),
        });
        break;
      }
      case "slack-link-complete":
        print( {
          ok: true,
          result: await client.completeSlackIdentityLink({
            challenge_attempt_id: requiredText(values, "challenge-attempt"),
            challenge_message_ts: requiredText(values, "challenge-message-ts"),
            challenge_code: (await readInput()).trim(),
          }),
        });
        break;
      case "slack-connect-begin": {
        const begun = await beginSlackBrowserConnect(
          client,
          open_browser,
        );
        // The attempt ID is an opaque cancellation/polling handle. The
        // authorization URL remains solely in the process that opened it.
        print( {
          ok: true,
          phase: "waiting-for-slack",
          attempt_id: begun.attempt_id,
          expires_at: begun.expires_at,
        });
        break;
      }
      case "slack-connect-status": {
        const status = await client.slackBrowserLinkStatus(
          requiredText(values, "attempt-id"),
        );
        print( { ok: true, ...status });
        break;
      }
      case "slack-connect-cancel": {
        const status = await client.cancelSlackBrowserLink(
          requiredText(values, "attempt-id"),
        );
        print( { ok: true, ...status });
        break;
      }
      case "slack-disconnect":
        print( { ok: true, result: await client.disconnectSlack() });
        break;
      }
    },
  })));
}
