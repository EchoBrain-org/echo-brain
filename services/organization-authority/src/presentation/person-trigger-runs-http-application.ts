import type { PersonRunsRequestV1, PersonRunsResultsV1 } from '@echo-brain/organization-api';

type RequestOf<K extends PersonRunsRequestV1['operation']> = Extract<PersonRunsRequestV1, { readonly operation: K }>;
type Input<K extends PersonRunsRequestV1['operation']> = { readonly access_token: string; readonly request: RequestOf<K>; readonly signal?: AbortSignal };

/** Durable research runs, the open items a finished impact run found, and the sweeps that recheck them (open items and Home v1, section 7). */
export interface PersonTriggerRunsHttpApplicationV1 {
  list(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['list']>;
  start(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'start'; readonly run_id: string; readonly capture_id?: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['start']>;
  retry(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'retry'; readonly run_id: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['retry']>;
  view(input: { readonly access_token: string; readonly request: { readonly schema_version: 1; readonly operation: 'view'; readonly run_id: string }; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['view']>;
  home(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['home']>;
  items(input: Input<'items'>): Promise<PersonRunsResultsV1['items']>;
  item(input: Input<'item'>): Promise<PersonRunsResultsV1['item']>;
  send(input: Input<'send'>): Promise<PersonRunsResultsV1['send']>;
  set_state(input: Input<'set_state'>): Promise<PersonRunsResultsV1['set_state']>;
  assign(input: Input<'assign'>): Promise<PersonRunsResultsV1['assign']>;
  sweep(input: Input<'sweep'>): Promise<PersonRunsResultsV1['sweep']>;
  close(): void;
}
