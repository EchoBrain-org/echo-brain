import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { OrganizationToolSetupStatusV4 } from "@echo-brain/organization-api";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { OrganizationSecretStore } from "@echo-brain/organization-control-plane/application/organization-secret-store-contracts";
import {
  validateOrganizationSlackAppCredentialsRequestV1,
  validateOrganizationSlackInstallAttemptRequestV1,
  validateOrganizationSlackInstallBeginRequestV1,
  validateOrganizationSlackInstallBeginResponseV1,
  validateOrganizationSlackInstallStatusResponseV1,
  validateOrganizationSlackRecipeResponseV1,
  validateOrganizationSlackSetupRequestV1,
  validateOrganizationSlackSetupResponseV1,
  type OrganizationSlackInstallBeginResponseV1,
  type OrganizationSlackInstallFailureReasonV1,
  type OrganizationSlackInstallResultV1,
  type OrganizationSlackInstallStatusResponseV1,
  type OrganizationSlackRecipeResponseV1,
  type OrganizationSlackSetupResponseV1,
} from "@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1";
import { NangoClientErrorV1, type NangoConnectionClientV1, type NangoSlackConnectionV1 } from "../organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { buildEchoSlackAppManifestV1, SLACK_PRIVATE_APP_BOT_SCOPES_V1, SlackAppManifestProviderErrorV1, type SlackAppManifestProviderV1 } from "../organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { SlackIdentityProviderErrorV1 } from "../organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { findPendingSlackAppCredentialsV1, findSlackAppCredentialsByReferenceSha256V1, parseSlackAppCredentialsV1, serializeSlackAppCredentialsV1, SLACK_APP_CREDENTIALS_KIND_V1, type FoundSlackAppCredentialsV1 } from "../organization-control-plane/application/slack-app-credentials-v1.js";
import type { SlackConnectionHealthV1 } from "../organization-control-plane/application/slack-connection-health-v1.js";
import { readActiveSlackConnectionV1 } from "../organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import type { SlackConnectionVerifierV1 } from "../organization-control-plane/persistence/sqlite-slack-connection-coordinator-v1.js";
import { activateNangoSlackConnectionV1, SlackConnectionRefusedErrorV1 } from "../organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 50;
const IN_PROGRESS = "Slack setup is in progress";

/** What the Authority composition passes when Nango is configured; absent, no setup route exists. */
export interface SlackOrganizationSetupOptionsV1 {
  readonly authority_url: string;
  readonly nango: { readonly client: NangoConnectionClientV1; readonly callback_url: string };
  readonly manifest_provider: SlackAppManifestProviderV1;
  /** Defaults to the Slack identity provider's `auth.test` check. */
  readonly verifier?: Pick<SlackConnectionVerifierV1, "verifyConnection">;
  /** Defaults to the runtime bundle's `connection_health`; the two must be one instance. */
  readonly health?: SlackConnectionHealthV1;
}

export interface SlackOrganizationSetupWorkflowOptionsV1 extends SlackOrganizationSetupOptionsV1 {
  readonly health: SlackConnectionHealthV1;
  readonly database: Database.Database;
  readonly secrets: OrganizationSecretStore;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly authentication: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly verifier: Pick<SlackConnectionVerifierV1, "verifyConnection">;
  readonly now?: () => string;
  readonly new_connection_id?: () => string;
}

type InstallState = Pick<OrganizationSlackInstallStatusResponseV1, "attempt_id" | "status" | "failure_reason" | "outstanding_approvals" | "result">;

interface InstallAttempt extends InstallState {
  readonly request_id: string;
  readonly session: PersonAccessAuthorization;
  /** Held only while pending: settling drops the client and signing secrets. */
  credential: FoundSlackAppCredentialsV1 | null;
  /** A reconnect reuses this Nango connection; `updated_at` is its timestamp at begin. */
  readonly reconnect: { readonly connection_id: string; readonly updated_at: string } | null;
  readonly confirm_replacement: boolean;
  readonly connect_link: string;
  readonly expires_at: string;
}

function sameSession(left: PersonAccessAuthorization, right: PersonAccessAuthorization): boolean {
  return left.organization_id === right.organization_id && left.principal_id === right.principal_id &&
    left.membership_id === right.membership_id && left.identity_binding_id === right.identity_binding_id &&
    left.session_family_id === right.session_family_id;
}

/**
 * Spike-sensitive (assumptions A3-A5, ruling P1); adjust here only. A first
 * install is found by its attempt tag. A reconnect keeps its connection id and
 * has finished once Nango's update timestamp passes the one read at begin:
 * Slack may return the same bot token on a reinstall, so the token is no signal.
 */
async function finishedNangoConnectionV1(
  nango: NangoConnectionClientV1,
  attempt: Pick<InstallAttempt, "attempt_id" | "reconnect">,
): Promise<NangoSlackConnectionV1 | undefined> {
  if (attempt.reconnect !== null) {
    const connection = await nango.getSlackConnection({ connection_id: attempt.reconnect.connection_id });
    return Date.parse(connection.updated_at) > Date.parse(attempt.reconnect.updated_at) ? connection : undefined;
  }
  const connectionId = await nango.findConnectionIdByTag({ key: "echo_attempt_id", value: attempt.attempt_id });
  return connectionId === undefined ? undefined : nango.getSlackConnection({ connection_id: connectionId });
}

/** A first install carries this attempt's tags; Nango may keep a reconnected connection's original tags. */
function tagsMatch(connection: NangoSlackConnectionV1, attempt: InstallAttempt, organizationId: string): boolean {
  const { tags } = connection;
  return tags.echo_organization_id === organizationId && (attempt.reconnect !== null ||
    (tags.echo_attempt_id === attempt.attempt_id && tags.echo_membership_id === attempt.session.membership_id));
}

function failureOf(error: unknown): { reason: OrganizationSlackInstallFailureReasonV1; outstanding: number | null } {
  if (error instanceof SlackConnectionRefusedErrorV1) return { reason: error.reason, outstanding: error.outstanding_approvals };
  if ((error instanceof NangoClientErrorV1 && error.code === "unauthorized") || error instanceof SlackAppManifestProviderErrorV1 ||
    (error instanceof SlackIdentityProviderErrorV1 && error.code === "unauthorized")) {
    return { reason: "provider_rejected", outstanding: null };
  }
  return { reason: "provider_unavailable", outstanding: null };
}

function unavailable(): AuthorityOperationError {
  return new AuthorityOperationError("unavailable", "Slack setup is unavailable");
}

/** Fixed messages only: Slack's errors may carry the configuration token. */
function setupError(error: unknown): AuthorityOperationError {
  if (error instanceof AuthorityOperationError) return error;
  if (error instanceof SlackAppManifestProviderErrorV1 && error.code === "invalid_token") {
    return new AuthorityOperationError("invalid_request", "Slack setup token is invalid");
  }
  if (error instanceof SlackAppManifestProviderErrorV1 && error.code === "invalid_manifest") {
    return new AuthorityOperationError("invalid_output", "Slack rejected the ECHO app recipe");
  }
  return unavailable();
}

function setupResponse(appId: string, setup: "app_created" | "connected"): OrganizationSlackSetupResponseV1 {
  return validateOrganizationSlackSetupResponseV1({ schema_version: 1, kind: "echo-organization-slack-setup-v1", app_id: appId, organization_setup: setup });
}

function statusResponse(state: InstallState): OrganizationSlackInstallStatusResponseV1 {
  return validateOrganizationSlackInstallStatusResponseV1({
    schema_version: 1, kind: "echo-organization-slack-install-status-v1", attempt_id: state.attempt_id, status: state.status,
    failure_reason: state.failure_reason, outstanding_approvals: state.outstanding_approvals, result: state.result,
  });
}

/**
 * Owner-only setup of the organization's private Slack app and its Nango
 * install. Install attempts live only in process memory; the single durable
 * write is the connection activation run by an authenticated status read from
 * the owner session that began the attempt.
 */
export class SlackOrganizationSetupWorkflowV1 {
  private readonly attempts = new Map<string, InstallAttempt>();
  private readonly manifest: Readonly<Record<string, unknown>>;
  /** One setup, credential change, install begin or install check at a time. */
  private busy = false;
  private checking: string | null = null;

  constructor(private readonly options: SlackOrganizationSetupWorkflowOptionsV1) {
    this.manifest = buildEchoSlackAppManifestV1({ authority_url: options.authority_url, nango_callback_url: options.nango.callback_url });
  }

  /** Creates the ECHO app, or updates the organization's existing one; never a duplicate. */
  async setup(input: unknown, accessToken: string): Promise<OrganizationSlackSetupResponseV1> {
    this.owner(accessToken);
    const request = this.request(() => validateOrganizationSlackSetupRequestV1(input), "Slack setup request is invalid");
    return this.exclusive(async () => {
      try {
        const active = this.activeNangoBundle();
        const target = active ?? findPendingSlackAppCredentialsV1(this.options.secrets);
        if (target !== undefined) {
          await this.options.manifest_provider.updateApp({ configuration_token: request.configuration_token,
            app_id: target.credentials.app_id, manifest: this.manifest });
          return setupResponse(target.credentials.app_id, active === undefined ? "app_created" : "connected");
        }
        const created = await this.options.manifest_provider.createApp({ configuration_token: request.configuration_token, manifest: this.manifest });
        this.options.secrets.create(serializeSlackAppCredentialsV1({ kind: SLACK_APP_CREDENTIALS_KIND_V1, app_id: created.app_id,
          client_id: created.client_id, client_secret: created.client_secret, signing_secret: created.signing_secret, nango_connection_id: null }));
        return setupResponse(created.app_id, "app_created");
      } catch (error) {
        throw setupError(error);
      }
    });
  }

  /** The manual fallback; it replaces any pending app (ruling R5). */
  async appCredentials(input: unknown, accessToken: string): Promise<OrganizationSlackSetupResponseV1> {
    const session = this.owner(accessToken);
    const credentials = this.request(() => {
      const request = validateOrganizationSlackAppCredentialsRequestV1(input);
      return parseSlackAppCredentialsV1(JSON.stringify({ kind: SLACK_APP_CREDENTIALS_KIND_V1, app_id: request.app_id, client_id: request.client_id,
        client_secret: request.client_secret, signing_secret: request.signing_secret, nango_connection_id: null }));
    }, "Slack app credentials are invalid");
    return this.exclusive(async () => {
      if (this.activeNangoBundle()?.credentials.app_id === credentials.app_id) {
        throw new AuthorityOperationError("conflict", "This Slack app is already connected");
      }
      this.expireAndTrim(this.now());
      const install = this.pendingAttempt();
      if (install !== undefined && !sameSession(install.session, session)) throw new AuthorityOperationError("conflict", IN_PROGRESS);
      const pending = findPendingSlackAppCredentialsV1(this.options.secrets);
      if (pending !== undefined) this.options.secrets.remove(pending.reference);
      this.options.secrets.create(serializeSlackAppCredentialsV1(credentials));
      // The owner's own install begun before this change could only finish as the old app.
      if (install !== undefined) this.settle(install, "cancelled");
      return setupResponse(credentials.app_id, "app_created");
    });
  }

  async recipe(accessToken: string): Promise<OrganizationSlackRecipeResponseV1> {
    this.owner(accessToken);
    return validateOrganizationSlackRecipeResponseV1({ schema_version: 1, kind: "echo-organization-slack-recipe-v1", manifest: this.manifest });
  }

  async beginInstall(input: unknown, accessToken: string): Promise<OrganizationSlackInstallBeginResponseV1> {
    const session = this.owner(accessToken);
    const request = this.request(() => validateOrganizationSlackInstallBeginRequestV1(input), "Slack install request is invalid");
    return this.exclusive(async () => {
      const now = this.now();
      this.expireAndTrim(now);
      const existing = this.pendingAttempt();
      if (existing !== undefined) {
        if (!sameSession(existing.session, session)) throw new AuthorityOperationError("conflict", IN_PROGRESS);
        if (existing.request_id === request.request_id) {
          if (existing.confirm_replacement !== request.confirm_replacement) {
            throw new AuthorityOperationError("conflict", "Slack install request was already used differently");
          }
          return this.beginResponse(existing);
        }
        this.settle(existing, "cancelled");
      }
      if (this.attempts.size >= MAX_ATTEMPTS) throw unavailable();
      const credential = this.installCredential();
      const attemptId = `ssi_${randomUUID()}`;
      const tags = Object.freeze({ echo_organization_id: this.options.organization_id, echo_membership_id: session.membership_id, echo_attempt_id: attemptId });
      const client = { client_id: credential.credentials.client_id, client_secret: credential.credentials.client_secret, scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 };
      const nango = this.options.nango.client;
      const connectionId = credential.credentials.nango_connection_id;
      let reconnect: InstallAttempt["reconnect"] = null;
      let opened: { connect_link: string };
      if (connectionId === null) {
        opened = await nango.createConnectSession({ tags, ...client });
      } else {
        opened = await nango.createReconnectSession({ connection_id: connectionId, tags, ...client });
        // Read after the session exists, so its own effect on the connection is not mistaken for a finished reconnect.
        reconnect = Object.freeze({ connection_id: connectionId, updated_at: (await nango.getSlackConnection({ connection_id: connectionId })).updated_at });
      }
      const attempt: InstallAttempt = { attempt_id: attemptId, request_id: request.request_id, session, credential, reconnect,
        confirm_replacement: request.confirm_replacement, connect_link: opened.connect_link,
        expires_at: new Date(Date.parse(now) + ATTEMPT_LIFETIME_MS).toISOString(),
        status: "pending", failure_reason: null, outstanding_approvals: null, result: null };
      const response = this.beginResponse(attempt);
      this.attempts.set(attemptId, attempt);
      return response;
    });
  }

  /** Polled by the owner; the only call that can activate the connection. */
  async installStatus(input: unknown, accessToken: string): Promise<OrganizationSlackInstallStatusResponseV1> {
    const attempt = this.ownedAttempt(input, this.owner(accessToken));
    if (typeof attempt === "string") return this.expired(attempt);
    // A concurrent check or setup decides first; the client polls again.
    if (attempt.status !== "pending" || attempt.credential === null || this.busy) return statusResponse(attempt);
    const credential = attempt.credential;
    this.busy = true;
    this.checking = attempt.attempt_id;
    try {
      let connection: NangoSlackConnectionV1 | undefined;
      try {
        connection = await finishedNangoConnectionV1(this.options.nango.client, attempt);
      } catch (error) {
        // Ruling P8: a Nango blip while looking is not an outcome; the attempt lives until it expires.
        if (error instanceof NangoClientErrorV1 && error.code === "unavailable") return statusResponse(attempt);
        throw error;
      }
      if (connection === undefined) return statusResponse(attempt);
      if (!tagsMatch(connection, attempt, this.options.organization_id)) throw new SlackConnectionRefusedErrorV1("workspace_mismatch", null);
      const activated = await activateNangoSlackConnectionV1({
        database: this.options.database, secrets: this.options.secrets, verifier: this.options.verifier,
        authority_id: this.options.authority_id, organization_id: this.options.organization_id, state_lineage_id: this.options.state_lineage_id,
        credential, nango: connection, confirm_replacement: attempt.confirm_replacement,
        now: () => this.now(), new_connection_id: this.options.new_connection_id ?? (() => `con_${randomUUID()}`),
      });
      this.options.health.clear();
      const result: OrganizationSlackInstallResultV1 = { kind: activated.kind, workspace_id: activated.connection.provider_tenant_id,
        person_links_revoked: activated.person_links_revoked };
      this.settle(attempt, "complete", null, null, result);
    } catch (error) {
      const failure = failureOf(error);
      this.settle(attempt, "failed", failure.reason, failure.outstanding);
    } finally {
      this.busy = false;
      this.checking = null;
    }
    return statusResponse(attempt);
  }

  async cancelInstall(input: unknown, accessToken: string): Promise<OrganizationSlackInstallStatusResponseV1> {
    const attempt = this.ownedAttempt(input, this.owner(accessToken));
    if (typeof attempt === "string") return this.expired(attempt);
    // An activation already under way finishes; its status read reports the outcome.
    if (attempt.status === "pending" && this.checking !== attempt.attempt_id) this.settle(attempt, "cancelled");
    return statusResponse(attempt);
  }

  organizationSetup(): OrganizationToolSetupStatusV4 {
    const active = readActiveSlackConnectionV1(this.options.database);
    if (active !== undefined) return this.options.health.needsReinstall(active.state_sha256) ? "needs_reinstall" : "connected";
    return findPendingSlackAppCredentialsV1(this.options.secrets) === undefined ? "not_set_up" : "app_created";
  }

  /** The setup status for an owner; null for everyone else. */
  organizationSetupForCaller(accessToken: string): OrganizationToolSetupStatusV4 | null {
    const caller = this.options.authentication.authenticateAccess({ access_token: accessToken });
    return caller.organization_id === this.options.organization_id && caller.membership_type === "owner" ? this.organizationSetup() : null;
  }

  /** Re-checked on every call. */
  private owner(accessToken: string): PersonAccessAuthorization {
    const caller = this.options.authentication.authenticateAccess({ access_token: accessToken });
    if (caller.organization_id !== this.options.organization_id || caller.membership_type !== "owner") {
      throw new AuthorityOperationError("unauthorized", "person authentication failed");
    }
    return caller;
  }

  private request<T>(parse: () => T, message: string): T {
    try { return parse(); } catch { throw new AuthorityOperationError("invalid_request", message); }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new AuthorityOperationError("conflict", IN_PROGRESS);
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      throw error instanceof AuthorityOperationError ? error : unavailable();
    } finally {
      this.busy = false;
    }
  }

  private activeNangoBundle(): FoundSlackAppCredentialsV1 | undefined {
    const active = readActiveSlackConnectionV1(this.options.database);
    return active?.kind === "nango"
      ? findSlackAppCredentialsByReferenceSha256V1(this.options.secrets, active.state.credential_reference_sha256)
      : undefined;
  }

  /** The pending app, else the connected Nango app (a reconnect). */
  private installCredential(): FoundSlackAppCredentialsV1 {
    const active = this.activeNangoBundle();
    const pending = findPendingSlackAppCredentialsV1(this.options.secrets);
    if (pending !== undefined && active !== undefined && pending.credentials.app_id === active.credentials.app_id) {
      // Ruling P5: a stray pending copy of the connected app must not start a second connection for it.
      this.options.secrets.remove(pending.reference);
      return active;
    }
    const credential = pending ?? active;
    if (credential === undefined) throw new AuthorityOperationError("conflict", "Slack app is not set up");
    return credential;
  }

  private beginResponse(attempt: InstallAttempt): OrganizationSlackInstallBeginResponseV1 {
    try {
      return validateOrganizationSlackInstallBeginResponseV1({ schema_version: 1, kind: "echo-organization-slack-install-v1",
        attempt_id: attempt.attempt_id, connect_link: attempt.connect_link, expires_at: attempt.expires_at });
    } catch {
      throw new AuthorityOperationError("invalid_output", "Nango returned an invalid connect link");
    }
  }

  /** Returns the attempt id alone when process memory no longer holds it. */
  private ownedAttempt(input: unknown, session: PersonAccessAuthorization): InstallAttempt | string {
    const { attempt_id } = this.request(() => validateOrganizationSlackInstallAttemptRequestV1(input), "Slack install attempt is invalid");
    const attempt = this.attempts.get(attempt_id);
    if (attempt === undefined) return attempt_id;
    if (!sameSession(attempt.session, session)) throw new AuthorityOperationError("unauthorized", "person authentication failed");
    if (attempt.status === "pending" && this.now() >= attempt.expires_at && this.checking !== attempt.attempt_id) this.settle(attempt, "expired");
    return attempt;
  }

  private expired(attemptId: string): OrganizationSlackInstallStatusResponseV1 {
    return statusResponse({ attempt_id: attemptId, status: "expired", failure_reason: null, outstanding_approvals: null, result: null });
  }

  private expireAndTrim(now: string): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.status === "pending" && now >= attempt.expires_at) this.settle(attempt, "expired");
    }
    // Map order is creation order, so the oldest finished attempts go first.
    const finished = [...this.attempts.values()].filter((attempt) => attempt.status !== "pending");
    while (this.attempts.size >= MAX_ATTEMPTS && finished.length > 0) this.attempts.delete(finished.shift()!.attempt_id);
  }

  private settle(
    attempt: InstallAttempt,
    status: Exclude<InstallAttempt["status"], "pending">,
    failure_reason: InstallAttempt["failure_reason"] = null,
    outstanding_approvals: number | null = null,
    result: InstallAttempt["result"] = null,
  ): void {
    attempt.status = status;
    attempt.failure_reason = failure_reason;
    attempt.outstanding_approvals = outstanding_approvals;
    attempt.result = result;
    attempt.credential = null;
  }

  private pendingAttempt(): InstallAttempt | undefined {
    return [...this.attempts.values()].find((attempt) => attempt.status === "pending");
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}
