export type StagingReleaseAction =
  | 'install' | 'inspect-install' | 'diagnose' | 'repair' | 'stage'
  | 'canary' | 'status' | 'rollback' | 'promote';

export type StagingReleaseCode =
  | 'installed' | 'installation_failed' | 'inspection_verified'
  | 'inspection_refused' | 'verified' | 'wrapper_failed'
  | 'environment_drift' | 'precondition_failed' | 'operation_locked'
  | 'operation_incomplete' | 'expired' | 'delivery_pending' | 'control_path_changed';

export type StagingReleaseTool =
  | 'update-clean-v1.sh' | 'onboard-clean-v1.sh' | 'restore-clean-v1-host.sh'
  | 'backup-authority-maintenance.sh' | 'release/clean-v1-release.py'
  | 'release/clean-v1-runtime-profile.py';
type LegacyTool = Exclude<StagingReleaseTool,
  'onboard-clean-v1.sh' | 'restore-clean-v1-host.sh' | 'backup-authority-maintenance.sh'>;

export type StagingReleaseTarget = Readonly<{
  account: string;
  region: string;
  stack_id: string;
  instance_id: string;
  volume_id: string;
}>;

export type StagingReleaseAuthorization = Readonly<{
  kind: 'echo-staging-release-founder-authorization-v1';
  release_sha256: string;
  person_client_sha256: string;
  slack_approved: true;
  person_records_passed: true;
  person_ask_passed: true;
  release_authorized: true;
}>;

type ReleaseArtifact = Readonly<{ sha256: string; base64: string }>;
type RequestAction =
  | Readonly<{
      action: 'promote'; approval: StagingReleaseAuthorization; content_telemetry: null;
    }>
  | Readonly<{
      action: 'stage'; approval: null; content_telemetry: 'true' | 'false' | null;
    }>
  | Readonly<{
      action: Exclude<StagingReleaseAction, 'promote' | 'stage'>;
      approval: null; content_telemetry: null;
    }>;
type RequestFields<Tool extends StagingReleaseTool> = Readonly<{
  operation_id: string;
  created_at: number;
  expires_at: number;
  target: StagingReleaseTarget;
  tooling_source: string;
  previous_tooling_source: string;
  accepted: Readonly<{ release_id: string; sha256: string }>;
  candidate: Readonly<{
    release_id: string;
    sha256: string;
    person_client_sha256: string;
  }>;
  files: Readonly<Record<Tool | 'candidate.json' | 'runtime-profile.json', ReleaseArtifact>>;
  old_tool_hashes: Readonly<Record<Tool, string>>;
}> & RequestAction;

/** V1 receipts remain readable; V2 and named V3 migration plans may be submitted. */
export type StagingReleaseRequest =
  | (RequestFields<LegacyTool> & Readonly<{
      schema_version: 1; kind: 'echo-staging-release-request-v1';
      tooling_migration?: never;
    }>)
  | (RequestFields<StagingReleaseTool> & Readonly<{
      schema_version: 2; kind: 'echo-staging-release-request-v2';
      tooling_migration?: never;
    }>)
  | (RequestFields<StagingReleaseTool> & Readonly<{
      schema_version: 3; kind: 'echo-staging-release-request-v3';
      action: 'install' | 'inspect-install';
      tooling_migration: 'legacy-staging-host-v1';
    }>);

export type StagingReleaseInspectionCategory =
  | 'ready' | 'identity_invalid' | 'retained_mount_invalid'
  | 'deployment_path_invalid' | 'data_ownership_invalid' | 'release_control_invalid'
  | 'operation_locked' | 'legacy_lock_present' | 'operation_incomplete'
  | 'request_expired' | 'accepted_record_invalid' | 'accepted_record_mismatch'
  | 'environment_invalid' | 'hostname_mismatch' | 'candidate_present'
  | 'tool_missing' | 'tool_file_invalid' | 'tool_hash_unknown'
  | 'repair_pending' | 'inspection_failed' | 'control_path_changed';

type ToolProblem = 'tool_missing' | 'tool_file_invalid' | 'tool_hash_unknown';
type InspectionLocation =
  | Readonly<{ category: ToolProblem; tool: StagingReleaseTool }>
  | Readonly<{
      category: Exclude<StagingReleaseInspectionCategory, ToolProblem>; tool: null;
    }>;
export type StagingReleaseToolInventory = Readonly<Record<StagingReleaseTool,
  | Readonly<{ state: 'old' | 'new' | 'unknown'; sha256: string }>
  | Readonly<{ state: 'missing' | 'invalid'; sha256: null }>
>>;

export type StagingReleaseInspection = InspectionLocation & (
  | Readonly<{
      schema_version: 1; kind: 'echo-staging-release-install-inspection-v1';
    }>
  | Readonly<{
      schema_version: 2; kind: 'echo-staging-release-install-inspection-v2';
      inventory: StagingReleaseToolInventory | null;
    }>
);

export type StagingReleaseEnvironmentDiagnostic = Readonly<{
  schema_version: 1;
  kind: 'echo-clean-v1-environment-drift';
  release_id: string;
  candidate_staged: boolean;
  environment_matches: boolean;
  changed_settings: readonly [] | readonly ['ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1'];
  other_bytes_changed: boolean;
  allowlisted_settings_valid: boolean;
  environment_format_supported: boolean;
  repair_pending: boolean;
  repair_eligible: boolean;
  runtime_checked: false;
}>;

type OutcomeFields = Readonly<{
  schema_version: 1;
  kind: 'echo-staging-release-host-result-v1';
  operation_id: string;
  request_sha256: string;
  ok: boolean;
  code: StagingReleaseCode;
}>;
export type StagingReleaseOutcome = OutcomeFields & (
  | Readonly<{ action: 'inspect-install'; diagnostic: StagingReleaseInspection }>
  | Readonly<{ action: 'diagnose'; diagnostic: StagingReleaseEnvironmentDiagnostic | null }>
  | Readonly<{
      action: Exclude<StagingReleaseAction, 'inspect-install' | 'diagnose'>;
      diagnostic: null;
    }>
);

export type StagingReleaseState =
  | 'planned' | 'submitting' | 'submitted' | 'succeeded' | 'failed' | 'unconfirmed';
export type StagingReleaseSummary = Readonly<{
  schema_version: 1;
  kind: 'echo-staging-release-operation-v1';
  action: StagingReleaseAction;
  operation_id: string;
  instance_id: string;
  accepted_release_id: string;
  candidate_release_id: string;
  state: StagingReleaseState;
  command_id: string | null;
  outcome: StagingReleaseOutcome | null;
}>;

export type StagingReleaseReceipt = Readonly<{
  schema_version: 1;
  kind: 'echo-staging-release-operation-v1';
  request: StagingReleaseRequest;
  request_sha256: string;
  parameters_sha256: string;
  state: StagingReleaseState;
  command_id: string | null;
  outcome: StagingReleaseOutcome | null;
}>;

export type StagingReleasePlanOptions = Readonly<{
  acceptedRelease: string;
  release: string;
  runtimeProfile: string;
  output: string;
  previousToolingSource?: string;
}> & (
  | Readonly<{ action: 'promote'; approval: string; contentTelemetry?: never; toolingMigration?: never }>
  | Readonly<{ action: 'stage'; approval?: never; contentTelemetry?: 'true' | 'false'; toolingMigration?: never }>
  | Readonly<{
      action: 'install' | 'inspect-install';
      approval?: never; contentTelemetry?: never;
      toolingMigration?: 'legacy-staging-host-v1';
    }>
  | Readonly<{
      action: Exclude<StagingReleaseAction, 'promote' | 'stage' | 'install' | 'inspect-install'>;
      approval?: never; contentTelemetry?: never; toolingMigration?: never;
    }>
);
export type StagingReleaseSourceReader = (commit: string, path: string) => Buffer;
export type StagingReleaseAws = (args: string[]) => unknown;
export type StagingReleaseDependencies = Readonly<{
  aws?: StagingReleaseAws;
  readSource?: StagingReleaseSourceReader;
  runtime?: () => string;
  now?: () => number;
}>;

export function releaseAction(action: string): StagingReleaseAction;
export function stagingReleaseTarget(aws?: StagingReleaseAws): StagingReleaseTarget;
/** Validation boundaries accept untrusted input and return a checked contract. */
export function validateReleaseRequest(request: unknown, readSource?: StagingReleaseSourceReader): StagingReleaseRequest;
export function releaseSsmParameters(request: unknown, readSource?: StagingReleaseSourceReader): Readonly<{
  commands: readonly string[]; executionTimeout: readonly string[];
}>;
export function planStagingRelease(options: StagingReleasePlanOptions, dependencies?: StagingReleaseDependencies): StagingReleaseSummary;
export function executeStagingRelease(path: string, dependencies?: StagingReleaseDependencies, pollOnly?: boolean): StagingReleaseSummary;
export function safeReleaseOutcome(raw: string, request: StagingReleaseRequest, requestHash: string): StagingReleaseOutcome;
