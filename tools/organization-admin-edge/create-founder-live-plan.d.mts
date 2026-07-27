export type OrganizationAdminEdgeFounderLiveRecoveryMode =
  "disable_restore_same_candidate" | "rollback_previous_release";

export interface OrganizationAdminEdgeFounderLivePlanInput {
  readonly preparationPath: string;
  readonly restoredPreparationPath: string;
  readonly networkPolicyPath: string;
  readonly networkProcedurePath: string;
  readonly recoveryMode: OrganizationAdminEdgeFounderLiveRecoveryMode;
  readonly outputPath: string;
  readonly now?: string;
}

export interface OrganizationAdminEdgeFounderLivePlanResult {
  readonly ok: true;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly plan_path: string;
  readonly plan_sha256: string;
}

export function deriveOrganizationAdminEdgeFounderLivePlan(
  input: Omit<OrganizationAdminEdgeFounderLivePlanInput, "outputPath">,
): Readonly<Record<string, unknown>>;

export function createOrganizationAdminEdgeFounderLivePlan(
  input: OrganizationAdminEdgeFounderLivePlanInput,
): OrganizationAdminEdgeFounderLivePlanResult;
