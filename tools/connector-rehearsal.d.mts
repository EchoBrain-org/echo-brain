export interface ConnectorRehearsalStatusV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-connector-rehearsal-status-v1';
  readonly status: 'prepared' | 'configuration_ready';
  readonly directory: string;
  readonly qualified: false;
  readonly missing_inputs?: readonly string[];
}

export function prepare(directory: string): ConnectorRehearsalStatusV1;
export function preflight(directory: string): ConnectorRehearsalStatusV1;
export function main(argv?: readonly string[]): void;
