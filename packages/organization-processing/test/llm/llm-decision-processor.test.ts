import { observeCoreRuntimeV1, withCoreRuntimeDiagnosticsV1, type CoreRuntimeObservationV1, type CoreRuntimeDiagnosticObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { describe, expect, it, vi } from 'vitest';
import { adapterConformance } from '../../../../tests/support/adapter-conformance.js';
import {
  AdapterError,
  assertCanonicalDecisionSet,
  type AdapterConfig,
  type MeetingDocument,
} from "../../src/core/index.js";
import {
  EXTRACTION_OUTPUT_JSON_FAILURE_MESSAGE,
  extractionGroundingFailureStage,
  extractionSchemaFailureStage,
  LlmDecisionProcessor,
  llmProcessingVersion as processingVersion,
} from "../../src/llm/llm-decision-processor.js";
import {
  type LlmProviderClient,
  type LlmProviderId,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "../../src/llm/llm-provider.js";
import { classifyExtractionFailureStageV1 } from "../../src/admitted-meeting-processing/extraction-failure-stage-v1.js";

const modelFailure = { aborted: false, received_output: false };
const GROUNDING = 'LLM output contained invalid or unsupported signal grounding at stage: ';
const SCHEMA = 'LLM output did not match the extraction schema at stage: ';

const processorConfig: AdapterConfig = {
  adapter_id: 'llm',
  instance_id: 'local',
  settings: { model: 'fixture-model' },
};

// Units: N1, N2 (notes, section "Vendor selection"), S1 (AI summary), T1 (Ada, a question), T2 (Zhen).
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
  participants: [
    { id: 'participant-zhen', display_name: 'Zhen' },
    { id: 'participant-ada', display_name: 'Ada' },
  ],
  time: {
    actual_start_at: '2026-07-17T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
  },
  content: [
    {
      id: 'notes-1',
      kind: 'note',
      text: '### Vendor selection\n- The team agreed to use vendor X for hosting\n- Zhen will send the contract by Friday',
    },
    { id: 'summary-1', kind: 'summary', text: 'Vendor X was cheaper and faster.' },
    {
      id: 'transcript-1',
      kind: 'transcript',
      text: 'Should we use vendor X for hosting?',
      speaker_participant_id: 'participant-ada',
      started_at: '2026-07-17T17:01:00.000Z',
      ended_at: '2026-07-17T17:01:04.000Z',
    },
    { id: 'transcript-2', kind: 'transcript', text: "I'll send the signed copy tonight.", speaker_participant_id: 'participant-zhen' },
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
    private readonly models: readonly string[] = ['fixture-model'],
    private readonly failure?: Error,
    readonly provider: LlmProviderId = 'fixture-local',
  ) {}

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    if (this.failure !== undefined) throw this.failure;
    this.requests.push(request);
    return { content: this.content };
  }

  async verifyModel(model: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (!this.models.includes(model)) {
      throw new AdapterError(
        'permanently_rejected',
        `Model '${model}' is not installed in fixture-local`,
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
    validateProviderConfig: config => config.settings['unsupported'] === true ? ['fixture setting is unsupported'] : [],
    identityEndpoint: null,
    now: () => '2026-07-17T18:00:00.000Z',
  });
}

function extractionContext(instance: LlmDecisionProcessor) {
  return {
    processor_version: instance.identity.version,
    input_fingerprint: meeting.provenance.canonical_revision,
  };
}

function extractWith(output: string, value: MeetingDocument = meeting) {
  const instance = processor(new FakeLlmClient(output));
  return instance.extract(value, extractionContext(instance));
}

function testProcessingVersion(config: AdapterConfig): string {
  return config.settings['provider'] === 'fixture-remote'
    ? processingVersion(config, 'fixture-remote', null)
    : processingVersion(config, 'fixture-local', null);
}

function modelSignal(overrides: Record<string, unknown>) {
  return {
    kind: 'decision',
    text: 'Use vendor X for hosting',
    status: 'unresolved',
    owner: null,
    due_at: null,
    confidence: null,
    evidence_units: ['N1'],
    supports_decision_indexes: [],
    ...overrides,
  };
}

function modelOutput(signals: readonly unknown[]) {
  return JSON.stringify({ signals });
}

const validModelOutput = modelOutput([
  modelSignal({ status: 'decided', confidence: 0.9, evidence_units: ['N1', 'T1'] }),
  modelSignal({ kind: 'action', text: 'Send the contract', owner: 'Zhen', due_at: '2026-07-24', confidence: 0.8, evidence_units: ['N2'] }),
  modelSignal({ kind: 'rationale', text: 'Vendor X was cheaper and faster', confidence: 0.7, evidence_units: ['S1'], supports_decision_indexes: [0] }),
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
    settings: { model: 'fixture-model', unsupported: true },
  },
});

describe('llm decision processor extraction', () => {
  it('renders the meeting as a header and numbered units per section', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    await instance.extract(meeting, extractionContext(instance));

    const request = client.requests[0]!;
    expect(request.userPrompt).toBe([
      'Meeting: Vendor selection sync',
      'Meeting date: 2026-07-17 (Friday), time zone America/Los_Angeles. Resolve relative dates from this date.',
      'Participants (may be incomplete): Zhen; Ada',
      'Speaker labels are participant names when known; otherwise a recording label, which may cover several people.',
      '',
      '### Notes written by people',
      '[N1] (Vendor selection) The team agreed to use vendor X for hosting',
      '[N2] (Vendor selection) Zhen will send the contract by Friday',
      "### Summary written by a tool's AI (cite only when nothing else supports a signal)",
      '[S1] Vendor X was cheaper and faster.',
      '### Transcript',
      '[T1] Ada: Should we use vendor X for hosting?',
      "[T2] Zhen: I'll send the signed copy tonight.",
    ].join('\n'));
    expect(request.model).toBe('fixture-model');
    expect(request.systemPrompt).toContain('For each signal, list in evidence_units the IDs of every unit that supports it');
    expect(request.systemPrompt).toContain('Never infer an owner from who spoke');
    expect(request.schema).toMatchObject({
      additionalProperties: false,
      properties: { signals: { items: {
        additionalProperties: false,
        required: ['kind', 'text', 'status', 'owner', 'due_at', 'confidence', 'evidence_units', 'supports_decision_indexes'],
        properties: { evidence_units: { type: 'array', items: { type: 'string' } } },
      } } },
    });
    const schemaJson = JSON.stringify(request.schema);
    for (const absent of ['"evidence"', 'quote', 'owner_participant_id', 'minItems', 'minimum', 'maximum']) {
      expect(schemaJson).not.toContain(absent);
    }

    const bare: MeetingDocument = {
      ...meeting, title: ' ', participants: [], time: undefined,
      content: [{ id: 'transcript-1', kind: 'transcript', text: 'Bo\u0085Li: Ship it.' }],
    };
    await instance.extract(bare, extractionContext(instance));
    expect(client.requests[1]!.userPrompt).toBe([
      'Meeting: (untitled)',
      'Meeting date: unknown. Set a due date only when the meeting states an absolute date.',
      'Speaker labels are participant names when known; otherwise a recording label, which may cover several people.',
      '',
      '### Transcript',
      '[T1] Bo Li: Ship it.',
    ].join('\n'));
  });

  it('builds evidence from the cited units as exact block slices', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    const first = await instance.extract(meeting, extractionContext(instance));
    const second = await instance.extract(meeting, extractionContext(instance));

    expect(first).toMatchObject({
      schema_version: 1,
      meeting_id: 'meeting-llm-1',
      meeting_revision: 'sha256:llm-fixture-revision',
      processor: instance.identity,
      generated_at: '2026-07-17T18:00:00.000Z',
    });
    const [decision, action, rationale] = first.signals;
    expect(decision!.id).toMatch(/^decision:sha256:[a-f0-9]{64}$/);
    expect(decision).toEqual({
      id: decision!.id, kind: 'decision', text: 'Use vendor X for hosting', subject: null, status: 'decided', confidence: 0.9,
      evidence: [
        { meeting_id: meeting.id, block_id: 'notes-1', quote: 'The team agreed to use vendor X for hosting' },
        {
          meeting_id: meeting.id, block_id: 'transcript-1', quote: 'Should we use vendor X for hosting?',
          started_at: '2026-07-17T17:01:00.000Z', ended_at: '2026-07-17T17:01:04.000Z',
        },
      ],
    });
    expect(action).toMatchObject({
      kind: 'action', owner: 'Zhen', due_at: '2026-07-24T19:00:00.000Z', confidence: 0.8,
      evidence: [{ meeting_id: meeting.id, block_id: 'notes-1', quote: 'Zhen will send the contract by Friday' }],
    });
    expect(rationale).toMatchObject({
      kind: 'rationale',
      evidence: [{ block_id: 'summary-1', quote: 'Vendor X was cheaper and faster.' }],
      supports_signal_ids: [decision!.id],
    });
    expect(first.signals).toHaveLength(3);
    expect(() => assertCanonicalDecisionSet(first, meeting, instance.identity)).not.toThrow();
    expect(second.signals.map((signal) => signal.id)).toEqual(first.signals.map((signal) => signal.id));
  });

  it('drops unknown cited IDs and sets aside an item with no known unit', async () => {
    const result = await extractWith(modelOutput([
      modelSignal({ text: 'Adopt vendor Y', evidence_units: ['T999', ' '] }),
      modelSignal({ evidence_units: [' [N1] ', 'T999', 'N1'] }),
    ]));

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      text: 'Use vendor X for hosting',
      evidence: [{ block_id: 'notes-1', quote: 'The team agreed to use vendor X for hosting' }],
    });
    expect(result.signals[0]!.evidence).toHaveLength(1);
  });

  it('keeps the first of items with the same kind, normalized text and units', async () => {
    const result = await extractWith(modelOutput([
      modelSignal({ evidence_units: ['N1', 'T1'] }),
      modelSignal({ text: '  use VENDOR x \n for hosting ', evidence_units: ['T1', 'N1'] }),
      modelSignal({ evidence_units: ['N1'] }),
      modelSignal({ kind: 'action', evidence_units: ['N1', 'T1'] }),
    ]));

    expect(result.signals.map((signal) => [signal.kind, signal.text, signal.evidence.length])).toEqual([
      ['decision', 'Use vendor X for hosting', 2],
      ['decision', 'Use vendor X for hosting', 1],
      ['action', 'Use vendor X for hosting', 2],
    ]);
    // Distinct units with identical quotes would repeat the signal id.
    const echoed: MeetingDocument = { ...meeting, content: [{ id: 'transcript-1', kind: 'transcript', text: 'Ada: Yes.\nBo: Yes.' }] };
    const repeated = await extractWith(modelOutput([modelSignal({ evidence_units: ['T1'] }), modelSignal({ evidence_units: ['T2'] })]), echoed);
    expect(repeated.signals).toHaveLength(1);
  });

  it('links a rationale citing a dropped duplicate decision to the kept one', async () => {
    const result = await extractWith(modelOutput([
      modelSignal({ evidence_units: ['N1'] }),
      modelSignal({ text: 'use vendor X for hosting', evidence_units: ['N1'] }),
      modelSignal({ kind: 'rationale', text: 'Vendor X was cheaper and faster', evidence_units: ['S1'], supports_decision_indexes: [1] }),
    ]));
    expect(result.signals.map((signal) => signal.kind)).toEqual(['decision', 'rationale']);
    expect(result.signals[1]).toMatchObject({ supports_signal_ids: [result.signals[0]!.id] });
  });

  // Units: N1–N8, then one long Ada turn split into T1.1 (sentences 1–8) and T1.2 (9–14).
  const manyUnits: MeetingDocument = { ...meeting, content: [
    { id: 'notes-1', kind: 'note', text: Array.from({ length: 8 }, (_, n) => `Point ${n + 1}`).join('\n') },
    { id: 'transcript-1', kind: 'transcript', speaker_participant_id: 'participant-ada',
      text: Array.from({ length: 14 }, (_, n) => `Sentence ${n + 1} covers one launch risk in detail.`).join(' ') },
  ] };
  const citedQuotes = (signal: { evidence: readonly { quote?: string }[] }) => signal.evidence.map((span) => span.quote?.split(' covers')[0]);

  it('keeps the first six cited units of an item in citation order', async () => {
    const result = await extractWith(modelOutput([modelSignal({ evidence_units: ['N8', 'N7', 'N6', 'N5', 'N4', 'N3', 'N2', 'N1'] })]), manyUnits);
    expect(result.signals.map(citedQuotes)).toEqual([['Point 8', 'Point 7', 'Point 6', 'Point 5', 'Point 4', 'Point 3']]);
  });

  it('reads cited IDs in any case and a split turn\'s parent ID as its parts', async () => {
    const result = await extractWith(modelOutput([
      modelSignal({ evidence_units: ['n1', 't1', 'T9'] }),
      modelSignal({ text: 'Ship the launch', evidence_units: ['N1', 'N2', 'N3', 'N4', 'N5', 'T1'] }),
    ]), manyUnits);
    expect(result.signals.map(citedQuotes)).toEqual([
      ['Point 1', 'Sentence 1', 'Sentence 9'],
      ['Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Sentence 1'],
    ]);
  });

  it('downgrades a decided decision that cites only questions', async () => {
    const result = await extractWith(modelOutput([
      modelSignal({ status: 'decided', evidence_units: ['T1'] }),
      modelSignal({ status: 'decided', evidence_units: ['T1', 'N1'] }),
    ]));
    expect(result.signals).toMatchObject([{ status: 'proposed' }, { status: 'decided' }]);
  });

  it('clears an unusable or pre-meeting due date and keeps the action', async () => {
    const dueDates = ['2026-07-24T00:00:00-07:00', '2026-07-24', '2026-07-17', 'not-a-date', '2026-02-30', 7,
      '2026-07-16', '2026-07-16T23:45:00-07:00', '2026-07-17T02:00:00Z'];
    const result = await extractWith(modelOutput(dueDates.map((due_at) => modelSignal({
      kind: 'action', text: `Send the contract (${String(due_at)})`, due_at, evidence_units: ['N2'],
    }))));

    expect(result.signals.map((signal) => signal.kind === 'action' ? signal.due_at : undefined)).toEqual([
      '2026-07-24T07:00:00.000Z', '2026-07-24T19:00:00.000Z', '2026-07-17T19:00:00.000Z', null, null, null, null, null, null,
    ]);
  });

  it.each([
    ['2026-03-08', '2026-03-08T19:00:00.000Z'],
    ['2026-11-01', '2026-11-01T20:00:00.000Z'],
  ])('normalizes date-only deadline %s at local noon across daylight-saving boundaries', async (localDate, dueAt) => {
    const dstMeeting: MeetingDocument = { ...meeting, time: { actual_start_at: `${localDate}T10:30:00.000Z`, timezone: 'America/Los_Angeles' } };
    const instance = processor(new FakeLlmClient(modelOutput([
      modelSignal({ kind: 'action', text: 'Send the contract', due_at: localDate, evidence_units: ['N2'] }),
    ])));
    const result = await instance.extract(dstMeeting, extractionContext(instance));
    expect(result.signals).toMatchObject([{ kind: 'action', due_at: dueAt }]);
    expect(() => assertCanonicalDecisionSet(result, dstMeeting, instance.identity)).not.toThrow();
  });

  it('keeps a proposed owner only when a cited unit names them or they commit as its speaker', async () => {
    const action = (text: string, owner: unknown, units: readonly string[]) =>
      modelSignal({ kind: 'action', text, owner, evidence_units: units });
    const result = await extractWith(modelOutput([
      action('Send the contract', '  Zhen ', ['N2']),
      action('Send the signed copy', 'Zhen', ['T2']),
      action('Confirm the hosting choice', 'Ada', ['T1']),
      action('Send the quote', 'Priya', ['N2']),
      action('Send the draft', 'Zhe', ['N2']),
      action('Send the memo', 7, ['N2']),
      action('Send the deck', 'x'.repeat(121), ['N2']),
      action('Send the notes', null, ['N2']),
      modelSignal({ owner: 'Zhen', evidence_units: ['N2'] }),
    ]));

    expect(result.signals.map((signal) => signal.kind === 'action' ? signal.owner : 'no-owner-field')).toEqual([
      'Zhen', 'Zhen', null, null, null, null, null, null, 'no-owner-field',
    ]);
    expect(result.signals[8]).not.toHaveProperty('owner');
  });

  it('links rationales only to surviving decisions and sets aside one with none left', async () => {
    const instance = processor(new FakeLlmClient(modelOutput([
      modelSignal({ kind: 'rationale', text: 'Vendor X was cheaper and faster', evidence_units: ['S1'], supports_decision_indexes: [2, 2, 1, 3, 99, -1, 0.5] }),
      modelSignal({ text: 'Adopt vendor Y', evidence_units: ['T999'] }),
      modelSignal({ evidence_units: ['N1'] }),
      modelSignal({ kind: 'rationale', text: 'Vendor Y was cheaper', evidence_units: ['S1'], supports_decision_indexes: [1] }),
      modelSignal({ kind: 'rationale', text: 'Vendor X was faster', evidence_units: ['S1'], supports_decision_indexes: 'all' }),
    ])));
    const result = await instance.extract(meeting, extractionContext(instance));

    expect(result.signals.map((signal) => signal.text)).toEqual(['Vendor X was cheaper and faster', 'Use vendor X for hosting']);
    expect(result.signals[0]).toMatchObject({ kind: 'rationale', supports_signal_ids: [result.signals[1]!.id] });
    expect(() => assertCanonicalDecisionSet(result, meeting, instance.identity)).not.toThrow();
  });

  it('fails the meeting with the first set-aside reason when no item survives', async () => {
    const instance = processor(new FakeLlmClient(modelOutput([
      modelSignal({ evidence_units: ['T999'] }),
      modelSignal({ kind: 'rationale', text: 'Vendor X was cheaper', evidence_units: ['S1'], supports_decision_indexes: [0] }),
    ])));
    const metadata: CoreRuntimeObservationV1[] = [];
    const failure = await observeCoreRuntimeV1('extraction', () => instance.extract(meeting, extractionContext(instance)), {
      observer: (event) => { metadata.push(event); },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'AdapterError', code: 'temporarily_unavailable', retryable: true, message: `${GROUNDING}evidence_id` });
    expect(extractionGroundingFailureStage(failure)).toBe('evidence_id');
    expect(classifyExtractionFailureStageV1(failure, modelFailure)).toBe('evidence_id');
    expect(metadata).toEqual(expect.arrayContaining([expect.objectContaining({
      phase: 'model_grounding', grounding_stage: 'evidence_id', result: 'grounding_failure', event: 'failed',
    })]));
    await expect(extractWith(modelOutput([modelSignal({ kind: 'bogus' }), modelSignal({ evidence_units: ['T999'] })])))
      .rejects.toMatchObject({ message: `${SCHEMA}kind` });
    await expect(extractWith(modelOutput([
      modelSignal({ kind: 'rationale', evidence_units: ['S1'], supports_decision_indexes: [1] }),
      modelSignal({ evidence_units: ['T999'] }),
    ]))).rejects.toMatchObject({ message: `${GROUNDING}rationale_supports` });
  });

  it('returns an empty set without calling the model when the meeting has no units', async () => {
    const client = new FakeLlmClient(validModelOutput);
    const instance = processor(client);
    const blank: MeetingDocument = { ...meeting, content: [{ id: 'notes-1', kind: 'note', text: ' \n### Agenda\n' }] };
    const payload: CoreRuntimeDiagnosticObservationV1[] = [];
    const result = await withCoreRuntimeDiagnosticsV1((event) => { payload.push(event); },
      () => observeCoreRuntimeV1('extraction', () => instance.extract(blank, extractionContext(instance))));

    expect(result.signals).toEqual([]);
    expect(() => assertCanonicalDecisionSet(result, blank, instance.identity)).not.toThrow();
    expect(client.requests).toHaveLength(0);
    expect(payload).toHaveLength(0);
    await expect(extractWith(modelOutput([]))).resolves.toMatchObject({ signals: [] });
  });

  it('sends set-aside items only to a selected private sink, keeping the survivors', async () => {
    const output = modelOutput([
      modelSignal({ kind: 'bogus', evidence_units: ['N1'] }),
      modelSignal({ text: 'Adopt vendor Y', evidence_units: ['T999'] }),
      modelSignal({ kind: 'action', text: 'Send the contract', evidence_units: ['N2'] }),
    ]);
    const instance = processor(new FakeLlmClient(output));
    const metadata: CoreRuntimeObservationV1[] = [], payload: CoreRuntimeDiagnosticObservationV1[] = [];
    const extract = () => observeCoreRuntimeV1('extraction', () => instance.extract(meeting, extractionContext(instance)), {
      observer: (event) => { metadata.push(event); },
    });
    const kept = { signals: [{ kind: 'action', text: 'Send the contract' }] };
    await expect(extract()).resolves.toMatchObject(kept);
    expect(payload).toHaveLength(0);
    await expect(withCoreRuntimeDiagnosticsV1((event) => { payload.push(event); }, extract)).resolves.toMatchObject(kept);
    expect(payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'model_request', role: 'extraction', input: expect.objectContaining({ user_prompt: expect.stringContaining('[N2] (Vendor selection) Zhen will send the contract by Friday') }) }),
      expect.objectContaining({ kind: 'model_response', value: output }),
    ]));
    expect(payload.filter((event) => event.kind === 'lifecycle')).toMatchObject([
      { stage: 'grounding', event: 'skipped', data: { signal_index: 0, reason: 'kind', cited_units: ['N1'] } },
      { stage: 'grounding', event: 'skipped', data: { signal_index: 1, reason: 'evidence_id', cited_units: ['T999'] } },
    ]);
    for (const text of ['T999', 'Adopt vendor Y', meeting.title!, 'Zhen will send']) expect(JSON.stringify(metadata)).not.toContain(text);
    await expect(withCoreRuntimeDiagnosticsV1(() => { throw new Error('diagnostic failure'); }, extract)).resolves.toMatchObject(kept);
  });

  it('ignores values in fields irrelevant to a signal kind and drops an invalid confidence', async () => {
    const noisy = JSON.parse(validModelOutput) as { signals: Record<string, unknown>[] };
    Object.assign(noisy.signals[0]!, { owner: 'Zhen', due_at: 'not-used', supports_decision_indexes: [2] });
    Object.assign(noisy.signals[1]!, { status: 'not-used', supports_decision_indexes: [0] });
    Object.assign(noisy.signals[2]!, { status: 'proposed', owner: 'Zhen', due_at: 'not-used' });
    const [clean, noisyResult] = await Promise.all([extractWith(validModelOutput), extractWith(JSON.stringify(noisy))]);
    expect(noisyResult).toEqual(clean);

    const confidences = await extractWith(modelOutput([
      modelSignal({ confidence: 95 }),
      modelSignal({ kind: 'action', confidence: 'high' }),
    ]));
    expect(confidences.signals).toMatchObject([{ confidence: null }, { confidence: null }]);
  });

  it('applies identical extraction semantics for independently supplied clients', async () => {
    const matrix: readonly [LlmProviderId, AdapterConfig][] = [
      ['fixture-local', processorConfig],
      ['fixture-remote', {
        adapter_id: 'llm', instance_id: 'remote',
        settings: { provider: 'fixture-remote', model: 'another-model' },
      }],
    ];
    const expectedSignals = (await extractWith(validModelOutput)).signals;

    for (const [provider, config] of matrix) {
      const client = new FakeLlmClient(validModelOutput, [String(config.settings['model'])], undefined, provider);
      const instance = processor(client, config);
      const result = await instance.extract(meeting, extractionContext(instance));
      expect(result.signals).toEqual(expectedSignals);
      expect(client.requests[0]!.systemPrompt).toContain('fill only the provided schema');
    }
  });

  it('reports only allowlisted structural schema stages without model values', async () => {
    const modelValue = 'model-value-that-must-not-appear';
    const cases: readonly [string, string][] = [
      [JSON.stringify({ signals: [], unexpected: modelValue }), 'irrelevant_fields'],
      [JSON.stringify({ signals: modelValue }), 'top_level'],
      [JSON.stringify([modelValue]), 'top_level'],
      [modelOutput([modelValue]), 'signal_fields'],
      [modelOutput([{ kind: 'action', text: modelValue }]), 'signal_fields'],
      [modelOutput([modelSignal({ owner_participant_id: modelValue })]), 'irrelevant_fields'],
      [modelOutput([modelSignal({ kind: modelValue })]), 'kind'],
      [modelOutput([modelSignal({ text: ' ' })]), 'text'],
      [modelOutput([modelSignal({ status: modelValue })]), 'status'],
      [modelOutput([modelSignal({ evidence_units: modelValue })]), 'evidence_shape'],
      [modelOutput([modelSignal({ evidence_units: ['N1', 7] })]), 'evidence_shape'],
    ];

    for (const [output, stage] of cases) {
      const error = await extractWith(output).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'AdapterError', code: 'temporarily_unavailable', retryable: true });
      expect(extractionSchemaFailureStage(error)).toBe(stage);
      expect(classifyExtractionFailureStageV1(error, modelFailure)).toBe(`schema_${stage}`);
      expect((error as Error).message).not.toContain(modelValue);
    }

    const notJson = await extractWith('not json at all').catch((caught: unknown) => caught);
    expect(notJson).toMatchObject({ code: 'temporarily_unavailable', retryable: true, message: EXTRACTION_OUTPUT_JSON_FAILURE_MESSAGE });
    expect(classifyExtractionFailureStageV1(notJson, modelFailure)).toBe('output_json');
    expect(extractionSchemaFailureStage(new AdapterError('temporarily_unavailable', `${SCHEMA}untrusted-value`, true))).toBeUndefined();
    expect(extractionGroundingFailureStage(new AdapterError('temporarily_unavailable', `${GROUNDING}${modelValue}`, true))).toBeUndefined();
  });

  it('fails closed on cancellation', async () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    const controller = new AbortController();
    controller.abort();
    await expect(
      instance.extract(meeting, extractionContext(instance), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('llm decision processor configuration', () => {
  it('requires a model and incorporates the injected validation errors', () => {
    const instance = processor(new FakeLlmClient(validModelOutput));
    expect(instance.validateConfig({ ...processorConfig, settings: {} }).errors).toContain('settings.model is required');
    expect(instance.validateConfig(processorConfig)).toEqual({ ok: true, errors: [] });
    const policy = vi.fn(() => ['fixture policy rejected configuration']);
    const rejecting = new LlmDecisionProcessor(processorConfig, {
      client: new FakeLlmClient(validModelOutput), validateProviderConfig: policy, identityEndpoint: null,
    });
    expect(rejecting.validateConfig(processorConfig).errors).toContain('fixture policy rejected configuration');
    expect(policy).toHaveBeenCalledWith(processorConfig);
  });
  it('changes processing identity for provider, model, or schema-affecting settings', () => {
    const local = processorConfig;
    const explicitLocal: AdapterConfig = {
      ...processorConfig,
      settings: { provider: 'fixture-local', model: 'fixture-model' },
    };
    const differentTimeout: AdapterConfig = {
      ...processorConfig,
      settings: {
        model: 'fixture-model',
        request_timeout_ms: 60_000,
      },
    };
    const differentModel: AdapterConfig = {
      ...processorConfig,
      settings: { model: 'fixture-larger-model' },
    };
    const remote: AdapterConfig = {
      ...processorConfig,
      credential_ref: 'env:OPENAI_API_KEY',
      settings: { provider: 'fixture-remote', model: 'fixture-model' },
    };
    const moreOutput: AdapterConfig = {
      ...processorConfig,
      settings: { model: 'fixture-model', max_output_tokens: 8192 },
    };

    expect(testProcessingVersion(explicitLocal)).toBe(
      testProcessingVersion(local),
    );
    expect(testProcessingVersion(differentTimeout)).toBe(
      testProcessingVersion(local),
    );
    expect(testProcessingVersion(differentModel)).not.toBe(
      testProcessingVersion(local),
    );
    expect(testProcessingVersion(remote)).not.toBe(testProcessingVersion(local));
    expect(testProcessingVersion(moreOutput)).not.toBe(
      testProcessingVersion(local),
    );
    const localProcessor = processor(
      new FakeLlmClient(validModelOutput),
      local,
    );
    const hostedProcessor = processor(
      new FakeLlmClient(validModelOutput, undefined, undefined, 'fixture-remote'),
      remote,
    );
    expect(hostedProcessor.identity.version).not.toBe(
      localProcessor.identity.version,
    );
  });
  it('reports unavailable health when the configured model is not installed', async () => {
    const instance = processor(
      new FakeLlmClient(validModelOutput, ['some-other-model']),
    );
    const health = await instance.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.message).toContain('fixture-model');
  });
  it('reports unavailable health when the provider cannot be reached', async () => {
    const instance = processor(
      new FakeLlmClient(
        validModelOutput,
        ['fixture-model'],
        new AdapterError('temporarily_unavailable', 'connection refused', true),
      ),
    );
    const health = await instance.healthCheck();
    expect(health.status).toBe('unavailable');
  });
});
