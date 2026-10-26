import { canonicalJsonBytes, canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_RESPONSE_MAX_BYTES_V4,
  validatePersonAnswerResponseV4,
  type PersonAnswerEvidenceFallbackV4,
  type PersonAnswerResponseV4,
  type PersonAnswerResponseV5,
  validatePersonAnswerResponseV5,
  type PersonAnswerResponseV6,
  validatePersonAnswerResponseV6,
  type PersonAnswerResponseV7,
  validatePersonAnswerResponseV7,
  type PersonAnswerResponseV8,
  validatePersonAnswerResponseV8,
  type PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import { AgenticAskOutputErrorV1 } from "./agentic-ask-v1-model-protocol.js";

type AnswerItem = PersonAnswerStatementV4 | PersonAnswerEvidenceFallbackV4;
type AskResponse = PersonAnswerResponseV4 | PersonAnswerResponseV5 | PersonAnswerResponseV6 | PersonAnswerResponseV7 | PersonAnswerResponseV8;
type Part = { question: string; status: PersonAnswerResponseV4["parts"][number]["status"]; statements: PersonAnswerStatementV4[]; gap?: string; records?: PersonAnswerEvidenceFallbackV4[] };

function overBound(candidate: AskResponse): boolean {
  return canonicalJsonBytes(candidate).byteLength > PERSON_ANSWER_RESPONSE_MAX_BYTES_V4;
}

/**
 * `candidate` with these parts and outcome, and only the citations they cite, renumbered in their order. A V8 answer to
 * a request that carried the previous turn keeps its question, and a clarify its choices (ADR-0047); `since` is never
 * kept, so dropping it first frees its citations.
 */
function withParts(candidate: AskResponse, parts: readonly Part[], outcome: AskResponse["outcome"]): AskResponse {
  const usedIndexes = new Set(parts.flatMap(part => [...part.statements.flatMap(statement => statement.citation_indexes), ...(part.records?.flatMap(record => record.citation_indexes) ?? [])]));
  const remap = new Map<number, number>();
  const citations = candidate.citations.filter((_, index) => {
    if (!usedIndexes.has(index)) return false;
    remap.set(index, remap.size); return true;
  });
  const remapItem = <T extends AnswerItem>(item: T): T => Object.freeze({ ...item, citation_indexes: Object.freeze(item.citation_indexes.map(index => remap.get(index)).filter((index): index is number => index !== undefined)) }) as T;
  const previous = candidate.schema_version !== 8 ? {} : {
    ...(candidate.question === undefined ? {} : { question: candidate.question }), ...(candidate.choices === undefined ? {} : { choices: candidate.choices }),
  };
  return Object.freeze({ schema_version: candidate.schema_version, kind: candidate.kind, scope: candidate.scope, outcome, citations: Object.freeze(citations), parts: Object.freeze(parts.map(part => Object.freeze({ question: part.question, status: part.status, statements: Object.freeze(part.statements.map(remapItem)), ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: Object.freeze(part.records.map(remapItem)) }) }))), ...(candidate.notice === undefined ? {} : { notice: candidate.notice }), ...previous }) as AskResponse;
}

/** Removes whole least-priority evidence records until the versioned packet fits. */
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV4): PersonAnswerResponseV4;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV5): PersonAnswerResponseV5;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV6): PersonAnswerResponseV6;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV7): PersonAnswerResponseV7;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV8): PersonAnswerResponseV8;
export function compactAndValidateAgenticAskResponseV1(result: AskResponse): AskResponse {
  let candidate = result;
  const copy = (value: AskResponse): Part[] => value.parts.map(part => ({ question: part.question, status: part.status, statements: [...part.statements], ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: [...part.records] }) }));
  // An Ask again's `since` (ADR-0047) goes first, and whole: cut short, it would say less changed than did. The answer
  // itself is unchanged, so its outcome stands.
  if (overBound(candidate) && candidate.schema_version === 8 && candidate.since !== undefined) candidate = withParts(candidate, copy(candidate), candidate.outcome);
  while (overBound(candidate)) {
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
  return candidate.schema_version === 8 ? validatePersonAnswerResponseV8(candidate) : candidate.schema_version === 7 ? validatePersonAnswerResponseV7(candidate) : candidate.schema_version === 6 ? validatePersonAnswerResponseV6(candidate) : candidate.schema_version === 5 ? validatePersonAnswerResponseV5(candidate) : validatePersonAnswerResponseV4(candidate);
}

/**
 * Ask's answer, as its audit binds it: the direct statement and parts, and, on an answer to a request that carried the
 * previous turn (ADR-0047), the question it answers, what is different since and the choices it offers.
 */
export function agenticAskAnswerSha256V1(response: AskResponse): Sha256Digest {
  const previous = response.schema_version !== 8 ? {} : {
    ...(response.question === undefined ? {} : { question: response.question }), ...(response.since === undefined ? {} : { since: response.since }),
    ...(response.choices === undefined ? {} : { choices: response.choices }),
  };
  return canonicalSha256({ direct: response.direct ?? null, parts: response.parts, ...previous });
}
