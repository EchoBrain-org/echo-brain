export interface StagingConnectorRehearsalInputV1 {
  readonly action: 'status' | 'capture';
  readonly release_id: string;
  readonly profile_path: string;
  readonly person_home?: string;
  readonly tool?: 'granola' | 'jira';
  readonly limit?: number;
}

export function runStagingConnectorRehearsal(
  input: StagingConnectorRehearsalInputV1,
  options?: { readonly fetch?: typeof fetch },
): Promise<unknown>;
export function main(argv?: readonly string[]): Promise<number>;
