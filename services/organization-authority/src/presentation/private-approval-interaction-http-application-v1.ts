/**
 * Provider-neutral ingress for the one active private-approval surface.
 * The HTTP server preserves raw bytes; the selected provider owns verification,
 * parsing, and durable acceptance.
 */
export interface PrivateApprovalInteractionHttpRequestV1 {
  readonly raw_body: Uint8Array;
  readonly content_type: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface PrivateApprovalInteractionHttpApplicationV1 {
  readonly method: "POST";
  /** Exact path owned by the selected approval-surface adapter. */
  readonly path: string;
  accept(request: PrivateApprovalInteractionHttpRequestV1): Promise<"accepted">;
}
