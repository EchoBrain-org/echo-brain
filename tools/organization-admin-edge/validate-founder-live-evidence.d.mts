export const ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_CHECK_IDS: readonly string[];
export const ORGANIZATION_ADMIN_EDGE_FOUNDER_LIVE_KNOWN_LIMITATIONS: readonly string[];

export interface OrganizationAdminEdgeFounderLiveValidation {
  readonly ok: boolean;
  readonly errors: string[];
}

export function validateOrganizationAdminEdgeFounderLiveEvidence(
  report: unknown,
  planContext?: Readonly<{
    plan: unknown;
    sha256: string;
    commitment: unknown;
    commitmentSha256: string;
  }> | null,
): OrganizationAdminEdgeFounderLiveValidation;
