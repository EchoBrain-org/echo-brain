import type {
  PrivateApprovalInteractionHttpApplicationV1,
  PrivateApprovalInteractionHttpRequestV1,
} from "../presentation/private-approval-interaction-http-application-v1.js";
import {
  PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1,
  type PrivateApprovalSlackInteractionsHttpApplicationV1,
} from "../presentation/private-approval-slack-interactions-http-application-v1.js";

/** Adapts the generic raw HTTP ingress to Slack's two signed headers. */
export function createPrivateApprovalSlackInteractionHttpIngressV1(
  application: PrivateApprovalSlackInteractionsHttpApplicationV1,
): PrivateApprovalInteractionHttpApplicationV1 {
  return Object.freeze({
    method: "POST",
    path: PRIVATE_APPROVAL_SLACK_INTERACTIONS_PATH_V1,
    accept: ({ raw_body, content_type, headers }: PrivateApprovalInteractionHttpRequestV1) =>
      application.accept({
        raw_body,
        content_type,
        slack_request_timestamp: headers["x-slack-request-timestamp"],
        slack_signature: headers["x-slack-signature"],
      }),
  });
}
