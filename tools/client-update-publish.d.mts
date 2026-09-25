import type { ClientUpdateConfig, ClientUpdateManifest } from '../src/product/person-client/client-update-contract.js';

export interface ClientUpdatePublicationSummary {
  kind: 'echo-client-update-first-publication-v1';
  operation_id: string;
  state: 'planned' | 'publishing' | 'succeeded' | 'unconfirmed';
  manifest_sha256: string;
  feed_url: string;
  release_id: string;
  verified_objects: number;
  object_count: number;
  metadata_fresh: boolean;
}
export interface ClientUpdatePublicationDependencies {
  aws?: (args: string[]) => any;
  runtime?: () => string;
  now?: () => number;
  readTemplate?: () => Buffer;
  fetch?: typeof globalThis.fetch;
  validatePrepared?: (options: { prepared: string; authorizationPath: string; now?: number; allowExpired?: boolean }) => {
    config: ClientUpdateConfig;
    manifest: ClientUpdateManifest;
    feedBytes: Buffer;
  };
}
export function planClientUpdatePublish(options: { hostingReceipt: string; prepared: string; authorization: string; output: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;
export function executeClientUpdatePublish(options: { receipt: string; approveManifest: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;
export function statusClientUpdatePublish(options: { receipt: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;

export function isAbsentClientUpdateHead(args: readonly string[], stderr: unknown): boolean;
