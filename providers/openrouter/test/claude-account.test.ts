import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAccountEnvironmentV1 } from '../src/claude-research/account-profile.js';
import { runClaudeResearchV1, runClaudeStructuredV1 } from '../src/claude-research/sdk-client.js';
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from '../src/openrouter-answer-composition-generation-bundle-v1.js';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function profile(authMethod = 'claude.ai', loggedIn = true) {
  const home_directory = await mkdtemp(join(tmpdir(), 'echo-claude-account-')); directories.push(home_directory);
  await mkdir(join(home_directory, '.claude'), { mode: 0o700 });
  const executable_path = join(home_directory, 'claude');
  await writeFile(executable_path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ loggedIn, authMethod }))});\n`, { mode: 0o700 });
  return { home_directory, executable_path };
}

it('preserves the native sign-in directory but strips service credentials and host configuration', async () => {
  const account = await profile();
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-host-key'); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'synthetic-host-token');
  let options: Options | undefined;
  const fake = ((input: Parameters<typeof query>[0]) => {
    options = input.options;
    return Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false }; })(), { close() {} });
  }) as unknown as typeof query;
  await runClaudeResearchV1({ prompt: 'synthetic', system: 'synthetic', model: 'claude-sonnet-5-5', base_url: 'http://127.0.0.1:1/test',
    account, signal: new AbortController().signal, servers: {}, tools: [] }, fake);
  expect(options!.env).toMatchObject({ HOME: account.home_directory, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/test' });
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) expect(options!.env).not.toHaveProperty(name);
  expect(options).toMatchObject({ pathToClaudeCodeExecutable: account.executable_path, tools: [], settingSources: [], plugins: [], persistSession: false });
  expect((await stat(account.home_directory)).isDirectory()).toBe(true);
  await expect(stat(options!.cwd!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([['api_key', true], ['claude.ai', false]])('rejects %s loggedIn=%s without exposing native diagnostics', async (method, loggedIn) => {
  await expect(claudeAccountEnvironmentV1(await profile(String(method), Boolean(loggedIn)), new AbortController().signal)).rejects.toThrow('Personal Claude sign-in is unavailable');
});

it('writes through the same native account with the answer schema and no research or host tools', async () => {
  const account = await profile();
  let options: Options | undefined;
  const fake = ((request: Parameters<typeof query>[0]) => {
    options = request.options;
    return Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, structured_output: { answer: 'synthetic' } }; })(), { close() {} });
  }) as unknown as typeof query;
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  await expect(runClaudeStructuredV1({ account, schema, model: 'claude-sonnet-5-5', prompt: 'Synthetic evidence', system: 'Write from evidence',
    base_url: 'http://127.0.0.1:1/test', max_output_tokens: 1500, signal: new AbortController().signal }, fake)).resolves.toEqual({ answer: 'synthetic' });
  expect(options).toMatchObject({ pathToClaudeCodeExecutable: account.executable_path, systemPrompt: 'Write from evidence',
    tools: [], allowedTools: ['StructuredOutput'], mcpServers: {}, settingSources: [], persistSession: false, outputFormat: { type: 'json_schema', schema } });
  expect(options!.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  expect(options!.env).toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '1500');
  expect(options!.maxTurns).toBeUndefined();
});

it('rejects a writable sign-in directory before launching native authentication', async () => {
  const account = await profile(); await chmod(join(account.home_directory, '.claude'), 0o777);
  await expect(claudeAccountEnvironmentV1(account, new AbortController().signal)).rejects.toThrow('Personal Claude sign-in is unavailable');
});

it('selects a personal researcher and writer while retaining the shared OpenRouter route', async () => {
  const binding = createOpenRouterAnswerCompositionGenerationBundleV1({ credential_file: '/missing',
    personal_claude_research: { ...await profile(), membership_id: 'mem_owner' } }).load();
  expect(binding.research_driver).toBeUndefined();
  expect(binding.personal_research).toMatchObject({ membership_id: 'mem_owner', driver: { run: expect.any(Function) },
    structured_output: { generate_with_admission: expect.any(Function) },
    generation: { generation_adapter_id: 'claude-account-research-writer-v1', answer_model: 'claude-sonnet-5-5' } });
  expect(binding.generation.generation_adapter_id).toBe('openrouter');
  expect(binding.structured_output.generate).toBeTypeOf('function');
});
