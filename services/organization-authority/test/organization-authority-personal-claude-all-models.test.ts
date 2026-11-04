import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AnswerCompositionGenerationBindingV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import type { AgenticResearchDriverSessionV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { createClaudeAccountDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/claude-account-decision-processor-bundle-v1';
import { createClaudeAccountAnswerCompositionGenerationBundleV1 } from '@echo-brain/provider-openrouter/claude-account-answer-composition-generation-bundle-v1';
import { createOpenRouterDecisionProcessorBundleV1 } from '@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1';
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from '@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1';
import { openOrganizationAuthorityService, type OrganizationAuthorityServiceConfig } from '../src/composition/organization-authority-composition-root.js';
import { openOrganizationAuthorityRuntime } from '../src/composition/organization-authority-runtime.js';
import { startOrganizationAuthorityServiceLifecycle } from '../src/composition/organization-authority-service-lifecycle.js';
import { openPersonMeetingRuntimeV1 } from '../src/composition/person-meeting-runtime-v1.js';
import { createPersonUpdateProcessingV1 } from '../src/composition/person-update-processing-v1.js';
import { bootstrapOrganizationAuthorityState } from '../src/composition/organization-authority-state-bootstrap.js';
import { initializePersonSessionCredentials } from '../src/composition/person-onboarding-service.js';
import type { ClaudeAccountProfileV1 } from '@echo-brain/provider-openrouter/claude-account-answer-composition-generation-bundle-v1';

vi.mock('@echo-brain/provider-openrouter/claude-account-decision-processor-bundle-v1', () => ({ createClaudeAccountDecisionProcessorBundleV1: vi.fn() }));
vi.mock('@echo-brain/provider-openrouter/claude-account-answer-composition-generation-bundle-v1', async importOriginal => ({
  ...await importOriginal<typeof import('@echo-brain/provider-openrouter/claude-account-answer-composition-generation-bundle-v1')>(),
  createClaudeAccountAnswerCompositionGenerationBundleV1: vi.fn(),
}));
vi.mock('@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1', () => ({ createOpenRouterDecisionProcessorBundleV1: vi.fn() }));
vi.mock('@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1', async importOriginal => ({
  ...await importOriginal<typeof import('@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1')>(),
  createOpenRouterAnswerCompositionGenerationBundleV1: vi.fn(),
}));
vi.mock('../src/composition/organization-authority-runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composition/organization-authority-runtime.js')>();
  return { ...actual, openOrganizationAuthorityRuntime: vi.fn(actual.openOrganizationAuthorityRuntime) };
});
vi.mock('../src/composition/person-meeting-runtime-v1.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composition/person-meeting-runtime-v1.js')>();
  return { ...actual, openPersonMeetingRuntimeV1: vi.fn(actual.openPersonMeetingRuntimeV1) };
});
vi.mock('../src/composition/person-update-processing-v1.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composition/person-update-processing-v1.js')>();
  return { ...actual, createPersonUpdateProcessingV1: vi.fn(actual.createPersonUpdateProcessingV1) };
});
// Real state/runtime composition runs; no HTTP server, worker, or provider call starts.
vi.mock('../src/composition/organization-authority-service-lifecycle.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/composition/organization-authority-service-lifecycle.js')>(),
  startOrganizationAuthorityServiceLifecycle: vi.fn(),
}));

const payer: ClaudeAccountProfileV1 = {
  home_directory: '/synthetic/claude-account', executable_path: '/synthetic/claude',
};
const roots: string[] = [];
function processor(): DecisionProcessorBundleV1 {
  return { processor_adapter_id: 'llm',
    current_commitments: () => { throw new Error('No source is admitted in this composition fixture'); },
    assert_admission_commitments: () => { throw new Error('No source is admitted in this composition fixture'); },
    create_processor: () => { throw new Error('No extraction may run in this composition fixture'); },
  };
}
const nativeProcessor = processor(), sharedProcessor = processor();
const nativeWriter = vi.fn(async (_input: StructuredGenerationInput) => ({ answer: 'synthetic native result' }));
const nativeResearch = vi.fn(async (_session: AgenticResearchDriverSessionV1) => {});
const native: AnswerCompositionGenerationBindingV1 = {
  generation: { generation_adapter_id: 'claude-account-research-writer-v1', planner_model: 'claude-sonnet-5-5', answer_model: 'claude-sonnet-5-5', timeout_ms: 60_000 },
  structured_output: {
    generate: async () => { throw new Error('Native writing requires per-request admission'); },
    generate_with_admission: nativeWriter,
  },
  research_driver: { run: nativeResearch },
};
const shared: AnswerCompositionGenerationBindingV1 = {
  generation: { generation_adapter_id: 'openrouter', planner_model: 'anthropic/claude-sonnet-5.5', answer_model: 'anthropic/claude-sonnet-5.5', timeout_ms: 60_000 },
  structured_output: { generate: async () => { throw new Error('Shared model must not run in this composition fixture'); } },
};
beforeEach(() => {
  vi.clearAllMocks();
  nativeWriter.mockResolvedValue({ answer: 'synthetic native result' });
  nativeResearch.mockResolvedValue(undefined);
  vi.mocked(createClaudeAccountDecisionProcessorBundleV1).mockReturnValue(nativeProcessor);
  vi.mocked(createOpenRouterDecisionProcessorBundleV1).mockReturnValue(sharedProcessor);
  vi.mocked(createClaudeAccountAnswerCompositionGenerationBundleV1).mockReturnValue({ load: () => native });
  vi.mocked(createOpenRouterAnswerCompositionGenerationBundleV1).mockReturnValue({ load: () => shared });
  vi.mocked(startOrganizationAuthorityServiceLifecycle).mockResolvedValue({
    address: { address: '127.0.0.1', family: 'IPv4', port: 0 },
    runUngated: async operation => operation(new AbortController().signal),
    drain: async () => {}, requestApprovalPublication() {}, close: async () => {},
  });
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function config(): OrganizationAuthorityServiceConfig {
  return {
    state_directory: '/unused', host: '127.0.0.1', port: 0, authority_url: STAGING_AUTHORITY_ORIGIN_V1,
    oidc: { issuer: 'https://issuer.invalid', client_id: 'synthetic-client', redirect_uri: `${STAGING_AUTHORITY_ORIGIN_V1}/v2/session/oidc/callback`, tenant: { kind: 'issuer' }, id_token_algorithms: ['RS256'] },
    client_authentication: { method: 'none' }, pkce_key_file: '/unused',
    openrouter_credential_file: '/unused/openrouter', nango: { secret_key: 'synthetic-nango-not-used-000000', integration_key: 'slack' },
    staging_claude_account: payer,
  };
}
function freshConfig(): OrganizationAuthorityServiceConfig {
  const created = mkdtempSync(join(tmpdir(), 'echo-all-models-composition-')); chmodSync(created, 0o700);
  const root = realpathSync(created); roots.push(root);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(root, 'state'), organization_display_name: 'Synthetic organization', owner_display_name: 'Synthetic owner',
    created_at: new Date(Date.now() - 1_000).toISOString(), creating_artifact_revision: 'all-models-composition-test',
  });
  const credentials = initializePersonSessionCredentials({ state_directory: initialized.state_directory });
  return { ...config(), state_directory: initialized.state_directory, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length) };
}
function expectNoRuntimeOrProviders(): void {
  for (const factory of [openOrganizationAuthorityRuntime, startOrganizationAuthorityServiceLifecycle,
    createClaudeAccountDecisionProcessorBundleV1, createClaudeAccountAnswerCompositionGenerationBundleV1,
    createOpenRouterDecisionProcessorBundleV1, createOpenRouterAnswerCompositionGenerationBundleV1]) expect(factory).not.toHaveBeenCalled();
}

it('selects native extraction and default generation for interactive and background work without a payer-member override', async () => {
  const runtime = await openOrganizationAuthorityService(freshConfig());
  try {
    expect(createClaudeAccountDecisionProcessorBundleV1).toHaveBeenCalledExactlyOnceWith({ account: payer, limit: expect.any(Function) });
    expect(createClaudeAccountAnswerCompositionGenerationBundleV1).toHaveBeenCalledExactlyOnceWith({ account: payer });
    expect(createOpenRouterDecisionProcessorBundleV1).not.toHaveBeenCalled();
    expect(createOpenRouterAnswerCompositionGenerationBundleV1).not.toHaveBeenCalled();
    const meeting = vi.mocked(openPersonMeetingRuntimeV1).mock.lastCall![0];
    expect(meeting.processor).toBe(nativeProcessor);
    const api = vi.mocked(startOrganizationAuthorityServiceLifecycle).mock.lastCall![1].api;
    const updates = vi.mocked(createPersonUpdateProcessingV1).mock.lastCall![0];
    for (const binding of [api.answer_composition_generation, updates]) {
      expect(binding.generation).toBe(native.generation);
      expect(binding).not.toHaveProperty('payer_membership_id');
    }
    const input: StructuredGenerationInput = { model: native.generation.answer_model, system_prompt: 'Synthetic instructions', user_prompt: 'Other member evidence', schema: {}, max_output_tokens: 1, timeout_ms: 1_000 };
    for (const port of [api.answer_composition_generation.structured_output, api.answer_composition_background!, updates.structured_output]) {
      await expect(port.generate_with_admission!(input, vi.fn())).resolves.toEqual({ answer: 'synthetic native result' });
    }
    expect(nativeWriter).toHaveBeenCalledTimes(3);
    const initial = { authenticated_membership: 'mem_another_person', question: 'Synthetic question' };
    const session: AgenticResearchDriverSessionV1 = { initial, question: true, list_available: false,
      signal: new AbortController().signal, remaining: () => 1_000, call: async () => ({}), model_request: vi.fn() };
    await api.answer_composition_generation.research_driver!.run(session);
    await api.research_background_driver!.run(session);
    expect(nativeResearch).toHaveBeenCalledTimes(2);
    for (const [received] of nativeResearch.mock.calls) expect(received.initial).toBe(initial);
  } finally { await runtime.close(); }
});

it('uses OpenRouter when no native account is selected', async () => {
  const { staging_claude_account: _account, ...sharedConfig } = freshConfig();
  const runtime = await openOrganizationAuthorityService(sharedConfig);
  try {
    expect(createClaudeAccountDecisionProcessorBundleV1).not.toHaveBeenCalled();
    expect(createClaudeAccountAnswerCompositionGenerationBundleV1).not.toHaveBeenCalled();
    expect(createOpenRouterDecisionProcessorBundleV1).toHaveBeenCalledExactlyOnceWith({ credential_file: '/unused/openrouter', limit: expect.any(Function) });
    expect(createOpenRouterAnswerCompositionGenerationBundleV1).toHaveBeenCalledExactlyOnceWith({ credential_file: '/unused/openrouter' });
    const meeting = vi.mocked(openPersonMeetingRuntimeV1).mock.lastCall![0];
    expect(meeting.processor).toBe(sharedProcessor);
    const api = vi.mocked(startOrganizationAuthorityServiceLifecycle).mock.lastCall![1].api;
    expect(api.answer_composition_generation.generation).toBe(shared.generation);
  } finally { await runtime.close(); }
});

it('shares the SDK session cap between default writers and research, reserving capacity for interactive work', async () => {
  const runtime = await openOrganizationAuthorityService(freshConfig());
  const started: string[] = [], releases = new Map<string, () => void>();
  let releaseAll!: () => void;
  const cleanup = new Promise<void>(resolve => { releaseAll = resolve; });
  const hold = (label: string) => {
    started.push(label);
    return Promise.race([cleanup, new Promise<void>(resolve => { releases.set(label, resolve); })]);
  };
  nativeWriter.mockImplementation(async input => { await hold(input.user_prompt); return { answer: 'synthetic native result' }; });
  nativeResearch.mockImplementation(async () => { await hold('interactive-research'); });
  const pending: Promise<unknown>[] = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    const api = vi.mocked(startOrganizationAuthorityServiceLifecycle).mock.lastCall![1].api;
    const input: StructuredGenerationInput = { model: native.generation.answer_model, system_prompt: 'Synthetic instructions', user_prompt: '', schema: {}, max_output_tokens: 1, timeout_ms: 1_000 };
    for (const user_prompt of ['background-1', 'background-2', 'background-3']) {
      pending.push(api.answer_composition_background!.generate_with_admission!({ ...input, user_prompt }, vi.fn()));
    }
    pending.push(api.answer_composition_generation.structured_output.generate_with_admission!({ ...input, user_prompt: 'interactive-writer' }, vi.fn()));
    pending.push(api.answer_composition_generation.research_driver!.run({ initial: {}, question: true, list_available: false,
      signal: new AbortController().signal, remaining: () => 1_000, call: async () => ({}), model_request: vi.fn() }));
    await flush();
    expect(started).toEqual(['background-1', 'background-2', 'interactive-writer']);
    releases.get('background-1')!(); await flush();
    expect(started).toEqual(['background-1', 'background-2', 'interactive-writer', 'interactive-research']);
    releases.get('interactive-writer')!(); await flush();
    expect(started).toEqual(['background-1', 'background-2', 'interactive-writer', 'interactive-research', 'background-3']);
  } finally { releaseAll(); await Promise.allSettled(pending); await runtime.close(); }
});

it('rejects native account selection outside staging before runtime startup', async () => {
  await expect(openOrganizationAuthorityService({ ...config(), authority_url: 'https://authority.example' }))
    .rejects.toThrow('only on the staging Authority');
  expectNoRuntimeOrProviders();
});

it.each([
  { ...payer, home_directory: 'relative-home' },
  { ...payer, executable_path: 'relative-executable' },
])('rejects malformed native account configuration before selecting providers', async selection => {
  await expect(openOrganizationAuthorityService({ ...config(), staging_claude_account: selection })).rejects.toThrow();
  expectNoRuntimeOrProviders();
});
