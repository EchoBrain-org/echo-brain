import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { PersonClient } from './client.js';

const MAXIMUM_INPUT_BYTES = 64 * 1024;

interface Output {
  write(value: string): unknown;
}

export interface PersonClientCliDependencies {
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly home_directory?: string;
  readonly fetch?: typeof fetch;
  readonly allow_insecure_loopback?: boolean;
  readonly now?: () => string;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly random_uuid?: () => string;
  readonly read_input?: () => string | Promise<string>;
}

const OPTIONS = {
  'authority-url': { type: 'string' },
  bootstrap: { type: 'boolean' },
  query: { type: 'string' },
  'source-adapter-id': { type: 'string' },
  'source-instance-id': { type: 'string' },
  'meeting-external-id': { type: 'string' },
  'challenge-attempt': { type: 'string' },
  'challenge-message-ts': { type: 'string' },
} as const;

type Option = keyof typeof OPTIONS;

const RULES: Readonly<
  Record<string, { accepts?: readonly Option[]; requires?: readonly Option[] }>
> = {
  'login-begin': {
    accepts: ['authority-url', 'bootstrap'],
    requires: ['authority-url'],
  },
  'session-install': {
    accepts: ['authority-url'],
    requires: ['authority-url'],
  },
  'session-refresh': {},
  logout: {},
  'recent-decisions': {},
  'reviewer-recent-decisions': {},
  'readable-search': { accepts: ['query'], requires: ['query'] },
  exclusions: {
    accepts: ['source-adapter-id', 'source-instance-id'],
    requires: ['source-adapter-id', 'source-instance-id'],
  },
  exclude: {
    accepts: [
      'source-adapter-id',
      'source-instance-id',
      'meeting-external-id',
    ],
    requires: ['source-adapter-id', 'source-instance-id'],
  },
  include: {
    accepts: [
      'source-adapter-id',
      'source-instance-id',
      'meeting-external-id',
    ],
    requires: ['source-adapter-id', 'source-instance-id'],
  },
  'slack-link-begin': {},
  'slack-link-complete': {
    accepts: ['challenge-attempt', 'challenge-message-ts'],
    requires: ['challenge-attempt', 'challenge-message-ts'],
  },
};

function usage(): string {
  return `usage: echo-brain person <${Object.keys(RULES).join('|')}>`;
}

function print(output: Output, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAXIMUM_INPUT_BYTES) {
      throw new Error('Person client input exceeds 64 KiB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function requiredText(
  values: Record<Option, string | boolean | undefined>,
  option: Option,
): string {
  const value = values[option];
  if (typeof value !== 'string') throw new Error(`missing --${option}`);
  return value;
}

export async function runPersonClientCli(
  argv: readonly string[],
  dependencies: PersonClientCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const action = argv[0] ?? '';
  const rule = RULES[action];
  if (rule === undefined) {
    print(stderr, { ok: false, error: usage() });
    return 2;
  }

  let values: Record<Option, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv.slice(1)],
      strict: true,
      allowPositionals: false,
      options: OPTIONS,
    }).values as Record<Option, string | boolean | undefined>;
    const accepted = new Set(rule.accepts ?? []);
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && !accepted.has(name as Option)) {
        throw new Error(`--${name} is not valid with \`echo-brain person ${action}\``);
      }
    }
    for (const required of rule.requires ?? []) {
      if (values[required] === undefined) {
        throw new Error(
          `\`echo-brain person ${action}\` requires --${required}`,
        );
      }
    }
  } catch (error) {
    print(stderr, { ok: false, error: (error as Error).message });
    return 2;
  }

  const client = new PersonClient({
    home_directory: dependencies.home_directory ?? homedir(),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    allow_insecure_loopback:
      dependencies.allow_insecure_loopback === true,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.random_bytes === undefined
      ? {}
      : { random_bytes: dependencies.random_bytes }),
    ...(dependencies.random_uuid === undefined
      ? {}
      : { random_uuid: dependencies.random_uuid }),
  });
  const readInput = dependencies.read_input ?? readBoundedStdin;

  try {
    switch (action) {
      case 'login-begin': {
        const loginGrant =
          values.bootstrap === true ? (await readInput()).trim() : undefined;
        print(stdout, {
          ok: true,
          ...(await client.beginLogin(
            requiredText(values, 'authority-url'),
            loginGrant,
          )),
        });
        break;
      }
      case 'session-install':
        print(stdout, {
          ok: true,
          ...(await client.installSession(
            requiredText(values, 'authority-url'),
            JSON.parse(await readInput()) as unknown,
          )),
        });
        break;
      case 'session-refresh':
        print(stdout, { ok: true, ...(await client.refresh()) });
        break;
      case 'logout':
        await client.logout();
        print(stdout, { ok: true });
        break;
      case 'recent-decisions':
        print(stdout, { ok: true, result: await client.recentDecisions() });
        break;
      case 'reviewer-recent-decisions':
        print(stdout, {
          ok: true,
          result: await client.reviewerRecentDecisions(),
        });
        break;
      case 'readable-search':
        print(stdout, {
          ok: true,
          result: await client.readableSearch(requiredText(values, 'query')),
        });
        break;
      case 'exclusions':
        print(stdout, {
          ok: true,
          result: await client.exclusions(
            requiredText(values, 'source-adapter-id'),
            requiredText(values, 'source-instance-id'),
          ),
        });
        break;
      case 'exclude':
      case 'include': {
        const sourceAdapterId = requiredText(values, 'source-adapter-id');
        const sourceInstanceId = requiredText(values, 'source-instance-id');
        const externalId = values['meeting-external-id'];
        await client.changeExclusion(
          action === 'exclude',
          typeof externalId === 'string'
            ? {
                scope: 'meeting',
                source_adapter_id: sourceAdapterId,
                source_instance_id: sourceInstanceId,
                external_id: externalId,
              }
            : {
                scope: 'source',
                source_adapter_id: sourceAdapterId,
                source_instance_id: sourceInstanceId,
              },
        );
        print(stdout, { ok: true, excluded: action === 'exclude' });
        break;
      }
      case 'slack-link-begin':
        print(stdout, { ok: true, ...(await client.beginSlackLink()) });
        break;
      case 'slack-link-complete':
        print(stdout, {
          ok: true,
          result: await client.completeSlackLink({
            challenge_attempt_id: requiredText(values, 'challenge-attempt'),
            challenge_message_ts: requiredText(
              values,
              'challenge-message-ts',
            ),
            challenge_code: (await readInput()).trim(),
          }),
        });
        break;
    }
    return 0;
  } catch (error) {
    print(stderr, {
      ok: false,
      action,
      error: (error as Error).message,
    });
    return 1;
  }
}
