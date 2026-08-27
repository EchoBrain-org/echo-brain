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
  output: string;
}>): Readonly<{ path: string; sha256: string }>;

export function onboardingTransferSsmCommands(input: Readonly<{
  region: string;
  artifact: OnboardingTransferArtifact;
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
}>): Readonly<{
  action: "execute";
  state: "prepared";
}>;

export function cleanupOnboardingTransfer(receiptPath: string, options?: Readonly<{ aws?: OnboardingTransferAws }>): Readonly<{
  action: "cleanup";
  state: "cleaned" | "prepared_cleaned";
}>;
