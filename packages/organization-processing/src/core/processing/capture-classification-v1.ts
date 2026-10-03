import type { ContextCaptureContentV2, ContextCaptureEnvelopeV2 } from '../contracts/context-capture-v2.js';
import {
  assertCaptureClassificationV1, captureRevisionRefV1,
  type CaptureClassificationV1, type CaptureProcessorV1,
} from '../contracts/context-derivation-v1.js';

/**
 * A pure, synchronous local rule over present content, such as a payload-kind skip rule.
 * Rules may skip or defer an item. Without a matching rule, valid content is retained.
 */
export type CaptureLocalRuleV1 = (content: Extract<ContextCaptureContentV2, { lifecycle: 'present' }>) =>
  | { readonly decision: 'skip'; readonly reason: 'noise' | 'unsupported' }
  | { readonly decision: 'unresolved'; readonly reason: 'needs_review' }
  | undefined;
/** A named, versioned local rule set. A source configuration selects one by id and version. */
export interface CaptureLocalClassifierV1 {
  readonly id: string;
  readonly version: string;
  readonly rules: readonly CaptureLocalRuleV1[];
}
/** Retains every valid present capture and every explicit tombstone. No skip rules yet. */
export const CAPTURE_DEFAULT_CLASSIFIER_V1: CaptureLocalClassifierV1 = Object.freeze({
  id: 'echo-capture-local-rules', version: '1', rules: Object.freeze([]),
});

/** No provider, network or model call. The first matching rule decides. */
export function classifyCaptureV1(input: {
  readonly source: ContextCaptureEnvelopeV2;
  readonly producer: CaptureProcessorV1;
  readonly rules: readonly CaptureLocalRuleV1[];
}): CaptureClassificationV1 {
  const content = input.source.content;
  let outcome: Pick<CaptureClassificationV1, 'decision' | 'reason'> | undefined;
  // A tombstone is always retained so the deletion is recorded against its predecessor.
  if (content.lifecycle === 'deleted') outcome = { decision: 'retain', reason: 'source_deleted' };
  else for (const rule of input.rules) { outcome = rule(content); if (outcome !== undefined) break; }
  if ((outcome as unknown) instanceof Promise) {
    void (outcome as unknown as Promise<unknown>).catch(() => undefined);
    throw new Error('Capture local rules must answer synchronously');
  }
  const { decision, reason } = outcome ?? { decision: 'retain', reason: 'useful' };
  const classification: CaptureClassificationV1 = Object.freeze({
    schema_version: 1, method: 'local_rules', input: Object.freeze(captureRevisionRefV1(input.source)),
    producer: Object.freeze({ id: input.producer.id, version: input.producer.version, config_sha256: input.producer.config_sha256 }), decision, reason,
  });
  // A rule answer outside the contract fails here, before any storage.
  assertCaptureClassificationV1(classification, input.source);
  return classification;
}
