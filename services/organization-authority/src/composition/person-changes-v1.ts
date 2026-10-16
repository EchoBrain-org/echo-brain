import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_CHANGES_CHECK_SECONDS_V1, PERSON_CHANGES_KIND_V1, validatePersonChangesV1, type PersonChangesV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import type { SqliteProjectContextRepositoryV1 } from '../adapters/persistence/sqlite/project-context-v1.js';
import type { PersonChangesHttpApplicationV1 } from '../presentation/person-changes-http-application.js';
import type { PersonReviewStatusesV1 } from './person-meeting-runtime-v1.js';
import { assessOpenItemsV1, openItemViewerV1, personalOpenItemRowsV1 } from './person-open-items-v1.js';
import { recordProjectAuthorizationOfGrantsV1 } from './person-record-project-scope-v1.js';
import type { PersonReadableDecisionsV1 } from './person-record-search-route.js';

/**
 * The change check (desktop refresh and notifications v1, section 1;
 * ADR-0036): `GET /v1/person/changes` answers one fingerprint per area of the
 * caller's own view, and no content.
 *
 * Each fingerprint is the canonical SHA-256 of a sorted array of tuples, built
 * only from rows the caller may read, through the same policy as the read the
 * area stands for. It moves only with activity the caller can see (ADR-0012):
 * no global position, counter or revision goes into it.
 *
 * - `projects`: `[project_id, name, status, role]` for every project the V2
 *   project list pages through for the caller, active and archived.
 * - `follow_ups`: `[item_id, state, owner_membership_id, owner_set_at,
 *   state_set_at, sent_at]` for every row `runs` `items` `involved` lists:
 *   the items the caller sent, owns or last handed on, after the same
 *   rows-only policy pass. A check (`checked_*`) is left out, so a sweep wakes
 *   no desktop.
 * - `reviews`: `[approval_id, status]` for each meeting `tools` `meetings`
 *   `reviews` lists for the caller.
 *
 * The check reads only the Authority database (and the record log the record
 * check reads), in one read transaction: no `BEGIN IMMEDIATE`, no live tool
 * read and no audit row, since it releases nothing.
 */
export interface CreatePersonChangesV1Options {
  /** The Authority database every source below reads; the check's one read transaction is opened on it. */
  readonly database: Database.Database;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly projects: Pick<SqliteProjectContextRepositoryV1, 'personChangeView'>;
  readonly items: Pick<SqliteImpactItemsV1, 'involving'>;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  readonly records: Pick<PersonReadableDecisionsV1, 'readableDecisions'>;
  /** The meetings waiting for a person's review, once a personal meeting runtime is composed; none otherwise. */
  readonly reviews?: () => Promise<PersonReviewStatusesV1>;
  /** How long the client waits before it checks again: 60 s unless the server is set to ask for longer (15..3600). */
  readonly check_again_after_seconds?: number;
}

/** One area's fingerprint: the canonical SHA-256 of its tuples in canonical order, so the order rows are read in never moves it. */
function fingerprint(tuples: readonly (readonly (string | null)[])[]): Sha256Digest {
  const keyed = tuples.map(tuple => ({ tuple, key: canonicalJson(tuple) }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return canonicalSha256(keyed.map(entry => entry.tuple));
}

function checkAgainAfter(value: number | undefined): number {
  const seconds = value ?? PERSON_CHANGES_CHECK_SECONDS_V1.default;
  if (!Number.isSafeInteger(seconds) || seconds < PERSON_CHANGES_CHECK_SECONDS_V1.min || seconds > PERSON_CHANGES_CHECK_SECONDS_V1.max) {
    throw new Error('The change check wait must be a whole number of seconds within 15..3600');
  }
  return seconds;
}

export function createPersonChangesV1(options: CreatePersonChangesV1Options): PersonChangesHttpApplicationV1 {
  const check_again_after_seconds = checkAgainAfter(options.check_again_after_seconds);
  return Object.freeze({
    async read(input: Parameters<PersonChangesHttpApplicationV1['read']>[0]): Promise<PersonChangesV1> {
      input.signal?.throwIfAborted();
      // The approval core is made ready first; everything after it reads synchronously, inside the one read transaction.
      const reviewsOf = options.reviews === undefined ? undefined : await options.reviews();
      input.signal?.throwIfAborted();
      if (options.database.inTransaction) throw new Error('The change check opens its own read transaction');
      const areas = options.database.transaction(() => {
        const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
        const view = options.projects.personChangeView(authorization);
        // The record check reads the grants just read here: a capture of its own would need a transaction of its own.
        const grants = recordProjectAuthorizationOfGrantsV1(view.grants);
        const records = { readableDecisions: (lookup: { readonly access_token: string; readonly record_sha256s: readonly Sha256Digest[] }) => options.records.readableDecisions({ ...lookup, projects: grants }) };
        const viewer = openItemViewerV1(input.access_token, authorization);
        const involved = assessOpenItemsV1({ records, people: options.people }, viewer, personalOpenItemRowsV1(options.items, viewer, 'involved'))
          .assessed.filter(entry => entry.access.see_row);
        return {
          projects: fingerprint(view.projects.map(project => [project.project_id, project.name, project.status, project.role])),
          follow_ups: fingerprint(involved.map(({ row }) => [row.item_id, row.state, row.owner_membership_id, row.owner_set_at, row.state_set_at, row.sent_at])),
          reviews: fingerprint((reviewsOf?.(authorization) ?? []).map(review => [review.approval_id, review.status])),
        };
      }).deferred();
      try {
        return validatePersonChangesV1({ kind: PERSON_CHANGES_KIND_V1, areas, check_again_after_seconds });
      } catch {
        throw new AuthorityOperationError('invalid_output', 'change check response is invalid');
      }
    },
  });
}
