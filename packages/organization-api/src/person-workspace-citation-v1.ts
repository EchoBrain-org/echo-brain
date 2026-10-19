import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertId, assertPatternString, fail } from './validation.js';

/**
 * What ECHO holds about a person's workspace, and the containers of the tools
 * they connected, as Ask evidence (research tool contract v1). Each citation
 * names its object and nothing else: what it says is read again, under the
 * viewer's own access, wherever it is shown.
 */

/** A project the asker belongs to. Opens the project in ECHO. */
export interface PersonProjectCitationV1 {
  readonly kind: 'project';
  readonly project_id: ProjectIdV1;
}

/** A member of the asker's organization, as its directory names them. Opens nothing. */
export interface PersonMemberCitationV1 {
  readonly kind: 'person';
  readonly membership_id: string;
}

/** One of the asker's tools and its connection, as the person tools list names it. Opens the tools page. */
export interface PersonToolCitationV1 {
  readonly kind: 'tool';
  readonly tool_id: string;
}

/** The kinds of container a connected tool holds its items in. */
export type PersonToolContainerKindV1 = 'jira_project' | 'confluence_space' | 'slack_channel';
export const PERSON_TOOL_CONTAINER_KINDS_V1: readonly PersonToolContainerKindV1[] = Object.freeze(['jira_project', 'confluence_space', 'slack_channel']);

/**
 * A container in a connected tool: a Jira project, a Confluence space or a
 * Slack channel. Opens its permalink in the tool.
 */
export interface PersonToolContainerCitationV1 {
  readonly kind: 'tool_container';
  readonly tool_id: string;
  readonly external_scope_id: string;
  readonly container: PersonToolContainerKindV1;
  /** Provider-stable container identity, never a title or URL. */
  readonly container_id: string;
  /** Display link only. The provider validates its own tenant and coordinates. */
  readonly permalink: string;
}

export type PersonWorkspaceCitationV1 = PersonProjectCitationV1 | PersonMemberCitationV1 | PersonToolCitationV1 | PersonToolContainerCitationV1;
export const PERSON_WORKSPACE_CITATION_KINDS_V1 = Object.freeze(['project', 'person', 'tool', 'tool_container'] as const);

const TOOL_ID = /^[a-z][a-z0-9-]*$/;
const LINE = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u;
const PERMALINK = /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/[^\s\\\p{Cc}]*$/u;

function line(value: unknown, label: string): asserts value is string {
  assertPatternString(value, label, 256, LINE);
  if (value !== value.normalize('NFC')) fail(`${label} is not normalized`);
}

/**
 * A display link: https, a host, no credentials, query or fragment, and already in the form the URL parser writes it, as
 * the desktop opens it (no upper-case host, default port or dot segment). Never a fetch target.
 */
function permalink(value: unknown): asserts value is string {
  assertPatternString(value, 'permalink', 2048, PERMALINK);
  const Url = (globalThis as unknown as { URL?: new (input: string) => { href: string; protocol: string; hostname: string; username: string; password: string; search: string; hash: string } }).URL;
  if (Url === undefined) fail('Tool container citation URL parser is unavailable');
  let url: InstanceType<typeof Url>;
  try { url = new Url(value); } catch { fail('Tool container citation permalink is invalid'); }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.href !== value) {
    fail('Tool container citation permalink is invalid');
  }
}

/** Whether a cited object is a workspace item or a tool container, which only the V8 answer admits. */
export function isPersonWorkspaceCitationV1(value: { readonly kind: string }): value is PersonWorkspaceCitationV1 {
  return (PERSON_WORKSPACE_CITATION_KINDS_V1 as readonly string[]).includes(value.kind);
}

export function validatePersonWorkspaceCitationV1(value: unknown): PersonWorkspaceCitationV1 {
  const r = asEnumerableRecord(value, 'Workspace citation');
  switch (r.kind) {
    case 'project':
      assertExactKeys(r, ['kind', 'project_id'], 'Project citation');
      return Object.freeze({ kind: 'project', project_id: validateProjectIdV1(r.project_id, 'Project citation project_id') });
    case 'person':
      assertExactKeys(r, ['kind', 'membership_id'], 'Person citation');
      assertId(r.membership_id, 'mem', 'Person citation membership_id');
      return Object.freeze({ kind: 'person', membership_id: r.membership_id as string });
    case 'tool':
      assertExactKeys(r, ['kind', 'tool_id'], 'Tool citation');
      assertPatternString(r.tool_id, 'tool_id', 64, TOOL_ID);
      return Object.freeze({ kind: 'tool', tool_id: r.tool_id });
    case 'tool_container': {
      assertExactKeys(r, ['kind', 'tool_id', 'external_scope_id', 'container', 'container_id', 'permalink'], 'Tool container citation');
      assertPatternString(r.tool_id, 'tool_id', 64, TOOL_ID);
      line(r.external_scope_id, 'external_scope_id');
      if (typeof r.container !== 'string' || !(PERSON_TOOL_CONTAINER_KINDS_V1 as readonly string[]).includes(r.container)) fail('Tool container citation container is invalid');
      line(r.container_id, 'container_id');
      permalink(r.permalink);
      return Object.freeze({ kind: 'tool_container', tool_id: r.tool_id, external_scope_id: r.external_scope_id, container: r.container as PersonToolContainerKindV1, container_id: r.container_id, permalink: r.permalink });
    }
    default:
      return fail('Workspace citation kind is invalid');
  }
}
