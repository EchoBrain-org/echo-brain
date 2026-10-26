import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, assertExactKeys, assertTimestamp, assertUnique, boundedList, fail } from './validation.js';

/**
 * Project activity (Ask timeline v1, C2; ADR-0047). A signed-in person asks
 * when something last arrived in each of their active projects from someone
 * else: a meeting record approved into it, a note or document added to it, or
 * a follow-up of its meetings whose owner, state or sent time moved. Each
 * counts only when the person can read it, so a time moves only with activity
 * they can see (ADR-0012, ADR-0036). Live Jira and Confluence edits never
 * count. It returns no content: the desktop marks a project whose time is after
 * the person last opened it.
 */
export const PERSON_PROJECT_ACTIVITY_PATH_V1 = '/v1/person/project-activity';
export const PERSON_PROJECT_ACTIVITY_KIND_V1 = 'echo-person-project-activity-v1';
/** One item per project, each project once, at most this many. */
export const PERSON_PROJECT_ACTIVITY_LIMITS_V1 = Object.freeze({ items: 500 });

export interface PersonProjectActivityItemV1 {
  readonly project_id: ProjectIdV1;
  /** The newest time something arrived from someone else that the caller can read, or null. */
  readonly latest_at: string | null;
}
export interface PersonProjectActivityV1 {
  readonly schema_version: 1;
  readonly kind: typeof PERSON_PROJECT_ACTIVITY_KIND_V1;
  /** Every active project the caller is a member of, at most 500. */
  readonly items: readonly PersonProjectActivityItemV1[];
}

export function validatePersonProjectActivityV1(value: unknown): PersonProjectActivityV1 {
  const record = asEnumerableRecord(value, 'Person project activity');
  assertExactKeys(record, ['schema_version', 'kind', 'items'], 'Person project activity');
  if (record.schema_version !== 1 || record.kind !== PERSON_PROJECT_ACTIVITY_KIND_V1) fail('Person project activity version or kind is unsupported');
  const items = boundedList(record.items, 'Person project activity items', PERSON_PROJECT_ACTIVITY_LIMITS_V1.items).map(entry => {
    const item = asEnumerableRecord(entry, 'Person project activity item');
    assertExactKeys(item, ['project_id', 'latest_at'], 'Person project activity item');
    const project_id = validateProjectIdV1(item.project_id, 'Person project activity project_id');
    if (item.latest_at !== null) assertTimestamp(item.latest_at, 'Person project activity latest_at');
    return Object.freeze({ project_id, latest_at: item.latest_at as string | null });
  });
  assertUnique(items.map(item => item.project_id), 'Person project activity items');
  return Object.freeze({ schema_version: 1, kind: PERSON_PROJECT_ACTIVITY_KIND_V1, items: Object.freeze(items) });
}
