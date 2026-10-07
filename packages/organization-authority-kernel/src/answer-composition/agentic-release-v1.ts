import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type { PersonAnswerResponseV4 } from "@echo-brain/organization-api";
import type { StructuredGenerationUsageV1 } from "./structured-generation-v1.js";
import { raceAbort, type AgenticAskGenerationObservationV1, type AgenticModelGateStatsV1 } from "./agentic-model-gate-v1.js";

/**
 * The shared release step (research trigger contract v1, section 4): every
 * trigger's result leaves a request here, in this order. A final access
 * check, one content-free audit record for the whole request, a second access
 * check after the audit write, then hand over. On timeout or cancel the
 * request writes a terminal witness instead and releases nothing.
 */

/** Content-free terminal witness. Route adapters bind identity and storage details. */
export interface AgenticAskAuditEntryV1 {
  readonly kind: "echo-agentic-ask-audit-v1";
  /** A research-only trigger definition's name; an Ask audit omits it. */
  readonly trigger?: string;
  /** Present only when the request ran beyond the live budget (research evaluation). */
  readonly budget?: "background";
  readonly outcome: PersonAnswerResponseV4["outcome"] | "cancelled" | "timed_out";
  readonly receipt_digests: readonly Sha256Digest[];
  /** Research steps run. */
  readonly rounds: number;
  readonly model_calls: number;
  readonly repairs: number;
  readonly fallbacks: number;
  readonly citation_count: number;
  readonly checked_at: string | null;
  /** Hashes bind terminal output without retaining question, evidence, or prose. */
  readonly prompt_sha256: Sha256Digest | null;
  readonly answer_sha256: Sha256Digest | null;
  readonly response_sha256: Sha256Digest | null;
  /** Provider metadata only. It deliberately carries no prompt, output, or evidence. */
  readonly generations: readonly AgenticAskGenerationObservationV1[];
  readonly generation_usage: { readonly input_tokens: number | null; readonly output_tokens: number | null; readonly total_tokens: number | null };
  readonly finish_reason_counts: Readonly<Record<string, number>>;
}

export interface AgenticAskAuditPortV1 {
  append(entry: AgenticAskAuditEntryV1): Promise<unknown> | unknown;
}

/** What every audit record of one request carries, read when the record is written. */
export interface AgenticAuditContextV1 {
  readonly audit: AgenticAskAuditPortV1;
  /** The provider binding the prompt fingerprint is bound to. */
  readonly generation_adapter_id: string;
  /** The request's model gate; read when the record is written, after the final check. */
  readonly gate_stats: () => AgenticModelGateStatsV1;
  /** Research-only triggers name themselves; Ask writes no trigger. */
  readonly trigger?: string;
  /** The request ran beyond the live budget. */
  readonly background: boolean;
  /** Receipts of everything released, copied when the record is written. */
  readonly receipts: readonly Sha256Digest[];
  readonly rounds: number;
  readonly fallbacks: number;
}

/** Fingerprints of the released result: its answer and the whole result. */
export interface AgenticReleaseDigestsV1 {
  readonly answer_sha256: Sha256Digest;
  readonly response_sha256: Sha256Digest;
}

export interface ReleaseAgenticResultV1Options<R> extends AgenticAuditContextV1 {
  /** The request's access-checked desk; only its cumulative revalidation is used. */
  readonly desk: { revalidate(input: { readonly signal: AbortSignal }): Promise<{ readonly checked_at: string }> };
  readonly outcome: PersonAnswerResponseV4["outcome"];
  readonly citation_count: number;
  /** What is handed over once every check has passed. */
  readonly result: R;
  /** The result's fingerprints, from its renderer. */
  readonly digests: AgenticReleaseDigestsV1;
  /** A second access check after the audit write (V5/V6 Ask and every task brief; V4 Ask has none). */
  readonly fence_after_audit: boolean;
  /** The request's active signal (caller cancel, deadline or terminal stop). */
  readonly signal: AbortSignal;
  /** Throws when the caller cancelled or the request deadline passed. */
  readonly assert_live: () => void;
  /** Receives each access check's time; the audit binds the final check's. */
  readonly on_checked: (checked_at: string) => void;
  /** The audit record is durable; the request must not write a terminal witness after this. */
  readonly on_audited: () => void;
  readonly now: () => number;
  /** Content-free timings of the final check and the audit write. */
  readonly on_stage?: (event: { readonly stage: "revalidation" | "audit"; readonly elapsed_ms: number }) => void;
}

function auditEntry(context: AgenticAuditContextV1, outcome: AgenticAskAuditEntryV1["outcome"], citations: number, checkedAt: string | null, digests: AgenticReleaseDigestsV1 | null): AgenticAskAuditEntryV1 {
  const { calls, repairs, generations, invocation_digests: invocationDigests } = context.gate_stats();
  const aggregate = (field: keyof StructuredGenerationUsageV1): number | null => {
    const values = generations.map(entry => entry.usage?.[field]);
    return values.length === 0 || values.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) ? null : values.reduce<number>((total, value) => total + value!, 0);
  };
  const finishReasonCounts: Record<string, number> = {};
  for (const generation of generations) if (generation.finish_reason !== null) finishReasonCounts[generation.finish_reason] = (finishReasonCounts[generation.finish_reason] ?? 0) + 1;
  return Object.freeze({
    kind: "echo-agentic-ask-audit-v1", ...(context.trigger === undefined ? {} : { trigger: context.trigger }),
    ...(context.background ? { budget: "background" as const } : {}),
    outcome, receipt_digests: Object.freeze([...context.receipts]), rounds: context.rounds, model_calls: calls, repairs, fallbacks: context.fallbacks, citation_count: citations, checked_at: checkedAt,
    prompt_sha256: outcome === "cancelled" || outcome === "timed_out" ? null : canonicalSha256({ generation: context.generation_adapter_id, invocations: invocationDigests }),
    answer_sha256: digests?.answer_sha256 ?? null,
    response_sha256: digests?.response_sha256 ?? null,
    generations: Object.freeze([...generations]),
    generation_usage: Object.freeze({ input_tokens: aggregate("input_tokens"), output_tokens: aggregate("output_tokens"), total_tokens: aggregate("total_tokens") }),
    finish_reason_counts: Object.freeze(finishReasonCounts),
  });
}

/** Final check, one audit record, the check after it, then the result. Any failure releases nothing. */
export async function releaseAgenticResultV1<R>(options: ReleaseAgenticResultV1Options<R>): Promise<R> {
  const { desk, signal, assert_live: assertLive } = options;
  const elapsed = (startedAt: number) => options.now() - startedAt;
  // 1. Final access check: the person can still see everything the result cites.
  assertLive();
  const fenceStartedAt = options.on_stage === undefined ? 0 : options.now();
  const fenced = await raceAbort(signal, desk.revalidate({ signal }));
  options.on_checked(fenced.checked_at);
  options.on_stage?.({ stage: "revalidation", elapsed_ms: elapsed(fenceStartedAt) });
  // 2. One content-free audit record for the whole request.
  const auditStartedAt = options.on_stage === undefined ? 0 : options.now();
  await options.audit.append(auditEntry(options, options.outcome, options.citation_count, fenced.checked_at, options.digests));
  options.on_audited();
  options.on_stage?.({ stage: "audit", elapsed_ms: elapsed(auditStartedAt) });
  // 3. A disconnect or membership change during the durable append still
  // suppresses release. Checking liveness first never leaves a desk call
  // started on an already-stopped request.
  if (options.fence_after_audit) {
    assertLive();
    const released = await raceAbort(signal, desk.revalidate({ signal }));
    options.on_checked(released.checked_at);
  }
  // An abort that races the terminal audit still suppresses publication.
  assertLive();
  // 4. Hand over.
  return options.result;
}

/** The witness a request that timed out or was cancelled writes in place of a release. */
export async function auditAgenticTerminalV1(kind: "timed_out" | "cancelled", context: AgenticAuditContextV1 & { readonly checked_at: string | null }): Promise<void> {
  await context.audit.append(auditEntry(context, kind, 0, context.checked_at, null));
}
