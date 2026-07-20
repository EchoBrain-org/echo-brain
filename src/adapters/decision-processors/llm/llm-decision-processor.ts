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

export const LLM_DECISION_PROCESSOR_ADAPTER_ID = 'llm';
export const LLM_DECISION_PROCESSOR_ADAPTER_VERSION = '1.0.0';
/** Bump with the adapter version whenever prompt/output semantics change. */
export const LLM_DECISION_PROCESSOR_PROMPT_VERSION = 'decision-extraction-v1';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;

export interface LlmChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmChatRequest {
  model: string;
  messages: readonly LlmChatMessage[];
  format: JsonObject;
  signal?: AbortSignal;
}

export interface LlmChatResponse {
  content: string;
}

/**
 * Transport port between the llm decision processor and a model provider.
 * The processor owns prompting, parsing, and evidence verification; a client
 * only moves messages. Ollama is the first implementation.
 */
export interface LlmClient {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
}

export interface OllamaClientOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function taxonomyErrorForStatus(status: number, body: string): AdapterError {
  if (status === 401 || status === 403) {
    return new AdapterError(
      'unauthorized',
      'Ollama rejected the request as unauthorized',
      false,
    );
  }
  if (status === 429) {
    return new AdapterError(
      'rate_limited',
      'Ollama rate limited the request',
      true,
    );
  }
  if (status >= 500) {
    return new AdapterError(
      'temporarily_unavailable',
      `Ollama responded with status ${status}`,
      true,
    );
  }
  return new AdapterError(
    'permanently_rejected',
    `Ollama rejected the request with status ${status}: ${body.slice(0, 200)}`,
    false,
  );
}

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const signals = [AbortSignal.timeout(this.requestTimeoutMs)];
    if (signal !== undefined) signals.push(signal);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new AdapterError('timeout', 'Ollama request timed out', true);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AdapterError('timeout', 'Ollama request was cancelled', true);
      }
      throw new AdapterError(
        'temporarily_unavailable',
        'Ollama is unreachable; is the local daemon running?',
        true,
      );
    }
    if (!response.ok) {
      throw taxonomyErrorForStatus(response.status, await response.text());
    }
    try {
      return await response.json();
    } catch {
      throw new AdapterError(
        'temporarily_unavailable',
        'Ollama returned a non-JSON response body',
        true,
      );
    }
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const payload = await this.request(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          format: request.format,
          options: { temperature: 0, num_ctx: 32_768 },
        }),
      },
      request.signal,
    );
    const content =
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { message?: { content?: unknown } }).message
        ?.content === 'string'
        ? (payload as { message: { content: string } }).message.content
        : null;
    if (content === null) {
      throw new AdapterError(
        'temporarily_unavailable',
        'Ollama chat response did not contain message content',
        true,
      );
    }
    return { content };
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    const payload = await this.request('/api/tags', { method: 'GET' }, signal);
    const models =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
    return models
      .map((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : null,
      )
      .filter((name): name is string => name !== null);
  }
}

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
        required: ['kind', 'text', 'evidence_quote'],
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

export interface LlmDecisionProcessorOptions {
  client?: LlmClient;
  now?: () => string;
}

export class LlmDecisionProcessor implements DecisionProcessorAdapter {
  readonly identity: DecisionProcessorAdapter['identity'];
  private readonly client: LlmClient;
  private readonly now: () => string;

  constructor(
    private readonly config: AdapterConfig,
    options: LlmDecisionProcessorOptions = {},
  ) {
    this.identity = Object.freeze({
      kind: 'decision-processor' as const,
      adapter_id: LLM_DECISION_PROCESSOR_ADAPTER_ID,
      instance_id: config.instance_id,
      version: LLM_DECISION_PROCESSOR_ADAPTER_VERSION,
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.client =
      options.client ??
      new OllamaClient({
        ...(typeof config.settings['base_url'] === 'string'
          ? { baseUrl: config.settings['base_url'] }
          : {}),
        ...(typeof config.settings['request_timeout_ms'] === 'number'
          ? { requestTimeoutMs: config.settings['request_timeout_ms'] }
          : {}),
      });
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
    if (config.credential_ref !== undefined) {
      errors.push(
        'credential_ref is not supported by the local Ollama provider',
      );
    }
    const allowedSettings = new Set([
      'model',
      'base_url',
      'request_timeout_ms',
    ]);
    for (const key of Object.keys(config.settings)) {
      if (!allowedSettings.has(key))
        errors.push(`settings.${key} is not supported`);
    }
    if (!isNonEmptyString(config.settings['model'])) {
      errors.push('settings.model is required');
    }
    const baseUrl = config.settings['base_url'];
    if (baseUrl !== undefined) {
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
        timeout <= MAX_REQUEST_TIMEOUT_MS
      )
    ) {
      errors.push(
        `settings.request_timeout_ms must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
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
    let models: readonly string[];
    try {
      models = await this.client.listModels(operation?.signal);
    } catch (error) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message:
          error instanceof AdapterError
            ? error.message
            : 'LLM provider is unreachable',
      };
    }
    if (!models.includes(this.model)) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: `Model '${this.model}' is not installed on the provider`,
      };
    }
    return { status: 'healthy', checked_at: checkedAt };
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
    const response = await this.client.chat({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderMeeting(meeting) },
      ],
      format: EXTRACTION_FORMAT,
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
