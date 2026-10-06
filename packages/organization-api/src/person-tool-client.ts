/** Single mapping, attempt status and disconnect responses are small closed records. */
export const PERSON_TOOL_SMALL_RESPONSE_MAX_BYTES_V1 = 8 * 1024;
/** Consent permits a 4,096-code-unit URL, at up to six JSON bytes per code unit. */
export const PERSON_TOOL_CONNECT_RESPONSE_MAX_BYTES_V1 = 32 * 1024;
/** Finite JSON envelope for bounded tool metadata collections; also the transport ceiling. */
export const PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1 = 128 * 1024;

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
/** The verbs of `echo-brain person tools <verb> --tool <tool_id>`, the same for every tool. */
export type PersonToolVerbNameV1 = 'setup' | 'connect' | 'disconnect' | 'status' | 'cancel' | 'project' | 'meetings';

export interface PersonToolVerbContextV1 {
  readonly host: PersonToolHostV1;
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  /** Prints one JSON line to standard output. */
  print(value: unknown): void;
  /** One bounded line of standard input, echoed as typed: never a token. */
  read_interactive_line(): Promise<string>;
  /** One bounded hidden line, the only way a verb receives a token; a terminal first shows `prompt`. */
  read_secret_line(prompt: string): Promise<string>;
  open_browser(url: string): boolean | Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface PersonToolVerbV1 {
  readonly description: string;
  /** Options beyond `--tool`, parsed strictly. */
  readonly options: Readonly<Record<string, { readonly type: 'string' | 'boolean' }>>;
  readonly requires?: readonly string[];
  run(context: PersonToolVerbContextV1): Promise<void>;
}

/** One tool's verbs, registered only at the CLI's selecting entrypoint. */
export interface PersonToolProviderV1 {
  readonly tool_id: string;
  readonly verbs: Readonly<Partial<Record<PersonToolVerbNameV1, PersonToolVerbV1>>>;
}

/** A refused, cancelled or unfinished tool step: fixed copy plus a machine-readable reason. */
export class PersonToolOutcomeErrorV1 extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'PersonToolOutcomeErrorV1';
  }
}
