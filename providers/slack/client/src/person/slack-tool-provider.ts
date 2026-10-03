import { PersonToolOutcomeErrorV1, type PersonToolProviderV1, type PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { beginSlackBrowserLink, beginSlackIdentityLink, beginSlackInstall, cancelSlackBrowserLink, cancelSlackInstall, completeSlackIdentityLink, disconnectSlack, setupSlackApp, slackBrowserLinkStatus, slackInstallStatus } from './slack-person-client.js';

const POLL_MS = 2_000;
// The Authority expires an install after 10 minutes and a sign-in after 5;
// these bound a client that is never told.
const INSTALL_POLLS = 300;
const SIGN_IN_POLLS = 150;

interface Attempt {
  readonly attempt_id: string;
  readonly expires_at: string;
}
interface AttemptStatus {
  readonly status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  readonly failure_reason: string | null;
}
interface AttemptSteps {
  readonly polls: number;
  read(): Promise<AttemptStatus>;
  cancel(): Promise<unknown>;
  readonly failures: Readonly<Record<string, string>>;
  readonly expired: string;
}

const INSTALL_FAILURES = {
  provider_rejected: 'Slack refused the install. Try again.',
  provider_unavailable: 'Slack setup is unavailable right now. Try again.',
  permissions_missing: 'The install did not grant the permissions ECHO needs. Try again.',
  workspace_mismatch: "The install did not match this organization's Slack app and workspace. Run setup again with --reconnect and choose the organization's workspace.",
  already_connected: 'Slack is already connected to a different app or workspace.',
};
const SIGN_IN_FAILURES = {
  provider_rejected: "Slack did not confirm the account. Sign in to your organization's Slack workspace, then try again.",
  provider_unavailable: 'Slack is unavailable right now. Try again.',
  identity_conflict: 'This Slack account is connected to another ECHO person.',
  tool_unavailable: 'Not set up by your organization. Ask an owner.',
};

/** A failed cancel changes nothing: the Authority still expires the attempt. */
async function quietly(step: () => Promise<unknown>): Promise<void> {
  try { await step(); } catch { /* keep the caller's error */ }
}

async function opened(context: PersonToolVerbContextV1, url: string): Promise<boolean> {
  try { return await context.open_browser(url); } catch { return false; }
}

/**
 * Opens the attempt's page (a page that never opened is cancelled), prints the
 * attempt, then, unless --no-wait, reads its status every 2 s until it settles.
 */
async function openAndWait(context: PersonToolVerbContextV1, begun: Attempt, url: string, closed: string, steps: AttemptSteps): Promise<void> {
  if (!await opened(context, url)) {
    await quietly(steps.cancel);
    throw new Error(closed);
  }
  context.print({ ok: true, phase: 'waiting', attempt_id: begun.attempt_id, expires_at: begun.expires_at });
  if (context.values['no-wait'] === true) return;
  for (let poll = 0; poll < steps.polls; poll += 1) {
    await context.sleep(POLL_MS);
    const status = await steps.read();
    if (status.status === 'pending') continue;
    if (status.status === 'complete') return context.print({ ok: true, phase: 'connected', result: status });
    if (status.status === 'failed') {
      const reason = status.failure_reason ?? 'failed';
      throw new PersonToolOutcomeErrorV1(reason, steps.failures[reason] ?? 'Slack could not be connected. Try again.');
    }
    throw status.status === 'expired' ? new PersonToolOutcomeErrorV1('expired', steps.expired)
      : new PersonToolOutcomeErrorV1('cancelled', 'The Slack step was cancelled.');
  }
  await quietly(steps.cancel);
  throw new PersonToolOutcomeErrorV1('timed_out', 'That took too long. Try again.');
}

const SETUP_TOKEN_PROMPT = 'Paste the Slack app configuration token (input hidden). Generate one at https://api.slack.com/apps → Your App Configuration Tokens.';

async function setup(context: PersonToolVerbContextV1): Promise<void> {
  const { host } = context;
  try {
    if (context.values.reconnect !== true) {
      const app = await setupSlackApp(host, (await context.read_secret_line(SETUP_TOKEN_PROMPT)).trim());
      context.print({ ok: true, phase: 'app-ready', app_id: app.app_id, organization_setup: app.organization_setup });
    }
    const begun = await beginSlackInstall(host);
    await openAndWait(context, begun, begun.connect_link, 'Slack connect page could not be opened', {
      polls: INSTALL_POLLS, failures: INSTALL_FAILURES,
      read: () => slackInstallStatus(host, begun.attempt_id), cancel: () => cancelSlackInstall(host, begun.attempt_id),
      expired: "Not finished. If your Slack requires admin approval, try again once it's approved.",
    });
  } catch (error) {
    // The Authority refuses a non-owner on every setup route with only its `unauthorized` code.
    if ((error as { code?: unknown } | null)?.code !== 'unauthorized') throw error;
    throw new PersonToolOutcomeErrorV1('unauthorized', 'Only an organization owner can set up Slack.');
  }
}

/** For machines without a browser: the person replies in a Slack DM with a code, then presses Enter. */
async function linkByDirectMessageCode(context: PersonToolVerbContextV1): Promise<void> {
  const slackUser = context.values['slack-user'];
  if (typeof slackUser !== 'string') throw new Error('--method dm-code requires --slack-user');
  if (context.values['no-wait'] === true) throw new Error('--no-wait is not valid with --method dm-code');
  const begun = await beginSlackIdentityLink(context.host, slackUser);
  // The opaque challenge handles stay in memory; only the code is shown.
  context.print({ ok: true, phase: 'reply-in-slack', challenge_code: begun.challenge_code, expires_at: begun.expires_at,
    instruction: 'Reply with challenge_code in the Slack thread, then press Enter here to confirm.' });
  if ((await context.read_interactive_line()).trim().length !== 0) {
    throw new Error('Person Slack identity-link confirmation must be an empty Enter acknowledgement');
  }
  context.print({ ok: true, phase: 'linked', result: await completeSlackIdentityLink(context.host, {
    challenge_attempt_id: begun.challenge_attempt_id, challenge_message_ts: begun.challenge_message_ts, challenge_code: begun.challenge_code,
  }) });
}

async function connect(context: PersonToolVerbContextV1): Promise<void> {
  const { host } = context;
  const method = context.values.method ?? 'browser';
  if (method === 'dm-code') return linkByDirectMessageCode(context);
  if (method !== 'browser') throw new Error('--method must be browser or dm-code');
  if (context.values['slack-user'] !== undefined) throw new Error('--slack-user is valid only with --method dm-code');
  const begun = await beginSlackBrowserLink(host);
  await openAndWait(context, begun, begun.authorization_url, 'Slack authorization browser could not be opened', {
    polls: SIGN_IN_POLLS, failures: SIGN_IN_FAILURES,
    read: () => slackBrowserLinkStatus(host, begun.attempt_id), cancel: () => cancelSlackBrowserLink(host, begun.attempt_id),
    expired: 'That took too long. Try again.',
  });
}

/** Routes by prefix: `ssi_` is an owner's install, `sbl_` a person's sign-in. */
async function attempt(context: PersonToolVerbContextV1, verb: 'status' | 'cancel'): Promise<void> {
  const { host } = context;
  const id = String(context.values['attempt-id']);
  let result: unknown;
  if (id.startsWith('ssi_')) result = verb === 'status' ? await slackInstallStatus(host, id) : await cancelSlackInstall(host, id);
  else if (id.startsWith('sbl_')) result = verb === 'status' ? await slackBrowserLinkStatus(host, id) : await cancelSlackBrowserLink(host, id);
  else throw new Error('--attempt-id must be an ssi_ setup attempt or an sbl_ connect attempt');
  context.print({ ok: true, result });
}

const attemptId = { 'attempt-id': { type: 'string' } } as const;
const noWait = { type: 'boolean' } as const;

export function createSlackPersonToolProviderV1(): PersonToolProviderV1 {
  const verbs: PersonToolProviderV1['verbs'] = {
    setup: {
      description: 'Owner only. Reads a Slack app configuration token from standard input (hidden at a terminal), creates or updates the ECHO app, opens Install and waits up to 10 minutes. --reconnect reads no token and installs the app already set up.',
      options: { reconnect: { type: 'boolean' }, 'no-wait': noWait },
      run: setup,
    },
    connect: {
      description: 'Opens Slack sign-in and waits up to 5 minutes. Without a browser: --method dm-code --slack-user <U…> links by a code you reply with in a Slack DM.',
      options: { method: { type: 'string' }, 'slack-user': { type: 'string' }, 'no-wait': noWait },
      run: connect,
    },
    disconnect: {
      description: 'Removes your personal Slack link.',
      options: {},
      run: async (context) => context.print({ ok: true, result: await disconnectSlack(context.host) }),
    },
    status: {
      description: 'Reads a step started with --no-wait: an ssi_ setup or sbl_ connect attempt.',
      options: attemptId, requires: ['attempt-id'],
      run: (context) => attempt(context, 'status'),
    },
    cancel: {
      description: 'Cancels a step started with --no-wait: an ssi_ setup or sbl_ connect attempt.',
      options: attemptId, requires: ['attempt-id'],
      run: (context) => attempt(context, 'cancel'),
    },
  };
  return Object.freeze({ tool_id: 'slack', verbs: Object.freeze(verbs) });
}
