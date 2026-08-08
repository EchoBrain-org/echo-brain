import type { OrganizationRecordSourceLocator } from './ports.js';

/**
 * Member-side never-ingest list. An excluded source produces no organization
 * events at all -- not even rejection acts -- because an append-only log has no
 * post-ingest erasure. Custody is member-side, so the member owns the valve;
 * an org-distributed subtractive floor is a later, additive concern.
 *
 * Matching is exact at two granularities and never pattern-based: a whole
 * source (`adapter_id` + `instance_id`), or one meeting within a source.
 */
export interface OrganizationIngestSourceExclusion {
  readonly adapter_id: string;
  readonly instance_id: string;
}

export interface OrganizationIngestMeetingExclusion {
  readonly source: OrganizationIngestSourceExclusion;
  readonly external_id: string;
}

export interface OrganizationIngestExclusionConfig {
  readonly sources: readonly OrganizationIngestSourceExclusion[];
  readonly meetings: readonly OrganizationIngestMeetingExclusion[];
}

export interface OrganizationIngestExclusion {
  excludes(source: OrganizationRecordSourceLocator): boolean;
}

function key(adapterId: string, instanceId: string): string {
  return `${JSON.stringify(adapterId)}\u0000${JSON.stringify(instanceId)}`;
}

export function createOrganizationIngestExclusion(
  config: OrganizationIngestExclusionConfig,
): OrganizationIngestExclusion {
  const excludedSources = new Set(
    config.sources.map((entry) => key(entry.adapter_id, entry.instance_id)),
  );
  const excludedMeetings = new Set(
    config.meetings.map(
      (entry) =>
        `${key(entry.source.adapter_id, entry.source.instance_id)}\u0000${JSON.stringify(entry.external_id)}`,
    ),
  );
  return Object.freeze({
    excludes(source: OrganizationRecordSourceLocator): boolean {
      const sourceKey = key(source.adapter_id, source.instance_id);
      return (
        excludedSources.has(sourceKey) ||
        excludedMeetings.has(
          `${sourceKey}\u0000${JSON.stringify(source.external_id)}`,
        )
      );
    },
  });
}
