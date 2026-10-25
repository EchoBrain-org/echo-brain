import type { PersonLiveEvidenceAuditV1, PersonLiveEvidenceCitationV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { WorkspaceSourceDescriptorV1, WorkspaceSourceIdV1 } from '@echo-brain/organization-authority-kernel/shared/workspace-evidence-v1';
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import { appendAuditRowV1 } from "./audit-row-v1.js";
import { AGENTIC_RESEARCH_BUDGETS_V1, type AgenticAskAuditEntryV1, type AgenticAskAuditPortV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { AGENTIC_TRIGGER_NAMES_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1";
import { PERSON_ASK_PROGRESS_NAMED_MAX_V1, validatePersonWorkspaceCitationV1 } from "@echo-brain/organization-api";

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
 * One release of follow-ups to an Ask (ADR-0040): the operation, and for each
 * follow-up its id and a digest of the fields released. Never a title, name,
 * phrase or decision text.
 */
export interface PersonFollowUpReleaseV1 {
  readonly operation: 'search' | 'list' | 'open';
  readonly items: readonly { readonly item_id: string; readonly released_fields_sha256: Sha256Digest }[];
}
export interface PersonFollowUpReleaseAuditV1 {
  /** Commits the release before its bytes leave Layer 3 and returns its receipt. */
  record(release: PersonFollowUpReleaseV1): Sha256Digest;
}
/**
 * One release of workspace items to an Ask (research tool contract v1): its source and operation, and for each item its
 * kind, its id (a project id, a membership id or a tool id), whether it was released beside the result, and a digest of
 * the fields released. Never a name, title or text.
 */
export interface PersonWorkspaceReleaseV1 {
  readonly source: WorkspaceSourceIdV1;
  readonly operation: 'search' | 'list' | 'open';
  readonly items: readonly { readonly kind: WorkspaceSourceDescriptorV1['kind']; readonly item_id: string; readonly linked: boolean; readonly released_fields_sha256: Sha256Digest }[];
}
export interface PersonWorkspaceReleaseAuditV1 {
  /** Commits the release before its bytes leave Layer 3 and returns its receipt. */
  record(release: PersonWorkspaceReleaseV1): Sha256Digest;
}
const FOLLOW_UP_ITEM_ID = /^itm_[A-Za-z0-9-]{4,60}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATIONS: readonly string[] = ['search', 'list', 'open'];
const WORKSPACE_SOURCES: readonly string[] = ['projects', 'people', 'tools'];
/** Each workspace item kind's id, as its citation names it. */
const WORKSPACE_ID_FIELDS: Readonly<Record<string, string>> = Object.freeze({ project: 'project_id', person: 'membership_id', tool: 'tool_id' });
/** A page of rows and the workspace items released beside them. */
const WORKSPACE_RELEASE_ITEMS_MAX = 200;

/** A workspace item named only by the id its citation would carry, and a digest of what was released. */
function workspaceItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, item_id, linked, released_fields_sha256 } = value as Record<string, unknown>;
  const field = typeof kind === 'string' && Object.hasOwn(WORKSPACE_ID_FIELDS, kind) ? WORKSPACE_ID_FIELDS[kind] : undefined;
  if (field === undefined || typeof item_id !== 'string' || typeof linked !== 'boolean' || typeof released_fields_sha256 !== 'string' || !DIGEST.test(released_fields_sha256)) return false;
  try { validatePersonWorkspaceCitationV1({ kind, [field]: item_id }); return true; } catch { return false; }
}

/**
 * The V3 terminal witness reuses the immutable read-decision table.  Its body
 * is deliberately content-free: question, evidence, and prose remain hashes
 * or release receipts only.
 */
export class SqlitePersonAgenticAskAuditV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  forRequest(context: AgenticAskAuditRequestContextV1): AgenticAskAuditPortV1 {
    const boundContext = this.bind(context);
    return Object.freeze({ append: (entry: AgenticAskAuditEntryV1) => this.appendBound(boundContext, entry) });
  }

  /** A minimized pre-model release witness. The audited reader has already normalized its citations. */
  forLiveRequest<C extends PersonLiveEvidenceCitationV1>(context: AgenticAskAuditRequestContextV1): PersonLiveEvidenceAuditV1<C> {
    const bound = this.bind(context); // Same trusted session/context validation as terminal Ask audits.
    // Research may release the same tickets repeatedly within one clock tick.
    let releaseSequence = 0;
    return Object.freeze<PersonLiveEvidenceAuditV1<C>>({ record: async (release) => {
      if (release.schema_version !== 1 || !['search', 'open', 'list'].includes(release.operation) ||
          release.binding.organization_id !== bound.organization_id || release.binding.principal_id !== bound.principal_id ||
          release.binding.membership_id !== bound.membership_id || release.citations.length > 50 || release.coordinates.length !== release.citations.length || release.value_digests.length !== release.citations.length || !release.value_digests.every(digest => /^sha256:[a-f0-9]{64}$/.test(digest))) throw new Error('Live release audit binding is invalid');
      // Copy an explicit allowlist. Never serialize adapter extras, handles or evidence bodies.
      const binding = release.binding;
      const read_binding = { organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id,
        tool_id: binding.tool_id, external_scope_id: binding.external_scope_id, external_subject_id: binding.external_subject_id, read_grant_sha256: binding.read_grant_sha256 };
      const recorded_at = this.now();
      const prompt_sha256 = canonicalSha256({ kind: 'echo-person-live-evidence-selection-v1', binding: read_binding, operation: release.operation });
      const answer_sha256 = canonicalSha256(release.citations);
      // Citation objects are closed at the adapter boundary. Commit their canonical bytes as digests;
      // tool/tenant plus opaque citation commitments suffice without retaining presentation URLs.
      // A tool container's citation commits to no text (research tool contract v1); its released value digest still does.
      const citations = release.citations.map((citation, index) => ({ kind: citation.kind, released_value_sha256: release.value_digests[index], coordinates: { object_id: release.coordinates[index]!.object_id, ...(release.coordinates[index]!.container_id === undefined ? {} : { container_id: release.coordinates[index]!.container_id }) }, ...(citation.kind === 'tool_container' ? {} : { text_sha256: citation.text_sha256 }), citation_sha256: canonicalSha256(citation) }));
      return this.insert({ schema_version: 1, kind: 'echo-person-live-evidence-release-audit-v1', context_kind: 'answer_composition', ...bound,
        release_sequence: ++releaseSequence, binding: read_binding, operation: release.operation, citations, prompt_sha256, answer_sha256, recorded_at }, prompt_sha256, answer_sha256, recorded_at);
    } });
  }

  /** A content-free witness of each follow-ups release (ADR-0040): the operation, and each follow-up's id and digest. */
  forFollowUpRequest(context: AgenticAskAuditRequestContextV1): PersonFollowUpReleaseAuditV1 {
    return Object.freeze<PersonFollowUpReleaseAuditV1>({ record: this.itemWitness(context, 'echo-person-follow-up', 'Follow-up release audit is invalid', release =>
      release.items.length <= 50 && new Set(release.items.map(item => item.item_id)).size === release.items.length &&
        release.items.every(item => typeof item.item_id === 'string' && FOLLOW_UP_ITEM_ID.test(item.item_id) && typeof item.released_fields_sha256 === 'string' && DIGEST.test(item.released_fields_sha256)),
    release => ({ selected: { operation: release.operation }, items: release.items.map(item => ({ item_id: item.item_id, released_fields_sha256: item.released_fields_sha256 })) })) });
  }

  /**
   * A content-free witness of each workspace release (research tool contract v1): the source, the operation, and each
   * item's kind, id, whether it was released beside the result, and a digest of its released fields.
   */
  forWorkspaceRequest(context: AgenticAskAuditRequestContextV1): PersonWorkspaceReleaseAuditV1 {
    return Object.freeze<PersonWorkspaceReleaseAuditV1>({ record: this.itemWitness(context, 'echo-person-workspace', 'Workspace release audit is invalid', release =>
      WORKSPACE_SOURCES.includes(release.source) && release.items.length <= WORKSPACE_RELEASE_ITEMS_MAX && release.items.every(workspaceItem) &&
        new Set(release.items.map(item => `${item.kind}:${item.item_id}`)).size === release.items.length,
    release => ({ selected: { source: release.source, operation: release.operation },
      items: release.items.map(item => ({ kind: item.kind, item_id: item.item_id, linked: item.linked, released_fields_sha256: item.released_fields_sha256 })) })) });
  }

  /**
   * One request's item release witnesses, in the same table and request context as the Ask's other witnesses: what was
   * selected (`<name>-selection-v1`) and the items' ids and digests, copied from an explicit allowlist so that a release
   * carries nothing else and nothing else is kept. Empty releases are committed too.
   */
  private itemWitness<R extends { readonly operation: string; readonly items: readonly unknown[] }>(context: AgenticAskAuditRequestContextV1, name: string, invalid: string,
    valid: (release: R) => boolean, copy: (release: R) => { readonly selected: Readonly<Record<string, string>>; readonly items: readonly unknown[] }): (release: R) => Sha256Digest {
    const bound = this.bind(context);
    let releaseSequence = 0;
    return (release) => {
      if (!OPERATIONS.includes(release.operation) || !Array.isArray(release.items) || !valid(release)) throw new Error(invalid);
      const { selected, items } = copy(release);
      const recorded_at = this.now();
      const prompt_sha256 = canonicalSha256({ kind: `${name}-selection-v1`, ...selected });
      const answer_sha256 = canonicalSha256(items);
      return this.insert({ schema_version: 1, kind: `${name}-release-audit-v1`, context_kind: 'answer_composition', ...bound,
        release_sequence: ++releaseSequence, ...selected, items, prompt_sha256, answer_sha256, recorded_at }, prompt_sha256, answer_sha256, recorded_at);
    };
  }

  /** Commits one immutable row and returns its receipt, the digest of its body. */
  private insert(body: object, prompt_sha256: Sha256Digest, answer_sha256: Sha256Digest, recorded_at: string): Sha256Digest {
    return appendAuditRowV1(this.database, "authority_person_read_decision_audit_v2", body, recorded_at, { context_kind: "answer_composition", prompt_sha256, answer_sha256 });
  }

  /** Validates the trusted request context and copies exactly its fields. */
  private bind(context: AgenticAskAuditRequestContextV1): AgenticAskAuditRequestContextV1 {
    if (![context.authority_id, context.organization_id, context.state_lineage_id, context.principal_id, context.membership_id, context.session_family_id, context.request_id]
      .every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)) throw new Error("Agentic Ask audit context is invalid");
    return Object.freeze({
      authority_id: context.authority_id,
      organization_id: context.organization_id,
      state_lineage_id: context.state_lineage_id,
      principal_id: context.principal_id,
      membership_id: context.membership_id,
      session_family_id: context.session_family_id,
      request_id: context.request_id,
    });
  }

  private appendBound(context: AgenticAskAuditRequestContextV1, entry: AgenticAskAuditEntryV1): Sha256Digest {
    // Research-only triggers and background-budget Ask runs (research loop evaluation v1).
    const background = entry.trigger !== undefined || entry.budget !== undefined;
    const budget = AGENTIC_RESEARCH_BUDGETS_V1[background ? "background" : "live"];
    const limits = { rounds: budget.max_rounds, model_calls: budget.max_model_calls, receipts: budget.max_receipts, citations: background ? 360 : 40 };
    // A native harness has no ECHO planner-step counter; it reports its outbound
    // research calls, already bounded by the shared request's call budget.
    const external = Array.isArray(entry.generations) && entry.generations.some(value => value.engine === 'external_research');
    const roundLimit = external ? limits.model_calls : limits.rounds;
    if (
      entry.kind !== "echo-agentic-ask-audit-v1" ||
      (entry.trigger !== undefined && !AGENTIC_TRIGGER_NAMES_V1.includes(entry.trigger)) ||
      (entry.budget !== undefined && entry.budget !== "background") ||
      // A follow-up that asked which one is released as `clarify` (ADR-0047).
      !["answered", "partial", "not_found", "clarify", "cancelled", "timed_out"].includes(entry.outcome) ||
      !Array.isArray(entry.receipt_digests) || entry.receipt_digests.length > limits.receipts ||
      new Set(entry.receipt_digests).size !== entry.receipt_digests.length ||
      !entry.receipt_digests.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)) ||
      ![entry.rounds, entry.model_calls, entry.repairs, entry.fallbacks, entry.citation_count]
        .every((value) => Number.isSafeInteger(value) && value >= 0) ||
      entry.rounds > roundLimit || (external && entry.rounds > entry.model_calls) || entry.model_calls > limits.model_calls || entry.repairs > limits.model_calls || entry.fallbacks > 16 || entry.citation_count > limits.citations ||
      (entry.checked_at !== null && new Date(entry.checked_at).toISOString() !== entry.checked_at) ||
      ![entry.prompt_sha256, entry.answer_sha256, entry.response_sha256]
        .every((digest) => digest === null || /^sha256:[a-f0-9]{64}$/.test(digest)) ||
      ((entry.outcome === "cancelled" || entry.outcome === "timed_out") && (entry.prompt_sha256 !== null || entry.answer_sha256 !== null || entry.response_sha256 !== null)) ||
      !Array.isArray(entry.generations) || entry.generations.length !== entry.model_calls ||
      entry.generations.some((generation) => !["step", "answer"].includes(generation.role) ||
        (generation.engine !== undefined && !['external_research', 'external_writer'].includes(generation.engine)) ||
        (generation.engine !== undefined && (generation.role !== (generation.engine === 'external_research' ? 'step' : 'answer') || typeof generation.model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,200}$/u.test(generation.model))) ||
        (generation.finish_reason !== null && (typeof generation.finish_reason !== "string" || generation.finish_reason.length > 128)) ||
        (generation.usage !== null && ![generation.usage.input_tokens, generation.usage.output_tokens, generation.usage.total_tokens]
          .every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)))) ||
      ![entry.generation_usage.input_tokens, entry.generation_usage.output_tokens, entry.generation_usage.total_tokens]
        .every((value) => value === null || (Number.isSafeInteger(value) && value >= 0)) ||
      Object.entries(entry.finish_reason_counts).some(([reason, count]) => reason.length === 0 || reason.length > 128 || !Number.isSafeInteger(count) || count < 1 || count > entry.model_calls) ||
      // A streamed request's named items (ADR-0039): distinct citation commitments, never labels.
      (entry.named_citation_digests !== undefined && (!Array.isArray(entry.named_citation_digests) ||
        entry.named_citation_digests.length > PERSON_ASK_PROGRESS_NAMED_MAX_V1 || new Set(entry.named_citation_digests).size !== entry.named_citation_digests.length ||
        !entry.named_citation_digests.every((digest) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest))))
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
      ...(entry.trigger === undefined ? {} : { trigger: entry.trigger }),
      ...(entry.budget === undefined ? {} : { budget: entry.budget }),
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
      ...(entry.named_citation_digests === undefined ? {} : { named_citation_digests: [...entry.named_citation_digests] }),
    });
    return this.insert(body, prompt_sha256, answer_sha256, recorded_at);
  }
}
