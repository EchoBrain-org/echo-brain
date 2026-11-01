import { validatePersonMeetingReviewOperationV2, validatePersonMeetingResultV2, type PersonMeetingReviewOperationV2, type PersonMeetingResultsV2 } from './person-meetings-v1.js';
import { PERSON_TOOL_REQUEST_MAX_BYTES_V1, type PersonToolHostV1 } from './person-tool-client.js';
import { asEnumerableRecord, fail } from './validation.js';

/** Reviews belong to the authenticated person, independently of connected or advertised source tools. */
export const PERSON_REVIEWS_PATH_V1 = '/v1/person/reviews';
export type PersonReviewOperationV1 = PersonMeetingReviewOperationV2;
export type PersonReviewRequestV1 = PersonReviewOperationV1 & { readonly schema_version: 1 };
export type PersonReviewResultsV1 = Pick<PersonMeetingResultsV2, PersonReviewOperationV1['operation']>;

export function validatePersonReviewRequestV1(value: unknown): PersonReviewRequestV1 {
  const row = asEnumerableRecord(value, 'Personal review request');
  if (row.schema_version !== 1) fail('Personal review request version is unsupported');
  const { schema_version: _version, ...operation } = row;
  return Object.freeze({ schema_version: 1, ...validatePersonMeetingReviewOperationV2(operation) });
}
export function validatePersonReviewResultV1<K extends keyof PersonReviewResultsV1>(operation: K, value: unknown): PersonReviewResultsV1[K] {
  return validatePersonMeetingResultV2(operation, value);
}
export function personReviewCommandV1<K extends PersonReviewOperationV1['operation']>(host: PersonToolHostV1, request: PersonReviewRequestV1 & { readonly operation: K }): Promise<PersonReviewResultsV1[K]> {
  const body = validatePersonReviewRequestV1(request);
  return host.withToolSession(session => session.transport.json({ path: PERSON_REVIEWS_PATH_V1, body, validate_request: validatePersonReviewRequestV1,
    validate_response: value => validatePersonReviewResultV1(request.operation, value), maximum_request_bytes: PERSON_TOOL_REQUEST_MAX_BYTES_V1, maximum_response_bytes: 128 * 1024, timeout_ms: 75_000 }));
}
