/**
 * Public integration surface for Slack-backed approvals used by Organization
 * Authority: the active connection and the Slack identity-link lookups that
 * pick, recheck and click-match an approval card's target.
 */
export {
  isCurrentSlackDmApprovalTargetV1,
  matchSlackApprovalClickActorV1,
  resolveSlackDmApprovalTargetV1,
} from "./persistence/sqlite-slack-dm-approval-reviewer-target-v1.js";
export { readActiveSlackConnectionV1 } from "./persistence/sqlite-slack-active-connection-v1.js";
