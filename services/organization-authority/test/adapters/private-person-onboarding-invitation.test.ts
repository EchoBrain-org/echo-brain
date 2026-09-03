import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discardPersonOnboardingInvitation,
  reservePersonOnboardingInvitationTarget,
  writePersonOnboardingInvitation,
} from "../../src/adapters/files/private-person-onboarding-invitation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-person-invite-")));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function options(outputPath: string) {
  return {
    output_path: outputPath,
    authority_url: "https://authority.example.com",
    issued_login_grant: {
      organization_id: "org_00000000-0000-4000-8000-000000000001",
      principal_id: "prn_00000000-0000-4000-8000-000000000001",
      membership_id: "mem_00000000-0000-4000-8000-000000000001",
      membership_type: "employee" as const,
      login_grant: "G".repeat(43),
      expected_issuer: "https://identity.example.test/",
      expected_email_sha256:
        "sha256:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd" as const,
      issued_at: "2026-08-21T00:00:00.000Z",
      expires_at: "2026-08-21T00:15:00.000Z",
    },
  };
}

/**
 * Replica of the strict parser shipped before schema version 2. Keep this
 * local: the compatibility property is that an old client recognizes only the
 * exact V1 shape, including its schema version.
 */
function parsePriorReleasedV1Invitation(serialized: string): {
  authority_url: string;
  expires_at: string;
  kind: "echo-person-onboarding-invitation";
  login_grant: string;
  schema_version: 1;
} {
  const parsed: unknown = JSON.parse(serialized);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Person onboarding invitation is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "authority_url,expires_at,kind,login_grant,schema_version" ||
    record.schema_version !== 1 ||
    record.kind !== "echo-person-onboarding-invitation" ||
    typeof record.authority_url !== "string" ||
    typeof record.login_grant !== "string" ||
    typeof record.expires_at !== "string"
  ) {
    throw new Error("Person onboarding invitation is invalid");
  }
  return {
    authority_url: record.authority_url,
    expires_at: record.expires_at,
    kind: record.kind,
    login_grant: record.login_grant,
    schema_version: 1,
  };
}

describe("private Person onboarding invitation", () => {
  it("writes only the canonical bootstrap material as a 0600 file", () => {
    const path = join(directory(), "person.json");
    const input = options(path);
    const reservation = reservePersonOnboardingInvitationTarget(input);
    writePersonOnboardingInvitation(reservation, input.issued_login_grant);

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(
      '{"authority_url":"https://authority.example.com","expires_at":"2026-08-21T00:15:00.000Z","kind":"echo-person-onboarding-invitation","login_grant":"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG","schema_version":1}\n',
    );
  });

  it("emits a versioned v2 artifact when the expected account is present", () => {
    const path = join(directory(), "person.json");
    const input = options(path);
    const invitation = writePersonOnboardingInvitation(
      reservePersonOnboardingInvitationTarget(input),
      input.issued_login_grant,
      { expected_email: "founder@example.com" },
    );

    expect(invitation).toMatchObject({
      schema_version: 2,
      expected_email: "founder@example.com",
    });
    expect(readFileSync(path, "utf8")).toBe(
      '{"authority_url":"https://authority.example.com","expected_email":"founder@example.com","expires_at":"2026-08-21T00:15:00.000Z","kind":"echo-person-onboarding-invitation","login_grant":"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG","schema_version":2}\n',
    );
  });

  it("refuses shell-shaped expected-email input before serializing an artifact", () => {
    const path = join(directory(), "person.json");
    const input = options(path);
    const reservation = reservePersonOnboardingInvitationTarget(input);

    expect(() =>
      writePersonOnboardingInvitation(reservation, input.issued_login_grant, {
        expected_email: "founder;$(id)@example.com",
      }),
    ).toThrow("expected email is invalid");
    discardPersonOnboardingInvitation(reservation);
    expect(existsSync(path)).toBe(false);
  });

  it("is rejected by a prior strict V1 reader as a different schema, while V1 remains compatible", () => {
    const root = directory();
    const v1Path = join(root, "person-v1.json");
    const v2Path = join(root, "person-v2.json");
    const v1Input = options(v1Path);
    const v2Input = options(v2Path);

    writePersonOnboardingInvitation(
      reservePersonOnboardingInvitationTarget(v1Input),
      v1Input.issued_login_grant,
    );
    writePersonOnboardingInvitation(
      reservePersonOnboardingInvitationTarget(v2Input),
      v2Input.issued_login_grant,
      { expected_email: "founder@example.com" },
    );

    expect(
      parsePriorReleasedV1Invitation(readFileSync(v1Path, "utf8")),
    ).toMatchObject({ schema_version: 1 });
    expect(JSON.parse(readFileSync(v2Path, "utf8"))).toMatchObject({
      schema_version: 2,
    });
    expect(() =>
      parsePriorReleasedV1Invitation(readFileSync(v2Path, "utf8")),
    ).toThrow("Person onboarding invitation is invalid");
  });

  it("never replaces an existing recipient artifact", () => {
    const path = join(directory(), "person.json");
    writeFileSync(path, "existing\n", { mode: 0o600 });
    chmodSync(path, 0o600);

    expect(() =>
      reservePersonOnboardingInvitationTarget(options(path)),
    ).toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe("existing\n");
  });

  it("cleans the reserved path when artifact writing fails", () => {
    const path = join(directory(), "person.json");
    const input = options(path);
    const reservation = reservePersonOnboardingInvitationTarget(input);
    closeSync(reservation.descriptor!);

    expect(() =>
      writePersonOnboardingInvitation(reservation, input.issued_login_grant),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
