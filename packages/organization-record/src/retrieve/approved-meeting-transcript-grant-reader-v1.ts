import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import type { PersonPolicyIdV2 } from "../application/person-policy-fact-contracts-v2.js";

export interface ApprovedMeetingTranscriptGrantLookupV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id?: string;
  readonly source_id?: string;
  readonly revision_id?: string;
  readonly source_sha256?: Sha256Digest;
}

/**
 * Immutable record-side witness only.  It never opens source custody and it
 * never resolves a present-day audience.  Layer 3 must use the returned
 * policy, reviewer tuple, and project IDs inside its current authorization
 * fence before reading transcript bytes.
 */
export interface ApprovedMeetingTranscriptGrantV1 {
  readonly approval_id: string;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
  readonly audience_project_ids: readonly string[];
  readonly association_project_ids: readonly string[];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  const result = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return result as Sha256Digest;
}

export class ApprovedMeetingTranscriptGrantReaderV1 {
  constructor(private readonly database: Database.Database) {}

  find(input: ApprovedMeetingTranscriptGrantLookupV1): ApprovedMeetingTranscriptGrantV1 | null {
    text(input.authority_id, "transcript grant authority_id");
    text(input.organization_id, "transcript grant organization_id");
    text(input.state_lineage_id, "transcript grant state_lineage_id");
    if (input.approval_id === undefined && input.source_id === undefined) {
      throw new Error("transcript grant lookup requires approval_id or exact source coordinates");
    }
    if (input.approval_id !== undefined) text(input.approval_id, "transcript grant approval_id");
    const exactSource = input.source_id !== undefined || input.revision_id !== undefined || input.source_sha256 !== undefined;
    if (exactSource && (input.source_id === undefined || input.revision_id === undefined || input.source_sha256 === undefined)) {
      throw new Error("transcript grant source lookup requires an exact source tuple");
    }
    if (input.source_id !== undefined) text(input.source_id, "transcript grant source_id");
    if (input.revision_id !== undefined) text(input.revision_id, "transcript grant revision_id");
    if (input.source_sha256 !== undefined) digest(input.source_sha256, "transcript grant source_sha256");
    const row = this.database.prepare(
      `SELECT grant.approval_id, grant.record_position, grant.record_sha256,
              grant.policy_id, grant.policy_contract_sha256,
              grant.source_id, grant.revision_id, grant.source_sha256,
              grant.reviewer_principal_id, grant.reviewer_membership_id
         FROM organization_record_meeting_transcript_grant_v1 AS grant
        WHERE grant.authority_id = ?
          AND grant.organization_id = ?
          AND grant.state_lineage_id = ?
          ${input.approval_id === undefined ? "" : "AND grant.approval_id = ?"}
          ${exactSource ? "AND grant.source_id = ? AND grant.revision_id = ? AND grant.source_sha256 = ?" : ""}`,
    ).get(
      input.authority_id,
      input.organization_id,
      input.state_lineage_id,
      ...(input.approval_id === undefined ? [] : [input.approval_id]),
      ...(exactSource ? [input.source_id!, input.revision_id!, input.source_sha256!] : []),
    ) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const committedPolicy = this.database.prepare(
      `SELECT COALESCE(
          json_extract(canonical_envelope, '$.body.human_act_resolution_ref.policy_id'),
          json_extract(canonical_envelope, '$.body.human_act_resolution_ref.selected_policy_id')
        ) AS policy_id,
        json_extract(canonical_envelope, '$.body.human_act_resolution_ref.policy_contract_sha256') AS policy_contract_sha256
         FROM organization_record_log
        WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'`,
    ).get(row.record_position, row.record_sha256) as
      | { readonly policy_id: unknown; readonly policy_contract_sha256: unknown }
      | undefined;
    if (
      committedPolicy === undefined ||
      committedPolicy.policy_id !== row.policy_id ||
      committedPolicy.policy_contract_sha256 !== row.policy_contract_sha256
    ) {
      throw new Error("transcript grant policy does not match its committed approval");
    }
    const record_position = row.record_position;
    if (!Number.isSafeInteger(record_position) || (record_position as number) < 1) {
      throw new Error("transcript grant record_position is invalid");
    }
    const audience_project_ids = this.projectIds(
      "organization_record_project_members_readable_person_record_fact",
      record_position as number,
      row.record_sha256,
    );
    const association_project_ids = this.projectIds(
      "organization_record_project_association_v1",
      record_position as number,
      row.record_sha256,
    );
    const policy_id = text(row.policy_id, "transcript grant policy_id") as PersonPolicyIdV2;
    if (
      policy_id !== "restricted-reviewer-person-v2" &&
      policy_id !== "organization-member-readable-person-v2" &&
      policy_id !== "project-members-readable-person-v1"
    ) {
      throw new Error("transcript grant policy_id is unsupported");
    }
    const reviewer_principal_id = row.reviewer_principal_id === null ? null : text(row.reviewer_principal_id, "transcript grant reviewer_principal_id");
    const reviewer_membership_id = row.reviewer_membership_id === null ? null : text(row.reviewer_membership_id, "transcript grant reviewer_membership_id");
    if ((reviewer_principal_id === null) !== (reviewer_membership_id === null)) {
      throw new Error("transcript grant reviewer tuple is incomplete");
    }
    if (policy_id === "restricted-reviewer-person-v2" && reviewer_principal_id === null) {
      throw new Error("restricted transcript grant lacks a reviewer tuple");
    }
    if (policy_id !== "restricted-reviewer-person-v2" && reviewer_principal_id !== null) {
      throw new Error("non-restricted transcript grant carries a reviewer tuple");
    }
    if (policy_id === "project-members-readable-person-v1" && (audience_project_ids.length === 0 || association_project_ids.length === 0)) {
      throw new Error("project transcript grant lacks audience or association facts");
    }
    if (policy_id !== "project-members-readable-person-v1" && (audience_project_ids.length !== 0 || association_project_ids.length !== 0)) {
      throw new Error("non-project transcript grant carries project facts");
    }
    return Object.freeze({
      approval_id: text(row.approval_id, "transcript grant approval_id"),
      record_position: record_position as number,
      record_sha256: digest(row.record_sha256, "transcript grant record_sha256"),
      policy_id,
      policy_contract_sha256: digest(row.policy_contract_sha256, "transcript grant policy_contract_sha256"),
      source_id: text(row.source_id, "transcript grant source_id"),
      revision_id: text(row.revision_id, "transcript grant revision_id"),
      source_sha256: digest(row.source_sha256, "transcript grant source_sha256"),
      reviewer_principal_id,
      reviewer_membership_id,
      audience_project_ids,
      association_project_ids,
    });
  }

  /**
   * The grant of one exact approved record, or null when its approver did not
   * share the transcript. It is read and checked exactly as `find` reads it.
   */
  findByRecord(input: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly record_sha256: Sha256Digest;
  }): ApprovedMeetingTranscriptGrantV1 | null {
    text(input.authority_id, "transcript grant authority_id");
    text(input.organization_id, "transcript grant organization_id");
    text(input.state_lineage_id, "transcript grant state_lineage_id");
    digest(input.record_sha256, "transcript grant record_sha256");
    const row = this.database.prepare(
      `SELECT grant.approval_id
         FROM organization_record_meeting_transcript_grant_v1 AS grant
        WHERE grant.authority_id = ?
          AND grant.organization_id = ?
          AND grant.state_lineage_id = ?
          AND grant.record_sha256 = ?`,
    ).get(input.authority_id, input.organization_id, input.state_lineage_id, input.record_sha256) as
      | { readonly approval_id: unknown }
      | undefined;
    if (row === undefined) return null;
    const grant = this.find({
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
      approval_id: text(row.approval_id, "transcript grant approval_id"),
    });
    if (grant === null || grant.record_sha256 !== input.record_sha256) {
      throw new Error("transcript grant does not bind its record");
    }
    return grant;
  }

  /**
   * Every grant in the lineage, oldest record first, or those for one exact
   * source revision. Each is read and checked exactly as `find` reads it.
   */
  list(input: Omit<ApprovedMeetingTranscriptGrantLookupV1, "approval_id">): readonly ApprovedMeetingTranscriptGrantV1[] {
    text(input.authority_id, "transcript grant authority_id");
    text(input.organization_id, "transcript grant organization_id");
    text(input.state_lineage_id, "transcript grant state_lineage_id");
    const exactSource = input.source_id !== undefined || input.revision_id !== undefined || input.source_sha256 !== undefined;
    if (exactSource && (input.source_id === undefined || input.revision_id === undefined || input.source_sha256 === undefined)) {
      throw new Error("transcript grant source lookup requires an exact source tuple");
    }
    const rows = this.database.prepare(
      `SELECT grant.approval_id
         FROM organization_record_meeting_transcript_grant_v1 AS grant
        WHERE grant.authority_id = ?
          AND grant.organization_id = ?
          AND grant.state_lineage_id = ?
          ${exactSource ? "AND grant.source_id = ? AND grant.revision_id = ? AND grant.source_sha256 = ?" : ""}
        ORDER BY grant.record_position ASC`,
    ).all(
      input.authority_id,
      input.organization_id,
      input.state_lineage_id,
      ...(exactSource ? [input.source_id!, input.revision_id!, input.source_sha256!] : []),
    ) as Array<{ readonly approval_id: unknown }>;
    return Object.freeze(rows.map((row) => {
      const grant = this.find({
        authority_id: input.authority_id,
        organization_id: input.organization_id,
        state_lineage_id: input.state_lineage_id,
        approval_id: text(row.approval_id, "transcript grant approval_id"),
      });
      if (grant === null) throw new Error("transcript grant disappeared while listing");
      return grant;
    }));
  }

  private projectIds(table: "organization_record_project_members_readable_person_record_fact" | "organization_record_project_association_v1", record_position: number, record_sha256: unknown): readonly string[] {
    const rows = this.database.prepare(
      `SELECT project_id FROM ${table}
        WHERE record_position = ? AND record_sha256 = ? ORDER BY project_id ASC`,
    ).all(record_position, record_sha256) as Array<{ readonly project_id: unknown }>;
    return Object.freeze(rows.map((row) => text(row.project_id, "transcript grant project_id")));
  }
}
