import type {
  ProviderHttpApplicationV1,
  ProviderHttpRequestV1,
} from "../../../../application/ports/provider-http-application-v1.js";
import {
  PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
  type PrivateSlackApprovalInteractionHttpPortV1,
} from "../../../../presentation/private-slack-approval-interaction-http-port-v1.js";

/** Adapts the generic raw HTTP ingress to Slack's two signed headers. */
export function createPrivateSlackApprovalHttpAdapterV1(
  interaction_handler: PrivateSlackApprovalInteractionHttpPortV1,
): ProviderHttpApplicationV1 {
  return Object.freeze({
    routes: Object.freeze([Object.freeze({
      route_id: "private-approval-interaction", method: "POST" as const,
      path: PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1,
    })]),
    async accept({ raw_body, content_type, headers }: ProviderHttpRequestV1) {
      await interaction_handler.accept({
        raw_body,
        content_type,
        slack_request_timestamp: headers["x-slack-request-timestamp"],
        slack_signature: headers["x-slack-signature"],
      });
      return { status: 200 as const, raw_body: new Uint8Array() };
    },
  });
}
