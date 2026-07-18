import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  type AdapterConfig,
  type MeetingDocument,
} from '../../src/core/index.js';
import {
  LlmDecisionProcessor,
  OllamaClient,
  type LlmChatRequest,
  type LlmClient,
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

class FakeLlmClient implements LlmClient {
  readonly requests: LlmChatRequest[] = [];
  constructor(
    private readonly content: string,
    private readonly models: readonly string[] = ['qwen3:4b'],
    private readonly failure?: Error,
  ) {}

  async chat(request: LlmChatRequest): Promise<{ content: string }> {
    if (this.failure !== undefined) throw this.failure;
    this.requests.push(request);
    return { content: this.content };
  }

  async listModels(): Promise<readonly string[]> {
    if (this.failure !== undefined) throw this.failure;
    return this.models;
  }
}

function processor(
  client: LlmClient,
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
    expect(client.requests[0]!.format).toMatchObject({ type: 'object' });
    const rendered = client.requests[0]!.messages.map((m) => m.content).join('\n');
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
});

describe('ollama client', () => {
  it('posts a non-streaming chat request and returns the message content', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: '{"signals":[]}' } }),
          { status: 200 },
        );
      },
    });
    const response = await client.chat({
      model: 'qwen3:4b',
      messages: [{ role: 'user', content: 'hello' }],
      format: { type: 'object' },
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
      options: { temperature: 0, num_ctx: 32_768 },
    });
  });

  it('maps provider failures onto the adapter error taxonomy', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async () => new Response('overloaded', { status: 500 }),
    });
    await expect(
      client.chat({
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'hello' }],
        format: { type: 'object' },
      }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('lists installed model names from the tags endpoint', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: async (url) => {
        expect(String(url)).toBe('http://127.0.0.1:11434/api/tags');
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen3:4b' }, { name: 'gemma2:2b' }] }),
          { status: 200 },
        );
      },
    });
    expect(await client.listModels()).toEqual(['qwen3:4b', 'gemma2:2b']);
  });
});
