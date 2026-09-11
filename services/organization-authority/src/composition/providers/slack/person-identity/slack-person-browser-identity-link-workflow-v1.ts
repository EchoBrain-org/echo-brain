import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { annotateCoreRuntimeV1, observeCoreRuntimeV1 } from "../../../../shared/core-runtime-observation-v1.js";
import {
  validateOrganizationPersonSlackBrowserLinkAttemptRequest,
  validateOrganizationPersonSlackBrowserLinkBeginRequest,
  validateOrganizationPersonSlackBrowserLinkBeginResponse,
  validateOrganizationPersonSlackBrowserLinkStatusResponse,
  type OrganizationPersonSlackBrowserLinkBeginResponseV1,
  type OrganizationPersonSlackBrowserLinkStatusResponseV1,
} from "@echo-brain/organization-api";
import type { ActiveSlackOrganizationTool, PersonSlackIdentityLinkSession } from "@echo-brain/organization-control-plane/slack-external-identity-integration-v1";
import type { PersonAccessAuthorization } from "../../../../application/person-identity-sessions.js";
import { AuthorityOperationError } from "../../../../domain/errors.js";
import type { SlackBrowserIdentityProvider } from "../../../../adapters/oidc/slack-browser-identity-provider.js";
import type {
  CompleteBrowserSlackIdentityLinkInputV1,
  SqliteSlackPersonIdentityLinkRepositoryV1,
} from "./sqlite-slack-person-identity-link-repository-v1.js";

const ATTEMPT_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 500;

type BrowserAttemptStatus = "pending" | "complete" | "cancelled" | "expired" | "failed";
type FailureReason = "provider_rejected" | "provider_unavailable" | "identity_conflict" | "tool_unavailable";

interface BrowserAttempt {
  readonly attempt_id: string;
  readonly request_id: string;
  readonly session: PersonSlackIdentityLinkSession;
  readonly organization_tool: ActiveSlackOrganizationTool;
  readonly state: string;
  readonly nonce: string;
  readonly code_verifier: string;
  readonly authorization_url: string;
  readonly created_at: string;
  readonly expires_at: string;
  status: BrowserAttemptStatus;
  failure_reason: FailureReason | null;
  proof: {
    readonly user_id: string;
    readonly team_id: string;
    readonly verification_evidence_sha256: `sha256:${string}`;
  } | null;
}

export interface SlackPersonBrowserIdentityLinkWorkflowOptionsV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly authentication: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly repository: Pick<SqliteSlackPersonIdentityLinkRepositoryV1,
    "activeSlackOrganizationTool" | "completeBrowserSlackIdentityLink">;
  readonly browser_provider: SlackBrowserIdentityProvider;
  readonly now?: () => string;
}

function personSession(authorization: PersonAccessAuthorization, authorityId: string): PersonSlackIdentityLinkSession {
  return Object.freeze({
    authority_id: authorityId,
    organization_id: authorization.organization_id,
    principal_id: authorization.principal_id,
    membership_id: authorization.membership_id,
    identity_binding_id: authorization.identity_binding_id,
    session_family_id: authorization.session_family_id,
  });
}

function sameSession(left: PersonSlackIdentityLinkSession, right: PersonSlackIdentityLinkSession): boolean {
  return left.authority_id === right.authority_id && left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id && left.membership_id === right.membership_id &&
    left.identity_binding_id === right.identity_binding_id && left.session_family_id === right.session_family_id;
}

function sameLinkOwner(left: PersonSlackIdentityLinkSession, right: PersonSlackIdentityLinkSession): boolean {
  return left.authority_id === right.authority_id && left.organization_id === right.organization_id &&
    left.principal_id === right.principal_id && left.membership_id === right.membership_id &&
    left.identity_binding_id === right.identity_binding_id;
}

function sameTool(left: ActiveSlackOrganizationTool, right: ActiveSlackOrganizationTool | null): right is ActiveSlackOrganizationTool {
  return right !== null && canonicalJson(left) === canonicalJson(right);
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function statusResponse(attempt: Pick<BrowserAttempt, "attempt_id" | "status" | "failure_reason">): OrganizationPersonSlackBrowserLinkStatusResponseV1 {
  return validateOrganizationPersonSlackBrowserLinkStatusResponse({
    schema_version: 1,
    kind: "echo-person-slack-browser-link-status-v1",
    attempt_id: attempt.attempt_id,
    status: attempt.status,
    failure_reason: attempt.failure_reason,
  });
}

/**
 * Holds only short-lived OIDC correlators and proof in process memory. The
 * callback does not write durable state: a current authenticated Person status
 * request performs the single durable link transaction.
 */
export class SlackPersonBrowserIdentityLinkWorkflowV1 {
  private readonly attempts = new Map<string, BrowserAttempt>();
  private readonly attemptByState = new Map<string, string>();
  private readonly attemptByMembership = new Map<string, string>();

  constructor(private readonly options: SlackPersonBrowserIdentityLinkWorkflowOptionsV1) {}

  async begin(input: unknown, accessToken: string): Promise<OrganizationPersonSlackBrowserLinkBeginResponseV1> {
    return this.observe("person_tool_delivery", async () => {
      let request: { request_id: string };
      try { request = validateOrganizationPersonSlackBrowserLinkBeginRequest(input); }
      catch { throw new AuthorityOperationError("invalid_request", "Slack browser link request is invalid"); }
      const current = this.authenticate(accessToken);
      this.expireAttempts(this.now());
      this.trimTerminalAttempts();
      const session = personSession(current, this.options.authority_id);
      const existing = this.attemptForMembership(session.membership_id);
      if (existing !== null) {
        if (existing.request_id === request.request_id && sameSession(existing.session, session)) return this.beginResponse(existing);
        if (!sameLinkOwner(existing.session, session)) {
          throw new AuthorityOperationError("unauthorized", "Person session does not own this Slack connection");
        }
        // A client can lose the begin response before it opens the browser. A
        // fresh request safely replaces only that same Person's pending proof.
        this.settle(existing, "cancelled");
      }
      if (this.attempts.size >= MAX_ATTEMPTS) throw new AuthorityOperationError("unavailable", "Slack connection is temporarily unavailable");
      const tool = this.options.repository.activeSlackOrganizationTool();
      if (tool === null) throw new AuthorityOperationError("conflict", "Slack is not active for this organization");
      const attemptId = `sbl_${randomUUID()}`;
      const state = randomSecret();
      const nonce = randomSecret();
      const codeVerifier = randomSecret();
      const expiresAt = new Date(Date.parse(this.now()) + ATTEMPT_LIFETIME_MS).toISOString();
      let authorizationUrl: string;
      try { authorizationUrl = this.options.browser_provider.authorizationUrl({ state, nonce, workspace_id: tool.team_id, code_verifier: codeVerifier }); }
      catch { throw new AuthorityOperationError("unavailable", "Slack connection is temporarily unavailable"); }
      const attempt: BrowserAttempt = { attempt_id: attemptId, request_id: request.request_id, session, organization_tool: tool,
        state, nonce, code_verifier: codeVerifier, authorization_url: authorizationUrl, expires_at: expiresAt,
        created_at: this.now(), status: "pending", failure_reason: null, proof: null };
      this.attempts.set(attemptId, attempt);
      this.attemptByState.set(state, attemptId);
      this.attemptByMembership.set(session.membership_id, attemptId);
      return this.beginResponse(attempt);
    });
  }

  async status(input: unknown, accessToken: string): Promise<OrganizationPersonSlackBrowserLinkStatusResponseV1> {
    return this.observe("person_tool_completion", async () => {
      const request = this.attemptRequest(input);
      const current = this.authenticate(accessToken);
      const attempt = this.attempts.get(request.attempt_id);
      if (attempt === undefined) return this.restartedStatus(request.attempt_id);
      this.expireAttempt(attempt, this.now());
      const session = personSession(current, this.options.authority_id);
      if (!sameSession(attempt.session, session)) throw new AuthorityOperationError("unauthorized", "Person session does not own this Slack connection");
      if (attempt.status !== "pending" || attempt.proof === null) return statusResponse(attempt);
      const activeTool = this.options.repository.activeSlackOrganizationTool();
      if (!sameTool(attempt.organization_tool, activeTool)) {
        this.settle(attempt, "failed", "tool_unavailable");
        return statusResponse(attempt);
      }
      try {
        const commit: CompleteBrowserSlackIdentityLinkInputV1 = {
          attempt_id: attempt.attempt_id, person_session: session, organization_tool: activeTool,
          provider_subject_id: attempt.proof.user_id, verification_evidence_sha256: attempt.proof.verification_evidence_sha256,
          now: current.checked_at,
        };
        this.options.repository.completeBrowserSlackIdentityLink(commit);
        this.settle(attempt, "complete");
      } catch (error) {
        this.settle(attempt, "failed", error instanceof Error &&
          (error.name === "OrganizationIntegrationConflictError" || error.name === "PersonSlackIdentityLinkConflictError")
          ? "identity_conflict" : "provider_unavailable");
      }
      return statusResponse(attempt);
    });
  }

  async cancel(input: unknown, accessToken: string): Promise<OrganizationPersonSlackBrowserLinkStatusResponseV1> {
    return this.observe("person_tool_completion", async () => {
      const request = this.attemptRequest(input);
      const session = personSession(this.authenticate(accessToken), this.options.authority_id);
      const attempt = this.attempts.get(request.attempt_id);
      if (attempt === undefined) return this.restartedStatus(request.attempt_id);
      this.expireAttempt(attempt, this.now());
      if (!sameSession(attempt.session, session)) throw new AuthorityOperationError("unauthorized", "Person session does not own this Slack connection");
      if (attempt.status === "pending") this.settle(attempt, "cancelled");
      return statusResponse(attempt);
    });
  }

  /** Called synchronously under the legacy workflow's disconnect write fence. */
  invalidateMembership(membershipId: string): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.session.membership_id === membershipId && attempt.status === "pending") {
        this.settle(attempt, "cancelled");
      }
    }
  }

  /** Called by the unauthenticated provider callback route. It never commits a link. */
  async callback(parameters: URLSearchParams): Promise<void> {
    await this.observe("person_tool_completion", async () => {
      const state = parameters.get("state");
      if (state === null) return { callback_result: "completed" as const };
      const attemptId = this.attemptByState.get(state);
      if (attemptId === undefined) return { callback_result: "completed" as const };
      const attempt = this.attempts.get(attemptId);
      if (attempt === undefined || attempt.status !== "pending") return { callback_result: "completed" as const };
      this.expireAttempt(attempt, this.now());
      if (attempt.status !== "pending") return { callback_result: "completed" as const };
      // State is one-shot before token exchange, so racing callbacks cannot each
      // exchange an authorization code or overwrite the proof.
      this.attemptByState.delete(state);
      try {
        const proof = await this.options.browser_provider.verifyCallback({ parameters, expectedState: attempt.state, expectedNonce: attempt.nonce,
          workspace_id: attempt.organization_tool.team_id, code_verifier: attempt.code_verifier });
        if (attempt.status !== "pending" || this.now() >= attempt.expires_at) {
          this.expireAttempt(attempt, this.now());
          return { callback_result: "completed" as const };
        }
        if (proof.team_id !== attempt.organization_tool.team_id || !/^[UW][A-Z0-9]{2,}$/.test(proof.user_id)) {
          this.settle(attempt, "failed", "provider_rejected");
          return { callback_result: "invalid_output" as const };
        }
        attempt.proof = Object.freeze(proof);
        return { callback_result: "completed" as const };
      } catch {
        if (attempt.status === "pending") {
          this.settle(attempt, "failed", "provider_rejected");
          return { callback_result: "invalid_output" as const };
        }
        return { callback_result: "completed" as const };
      }
    });
  }

  private beginResponse(attempt: BrowserAttempt): OrganizationPersonSlackBrowserLinkBeginResponseV1 {
    return validateOrganizationPersonSlackBrowserLinkBeginResponse({ schema_version: 1, kind: "echo-person-slack-browser-link-v1",
      attempt_id: attempt.attempt_id, authorization_url: attempt.authorization_url, expires_at: attempt.expires_at });
  }

  private attemptRequest(input: unknown): { attempt_id: string } {
    try { return validateOrganizationPersonSlackBrowserLinkAttemptRequest(input); }
    catch { throw new AuthorityOperationError("invalid_request", "Slack browser link attempt is invalid"); }
  }

  private authenticate(accessToken: string): PersonAccessAuthorization {
    const authorization = this.options.authentication.authenticateAccess({ access_token: accessToken });
    if (authorization.organization_id !== this.options.organization_id) {
      throw new AuthorityOperationError("unauthorized", "person authentication failed");
    }
    return authorization;
  }

  private attemptForMembership(membershipId: string): BrowserAttempt | null {
    const attemptId = this.attemptByMembership.get(membershipId);
    return attemptId === undefined ? null : this.attempts.get(attemptId) ?? null;
  }

  private expireAttempts(now: string): void {
    for (const attempt of this.attempts.values()) this.expireAttempt(attempt, now);
  }

  private expireAttempt(attempt: BrowserAttempt, now: string): void {
    if (attempt.status === "pending" && now >= attempt.expires_at) {
      this.settle(attempt, "expired");
    }
  }

  private releaseMembership(attempt: BrowserAttempt): void {
    if (this.attemptByMembership.get(attempt.session.membership_id) === attempt.attempt_id) {
      this.attemptByMembership.delete(attempt.session.membership_id);
    }
  }

  private settle(
    attempt: BrowserAttempt,
    status: Exclude<BrowserAttemptStatus, "pending">,
    failure_reason: FailureReason | null = null,
  ): void {
    attempt.status = status;
    attempt.failure_reason = failure_reason;
    this.attemptByState.delete(attempt.state);
    this.releaseMembership(attempt);
  }

  private trimTerminalAttempts(): void {
    const terminals = [...this.attempts.values()]
      .filter((attempt) => attempt.status !== "pending")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    while (this.attempts.size >= MAX_ATTEMPTS && terminals.length > 0) {
      const attempt = terminals.shift()!;
      this.attempts.delete(attempt.attempt_id);
      this.attemptByState.delete(attempt.state);
    }
  }

  private restartedStatus(attemptId: string): OrganizationPersonSlackBrowserLinkStatusResponseV1 {
    return validateOrganizationPersonSlackBrowserLinkStatusResponse({ schema_version: 1, kind: "echo-person-slack-browser-link-status-v1",
      attempt_id: attemptId, status: "expired", failure_reason: null });
  }

  private async observe<T>(phase: "person_tool_delivery" | "person_tool_completion", operation: () => Promise<T>): Promise<T> {
    return observeCoreRuntimeV1(phase, async () => {
      try {
        const value = await operation();
        const status = value !== null && typeof value === "object"
          ? value as { status?: unknown; failure_reason?: unknown; callback_result?: unknown }
          : {};
        annotateCoreRuntimeV1({ result: status.callback_result === "invalid_output" ? "invalid_output" : status.status === "failed"
          ? status.failure_reason === "identity_conflict" ? "competing_action" : "unavailable"
          : "completed" });
        return value;
      }
      catch (error) {
        annotateCoreRuntimeV1({ result: error instanceof AuthorityOperationError && error.code === "unauthorized" ? "authorization" : "unavailable" });
        throw error;
      }
    });
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}
