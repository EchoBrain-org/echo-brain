export const PRIVATE_SLACK_APPROVAL_INTERACTION_PATH_V1 =
  "/v2/integrations/slack/interactions" as const;

/**
 * Narrow signed-provider ingress seam. The HTTP server owns exact raw bytes;
 * composition owns signature verification, parsing, and durable enqueue.
 */
export interface PrivateSlackApprovalInteractionHttpPortV1 {
  accept(input: {
    readonly raw_body: Uint8Array;
    readonly content_type: string | undefined;
    readonly slack_request_timestamp: string | undefined;
    readonly slack_signature: string | undefined;
  }): Promise<"accepted">;
}
