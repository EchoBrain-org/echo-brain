/**
 * Provider-free read-path construction for the single-meeting core smoke.
 * It deliberately opens the real Authority and record databases and uses the
 * real Person search/answer routes. Caller sessions come from core-identity;
 * this module never accepts a reader tuple or manufactures authorization.
 */
import { join } from "node:path";
import { openAuthorityDatabase } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/open-authority-database.js";
import { SqlitePersonAnswerCompositionAuditV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-answer-composition-audit-v1.js";
import { SqlitePersonRecordReadAuditV1 } from "../../../services/organization-authority/dist/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { createPersonAnswerRouteV1 } from "../../../services/organization-authority/dist/composition/person-answer-route.js";
import { createPersonRecordSearchRouteV1 } from "../../../services/organization-authority/dist/composition/person-record-search-route.js";
import { readableSearchGenerationContractV1 } from "../../../services/organization-authority/dist/composition/readable-search-generation-composition.js";
import { verifyAuthorityStateLineage } from "../../../services/organization-authority/dist/composition/verify-authority-state-lineage.js";
import { openOrganizationRecordDatabase } from "@echo-brain/organization-record/organization-record-api-v1";
import { expandReadableSearchRelatedAtomsV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";

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

function plannerResponse(userPrompt) {
  const question = parseJson(userPrompt)?.question;
  if (typeof question !== "string") throw new Error("deterministic planner did not receive a question");
  const terms = [...new Set(question.match(/[\p{L}\p{N}]+/gu)?.map((term) => term.toLowerCase()) ?? [])];
  // The original question is always the first real retrieval query. This is
  // only a bounded lexical refinement and never a hidden answer lookup.
  const query = terms.slice(-3).join(" ");
  return Object.freeze({ queries: query.length === 0 ? [] : [query] });
}

function answerResponse(userPrompt) {
  const sources = parseJson(userPrompt)?.sources;
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("deterministic answerer received no released evidence");
  const first = record(sources[0]);
  if (first === null || typeof first.citation_id !== "string" || first.citation_id.length === 0 || typeof first.text !== "string" || first.text.length === 0) {
    throw new Error("deterministic answerer received invalid released evidence");
  }
  // Return only a released text value and its released alias. There is no
  // corpus map, response fixture, or caller-controlled citation path.
  const answer = first.text.slice(0, 4_000).trim();
  if (answer.length === 0) throw new Error("deterministic answerer received empty released evidence");
  return Object.freeze({
    status: "answered",
    answer,
    citations: [first.citation_id],
  });
}

/**
 * A provider-free structured-output port shared by answer composition and the
 * related-atom projector. It derives output solely from each current
 * request: planner question, answer evidence aliases, or projector input.
 */
export function createCoreDeterministicStructuredGenerationPort() {
  return Object.freeze({
    async generate(input) {
      const properties = record(record(record(input)?.schema)?.properties);
      if (properties === null || typeof input?.user_prompt !== "string") {
        throw new Error("deterministic structured generation input is invalid");
      }
      if (Object.hasOwn(properties, "queries")) return plannerResponse(input.user_prompt);
      if (Object.hasOwn(properties, "status") && Object.hasOwn(properties, "citations")) {
        return answerResponse(input.user_prompt);
      }
      if (Object.hasOwn(properties, "relationships")) {
        // No relation can be inferred safely from lexical overlap alone.
        return Object.freeze({ relationships: [] });
      }
      throw new Error("deterministic structured generation schema is unsupported");
    },
  });
}

/**
 * Open real current-Person search and answer routes over a verified stopped
 * Authority state. The returned projector binding must also be passed to the
 * real reconciler that publishes the generation this route reads.
 */
export function createCoreReadRoutes({ state_directory, sessions } = {}) {
  text(state_directory, "state_directory");
  if (sessions === null || typeof sessions !== "object" || typeof sessions.authenticateAccess !== "function") {
    throw new TypeError("sessions must be the real core identity application");
  }
  const generation = ANSWER_PROFILE;
  const structured_output = createCoreDeterministicStructuredGenerationPort();
  const related_atom_projector = Object.freeze({
    structured_output,
    profile: Object.freeze({
      generation_adapter_id: generation.generation_adapter_id,
      model: generation.planner_model,
      timeout_ms: generation.timeout_ms,
    }),
  });
  const lineage = verifyAuthorityStateLineage(state_directory);
  let authority;
  let recordDatabase;
  try {
    authority = openAuthorityDatabase(join(state_directory, "authority.sqlite"), { fileMustExist: true });
    recordDatabase = openOrganizationRecordDatabase(join(state_directory, "record-log.sqlite"), { fileMustExist: true });
    const contract = readableSearchGenerationContractV1({
      related_atom_projector: related_atom_projector.profile,
    });
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
      expand_related_atoms: expandReadableSearchRelatedAtomsV1,
    });
    const answer = createPersonAnswerRouteV1({
      authority_id: lineage.root.authority_id,
      organization_id: lineage.root.organization_id,
      state_lineage_id: lineage.root.state_lineage_id,
      search,
      model: structured_output,
      generation,
      audit: new SqlitePersonAnswerCompositionAuditV1(authority),
    });
    return Object.freeze({
      search,
      answer,
      related_atom_projector,
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
