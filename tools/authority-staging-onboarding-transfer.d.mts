export type OnboardingTransferArtifact = Readonly<{
  bucket: string;
  keyArn: string;
  key: string;
  version: string;
  sha256: string;
}>;

/** Private receipt lifecycle. SSM-submitted states may only be reconciled. */
export type OnboardingTransferReceiptState =
  | "uploading"
  | "uploaded"
  | "planned"
  | "ssm_submitting"
  | "ssm_submitted"
  | "remote_prepared";

export type OnboardingTransferAws = Readonly<{
  json(args: readonly string[]): unknown;
  noOutput(args: readonly string[]): void;
  now?(): number;
  sleep?(milliseconds: number): void;
}>;

export function createOnboardingInputArchive(input: Readonly<{
  sourceDir: string;
  /** Optional exact four-file staging fixture directory. */
  stagingSyntheticMeetingsDir?: string;
  /** Rehearsal-only mode: archive just the three non-secret inputs. */
  reuseCurrentProviderInputs?: true;
  output: string;
}>): Readonly<{ path: string; sha256: string }>;

export type OnboardingTransferPreflightFile = Readonly<{
  name: string;
  state: "ready" | "missing" | "empty" | "too_large" | "not_private_regular";
  detail: string | null;
  bytes?: number;
}>;

/**
 * The local AWS CLI boundary: fixed to echo-prod and stripped of inherited
 * credential, endpoint, proxy, and CA override variables.
 */
export function sanitizedAwsEnvironment(
  sourceEnvironment?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;

/** Explicit arguments used for every local AWS CLI process. */
export function awsCliArguments(args: readonly string[]): readonly string[];

export function preflightOnboardingInput(configPath: string): Readonly<{
  schema_version: 1;
  kind: "echo-authority-staging-onboarding-preflight-v1";
  action: "preflight";
  state: "ready" | "incomplete";
  ready: boolean;
  operation_id: string;
  directory_private: boolean;
  required_files: readonly OnboardingTransferPreflightFile[];
  /** Count only: preflight deliberately does not disclose unexpected names. */
  unexpected_file_count: number;
  total_bytes: number;
  total_bytes_limit: number;
  /** Exact number of bytes to remove from required inputs, zero when in limit. */
  bytes_over_limit: number;
  /** Present only when the controller selected the fixed four-fixture source. */
  staging_synthetic_meetings?: Readonly<{
    directory_private: boolean;
    required_files: readonly OnboardingTransferPreflightFile[];
    /** Count only: extra fixture names are never disclosed. */
    unexpected_file_count: number;
    ready: boolean;
  }>;
  /** Present only for the bounded server-local provider-input rehearsal mode. */
  reuse_current_provider_inputs?: true;
  next_action: string;
}>;

export function onboardingTransferSsmCommands(input: Readonly<{
  region: string;
  artifact: OnboardingTransferArtifact;
  /** Receipt-bound selected source; omitted preserves the ordinary nine-file flow. */
  stagingSyntheticMeetings?: boolean;
  /** Rehearsal-only selected-source mode; requires stagingSyntheticMeetings. */
  reuseCurrentProviderInputs?: boolean;
  /** Required when reuseCurrentProviderInputs is true. */
  operationId?: string;
}>): readonly string[];

export function planOnboardingTransfer(configPath: string, options?: Readonly<{
  aws?: OnboardingTransferAws;
  /** Test-only persistence seam; production always uses the private atomic writer. */
  writeReceipt?(path: string, receipt: Readonly<Record<string, unknown>>): string;
}>): Readonly<{
  action: "plan";
  state: "planned";
  receipt_path: string;
}>;

export function executeOnboardingTransfer(receiptPath: string, options?: Readonly<{
  aws?: OnboardingTransferAws;
  /** Test-only persistence seam; production always uses the private atomic replacer. */
  replaceReceipt?(path: string, receipt: Readonly<Record<string, unknown>>): void;
  /** Test-only completion persistence seam. */
  writeStageReceipt?(path: string, receipt: Readonly<Record<string, unknown>>): string;
  /** Test-only completion replacement seam. */
  replaceStageReceipt?(path: string, receipt: Readonly<Record<string, unknown>>): void;
}>): Readonly<{
  action: "execute";
  state: "prepared" | "staged_awaiting_human";
  completion_path?: string;
  host_stage_path?: string;
  next_human_action?: string;
}>;

export function cleanupOnboardingTransfer(receiptPath: string, options?: Readonly<{ aws?: OnboardingTransferAws }>): Readonly<{
  action: "cleanup";
  state: "cleaned" | "prepared_cleaned" | "staged_awaiting_human";
  completion_path?: string;
  host_stage_path?: string;
  next_human_action?: string;
}>;
