export interface ToolchainCheck {
  name: string;
  status: 'pass' | 'fail';
  resolved?: string;
  version?: string;
  reason?: string;
}

export interface ToolchainPreflightOptions {
  expectedNode: string;
  expectedNpm?: string;
  nodedir: string;
  which?: (command: string) => string | null;
  run?: (
    command: string,
    args: readonly string[],
  ) => { status: number | null; stdout: string; stderr: string };
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  nodeVersion?: string;
}

export interface ToolchainPreflightResult {
  schema_version: 1;
  ok: boolean;
  expected_node: string;
  executing_node: string;
  expected_npm: string;
  executing_npm: string;
  nodedir: string;
  checks: ToolchainCheck[];
}

export function runToolchainPreflight(
  options: ToolchainPreflightOptions,
): ToolchainPreflightResult;
