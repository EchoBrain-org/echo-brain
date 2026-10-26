import type Database from 'better-sqlite3';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  PERSON_PROJECT_ACTIVITY_KIND_V1,
  PERSON_PROJECT_ACTIVITY_LIMITS_V1,
  validatePersonProjectActivityV1,
  type PersonProjectActivityV1,
  type ProjectIdV1,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import type { SqlitePersonProjectActivityV1 } from '../adapters/persistence/sqlite/person-project-activity-v1.js';
import type { SqliteProjectContextRepositoryV1 } from '../adapters/persistence/sqlite/project-context-v1.js';
import type { PersonProjectActivityHttpApplicationV1 } from '../presentation/person-project-activity-http-application.js';
import { assessOpenItemsV1, openItemDecisionsReaderV1, openItemViewerV1, type OpenItemDecisionsReaderV1, type OpenItemViewerV1 } from './person-open-items-v1.js';
import { recordProjectAuthorizationOfGrantsV1 } from './person-record-project-scope-v1.js';
import type { PersonProjectRecordActivityV1, PersonReadableDecisionProjectsV1, PersonReadableDecisionV1 } from './person-record-search-route.js';

/**
 * Project activity (Ask timeline v1, C2; ADR-0047): `GET /v1/person/project-activity` answers, for every active project the
 * caller is a member of (newest first, as the project list pages them, at most 500), when something last arrived in it from
 * someone else, or null, and no content. The route authenticates the caller before it asks.
 *
 * `latest_at` is the newest of these, each counted only from rows the caller reads now, through the same policy as the
 * project page that lists them:
 * - a note filed into the project by someone else (`associated_at`), under the person list's ACL;
 * - a document filed into it by someone else (`associated_at`), under the same ACL;
 * - a meeting record filed into it that the caller reads (the exact Layer 1 check) and did not approve (its receipt time);
 * - a follow-up of the project's newest 500 records (the records its follow-ups list reads) that someone else sent, or whose
 *   owner or state someone else set last (`sent_at`, `owner_set_at`, `state_set_at`), of the rows the open-items policy shows
 *   the caller with their decision. The store returns only rows someone else moved, with when, newest move first, a page at a
 *   time, so the first row the policy pass shows is the newest.
 * Only a project's newest 500 filed records count: its meetings past them, and their follow-ups, never light it.
 * Live Jira and Confluence edits never count, and no global position, counter or revision goes into it: it moves only with
 * activity the caller can see (ADR-0012, ADR-0036).
 *
 * The read takes the Authority database in one read transaction (the record log on its own connection, as every record read
 * does): no `BEGIN IMMEDIATE`, no live tool read and no audit row, since it releases nothing.
 */
export interface CreatePersonProjectActivityV1Options {
  /** The Authority database every source below reads; the read's one read transaction is opened on it. */
  readonly database: Database.Database;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly projects: Pick<SqliteProjectContextRepositoryV1, 'personChangeView'>;
  /** Notes and documents filed into the projects. */
  readonly originals: Pick<SqlitePersonProjectActivityV1, 'originals'>;
  /** The records the caller's own published approvals name. */
  readonly approvals: Pick<SqlitePersonProjectActivityV1, 'approvedRecords'>;
  readonly items: Pick<SqliteImpactItemsV1, 'movedByOthers'>;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  readonly records: PersonProjectRecordActivityV1 & PersonReadableDecisionProjectsV1;
}

const PROJECTS_MAX = PERSON_PROJECT_ACTIVITY_LIMITS_V1.items;
/** The follow-ups someone else moved, read a page at a time, newest move first. */
const MOVES_PAGE = 50;

export function createPersonProjectActivityV1(options: CreatePersonProjectActivityV1Options): PersonProjectActivityHttpApplicationV1 {
  /**
   * The newest move by someone else among the follow-ups of these records filed in this project, of the rows the open-items
   * policy shows the viewer together with their decision: an owner who cannot read the decision sees the row, never which
   * project it is filed in. The store returns only rows someone else moved, each with when it last did (`moved_at`), newest
   * move first, a page at a time, so the first row the policy shows is the newest. Usually the first page has one; a page
   * whose rows the viewer cannot see moves on to the next.
   */
  const followUpsAt = (viewer: OpenItemViewerV1, projectId: ProjectIdV1, records: readonly Sha256Digest[], decisions: OpenItemDecisionsReaderV1<Pick<PersonReadableDecisionV1, 'project_ids'>>): string | null => {
    if (records.length === 0) return null;
    for (let after: { readonly moved_at: string; readonly item_id: string } | undefined; ;) {
      const page = options.items.movedByOthers(viewer.organization, viewer.membership, records, { limit: MOVES_PAGE, ...(after === undefined ? {} : { after }) });
      const last = page.at(-1);
      if (last === undefined) return null;
      const context = assessOpenItemsV1({ records: decisions, people: options.people }, viewer, page.map(entry => entry.row));
      const shown = new Set(context.assessed.flatMap(({ row, access }) =>
        access.see_row && access.see_decision && context.decisions.get(row.record_sha256)?.project_ids.includes(projectId) === true ? [row.item_id] : []));
      const newest = page.find(entry => shown.has(entry.row.item_id));
      if (newest !== undefined) return newest.moved_at;
      if (page.length < MOVES_PAGE) return null;
      after = { moved_at: last.moved_at, item_id: last.row.item_id };
    }
  };

  return Object.freeze({
    async read(input: Parameters<PersonProjectActivityHttpApplicationV1['read']>[0]): Promise<PersonProjectActivityV1> {
      input.signal?.throwIfAborted();
      if (options.database.inTransaction) throw new Error('The project activity read opens its own read transaction');
      const items = options.database.transaction(() => {
        const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
        const view = options.projects.personChangeView(authorization);
        const active = view.projects.filter(project => project.status === 'active').slice(0, PROJECTS_MAX);
        const ids = active.map(project => project.project_id);
        const latest = new Map<string, string | null>(ids.map(id => [id, null]));
        const arrived = (projectId: string, at: string | null): void => {
          const current = latest.get(projectId);
          if (at !== null && current !== undefined && (current === null || at > current)) latest.set(projectId, at);
        };
        for (const [projectId, at] of options.originals.originals(authorization, ids)) arrived(projectId, at);
        // The record checks read the grants just read here: a capture of their own would need a transaction of its own.
        const projects = recordProjectAuthorizationOfGrantsV1(view.grants);
        const filed = options.records.projectRecordActivity({
          access_token: input.access_token, projects, project_ids: ids, own: options.approvals.approvedRecords(authorization),
        });
        const viewer = openItemViewerV1(input.access_token, authorization);
        // Which records the viewer reads, from the grants read in the read's own transaction; each looked up once per read.
        const decisions = openItemDecisionsReaderV1(options.records, input.access_token, () => projects);
        for (const { project_id } of active) {
          const records = filed.get(project_id);
          if (records === undefined) continue;
          arrived(project_id, records.meeting_at);
          arrived(project_id, followUpsAt(viewer, project_id, records.filed, decisions));
        }
        return active.map(project => ({ project_id: project.project_id, latest_at: latest.get(project.project_id) ?? null }));
      }).deferred();
      try {
        return validatePersonProjectActivityV1({ schema_version: 1, kind: PERSON_PROJECT_ACTIVITY_KIND_V1, items });
      } catch {
        throw new AuthorityOperationError('invalid_output', 'project activity response is invalid');
      }
    },
  });
}
