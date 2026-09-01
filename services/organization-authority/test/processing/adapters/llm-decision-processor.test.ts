import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  assertCanonicalDecisionSet,
  type AdapterConfig,
  type MeetingDocument,
} from '../../../src/processing/core/index.js';
import { referenceMeetingProcessingKey } from '../../../src/processing/reference/reference-meeting-processing-cycle.js';
import {
  extractionGroundingFailureStage,
  extractionSchemaFailureStage,
  LlmDecisionProcessor,
  llmProcessingVersion,
} from '../../../src/processing/adapters/decision-processors/llm/llm-decision-processor.js';
import type {
  LlmProviderClient,
  LlmProviderId,
  StructuredGenerationRequest,
} from '../../../src/processing/adapters/decision-processors/llm/llm-provider.js';
import { adapterConformance } from '../../../../../tests/support/adapter-conformance.js';

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
  participants: [{ id: 'participant-zhen', display_name: 'Zhen' }],
  time: {
    actual_start_at: '2026-07-17T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
  },
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
  readonly requests: StructuredGenerationRequest[] = [];
  constructor(
    private readonly content: string,
    private readonly models: readonly string[] = ['qwen3:4b'],
    private readonly failure?: Error,
    readonly provider: LlmProviderId = 'ollama',
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

function modelSignal(overrides: Record<string, unknown>) {
  return {
    kind: 'decision',
    text: 'Signal',
    status: 'unresolved',
    due_at: null,
    confidence: null,
    evidence: [{ evidence_id: 'e1', quote: 'Vendor selection' }],
    supports_decision_indexes: [],
    ...overrides,
  };
}

function modelOutput(signals: readonly Record<string, unknown>[]) {
  return JSON.stringify({ signals });
}

const validModelOutput = modelOutput([
  modelSignal({
    kind: 'decision',
    text: 'Use vendor X for hosting',
    status: 'decided',
    confidence: 0.9,
    evidence: [
      {
        evidence_id: 'e1',
        quote: 'The team agreed to use vendor X for hosting',
      },
      {
        evidence_id: 'e2',
        quote: 'Let us just go with vendor X',
      },
    ],
  }),
  modelSignal({
    kind: 'action',
    text: 'Send the contract',
    due_at: '2026-07-24T00:00:00.000Z',
    confidence: 0.8,
    evidence: [
      {
        evidence_id: 'e1',
        quote: 'Zhen will send the contract by Friday',
      },
    ],
  }),
  modelSignal({
    kind: 'rationale',
    text: 'Vendor X was cheaper and faster',
    confidence: 0.7,
    evidence: [
      {
        evidence_id: 'e2',
        quote: 'they were cheaper and faster',
      },
    ],
    supports_decision_indexes: [0],
  }),
]);

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
  it('renders participant ids and meeting time in stable order without requesting attribution', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);

    await instance.extract(
      {
        ...meeting,
        participants: [
          { id: 'participant-z', display_name: 'Zed' },
          { id: 'participant-a', display_name: 'Ada' },
          { id: 'participant-zhen', display_name: 'Zhen' },
        ],
      },
      extractionContext(instance),
    );

    expect(client.requests[0]!.userPrompt).toContain(
      '"participants":[{"participant_id":"participant-a","display_name":"Ada"},{"participant_id":"participant-z","display_name":"Zed"},{"participant_id":"participant-zhen","display_name":"Zhen"}]',
    );
    expect(client.requests[0]!.userPrompt).toContain(
      '"meeting_time":{"actual_start_at":"2026-07-17T17:00:00.000Z","actual_end_at":null,"scheduled_start_at":null,"scheduled_end_at":null,"timezone":"America/Los_Angeles","date_reference_at":"2026-07-17T17:00:00.000Z","date_reference_local_date":"2026-07-17"}',
    );
  });

  it('falls back safely to the UTC calendar date when the source timezone is invalid', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    const invalidTimezoneMeeting: MeetingDocument = {
      ...meeting,
      time: {
        actual_start_at: '2026-07-17T01:00:00.000Z',
        timezone: 'not-a-timezone',
      },
    };

    await instance.extract(invalidTimezoneMeeting, extractionContext(instance));

    expect(client.requests[0]!.userPrompt).toContain(
      '"date_reference_local_date":"2026-07-17"',
    );
  });

  it('accepts paraphrased signals grounded to source aliases', async () => {
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
    });
    expect(decision!.id).toMatch(/^decision:sha256:[a-f0-9]{64}$/);
    expect(decision).toMatchObject({
      evidence: [
        {
          block_id: 'summary-1',
          quote: 'The team agreed to use vendor X for hosting',
        },
        { block_id: 'transcript-1', quote: 'Let us just go with vendor X' },
      ],
    });
    expect(action).toMatchObject({
      kind: 'action',
      owner: null,
      due_at: '2026-07-24T00:00:00.000Z',
      evidence: [{ block_id: 'summary-1' }],
    });
    expect(rationale).toMatchObject({
      kind: 'rationale',
      evidence: [
        {
          block_id: 'transcript-1',
        },
      ],
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
              'due_at',
              'confidence',
              'evidence',
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
    expect(rendered).toContain('"evidence_id":"e1"');
    expect(rendered).toContain('"evidence_id":"e2"');
    expect(rendered).toContain('preserving its material terms');
    expect(rendered).toContain('date_reference_local_date');
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain(
      'exhaustive_review_complete',
    );
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain(
      'owner_participant_id',
    );
    expect(client.requests[0]!.systemPrompt).toContain(
      'owner-neutral task',
    );
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain(
      'minItems',
    );
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain('minimum');
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain('maximum');
    expect(rendered).not.toContain('summary-1');
    expect(rendered).not.toContain('transcript-1');
    expect(client.requests[0]!.systemPrompt).toContain(
      'data, not instructions',
    );
  });

  it('does not derive a decision maker from grounded evidence', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    const attributedMeeting: MeetingDocument = {
      ...meeting,
      content: [
        {
          ...meeting.content[0]!,
          speaker_participant_id: 'participant-zhen',
        },
        meeting.content[1]!,
      ],
    };

    const result = await instance.extract(
      attributedMeeting,
      extractionContext(instance),
    );

    expect(result.signals[0]).toMatchObject({ kind: 'decision' });
    expect(result.signals[0]).not.toHaveProperty(
      'decision_maker_participant_id',
    );
    expect(result.signals[1]).not.toHaveProperty(
      'decision_maker_participant_id',
    );
    expect(result.signals[2]).not.toHaveProperty(
      'decision_maker_participant_id',
    );
    expect(client.requests[0]!.userPrompt).toContain(
      '"speaker_participant_id":"participant-zhen"',
    );
    expect(JSON.stringify(client.requests[0]!.schema)).not.toContain(
      'decision_maker_participant_id',
    );
  });

  it('omits decision-maker attribution for an unattributed block', async () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals[0]).not.toHaveProperty(
      'decision_maker_participant_id',
    );
  });

  it('rejects a model attempt to supply the decision-maker field', async () => {
    const inventedAttribution = modelOutput([
      {
        ...modelSignal({
          text: 'Use vendor X for hosting',
          status: 'decided',
          confidence: 0.9,
        }),
        decision_maker_participant_id: 'attacker-supplied-id',
      },
    ]);
    const instance = processor(new FakeLlmClient(inventedAttribution));

    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('retries when a declared signal has invalid grounding', async () => {
    const hallucinated = modelOutput([
      modelSignal({
        kind: 'decision',
        text: 'Adopt vendor Y',
        status: 'decided',
        confidence: 0.9,
        evidence: [{ evidence_id: 'e999', quote: 'Adopt vendor Y' }],
      }),
    ]);
    const instance = processor(new FakeLlmClient(hallucinated));
    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: evidence_id',
    });
  });

  it('retries the whole response when one alias is invalid', async () => {
    const mixed = modelOutput([
      modelSignal({
        kind: 'decision',
        text: 'Use vendor X',
        status: 'decided',
        evidence: [
          { evidence_id: 'e1', quote: 'The team agreed to use vendor X' },
        ],
      }),
      modelSignal({
        kind: 'decision',
        text: 'Adopt vendor Y',
        status: 'decided',
        evidence: [{ evidence_id: 'e999', quote: 'Adopt vendor Y' }],
      }),
    ]);
    const instance = processor(new FakeLlmClient(mixed));
    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: evidence_id',
    });
  });

  it('rejects a signal when any cited quote or alias is invalid or duplicated', async () => {
    const invalidQuote = modelOutput([
      modelSignal({
        text: 'Use vendor X',
        status: 'decided',
        evidence: [
          { evidence_id: 'e1', quote: 'The team agreed to use vendor X' },
          { evidence_id: 'e2', quote: 'Invented supporting sentence' },
        ],
      }),
    ]);
    const invalidQuoteProcessor = processor(new FakeLlmClient(invalidQuote));
    await expect(
      invalidQuoteProcessor.extract(
        meeting,
        extractionContext(invalidQuoteProcessor),
      ),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: evidence_quote',
    });

    const duplicateAlias = modelOutput([
      modelSignal({
        text: 'Use vendor X',
        status: 'decided',
        evidence: [
          { evidence_id: 'e1', quote: 'The team agreed to use vendor X' },
          { evidence_id: 'e1', quote: 'Zhen will send the contract by Friday' },
        ],
      }),
    ]);
    const duplicateProcessor = processor(new FakeLlmClient(duplicateAlias));
    await expect(
      duplicateProcessor.extract(
        meeting,
        extractionContext(duplicateProcessor),
      ),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: evidence_duplicate',
    });
  });

  it('keeps an action unassigned when the transcript names a responsible participant', async () => {
    const output = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Send the contract',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Zhen will send the contract by Friday',
          },
        ],
      }),
    ]);
    const instance = processor(new FakeLlmClient(output));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals).toMatchObject([{ kind: 'action', owner: null }]);
  });

  it('rejects model-supplied action attribution as an unexpected field', async () => {
    const output = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Send the contract',
        owner_participant_id: 'participant-zhen',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Zhen will send the contract by Friday',
          },
        ],
      }),
    ]);
    const instance = processor(new FakeLlmClient(output));
    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output did not match the extraction schema at stage: irrelevant_fields',
    });
  });

  it('rejects a decided signal supported only by questions', async () => {
    const questionMeeting: MeetingDocument = {
      ...meeting,
      content: [
        {
          ...meeting.content[0]!,
          text: 'Should we use vendor X for hosting?',
        },
      ],
    };
    const output = modelOutput([
      modelSignal({
        text: 'Use vendor X for hosting',
        status: 'decided',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Should we use vendor X for hosting?',
          },
        ],
      }),
    ]);
    const instance = processor(new FakeLlmClient(output));
    await expect(
      instance.extract(questionMeeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: decided_question_only',
    });
  });

  it('normalizes grounded ISO and local calendar due dates and rejects malformed dates', async () => {
    const dueDates = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Send the contract',
        due_at: '2026-07-24T00:00:00-07:00',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Zhen will send the contract by Friday',
          },
        ],
      }),
    ]);
    const instance = processor(new FakeLlmClient(dueDates));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals).toMatchObject([
      { kind: 'action', due_at: '2026-07-24T07:00:00.000Z' },
    ]);
    expect(() =>
      assertCanonicalDecisionSet(result, meeting, instance.identity),
    ).not.toThrow();

    const malformed = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Confirm the hosting choice',
        due_at: 'not-a-date',
      }),
    ]);
    await expect(
      processor(new FakeLlmClient(malformed)).extract(
        meeting,
        extractionContext(instance),
      ),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });

    const dateOnly = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Confirm the hosting choice',
        due_at: '2026-07-24',
      }),
    ]);
    const dateOnlyResult = await processor(
      new FakeLlmClient(dateOnly),
    ).extract(meeting, extractionContext(instance));
    expect(dateOnlyResult.signals).toMatchObject([
      { kind: 'action', due_at: '2026-07-24T19:00:00.000Z' },
    ]);
    expect(() =>
      assertCanonicalDecisionSet(dateOnlyResult, meeting, instance.identity),
    ).not.toThrow();

    const invalidCalendarDate = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Confirm the hosting choice',
        due_at: '2026-02-30',
      }),
    ]);
    await expect(
      processor(new FakeLlmClient(invalidCalendarDate)).extract(
        meeting,
        extractionContext(instance),
      ),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });

    const beforeMeeting = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Confirm the hosting choice',
        due_at: '2024-07-24T00:00:00-07:00',
      }),
    ]);
    await expect(
      processor(new FakeLlmClient(beforeMeeting)).extract(
        meeting,
        extractionContext(instance),
      ),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });
  });

  it('normalizes date-only deadlines at local noon across daylight-saving boundaries', async () => {
    const cases = [
      ['2026-03-08', '2026-03-08T19:00:00.000Z'],
      ['2026-11-01', '2026-11-01T20:00:00.000Z'],
    ] as const;

    for (const [localDate, canonicalDueAt] of cases) {
      const dstMeeting: MeetingDocument = {
        ...meeting,
        time: {
          actual_start_at: `${localDate}T10:30:00.000Z`,
          timezone: 'America/Los_Angeles',
        },
      };
      const output = modelOutput([
        modelSignal({
          kind: 'action',
          text: 'Send the contract',
          due_at: localDate,
          evidence: [
            {
              evidence_id: 'e1',
              quote: 'Zhen will send the contract by Friday',
            },
          ],
        }),
      ]);
      const instance = processor(new FakeLlmClient(output));
      const result = await instance.extract(
        dstMeeting,
        extractionContext(instance),
      );

      expect(result.signals).toMatchObject([
        { kind: 'action', due_at: canonicalDueAt },
      ]);
      expect(() =>
        assertCanonicalDecisionSet(result, dstMeeting, instance.identity),
      ).not.toThrow();
    }
  });

  it('ignores schema-valid values in fields irrelevant to a signal kind', async () => {
    const noisy = JSON.parse(validModelOutput) as {
      signals: Record<string, unknown>[];
    };
    Object.assign(noisy.signals[0]!, {
      due_at: 'not-used',
      supports_decision_indexes: [2],
    });
    Object.assign(noisy.signals[1]!, {
      status: 'decided',
      supports_decision_indexes: [0],
    });
    Object.assign(noisy.signals[2]!, {
      status: 'proposed',
      due_at: 'not-used',
    });
    const cleanInstance = processor(new FakeLlmClient(validModelOutput));
    const noisyInstance = processor(
      new FakeLlmClient(JSON.stringify(noisy)),
    );

    const [cleanResult, noisyResult] = await Promise.all([
      cleanInstance.extract(meeting, extractionContext(cleanInstance)),
      noisyInstance.extract(meeting, extractionContext(noisyInstance)),
    ]);

    expect(noisyResult).toEqual(cleanResult);
  });

  it('drops an out-of-range advisory confidence without dropping the signal', async () => {
    const output = modelOutput([
      modelSignal({
        text: 'Use vendor X for hosting',
        status: 'decided',
        confidence: 95,
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'The team agreed to use vendor X for hosting',
          },
        ],
      }),
    ]);
    const instance = processor(new FakeLlmClient(output));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals).toMatchObject([{ confidence: null }]);

    const wrongType = modelOutput([
      modelSignal({ confidence: 'high' }),
    ]);
    await expect(
      processor(new FakeLlmClient(wrongType)).extract(
        meeting,
        extractionContext(instance),
      ),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message: 'LLM output did not match the extraction schema at stage: confidence',
    });
  });

  it('rejects rationales that do not uniquely reference extracted decisions', async () => {
    const invalidSupports = [[], [1], [99], [0, 0]] as const;

    for (const supports of invalidSupports) {
      const parsed = JSON.parse(validModelOutput) as {
        signals: Record<string, unknown>[];
      };
      parsed.signals[2]!['supports_decision_indexes'] = [...supports];
      const instance = processor(
        new FakeLlmClient(JSON.stringify(parsed)),
      );

      await expect(
        instance.extract(meeting, extractionContext(instance)),
      ).rejects.toMatchObject({
        code: 'temporarily_unavailable',
        message:
          'LLM output contained invalid or unsupported signal grounding at stage: rationale_supports',
      });
    }
  });

  it('compares due dates to the local meeting date across a near-midnight boundary', async () => {
    const nearMidnightMeeting: MeetingDocument = {
      ...meeting,
      time: {
        actual_start_at: '2026-07-17T07:30:00.000Z',
        timezone: 'America/Los_Angeles',
      },
    };
    const output = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Send the contract',
        due_at: '2026-07-16T23:45:00-07:00',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Zhen will send the contract by Friday',
          },
        ],
      }),
    ]);
    const client = new FakeLlmClient(output);
    const instance = processor(client);

    await expect(
      instance.extract(nearMidnightMeeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      message:
        'LLM output contained invalid or unsupported signal grounding at stage: due_before_meeting',
    });
    expect(client.requests[0]!.userPrompt).toContain(
      '"date_reference_local_date":"2026-07-17"',
    );
  });

  it('compares due dates using the meeting timezone across daylight-saving time', async () => {
    const dstMeeting: MeetingDocument = {
      ...meeting,
      time: {
        actual_start_at: '2026-03-08T10:30:00.000Z',
        timezone: 'America/Los_Angeles',
      },
    };
    const output = modelOutput([
      modelSignal({
        kind: 'action',
        text: 'Send the contract',
        due_at: '2026-03-07T23:30:00-08:00',
        evidence: [
          {
            evidence_id: 'e1',
            quote: 'Zhen will send the contract by Friday',
          },
        ],
      }),
    ]);
    const client = new FakeLlmClient(output);
    const instance = processor(client);

    await expect(
      instance.extract(dstMeeting, extractionContext(instance)),
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(client.requests[0]!.userPrompt).toContain(
      '"date_reference_local_date":"2026-03-08"',
    );
  });

  it('applies identical v5 extraction semantics for every provider', async () => {
    const matrix: readonly [LlmProviderId, AdapterConfig][] = [
      [
        'ollama',
        {
          adapter_id: 'llm',
          instance_id: 'local',
          settings: { provider: 'ollama', model: 'qwen3:4b' },
        },
      ],
      [
        'openai',
        {
          adapter_id: 'llm',
          instance_id: 'openai',
          credential_ref: 'env:OPENAI_API_KEY',
          settings: { provider: 'openai', model: 'gpt-5' },
        },
      ],
      [
        'anthropic',
        {
          adapter_id: 'llm',
          instance_id: 'anthropic',
          credential_ref: 'env:ANTHROPIC_API_KEY',
          settings: { provider: 'anthropic', model: 'claude-sonnet' },
        },
      ],
      [
        'openrouter',
        {
          adapter_id: 'llm',
          instance_id: 'openrouter',
          credential_ref: 'env:OPENROUTER_API_KEY',
          settings: { provider: 'openrouter', model: 'openai/gpt-5' },
        },
      ],
    ];
    const expectedSignals = (
      await processor(new FakeLlmClient(validModelOutput)).extract(
        meeting,
        extractionContext(processor(new FakeLlmClient(validModelOutput))),
      )
    ).signals;

    for (const [provider, config] of matrix) {
      const client = new FakeLlmClient(
        validModelOutput,
        [String(config.settings['model'])],
        undefined,
        provider,
      );
      const instance = processor(client, config);
      const result = await instance.extract(
        meeting,
        extractionContext(instance),
      );

      expect(result.signals).toEqual(expectedSignals);
      expect(client.requests[0]!.schema).toEqual(
        expect.objectContaining({ type: 'object' }),
      );
      expect(client.requests[0]!.systemPrompt).toContain(
        'fill only the provided schema',
      );
    }
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

  it('rejects a partially malformed signal instead of silently dropping it', async () => {
    const partial = modelOutput([
      modelSignal({ text: 'Use vendor X' }),
      { kind: 'action', text: 'Missing the required fields' },
    ]);
    const instance = processor(new FakeLlmClient(partial));

    await expect(
      instance.extract(meeting, extractionContext(instance)),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'temporarily_unavailable',
      retryable: true,
    });
  });

  it('reports only allowlisted structural schema stages without model values', async () => {
    const modelValue = 'model-value-that-must-not-appear';
    const cases: readonly [string, string][] = [
      [JSON.stringify({ signals: [], unexpected: modelValue }), 'irrelevant_fields'],
      [
        modelOutput([
          modelSignal({ kind: modelValue }),
        ]),
        'kind',
      ],
      [
        modelOutput([
          modelSignal({ evidence: [] }),
        ]),
        'evidence_shape',
      ],
    ];

    for (const [output, stage] of cases) {
      try {
        await processor(new FakeLlmClient(output)).extract(
          meeting,
          extractionContext(processor(new FakeLlmClient(output))),
        );
        throw new Error('expected extraction to fail');
      } catch (error) {
        expect(error).toMatchObject({
          name: 'AdapterError',
          code: 'temporarily_unavailable',
          retryable: true,
        });
        expect(extractionSchemaFailureStage(error)).toBe(stage);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(modelValue);
      }
    }

    expect(
      extractionSchemaFailureStage(
        new AdapterError(
          'temporarily_unavailable',
          'LLM output did not match the extraction schema at stage: untrusted-value',
          true,
        ),
      ),
    ).toBeUndefined();
  });

  it('reports only allowlisted grounding stages without rejected values', () => {
    const rejectedValue = 'model-value-that-must-not-appear';
    const error = new AdapterError(
      'temporarily_unavailable',
      'LLM output contained invalid or unsupported signal grounding at stage: evidence_quote',
      true,
    );

    expect(extractionGroundingFailureStage(error)).toBe('evidence_quote');
    expect(error.message).not.toContain(rejectedValue);
    expect(
      extractionGroundingFailureStage(
        new AdapterError(
          'temporarily_unavailable',
          `LLM output contained invalid or unsupported signal grounding at stage: ${rejectedValue}`,
          true,
        ),
      ),
    ).toBeUndefined();
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
    expect(referenceMeetingProcessingKey(meeting, hostedProcessor)).not.toBe(
      referenceMeetingProcessingKey(meeting, localProcessor),
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
