import {
  PersonToolOutcomeErrorV1,
  PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, PERSON_TOOL_CONNECT_RESPONSE_MAX_BYTES_V1,
  type PersonToolHostV1,
  type PersonToolProviderV1,
  type PersonToolVerbContextV1,
} from './person-tool-client.js';
import {
  validatePersonToolAttemptStatusV1, validatePersonToolAttemptV1,
  validatePersonToolCommandV1, validatePersonToolConnectV1, validatePersonToolStateV1,
  type PersonToolAttemptStatusV1, type PersonToolConnectV1, type PersonToolConnectionStateV1,
} from './person-tool-connection-v1.js';

interface ConnectionRoutes {
  readonly connect: string;
  readonly status: string;
  readonly cancel: string;
  readonly disconnect: string;
}

/** Uses the host session for every request, including its current-account check. */
export class PersonToolConnectionClientV1 {
  constructor(
    protected readonly host: PersonToolHostV1,
    private readonly display_name: string,
    private readonly routes: ConnectionRoutes,
  ) {}

  connect(): Promise<PersonToolConnectV1> {
    return this.command(this.routes.connect, value => validatePersonToolConnectV1(value, this.display_name), PERSON_TOOL_CONNECT_RESPONSE_MAX_BYTES_V1);
  }
  status(attempt: string): Promise<PersonToolAttemptStatusV1> { return this.attempt(this.routes.status, attempt); }
  cancel(attempt: string): Promise<PersonToolAttemptStatusV1> { return this.attempt(this.routes.cancel, attempt); }
  disconnect(): Promise<PersonToolConnectionStateV1> {
    return this.command(this.routes.disconnect, value => validatePersonToolStateV1(value, false, this.display_name));
  }

  private command<T>(path: string, validate_response: (value: unknown) => T, maximum_response_bytes = PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1): Promise<T> {
    const validate_request = (value: unknown) => validatePersonToolCommandV1(value, this.display_name);
    return this.host.withToolSession(session => session.transport.json({
      path, body: validate_request({ schema_version: 1 }), validate_request, validate_response,
      maximum_response_bytes, timeout_ms: 75_000,
    }));
  }
  private attempt(path: string, attempt: string): Promise<PersonToolAttemptStatusV1> {
    const validate_request = (value: unknown) => validatePersonToolAttemptV1(value, this.display_name);
    return this.host.withToolSession(session => session.transport.json({
      path, body: validate_request({ schema_version: 1, attempt }), validate_request,
      validate_response: value => {
        const response = validatePersonToolAttemptStatusV1(value, this.display_name);
        if (response.attempt !== attempt) throw new Error(`${this.display_name} attempt response did not match the requested attempt`);
        return response;
      },
      maximum_response_bytes: PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1, timeout_ms: 75_000,
    }));
  }
}

async function quietly(operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); } catch { /* Preserve the actionable browser or timeout outcome. */ }
}

function attemptId(context: PersonToolVerbContextV1): string {
  const value = context.values['attempt-id'];
  if (typeof value !== 'string') throw new Error('--attempt-id is required');
  return value;
}

/** Only the consent lifecycle is shared; each tool keeps its own other verbs. */
export function createPersonToolConnectionVerbsV1(
  display_name: string,
  client: (host: PersonToolHostV1) => PersonToolConnectionClientV1,
): PersonToolProviderV1['verbs'] {
  const messages: Readonly<Record<string, string>> = {
    provider_rejected: `${display_name} did not accept this connection. Try again.`,
    provider_unavailable: `${display_name} is unavailable right now. Try again.`,
    account_mismatch: `That ${display_name} account does not match your previously connected ${display_name} account. Try again with that account.`,
  };
  return {
    connect: {
      description: `Opens ${display_name} consent and waits up to 30 minutes. Use --no-wait to check the attempt later.`,
      options: { 'no-wait': { type: 'boolean' } },
      run: async context => {
        const connection = client(context.host);
        const begun = await connection.connect();
        let opened = false;
        try { opened = await context.open_browser(begun.connect_link); } catch { /* Cancel below. */ }
        if (!opened) {
          await quietly(() => connection.cancel(begun.attempt));
          throw new PersonToolOutcomeErrorV1('browser_unavailable', `${display_name} connection page could not be opened.`);
        }
        context.print({ ok: true, phase: 'waiting', attempt: begun.attempt, expires_at: begun.expires_at });
        if (context.values['no-wait'] === true) return;
        for (let poll = 0; poll < 900; poll += 1) {
          await context.sleep(2_000);
          const status = await connection.status(begun.attempt);
          if (status.status === 'pending') continue;
          if (status.status === 'complete') {
            context.print({ ok: true, phase: 'connected', attempt: status.attempt, expires_at: status.expires_at });
            return;
          }
          if (status.status === 'failed') {
            const reason = status.failure_reason!;
            throw new PersonToolOutcomeErrorV1(reason, messages[reason] ?? `${display_name} could not be connected. Try again.`);
          }
          if (status.status === 'expired') throw new PersonToolOutcomeErrorV1('expired', `The ${display_name} connection attempt expired. Try again.`);
          throw new PersonToolOutcomeErrorV1('cancelled', `The ${display_name} connection attempt was cancelled.`);
        }
        await quietly(() => connection.cancel(begun.attempt));
        throw new PersonToolOutcomeErrorV1('timed_out', `The ${display_name} connection attempt took too long. Try again.`);
      },
    },
    status: {
      description: `Reads a ${display_name} connection attempt started with --no-wait.`,
      options: { 'attempt-id': { type: 'string' } }, requires: ['attempt-id'],
      run: async context => { context.print({ ok: true, result: await client(context.host).status(attemptId(context)) }); },
    },
    cancel: {
      description: `Cancels a pending ${display_name} connection attempt.`,
      options: { 'attempt-id': { type: 'string' } }, requires: ['attempt-id'],
      run: async context => { context.print({ ok: true, result: await client(context.host).cancel(attemptId(context)) }); },
    },
    disconnect: {
      description: `Disconnects your ${display_name} account.`, options: {},
      run: async context => { context.print({ ok: true, result: await client(context.host).disconnect() }); },
    },
  };
}
