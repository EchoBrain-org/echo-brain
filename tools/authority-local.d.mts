export interface AuthorityLocalPorts {
  http: number;
  https: number;
}

export interface ValidateStateDirectoryOptions {
  repo?: string;
  productionData?: string;
}

/** The developer's own Nango key file, mounted read-only, and Slack integration key. */
export interface AuthorityLocalNango {
  integration: string;
  secret_key_file: string;
}

export interface LocalOverlayInput {
  state: string;
  ports: AuthorityLocalPorts;
  localSource: string;
  /** Absent only for a tuple stored before the Authority required Nango. */
  nango?: AuthorityLocalNango;
}

export function localProjectName(
  repo?: string,
  uid?: number,
  state?: string,
): string;

export function validateStateDirectory(
  input?: string,
  options?: ValidateStateDirectoryOptions,
): string;

export function localOverlay(input: LocalOverlayInput): string;

export function main(argv?: readonly string[]): void;
