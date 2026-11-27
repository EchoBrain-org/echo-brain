import { canonicalJsonBytes, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_RESPONSE_MAX_BYTES_V4,
  type PersonAnswerEvidenceFallbackV4,
  type PersonAnswerResponseV8,
  validatePersonAnswerResponseV8,
  type PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import { AgenticAskOutputErrorV1 } from "./agentic-ask-v1-model-protocol.js";
import { observeCoreModelCorrectionV1 } from "../shared/core-runtime-observation-v1.js";
import type { AskFollowUpDraftV1 } from "./ask-follow-ups-v1.js";

type AnswerItem = PersonAnswerStatementV4 | PersonAnswerEvidenceFallbackV4;
type Block = NonNullable<PersonAnswerResponseV8["parts"][number]["blocks"]>[number];
type Part = { question: string; status: PersonAnswerResponseV8["parts"][number]["status"]; statements: PersonAnswerStatementV4[]; gap?: string; gap_details?: PersonAnswerResponseV8["parts"][number]["gap_details"]; records?: PersonAnswerEvidenceFallbackV4[]; blocks?: readonly Block[] };

/** Whether an Ask response fits its JSON byte bound. */
export function agenticAskResponseFitsV1(response: unknown): boolean {
  return canonicalJsonBytes(response).byteLength <= PERSON_ANSWER_RESPONSE_MAX_BYTES_V4;
}

/**
 * A part's blocks once its statements are cut to `kept` (always from the end): a block whose statements all remain is kept
 * as written, its table rows' citations renumbered; the block cut part way, and any whose rows lose every citation, reads
 * as one text block of what remains of it (`collapsed` is told). Null when the part has no blocks to keep.
 */
function keptBlocks(blocks: readonly Block[] | undefined, kept: number, remap: ReadonlyMap<number, number>, collapsed: () => void): readonly Block[] | null {
  if (blocks === undefined || kept === 0) return null;
  const out: Block[] = [];
  for (const block of blocks) {
    const remaining = block.statements.filter(index => index < kept);
    if (remaining.length === 0) continue;
    const rows = block.kind === "table" ? block.rows.map(row => ({ ...row, citation_indexes: row.citation_indexes.map(index => remap.get(index)).filter((index): index is number => index !== undefined) })) : undefined;
    if (remaining.length === block.statements.length && (rows === undefined || rows.every(row => row.citation_indexes.length > 0))) {
      out.push(Object.freeze(rows === undefined ? block : { ...block, rows: Object.freeze(rows.map(row => Object.freeze(row))) }) as Block);
      continue;
    }
    collapsed();
    out.push(Object.freeze({ kind: "text", statements: Object.freeze(remaining) }));
  }
  return Object.freeze(out);
}

/**
 * `candidate` with these parts and outcome, and only the citations they cite, renumbered in their order. Every other field
 * is kept, except the two others that index the citations: a direct statement, and an Ask again's `since` (ADR-0047),
 * whose citations dropping it frees. A part keeps the blocks its remaining statements were arranged in (ADR-0051); where
 * a cut leaves a block unable to stand, what remains of it reads as text, and the collapse is counted.
 */
function withParts(candidate: PersonAnswerResponseV8, parts: readonly Part[], outcome: PersonAnswerResponseV8["outcome"], collapsed: () => void): PersonAnswerResponseV8 {
  const usedIndexes = new Set(parts.flatMap(part => [...part.statements.flatMap(statement => statement.citation_indexes), ...(part.records?.flatMap(record => record.citation_indexes) ?? [])]));
  const remap = new Map<number, number>();
  const citations = candidate.citations.filter((_, index) => {
    if (!usedIndexes.has(index)) return false;
    remap.set(index, remap.size); return true;
  });
  parts = parts.map((part, at) => ({ ...part, blocks: keptBlocks(candidate.parts[at]?.blocks, part.statements.length, remap, collapsed) ?? undefined }));
  const remapItem = <T extends AnswerItem>(item: T): T => Object.freeze({ ...item, citation_indexes: Object.freeze(item.citation_indexes.map(index => remap.get(index)).filter((index): index is number => index !== undefined)) }) as T;
  const { outcome: _outcome, citations: _citations, parts: _parts, direct: _direct, since: _since, ...kept } = candidate;
  return Object.freeze({ ...kept, outcome, citations: Object.freeze(citations), parts: Object.freeze(parts.map(part => Object.freeze({ question: part.question, status: part.status, statements: Object.freeze(part.statements.map(remapItem)), ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.gap_details === undefined ? {} : { gap_details: part.gap_details }), ...(part.records === undefined ? {} : { records: Object.freeze(part.records.map(remapItem)) }),
    ...(part.statements.length === 0 ? {} : { blocks: part.blocks ?? Object.freeze([Object.freeze({ kind: "text", statements: Object.freeze(part.statements.map((_, at) => at)) })]) }) }))) }) as PersonAnswerResponseV8;
}

/**
 * Removes whole least-priority evidence records until the packet fits the response's transport bound. A layout the cut
 * changed is counted once, as `writer_layout_collapsed`.
 */
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV8): PersonAnswerResponseV8 {
  let candidate = result;
  let layoutCollapsed = false;
  const collapsed = () => { layoutCollapsed = true; };
  const copy = (value: PersonAnswerResponseV8): Part[] => value.parts.map(part => ({ question: part.question, status: part.status, statements: [...part.statements], ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.gap_details === undefined ? {} : { gap_details: part.gap_details }), ...(part.records === undefined ? {} : { records: [...part.records] }) }));
  // An Ask again's `since` (ADR-0047) goes first, and whole: cut short, it would say less changed than did. The answer
  // itself is unchanged, so its outcome stands.
  if (candidate.since !== undefined && !agenticAskResponseFitsV1(candidate)) candidate = withParts(candidate, copy(candidate), candidate.outcome, collapsed);
  while (!agenticAskResponseFitsV1(candidate)) {
    const parts = copy(candidate);
    let removed = false;
    for (let index = parts.length - 1; index >= 0 && !removed; index -= 1) {
      const part = parts[index]!;
      if (part.records !== undefined && part.records.length > 0) { part.records.pop(); removed = true; }
      else if (part.statements.length > 0) { part.statements.pop(); removed = true; }
      if (!removed) continue;
      if (part.records !== undefined && part.records.length > 0) {
        part.status = "records_only";
        part.statements = [];
      } else if (part.statements.length === 0) {
        part.status = "not_found";
        delete part.records;
        part.gap = "Some evidence could not fit in this response.";
      } else {
        part.status = "partial";
        part.gap ??= "Some evidence could not fit in this response.";
      }
    }
    if (!removed) throw new AgenticAskOutputErrorV1("agentic Ask response cannot fit its byte bound");
    // Losing evidence to the byte bound is partial output, never proof that a completed search found nothing.
    candidate = withParts(candidate, parts, "partial", collapsed);
  }
  if (candidate === result) return validatePersonAnswerResponseV8(candidate);
  try {
    const validated = validatePersonAnswerResponseV8(candidate);
    if (layoutCollapsed) observeCoreModelCorrectionV1("writer_layout_collapsed");
    return validated;
  } catch {
    // A kept block the layout contract refuses once its neighbours were cut: every part then reads as one text block.
    observeCoreModelCorrectionV1("writer_layout_collapsed");
    return validatePersonAnswerResponseV8(Object.freeze({ ...candidate, parts: Object.freeze(candidate.parts.map(part => part.statements.length === 0 ? part
      : Object.freeze({ ...part, blocks: Object.freeze([Object.freeze({ kind: "text" as const, statements: Object.freeze(part.statements.map((_, at) => at)) })]) }))) }) as PersonAnswerResponseV8);
  }
}

/**
 * Ask's answer, as its audit binds it: the direct statement and parts, and, on an answer to a request that carried the
 * previous turn (ADR-0047), the question it answers, what is different since and the choices it offers. An answer that
 * drafted follow-ups (ADR-0053) binds them too: `drafts`, what is saved, when the caller has them, else their ids. An
 * answer to a request that carried threads (ADR-0056) binds `thread` and `merge`, and one that carries a label (ADR-0057)
 * binds it. With none of these, it hashes as before.
 */
export function agenticAskAnswerSha256V1(response: PersonAnswerResponseV8, drafts?: readonly AskFollowUpDraftV1[]): Sha256Digest {
  const previous = {
    ...(response.question === undefined ? {} : { question: response.question }), ...(response.since === undefined ? {} : { since: response.since }),
    ...(response.recalled === undefined ? {} : { recalled: response.recalled }),
    ...(response.choices === undefined ? {} : { choices: response.choices }),
  };
  const followUps = response.follow_ups === undefined ? {} : { follow_ups: drafts ?? response.follow_ups };
  // A label (ADR-0057) is covered only when present, so an answer without one hashes as before.
  const placed = { ...(response.thread === undefined ? {} : { thread: response.thread }), ...(response.merge === undefined ? {} : { merge: response.merge }), ...(response.label === undefined ? {} : { label: response.label }) };
  return canonicalSha256({ direct: response.direct ?? null, parts: response.parts, ...previous, ...followUps, ...placed });
}
