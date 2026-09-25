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
}
export interface ClientUpdatePublicationDependencies {
  aws?: (args: string[]) => any;
  runtime?: () => string;
  readTemplate?: () => Buffer;
  fetch?: typeof globalThis.fetch;
  validatePrepared?: (options: { prepared: string; authorizationPath: string }) => {
    config: ClientUpdateConfig;
    manifest: ClientUpdateManifest;
    feedBytes: Buffer;
  };
}
export function planClientUpdatePublish(options: { hostingReceipt: string; prepared: string; authorization: string; output: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;
export function executeClientUpdatePublish(options: { receipt: string; approveManifest: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;
export function statusClientUpdatePublish(options: { receipt: string }, dependencies?: ClientUpdatePublicationDependencies): Promise<ClientUpdatePublicationSummary>;

export function isAbsentClientUpdateHead(args: readonly string[], stderr: unknown): boolean;
