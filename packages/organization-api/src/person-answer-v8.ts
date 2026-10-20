import type { PersonAnswerCitationV4, PersonAnswerResponseV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV7, PersonAnswerOpenRefV7, PersonEvidenceKindV4 } from './person-answer-v7.js';
import { validateProjectIdV1 } from './project-context-v1.js';
import type { PersonProjectCitationV1, PersonToolCitationV1, PersonWorkspaceCitationV1 } from './person-workspace-citation-v1.js';
import { assertToolId, fail } from './validation.js';

/**
 * V8 adds workspace and tool-container citations (research tool contract
 * v1): the asker's projects, the people in their organization, their tools,
 * and the Jira projects and Confluence spaces of the tools they connected.
 * The V3 request shape is unchanged. A matched response on this path carries
 * `PERSON_ANSWER_ROUTE_HEADER_V5` with the value `7`.
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
  /** A project and a tool always carry theirs; a person and a tool container never carry one. */
  readonly ref?: PersonAnswerOpenRefV8;
  /**
   * Only on a tool container that has one: its key in its tool, such as a Jira project key or a Confluence space key.
   * Display text shown beside its label, as the label is; never part of what the citation names.
   */
  readonly key?: string;
}
export interface PersonAnswerResponseV8 extends Omit<PersonAnswerResponseV4, 'schema_version' | 'kind' | 'citations'> {
  readonly schema_version: 8;
  readonly kind: 'echo-clean-person-answer-v8';
  readonly citations: readonly PersonAnswerCitationV8[];
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
