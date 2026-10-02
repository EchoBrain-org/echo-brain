import { canonicalJsonBytes } from "@echo-brain/federation-protocol";
import {
  PERSON_ANSWER_RESPONSE_MAX_BYTES_V4,
  validatePersonAnswerResponseV4,
  type PersonAnswerEvidenceFallbackV4,
  type PersonAnswerResponseV4,
  type PersonAnswerResponseV5,
  validatePersonAnswerResponseV5,
  type PersonAnswerStatementV4,
} from "@echo-brain/organization-api";
import { AgenticAskOutputErrorV1 } from "./agentic-ask-v1-model-protocol.js";

type AnswerItem = PersonAnswerStatementV4 | PersonAnswerEvidenceFallbackV4;

/** Removes whole least-priority evidence records until the versioned packet fits. */
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV4): PersonAnswerResponseV4;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV5): PersonAnswerResponseV5;
export function compactAndValidateAgenticAskResponseV1(result: PersonAnswerResponseV4 | PersonAnswerResponseV5): PersonAnswerResponseV4 | PersonAnswerResponseV5 {
  let candidate = result;
  while (canonicalJsonBytes(candidate).byteLength > PERSON_ANSWER_RESPONSE_MAX_BYTES_V4) {
    const parts: Array<{ question: string; status: PersonAnswerResponseV4["parts"][number]["status"]; statements: PersonAnswerStatementV4[]; gap?: string; records?: PersonAnswerEvidenceFallbackV4[] }> = candidate.parts.map(part => ({ question: part.question, status: part.status, statements: [...part.statements], ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: [...part.records] }) }));
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
    const usedIndexes = new Set(parts.flatMap(part => [...part.statements.flatMap(statement => statement.citation_indexes), ...(part.records?.flatMap(record => record.citation_indexes) ?? [])]));
    const remap = new Map<number, number>();
    const citations = candidate.citations.filter((_, index) => {
      if (!usedIndexes.has(index)) return false;
      remap.set(index, remap.size); return true;
    });
    const remapItem = <T extends AnswerItem>(item: T): T => Object.freeze({ ...item, citation_indexes: Object.freeze(item.citation_indexes.map(index => remap.get(index)).filter((index): index is number => index !== undefined)) }) as T;
    candidate = Object.freeze({ schema_version: candidate.schema_version, kind: candidate.kind, scope: candidate.scope, outcome, citations: Object.freeze(citations), parts: Object.freeze(parts.map(part => Object.freeze({ question: part.question, status: part.status, statements: Object.freeze(part.statements.map(remapItem)), ...(part.gap === undefined ? {} : { gap: part.gap }), ...(part.records === undefined ? {} : { records: Object.freeze(part.records.map(remapItem)) }) }))), ...(candidate.assumption === undefined ? {} : { assumption: candidate.assumption }), ...(candidate.notice === undefined ? {} : { notice: candidate.notice }) }) as PersonAnswerResponseV4 | PersonAnswerResponseV5;
  }
  return candidate.schema_version === 5 ? validatePersonAnswerResponseV5(candidate) : validatePersonAnswerResponseV4(candidate);
}
