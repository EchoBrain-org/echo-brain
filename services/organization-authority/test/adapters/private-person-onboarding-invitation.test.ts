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
