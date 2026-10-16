import type Database from 'better-sqlite3';
import { canonicalJson, sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import { PERSON_CHANGES_CHECK_SECONDS_V1, PERSON_CHANGES_KIND_V1, validatePersonChangesV1, type PersonChangesV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { SqliteImpactItemsV1 } from '../adapters/persistence/sqlite/impact-items-v1.js';
import type { SqliteOpenItemPeopleV1 } from '../adapters/persistence/sqlite/open-item-people-v1.js';
import type { SqliteProjectContextRepositoryV1 } from '../adapters/persistence/sqlite/project-context-v1.js';
import type { PersonChangesHttpApplicationV1 } from '../presentation/person-changes-http-application.js';
import type { PersonReviewStatusesV1 } from './person-meeting-runtime-v1.js';
import { errorCodeV1, observeEventV1, openItemViewerV1, visiblePersonalOpenItemsV1 } from './person-open-items-v1.js';
import { recordProjectAuthorizationOfGrantsV1 } from './person-record-project-scope-v1.js';
import type { PersonReadableDecisionProjectsV1 } from './person-record-search-route.js';

/**
 * The change check (desktop refresh and notifications v1, section 1;
 * ADR-0036): `GET /v1/person/changes` answers one fingerprint per area of the
 * caller's own view, and no content. The route authenticates the caller
 * before it asks.
 *
 * Each fingerprint is the canonical SHA-256 of a sorted array of tuples, built
 * only from rows the caller may read, through the same policy as the read the
 * area stands for. It moves only with activity the caller can see (ADR-0012):
 * no global position, counter or revision goes into it.
 *
 * - `projects`: `[project_id, name, status, role]` for every project the V2
 *   project list pages through for the caller, active and archived.
 * - `follow_ups`: `[item_id, state, owner_membership_id, owner_set_at,
 *   state_set_at, sent_at]` for every item `runs` `items` `involved` shows:
 *   the items the caller sent, owns or last handed on, after the same
 *   rows-only policy pass, with no bound before that pass. A check
 *   (`checked_*`) is left out, so a sweep wakes no desktop.
 * - `reviews`: `[approval_id, status]` for each meeting `tools` `meetings`
 *   `reviews` lists for the caller. Reviews that cannot be read just now are
 *   none (the digest of `[]`), and are reported; the other areas still answer.
 *
 * The check reads the Authority database in one Authority read transaction
 * (the record check reads the record log on its own connection, as every
 * record read does): no `BEGIN IMMEDIATE`, no live tool read and no audit row,
 * since it releases nothing. It answers the contract's default wait.
 */
export interface CreatePersonChangesV1Options {
  /** The Authority database every source below reads; the check's one read transaction is opened on it. */
  readonly database: Database.Database;
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly projects: Pick<SqliteProjectContextRepositoryV1, 'personChangeView'>;
  readonly items: Pick<SqliteImpactItemsV1, 'involving'>;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'people' | 'leadsAny'>;
  readonly records: PersonReadableDecisionProjectsV1;
  /** The meetings waiting for a person's review, once a personal meeting runtime is composed; none otherwise. */
  readonly reviews?: () => Promise<PersonReviewStatusesV1>;
  /** Where reviews that could not be read are reported; one content-free line of JSON on standard error by default. */
  readonly on_reviews_failure?: (event: PersonChangesReviewsFailureV1) => void;
}
/** Reviews the check could not read: where it failed and the error's Authority code (`error` otherwise), nothing else. */
export interface PersonChangesReviewsFailureV1 { readonly kind: 'person_changes_reviews'; readonly reason: 'ready' | 'read'; readonly code: string }

/** One area's fingerprint: the SHA-256 of the canonical JSON array of its tuples in canonical order, each tuple canonicalized once. */
function fingerprint(tuples: readonly (readonly (string | null)[])[]): Sha256Digest {
  return sha256Digest(`[${tuples.map(tuple => canonicalJson(tuple)).sort().join(',')}]`);
}

export function createPersonChangesV1(options: CreatePersonChangesV1Options): PersonChangesHttpApplicationV1 {
  const report = (reason: PersonChangesReviewsFailureV1['reason'], error: unknown): void =>
    observeEventV1(options.on_reviews_failure, Object.freeze({ kind: 'person_changes_reviews' as const, reason, code: errorCodeV1(error) }));
  /** The reviews reader, or none when there is no meeting runtime or it cannot be made ready just now. */
  const reviewsReader = async (): Promise<PersonReviewStatusesV1 | undefined> => {
    if (options.reviews === undefined) return undefined;
    try { return await options.reviews(); } catch (error) { report('ready', error); return undefined; }
  };
  const reviewTuples = (reader: PersonReviewStatusesV1 | undefined, person: PersonAccessAuthorization): (readonly string[])[] => {
    if (reader === undefined) return [];
    try { return reader(person).map(review => [review.approval_id, review.status]); } catch (error) { report('read', error); return []; }
  };
  return Object.freeze({
    async read(input: Parameters<PersonChangesHttpApplicationV1['read']>[0]): Promise<PersonChangesV1> {
      input.signal?.throwIfAborted();
      // The approval core is made ready first; everything after it reads synchronously, inside the one read transaction.
      const reviewsOf = await reviewsReader();
      input.signal?.throwIfAborted();
      if (options.database.inTransaction) throw new Error('The change check opens its own read transaction');
      const areas = options.database.transaction(() => {
        const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
        const view = options.projects.personChangeView(authorization);
        // The record check reads the grants just read here: a capture of its own would need a transaction of its own.
        const projects = recordProjectAuthorizationOfGrantsV1(view.grants);
        const records = { readableDecisions: (lookup: { readonly access_token: string; readonly record_sha256s: readonly Sha256Digest[] }) => options.records.readableDecisionProjects({ ...lookup, projects }) };
        const viewer = openItemViewerV1(input.access_token, authorization);
        const involved = visiblePersonalOpenItemsV1({ items: options.items, records, people: options.people }, viewer, 'involved').assessed;
        return {
          projects: fingerprint(view.projects.map(project => [project.project_id, project.name, project.status, project.role])),
          follow_ups: fingerprint(involved.map(({ row }) => [row.item_id, row.state, row.owner_membership_id, row.owner_set_at, row.state_set_at, row.sent_at])),
          reviews: fingerprint(reviewTuples(reviewsOf, authorization)),
        };
      }).deferred();
      try {
        return validatePersonChangesV1({ kind: PERSON_CHANGES_KIND_V1, areas, check_again_after_seconds: PERSON_CHANGES_CHECK_SECONDS_V1.default });
      } catch {
        throw new AuthorityOperationError('invalid_output', 'change check response is invalid');
      }
    },
  });
}
