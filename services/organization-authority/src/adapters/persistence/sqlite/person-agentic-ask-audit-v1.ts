import { canonicalJson, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import type { AgenticAskAuditEntryV1, AgenticAskAuditPortV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";

export interface AgenticAskAuditRequestContextV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly session_family_id: string;
  readonly request_id: string;
}

/**
 * The V3 terminal witness reuses the immutable read-decision table.  Its body
 * is deliberately content-free: question, evidence, and prose remain hashes
 * or release receipts only.
 */
export class SqlitePersonAgenticAskAuditV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  forRequest(context: AgenticAskAuditRequestContextV1): AgenticAskAuditPortV1 {
    if (![context.authority_id, context.organization_id, context.state_lineage_id, context.principal_id, context.membership_id, context.session_family_id, context.request_id]
      .every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)) throw new Error("Agentic Ask audit context is invalid");
    const boundContext = Object.freeze({
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      state_lineage_id: context.state_lineage_id,
      principal_id: context.principal_id,
      membership_id: context.membership_id,
      session_family_id: context.session_family_id,
      request_id: context.request_id,
    });
    return Object.freeze({ append: (entry: AgenticAskAuditEntryV1) => this.appendBound(boundContext, entry) });
  }

  private appendBound(context: AgenticAskAuditRequestContextV1, entry: AgenticAskAuditEntryV1): Sha256Digest {
    if (
      entry.kind !== "echo-agentic-ask-audit-v1" ||
      !["answered", "partial", "not_found", "off_scope", "cancelled", "timed_out"].includes(entry.outcome) ||
      !Array.isArray(entry.receipt_digests) || entry.receipt_digests.length > 128 ||
      new Set(entry.receipt_digests).size !== entry.receipt_digests.length ||
      !entry.receipt_digests.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)) ||
      ![entry.rounds, entry.model_calls, entry.repairs, entry.fallbacks, entry.citation_count]
        .every((value) => Number.isSafeInteger(value) && value >= 0) ||
      entry.rounds > 6 || entry.model_calls > 12 || entry.repairs > 12 || entry.fallbacks > 16 || entry.citation_count > 40 ||
      (entry.checked_at !== null && new Date(entry.checked_at).toISOString() !== entry.checked_at) ||
      ![entry.prompt_sha256, entry.answer_sha256, entry.response_sha256]
        .every((digest) => digest === null || /^sha256:[a-f0-9]{64}$/.test(digest)) ||
      ((entry.outcome === "cancelled" || entry.outcome === "timed_out") && (entry.prompt_sha256 !== null || entry.answer_sha256 !== null || entry.response_sha256 !== null)) ||
      !Array.isArray(entry.generations) || entry.generations.length !== entry.model_calls ||
      entry.generations.some((generation) => !["step", "answer"].includes(generation.role) ||
        (generation.finish_reason !== null && (typeof generation.finish_reason !== "string" || generation.finish_reason.length > 128)) ||
        (generation.usage !== null && ![generation.usage.input_tokens, generation.usage.output_tokens, generation.usage.total_tokens]
          .every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)))) ||
      ![entry.generation_usage.input_tokens, entry.generation_usage.output_tokens, entry.generation_usage.total_tokens]
        .every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)) ||
      Object.entries(entry.finish_reason_counts).some(([reason, count]) => reason.length === 0 || reason.length > 128 || !Number.isSafeInteger(count) || count < 1 || count > entry.model_calls)
    ) throw new Error("Agentic Ask audit entry is invalid");

    const recorded_at = entry.checked_at ?? this.now();
    if (new Date(recorded_at).toISOString() !== recorded_at) throw new Error("Agentic Ask audit timestamp is invalid");
    // The shared immutable table requires non-null composition hashes. A
    // request cancelled by its caller or stopped at its deadline has no output
    // payload. Distinct fixed sentinels retain that terminal cause.
    const sentinelKind = entry.outcome === "timed_out" ? "echo-agentic-ask-timed-out-v1" : "echo-agentic-ask-cancelled-v1";
    const prompt_sha256 = entry.prompt_sha256 ?? canonicalSha256({ kind: sentinelKind, field: "prompt" });
    const answer_sha256 = entry.answer_sha256 ?? canonicalSha256({ kind: sentinelKind, field: "answer" });
    const response_sha256 = entry.response_sha256 ?? canonicalSha256({ kind: sentinelKind, field: "response" });
    const body = Object.freeze({
      schema_version: 1,
      kind: "echo-person-agentic-ask-audit-v1",
      context_kind: "answer_composition",
      ...context,
      outcome: entry.outcome,
      receipt_digests: entry.receipt_digests,
      rounds: entry.rounds,
      model_calls: entry.model_calls,
      repairs: entry.repairs,
      fallbacks: entry.fallbacks,
      citation_count: entry.citation_count,
      checked_at: entry.checked_at,
      prompt_sha256,
      answer_sha256,
      response_sha256,
      generations: entry.generations,
      generation_usage: entry.generation_usage,
      finish_reason_counts: entry.finish_reason_counts,
    });
    const row_sha256 = canonicalSha256(body);
    this.database.prepare(
      `INSERT INTO authority_person_read_decision_audit_v2
       (row_sha256, body_json, context_kind, prompt_sha256, answer_sha256, recorded_at)
       VALUES (?, ?, 'answer_composition', ?, ?, ?)`,
    ).run(row_sha256, canonicalJson(body), prompt_sha256, answer_sha256, recorded_at);
    return row_sha256;
  }
}
