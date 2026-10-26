import { canonicalJsonBytes, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_RESPONSE_MAX_BYTES_V4,
  type PersonAnswerEvidenceFallbackV4,
  type PersonAnswerResponseV8,
  validatePersonAnswerResponseV8,
  type PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import { AgenticAskOutputErrorV1 } from "./agentic-ask-v1-model-protocol.js";

type AnswerItem = PersonAnswerStatementV4 | PersonAnswerEvidenceFallbackV4;
type Part = { question: string; status: PersonAnswerResponseV8["parts"][number]["status"]; statements: PersonAnswerStatementV4[]; gap?: string; records?: PersonAnswerEvidenceFallbackV4[] };

/** Whether an Ask response fits its JSON byte bound. */
export function agenticAskResponseFitsV1(response: unknown): boolean {
  return canonicalJsonBytes(response).byteLength <= PERSON_ANSWER_RESPONSE_MAX_BYTES_V4;
}

/**
 * `candidate` with these parts and outcome, and only the citations they cite, renumbered in their order. Every other field
 * is kept, except the two others that index the citations: a direct statement, and an Ask again's `since` (ADR-0047),
 * whose citations dropping it frees.
 */
function withParts(candidate: PersonAnswerResponseV8, parts: readonly Part[], outcome: PersonAnswerResponseV8["outcome"]): PersonAnswerResponseV8 {
  const usedIndexes = new Set(parts.flatMap(part => [...part.statements.flatMap(statement => statement.citation_indexes), ...(part.records?.flatMap(record => record.citation_indexes) ?? [])]));
  const remap = new Map<number, number>();
  const citations = candidate.citations.filter((_, index) => {
    if (!usedIndexes.has(index)) return false;
    remap.set(index, remap.size); return true;
  });
  const remapItem = <T extends AnswerItem>(item: T): T => Object.freeze({ ...item, citation_indexes: Object.freeze(item.citation_indexes.map(index => remap.get(index)).filter((index): index is number => index !== undefined)) }) as T;
  const { outcome: _outcome, citations: _citations, parts: _parts, direct: _direct, since: _since, ...kept } = candidate;
  return Object.freeze({ ...kept, outcome, citations: Object.freeze(citations), parts: Object.freeze(parts.map(part => Object.freeze({ question: part.question, status: part.status, statements: Object.freeze(part.statements.map(remapItem)), ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: Object.freeze(part.records.map(remapItem)) }) }))) }) as PersonAnswerResponseV8;
}

/** Removes whole least-priority evidence records until the packet fits. */
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV8): PersonAnswerResponseV8 {
  let candidate = result;
  const copy = (value: PersonAnswerResponseV8): Part[] => value.parts.map(part => ({ question: part.question, status: part.status, statements: [...part.statements], ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: [...part.records] }) }));
  // An Ask again's `since` (ADR-0047) goes first, and whole: cut short, it would say less changed than did. The answer
  // itself is unchanged, so its outcome stands.
  if (candidate.since !== undefined && !agenticAskResponseFitsV1(candidate)) candidate = withParts(candidate, copy(candidate), candidate.outcome);
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
    const statuses = parts.map(part => part.status);
    const outcome = statuses.every(status => status === "not_found") ? "not_found" : statuses.every(status => status === "answered") ? "answered" : "partial";
    candidate = withParts(candidate, parts, outcome);
  }
  return validatePersonAnswerResponseV8(candidate);
}

/**
 * Ask's answer, as its audit binds it: the direct statement and parts, and, on an answer to a request that carried the
 * previous turn (ADR-0047), the question it answers, what is different since and the choices it offers.
 */
export function agenticAskAnswerSha256V1(response: PersonAnswerResponseV8): Sha256Digest {
  const previous = {
    ...(response.question === undefined ? {} : { question: response.question }), ...(response.since === undefined ? {} : { since: response.since }),
    ...(response.choices === undefined ? {} : { choices: response.choices }),
  };
  return canonicalSha256({ direct: response.direct ?? null, parts: response.parts, ...previous });
}
