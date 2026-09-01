import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { BegunPersonOidcLogin } from "../../../../src/application/person-identity-sessions.js";
import { PersonIdentitySessionApplication } from "../../../../src/application/person-identity-sessions.js";
import { SqlitePersonSessionRepository } from "../../../../src/adapters/persistence/sqlite/sqlite-person-session-repository.js";
import { openAuthorityDatabase } from "../../../../src/adapters/persistence/sqlite/open-authority-database.js";
import { readPrivateAuthorityPersonSessionPkceKey } from "../../../../src/adapters/security/private-file-credentials.js";
import { NodePersonSessionCrypto } from "../../../../src/adapters/security/node-person-session-crypto.js";
import { SystemAuthorityClock } from "../../../../src/adapters/system/system-authority-clock.js";
import { admitSyntheticDemoMeetingSource } from "../../../../src/composition/providers/synthetic-demo/synthetic-demo-meeting-source-admission.js";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "../../../../src/composition/person-onboarding-service.js";
import type { PersonSessionOidcAuthorizationProvider } from "../../../../src/composition/lazy-person-session-oidc-provider.js";
import { bootstrapOrganizationAuthorityState } from "../../../../src/composition/organization-authority-state-bootstrap.js";
import { loadSyntheticDemoMeetingCorpusV1 } from "../../../../src/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";

const roots: string[] = [];
const ADMITTED_AT = "2026-08-30T01:02:03.004Z";
const meetingsDirectory = fileURLToPath(
  new URL("../../../../../../demo/meetings/", import.meta.url),
);
const OIDC = {
  issuer: "https://issuer.example",
  client_id: "founder-client",
  redirect_uri: "https://authority.example/v2/session/oidc/callback",
  tenant: { kind: "issuer" as const },
  id_token_algorithms: ["RS256"],
};

class TestOidcProvider implements PersonSessionOidcAuthorizationProvider {
  private attempt: BegunPersonOidcLogin | undefined;

  buildAuthorizationUrl(attempt: BegunPersonOidcLogin): string {
    this.attempt = attempt;
    return "https://issuer.example/authorize";
  }

  async redeemAuthorizationCode() {
    if (this.attempt === undefined) throw new Error("missing OIDC attempt");
    return {
      kind: "verified" as const,
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

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "echo-synthetic-demo-admission-")));
  roots.push(parent);
  chmodSync(parent, 0o700);
  const initialized = bootstrapOrganizationAuthorityState({
    state_directory: join(parent, "state"),
    organization_display_name: "Demo Organization",
    owner_display_name: "Founder",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    creating_artifact_revision: "synthetic-demo-admission-test",
  });
  return { parent, initialized, state_directory: initialized.state_directory };
}

function personalizedMeetingsDirectory(parent: string): string {
  const directory = join(parent, "meetings");
  cpSync(meetingsDirectory, directory, { recursive: true });
  for (const filename of readdirSync(directory)) {
    const path = join(directory, filename);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(
        "owner@example.test",
        "founder@example.com",
      ),
    );
  }
  return directory;
}

async function completeInitialOwnerOnboarding(input: ReturnType<typeof fixture>) {
  const credentials = initializePersonSessionCredentials({
    state_directory: input.state_directory,
  });
  const invitationDirectory = join(input.parent, "invitations");
  mkdirSync(invitationDirectory, { mode: 0o700 });
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
    const provider = new TestOidcProvider();
    const application = new PersonIdentitySessionApplication(
      new SqlitePersonSessionRepository(database),
      OIDC,
      {
        clock: new SystemAuthorityClock(),
        random: crypto,
        hash: crypto,
        pkce_sealer: crypto,
        oidc_provider: provider,
        diagnostics: { oidcLoginDenied() {} },
      },
    );
    const begun = application.beginOidcLogin({
      kind: "identity_bootstrap",
      login_grant: invitation.login_grant,
    });
    provider.buildAuthorizationUrl(begun);
    await application.completeOidcLogin({
      state: begun.state,
      authorization_code: "founder-code",
    });
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("synthetic-demo meeting-source admission", () => {
  it("admits the fixed corpus once and makes retries idempotent", async () => {
    const input = fixture();
    await completeInitialOwnerOnboarding(input);
    let preflightCalls = 0;
    const processor = {
      adapter_id: "fixture-processor",
      instance_id: "fixture-runner",
      version: "fixture-v1",
      configuration_sha256: canonicalSha256({ fixture: "configuration" }),
      credential_reference_sha256: canonicalSha256({ fixture: "credential" }),
      preflight: () => {
        preflightCalls += 1;
      },
    };
    await expect(
      admitSyntheticDemoMeetingSource({
        state_directory: input.state_directory,
        meetings_directory: meetingsDirectory,
        processor,
      }),
    ).rejects.toThrow("meeting owners must match the admitted owner identity");

    const personalizedMeetings = personalizedMeetingsDirectory(input.parent);
    const corpus = await loadSyntheticDemoMeetingCorpusV1(personalizedMeetings);
    const admitted = await admitSyntheticDemoMeetingSource({
      state_directory: input.state_directory,
      meetings_directory: personalizedMeetings,
      processor,
      now: () => ADMITTED_AT,
    });

    expect(admitted).toMatchObject({
      outcome: "admitted",
      source: {
        adapter_id: "synthetic-demo-source",
        instance_id: "customer-demo",
        version: "1.0.0",
        corpus_digest: corpus.corpus_digest,
        cursor: "synthetic-demo-source:customer-demo:1.0.0:v1:0",
        cutoff_at: ADMITTED_AT,
      },
      custody: {
        principal_id: input.initialized.owner_principal_id,
        membership_id: input.initialized.owner_membership_id,
      },
    });
    const database = new Database(join(input.state_directory, "authority.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT source_credential_reference_sha256, normalizer_version,
                    source_custodian_assurance, source_custodian_observed_at,
                    cutoff_at, admitted_at
               FROM authority_live_source_admission_v2`,
          )
          .get(),
      ).toEqual({
        source_credential_reference_sha256: corpus.corpus_digest,
        normalizer_version: "1.0.0",
        source_custodian_assurance: "authority_initial_owner_identity",
        source_custodian_observed_at: ADMITTED_AT,
        cutoff_at: ADMITTED_AT,
        admitted_at: ADMITTED_AT,
      });
    } finally {
      database.close();
    }

    await expect(
      admitSyntheticDemoMeetingSource({
        state_directory: input.state_directory,
        meetings_directory: personalizedMeetings,
        processor,
        now: () => {
          throw new Error("retry must not resample time");
        },
      }),
    ).resolves.toMatchObject({ outcome: "already_admitted" });
    await expect(
      admitSyntheticDemoMeetingSource({
        state_directory: input.state_directory,
        meetings_directory: personalizedMeetings,
        processor: {
          ...processor,
          configuration_sha256: canonicalSha256({ fixture: "changed" }),
        },
      }),
    ).rejects.toThrow("semantic input conflicts");
    expect(preflightCalls).toBe(4);
  });
});
