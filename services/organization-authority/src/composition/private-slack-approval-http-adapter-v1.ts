import type {
  PrivateApprovalInteractionHttpApplicationV1,
  PrivateApprovalInteractionHttpRequestV1,
} from "../presentation/private-approval-interaction-http-application-v1.js";
import {
  PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
  type PrivateSlackApprovalInteractionHttpPortV1,
} from "../presentation/private-slack-approval-interaction-http-port-v1.js";

/** Adapts the generic raw HTTP ingress to Slack's two signed headers. */
export function createPrivateSlackApprovalHttpAdapterV1(
  interaction_handler: PrivateSlackApprovalInteractionHttpPortV1,
): PrivateApprovalInteractionHttpApplicationV1 {
  return Object.freeze({
    method: "POST",
    path: PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
    accept: ({ raw_body, content_type, headers }: PrivateApprovalInteractionHttpRequestV1) =>
      interaction_handler.accept({
        raw_body,
        content_type,
        slack_request_timestamp: headers["x-slack-request-timestamp"],
        slack_signature: headers["x-slack-signature"],
      }),
  });
}
