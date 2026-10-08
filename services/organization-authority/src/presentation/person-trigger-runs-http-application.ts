import type { PersonRunsResultsV1 } from '@echo-brain/organization-api';

/** Durable approved-record research runs. */
export interface PersonTriggerRunsHttpApplicationV1 {
  list(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['list']>;
  start(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'start'; readonly run_id: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['start']>;
  retry(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'retry'; readonly run_id: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['retry']>;
  view(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'view'; readonly run_id: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['view']>;
  close(): void;
}
