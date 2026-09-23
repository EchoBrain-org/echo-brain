import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateSubmitV2, validatePersonUpdateSubmitV3, validatePersonUploadAudienceV3, type ProjectIdV1 } from '@echo-brain/organization-api';
import { sourceContentSha256V1, sourceItemIdV1 } from '@echo-brain/organization-processing/core';
import type { PersonTextSourceInboxV1, PersonTextSourceContentV1, PersonTextSourceFailureObservationV1 } from '../../../application/ports/person-text-source-v1.js';
import { PERSON_SOURCE_IDENTITY_V1 } from '../../../application/person-document-source-v1.js';

type TextRow = {
  api_version: 1 | 2 | 3; organization_id: string; principal_id: string; membership_id: string;
  request_id: string; context_id: string; title: string; text: string; payload_sha256: string;
  audience_kind: 'only_me' | 'team' | 'project' | 'projects'; audience_project_id: string | null;
  project_id: string | null; submitted_association_project_ids_json: string | null;
  audience_project_ids_json: string | null; received_at: string;
};

function canonicalIds(json: string | null, label: string): readonly ProjectIdV1[] {
  if (json === null) throw new Error(`${label} is absent`);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || canonicalJson(parsed) !== json) throw new Error();
    return Object.freeze(parsed.map((value) => {
      if (typeof value !== 'string') throw new Error();
      return value as ProjectIdV1;
    }));
  } catch { throw new Error(`${label} is invalid`); }
}

function audienceV3(row: TextRow) {
  if (row.audience_kind === 'projects') {
    return validatePersonUploadAudienceV3({ kind: 'projects', project_ids: canonicalIds(row.audience_project_ids_json, 'Audience project IDs') });
  }
  if (row.audience_kind === 'project' && row.audience_project_id !== null) return { kind: 'project' as const, project_id: row.audience_project_id as ProjectIdV1 };
  if (row.audience_kind === 'only_me' || row.audience_kind === 'team') return { kind: row.audience_kind } as const;
  throw new Error('V3 audience is invalid');
}

function policy(row: TextRow): { custody_ref: string; access_policy_ref: string } {
  const custody_ref = row.audience_kind === 'projects'
    ? `projects:${canonicalSha256(canonicalIds(row.audience_project_ids_json, 'Audience project IDs'))}`
    : row.audience_kind === 'project'
      ? `project:${row.audience_project_id}`
      : row.audience_kind === 'team'
        ? `organization:${row.organization_id}`
        : `membership:${row.membership_id}`;
  return { custody_ref, access_policy_ref: `person-text-audience:${row.context_id}` };
}

/** Pull accepted editor notes into the same Person source; their read indexes already exist. */
export class SqlitePersonTextSourceInboxV1 implements PersonTextSourceInboxV1 {
  private readonly failures: PersonTextSourceFailureObservationV1[] = [];
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}
  next(): ReturnType<PersonTextSourceInboxV1['next']> {
    const result = this.database.transaction(() => {
      const failures: PersonTextSourceFailureObservationV1[] = [];
      const current = this.database.pragma('user_version', { simple: true }) as number;
      const v2 = current >= 9
        ? `SELECT request_version AS api_version,organization_id,principal_id,membership_id,request_id,context_id,title,text,payload_sha256,audience_kind,audience_project_id,project_id,submitted_association_project_ids_json,audience_project_ids_json,received_at FROM authority_person_updates_v2`
        : `SELECT 2 AS api_version,organization_id,principal_id,membership_id,request_id,context_id,title,text,payload_sha256,audience_kind,audience_project_id,project_id,NULL AS submitted_association_project_ids_json,NULL AS audience_project_ids_json,received_at FROM authority_person_updates_v2`;
      for (let inspected = 0; inspected < 16; inspected += 1) {
        const row = this.database.prepare(`SELECT * FROM (
          SELECT 1 AS api_version,organization_id,principal_id,membership_id,request_id,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,NULL AS project_id,NULL AS submitted_association_project_ids_json,NULL AS audience_project_ids_json,received_at FROM authority_person_updates_v1
          UNION ALL ${v2}
        ) u WHERE NOT EXISTS (SELECT 1 FROM authority_sources_v1 s WHERE s.organization_id=u.organization_id AND s.adapter_id=? AND s.instance_id=? AND s.external_id=u.context_id)
          AND NOT EXISTS (SELECT 1 FROM authority_person_text_source_failures_v1 f WHERE f.organization_id=u.organization_id AND f.api_version=u.api_version AND f.context_id=u.context_id)
          AND (u.audience_kind!='only_me' OR EXISTS(SELECT 1 FROM authority_memberships m WHERE m.organization_id=u.organization_id AND m.principal_id=u.principal_id AND m.membership_id=u.membership_id AND m.status='active'))
          ORDER BY received_at,context_id LIMIT 1`).get(PERSON_SOURCE_IDENTITY_V1.adapter_id, PERSON_SOURCE_IDENTITY_V1.instance_id) as TextRow | undefined;
        if (!row) return { source: undefined, failures };
        try { return { source: this.sourceFrom(row), failures }; }
        catch {
          this.database.prepare(`INSERT INTO authority_person_text_source_failures_v1(organization_id,api_version,context_id,disposition,recorded_at) VALUES (?,?,?,'invalid_retained_text',?) ON CONFLICT(organization_id,api_version,context_id) DO NOTHING`)
            .run(row.organization_id, row.api_version, row.context_id, this.now());
          failures.push({ stage: 'text_source_admission', error_code: 'invalid_retained_text' });
        }
      }
      return { source: undefined, failures };
    }).immediate();
    this.failures.push(...result.failures);
    return result.source;
  }
  takeFailureObservations(): readonly PersonTextSourceFailureObservationV1[] { return this.failures.splice(0); }
  private sourceFrom(row: TextRow): Exclude<ReturnType<PersonTextSourceInboxV1['next']>, undefined> {
    const legacyAudience = row.audience_kind === 'project' ? { kind: 'project' as const, project_id: row.audience_project_id } : { kind: row.audience_kind };
    const request = row.api_version === 1
      ? validatePersonUpdateSubmitV1({ schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: row.request_id, title: row.title, text: row.text, visibility: row.audience_kind })
      : row.api_version === 2
        ? validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: row.request_id, title: row.title, text: row.text, audience: legacyAudience, project_id: row.project_id })
        : validatePersonUpdateSubmitV3({ schema_version: 3, kind: 'echo-person-update-submit-v3', request_id: row.request_id, title: row.title, text: row.text, association_project_ids: canonicalIds(row.submitted_association_project_ids_json, 'Association project IDs'), audience: audienceV3(row) });
    const coordinates = { organization_id: row.organization_id, membership_id: row.membership_id, request_id: row.request_id };
    const id = `ctx_${canonicalSha256(row.api_version === 1 ? coordinates : { schema_version: row.api_version, kind: `echo-person-update-source-v${row.api_version}`, ...coordinates }).slice(7)}`;
    if (id !== row.context_id || canonicalSha256(request) !== row.payload_sha256) throw new Error('Person text source integrity failed');
    const content: PersonTextSourceContentV1 = { schema_version: 1, kind: 'person-text', original_api_version: row.api_version, context_id: row.context_id, title: row.title, text: row.text };
    const sourceId = sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1, row.context_id);
    return {
      source: { item: { schema_version: 1, source_id: sourceId, adapter: PERSON_SOURCE_IDENTITY_V1, external_id: row.context_id }, revision: { schema_version: 1, source_id: sourceId, revision_id: row.payload_sha256, captured_at: row.received_at, content_sha256: sourceContentSha256V1(content), contributor: { principal_id: row.principal_id, membership_id: row.membership_id }, artifact_refs: [{ artifact_id: row.context_id, media_type: 'text/plain', sha256: sha256Digest(row.text).slice(7), byte_length: Buffer.byteLength(row.text) }], representation_refs: [] }, content },
      scope: { organization_id: row.organization_id, ...policy(row), analysis_policy: 'on_request' },
    };
  }
}
