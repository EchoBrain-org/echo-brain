import { HUMAN_ACT_RECORD_INPUT_CODECS_V4 } from '@echo-brain/organization-protocol';
import { createPersonPolicyFactProjectorV2, createRecordPolicyFactProjectorRegistryV1 } from '@echo-brain/organization-record/organization-record-api-v1';
import type { AnswerCompositionGenerationBindingV1 } from '@echo-brain/organization-authority-kernel/composition/answer-composition-generation-bundle-v1';
import { openOrganizationAuthorityRuntime } from '../src/composition/organization-authority-runtime.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { authorization } from './fixtures/project-context-sqlite.js';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import {
  PersonIdentitySessionApplication,
  PersonOidcRetryableError,
} from "../src/application/person-identity-sessions.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import { SqlitePersonSessionRepository } from "../src/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import { NodePersonSessionCrypto } from "../src/adapters/security/node-person-session-crypto.js";
import { SystemAuthorityClock } from "../src/adapters/system/system-authority-clock.js";
import { isOidcRedemptionClaimInNamespace } from "../src/application/ports/person-session-repository.js";
import { bootstrapOrganizationAuthorityState } from "../src/composition/organization-authority-state-bootstrap.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../src/composition/person-onboarding-service.js";
import { startOrganizationAuthorityApiRuntime } from "../src/composition/organization-authority-api-runtime.js";
import type {
  PersonExternalIdentityRuntimeInputV1,
  OpenedPersonExternalIdentityRuntimeV1,
} from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS } from "@echo-brain/organization-authority-kernel/domain/person-session-rules";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-authority-api-runtime-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

/** Fresh genesis with the owner's session credentials and a private invitation directory. */
function founder(
  revision: string,
  names = { organization: "Founder Organization", owner: "Founder" },
) {
  const parent = root();
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(parent, "state"),
    organization_display_name: names.organization,
    owner_display_name: names.owner,
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: revision,
  });
  const credentials = initializePersonSessionCredentials({
    state_directory: initialized.state_directory,
  });
  const pkce = readPrivateAuthorityPersonSessionPkceKey(
    credentials.pkce_sealing_key_reference,
  );
  const invitationDirectory = join(parent, "invitations");
  mkdirSync(invitationDirectory, { mode: 0o700 });
  chmodSync(invitationDirectory, 0o700);
  /** Issues the owner another invitation and reads its artifact back. */
  const invite = (name: string) => {
    const path = join(invitationDirectory, name);
    const issued = issuePersonOnboardingInvitation({
      state_directory: initialized.state_directory,
      oidc: OIDC,
      pkce_sealing_key: pkce,
      membership_id: initialized.owner_membership_id,
      expected_email: "founder@example.com",
      authority_url: "https://authority.example",
      output_path: path,
    });
    return {
      issued,
      path,
      body: JSON.parse(readFileSync(path, "utf8")) as {
        login_grant: string;
        expected_email?: string;
      },
    };
  };
  return { initialized, credentials, pkce, invite };
}

type SessionDependencies = ConstructorParameters<typeof PersonIdentitySessionApplication>[2];

/** Person sessions over the given database, with Node crypto and the system clock unless one is given. */
function sessionsFor(
  database: ReturnType<typeof openAuthorityDatabase>,
  pkce: Uint8Array,
  dependencies: Omit<SessionDependencies, "clock" | "random" | "hash" | "pkce_sealer"> &
    Partial<Pick<SessionDependencies, "clock">>,
): PersonIdentitySessionApplication {
  const crypto = new NodePersonSessionCrypto(pkce);
  return new PersonIdentitySessionApplication(
    new SqlitePersonSessionRepository(database),
    OIDC,
    {
      clock: new SystemAuthorityClock(),
      random: crypto,
      hash: crypto,
      pkce_sealer: crypto,
      ...dependencies,
    },
  );
}

function consumedGrants(database: ReturnType<typeof openAuthorityDatabase>): unknown {
  return database
    .prepare(
      "SELECT count(*) FROM authority_person_login_grants WHERE consumed_at IS NOT NULL",
    )
    .pluck()
    .get();
}

class MockOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private last: BegunPersonOidcLogin | undefined;
  private retryableBeforeRedemption = false;
  private terminalRedemptionFailure = false;

  constructor(
    private claims: Readonly<Record<string, unknown>> = {
      email: "founder@example.com",
      email_verified: true,
    },
  ) {}

  setClaims(claims: Readonly<Record<string, unknown>>): void {
    this.claims = claims;
  }

  setAttempt(attempt: BegunPersonOidcLogin): void {
    this.last = attempt;
  }

  setRetryableBeforeRedemption(value: boolean): void {
    this.retryableBeforeRedemption = value;
  }

  setTerminalRedemptionFailure(value: boolean): void {
    this.terminalRedemptionFailure = value;
  }

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.last = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode(): Promise<
    | { kind: "retryable_before_redemption" }
    | { kind: "terminal_failure"; diagnostic_stage: "redemption" }
    | {
        kind: "verified";
        token: {
          issuer: string;
          subject: string;
          audience: string;
          nonce: string;
          issued_at: number;
          claims: Readonly<Record<string, unknown>>;
        };
      }
  > {
    if (this.retryableBeforeRedemption)
      return { kind: "retryable_before_redemption" };
    if (this.terminalRedemptionFailure)
      return { kind: "terminal_failure", diagnostic_stage: "redemption" };
    if (this.last === undefined) throw new Error("missing OIDC begin");
    return {
      kind: "verified",
      token: {
        issuer: "https://issuer.example",
        subject: "founder-subject",
        audience: "founder-client",
        nonce: this.last.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: this.claims,
      },
    };
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("Organization Authority API runtime", () => {
  it("runs V2 enrichment through the existing serialized meeting worker and drains it on shutdown", async () => {
    const { initialized, credentials } = founder("pc03-worker-composition", { organization: "Worker fixture", owner: "Owner" });
    const database = openAuthorityDatabase(join(initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
    const actor = authorization({ organization_id: initialized.organization_id, principal_id: initialized.owner_principal_id, membership_id: initialized.owner_membership_id, membership_type: 'owner' });
    const application = createProjectContextApplicationV1({ authenticate: () => actor, repository: new SqliteProjectContextRepositoryV1(database) });
    const events: string[] = [];
    const errors: unknown[] = [];
    // Meetings enter only through a personal meeting runtime, which shares the one serialized worker.
    const personal_meetings = {
      async recoverV4Appends() {}, async pollAndStageAdmittedMeetings() { events.push('meeting'); },
      async observeAndFinalizePendingApprovals() {}, async appendFinalizedApprovalsToV4() {}, async reconcileReadableSearchGeneration() {},
    };
    let releaseModel!: () => void;
    const modelPending = new Promise<void>(resolve => { releaseModel = resolve; });
    let generationCalls = 0;
    let active = 0;
    let maximumActive = 0;
    const generation: AnswerCompositionGenerationBindingV1 = {
      generation: { generation_adapter_id: 'pc03-generation', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1000 },
      structured_output: { async generate() {
        active++; maximumActive = Math.max(maximumActive, active); generationCalls++;
        events.push('upload');
        try { if (generationCalls === 1) await modelPending; return { search_hints: 'telephone' }; }
        finally { active--; }
      } },
    };
    const project = application.createProject('fixture', { schema_version: 1, kind: 'echo-project-create-v1', request_id: '00000000-0000-4000-8000-000000000011', name: 'Worker' });
    const request = { schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: '00000000-0000-4000-8000-000000000012', title: 'Original', text: 'Call the customer.', project_id: project.project_id, audience: { kind: 'project', project_id: project.project_id } };
    const receipt = application.submitUpload('fixture', request);
    const config = {
      state_directory: initialized.state_directory, host: '127.0.0.1' as const, port: await availablePort(),
      authority_url: 'https://authority.example', oidc: OIDC,
      client_authentication: { method: 'none' as const }, pkce_key_file: credentials.pkce_sealing_key_reference.slice('file:'.length),
      answer_composition_generation_bundle: { load: () => generation }, record_input_codecs: HUMAN_ACT_RECORD_INPUT_CODECS_V4,
      record_policy_fact_projectors: createRecordPolicyFactProjectorRegistryV1([createPersonPolicyFactProjectorV2()]),
      worker_interval_ms: 10, on_worker_error: (error: unknown) => { errors.push(error); },
    };
    const dependencies = { api: { oidc_provider: new MockOidcProvider(), person_http_runtime_factory: () => ({ applications: [], processing: personal_meetings, close() {} }) } };
    let runtime: Awaited<ReturnType<typeof openOrganizationAuthorityRuntime>> | undefined;
    try {
      runtime = await openOrganizationAuthorityRuntime(config, dependencies);
      expect(runtime.processing).toBe('active');
      await vi.waitFor(() => expect(generationCalls).toBe(1), { timeout: 2000 });
      // Personal meeting intake waits behind the in-flight enrichment in the same worker.
      expect(events).toEqual(['upload']);
      expect(application.readUpload('fixture', receipt.context_id).text).toBe(request.text);
      let stopped = false;
      const closing = runtime.close().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(stopped).toBe(false); expect(generationCalls).toBe(1); expect(maximumActive).toBe(1);
      releaseModel(); await closing; runtime = undefined;
      expect(application.uploadStatus('fixture', request.request_id).metadata).toBe('processing');
      expect(events).toEqual(['upload']);
      runtime = await openOrganizationAuthorityRuntime(config, dependencies);
      await vi.waitFor(() => expect(application.uploadStatus('fixture', request.request_id).metadata).toBe('ready'));
      await vi.waitFor(() => expect(events).toContain('meeting'));
      await runtime.close(); runtime = undefined;
      expect(events.slice(0, 3)).toEqual(['upload', 'upload', 'meeting']);
      expect(generationCalls).toBe(2); expect(maximumActive).toBe(1); expect(errors).toEqual([]);
      expect(application.searchUploads('fixture', { query: 'telephone' }).results[0]?.context_id).toBe(receipt.context_id);
      expect(application.readUpload('fixture', receipt.context_id).text).toBe(request.text);
      expect(database.prepare('SELECT count(*) AS n FROM authority_live_source_admission_v2').get()).toEqual({ n: 0 });
      expect(database.prepare('SELECT count(*) AS n FROM authority_live_source_candidates_v2').get()).toEqual({ n: 0 });
      expect(database.prepare('SELECT count(*) AS n FROM authority_person_update_work_v2').get()).toEqual({ n: 1 });
    } finally { releaseModel(); await runtime?.close(); database.close(); }
  });

  it("wires an injected external-identity application without selecting a provider", async () => {
    const { initialized, pkce } = founder("person-external-identity-runtime-test");
    const opened: PersonExternalIdentityRuntimeInputV1[] = [];
    let closed = 0;
    const runtime = await startOrganizationAuthorityApiRuntime(
      {
        state_directory: initialized.state_directory,
        host: "127.0.0.1",
        port: await availablePort(),
        authority_url: "https://authority.example",
        oidc: OIDC,
        client_authentication: { method: "none" },
        pkce_sealing_key: pkce,
      },
      {
        oidc_provider: new MockOidcProvider(),
        external_identity_runtime_bundle: {
          open(input): OpenedPersonExternalIdentityRuntimeV1 {
            opened.push(input);
            return {
              application: {
                routes: [
                  {
                    route_id: "fake-external-identity",
                    method: "POST",
                    path: "/v2/external-identity/fake",
                  },
                ],
                async accept(request) {
                  return {
                    status: 201,
                    body: { route_id: request.route_id, provider: "fake" },
                  };
                },
              },
              tools: async () => [],
              close: () => {
                closed += 1;
              },
            };
          },
        },
      },
    );
    try {
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        state_directory: initialized.state_directory,
        authority_id: initialized.authority_id,
        organization_id: initialized.organization_id,
        state_lineage_id: initialized.state_lineage_id,
      });
      const response = await fetch(
        `http://127.0.0.1:${String(runtime.address.port)}/v2/external-identity/fake`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        route_id: "fake-external-identity",
        provider: "fake",
      });
    } finally {
      await runtime.close();
    }
    expect(closed).toBe(1);
  });

  it("forwards a matching invitation address as login_hint and ignores a wrong one", async () => {
    const { initialized, pkce, invite } = founder("clean-login-hint-test");
    const first = invite("founder.invitation.json").body;
    // The address rides in the artifact so the client can name it and hint it.
    expect(first.expected_email).toBe("founder@example.com");

    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      const sessions = sessionsFor(database, pkce, { oidc_provider: new MockOidcProvider() });
      const matched = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: first.login_grant,
        login_hint: "founder@example.com",
      });
      expect(matched.login_hint).toBe("founder@example.com");

      // A hint the grant does not name must never reach the provider: it could
      // otherwise pre-select an account the Authority is bound to reject, which
      // is the exact way a one-time invitation gets spent.
      const second = invite("second.invitation.json").body;
      const mismatched = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: second.login_grant,
        login_hint: "someone-else@example.com",
      });
      expect(mismatched.login_hint).toBeUndefined();

      // A malformed hint is dropped, not a reason to fail beginning a login.
      const third = invite("third.invitation.json").body;
      const malformed = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: third.login_grant,
        login_hint: "NOT AN EMAIL",
      });
      expect(malformed.login_hint).toBeUndefined();
    } finally {
      database.close();
    }
  });
  it("retries a verified wrong bootstrap account without spending its invitation", async () => {
    const { initialized, pkce, invite } = founder("clean-person-email-binding-test");
    const invitation = invite("founder.invitation.json").body;
    const parallelInvitation = invite("parallel-founder.invitation.json").body;
    const databasePath = join(initialized.state_directory, "authority.sqlite");
    let database = openAuthorityDatabase(databasePath, { fileMustExist: true });
    try {
      let provider = new MockOidcProvider({
        email: "someone-else@example.com",
        email_verified: true,
      });
      const diagnostics: string[] = [];
      // Reads the current database and provider, so a restart rebuilds over both.
      const createSessions = () =>
        sessionsFor(database, pkce, {
          oidc_provider: provider,
          diagnostics: {
            oidcLoginDenied(reason) {
              diagnostics.push(reason);
            },
          },
        });
      let sessions = createSessions();
      const begun = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      provider.setAttempt(begun);
      const firstWrongAccountFailure = await sessions
        .completeOidcLogin({
          state: begun.state,
          authorization_code: "wrong-email-code",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(diagnostics).toEqual(["bootstrap_email_mismatch"]);
      expect(firstWrongAccountFailure).toBeInstanceOf(PersonOidcRetryableError);
      expect(
        database
          .prepare("SELECT consumed_at FROM authority_person_login_grants")
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        isOidcRedemptionClaimInNamespace(
          database
            .prepare(
              "SELECT redemption_claim_id FROM authority_oidc_login_attempts",
            )
            .pluck()
            .get() as string,
          "reservation",
        ),
      ).toBe(true);

      // The retry marker must survive a real Authority process restart. A
      // fresh repository and application then reattach the exact attempt.
      database.close();
      database = openAuthorityDatabase(databasePath, { fileMustExist: true });
      provider = new MockOidcProvider({
        email: "someone-else@example.com",
        email_verified: true,
      });
      sessions = createSessions();
      const restarted = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      expect(restarted).toMatchObject({
        login_attempt_id: begun.login_attempt_id,
        state: begun.state,
        nonce: begun.nonce,
      });

      // The marker retains each attempt's UUID body. Two reservations may be
      // pending together without violating the frozen UNIQUE claim column.
      const parallelBegun = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      provider.setAttempt(parallelBegun);
      await expect(
        sessions.completeOidcLogin({
          state: parallelBegun.state,
          authorization_code: "parallel-wrong-email-code",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const reservationClaims = database
        .prepare(
          "SELECT redemption_claim_id FROM authority_oidc_login_attempts WHERE terminal_outcome IS NULL ORDER BY login_attempt_id",
        )
        .pluck()
        .all() as string[];
      expect(reservationClaims).toHaveLength(2);
      expect(
        reservationClaims.every((claim) =>
          isOidcRedemptionClaimInNamespace(claim, "reservation"),
        ),
      ).toBe(true);
      expect(new Set(reservationClaims).size).toBe(2);

      const parallelProviderRetry = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      expect(parallelProviderRetry).toMatchObject({
        login_attempt_id: parallelBegun.login_attempt_id,
        state: parallelBegun.state,
        nonce: parallelBegun.nonce,
      });
      provider.setAttempt(parallelProviderRetry);
      // A provider failure known before code redemption must restore the same
      // reservation, not silently buy another wrong-account attempt.
      provider.setRetryableBeforeRedemption(true);
      await expect(
        sessions.completeOidcLogin({
          state: parallelProviderRetry.state,
          authorization_code: "provider-retry-before-redemption",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const parallelReservationAfterProviderRetry = database
        .prepare(
          "SELECT redemption_claim_id FROM authority_oidc_login_attempts WHERE login_attempt_id = ?",
        )
        .pluck()
        .get(parallelBegun.login_attempt_id) as string;
      expect(
        isOidcRedemptionClaimInNamespace(
          parallelReservationAfterProviderRetry,
          "reservation",
        ),
      ).toBe(true);

      const parallelSecondWrongAccount = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: parallelInvitation.login_grant,
      });
      expect(parallelSecondWrongAccount).toMatchObject({
        login_attempt_id: parallelBegun.login_attempt_id,
        state: parallelBegun.state,
        nonce: parallelBegun.nonce,
      });
      provider.setAttempt(parallelSecondWrongAccount);
      provider.setRetryableBeforeRedemption(false);
      provider.setClaims({
        email: "someone-else@example.com",
        email_verified: true,
      });
      await expect(
        sessions.completeOidcLogin({
          state: parallelSecondWrongAccount.state,
          authorization_code: "second-wrong-email-after-provider-retry",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare(
            "SELECT terminal_outcome FROM authority_oidc_login_attempts WHERE login_attempt_id = ?",
          )
          .pluck()
          .get(parallelBegun.login_attempt_id),
      ).toBe("denied");
      expect(
        database
          .prepare(
            `SELECT grant_row.consumed_at IS NOT NULL
               FROM authority_oidc_login_attempts attempt
               JOIN authority_person_login_grants grant_row
                 ON grant_row.login_grant_sha256 = attempt.login_grant_sha256
              WHERE attempt.login_attempt_id = ?`,
          )
          .pluck()
          .get(parallelBegun.login_attempt_id),
      ).toBe(1);

      provider.setAttempt(restarted);
      provider.setClaims({
        email: "founder@example.com",
        email_verified: true,
      });
      await expect(
        sessions.completeOidcLogin({
          state: restarted.state,
          authorization_code: "correct-email-code",
        }),
      ).resolves.toMatchObject({
        membership_id: initialized.owner_membership_id,
      });
      expect(consumedGrants(database)).toBe(2);
      expect(
        database
          .prepare("SELECT count(*) FROM authority_person_session_families")
          .pluck()
          .get(),
      ).toBe(1);

      // A malformed or unverified bootstrap identity is not a wrong-account
      // retry: it remains terminal and spends this distinct invitation.
      const invalidInvitation = invite("invalid-email.invitation.json").body;
      provider.setClaims({
        email: "founder@example.com",
        email_verified: false,
      });
      const invalid = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invalidInvitation.login_grant,
      });
      provider.setAttempt(invalid);
      await expect(
        sessions.completeOidcLogin({
          state: invalid.state,
          authorization_code: "unverified-email-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(consumedGrants(database)).toBe(3);

      // A second verified wrong account is terminal. The reservation is
      // durable across the restart, while the grant and attempt remain one-use.
      const cappedInvitation = invite("capped-retry.invitation.json").body;
      provider.setClaims({
        email: "someone-else@example.com",
        email_verified: true,
      });
      const cappedFirst = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: cappedInvitation.login_grant,
      });
      provider.setAttempt(cappedFirst);
      await expect(
        sessions.completeOidcLogin({
          state: cappedFirst.state,
          authorization_code: "first-capped-wrong-email-code",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const cappedSecond = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: cappedInvitation.login_grant,
      });
      provider.setAttempt(cappedSecond);
      await expect(
        sessions.completeOidcLogin({
          state: cappedSecond.state,
          authorization_code: "second-capped-wrong-email-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(consumedGrants(database)).toBe(4);
      expect(
        database
          .prepare(
            "SELECT terminal_outcome FROM authority_oidc_login_attempts ORDER BY rowid DESC LIMIT 1",
          )
          .pluck()
          .get(),
      ).toBe("denied");

      // A replayed or otherwise terminally redeemed code after the first
      // mismatch spends the invitation; it cannot clear the reservation and
      // turn the next browser return into another wrong-account retry.
      const replayedInvitation = invite("replayed-code.invitation.json").body;
      const replayedFirst = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: replayedInvitation.login_grant,
      });
      provider.setAttempt(replayedFirst);
      await expect(
        sessions.completeOidcLogin({
          state: replayedFirst.state,
          authorization_code: "replayed-code-first-wrong-account",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      const replayedRetry = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: replayedInvitation.login_grant,
      });
      provider.setAttempt(replayedRetry);
      provider.setTerminalRedemptionFailure(true);
      await expect(
        sessions.completeOidcLogin({
          state: replayedRetry.state,
          authorization_code: "replayed-provider-code",
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      provider.setTerminalRedemptionFailure(false);
      expect(consumedGrants(database)).toBe(5);
    } finally {
      database.close();
    }
  });

  it("releases retryable bootstrap redemption before consuming the invitation", async () => {
    const { initialized, pkce, invite } = founder("clean-person-bootstrap-retry-test");
    const invitation = invite("founder.invitation.json").body;
    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      let now = new Date().toISOString();
      const sessions = sessionsFor(database, pkce, {
        clock: { now: () => now },
        oidc_provider: {
          async redeemAuthorizationCode() {
            return { kind: "retryable_before_redemption" };
          },
        },
      });
      const first = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      const reattached = sessions.beginOidcLogin({
        kind: "identity_bootstrap",
        login_grant: invitation.login_grant,
      });
      expect(reattached).toMatchObject({
        login_attempt_id: first.login_attempt_id,
        state: first.state,
        nonce: first.nonce,
      });

      await expect(
        sessions.completeOidcLogin({
          state: first.state,
          authorization_code: "retryable-provider-result",
        }),
      ).rejects.toBeInstanceOf(PersonOidcRetryableError);
      expect(
        database
          .prepare("SELECT consumed_at FROM authority_person_login_grants")
          .pluck()
          .get(),
      ).toBeNull();
      expect(
        database
          .prepare(
            "SELECT redemption_claim_id IS NULL AND terminal_outcome IS NULL FROM authority_oidc_login_attempts",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        sessions.beginOidcLogin({
          kind: "identity_bootstrap",
          login_grant: invitation.login_grant,
        }),
      ).toMatchObject({ login_attempt_id: first.login_attempt_id });
      now = new Date(Date.parse(now) + 11 * 60 * 1000).toISOString();
      let expiredError: unknown;
      try {
        sessions.beginOidcLogin({
          kind: "identity_bootstrap",
          login_grant: invitation.login_grant,
        });
      } catch (error) {
        expiredError = error;
      }
      expect(expiredError).toMatchObject({ code: "unauthorized" });
      expect(
        database
          .prepare(
            "SELECT invalidated_at IS NOT NULL FROM authority_person_login_grants",
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("caps unauthenticated OIDC begins durably and releases expired capacity", () => {
    const { initialized, pkce } = founder("clean-person-oidc-capacity-test");
    const database = openAuthorityDatabase(
      join(initialized.state_directory, "authority.sqlite"),
      { fileMustExist: true },
    );
    try {
      let now = new Date().toISOString();
      const sessions = sessionsFor(database, pkce, {
        clock: { now: () => now },
        oidc_provider: {
          async redeemAuthorizationCode() {
            return { kind: "retryable_before_redemption" };
          },
        },
      });
      for (
        let index = 0;
        index < MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS;
        index += 1
      ) {
        sessions.beginOidcLogin({ kind: "existing_identity_login" });
      }
      let capacityError: unknown;
      try {
        sessions.beginOidcLogin({ kind: "existing_identity_login" });
      } catch (error) {
        capacityError = error;
      }
      expect(capacityError).toMatchObject({ code: "rate_limited" });
      expect(
        database
          .prepare("SELECT count(*) FROM authority_oidc_login_attempts")
          .pluck()
          .get(),
      ).toBe(MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS);

      now = new Date(Date.parse(now) + 11 * 60 * 1000).toISOString();
      expect(
        sessions.beginOidcLogin({ kind: "existing_identity_login" }),
      ).toMatchObject({ issuer: "https://issuer.example" });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM authority_oidc_login_attempts WHERE terminal_outcome IS NULL",
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare("SELECT count(*) FROM authority_oidc_login_attempts")
          .pluck()
          .get(),
      ).toBe(MAXIMUM_ACTIVE_OIDC_LOGIN_ATTEMPTS + 1);
    } finally {
      database.close();
    }
  });

  it("runs fresh genesis through initial-owner grant, OIDC bootstrap, refresh, and logout without legacy state", async () => {
    const { initialized, credentials, pkce, invite } = founder("organization-authority-api-runtime-test");
    expect(credentials.pkce_sealing_key_reference).toContain(
      "person-session-pkce-sealing-key",
    );
    expect(() =>
      initializePersonSessionCredentials({
        state_directory: initialized.state_directory,
      }),
    ).toThrow();
    const { issued, path: invitationPath, body: invitationBody } = invite("founder.invitation.json");
    expect(issued.output_path).toBe(invitationPath);
    const apiConfig = {
      state_directory: initialized.state_directory, host: "127.0.0.1" as const, port: await availablePort(),
      authority_url: "https://authority.example", oidc: OIDC,
      client_authentication: { method: "none" as const }, pkce_sealing_key: pkce,
    };
    const apiDependencies = {
      oidc_provider: new MockOidcProvider(),
    };
    let runtime = await startOrganizationAuthorityApiRuntime(apiConfig, apiDependencies);
    try {
      let origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const descriptor = await fetch(`${origin}/v1/authority-descriptor`);
      expect(descriptor.status).toBe(200);
      expect((await json(descriptor)).authority_descriptor).toMatchObject({
        authority_id: initialized.authority_id,
        organization_id: initialized.organization_id,
      });
      const unavailableBootstrap = await fetch(
        `${origin}/v2/session/oidc/begin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "identity_bootstrap",
            login_grant: "G".repeat(43),
          }),
        },
      );
      expect(unavailableBootstrap.status).toBe(401);

      const recoveryWithoutIdentity = await fetch(
        `${origin}/v2/session/oidc/begin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "existing_identity_login",
            loopback_handoff: {
              url: `http://127.0.0.1:39999/${"U".repeat(43)}`,
              token: "N".repeat(43),
            },
          }),
        },
      );
      expect(recoveryWithoutIdentity.status).toBe(201);
      const recoveryWithoutIdentityState = new URL(
        (await json(recoveryWithoutIdentity)).authorization_url as string,
      ).searchParams.get("state");
      expect(recoveryWithoutIdentityState).not.toBeNull();
      const identityNotBoundCallback = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(recoveryWithoutIdentityState!)}&code=code-unbound&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(identityNotBoundCallback.status).toBe(200);
      expect(identityNotBoundCallback.headers.get("cache-control")).toBe(
        "no-store",
      );
      const identityNotBoundPage = await identityNotBoundCallback.text();
      expect(identityNotBoundPage).toContain(
        `action="http://127.0.0.1:39999/${"U".repeat(43)}"`,
      );
      expect(identityNotBoundPage).toContain(
        'name="token" value="' + "N".repeat(43) + '"',
      );
      expect(identityNotBoundPage).toContain(
        'name="error" value="identity_not_bound"',
      );
      expect(identityNotBoundPage).not.toContain('name="session"');
      expect(identityNotBoundPage).not.toContain("access_token");
      expect(identityNotBoundPage).not.toContain("refresh_token");

      const begun = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "identity_bootstrap",
          login_grant: invitationBody.login_grant,
          loopback_handoff: {
            url: `http://127.0.0.1:39999/${"P".repeat(43)}`,
            token: "T".repeat(43),
          },
        }),
      });
      expect(begun.status).toBe(201);
      const authorization = await json(begun);
      const state = new URL(
        authorization.authorization_url as string,
      ).searchParams.get("state");
      expect(state).not.toBeNull();

      const callback = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(state!)}&code=code-1&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(callback.status).toBe(200);
      expect(callback.headers.get("content-type")).toContain("text/html");
      expect(callback.headers.get("cache-control")).toBe("no-store");
      const callbackPage = await callback.text();
      expect(callbackPage).toContain(
        `action="http://127.0.0.1:39999/${"P".repeat(43)}"`,
      );
      expect(callbackPage).toContain(
        'name="token" value="' + "T".repeat(43) + '"',
      );
      expect(callbackPage).not.toContain("access_token");
      expect(callbackPage).not.toContain("refresh_token");
      const encoded = /name="session" value="([A-Za-z0-9_-]+)"/.exec(
        callbackPage,
      )?.[1];
      expect(encoded).toBeDefined();
      const session = JSON.parse(
        Buffer.from(encoded!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      expect(session.membership_id).toBe(initialized.owner_membership_id);
      expect(session.display_name).toBe("Founder");

      for (const operation of ["list", "home"]) {
        const unavailableRuns = await fetch(`${origin}/v1/person/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.access_token as string}`, "content-type": "application/json" },
          body: JSON.stringify({ schema_version: 1, operation }),
        });
        expect(unavailableRuns.status).toBe(503);
        expect(await json(unavailableRuns)).toMatchObject({ error: { code: "unavailable" } });
      }

      const recoveryBegin = await fetch(`${origin}/v2/session/oidc/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "existing_identity_login" }),
      });
      expect(recoveryBegin.status).toBe(201);
      const recoveryState = new URL(
        (await json(recoveryBegin)).authorization_url as string,
      ).searchParams.get("state");
      const expiredDelivery = await fetch(
        `${origin}/v2/session/oidc/callback?state=${encodeURIComponent(recoveryState!)}&code=code-2&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(expiredDelivery.status).toBe(200);
      expect(expiredDelivery.headers.get("content-type")).toContain(
        "text/html",
      );
      const expiredPage = await expiredDelivery.text();
      expect(expiredPage).toContain("Sign-in expired");
      expect(expiredPage).toContain(
        "rerun the exact command that started sign-in",
      );
      expect(expiredPage).not.toContain("echo-brain person login");
      expect(expiredPage).not.toContain("access_token");
      expect(expiredPage).not.toContain("refresh_token");
      expect(expiredPage).not.toContain('name="session"');

      for (const version of [3, 4]) {
        const tools = `${origin}/v${String(version)}/person/tools`;
        const noTools = await fetch(tools, {
          headers: { authorization: `Bearer ${session.access_token as string}` },
        });
        expect(noTools.status).toBe(200);
        expect(await json(noTools)).toEqual({
          schema_version: version,
          kind: "echo-organization-person-tools",
          organization_id: initialized.organization_id,
          membership_id: initialized.owner_membership_id,
          tools: [],
        });
        expect((await fetch(tools)).status).toBe(401);
      }

      // Exercise the actual composed project application against fresh V7 storage.
      const projectHeaders = { authorization: `Bearer ${session.access_token as string}`, "content-type": "application/json" };
      const post = async (path: string, body: unknown, status = 200) => {
        const response = await fetch(origin + path, { method: "POST", headers: projectHeaders, body: JSON.stringify(body) });
        expect(response.status).toBe(status);
        return json(response);
      };
      const get = async (path: string, status = 200) => {
        const response = await fetch(origin + path, { headers: projectHeaders });
        expect(response.status).toBe(status);
        return json(response);
      };
      const create = { schema_version: 1, kind: "echo-project-create-v1", request_id: "00000000-0000-4000-8000-000000000001", name: "Runtime project" };
      const created = await post("/v1/person/projects", create, 201);
      const project_id = created.project_id as string;
      expect(await get(`/v1/person/projects/${project_id}`)).toMatchObject({ name: create.name, role: "lead" });
      expect(await get("/v1/person/projects")).toMatchObject({ items: [{ project_id }] });
      const upload = {
        schema_version: 2, kind: "echo-person-update-submit-v2", request_id: "00000000-0000-4000-8000-000000000002",
        title: "Runtime original", text: "Ship the original immediately.\n", project_id, audience: { kind: "project", project_id },
      };
      const receipt = await post("/v2/person/updates", upload, 202);
      const context_id = receipt.context_id as string;
      expect(await get(`/v2/person/updates/${upload.request_id}`)).toMatchObject({ status: "stored", metadata: "pending" });
      expect(await get(`/v2/person/updates/content/${context_id}`)).toMatchObject({ text: upload.text, audience: upload.audience });
      expect(await get(`/v1/person/projects/${project_id}/context/${context_id}`)).toMatchObject({ text: upload.text, project_id });
      const feed = await post("/v1/person/projects/context/feed", { project_id, limit: 10 });
      expect(feed).toMatchObject({ items: [{ context_id }] });
      expect(await post("/v1/person/projects/context/search", { project_id, query: "original" })).toMatchObject({ items: [{ context_id }] });
      expect(await post("/v2/person/updates/search", { query: "original" })).toMatchObject({ results: [{ context_id }] });
      expect(await post("/v1/person/projects/members", { project_id })).toMatchObject({ items: [{ membership_id: initialized.owner_membership_id, role: "lead" }] });
      expect(await post("/v1/person/projects/directory", { project_id, query: "Founder" })).toMatchObject({ items: [{ membership_id: initialized.owner_membership_id }] });
      expect(await post("/v1/person/directory", { query: "Founder" })).toEqual({ schema_version: 1, kind: "echo-organization-directory-v1", items: [{ membership_id: initialized.owner_membership_id, display_name: expect.any(String) }], next_cursor: null });
      expect(await post("/v1/person/directory", { project_id }, 400)).toEqual({ error: { code: "invalid_request", message: "request failed" } });
      await post("/v1/person/projects/members/set", { schema_version: 1, kind: "echo-project-member-set-v1", request_id: "00000000-0000-4000-8000-000000000003", project_id, membership_id: initialized.owner_membership_id, role: "lead" });
      expect(await post("/v1/person/projects/members/remove", { schema_version: 1, kind: "echo-project-member-remove-v1", request_id: "00000000-0000-4000-8000-000000000004", project_id, membership_id: initialized.owner_membership_id }, 409)).toEqual({ error: { code: "conflict", message: "request failed" } });
      await post("/v1/person/projects/context/dissociate", { schema_version: 1, kind: "echo-project-context-dissociate-v1", request_id: "00000000-0000-4000-8000-000000000005", project_id, context_id });
      expect(await post("/v1/person/projects/context/feed", { project_id })).toMatchObject({ items: [] });
      expect(await get(`/v1/person/projects/${project_id}/context/${context_id}`, 404)).toEqual({ error: { code: "not_found", message: "request failed" } });
      expect(await get(`/v2/person/updates/content/${context_id}`)).toMatchObject({ text: upload.text });
      await post("/v1/person/projects/context/associate", { schema_version: 1, kind: "echo-project-context-associate-v1", request_id: "00000000-0000-4000-8000-000000000006", project_id, context_id });
      expect(await post("/v1/person/projects/context/feed", { project_id })).toEqual(feed);
      const inspection = openAuthorityDatabase(join(initialized.state_directory, "authority.sqlite"), { fileMustExist: true });
      try {
        expect(inspection.prepare("SELECT json_extract(body_json, '$.response_sha256') AS response_sha256 FROM authority_project_read_audit_v1 WHERE json_extract(body_json, '$.operation') = 'feed' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ response_sha256: canonicalSha256(feed) });
        const auditCount = () => inspection.prepare("SELECT count(*) AS n FROM authority_project_read_audit_v1").get();
        const before = auditCount();
        let authentications = 0;
        const now = Date.now();
        const clock = vi.spyOn(SystemAuthorityClock.prototype, "now").mockImplementation(() =>
          new Date(now + (++authentications === 1 ? 0 : 365 * 24 * 60 * 60 * 1000)).toISOString(),
        );
        try {
          expect(await get(`/v1/person/projects/${project_id}/context/${context_id}`, 401)).toEqual({ error: { code: "unauthorized", message: "request failed" } });
          expect(authentications).toBe(2);
          expect(auditCount()).toEqual(before);
        } finally { clock.mockRestore(); }
        inspection.exec("CREATE TRIGGER fixture_project_audit_failure BEFORE INSERT ON authority_project_read_audit_v1 BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
        try {
          expect(await get(`/v2/person/updates/content/${context_id}`, 503)).toEqual({ error: { code: "unavailable", message: "request failed" } });
          expect(auditCount()).toEqual(before);
        } finally { inspection.exec("DROP TRIGGER fixture_project_audit_failure"); }
        expect(inspection.prepare("SELECT count(*) AS n FROM authority_live_source_candidates_v2").get()).toEqual({ n: 0 });
        expect(inspection.prepare("SELECT count(*) AS n FROM authority_person_update_work_v2").get()).toEqual({ n: 1 });
      } finally { inspection.close(); }
      await runtime.close();
      runtime = await startOrganizationAuthorityApiRuntime({ ...apiConfig, port: await availablePort() }, apiDependencies);
      origin = `http://127.0.0.1:${runtime.address.port}`;
      expect(await post("/v1/person/projects", create, 201)).toEqual(created);
      expect(await post("/v2/person/updates", upload, 202)).toEqual(receipt);
      expect(await post("/v2/person/updates", { ...upload, audience: { kind: "team" } }, 409)).toEqual({ error: { code: "conflict", message: "request failed" } });
      expect(await get(`/v2/person/updates/content/${context_id}`)).toMatchObject({ text: upload.text, audience: upload.audience });

      // The person list and open serve without an answer model or a published generation (ADR-0024).
      expect(await post("/v1/person/list", { schema_version: 1 })).toEqual({
        schema_version: 1, kind: "echo-person-list-v1", scope: { kind: "global" },
        me: { display_name: "Founder", membership_type: "owner" }, connected: [],
        projects: [{ project_id, name: create.name, role: "lead", status: "active" }], projects_more: false,
        items: [{ ref: `note:${context_id}`, kind: "note", title: upload.title, added_at: expect.any(String), visibility: "project", projects: [{ project_id, name: create.name }] }],
        next_cursor: null,
      });
      // This runtime composes no record approver projectors, so mine is unavailable, never global.
      expect(await post("/v1/person/list", { schema_version: 1, mine: true }, 503)).toEqual({ error: { code: "unavailable", message: "request failed" } });
      expect(await post("/v1/person/open", { schema_version: 1, ref: `note:${context_id}` })).toMatchObject({ kind: "echo-person-open-v1", text: upload.text, next_cursor: null });
      expect(await post("/v1/person/open", { schema_version: 1, ref: `meeting:sha256:${"0".repeat(64)}` }, 404)).toEqual({ error: { code: "not_found", message: "request failed" } });

      const searchBeforeGeneration = await fetch(
        `${origin}/v1/person/records`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.access_token as string}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "pricing" }),
        },
      );
      expect(searchBeforeGeneration.status).toBe(503);
      const malformedSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token as string}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "pricing", unexpected: true }),
      });
      expect(malformedSearch.status).toBe(400);
      const unauthenticatedSearch = await fetch(`${origin}/v1/person/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "pricing" }),
      });
      expect(unauthenticatedSearch.status).toBe(401);

      const refreshed = await fetch(`${origin}/v2/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      expect(refreshed.status).toBe(200);
      const rotated = await json(refreshed);
      expect(rotated.refresh_token).not.toBe(session.refresh_token);
      expect(rotated.display_name).toBe("Founder");

      const logout = await fetch(`${origin}/v2/session/revocations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotated.access_token as string}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(logout.status).toBe(204);
      expect(await get("/v1/person/projects", 401)).toEqual({ error: { code: "unauthorized", message: "request failed" } });
      const afterLogout = await fetch(`${origin}/v2/session/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rotated.refresh_token }),
      });
      expect(afterLogout.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });
});
