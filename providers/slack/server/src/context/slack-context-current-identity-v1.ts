import type Database from 'better-sqlite3';
import { readActiveSlackConnectionV1, type StoredSlackConnectionV1 } from '../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js';
import { resolveCurrentSlackDmApprovalReviewerTargetV1 } from '../organization-control-plane/persistence/sqlite-slack-dm-approval-reviewer-target-v1.js';

/** Provider identity evidence only. The Authority must separately authorize channel reads. */
export interface SlackContextCurrentIdentityV1 {
  readonly stored: StoredSlackConnectionV1;
  readonly identity_link_id: string;
  readonly identity_link_sha256: `sha256:${string}`;
  readonly human_user_id: string;
}

/** Reuses the existing canonical connection/link proof without creating an approval or read grant. */
export function readSlackContextCurrentIdentityV1(database: Database.Database, input: {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}): SlackContextCurrentIdentityV1 | undefined {
  const stored = readActiveSlackConnectionV1(database);
  if (stored === undefined) return undefined;
  const current = resolveCurrentSlackDmApprovalReviewerTargetV1(database, input, stored.connection.connection_id, {
    principal_id: input.principal_id, membership_id: input.membership_id, membership_type: 'owner',
  });
  if (current === undefined || current.connection.sha256 !== stored.contract_sha256 || current.connection_state.sha256 !== stored.state_sha256) return undefined;
  return Object.freeze({
    stored,
    identity_link_id: current.current_slack_identity_link.external_identity_link_id,
    identity_link_sha256: current.current_slack_identity_link.external_identity_link_contract_sha256,
    human_user_id: current.current_slack_identity_link.provider_subject_id,
  });
}
