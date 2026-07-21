import { createHash } from 'node:crypto';
import {
  AdapterError,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type AdapterOperationContext,
  type DecisionExtractionContext,
  type DecisionProcessorAdapter,
  type DecisionSet,
  type EvidenceSpan,
  type ExtractedSignal,
  type JsonObject,
  type MeetingContentBlock,
  type MeetingDocument,
} from '../../../core/index.js';
import { AnthropicClient } from './anthropic-client.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  LLM_PROVIDER_IDS,
  MAX_LLM_REQUEST_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  type LlmCredentialResolver,
  type LlmProviderClient,
  type LlmProviderId,
} from './llm-provider.js';
import { OllamaClient, DEFAULT_OLLAMA_BASE_URL } from './ollama-client.js';
import { OpenAiClient } from './openai-client.js';
import { OpenRouterClient } from './openrouter-client.js';

export const LLM_DECISION_PROCESSOR_ADAPTER_ID = 'llm';
export const LLM_DECISION_PROCESSOR_ADAPTER_VERSION = '1.1.0';
/** Bump with the adapter version whenever prompt/output semantics change. */
export const LLM_DECISION_PROCESSOR_PROMPT_VERSION = 'decision-extraction-v2';
export const LLM_DECISION_PROCESSOR_SCHEMA_VERSION =
  'decision-extraction-schema-v2';

const DEFAULT_PROVIDER: LlmProviderId = 'ollama';

/** JSON schema handed to the provider as a structured-output constraint. */
const EXTRACTION_FORMAT: JsonObject = {
  type: 'object',
  required: ['signals'],
  additionalProperties: false,
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'kind',
          'text',
          'status',
          'owner',
          'due_at',
          'confidence',
          'evidence_quote',
          'supports_decision_indexes',
        ],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['decision', 'action', 'rationale'] },
          text: { type: 'string' },
          status: {
            type: 'string',
            enum: ['proposed', 'decided', 'unresolved'],
          },
          owner: { type: ['string', 'null'] },
          due_at: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          evidence_quote: { type: 'string' },
          supports_decision_indexes: {
            type: 'array',
            items: { type: 'integer' },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You extract decisions, action items, and rationales from a meeting record.',
  'Rules:',
  '- Only report signals the meeting text explicitly supports; never invent content.',
  '- evidence_quote MUST be copied verbatim, character for character, from the meeting text.',
  '- A decision is a choice the participants made or proposed (status: proposed | decided | unresolved).',
  '- An action is a follow-up task; set owner to the participant name if stated, else null.',
  '- A rationale explains why a decision was made; reference the decisions it supports by their',
  '  zero-based index within your own signals array via supports_decision_indexes.',
  '- Set confidence between 0 and 1 for every signal.',
  '- Return every schema field for every signal. Use null for an inapplicable owner or due_at,',
  '  unresolved for an inapplicable status, and [] for inapplicable supports_decision_indexes.',
  '- If the meeting contains no decisions, actions, or rationales, return {"signals": []}.',
].join('\n');

interface RawSignal {
  index: number;
  kind: 'decision' | 'action' | 'rationale';
  text: string;
  status: 'proposed' | 'decided' | 'unresolved';
  owner: string | null;
  dueAt: string | null;
  confidence: number | null;
  quote: string;
  supports: readonly number[];
}

function assertNotCancelled(
  signal: AbortSignal | undefined,
  operation: string,
): void {
  if (signal?.aborted === true) {
    throw new AdapterError('timeout', `LLM ${operation} was cancelled`, true);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function renderMeeting(meeting: MeetingDocument): string {
  const lines: string[] = [];
  if (isNonEmptyString(meeting.title)) lines.push(`Title: ${meeting.title}`);
  const participants = meeting.participants
    .map((participant) => participant.display_name ?? participant.id)
    .filter(isNonEmptyString);
  if (participants.length > 0)
    lines.push(`Participants: ${participants.join(', ')}`);
  for (const block of meeting.content) {
    if (!isNonEmptyString(block.text)) continue;
    lines.push('');
    lines.push(`[${block.kind}]`);
    lines.push(block.text);
  }
  return lines.join('\n');
}

function normalizedConfidence(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function normalizedDueAt(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rawSignals(content: string): RawSignal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AdapterError(
      'temporarily_unavailable',
      'LLM output was not valid JSON',
      true,
    );
  }
  const items =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { signals?: unknown }).signals)
      ? (parsed as { signals: unknown[] }).signals
      : null;
  if (items === null) {
    throw new AdapterError(
      'temporarily_unavailable',
      'LLM output did not match the extraction schema',
      true,
    );
  }
  const signals: RawSignal[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const kind = record['kind'];
    if (kind !== 'decision' && kind !== 'action' && kind !== 'rationale')
      continue;
    if (
      !isNonEmptyString(record['text']) ||
      !isNonEmptyString(record['evidence_quote'])
    ) {
      continue;
    }
    const status = record['status'];
    const supports = Array.isArray(record['supports_decision_indexes'])
      ? record['supports_decision_indexes'].filter((value): value is number =>
          Number.isInteger(value),
        )
      : [];
    signals.push({
      index,
      kind,
      text: record['text'].trim(),
      status:
        status === 'proposed' || status === 'decided' || status === 'unresolved'
          ? status
          : 'unresolved',
      owner: isNonEmptyString(record['owner']) ? record['owner'].trim() : null,
      dueAt: normalizedDueAt(record['due_at']),
      confidence: normalizedConfidence(record['confidence']),
      quote: record['evidence_quote'],
      supports,
    });
  }
  return signals;
}

/** A signal survives only when its quote appears verbatim in the meeting. */
function evidenceBlockFor(
  meeting: MeetingDocument,
  quote: string,
): MeetingContentBlock | null {
  for (const block of meeting.content) {
    if (isNonEmptyString(block.text) && block.text.includes(quote))
      return block;
  }
  return null;
}

function stableSignalId(meeting: MeetingDocument, raw: RawSignal): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
        meeting.id,
        meeting.provenance.canonical_revision,
        raw.kind,
        raw.text,
        raw.quote,
      ]),
    )
    .digest('hex');
  return `${raw.kind}:sha256:${digest}`;
}

export function configuredLlmProvider(config: AdapterConfig): LlmProviderId {
  const provider = config.settings['provider'];
  return typeof provider === 'string' &&
    LLM_PROVIDER_IDS.includes(provider as LlmProviderId)
    ? (provider as LlmProviderId)
    : DEFAULT_PROVIDER;
}

function configuredRequestTimeout(config: AdapterConfig): number | undefined {
  const timeout = config.settings['request_timeout_ms'];
  return typeof timeout === 'number' ? timeout : undefined;
}

function configuredMaxOutputTokens(config: AdapterConfig): number {
  const value = config.settings['max_output_tokens'];
  return typeof value === 'number' ? value : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Runtime processing identity. Provider/model changes must not reuse cached
 * decision sets or approvals even though all providers share adapter_id=llm.
 */
export function llmProcessingVersion(config: AdapterConfig): string {
  const provider = configuredLlmProvider(config);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
        LLM_DECISION_PROCESSOR_PROMPT_VERSION,
        LLM_DECISION_PROCESSOR_SCHEMA_VERSION,
        provider,
        config.settings['model'] ?? null,
        configuredMaxOutputTokens(config),
        provider === 'ollama'
          ? (config.settings['base_url'] ?? DEFAULT_OLLAMA_BASE_URL)
          : null,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return `${LLM_DECISION_PROCESSOR_ADAPTER_VERSION}+processing.${digest}`;
}

function createProviderClient(
  config: AdapterConfig,
  options: LlmDecisionProcessorOptions,
): LlmProviderClient {
  const provider = configuredLlmProvider(config);
  const requestTimeoutMs = configuredRequestTimeout(config);
  const fetchImpl = options.fetchImpl;
  if (provider === 'ollama') {
    return new OllamaClient({
      ...(typeof config.settings['base_url'] === 'string'
        ? { baseUrl: config.settings['base_url'] }
        : {}),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  const hostedOptions = {
    credentialRef: config.credential_ref ?? '',
    credentialResolver: options.credentialResolver ?? (() => undefined),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
  switch (provider) {
    case 'openai':
      return new OpenAiClient(hostedOptions);
    case 'anthropic':
      return new AnthropicClient(hostedOptions);
    case 'openrouter':
      return new OpenRouterClient(hostedOptions);
  }
}

export interface LlmDecisionProcessorOptions {
  client?: LlmProviderClient;
  credentialResolver?: LlmCredentialResolver;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export class LlmDecisionProcessor implements DecisionProcessorAdapter {
  readonly identity: DecisionProcessorAdapter['identity'];
  private readonly client: LlmProviderClient;
  private readonly now: () => string;

  constructor(
    private readonly config: AdapterConfig,
    options: LlmDecisionProcessorOptions = {},
  ) {
    this.identity = Object.freeze({
      kind: 'decision-processor' as const,
      adapter_id: LLM_DECISION_PROCESSOR_ADAPTER_ID,
      instance_id: config.instance_id,
      version: llmProcessingVersion(config),
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.client = options.client ?? createProviderClient(config, options);
  }

  private get model(): string {
    const model = this.config.settings['model'];
    return typeof model === 'string' ? model : '';
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const errors: string[] = [];
    if (config.adapter_id !== LLM_DECISION_PROCESSOR_ADAPTER_ID) {
      errors.push(`adapter_id must be '${LLM_DECISION_PROCESSOR_ADAPTER_ID}'`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(config.instance_id)) {
      errors.push(
        'instance_id must use lowercase letters, numbers, and hyphens',
      );
    } else if (config.instance_id !== this.identity.instance_id) {
      errors.push('instance_id does not match the registered adapter instance');
    }
    const allowedSettings = new Set([
      'provider',
      'model',
      'base_url',
      'request_timeout_ms',
      'max_output_tokens',
    ]);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    if (!isNonEmptyString(config.settings['model'])) {
      errors.push('settings.model is required');
    }
    const configuredProvider = config.settings['provider'];
    if (
      configuredProvider !== undefined &&
      (!isNonEmptyString(configuredProvider) ||
        !LLM_PROVIDER_IDS.includes(configuredProvider as LlmProviderId))
    ) {
      errors.push(
        `settings.provider must be one of ${LLM_PROVIDER_IDS.join(', ')}`,
      );
    }
    const provider = configuredLlmProvider(config);
    if (provider === 'ollama' && config.credential_ref !== undefined) {
      errors.push('credential_ref is not supported by the Ollama provider');
    }
    if (provider !== 'ollama' && !isNonEmptyString(config.credential_ref)) {
      errors.push(`credential_ref is required by the ${provider} provider`);
    }
    const baseUrl = config.settings['base_url'];
    if (provider !== 'ollama' && baseUrl !== undefined) {
      errors.push('settings.base_url is supported only by the Ollama provider');
    } else if (baseUrl !== undefined) {
      try {
        const url = new URL(String(baseUrl));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          errors.push('settings.base_url must be an HTTP(S) URL');
        }
      } catch {
        errors.push('settings.base_url must be an HTTP(S) URL');
      }
    }
    const timeout = config.settings['request_timeout_ms'];
    if (
      timeout !== undefined &&
      !(
        Number.isInteger(timeout) &&
        typeof timeout === 'number' &&
        timeout > 0 &&
        timeout <= MAX_LLM_REQUEST_TIMEOUT_MS
      )
    ) {
      errors.push(
        `settings.request_timeout_ms must be an integer from 1 to ${MAX_LLM_REQUEST_TIMEOUT_MS}`,
      );
    }
    const maxOutputTokens = config.settings['max_output_tokens'];
    if (
      maxOutputTokens !== undefined &&
      !(
        Number.isInteger(maxOutputTokens) &&
        typeof maxOutputTokens === 'number' &&
        maxOutputTokens > 0 &&
        maxOutputTokens <= MAX_OUTPUT_TOKENS
      )
    ) {
      errors.push(
        `settings.max_output_tokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`,
      );
    }
    if (
      provider === 'openrouter' &&
      isNonEmptyString(config.settings['model']) &&
      !/^[^/\s]+\/[^/\s]+$/u.test(config.settings['model'])
    ) {
      errors.push(
        'settings.model must use the author/model-slug form for OpenRouter',
      );
    }
    return { ok: errors.length === 0, errors };
  }

  async healthCheck(
    operation?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    assertNotCancelled(operation?.signal, 'health check');
    const checkedAt = this.now();
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: 'LLM processor configuration is invalid',
        details: { error_count: validation.errors.length },
      };
    }
    try {
      await this.client.verifyModel(this.model, operation?.signal);
    } catch (error) {
      return {
        status:
          error instanceof AdapterError && error.code === 'unauthorized'
            ? 'unauthorized'
            : 'unavailable',
        checked_at: checkedAt,
        message:
          error instanceof AdapterError
            ? error.message
            : `${this.client.provider} provider health check failed`,
        details: { provider: this.client.provider, model: this.model },
      };
    }
    return {
      status: 'healthy',
      checked_at: checkedAt,
      details: { provider: this.client.provider, model: this.model },
    };
  }

  async extract(
    meeting: MeetingDocument,
    context: DecisionExtractionContext,
    operation?: AdapterOperationContext,
  ): Promise<DecisionSet> {
    assertNotCancelled(operation?.signal, 'extraction');
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      throw new AdapterError(
        'invalid_config',
        'LLM processor configuration is invalid',
        false,
      );
    }
    if (
      context.processor_version !== this.identity.version ||
      context.input_fingerprint.trim().length === 0
    ) {
      throw new AdapterError(
        'invalid_config',
        'decision extraction context is invalid',
        false,
      );
    }
    const response = await this.client.generateStructured({
      model: this.model,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: renderMeeting(meeting),
      schema: EXTRACTION_FORMAT,
      maxOutputTokens: configuredMaxOutputTokens(this.config),
      ...(operation?.signal === undefined ? {} : { signal: operation.signal }),
    });
    assertNotCancelled(operation?.signal, 'extraction');

    // Anti-hallucination gate: a signal survives only with verbatim evidence.
    const verified: { raw: RawSignal; id: string; evidence: EvidenceSpan }[] =
      [];
    for (const raw of rawSignals(response.content)) {
      const block = evidenceBlockFor(meeting, raw.quote);
      if (block === null) continue;
      verified.push({
        raw,
        id: stableSignalId(meeting, raw),
        evidence: {
          meeting_id: meeting.id,
          block_id: block.id,
          quote: raw.quote,
          ...(block.started_at === undefined
            ? {}
            : { started_at: block.started_at }),
          ...(block.ended_at === undefined ? {} : { ended_at: block.ended_at }),
        },
      });
    }
    const decisionIdsByRawIndex = new Map(
      verified
        .filter((entry) => entry.raw.kind === 'decision')
        .map((entry) => [entry.raw.index, entry.id]),
    );
    const signals: ExtractedSignal[] = verified.map(({ raw, id, evidence }) => {
      const base = {
        id,
        text: raw.text,
        subject: null,
        confidence: raw.confidence,
        evidence: [evidence],
      };
      switch (raw.kind) {
        case 'decision':
          return { ...base, kind: 'decision' as const, status: raw.status };
        case 'action':
          return {
            ...base,
            kind: 'action' as const,
            owner: raw.owner,
            due_at: raw.dueAt,
          };
        case 'rationale':
          return {
            ...base,
            kind: 'rationale' as const,
            supports_signal_ids: raw.supports
              .map((index) => decisionIdsByRawIndex.get(index))
              .filter((value): value is string => value !== undefined),
          };
      }
    });
    return {
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: this.identity,
      generated_at: this.now(),
      signals,
    };
  }
}

export function createLlmDecisionProcessor(
  config: AdapterConfig,
  options: LlmDecisionProcessorOptions = {},
): LlmDecisionProcessor {
  return new LlmDecisionProcessor(config, options);
}
