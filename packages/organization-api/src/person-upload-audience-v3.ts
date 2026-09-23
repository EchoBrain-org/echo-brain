import { validateProjectContextAudienceV1, validateProjectIdV1, type ProjectContextAudienceV1, type ProjectIdV1 } from './project-context-v1.js';
import { asRecord, assertExactKeys, assertOnlyEnumerableDataProperties, fail } from './validation.js';
import { canonicalJson } from '@echo-brain/federation-protocol';

/** The legacy choices retain their existing single-project semantics. */
export type PersonUploadAudienceV3 =
  | ProjectContextAudienceV1
  /** Immutable union of the current active members of these selected projects. */
  | { readonly kind: 'projects'; readonly project_ids: readonly ProjectIdV1[] };

export const PERSON_UPLOAD_PROJECT_SET_MAX = 20;

function canonicalProjectIds(value: unknown, label: string, minimum: number): readonly ProjectIdV1[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > PERSON_UPLOAD_PROJECT_SET_MAX) {
    fail(`${label} is invalid`);
  }
  const project_ids = value.map((projectId) => validateProjectIdV1(projectId, label));
  for (let index = 1; index < project_ids.length; index += 1) {
    if (project_ids[index - 1]! >= project_ids[index]!) fail(`${label} must be sorted and unique`);
  }
  return Object.freeze(project_ids);
}

/** Empty associations are allowed; a projects audience always names at least one project. */
export function validateAssociationProjectIdsV1(value: unknown): readonly ProjectIdV1[] {
  return canonicalProjectIds(value, 'Association project IDs', 0);
}

/** CLI and native bridges accept only a canonical JSON encoding of the immutable set. */
export function parseCanonicalAssociationProjectIdsJsonV1(value: unknown): readonly ProjectIdV1[] {
  if (typeof value !== 'string') fail('Association project IDs JSON is invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail('Association project IDs JSON is invalid'); }
  if (canonicalJson(parsed) !== value) fail('Association project IDs JSON is invalid');
  return validateAssociationProjectIdsV1(parsed);
}

export function validatePersonUploadAudienceV3(value: unknown): PersonUploadAudienceV3 {
  assertOnlyEnumerableDataProperties(value, 'Person upload audience');
  const record = asRecord(value, 'Person upload audience');
  if (record.kind !== 'projects') return validateProjectContextAudienceV1(record);
  assertExactKeys(record, ['kind', 'project_ids'], 'Person upload audience');
  return Object.freeze({ kind: 'projects' as const, project_ids: canonicalProjectIds(record.project_ids, 'Audience project IDs', 1) });
}
