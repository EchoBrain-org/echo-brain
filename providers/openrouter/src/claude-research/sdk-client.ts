import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeAccountEnvironmentV1, type ClaudeAccountProfileV1 } from './account-profile.js';

export interface ClaudeResearchRunV1 {
  readonly prompt: string;
  readonly system: string;
  readonly model: string;
  readonly base_url: string;
  readonly signal: AbortSignal;
  readonly servers: NonNullable<Options['mcpServers']>;
  readonly tools: readonly string[];
  readonly account?: ClaudeAccountProfileV1;
}

/** A started SDK session failed: an error result (provider refusals after its retry, output retries) or the child exited. */
export class ClaudeResearchResultErrorV1 extends Error {
  constructor() { super('Claude research did not complete'); this.name = 'ClaudeResearchResultErrorV1'; }
}

/** Each request gets an empty working directory and only ECHO tools; personal runs preserve native sign-in. */
export async function runClaudeResearchV1(input: ClaudeResearchRunV1, sdkQuery: typeof query = query): Promise<void> {
  await runClaudeSessionV1(input, { type: 'object', additionalProperties: false, required: ['finished'], properties: { finished: { type: 'boolean' } } }, sdkQuery);
}

/** A separate native writing pass: same isolated runtime, no research tools, ECHO's answer schema. */
export async function runClaudeStructuredV1(input: Omit<ClaudeResearchRunV1, 'servers' | 'tools'> & { readonly schema: Record<string, unknown>; readonly max_output_tokens: number }, sdkQuery: typeof query = query): Promise<unknown> {
  const result = await runClaudeSessionV1({ ...input, servers: {}, tools: [] }, input.schema, sdkQuery, input.max_output_tokens);
  if (result.structured_output === undefined) throw new ClaudeResearchResultErrorV1();
  return result.structured_output;
}

async function runClaudeSessionV1(input: ClaudeResearchRunV1, schema: Record<string, unknown>, sdkQuery: typeof query, maxOutputTokens?: number) {
  input.signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), 'echo-research-'));
  const abortController = new AbortController();
  const cancel = () => abortController.abort(input.signal.reason);
  input.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal.aborted) cancel();
  // Service runs have no provider credential. A personal run selects native sign-in below.
  // Both routes must pass the same loopback model-admission gate.
  const env: Record<string, string> = {
    HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data'), XDG_STATE_HOME: join(cwd, 'state'),
    CLAUDE_CONFIG_DIR: join(cwd, 'claude'), TMPDIR: cwd, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: input.base_url, ANTHROPIC_AUTH_TOKEN: 'echo-loopback-only', ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.model, ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model, ANTHROPIC_DEFAULT_FABLE_MODEL: input.model,
    CLAUDE_CODE_SUBAGENT_MODEL: input.model, ANTHROPIC_SMALL_FAST_MODEL: input.model,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    // Source text and questions are not the operator's input: never read `@path` mentions from the host.
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
    // One retry, as the native engine; every retry is another admitted call against the request budget.
    CLAUDE_CODE_MAX_RETRIES: '1',
    ...(maxOutputTokens === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }),
  };
  let session: ReturnType<typeof query> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined, exited: Promise<void> | undefined;
  let result: SDKResultMessage | undefined;
  try {
    if (input.account !== undefined) {
      // Native Claude Code owns sign-in. No ECHO credential resolver reads its profile.
      Object.assign(env, await claudeAccountEnvironmentV1(input.account, input.signal));
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDE_CONFIG_DIR;
    }
    session = sdkQuery({ prompt: input.prompt, options: {
      cwd, env, model: input.model, systemPrompt: input.system, abortController,
      ...(input.account === undefined ? {} : { pathToClaudeCodeExecutable: input.account.executable_path }),
      tools: [], allowedTools: [...input.tools, 'StructuredOutput'], mcpServers: input.servers,
      strictMcpConfig: true, settingSources: [], plugins: [], persistSession: false, permissionMode: 'dontAsk', verbatimPrompts: true,
      outputFormat: { type: 'json_schema', schema },
      // Explicit spawn environment prevents the SDK's parent environment merge from leaking host credentials/config.
      spawnClaudeCodeProcess: options => {
        child = spawn(options.command, options.args, { cwd, env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        // Drain stderr without retaining source content or SDK diagnostics in service logs.
        child.stderr.resume();
        // Abort emits an error before a child has necessarily exited. Keep the
        // cleanup timer until close, including a failed spawn's close event.
        exited = new Promise(resolve => { child!.once('close', () => resolve()); child!.once('error', () => undefined); });
        return child;
      },
    } });
    try {
      for await (const message of session) if (message.type === 'result') result = message;
    } catch {
      input.signal.throwIfAborted();
      // A started session failed: an error result, or the child exited. Never retain its text.
      throw new ClaudeResearchResultErrorV1();
    }
    input.signal.throwIfAborted();
    if (result?.subtype !== 'success' || result.is_error) throw new ClaudeResearchResultErrorV1();
    return result;
  } finally {
    input.signal.removeEventListener('abort', cancel);
    session?.close();
    if (child !== undefined && exited !== undefined) {
      // SDK close gives the child a grace period. Bound cleanup separately from the research budget.
      const kill = setTimeout(() => child?.kill('SIGKILL'), 5_000);
      try { await exited; } finally { clearTimeout(kill); }
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
