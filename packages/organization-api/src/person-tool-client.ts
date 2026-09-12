/** Authenticated, bounded Authority transport supplied to a Person tool fragment. */
export interface PersonToolJsonRequestV1<T> {
  readonly path: string;
  readonly body: unknown;
  readonly validate_request: (value: unknown) => unknown;
  readonly validate_response: (value: unknown) => T;
  readonly maximum_response_bytes?: number;
  readonly timeout_ms?: number;
}
export interface PersonToolGetRequestV1<T> {
  readonly path: string;
  readonly validate_response: (value: unknown) => T;
  readonly maximum_response_bytes: number;
}
export interface PersonToolTransportV1 {
  json<T>(input: PersonToolJsonRequestV1<T>): Promise<T>;
  getJson<T>(input: PersonToolGetRequestV1<T>): Promise<T>;
}
export interface PersonToolSessionV1 {
  readonly identity: { readonly organization_id: string; readonly membership_id: string };
  readonly transport: PersonToolTransportV1;
  request_id(prefix: string): string;
  random_bytes(size: number): Uint8Array;
}
export interface PersonToolHostV1 {
  /** The host authenticates first and verifies the same current account after the operation. */
  withToolSession<T>(operation: (session: PersonToolSessionV1) => Promise<T>): Promise<T>;
}
export interface PersonToolCommandV1 {
  readonly name: string;
  readonly description: string;
  readonly options: Readonly<Record<string, { readonly type: 'string' | 'boolean' }>>;
  readonly requires?: readonly string[];
  run(input: {
    readonly host: PersonToolHostV1;
    readonly values: Readonly<Record<string, string | boolean | undefined>>;
    print(value: unknown): void;
    read_input(): Promise<string>;
    read_interactive_line(): Promise<string>;
    open_browser(url: string): boolean | Promise<boolean>;
  }): Promise<void>;
}
