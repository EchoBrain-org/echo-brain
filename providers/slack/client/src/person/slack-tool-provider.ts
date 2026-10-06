import { PersonToolOutcomeErrorV1, type PersonToolProviderV1, type PersonToolVerbContextV1 } from '@echo-brain/organization-api';
import { asEnumerableRecord, assertExactKeys } from '@echo-brain/organization-api/validation';
import {
  validateOrganizationSlackAppClientIdV1,
  validateOrganizationSlackAppClientSecretV1,
  validateOrganizationSlackAppSigningSecretV1,
  validateOrganizationSlackConfigurationTokenV1,
  validateOrganizationSlackExistingAppV1,
} from '../organization-api/organization-slack-setup-v1.js';
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
  app_mismatch: 'Slack authorized a different app than the app saved in ECHO. Check the selected app\'s client ID and the Nango session\'s app before retrying. Do not change shared Nango integration credentials.',
  attempt_mismatch: 'The Slack install did not belong to this setup attempt. Close older install tabs, then run setup with --reconnect to reuse your saved credentials.',
  identity_mismatch: 'Slack and Nango reported different workspace or bot identities for the install. The connection was refused; investigate the provider connection before retrying. Your app credentials are saved.',
  workspace_mismatch: "The install did not match this organization's existing Slack workspace or bot. Run setup with --reconnect and choose the organization's workspace; your app credentials are saved.",
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
const EXISTING_APP_CONFIGURATION_TOKEN_PROMPT = 'Paste the selected Slack app configuration token (input hidden).';
const EXISTING_APP_CLIENT_ID_PROMPT = 'Paste the selected Slack app client ID (input hidden).';
const EXISTING_APP_CLIENT_SECRET_PROMPT = 'Paste the selected Slack app client secret (input hidden).';
const EXISTING_APP_SIGNING_SECRET_PROMPT = 'Paste the selected Slack app signing secret (input hidden).';

function existingAppJsonInput(raw: string, appId: string) {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) throw new Error();
    const input = asEnumerableRecord(JSON.parse(raw), 'Slack existing-app input');
    assertExactKeys(input, ['configuration_token', 'client_id', 'client_secret', 'signing_secret'], 'Slack existing-app input');
    return existingAppFieldsInput({ configurationToken: input.configuration_token, clientId: input.client_id,
      clientSecret: input.client_secret, signingSecret: input.signing_secret }, appId);
  } catch {
    // JSON parser errors can contain the document, including credential bytes.
    throw new Error('Slack existing-app input is invalid');
  }
}

function existingAppFieldsInput(input: {
  readonly configurationToken: unknown;
  readonly clientId: unknown;
  readonly clientSecret: unknown;
  readonly signingSecret: unknown;
}, appId: string) {
  const configurationToken = validateOrganizationSlackConfigurationTokenV1(input.configurationToken);
  const existingApp = validateOrganizationSlackExistingAppV1({ app_id: appId,
    client_id: input.clientId, client_secret: input.clientSecret, signing_secret: input.signingSecret,
  });
  return { configurationToken, existingApp };
}

function isExistingAppJsonInput(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[') || value === 'null';
}

async function existingAppInput(context: PersonToolVerbContextV1, appId: string) {
  const configurationToken = (await context.read_secret_line(EXISTING_APP_CONFIGURATION_TOKEN_PROMPT)).trim();
  if (isExistingAppJsonInput(configurationToken)) return existingAppJsonInput(configurationToken, appId);
  const validConfigurationToken = validateOrganizationSlackConfigurationTokenV1(configurationToken);
  const clientId = validateOrganizationSlackAppClientIdV1((await context.read_secret_line(EXISTING_APP_CLIENT_ID_PROMPT)).trim());
  const clientSecret = validateOrganizationSlackAppClientSecretV1((await context.read_secret_line(EXISTING_APP_CLIENT_SECRET_PROMPT)).trim());
  const signingSecret = validateOrganizationSlackAppSigningSecretV1((await context.read_secret_line(EXISTING_APP_SIGNING_SECRET_PROMPT)).trim());
  return existingAppFieldsInput({ configurationToken: validConfigurationToken, clientId, clientSecret, signingSecret }, appId);
}

async function setup(context: PersonToolVerbContextV1): Promise<void> {
  const { host } = context;
  const existingAppId = context.values['existing-app'];
  if (existingAppId !== undefined && context.values.reconnect === true) throw new Error('--existing-app and --reconnect are mutually exclusive');
  if (existingAppId !== undefined && (typeof existingAppId !== 'string' || !/^A[A-Z0-9]{2,63}$/.test(existingAppId))) {
    throw new Error('--existing-app must be a Slack app ID');
  }
  try {
    if (context.values.reconnect !== true) {
      const input = existingAppId === undefined
        ? { configurationToken: (await context.read_secret_line(SETUP_TOKEN_PROMPT)).trim(), existingApp: undefined }
        : await existingAppInput(context, existingAppId);
      const app = await setupSlackApp(host, input.configurationToken, input.existingApp);
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
      description: 'Owner only. Reads a Slack app configuration token from standard input (hidden at a terminal), creates or updates the ECHO app, opens Install and waits up to 10 minutes. --existing-app <A…> adopts that app with named hidden prompts for its configuration token, client ID, client secret and signing secret; scripts may still send one JSON line. --reconnect reuses saved app credentials and installs the app already set up. --existing-app and --reconnect are mutually exclusive.',
      options: { reconnect: { type: 'boolean' }, 'existing-app': { type: 'string' }, 'no-wait': noWait },
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
