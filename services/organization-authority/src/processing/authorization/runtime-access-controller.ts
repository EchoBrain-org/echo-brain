import type { OrganizationInstallationAccessDecisionV1 } from '@echo-brain/organization-protocol';

/** The bounded access-session capability used by the processing runtime. */
export interface OrganizationRuntimeAccessSession {
  readonly coordinator: {
    currentAccess(): OrganizationInstallationAccessDecisionV1;
    refreshAccess(): Promise<OrganizationInstallationAccessDecisionV1>;
  };
  close(): void;
}

export interface OrganizationRuntimeAccessControllerOptions {
  openRuntime(): OrganizationRuntimeAccessSession;
  now: () => string;
  renewalLeadMs?: number;
  renewalIntervalMs?: number;
}

const DEFAULT_RENEWAL_LEAD_MS = 60_000;
const DEFAULT_RENEWAL_INTERVAL_MS = 30_000;

class OrganizationAccessRevokedError extends Error {}

function accessDenied(
  decision: Extract<
    OrganizationInstallationAccessDecisionV1,
    { permitted: false }
  >,
): Error {
  return new OrganizationAccessRevokedError(
    `organization ${decision.state.revocation_reason.replaceAll('_', ' ')}`,
  );
}

/**
 * Bridges durable organization authorization into the product runtime.
 *
 * Each check opens the organization store for one bounded operation. A valid
 * cached signed lease may carry a transient authority outage only until its
 * signed expiry; revoked and expired states fail closed.
 */
export class OrganizationRuntimeAccessController {
  private readonly now: () => string;
  private readonly renewalLeadMs: number;
  private readonly renewalIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private activeCheck: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: OrganizationRuntimeAccessControllerOptions,
  ) {
    this.now = options.now;
    this.renewalLeadMs =
      options.renewalLeadMs ?? DEFAULT_RENEWAL_LEAD_MS;
    this.renewalIntervalMs =
      options.renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.renewalLeadMs) ||
      this.renewalLeadMs < 0 ||
      !Number.isSafeInteger(this.renewalIntervalMs) ||
      this.renewalIntervalMs <= 0
    ) {
      throw new Error('organization access renewal intervals are invalid');
    }
  }

  private async check(): Promise<void> {
    if (this.closed) throw new Error('organization access gate is closed');
    const runtime = this.options.openRuntime();
    try {
      let cached:
        | Extract<OrganizationInstallationAccessDecisionV1, { permitted: true }>
        | null = null;
      try {
        const current = runtime.coordinator.currentAccess();
        if (!current.permitted) throw accessDenied(current);
        cached = current;
        if (
          Date.parse(current.state.valid_until) - Date.parse(this.now()) >
          this.renewalLeadMs
        ) {
          return;
        }
      } catch (error) {
        // A durable revocation must never be hidden by a refresh attempt.
        if (error instanceof OrganizationAccessRevokedError) {
          throw error;
        }
      }

      try {
        const refreshed = await runtime.coordinator.refreshAccess();
        if (!refreshed.permitted) throw accessDenied(refreshed);
      } catch (error) {
        // A still-current signed lease is valid offline evidence. Once it
        // expires, currentAccess() stops returning it and refresh must succeed.
        if (
          cached !== null &&
          Date.parse(cached.state.valid_until) > Date.parse(this.now())
        ) {
          return;
        }
        throw error;
      }
    } finally {
      runtime.close();
    }
  }

  assertAuthorized(): Promise<void> {
    if (this.activeCheck !== null) return this.activeCheck;
    this.activeCheck = this.check().finally(() => {
      this.activeCheck = null;
    });
    return this.activeCheck;
  }

  start(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.assertAuthorized().catch(() => {
        // The durable decision remains authoritative. The next foreground
        // cycle rechecks it and reports a structured fail-closed error.
      });
    }, this.renewalIntervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
