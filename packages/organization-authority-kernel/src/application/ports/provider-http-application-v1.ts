/** Exact routes owned by one selected identity or approval application. */
export interface ProviderHttpRouteV1 {
  readonly route_id: string;
  readonly method: "POST" | "GET";
  readonly path: string;
  /** Query parameters are rejected unless the route explicitly opts in. */
  readonly accepts_query?: true;
}

export interface ProviderHttpRequestV1 {
  readonly route_id: string;
  readonly method: "POST" | "GET";
  readonly path: string;
  /** Exact bytes, bounded by the listener, for provider signature verification. */
  readonly raw_body: Uint8Array;
  readonly content_type: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query?: URLSearchParams;
}

/**
 * Generalizes the identity callback response for approval acknowledgments.
 * The host caps encoded output and owns Content-Length, cache, and browser
 * security headers. Only the listed content types are selectable; arbitrary
 * headers, redirects, cookies, and request-token reflection are not supported.
 */
export type ProviderHttpResponseV1 = { readonly status: 200 | 201 | 202 } & (
  | { readonly body: unknown; readonly content_type?: undefined }
  /** Only fixed, provider-owned callback pages; never reflect request fields. */
  | { readonly body: string; readonly content_type: "text/html" }
  | {
      readonly raw_body: Uint8Array;
      /** Required for nonempty bytes. Omit for an empty acknowledgment. */
      readonly content_type?: "text/plain" | "application/octet-stream";
    }
);

/** Transport only: verification, authorization, and durable acceptance stay in the application. */
export interface ProviderHttpApplicationV1 {
  readonly routes: readonly ProviderHttpRouteV1[];
  accept(request: ProviderHttpRequestV1): Promise<ProviderHttpResponseV1>;
}
