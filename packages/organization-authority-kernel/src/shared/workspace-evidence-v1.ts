import type { EvidenceSourceCapabilitiesV1, PersonLiveSourceDescriptorV2 } from './evidence-desk-v2.js';

/**
 * The asker's workspace as Ask sources (research tool contract v1): the
 * projects they belong to, the people in their organization, and their tools.
 * These are the kernel-facing names and descriptors; the sources themselves,
 * their visibility and their audits are server composition.
 */

/** The first Ask response version whose citations admit a workspace item or a tool container. */
export const WORKSPACE_MINIMUM_RESPONSE_VERSION_V1 = 8 as const;

export type WorkspaceSourceIdV1 = 'projects' | 'people' | 'tools';
export const WORKSPACE_SOURCE_IDS_V1: readonly WorkspaceSourceIdV1[] = Object.freeze(['projects', 'people', 'tools']);
/** The desk item kind of each workspace source. */
export const WORKSPACE_SOURCE_KINDS_V1 = Object.freeze({ projects: 'project', people: 'person', tools: 'tool' } as const satisfies Record<WorkspaceSourceIdV1, 'project' | 'person' | 'tool'>);

/**
 * A workspace source's descriptor. Request-bound like follow-ups: ECHO's own
 * state, read as the asker, with no tool of its own. Its list is not metadata
 * only: an item carries its fields as text.
 */
export interface WorkspaceSourceDescriptorV1 extends Omit<PersonLiveSourceDescriptorV2, 'source_id' | 'kind' | 'selector' | 'tool_id' | 'capabilities'> {
  readonly source_id: WorkspaceSourceIdV1;
  readonly kind: (typeof WORKSPACE_SOURCE_KINDS_V1)[WorkspaceSourceIdV1];
  readonly selector: WorkspaceSourceIdV1;
  readonly capabilities: EvidenceSourceCapabilitiesV1;
}

export const PROJECTS_SOURCE_DESCRIPTOR_V1: WorkspaceSourceDescriptorV1 = Object.freeze({
  source_id: 'projects', kind: 'project', selector: 'projects', metadata_only_list: false,
  description: "Projects the asker belongs to: each project's name, whether it is active or archived, the asker's role in it, and its leads and members.",
  capabilities: Object.freeze({
    filters: Object.freeze({ status: Object.freeze(['active', 'archived']), role: Object.freeze(['lead', 'member']) }),
    dates: Object.freeze({ created: 'when the project was created in ECHO; every project has it' }),
    any_date: true,
    // A project's Jira project and Confluence spaces are their own sources, which name the projects mapped to them.
    links: Object.freeze(['members']),
  }),
});

export const PEOPLE_SOURCE_DESCRIPTOR_V1: WorkspaceSourceDescriptorV1 = Object.freeze({
  source_id: 'people', kind: 'person', selector: 'people', metadata_only_list: false,
  description: "People in the asker's organization, as its directory names them, with the projects they share with the asker and their role in each.",
  capabilities: Object.freeze({ filters: Object.freeze({}), dates: Object.freeze({}), any_date: false, links: Object.freeze(['projects']) }),
});

export const TOOLS_SOURCE_DESCRIPTOR_V1: WorkspaceSourceDescriptorV1 = Object.freeze({
  source_id: 'tools', kind: 'tool', selector: 'tools', metadata_only_list: false,
  description: "The asker's tools, such as Jira, Confluence and Slack, and whether the asker has connected each one.",
  capabilities: Object.freeze({ filters: Object.freeze({}), dates: Object.freeze({}), any_date: false, links: Object.freeze([]) }),
});
