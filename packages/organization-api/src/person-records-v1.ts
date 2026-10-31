import { PersonQueryInputError, validatePersonQueryText } from './person-query.js';
import { asPlainRecord, exactKeys } from './validation.js';

/** The record list (GET) and the record search (POST) share one path. */
export const PERSON_RECORDS_PATH_V1 = "/v1/person/records";

export interface PersonRecordListV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-record-list-v1";
  readonly records: readonly PersonRecordListItemV1[];
}

export interface PersonRecordListItemV1 {
  readonly position: number;
  readonly approval_id: string;
  readonly record_sha256: `sha256:${string}`;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly source_metadata?: PersonRecordSourceMetadataV1;
}

/** Optional presentation metadata, resolved now; not part of the signed record. */
export interface PersonRecordSourceMetadataV1 {
  readonly record_approved_by?: { readonly display_name: string };
}

export interface PersonRecordSearchV2 {
  readonly schema_version: 2;
  readonly kind: "echo-clean-person-record-search-v2";
  readonly items: readonly PersonRecordSearchItemV1[];
}

export interface PersonRecordSearchItemV1 {
  readonly atom_id: `sha256:${string}`;
  readonly record_sha256: `sha256:${string}`;
  readonly kind: "decision" | "action" | "rationale";
  readonly text: string;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2"
    | "project-members-readable-person-v1";
}

export function validatePersonRecordListV1(
  value: unknown,
): PersonRecordListV1 {
  const response = asPlainRecord(value, "record list response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "records"],
    "record list response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-record-list-v1" ||
    !Array.isArray(response.records) ||
    response.records.length > 100
  ) {
    throw new Error("record list response is invalid");
  }
  let previousPosition = Number.POSITIVE_INFINITY;
  const records = response.records.map((value) => {
    const record = asPlainRecord(value, "record list item is invalid");
    exactKeys(
      record,
      ["position", "approval_id", "record_sha256", "envelope",
        ...(record.source_metadata === undefined ? [] : ["source_metadata"])],
      "record list item is invalid",
    );
    if (
      typeof record.position !== "number" ||
      !Number.isSafeInteger(record.position) ||
      record.position < 1 ||
      record.position >= previousPosition ||
      typeof record.approval_id !== "string" ||
      record.approval_id.length === 0 ||
      record.approval_id.length > 256 ||
      typeof record.record_sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(record.record_sha256)
    ) {
      throw new Error("record list item is invalid");
    }
    const envelope = asPlainRecord(
      record.envelope,
      "record list item is invalid",
    );
    previousPosition = record.position;
    return Object.freeze({
      position: record.position,
      approval_id: record.approval_id,
      record_sha256: record.record_sha256 as `sha256:${string}`,
      envelope,
      ...(record.source_metadata === undefined ? {} : {
        source_metadata: validateSourceMetadata(record.source_metadata),
      }),
    });
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-list-v1",
    records: Object.freeze(records),
  });
}

function validateSourceMetadata(value: unknown): NonNullable<PersonRecordListItemV1["source_metadata"]> {
  const metadata = asPlainRecord(value, "source metadata is invalid");
  exactKeys(metadata, metadata.record_approved_by === undefined ? [] : ["record_approved_by"], "source metadata is invalid");
  if (metadata.record_approved_by === undefined) return Object.freeze({});
  const approver = asPlainRecord(metadata.record_approved_by, "source approver is invalid");
  exactKeys(approver, ["display_name"], "source approver is invalid");
  if (typeof approver.display_name !== "string" || approver.display_name.trim().length === 0 ||
    approver.display_name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(approver.display_name)) {
    throw new Error("source approver is invalid");
  }
  return Object.freeze({ record_approved_by: Object.freeze({ display_name: approver.display_name }) });
}

export function validatePersonRecordSearchRequestV2(value: unknown): {
  readonly query: string;
  readonly limit?: number;
} {
  const request = asPlainRecord(value, "record search request is invalid");
  const keys = Object.keys(request).sort();
  const query = validatePersonQueryText(request.query);
  if (
    keys.length < 1 || keys.length > 2 || !keys.includes("query") ||
    keys.some(key => key !== "query" && key !== "limit") ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        (request.limit as number) < 1 ||
        (request.limit as number) > 10))
  ) {
    throw new PersonQueryInputError("invalid_limit", "Search --limit must be an integer from 1 to 10");
  }
  return Object.freeze({
    query,
    ...(request.limit === undefined
      ? {}
      : { limit: request.limit as number }),
  });
}

export function validatePersonRecordSearchV2(
  value: unknown,
): PersonRecordSearchV2 {
  const response = asPlainRecord(value, "record search response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "items"],
    "record search response is invalid",
  );
  if (
    response.schema_version !== 2 ||
    response.kind !== "echo-clean-person-record-search-v2" ||
    !Array.isArray(response.items) ||
    response.items.length > 10
  ) {
    throw new Error("record search response is invalid");
  }
  const items = response.items.map((value) => {
    const item = asPlainRecord(value, "record search item is invalid");
    exactKeys(
      item,
      ["atom_id", "record_sha256", "kind", "text", "policy_id"],
      "record search item is invalid",
    );
    if (
      typeof item.atom_id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.atom_id) ||
      typeof item.record_sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.record_sha256) ||
      (item.kind !== "decision" &&
        item.kind !== "action" &&
        item.kind !== "rationale") ||
      typeof item.text !== "string" ||
      item.text.length === 0 ||
      item.text !== item.text.normalize("NFC") ||
      (item.policy_id !== "organization-member-readable-person-v2" &&
        item.policy_id !== "restricted-reviewer-person-v2" &&
        item.policy_id !== "project-members-readable-person-v1")
    ) {
      throw new Error("record search item is invalid");
    }
    return Object.freeze({
      atom_id: item.atom_id as `sha256:${string}`,
      record_sha256: item.record_sha256 as `sha256:${string}`,
      kind: item.kind,
      text: item.text,
      policy_id: item.policy_id,
    });
  });
  return Object.freeze({
    schema_version: 2,
    kind: "echo-clean-person-record-search-v2",
    items: Object.freeze(items),
  });
}
