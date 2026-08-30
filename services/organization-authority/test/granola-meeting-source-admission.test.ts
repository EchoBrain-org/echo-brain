import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../src/application/person-identity-sessions.js";
import { PersonIdentitySessionApplication } from "../src/application/person-identity-sessions.js";
import { SqlitePersonSessionRepository } from "../src/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { NodePersonSessionCrypto } from "../src/adapters/security/node-person-session-crypto.js";
import { SystemAuthorityClock } from "../src/adapters/runtime/system-runtime-ports.js";
import {
  admitGranolaMeetingSource,
} from "../src/composition/granola-meeting-source-admission.js";
import {
  OPENROUTER_CLEAN_PROCESSOR_MODEL_V1,
  OPENROUTER_CLEAN_PROCESSOR_RUNTIME_VERSION_V1,
} from "../src/composition/openrouter-clean-processor-config-v1.js";
import { createOpenRouterCleanProcessorAdmissionCommitmentV1 } from "../src/composition/openrouter-clean-processor-admission-commitment.js";
import { runGranolaMeetingSourceAdmissionCli } from "../src/composition/granola-meeting-source-admission-cli.js";
import { personLoginGrantExpectedEmailSha256 } from "../src/domain/person-email-binding.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../src/composition/person-onboarding-service.js";
import type { PersonSessionOidcAuthorizationProvider } from "../src/composition/lazy-person-session-oidc-provider.js";
import { initializeAuthorityState } from "../src/composition/authority-state-initializer.js";
import { granolaLiveOnlyCutoff } from "../src/processing/adapters/meeting-sources/granola/index.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../src/adapters/security/private-file-credentials.js";

const roots: string[] = [];
const ADMITTED_AT = "2026-08-22T01:02:03.004Z";
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

const RECORD_OWNER_CLIENT = {
  async listNotes(_params: { page_size?: number }) {
    return {
      notes: [{ id: "preflight-only", owner: { email: "founder@example.com" } }],
      hasMore: false,
      cursor: null,
    };
  },
};

class FounderOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private attempt: BegunPersonOidcLogin | undefined;

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.attempt = attempt;
    return `https://issuer.example/authorize?state=${encodeURIComponent(attempt.state)}`;
  }

  async redeemAuthorizationCode(): Promise<{
    kind: "verified";
    token: {
      issuer: string;
      subject: string;
      audience: string;
      nonce: string;
      issued_at: number;
      claims: Readonly<Record<string, unknown>>;
    };
  }> {
    if (this.attempt === undefined) throw new Error("missing OIDC attempt");
    return {
      kind: "verified",
      token: {
        issuer: OIDC.issuer,
        subject: "founder-subject",
        audience: OIDC.client_id,
        nonce: this.attempt.nonce,
        issued_at: Math.floor(Date.now() / 1000),
        claims: { email: "founder@example.com", email_verified: true },
      },
    };
  }
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-clean-granola-source-"));
  chmodSync(directory, 0o700);
  const value = realpathSync(directory);
  roots.push(value);
  return value;
}

function privateFile(rootPath: string, name: string, value: string): string {
  const path = join(rootPath, name);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function fixture() {
  const parent = root();
  const initialized = initializeAuthorityState({
    state_directory: join(parent, "state"),
    organization_display_name: "Founder Organization",
    owner_display_name: "Founder",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "clean-granola-source-test",
  });
  let recordOwnerCalls = 0;
  const llmCredentialReference = `file:${privateFile(
    parent,
    "llm.key",
    "llm-private-credential-material-000000",
  )}`;
  return {
    parent,
    initialized,
    state_directory: initialized.state_directory,
    source_instance_id: "founder-granola",
    processor_instance_id: "founder-llm",
    granola_credential_reference: `file:${privateFile(parent, "granola.key", `grn_${"a".repeat(32)}`)}`,
    granola_owner_email_reference: `file:${privateFile(parent, "granola-owner-email", "founder@example.com")}`,
    llm_credential_reference: llmCredentialReference,
    processor: createOpenRouterCleanProcessorAdmissionCommitmentV1({
      instance_id: "founder-llm",
      credential_reference: llmCredentialReference,
    }),
    create_granola_record_owner_client: () => ({
      async listNotes(params: { page_size?: number }) {
        recordOwnerCalls += 1;
        return RECORD_OWNER_CLIENT.listNotes(params);
      },
    }),
    record_owner_calls: () => recordOwnerCalls,
  };
}

async function bootstrapFounder(
  input: ReturnType<typeof fixture>,
): Promise<void> {
  const credentials = initializePersonSessionCredentials({
    state_directory: input.state_directory,
  });
  const invitationDirectory = join(input.parent, "invitations");
  mkdirSync(invitationDirectory, { mode: 0o700 });
  chmodSync(invitationDirectory, 0o700);
  const invitationPath = join(invitationDirectory, "founder.invitation.json");
  const pkce = readPrivateAuthorityPersonSessionPkceKey(
    credentials.pkce_sealing_key_reference,
  );
  issuePersonOnboardingInvitation({
    state_directory: input.state_directory,
    oidc: OIDC,
    pkce_sealing_key: pkce,
    membership_id: input.initialized.owner_membership_id,
    expected_email: "founder@example.com",
    authority_url: "https://authority.example",
    output_path: invitationPath,
  });
  const invitation = JSON.parse(readFileSync(invitationPath, "utf8")) as {
    login_grant: string;
  };
  const database = openAuthorityDatabase(
    join(input.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  try {
    const crypto = new NodePersonSessionCrypto(pkce);
    const denied: string[] = [];
    const provider = new FounderOidcProvider();
    const application = new PersonIdentitySessionApplication(
      new SqlitePersonSessionRepository(database),
      OIDC,
      {
        clock: new SystemAuthorityClock(),
        random: crypto,
        hash: crypto,
        pkce_sealer: crypto,
        oidc_provider: provider,
        diagnostics: {
          oidcLoginDenied(reason) {
            denied.push(reason);
          },
        },
      },
    );
    const begun = application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: invitation.login_grant,
    });
    provider.buildAuthorizationUrl(begun);
    try {
      await application.completeOidcLogin({
        state: begun.state,
        authorization_code: "founder-code",
      });
    } catch {
      throw new Error(`founder OIDC bootstrap denied: ${denied.join(",")}`);
    }
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("clean Granola source admission", () => {
  it("commits a provider-neutral processor after its own preflight", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    let preflightCalls = 0;
    const admitted = await admitGranolaMeetingSource({
      ...input,
      processor: {
        adapter_id: "fixture-processor",
        instance_id: "fixture-runner",
        version: "fixture-v1",
        configuration_sha256: canonicalSha256({ fixture: "configuration" }),
        credential_reference_sha256: canonicalSha256({ fixture: "credential" }),
        preflight: () => {
          preflightCalls += 1;
        },
      },
      now: () => ADMITTED_AT,
    });

    expect(preflightCalls).toBe(1);
    expect(admitted.processor).toMatchObject({
      adapter_id: "fixture-processor",
      instance_id: "fixture-runner",
      version: "fixture-v1",
    });
    const database = new Database(
      join(input.state_directory, "authority.sqlite"),
      { readonly: true, fileMustExist: true },
    );
    try {
      expect(
        database
          .prepare(
            `SELECT processor_adapter_id, processor_instance_id,
                    processor_adapter_version
               FROM authority_live_source_admission_v2`,
          )
          .get(),
      ).toEqual({
        processor_adapter_id: "fixture-processor",
        processor_instance_id: "fixture-runner",
        processor_adapter_version: "fixture-v1",
      });
    } finally {
      database.close();
    }
  });

  it("requires founder OIDC re-onboarding, then admits a fresh live-only source and fixed LLM processing identity", async () => {
    const input = fixture();
    await expect(
      admitGranolaMeetingSource({ ...input, now: () => ADMITTED_AT }),
    ).rejects.toThrow("completed founder OIDC re-onboarding");
    await bootstrapFounder(input);
    const admitted = await admitGranolaMeetingSource({
      ...input,
      now: () => ADMITTED_AT,
    });
    expect(admitted).toMatchObject({
      kind: "echo-clean-granola-source-admission-v1",
      outcome: "admitted",
      source: {
        adapter_id: "granola",
        instance_id: "founder-granola",
        version: "2.2.0",
        cutoff_at: ADMITTED_AT,
      },
      custody: {
        principal_id: input.initialized.owner_principal_id,
        membership_id: input.initialized.owner_membership_id,
        membership_type: "owner",
      },
      processor: {
        adapter_id: "llm",
        instance_id: "founder-llm",
        version: OPENROUTER_CLEAN_PROCESSOR_RUNTIME_VERSION_V1,
      },
    });
    expect(admitted.source.cursor).toMatch(/^granola:v1:/);
    expect(granolaLiveOnlyCutoff(admitted.source.cursor)).toBe(ADMITTED_AT);
    expect(admitted.processor.configuration_sha256).toMatch(/^sha256:/);
    expect(JSON.stringify(admitted)).not.toContain("grn_");
    expect(JSON.stringify(admitted)).not.toContain(
      OPENROUTER_CLEAN_PROCESSOR_MODEL_V1,
    );

    const database = new Database(
      join(input.initialized.state_directory, "authority.sqlite"),
      { readonly: true, fileMustExist: true },
    );
    try {
      expect(
        database
          .prepare(
          `SELECT source_adapter_id, source_adapter_version, normalizer_version, cutoff_at,
                  source_custodian_assurance, source_custodian_observed_at,
                  processor_adapter_id,
                  processor_configuration_sha256, source_credential_reference_sha256,
                    processor_credential_reference_sha256
               FROM authority_live_source_admission_v2`,
          )
          .get(),
      ).toMatchObject({
        source_adapter_id: "granola",
        source_adapter_version: "2.2.0",
        normalizer_version: "2.2.0",
        cutoff_at: ADMITTED_AT,
        source_custodian_assurance: "provider_record_owner_observed",
        source_custodian_observed_at: ADMITTED_AT,
        processor_adapter_id: "llm",
      });
    } finally {
      database.close();
    }
  });

  it("reuses the exact cutoff for an exact retry and conflicts on changed semantic input", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    const first = await admitGranolaMeetingSource({
      ...input,
      now: () => ADMITTED_AT,
    });
    const retry = await admitGranolaMeetingSource({
      ...input,
      now: () => {
        throw new Error("exact retry must not sample a new cutoff");
      },
    });
    expect(retry).toMatchObject({
      outcome: "already_admitted",
      source: { cursor: first.source.cursor, cutoff_at: ADMITTED_AT },
    });
    expect(input.record_owner_calls()).toBe(1);
    await expect(
      admitGranolaMeetingSource({
        ...input,
        source_instance_id: "different-granola",
      }),
    ).rejects.toThrow("semantic input conflicts");
  });

  it("refuses a Granola owner email that differs from the completed founder identity", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    const otherOwner = privateFile(
      input.parent,
      "other-owner-email",
      "other@example.com",
    );
    await expect(
      admitGranolaMeetingSource({
        ...input,
        granola_owner_email_reference: `file:${otherOwner}`,
      }),
    ).rejects.toThrow("completed founder OIDC re-onboarding");
  });

  it("fails closed without an admission or cutoff when provider observation fails or cannot find the owner", async () => {
    for (const create_granola_record_owner_client of [
      () => ({
        async listNotes() {
          throw new Error("Granola provider unavailable");
        },
      }),
      () => ({
        async listNotes() {
          return {
            notes: [{ id: "other", owner: { email: "other@example.com" } }],
            hasMore: false,
            cursor: null,
          };
        },
      }),
    ]) {
      const input = fixture();
      await bootstrapFounder(input);
      await expect(
        admitGranolaMeetingSource({
          ...input,
          create_granola_record_owner_client,
          now: () => ADMITTED_AT,
        }),
      ).rejects.toThrow();
      const database = new Database(
        join(input.state_directory, "authority.sqlite"),
        { readonly: true, fileMustExist: true },
      );
      try {
        expect(
          database
            .prepare(
              "SELECT count(*) AS count FROM authority_live_source_admission_v2",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    }
  });

  it("does not hold the Authority write transaction across the provider preflight", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    let competingWriteAcquired = false;
    const admitted = await admitGranolaMeetingSource({
      ...input,
      create_granola_record_owner_client: () => ({
        async listNotes() {
          const contender = new Database(
            join(input.state_directory, "authority.sqlite"),
            { fileMustExist: true },
          );
          try {
            contender.exec("BEGIN IMMEDIATE");
            competingWriteAcquired = true;
            contender.exec("ROLLBACK");
          } finally {
            contender.close();
          }
          return {
            notes: [{ id: "preflight-only", owner: { email: "founder@example.com" } }],
            hasMore: false,
            cursor: null,
          };
        },
      }),
      now: () => ADMITTED_AT,
    });
    expect(competingWriteAcquired).toBe(true);
    expect(admitted.outcome).toBe("admitted");
  });

  it("binds provider observation and admission validation to one credential read", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    let factoryCredential: string | undefined;
    const credentialPath = input.granola_credential_reference.slice(
      "file:".length,
    );
    const admitted = await admitGranolaMeetingSource({
      ...input,
      create_granola_record_owner_client: (credential) => {
        factoryCredential = credential;
        writeFileSync(credentialPath, "changed-after-client-creation");
        chmodSync(credentialPath, 0o600);
        return RECORD_OWNER_CLIENT;
      },
      now: () => ADMITTED_AT,
    });
    expect(factoryCredential).toBe(`grn_${"a".repeat(32)}`);
    expect(admitted.outcome).toBe("admitted");
  });

  it("binds provider observation and admission validation to one owner-email read", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    const ownerEmailPath = input.granola_owner_email_reference.slice(
      "file:".length,
    );
    const admitted = await admitGranolaMeetingSource({
      ...input,
      create_granola_record_owner_client: () => {
        writeFileSync(ownerEmailPath, "other@example.com");
        chmodSync(ownerEmailPath, 0o600);
        return RECORD_OWNER_CLIENT;
      },
      now: () => ADMITTED_AT,
    });
    expect(admitted.outcome).toBe("admitted");
    expect(admitted.custody.owner_email_sha256).toBe(
      personLoginGrantExpectedEmailSha256("founder@example.com"),
    );
  });

  it("accepts only private file paths at its CLI boundary and never prints the credential", async () => {
    const input = fixture();
    await bootstrapFounder(input);
    const output: string[] = [];
    await expect(
      runGranolaMeetingSourceAdmissionCli(
        [
          "--state-dir",
          input.initialized.state_directory,
          "--source-instance",
          input.source_instance_id,
          "--processor-instance",
          input.processor_instance_id,
          "--granola-credential-file",
          input.granola_credential_reference.slice("file:".length),
          "--granola-owner-email-file",
          input.granola_owner_email_reference.slice("file:".length),
          "--llm-credential-file",
          input.llm_credential_reference.slice("file:".length),
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
        { createGranolaRecordOwnerClient: () => RECORD_OWNER_CLIENT },
      ),
    ).resolves.toBe(0);
    expect(output.join("")).not.toContain("grn_");
    expect(output.join("")).not.toContain("llm-private");
    const status = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(status).toEqual({
      schema_version: 1,
      kind: "echo-clean-granola-source-admission-status-v1",
      outcome: "admitted",
      owner_observed_at: expect.any(String),
    });
    expect(Object.keys(status)).not.toContain("source");
    expect(Object.keys(status)).not.toContain("processor");
    expect(Object.keys(status)).not.toContain("custody");
    await expect(
      runGranolaMeetingSourceAdmissionCli(
        ["--state-dir", input.initialized.state_directory],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow("usage:");
  });
});
