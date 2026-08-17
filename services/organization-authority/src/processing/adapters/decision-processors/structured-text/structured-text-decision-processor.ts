import { createHash } from 'node:crypto';
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  DecisionExtractionContext,
  DecisionProcessorAdapter,
  DecisionSet,
  EvidenceSpan,
  ExtractedSignal,
  MeetingContentBlock,
  MeetingDocument,
} from '../../../core/index.js';
import { AdapterError } from '../../../core/index.js';

export const STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID = 'structured-text';
export const STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_VERSION = '1.0.0';

export interface StructuredTextDecisionProcessorOptions {
  now?: () => string;
}

type SupportedLabel = 'decision' | 'action' | 'rationale';

interface LabeledLine {
  kind: SupportedLabel;
  text: string;
  quote: string;
  lineIndex: number;
}

const LABELED_LINE = /^\s*(Decision|Action|Rationale):\s*(\S(?:.*\S)?)\s*$/i;

function normalizedTimestamp(value: string): string | null {
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function assertNotCancelled(
  signal: AbortSignal | undefined,
  operation: string,
): void {
  if (signal?.aborted === true) {
    throw new AdapterError(
      'timeout',
      `Structured-text ${operation} was cancelled`,
      true,
    );
  }
}

function labeledLines(block: MeetingContentBlock): LabeledLine[] {
  const matches: LabeledLine[] = [];
  for (const [lineIndex, line] of block.text.split(/\r?\n/).entries()) {
    const match = LABELED_LINE.exec(line);
    if (match === null) continue;
    matches.push({
      kind: match[1]!.toLowerCase() as SupportedLabel,
      text: match[2]!,
      quote: line.trim(),
      lineIndex,
    });
  }
  return matches;
}

function evidenceFor(
  meeting: MeetingDocument,
  block: MeetingContentBlock,
  quote: string,
): EvidenceSpan {
  return {
    meeting_id: meeting.id,
    block_id: block.id,
    quote,
    ...(block.started_at === undefined ? {} : { started_at: block.started_at }),
    ...(block.ended_at === undefined ? {} : { ended_at: block.ended_at }),
  };
}

function stableSignalId(
  meeting: MeetingDocument,
  block: MeetingContentBlock,
  line: LabeledLine,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_VERSION,
        meeting.id,
        meeting.provenance.canonical_revision,
        block.id,
        line.lineIndex,
        line.kind,
        line.text,
      ]),
    )
    .digest('hex');
  return `${line.kind}:sha256:${digest}`;
}

function signalFor(
  meeting: MeetingDocument,
  block: MeetingContentBlock,
  line: LabeledLine,
): ExtractedSignal {
  const base = {
    id: stableSignalId(meeting, block, line),
    text: line.text,
    subject: null,
    confidence: null,
    evidence: [evidenceFor(meeting, block, line.quote)],
  };
  switch (line.kind) {
    case 'decision':
      return { ...base, kind: 'decision', status: 'decided' };
    case 'action':
      return { ...base, kind: 'action', owner: null, due_at: null };
    case 'rationale':
      // A label proves that this is rationale text, but not which decision it
      // supports. Linking it would be semantic inference, so the baseline
      // adapter intentionally leaves the relationship unresolved.
      return { ...base, kind: 'rationale', supports_signal_ids: [] };
  }
}

export class StructuredTextDecisionProcessor implements DecisionProcessorAdapter {
  readonly identity: DecisionProcessorAdapter['identity'];
  private readonly now: () => string;

  constructor(
    private readonly config: AdapterConfig,
    options: StructuredTextDecisionProcessorOptions = {},
  ) {
    this.identity = Object.freeze({
      kind: 'decision-processor' as const,
      adapter_id: STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID,
      instance_id: config.instance_id,
      version: STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_VERSION,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const errors: string[] = [];
    if (config.adapter_id !== STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID) {
      errors.push(`adapter_id must be '${STRUCTURED_TEXT_DECISION_PROCESSOR_ADAPTER_ID}'`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(config.instance_id)) {
      errors.push('instance_id must use lowercase letters, numbers, and hyphens');
    } else if (config.instance_id !== this.identity.instance_id) {
      errors.push('instance_id does not match the registered adapter instance');
    }
    if (config.credential_ref !== undefined) {
      errors.push('credential_ref is not supported by this local adapter');
    }
    for (const key of Object.keys(config.settings)) {
      errors.push(`settings.${key} is not supported`);
    }
    return { ok: errors.length === 0, errors };
  }

  async healthCheck(
    operation?: AdapterOperationContext,
  ): Promise<AdapterHealth> {
    assertNotCancelled(operation?.signal, 'health check');
    const validation = this.validateConfig(this.config);
    const timestamp = normalizedTimestamp(this.now());
    const checkedAt = timestamp ?? new Date().toISOString();
    if (!validation.ok) {
      return {
        status: 'unavailable',
        checked_at: checkedAt,
        message: 'Structured-text processor configuration is invalid',
        details: { error_count: validation.errors.length },
      };
    }
    if (timestamp === null) {
      return {
        status: 'degraded',
        checked_at: checkedAt,
        message: 'Structured-text processor clock is invalid',
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
        'Structured-text processor configuration is invalid',
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
    const generatedAt = normalizedTimestamp(this.now());
    if (generatedAt === null) {
      throw new AdapterError(
        'temporarily_unavailable',
        'Structured-text processor clock is invalid',
        true,
      );
    }

    const signals: ExtractedSignal[] = [];
    for (const [index, block] of meeting.content.entries()) {
      assertNotCancelled(operation?.signal, 'extraction');
      if (index > 0 && index % 100 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assertNotCancelled(operation?.signal, 'extraction');
      }
      for (const line of labeledLines(block)) {
        signals.push(signalFor(meeting, block, line));
      }
    }
    return {
      schema_version: 1,
      meeting_id: meeting.id,
      meeting_revision: meeting.provenance.canonical_revision,
      processor: this.identity,
      generated_at: generatedAt,
      signals,
    };
  }
}

export function createStructuredTextDecisionProcessor(
  config: AdapterConfig,
  options: StructuredTextDecisionProcessorOptions = {},
): StructuredTextDecisionProcessor {
  return new StructuredTextDecisionProcessor(config, options);
}
