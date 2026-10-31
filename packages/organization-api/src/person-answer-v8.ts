import type { PersonAnswerScopeV3 } from './person-answer-v3.js';
import type { PersonAnswerCitationV4, PersonAnswerEvidenceCitationV4, PersonAnswerPartV4, PersonAnswerStatementV4, PersonEvidenceKindV1 } from './person-answer-v4.js';
import type { PersonAnswerChoiceV1, PersonAnswerSinceV1 } from './person-answer-previous-v1.js';
import type { PersonFollowUpCitationV1, PersonFollowUpRefV1 } from './person-follow-up-evidence-v1.js';
import type { PersonItemRefV1 } from './person-list-v1.js';
import type { PersonPageCitationV1 } from './person-page-citation-v1.js';
import type { PersonTicketCitationV1 } from './person-ticket-citation-v1.js';
import { validateProjectIdV1 } from './project-context-v1.js';
import type { PersonProjectCitationV1, PersonToolCitationV1, PersonWorkspaceCitationV1 } from './person-workspace-citation-v1.js';
import { assertToolId, fail } from './validation.js';

/**
 * The Ask route, with the V8 answer: the only one, since the routes before it (`/v3` to `/v6`, the V4 to V7 answers)
 * were retired. V8 added workspace and tool-container citations (research tool contract v1): the asker's projects, the
 * people in their organization, their tools, and the Jira projects and Confluence spaces of the tools they connected.
 * Its request is the V3 request.
 */
export const PERSON_ANSWER_PATH_V7 = '/v7/person/ask';
/**
 * Present, with the value `7`, on every response the `/v7` route gives, provider and application errors included, so a
 * client tells the route's own 404 from an Authority that has no `/v7`.
 */
export const PERSON_ANSWER_ROUTE_HEADER_V5 = 'x-echo-person-ask-route';
/**
 * Ticket citations, which the V5 answer added. That answer and its route, `/v4/person/ask`, were retired; an impact
 * card's V6 citations and the V8 answer's build on these.
 */
export type PersonEvidenceKindV2 = PersonEvidenceKindV1 | 'ticket';
export type PersonAnswerEvidenceCitationV5 = PersonAnswerEvidenceCitationV4 | PersonTicketCitationV1;
/**
 * Live page citations, which the V6 answer added. That answer and its route, `/v5/person/ask`, were retired; a V6
 * citation is what an impact card cites (person-impact-card-v1.ts), and the V8 answer's citations build on it.
 */
export type PersonEvidenceKindV3 = PersonEvidenceKindV2 | 'page';
export type PersonAnswerEvidenceCitationV6 = PersonAnswerEvidenceCitationV5 | PersonPageCitationV1;
export interface PersonAnswerCitationV6 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV6;
  readonly kind: PersonEvidenceKindV3;
}
/**
 * Follow-up citations (ADR-0040), which the V7 answer added. That answer and its route, `/v6/person/ask`, were retired;
 * the V8 answer's citations build on these.
 */
export type PersonEvidenceKindV4 = PersonEvidenceKindV3 | 'follow_up';
export type PersonAnswerEvidenceCitationV7 = PersonAnswerEvidenceCitationV6 | PersonFollowUpCitationV1;
/** A follow-up citation always carries its follow-up ref; every other kind keeps the person-open refs of V4. */
export type PersonAnswerOpenRefV7 = PersonItemRefV1 | PersonFollowUpRefV1;
export interface PersonAnswerCitationV7 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind' | 'ref'> {
  readonly citation: PersonAnswerEvidenceCitationV7;
  readonly kind: PersonEvidenceKindV4;
  readonly ref?: PersonAnswerOpenRefV7;
}
export type PersonEvidenceKindV5 = PersonEvidenceKindV4 | 'project' | 'person' | 'tool' | 'tool_container';
export type PersonAnswerEvidenceCitationV8 = PersonAnswerEvidenceCitationV7 | PersonWorkspaceCitationV1;
/**
 * Opens a cited project in ECHO (`project:prj_…`), or the tools page at a tool (`tool:<tool_id>`). A person and a tool
 * container carry no ref: a person opens nothing, and a container opens its own permalink in its tool.
 */
export type PersonWorkspaceRefV1 = `project:prj_${string}` | `tool:${string}`;
export type PersonAnswerOpenRefV8 = PersonAnswerOpenRefV7 | PersonWorkspaceRefV1;
export interface PersonAnswerCitationV8 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind' | 'ref'> {
  readonly citation: PersonAnswerEvidenceCitationV8;
  readonly kind: PersonEvidenceKindV5;
  /** A project and a tool always carry theirs; a person and a tool container never carry one. */
  readonly ref?: PersonAnswerOpenRefV8;
  /**
   * Only on a tool container that has one: its key in its tool, such as a Jira project key or a Confluence space key.
   * Display text shown beside its label, as the label is; never part of what the citation names.
   */
  readonly key?: string;
}
/** Every outcome a V8 answer may carry. */
export const PERSON_ANSWER_OUTCOMES_V8 = Object.freeze(['answered', 'partial', 'not_found', 'clarify'] as const);
export interface PersonAnswerResponseV8 {
  readonly schema_version: 8;
  readonly kind: 'echo-clean-person-answer-v8';
  readonly scope: PersonAnswerScopeV3;
  /**
   * `clarify` answers only a follow-up that could mean more than one thing (ADR-0047): it carries `choices`, the
   * question asked, and no part or citation.
   */
  readonly outcome: (typeof PERSON_ANSWER_OUTCOMES_V8)[number];
  readonly citations: readonly PersonAnswerCitationV8[];
  readonly direct?: PersonAnswerStatementV4;
  readonly parts: readonly PersonAnswerPartV4[];
  readonly notice?: string;
  /** Only on an answer to a request that carried `previous` (ADR-0047): the full question this answer answers. */
  readonly question?: string;
  /** Only on an Ask again answer that compared with the earlier one (ADR-0047): what is different since. */
  readonly since?: PersonAnswerSinceV1;
  /** Only with outcome `clarify` (ADR-0047): one full question for each thing the follow-up could mean. */
  readonly choices?: readonly PersonAnswerChoiceV1[];
}

/** A workspace ref, exactly: `project:` and a project id, or `tool:` and a tool id. */
export function validatePersonWorkspaceRefV1(value: unknown, label = 'Workspace ref'): PersonWorkspaceRefV1 {
  if (typeof value === 'string' && value.startsWith('project:')) {
    validateProjectIdV1(value.slice('project:'.length), label);
    return value as PersonWorkspaceRefV1;
  }
  if (typeof value === 'string' && value.startsWith('tool:')) {
    assertToolId(value.slice('tool:'.length), label);
    return value as PersonWorkspaceRefV1;
  }
  return fail(`${label} is invalid`);
}

/** The ref that opens a cited project or tool. A person and a tool container have none. */
export function personWorkspaceRefV1(citation: PersonProjectCitationV1 | PersonToolCitationV1): PersonWorkspaceRefV1 {
  return validatePersonWorkspaceRefV1(citation.kind === 'project' ? `project:${citation.project_id}` : `tool:${citation.tool_id}`);
}
