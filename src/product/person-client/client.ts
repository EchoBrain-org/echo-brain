import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import {
  validateOrganizationPersonSession,
  type OrganizationPersonMeetingIngestionExclusionSelectorV2,
  type OrganizationPersonSessionV2,
} from "@echo-brain/organization-api";
import {
  PersonAuthorityClient,
  PersonAuthorityClientError,
  type EmployeeRosterV1,
  type PersonAnswerV1,
  type PersonRecordListV1,
  type PersonRecordSearchV1,
} from "./authority-client.js";
import {
  createPersonMeetingIngestionExclusionChangeRequest,
  createPersonMeetingIngestionExclusionListRequest,
  createPersonSlackIdentityLinkBeginRequest,
  createPersonSlackIdentityLinkCompleteRequest,
} from "./person-api-request-builders.js";
import {
  PersonClientSessionUnavailableError,
  PersonSessionStore,
  type StoredPersonClientSessionV1,
} from "./session-store.js";
import {
  preflightPersonOnboardingInvitationOutput,
  writePersonOnboardingInvitation,
} from "./onboarding-invitation.js";

interface PersonOidcLoopbackHandoff {
  readonly url: string;
  readonly token: string;
}

export interface PersonClientOptions {
  readonly home_directory: string;
  readonly fetch?: typeof fetch;
  readonly allow_insecure_loopback?: boolean;
  readonly now?: () => string;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly random_uuid?: () => string;
}

export interface PersonClientSessionSummary {
  readonly authority_origin: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
  readonly access_expires_at: string;
  readonly hard_reauthentication_at: string;
}

function summary(
  stored: StoredPersonClientSessionV1,
): PersonClientSessionSummary {
  return Object.freeze({
    authority_origin: stored.authority_origin,
    authority_id: stored.authority_id,
    organization_id: stored.session.organization_id,
    principal_id: stored.session.principal_id,
    membership_id: stored.session.membership_id,
    membership_type: stored.session.membership_type,
    access_expires_at: stored.session.access_expires_at,
    hard_reauthentication_at: stored.session.hard_reauthentication_at,
  });
}

function assertRefreshIdentity(
  previous: OrganizationPersonSessionV2,
  next: OrganizationPersonSessionV2,
): void {
  for (const key of [
    "organization_id",
    "principal_id",
    "membership_id",
    "membership_type",
    "identity_binding_id",
    "session_family_id",
    "hard_reauthentication_at",
  ] as const) {
    if (previous[key] !== next[key]) {
      throw new Error(`Person session refresh changed ${key}`);
    }
  }
  if (previous.refresh_token === next.refresh_token) {
    throw new Error("Person session refresh did not rotate its refresh token");
  }
}

export class PersonClient {
  private readonly store: PersonSessionStore;
  private readonly now: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly randomUuid: () => string;

  constructor(private readonly options: PersonClientOptions) {
    this.store = new PersonSessionStore(options.home_directory);
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.random_bytes ?? randomBytes;
    this.randomUuid = options.random_uuid ?? randomUUID;
  }

  private authority(origin: string): PersonAuthorityClient {
    return new PersonAuthorityClient({
      authority_origin: origin,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
      allow_insecure_loopback: this.options.allow_insecure_loopback === true,
    });
  }

  private currentTime(): number {
    const value = Date.parse(this.now());
    if (!Number.isFinite(value))
      throw new Error("Person client clock is invalid");
    return value;
  }

  private requestId(
    prefix: "rdr" | "rrd" | "osq" | "mex" | "psb" | "psc",
  ): string {
    return `${prefix}_${this.randomUuid()}`;
  }

  async beginLogin(
    authorityOrigin: string,
    loginGrant?: string,
    loopbackHandoff?: PersonOidcLoopbackHandoff,
  ) {
    return await this.authority(authorityOrigin).beginOidcLogin(
      loginGrant === undefined
        ? {
            kind: "existing_identity_login",
            ...(loopbackHandoff === undefined
              ? {}
              : { loopback_handoff: loopbackHandoff }),
          }
        : {
            kind: "identity_bootstrap",
            login_grant: loginGrant,
            ...(loopbackHandoff === undefined
              ? {}
              : { loopback_handoff: loopbackHandoff }),
          },
    );
  }

  async installSession(
    authorityOrigin: string,
    value: unknown,
  ): Promise<PersonClientSessionSummary> {
    const session = validateOrganizationPersonSession(value);
    if (this.currentTime() >= Date.parse(session.hard_reauthentication_at)) {
      throw new Error("Person session is already past hard reauthentication");
    }
    const descriptor = await this.authority(authorityOrigin).descriptor();
    if (
      descriptor.authority_descriptor.organization_id !==
      session.organization_id
    ) {
      throw new Error("Person session belongs to another organization");
    }
    return summary(
      this.store.install(
        authorityOrigin,
        descriptor.authority_descriptor.authority_id,
        session,
      ),
    );
  }

  sessionSummary(): PersonClientSessionSummary {
    return summary(this.store.read());
  }

  async refresh(): Promise<PersonClientSessionSummary> {
    const claimed = this.store.claimRefresh();
    if (
      this.currentTime() >=
      Date.parse(claimed.stored.session.hard_reauthentication_at)
    ) {
      throw new PersonClientSessionUnavailableError(
        "Person session requires authentication again",
      );
    }
    const next = await this.authority(claimed.stored.authority_origin).refresh(
      claimed.stored.session.refresh_token,
    );
    assertRefreshIdentity(claimed.stored.session, next);
    return summary(this.store.completeRefresh(claimed, next));
  }

  private async accessSession(): Promise<StoredPersonClientSessionV1> {
    const stored = this.store.read();
    if (this.currentTime() < Date.parse(stored.session.access_expires_at)) {
      return stored;
    }
    await this.refresh();
    return this.store.read();
  }

  async logout(): Promise<void> {
    const claimed = this.store.claimLogout();
    try {
      await this.authority(claimed.authority_origin).logout(
        claimed.session.access_token,
      );
    } catch (error) {
      // A membership revocation has already invalidated this credential. The
      // Authority's explicit 401 is therefore a successful terminal result
      // for local sign-out. Transport and server failures remain visible.
      if (
        !(
          error instanceof PersonAuthorityClientError &&
          error.code === "unauthorized" &&
          error.status === 401
        )
      ) {
        throw error;
      }
    } finally {
      this.store.finishLogout();
    }
  }

  async records(
    limit?: number,
    query?: string,
  ): Promise<PersonRecordListV1 | PersonRecordSearchV1> {
    const stored = await this.accessSession();
    if (query !== undefined) {
      return await this.authority(stored.authority_origin).searchRecords(
        stored.session.access_token,
        query,
        limit,
      );
    }
    return await this.authority(stored.authority_origin).records(
      stored.session.access_token,
      limit,
    );
  }

  async ask(question: string): Promise<PersonAnswerV1> {
    const stored = await this.accessSession();
    return await this.authority(stored.authority_origin).ask(
      stored.session.access_token,
      question,
    );
  }

  async changeMeetingIngestionExclusion(
    excluded: boolean,
    selector: OrganizationPersonMeetingIngestionExclusionSelectorV2,
  ): Promise<void> {
    const stored = await this.accessSession();
    await this.authority(stored.authority_origin).changeMeetingIngestionExclusion(
      createPersonMeetingIngestionExclusionChangeRequest(
        stored,
        this.requestId("mex"),
        excluded,
        selector,
      ),
      stored.session.access_token,
    );
  }

  async meetingIngestionExclusions(
    sourceAdapterId: string,
    sourceInstanceId: string,
  ) {
    const stored = await this.accessSession();
    return await this.authority(
      stored.authority_origin,
    ).meetingIngestionExclusions(
      createPersonMeetingIngestionExclusionListRequest(
        stored,
        this.requestId("mex"),
        sourceAdapterId,
        sourceInstanceId,
      ),
      stored.session.access_token,
    );
  }

  async beginSlackIdentityLink() {
    const stored = await this.accessSession();
    const challengeBytes = this.randomBytes(32);
    if (challengeBytes.byteLength !== 32) {
      throw new Error(
        "Person client challenge generator returned the wrong size",
      );
    }
    const challengeCode = Buffer.from(challengeBytes).toString("base64url");
    try {
      const response = await this.authority(
        stored.authority_origin,
      ).beginSlackIdentityLink(
        createPersonSlackIdentityLinkBeginRequest(this.requestId("psb"), challengeCode),
        stored.session.access_token,
      );
      return { ...response, challenge_code: challengeCode };
    } finally {
      challengeBytes.fill(0);
    }
  }

  async completeSlackIdentityLink(input: {
    readonly challenge_attempt_id: string;
    readonly challenge_message_ts: string;
    readonly challenge_code: string;
  }) {
    const stored = await this.accessSession();
    return await this.authority(stored.authority_origin).completeSlackIdentityLink(
      createPersonSlackIdentityLinkCompleteRequest(this.requestId("psc"), input),
      stored.session.access_token,
    );
  }

  async employees(): Promise<EmployeeRosterV1> {
    const stored = await this.accessSession();
    return await this.authority(stored.authority_origin).employees(
      stored.session.access_token,
    );
  }

  async inviteEmployee(input: {
    name: string;
    email: string;
    output_path: string;
  }): Promise<{ output_path: string; expires_at: string }> {
    const outputPath = preflightPersonOnboardingInvitationOutput(input.output_path);
    const stored = await this.accessSession();
    return await this.issueEmployeeInvitation(
      outputPath,
      () =>
        this.authority(stored.authority_origin).inviteEmployee(
          { name: input.name, email: input.email },
          stored.session.access_token,
        ),
      stored.authority_origin,
    );
  }

  async reissueEmployee(input: {
    email: string;
    output_path: string;
  }): Promise<{ output_path: string; expires_at: string }> {
    const outputPath = preflightPersonOnboardingInvitationOutput(input.output_path);
    const stored = await this.accessSession();
    try {
      return await this.issueEmployeeInvitation(
        outputPath,
        () =>
          this.authority(stored.authority_origin).reissueEmployee(
            { email: input.email },
            stored.session.access_token,
          ),
        stored.authority_origin,
      );
    } catch (error) {
      if (
        error instanceof PersonAuthorityClientError &&
        error.code === "conflict" &&
        error.status === 409
      ) {
        throw new Error(
          "Employee identity onboarding is already complete; use person login with the Authority URL on the employee machine.",
        );
      }
      throw error;
    }
  }

  async revokeEmployee(email: string): Promise<void> {
    const stored = await this.accessSession();
    await this.authority(stored.authority_origin).revokeEmployee(
      { email },
      stored.session.access_token,
    );
  }

  private async issueEmployeeInvitation(
    outputPath: string,
    issue: () => Promise<{ login_grant: string; expires_at: string }>,
    authorityOrigin: string,
  ): Promise<{ output_path: string; expires_at: string }> {
    const issued = await issue();
    // A different local writer can win after preflight. O_EXCL leaves its
    // file untouched; the owner can safely reissue the one-time grant.
    writePersonOnboardingInvitation(outputPath, {
      schema_version: 1,
      kind: "echo-person-onboarding-invitation",
      authority_url: authorityOrigin,
      login_grant: issued.login_grant,
      expires_at: issued.expires_at,
    });
    return Object.freeze({ output_path: outputPath, expires_at: issued.expires_at });
  }
}
