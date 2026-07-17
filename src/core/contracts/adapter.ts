import type { JsonObject } from './json.js';

export type AdapterKind =
  | 'meeting-source'
  | 'decision-processor'
  | 'communication-channel';

export interface AdapterIdentity {
  kind: AdapterKind;
  adapter_id: string;
  instance_id: string;
  version: string;
}

export interface AdapterConfig {
  adapter_id: string;
  instance_id: string;
  credential_ref?: string;
  settings: Readonly<JsonObject>;
}

export type AdapterInstanceConfig = AdapterConfig;

export interface AdapterConfigValidation {
  ok: boolean;
  errors: readonly string[];
}

export interface AdapterHealth {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unauthorized';
  checked_at: string;
  message?: string;
  details?: Readonly<JsonObject>;
}

export interface AdapterOperationContext {
  /** Aborted when the host cancels the cycle or its operation deadline expires. */
  signal: AbortSignal;
}

export type AdapterErrorCode =
  | 'invalid_config'
  | 'unauthorized'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'permanently_rejected'
  | 'timeout'
  | 'unknown_outcome';

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface Adapter {
  readonly identity: AdapterIdentity;
  validateConfig(config: AdapterConfig): AdapterConfigValidation;
  healthCheck(context?: AdapterOperationContext): Promise<AdapterHealth>;
}

export function adapterInstanceKey(
  kind: AdapterKind,
  adapterId: string,
  instanceId: string,
): string {
  return `${kind}:${adapterId}:${instanceId}`;
}
