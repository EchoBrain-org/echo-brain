export interface StagingConnectorRehearsalInput {
  readonly action: 'status' | 'capture';
  readonly release_id: string;
  readonly profile_path: string;
  readonly person_home?: string;
  readonly tool?: 'granola' | 'jira' | 'slack';
  readonly limit?: number;
}

export function runStagingConnectorRehearsal(
  input: StagingConnectorRehearsalInput,
  options?: { readonly fetch?: typeof fetch },
): Promise<unknown>;
export function main(argv?: readonly string[]): Promise<number>;
