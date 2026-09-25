export type ClientUpdateStagingState =
  | 'planning'
  | 'planned'
  | 'executing'
  | 'succeeded'
  | 'unconfirmed';

export type ClientUpdateStagingHosting = 'cloudfront' | 's3';
export type ClientUpdateStagingKind = 'echo-client-update-staging-feed-operation-v1' | 'echo-client-update-staging-s3-feed-operation-v1';

export type ClientUpdateStagingInventory = Readonly<{
  logical_id: 'FeedBucket' | 'FeedBucketPolicy' | 'FeedDistribution' | 'FeedOriginAccessControl' | 'FeedCachePolicy';
  resource_type: 'AWS::S3::Bucket' | 'AWS::S3::BucketPolicy' | 'AWS::CloudFront::Distribution' | 'AWS::CloudFront::OriginAccessControl' | 'AWS::CloudFront::CachePolicy';
  action: 'Add';
}>;

export type ClientUpdateStagingOutputs = Readonly<{
  bucket_name: string;
  distribution_id: string | null;
  feed_url: string;
}>;

export type ClientUpdateStagingReceipt = Readonly<{
  schema_version: 1;
  kind: ClientUpdateStagingKind;
  operation_id: string;
  source_sha: string;
  template_sha256: string;
  account: '904560150024';
  region: 'us-west-2';
  stack_name: 'echo-client-update-staging-v1' | 'echo-client-update-staging-s3-v1';
  change_set_name: string;
  change_set_id: string | null;
  stack_id: string | null;
  change_set_type: 'CREATE' | null;
  inventory: readonly ClientUpdateStagingInventory[] | null;
  state: ClientUpdateStagingState;
  outputs: ClientUpdateStagingOutputs | null;
}>;

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
