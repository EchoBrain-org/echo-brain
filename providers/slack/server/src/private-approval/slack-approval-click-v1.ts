import Database from "better-sqlite3";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { VerifiedSlackApprovalClickV1 } from "./private-slack-approval-interaction-protocol-v1.js";
import { slackApprovalDestinationSha256V4 } from "./slack-approval-card-v4.js";
import type { ApprovalActorV1, SlackApprovalTargetV1 as TargetV1 } from "./slack-approval-presenter-v1.js";

type LinkV1 = ApprovalActorV1 & {
  readonly external_identity_link_id: string;
  readonly contract_sha256: string;
  readonly connection_id: string;
  readonly api_app_id: string;
};
type CoreV1 = {
  decide(
    surface: "slack",
    request: {
      readonly approval_id: string;
      readonly command_id: string;
      readonly snapshot_sha256: Sha256Digest;
      readonly action: "approve" | "reject";
      readonly routes: readonly {
        readonly signal_id: string;
        readonly project_ids: readonly string[] | null;
      }[];
      readonly owners: readonly {
        readonly signal_id: string;
        readonly owner: string;
      }[];
    },
    authorize: () => {
      readonly actor: ApprovalActorV1;
      readonly evidence: {
        readonly kind: "slack-click";
        readonly sha256: Sha256Digest;
      };
    },
  ): { readonly kind: "decided" | "replayed" | "already_decided" | "stale" };
  proposal(id: string): {
    readonly reviewer: ApprovalActorV1;
    readonly status: "pending" | "publishing" | "approved" | "rejected" | "superseded";
    readonly project_ids: readonly string[];
    readonly snapshot_json: string;
  } | undefined;
  ownerProposals(id: string): readonly { readonly signal_id: string }[];
};
/** The frozen snapshot's decisions then actions, in brief order: the items a Slack approval routes. Undefined when it does not read so. */
function routedSignals(snapshotJson: string): readonly string[] | undefined {
  try {
    const brief = (JSON.parse(snapshotJson) as { readonly approved_payload?: { readonly brief?: Readonly<Record<string, unknown>> } }).approved_payload?.brief;
    const ids = [brief?.decisions, brief?.actions].flatMap((signals) =>
      Array.isArray(signals) ? signals.map((signal) => (signal as { readonly id?: unknown } | null)?.id) : [undefined]);
    return ids.every((id): id is string => typeof id === "string") ? ids : undefined;
  } catch {
    return undefined;
  }
}
function sameActor(left: ApprovalActorV1, right: ApprovalActorV1): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id
  );
}
function target(value: unknown): TargetV1 | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const record = value as Record<string, unknown>,
    keys = Object.keys(record).sort(),
    expected = [
      "api_app_id",
      "connection_id",
      "external_identity_link_contract_sha256",
      "external_identity_link_id",
      "slack_subject_id",
      "slack_workspace_id",
    ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    expected.some((key) => typeof record[key] !== "string")
  )
    return undefined;
  return record as unknown as TargetV1;
}
/**
 * A target-bound Slack click adapter. It decides only through approval core decide(), approving as suggested, and only while
 * the suggestion is the destination its card showed; otherwise it marks that open card for redraw and decides nothing.
 */
export function createSlackApprovalClickV1(options: {
  readonly database: Database.Database;
  readonly core: CoreV1;
  readonly link: (click: {
    readonly workspace_id: string;
    readonly subject_id: string;
  }) => LinkV1 | null;
  readonly redraw: (approvalId: string) => void;
}): (click: VerifiedSlackApprovalClickV1) => {
  readonly outcome: "decided" | "already_decided" | "stale" | "refused";
} {
  const presentation = options.database.prepare(
    "SELECT target_json,dm_channel_id,message_ts FROM authority_approval_presentations_v1 WHERE approval_id=? AND surface='slack' AND delivery='posted'",
  );
  // The presenter redraws a posted card whose card_sha256 is cleared (its first-draw path); an open one is otherwise drawn once.
  const redrawCard = options.database.prepare(
    "UPDATE authority_approval_presentations_v1 SET card_sha256=NULL,updated_at=? WHERE approval_id=? AND surface='slack' AND delivery='posted' AND shows='open'",
  );
  return (click) => {
    const row = presentation.get(click.approval_id) as
      | {
          target_json: string;
          dm_channel_id: string | null;
          message_ts: string | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.dm_channel_id === null ||
      row.message_ts === null
    )
      return { outcome: "refused" };
    let posted: TargetV1 | undefined;
    try {
      posted = target(JSON.parse(row.target_json));
    } catch {
      posted = undefined;
    }
    if (
      posted === undefined ||
      click.lookup.workspace_id !== posted.slack_workspace_id ||
      click.lookup.slack_user_id !== posted.slack_subject_id ||
      click.lookup.channel_id !== row.dm_channel_id ||
      click.lookup.message_ts !== row.message_ts ||
      click.lookup.api_app_id !== posted.api_app_id ||
      click.lookup.message_app_id !== posted.api_app_id
    )
      return { outcome: "refused" };
    const current = options.link({
      workspace_id: click.lookup.workspace_id,
      subject_id: click.lookup.slack_user_id,
    });
    if (
      current === null ||
      current.connection_id !== posted.connection_id ||
      current.api_app_id !== posted.api_app_id ||
      current.external_identity_link_id !== posted.external_identity_link_id ||
      current.contract_sha256 !== posted.external_identity_link_contract_sha256
    )
      return { outcome: "refused" };
    const proposal = options.core.proposal(click.approval_id);
    if (proposal === undefined || !sameActor(current, proposal.reviewer))
      return { outcome: "refused" };
    // Slack approves as suggested: every decision and action goes to the frozen suggestion the reviewer can read now, or to
    // the reviewer alone when there is none. Choosing per item happens in the ECHO desktop app.
    const signals = routedSignals(proposal.snapshot_json);
    if (signals === undefined) return { outcome: "refused" };
    const suggestion = [...proposal.project_ids];
    // Approve sends every item where the card said. A suggestion that changed since it was drawn (a project the reviewer
    // joined or left) decides nothing: the card is redrawn with where Approve sends the items now.
    if (click.action === "approve" && proposal.status === "pending" && slackApprovalDestinationSha256V4(suggestion) !== click.destination_sha256) {
      redrawCard.run(new Date().toISOString(), click.approval_id);
      options.redraw(click.approval_id);
      return { outcome: "stale" };
    }
    const ownerProposals = options.core.ownerProposals(click.approval_id);
    const permitted = new Set(ownerProposals.map((owner) => owner.signal_id));
    if (click.owners.some((owner) => !permitted.has(owner.signal_id)))
      return { outcome: "refused" };
    const evidence = canonicalSha256({
      provider_action_key_sha256: click.provider_action_key_sha256,
      workspace: click.lookup.workspace_id,
      subject: click.lookup.slack_user_id,
      channel: click.lookup.channel_id,
      message_ts: click.lookup.message_ts,
      link_id: posted.external_identity_link_id,
      link_contract_sha256: posted.external_identity_link_contract_sha256,
    });
    const authorize = () => {
      const active = options.link({
        workspace_id: click.lookup.workspace_id,
        subject_id: click.lookup.slack_user_id,
      });
      if (
        active === null ||
        !sameActor(active, proposal.reviewer) ||
        active.connection_id !== posted.connection_id ||
        active.api_app_id !== posted.api_app_id ||
        active.external_identity_link_id !== posted.external_identity_link_id ||
        active.contract_sha256 !== posted.external_identity_link_contract_sha256
      )
        throw new AuthorityOperationError(
          "unauthorized",
          "Slack approval link is no longer current",
        );
      return {
        actor: {
          organization_id: active.organization_id,
          principal_id: active.principal_id,
          membership_id: active.membership_id,
        },
        evidence: { kind: "slack-click" as const, sha256: evidence },
      };
    };
    try {
      const result = options.core.decide(
        "slack",
        {
          approval_id: click.approval_id,
          command_id: `slack:${click.provider_action_key_sha256.slice(7)}`,
          snapshot_sha256: click.snapshot_sha256,
          action: click.action,
          routes:
            click.action === "approve"
              ? signals.map((signal_id) => ({ signal_id, project_ids: suggestion }))
              : [],
          owners:
            click.action === "approve"
              ? ownerProposals.flatMap((owner) => {
                  const chosen = click.owners.find(
                    (value) => value.signal_id === owner.signal_id,
                  );
                  return chosen === undefined ? [] : [chosen];
                })
              : [],
        },
        authorize,
      );
      const outcome =
        result.kind === "decided" || result.kind === "replayed"
          ? "decided"
          : result.kind;
      if (outcome !== "decided") options.redraw(click.approval_id);
      return { outcome };
    } catch (error) {
      if (error instanceof AuthorityOperationError)
        return {
          outcome: error.code === "stale_access_state" ? "stale" : "refused",
        };
      throw error;
    }
  };
}
