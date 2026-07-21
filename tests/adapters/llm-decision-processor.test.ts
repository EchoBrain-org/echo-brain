import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  assertCanonicalDecisionSet,
  meetingProcessingKey,
  type AdapterConfig,
  type MeetingDocument,
} from '../../src/core/index.js';
import {
  LlmDecisionProcessor,
  OllamaClient,
  llmProcessingVersion,
  type LlmProviderClient,
  type StructuredGenerationRequest,
} from '../../src/adapters/decision-processors/llm/index.js';
import { adapterConformance } from '../core/adapter-conformance.js';

const processorConfig: AdapterConfig = {
  adapter_id: 'llm',
  instance_id: 'local',
  settings: { model: 'qwen3:4b' },
};

const meeting: MeetingDocument = {
  schema_version: 1,
  id: 'meeting-llm-1',
  title: 'Vendor selection sync',
  capture: {
    state: 'complete',
    components: [
      { kind: 'summary', state: 'available' },
      { kind: 'transcript', state: 'available' },
    ],
  },
  participants: [],
  content: [
    {
      id: 'summary-1',
      kind: 'summary',
      text: [
        '### Vendor selection',
        '- The team agreed to use vendor X for hosting',
        '- Zhen will send the contract by Friday',
      ].join('\n'),
    },
    {
      id: 'transcript-1',
      kind: 'transcript',
      text: 'Let us just go with vendor X, they were cheaper and faster.',
    },
  ],
  artifacts: [],
  provenance: {
    source: {
      kind: 'meeting-source',
      adapter_id: 'fixture-source',
      instance_id: 'local',
      version: '1.0.0',
    },
    external_id: 'fixture-llm-1',
    canonical_revision: 'sha256:llm-fixture-revision',
    observed_at: '2026-07-17T17:01:00.000Z',
    normalizer_version: '1.0.0',
    source_updated_at: '2026-07-17T17:00:00.000Z',
  },
};

class FakeLlmClient implements LlmProviderClient {
  readonly provider = 'ollama' as const;
  readonly requests: StructuredGenerationRequest[] = [];
  constructor(
    private readonly content: string,
    private readonly models: readonly string[] = ['qwen3:4b'],
    private readonly failure?: Error,
  ) {}

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<{ content: string }> {
    if (this.failure !== undefined) throw this.failure;
    this.requests.push(request);
    return { content: this.content };
  }

  async verifyModel(model: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (!this.models.includes(model)) {
      throw new AdapterError(
        'permanently_rejected',
        `Model '${model}' is not installed in Ollama`,
        false,
      );
    }
  }
}

function processor(
  client: LlmProviderClient,
  config: AdapterConfig = processorConfig,
): LlmDecisionProcessor {
  return new LlmDecisionProcessor(config, {
    client,
    now: () => '2026-07-17T18:00:00.000Z',
  });
}

function extractionContext(instance: LlmDecisionProcessor) {
  return {
    processor_version: instance.identity.version,
    input_fingerprint: meeting.provenance.canonical_revision,
  };
}

const validModelOutput = JSON.stringify({
  signals: [
    {
      kind: 'decision',
      text: 'Use vendor X for hosting',
      status: 'decided',
      confidence: 0.9,
      evidence_quote: 'The team agreed to use vendor X for hosting',
    },
    {
      kind: 'action',
      text: 'Send the contract',
      owner: 'Zhen',
      due_at: '2026-07-24T00:00:00.000Z',
      confidence: 0.8,
      evidence_quote: 'Zhen will send the contract by Friday',
    },
    {
      kind: 'rationale',
      text: 'Vendor X was cheaper and faster',
      confidence: 0.7,
      evidence_quote: 'they were cheaper and faster',
      supports_decision_indexes: [0],
    },
  ],
});

adapterConformance({
  name: 'llm decision processor',
  kind: 'decision-processor',
  create: () => processor(new FakeLlmClient(validModelOutput)),
  validConfig: processorConfig,
  invalidConfig: {
    adapter_id: 'llm',
    instance_id: 'local',
    credential_ref: 'env:SECRET_TOKEN',
    settings: { model: 'qwen3:4b', unsupported: true },
  },
});

describe('llm decision processor extraction', () => {
  it('maps model signals into a decision set with stable ids and verified evidence', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    const first = await instance.extract(meeting, extractionContext(instance));
    const second = await instance.extract(meeting, extractionContext(instance));

    expect(first).toMatchObject({
      schema_version: 1,
      meeting_id: 'meeting-llm-1',
      meeting_revision: 'sha256:llm-fixture-revision',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'llm',
        instance_id: 'local',
      },
      generated_at: '2026-07-17T18:00:00.000Z',
    });
    expect(first.signals).toHaveLength(3);

    const [decision, action, rationale] = first.signals;
    expect(decision).toMatchObject({
      kind: 'decision',
      status: 'decided',
      text: 'Use vendor X for hosting',
      confidence: 0.9,
      evidence: [
        {
          meeting_id: 'meeting-llm-1',
          block_id: 'summary-1',
          quote: 'The team agreed to use vendor X for hosting',
        },
      ],
    });
    expect(decision!.id).toMatch(/^decision:sha256:[a-f0-9]{64}$/);
    expect(action).toMatchObject({
      kind: 'action',
      owner: 'Zhen',
      due_at: '2026-07-24T00:00:00.000Z',
      evidence: [{ block_id: 'summary-1' }],
    });
    expect(rationale).toMatchObject({
      kind: 'rationale',
      evidence: [{ block_id: 'transcript-1' }],
      supports_signal_ids: [decision!.id],
    });

    // Determinism: identical input produces identical signal ids.
    expect(second.signals.map((signal) => signal.id)).toEqual(
      first.signals.map((signal) => signal.id),
    );

    // The model was asked for structured output over the meeting content.
    expect(client.requests[0]!.model).toBe('qwen3:4b');
    expect(client.requests[0]!.schema).toMatchObject({ type: 'object' });
    expect(client.requests[0]!.schema).toMatchObject({
      additionalProperties: false,
      properties: {
        signals: {
          items: {
            additionalProperties: false,
            required: expect.arrayContaining([
              'kind',
              'text',
              'status',
              'owner',
              'due_at',
              'confidence',
              'evidence_quote',
              'supports_decision_indexes',
            ]),
          },
        },
      },
    });
    const rendered = [
      client.requests[0]!.systemPrompt,
      client.requests[0]!.userPrompt,
    ].join('\n');
    expect(rendered).toContain('The team agreed to use vendor X for hosting');
    expect(rendered).toContain('Let us just go with vendor X');
  });

  it('drops signals whose evidence quote is not verbatim in the meeting', async () => {
    const hallucinated = JSON.stringify({
      signals: [
        {
          kind: 'decision',
          text: 'Adopt vendor Y',
          status: 'decided',
          confidence: 0.9,
          evidence_quote: 'We are definitely adopting vendor Y next quarter',
        },
      ],
    });
    const instance = processor(new FakeLlmClient(hallucinated));
    const result = await instance.extract(meeting, extractionContext(instance));
    expect(result.signals).toEqual([]);
  });

  it('normalizes parseable due dates and clears invalid ones', async () => {
    const dueDates = JSON.stringify({
      signals: [
        {
          kind: 'action',
          text: 'Send the contract',
          due_at: '2026-07-24',
          evidence_quote: 'Zhen will send the contract by Friday',
        },
        {
          kind: 'action',
          text: 'Confirm the hosting choice',
          due_at: 'not-a-date',
          evidence_quote: 'The team agreed to use vendor X for hosting',
        },
      ],
    });
    const instance = processor(new FakeLlmClient(dueDates));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals).toMatchObject([
      { kind: 'action', due_at: '2026-07-24T00:00:00.000Z' },
      { kind: 'action', due_at: null },
    ]);
    expect(() =>
      assertCanonicalDecisionSet(result, meeting, instance.identity),
    ).not.toThrow();
  });

  it('rejects malformed model output with a retryable taxonomy error', async () => {
    const instance = processor(new FakeLlmClient('not json at all'));
    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('fails closed on cancellation', async () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    const controller = new AbortController();
    controller.abort();
    await expect(
      instance.extract(meeting, extractionContext(instance), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('llm decision processor configuration', () => {
  it('requires a model and rejects unsupported settings and credentials', () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        settings: {},
      }).ok,
    ).toBe(false);
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        settings: { model: 'qwen3:4b', temperature: 1 },
      }).ok,
    ).toBe(false);
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        credential_ref: 'env:NOT_NEEDED',
        settings: { model: 'qwen3:4b' },
      }).ok,
    ).toBe(false);
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        settings: {
          model: 'qwen3:4b',
          base_url: 'http://127.0.0.1:11434',
          request_timeout_ms: 60_000,
        },
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it('requires credentials only for hosted providers and fixes their endpoints', () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    for (const provider of ['openai', 'anthropic'] as const) {
      expect(
        instance.validateConfig({
          adapter_id: 'llm',
          instance_id: 'local',
          credential_ref: `env:${provider.toUpperCase()}_API_KEY`,
          settings: { provider, model: `${provider}-model` },
        }),
      ).toEqual({ ok: true, errors: [] });
    }
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        credential_ref: 'env:OPENROUTER_API_KEY',
        settings: {
          provider: 'openrouter',
          model: 'anthropic/claude-model',
        },
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        settings: { provider: 'openai', model: 'gpt-model' },
      }).errors,
    ).toContain('credential_ref is required by the openai provider');
    expect(
      instance.validateConfig({
        adapter_id: 'llm',
        instance_id: 'local',
        credential_ref: 'env:OPENAI_API_KEY',
        settings: {
          provider: 'openai',
          model: 'gpt-model',
          base_url: 'https://attacker.invalid',
        },
      }).errors,
    ).toContain('settings.base_url is supported only by the Ollama provider');
  });

  it('changes processing identity for provider, model, or schema-affecting settings', () => {
    const ollama = processorConfig;
    const explicitOllama: AdapterConfig = {
      ...processorConfig,
      settings: { provider: 'ollama', model: 'qwen3:4b' },
    };
    const differentTimeout: AdapterConfig = {
      ...processorConfig,
      settings: {
        model: 'qwen3:4b',
        request_timeout_ms: 60_000,
      },
    };
    const differentModel: AdapterConfig = {
      ...processorConfig,
      settings: { model: 'qwen3:8b' },
    };
    const openai: AdapterConfig = {
      ...processorConfig,
      credential_ref: 'env:OPENAI_API_KEY',
      settings: { provider: 'openai', model: 'qwen3:4b' },
    };
    const moreOutput: AdapterConfig = {
      ...processorConfig,
      settings: { model: 'qwen3:4b', max_output_tokens: 8192 },
    };

    expect(llmProcessingVersion(explicitOllama)).toBe(
      llmProcessingVersion(ollama),
    );
    expect(llmProcessingVersion(differentTimeout)).toBe(
      llmProcessingVersion(ollama),
    );
    expect(llmProcessingVersion(differentModel)).not.toBe(
      llmProcessingVersion(ollama),
    );
    expect(llmProcessingVersion(openai)).not.toBe(llmProcessingVersion(ollama));
    expect(llmProcessingVersion(moreOutput)).not.toBe(
      llmProcessingVersion(ollama),
    );
    const localProcessor = processor(
      new FakeLlmClient(validModelOutput),
      ollama,
    );
    const hostedProcessor = processor(
      new FakeLlmClient(validModelOutput),
      openai,
    );
    expect(hostedProcessor.identity.version).not.toBe(
      localProcessor.identity.version,
    );
    expect(meetingProcessingKey(meeting, hostedProcessor)).not.toBe(
      meetingProcessingKey(meeting, localProcessor),
    );
  });

  it('reports unavailable health when the configured model is not installed', async () => {
    const instance = processor(
      new FakeLlmClient(validModelOutput, ['some-other-model']),
    );
    const health = await instance.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.message).toContain('qwen3:4b');
  });

  it('reports unavailable health when the provider cannot be reached', async () => {
    const instance = processor(
      new FakeLlmClient(
        validModelOutput,
        ['qwen3:4b'],
        new AdapterError('temporarily_unavailable', 'connection refused', true),
      ),
    );
    const health = await instance.healthCheck();
    expect(health.status).toBe('unavailable');
  });

  it('reports unauthorized before transport when a hosted credential cannot resolve', async () => {
    const instance = new LlmDecisionProcessor({
      adapter_id: 'llm',
      instance_id: 'hosted',
      credential_ref: 'env:OPENAI_API_KEY',
      settings: { provider: 'openai', model: 'gpt-model' },
    });
    await expect(instance.healthCheck()).resolves.toMatchObject({
      status: 'unauthorized',
      details: { provider: 'openai', model: 'gpt-model' },
    });
  });
});

describe('ollama provider client', () => {
  it('posts a non-streaming chat request and returns the message content', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: '{"signals":[]}' },
          }),
          { status: 200 },
        );
      },
    });
    const response = await client.generateStructured({
      model: 'qwen3:4b',
      systemPrompt: 'extract decisions',
      userPrompt: 'hello',
      schema: { type: 'object' },
      maxOutputTokens: 4096,
    });
    expect(response.content).toBe('{"signals":[]}');
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      format: { type: 'object' },
      // Deterministic decoding and a context window large enough for a full
      // meeting transcript; Ollama's default num_ctx silently truncates.
      options: { temperature: 0, num_ctx: 32_768, num_predict: 4096 },
    });
  });

  it('maps provider failures onto the adapter error taxonomy', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async () => new Response('overloaded', { status: 500 }),
    });
    await expect(
      client.generateStructured({
        model: 'qwen3:4b',
        systemPrompt: 'extract decisions',
        userPrompt: 'hello',
        schema: { type: 'object' },
        maxOutputTokens: 4096,
      }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('verifies installed model names from the tags endpoint', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url) => {
        expect(String(url)).toBe('http://127.0.0.1:11434/api/tags');
        return new Response(
          JSON.stringify({
            models: [{ name: 'qwen3:4b' }, { name: 'gemma2:2b' }],
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.verifyModel('qwen3:4b')).resolves.toBeUndefined();
    await expect(client.verifyModel('missing:latest')).rejects.toMatchObject({
      code: 'permanently_rejected',
    });
  });
});
