export interface EmployeeProcessResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error_code?: string;
}

export function runEmployeeProcess(
  input: Record<string, unknown>,
  temporaryDirectory: string,
): Promise<EmployeeProcessResult>;

export function adminPost(options: {
  origin: string;
  adminToken: string;
  path: string;
  body: unknown;
}): Promise<unknown>;

export function adminGet(options: {
  origin: string;
  adminToken: string;
  path: string;
}): Promise<unknown>;

export function assertIsolatedPaths(paths: string[]): void;

export function corruptClosedOrganizationDatabase(options: {
  source: string;
  destination: string;
}): Promise<void>;

export function assertPrivateStatePermissions(roots: string[]): number;

export function scanFilesForKnownSecrets(
  roots: string[],
  secretValues: string[],
): number;
