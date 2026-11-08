export const PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1 =
  "/v2/integrations/slack/interactions" as const;

/** What the HTTP layer answers Slack: always an empty acknowledgement. Feedback goes to the click's response URL. */
export type PrivateSlackApprovalInteractionReplyV1 = { readonly kind: "acknowledged" };

/**
 * Narrow signed-provider ingress seam. The HTTP server owns exact raw bytes;
 * composition owns signature verification and parsing.
 */
export interface PrivateSlackApprovalInteractionHttpPortV1 {
  accept(input: {
    readonly raw_body: Uint8Array;
    readonly content_type: string | undefined;
    readonly slack_request_timestamp: string | undefined;
    readonly slack_signature: string | undefined;
  }): Promise<PrivateSlackApprovalInteractionReplyV1>;
}
