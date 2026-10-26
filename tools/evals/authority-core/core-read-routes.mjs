/**
 * Provider-free read-path construction for the single-meeting core smoke.
 * It deliberately opens the real Authority and record databases and uses the
 * real Person search route and the agentic Ask route (the only Ask since
 * ADR-0022), as `POST /v7/person/ask` composes it, with no live source,
 * follow-ups or workspace. Caller sessions come from core-identity; this
 * module never accepts a reader tuple or manufactures authorization.
 */
import { join } from "node:path";
import { openAuthorityDatabase } from "../../../packages/organization-authority-kernel/dist/adapters/persistence/sqlite/open-authority-database.js";
import { SqlitePersonAgenticAskAuditV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js";
import { SqlitePersonOriginalContextRetrievalV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-original-context-retrieval-v1.js";
import { SqlitePersonRecordReadAuditV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { SqliteProjectContextRepositoryV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/project-context-v1.js";
import { createPersonLiveAnswerRouteV1 } from "../../../services/organization-authority/dist/composition/person-live-answer-route-v1.js";
import { createRecordProjectAuthorizationV1 } from "../../../services/organization-authority/dist/composition/person-record-project-scope-v1.js";
import { createPersonRecordSearchRouteV1 } from "../../../services/organization-authority/dist/composition/person-record-search-route.js";
import { readableSearchGenerationContractV1 } from "../../../services/organization-authority/dist/composition/readable-search-generation-composition.js";
import { verifyAuthorityStateLineage } from "../../../packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js";
import { openOrganizationRecordDatabase } from "@echo-brain/organization-record/organization-record-api-v1";

const ANSWER_PROFILE = Object.freeze({
  generation_adapter_id: "authority-core-deterministic-v1",
  planner_model: "authority-core-query-extractor-v1",
  answer_model: "authority-core-evidence-composer-v1",
  timeout_ms: 60_000,
});

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJson(value) {
  try { return record(JSON.parse(value)); } catch { return null; }
}

/** The question's words, as the one keyword search the deterministic agent runs. */
function questionQuery(question) {
  const terms = [...new Set(question.match(/[\p{L}\p{N}]+/gu)?.map((term) => term.toLowerCase()) ?? [])];
  return terms.slice(-8).join(" ");
}

/**
 * One deterministic research loop: search the question once, finish on the
 * highest-ranked result whose full text was shown (an approved record item
 * before an unapproved import), otherwise complete a meeting
 * inventory read before reporting no result. It reads only the current prompt:
 * no corpus map, response fixture or caller-controlled citation. Its one need
 * asks what an item says, so it declares content (ADR-0041) and never finishes
 * on a list.
 */
function stepResponse(userPrompt) {
  const prompt = parseJson(userPrompt);
  const question = prompt?.question;
  if (typeof question !== "string") throw new Error("deterministic agent did not receive a question");
  const part = (status, evidence = []) => ({ question, needs: [{ need: "the answer", kind: "content", status, evidence }], notes: "" });
  const lastResults = Array.isArray(prompt.last_results) ? prompt.last_results : [];
  // A search result names its hits by id in rank order; their details and text
  // are in seen, which is in id order, so walk the ids to keep the rank.
  const shown = new Map((Array.isArray(prompt.seen) ? prompt.seen : []).map((item) => [record(item)?.id, item]));
  const seen = lastResults.flatMap((result) => Array.isArray(record(result)?.results) ? result.results : [])
    .map((id) => shown.get(id)).filter((item) => item !== undefined);
  // Approved record items are the authority; an unapproved import is used only when no approved item was shown.
  const shownInFull = seen.filter((item) => record(item)?.full === true && typeof item.id === "string");
  const full = shownInFull.find((item) => record(record(item)?.provenance)?.kind === "approved_record") ?? shownInFull[0];
  if (full !== undefined) return Object.freeze({ parts: [part("found", [full.id])], actions: [{ tool: "finish", args: {} }] });
  if (prompt.step === 1) {
    const query = questionQuery(question);
    if (query.length > 0) return Object.freeze({ parts: [part("open")], actions: [{ tool: "search", args: { query } }] });
  }
  const completedMeetingList = lastResults.some((result) => {
    const value = record(result);
    return value?.tool === "list" && Array.isArray(value.items) && value.more === false;
  });
  if (!completedMeetingList) return Object.freeze({ parts: [part("open")], actions: [{ tool: "list", args: { source: "meetings" } }] });
  return Object.freeze({ parts: [part("not_found")], actions: [{ tool: "finish", args: {} }] });
}

/**
 * Ask's writer sees released text and, since ADR-0041, the lists research read as rows without text. The
 * deterministic writer quotes the first released text and chooses no list: its planner declares content, so no list
 * answers its need, and code states every list a which_items need cites anyway. With only lists, it writes nothing.
 */
function answerResponse(userPrompt) {
  const prompt = parseJson(userPrompt);
  const evidence = prompt?.evidence;
  const lists = Array.isArray(prompt?.lists) ? prompt.lists : [];
  if (!Array.isArray(evidence) || (evidence.length === 0 && lists.length === 0)) throw new Error("deterministic answerer received no released evidence");
  if (evidence.length === 0) return Object.freeze({ lists: [], sentences: [], not_found: [] });
  const first = record(evidence[0]);
  if (first === null || typeof first.id !== "string" || first.id.length === 0 || typeof first.text !== "string" || first.text.length === 0) {
    throw new Error("deterministic answerer received invalid released evidence");
  }
  // Return only released text and its released id.
  const text = first.text.slice(0, 500).trim();
  if (text.length === 0) throw new Error("deterministic answerer received empty released evidence");
  return Object.freeze({ lists: [], sentences: [{ text, evidence: [first.id] }], not_found: [] });
}

/**
 * A provider-free structured-output port for answer composition. It derives
 * output solely from each current request: planner question or answer
 * evidence aliases.
 */
export function createCoreDeterministicStructuredGenerationPort() {
  return Object.freeze({
    async generate(input) {
      const properties = record(record(record(input)?.schema)?.properties);
      if (properties === null || typeof input?.user_prompt !== "string") {
        throw new Error("deterministic structured generation input is invalid");
      }
      if (Object.hasOwn(properties, "actions")) return stepResponse(input.user_prompt);
      if (Object.hasOwn(properties, "sentences")) return answerResponse(input.user_prompt);
      throw new Error("deterministic structured generation schema is unsupported");
    },
  });
}

/**
 * Open real current-Person search and answer routes over a verified stopped
 * Authority state.
 */
export function createCoreReadRoutes({ state_directory, sessions, record_input_codecs } = {}) {
  text(state_directory, "state_directory");
  if (sessions === null || typeof sessions !== "object" || typeof sessions.authenticateAccess !== "function") {
    throw new TypeError("sessions must be the real core identity application");
  }
  const generation = ANSWER_PROFILE;
  const structured_output = createCoreDeterministicStructuredGenerationPort();
  const lineage = verifyAuthorityStateLineage(state_directory);
  let authority;
  let recordDatabase;
  try {
    authority = openAuthorityDatabase(join(state_directory, "authority.sqlite"), { fileMustExist: true });
    recordDatabase = openOrganizationRecordDatabase(join(state_directory, "record-log.sqlite"), { fileMustExist: true });
    const contract = readableSearchGenerationContractV1();
    const search = createPersonRecordSearchRouteV1({
      state_directory,
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      retrieval_contract_sha256: contract.retrieval_contract_sha256,
      sessions,
      authority,
      record: recordDatabase,
      audit: new SqlitePersonRecordReadAuditV1(authority),
      // A project-audience record is readable only by the project's current members.
      capture_projects: createRecordProjectAuthorizationV1(new SqliteProjectContextRepositoryV1(authority)),
      ...(record_input_codecs === undefined ? {} : { record_input_codecs }),
    });
    const answer = createPersonLiveAnswerRouteV1({
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      sessions,
      originals: new SqlitePersonOriginalContextRetrievalV1(authority, sessions, lineage.root.organization_id),
      records: search,
      model: structured_output,
      generation,
      audit: new SqlitePersonAgenticAskAuditV1(authority),
    });
    return Object.freeze({
      search,
      answer,
      close() {
        recordDatabase?.close();
        recordDatabase = undefined;
        authority?.close();
        authority = undefined;
      },
    });
  } catch (error) {
    recordDatabase?.close();
    authority?.close();
    throw error;
  }
}
