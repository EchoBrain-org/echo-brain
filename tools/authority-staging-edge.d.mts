export type StagingEdgeInput = Readonly<{
  accountId: string;
  zoneId: string;
  hostname: string;
  secretArn: string;
  slotId: string;
  operationId: string;
  apiToken: string;
}>;

export type ValidatedStagingEdgeInput = StagingEdgeInput &
  Readonly<{ tunnelName: string }>;

export type StagingEdgeState = "ready" | "absent" | "incomplete";

export type StagingEdgeReceipt = Readonly<{
  schema_version: 1;
  kind: "echo-authority-staging-edge-v1";
  action: "status" | "install-token";
  state: StagingEdgeState;
  hostname: string;
  tunnel_name: string;
  operation_id: string;
  readonly [field: string]: string | number | boolean;
}>;

export type FetchLike = (
  input: string,
  init?: Readonly<Record<string, unknown>>,
) => Promise<{
  readonly ok: boolean;
  json(): Promise<unknown>;
}>;

export type PutSecretValue = (
  input: Readonly<{
    clientRequestToken: string;
    secretArn: string;
    secretString: string;
  }>,
) => Promise<void>;

export function validateStagingEdgeInput(
  input: unknown,
): ValidatedStagingEdgeInput;
export function stagingEdgeStatus(
  input: StagingEdgeInput,
  dependencies?: Readonly<{
    fetchImpl?: FetchLike;
    /** Test seam: bounds one Cloudflare HTTP request. */
    requestTimeoutMs?: number;
    /** Test seam: bounds one Cloudflare JSON response. */
    maxResponseBytes?: number;
  }>,
): Promise<StagingEdgeReceipt>;
export function installStagingEdgeToken(
  input: StagingEdgeInput,
  dependencies?: Readonly<{
    fetchImpl?: FetchLike;
    putSecretValue?: PutSecretValue;
    /** Test seam: bounds one Cloudflare HTTP request. */
    requestTimeoutMs?: number;
    /** Test seam: bounds one Cloudflare JSON response. */
    maxResponseBytes?: number;
  }>,
): Promise<StagingEdgeReceipt>;
