import type { PersonAnswerCitationV4, PersonAnswerResponseV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV7, PersonAnswerOpenRefV7, PersonEvidenceKindV4 } from './person-answer-v7.js';
import type { PersonWorkspaceCitationV1 } from './person-workspace-citation-v1.js';

/**
 * V8 adds workspace and tool-container citations (research tool contract
 * v1): the asker's projects, the people in their organization, their tools,
 * and the Jira projects, Confluence spaces and Slack channels of the tools they
 * connected. The V3 request shape is unchanged. A matched response on this path
 * carries `PERSON_ANSWER_ROUTE_HEADER_V5` with the value `7`.
 */
export const PERSON_ANSWER_PATH_V7 = '/v7/person/ask';
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
  readonly ref?: PersonAnswerOpenRefV8;
}
export interface PersonAnswerResponseV8 extends Omit<PersonAnswerResponseV4, 'schema_version' | 'kind' | 'citations'> {
  readonly schema_version: 8;
  readonly kind: 'echo-clean-person-answer-v8';
  readonly citations: readonly PersonAnswerCitationV8[];
}
