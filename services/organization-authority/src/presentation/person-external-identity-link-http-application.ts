/** An exact external-identity route selected by its provider-owned bundle. */
export interface PersonExternalIdentityHttpRouteV1 {
  readonly route_id: string;
  readonly method: "POST";
  readonly path: string;
}

export interface PersonExternalIdentityHttpRequestV1 {
  readonly route_id: string;
  readonly raw_body: Uint8Array;
  readonly content_type: string | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface PersonExternalIdentityHttpResponseV1 {
  readonly status: 200 | 201;
  readonly body: unknown;
}

/** Provider-neutral raw HTTP ingress for an external-identity application. */
export interface PersonExternalIdentityLinkHttpApplicationV1 {
  readonly routes: readonly PersonExternalIdentityHttpRouteV1[];
  accept(
    request: PersonExternalIdentityHttpRequestV1,
  ): Promise<PersonExternalIdentityHttpResponseV1>;
}
