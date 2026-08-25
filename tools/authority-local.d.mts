export interface AuthorityLocalPorts {
  http: number;
  https: number;
}

export interface ValidateStateDirectoryOptions {
  repo?: string;
  productionData?: string;
}

export interface LocalOverlayInput {
  state: string;
  ports: AuthorityLocalPorts;
  localSource: string;
}

export function canonicalWorktreeId(repo?: string): string;

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
