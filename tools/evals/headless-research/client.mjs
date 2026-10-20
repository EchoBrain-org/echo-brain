import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Use the existing CLI's authentication internally. Never read or copy its credentials. */
export async function runClaude({ prompt, system, schema, servers = {}, tools = [], signal, timeoutMs = 65_000, unbounded = false, hooks = {}, onEvent = () => {}, modelFence }) {
  const cwd = await mkdtemp(join(tmpdir(), 'echo-synthetic-research-'));
  const abort = new AbortController();
  const propagate = () => abort.abort(signal.reason);
  if (signal?.aborted) propagate(); else signal?.addEventListener('abort', propagate, { once: true });
  const timer = unbounded ? undefined : setTimeout(() => abort.abort(new Error('research_deadline')), timeoutMs);
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'TMPDIR', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  let session; let result; const models = new Set(), messages = new Set();
  const started = performance.now();
  try {
    session = query({ prompt, options: {
      cwd, model: 'sonnet', systemPrompt: system, tools: [], allowedTools: [...tools, 'StructuredOutput'],
      mcpServers: servers, strictMcpConfig: true, settingSources: [], plugins: [], persistSession: false,
      permissionMode: 'dontAsk',
      abortController: abort, ...(unbounded ? {} : { maxTurns: 12, maxBudgetUsd: 2 }), outputFormat: { type: 'json_schema', schema }, hooks,
      env: { ...env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(modelFence?.environment() ?? {}) },
      pathToClaudeCodeExecutable: process.env.ECHO_TRIAL_CLAUDE_BINARY ?? execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(),
    } });
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init') {
        models.add(message.model);
        onEvent({ event: 'initialized', model: message.model, tools: message.tools });
      }
      if (message.type === 'assistant' && message.message) {
        messages.add(message.message.id); models.add(message.message.model);
        onEvent({ event: 'model_message', model: message.message.model, count: messages.size });
      }
      if (message.type === 'result') result = message;
    }
    if (!result || result.subtype !== 'success' || result.is_error || !result.structured_output) {
      const error = new Error(`Claude trial failed: ${result?.subtype ?? 'no_result'}`);
      error.diagnostic = result ? { subtype: result.subtype, errors: result.errors, result: result.result, permission_denials: result.permission_denials,
        models: [...models], model_calls: messages.size, turns: result.num_turns, usage: result.usage, elapsed_ms: performance.now() - started, estimated_cost_usd: result.total_cost_usd } : undefined;
      throw error;
    }
    const usage = result.usage ?? {};
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return { value: result.structured_output, metrics: { models: [...models], turns: result.num_turns, model_calls: messages.size, input_tokens: input, output_tokens: usage.output_tokens ?? 0,
      total_tokens: input + (usage.output_tokens ?? 0), model_ms: result.duration_api_ms, elapsed_ms: performance.now() - started, estimated_cost_usd: result.total_cost_usd, permission_denials: result.permission_denials ?? [] } };
  } catch (error) {
    error.diagnostic ??= { models: [...models], model_calls: messages.size, elapsed_ms: performance.now() - started, estimated_cost_usd: null,
      note: 'SDK threw before delivering a successful result; usage and estimated cost are unavailable.' };
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', propagate); session?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Same headless provider for each existing-loop decision and both writers. Startup overhead is recorded. */
export function generationPort(onCall = () => {}) {
  return { async generate(input) {
    const result = await runClaude({ prompt: input.user_prompt, system: input.system_prompt, schema: input.schema, signal: input.signal, timeoutMs: input.timeout_ms });
    onCall(result.metrics); return result.value;
  } };
}
