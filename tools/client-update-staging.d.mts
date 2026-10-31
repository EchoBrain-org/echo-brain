export type ClientUpdateStagingState =
  | 'planning'
  | 'planned'
  | 'executing'
  | 'succeeded'
  | 'unconfirmed';

export type ClientUpdateStagingHosting = 's3';
export type ClientUpdateStagingKind = 'echo-client-update-staging-s3-feed-operation-v1';

export type ClientUpdateStagingSummary = Readonly<{
  schema_version: 1;
  kind: ClientUpdateStagingKind;
  operation_id: string;
  state: ClientUpdateStagingState;
  change_set_id: string | null;
  feed_url: string | null;
}>;

export type ClientUpdateStagingAws = (args: string[]) => unknown;
export type ClientUpdateStagingDependencies = Readonly<{
  aws?: ClientUpdateStagingAws;
  awsNoOutput?: (args: string[]) => void;
  readTemplate?: () => Buffer;
  runtime?: () => string;
  operationId?: string;
}>;

export function planClientUpdateStaging(options: Readonly<{ output: string; hosting?: ClientUpdateStagingHosting }>, dependencies?: ClientUpdateStagingDependencies): ClientUpdateStagingSummary;
export function executeClientUpdateStaging(options: Readonly<{ receipt: string; approveChangeSet: string }>, dependencies?: ClientUpdateStagingDependencies): ClientUpdateStagingSummary;
export function statusClientUpdateStaging(options: Readonly<{ receipt: string }>, dependencies?: ClientUpdateStagingDependencies): ClientUpdateStagingSummary;
