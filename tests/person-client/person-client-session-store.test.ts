import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonClientSessionUnavailableError,
  PersonSessionStore,
  readPersonOnboardingInvitation,
  writePersonOnboardingInvitation,
} from "../../src/product/person-client/index.js";
import { preflightPersonOnboardingInvitationOutput } from "../../src/product/person-client/onboarding-invitation.js";
import { describe, expect, it } from "vitest";

const id = (prefix: string, tail: string) =>
  `${prefix}_00000000-0000-4000-8000-${tail}`;

const SESSION = {
  organization_id: id("org", "000000000001"),
  principal_id: id("prn", "000000000002"),
  membership_id: id("mem", "000000000003"),
  display_name: "Example Person",
  membership_type: "employee",
  identity_binding_id: id("oib", "000000000004"),
  session_family_id: id("psf", "000000000005"),
  access_token: "A".repeat(43),
  refresh_token: "R".repeat(43),
  access_expires_at: "2026-08-18T12:00:00.000Z",
  refresh_expires_at: "2026-08-25T00:00:00.000Z",
  hard_reauthentication_at: "2026-08-25T00:00:00.000Z",
} as const;

const AUTHORITY_ID = id("oau", "000000000006");

function withHome(run: (home: string) => void): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "echo-person-")));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("Person session store", () => {
  it("reads only a canonical private Person onboarding invitation", () => {
    withHome((home) => {
      const path = join(home, "person-onboarding.json");
      const grant = "G".repeat(43);
      writeFileSync(
        path,
        '{"authority_url":"https://authority.example","expires_at":"2026-08-21T00:15:00.000Z","kind":"echo-person-onboarding-invitation","login_grant":"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG","schema_version":1}\n',
        { mode: 0o600 },
      );
      chmodSync(path, 0o600);
      expect(readPersonOnboardingInvitation(path)).toMatchObject({
        authority_url: "https://authority.example",
        login_grant: grant,
      });

      chmodSync(path, 0o644);
      expect(() => readPersonOnboardingInvitation(path)).toThrow("0600");
    });
  });

  it("never removes a pre-existing invitation when exclusive output creation fails", () => {
    withHome((home) => {
      const path = join(home, "existing-invitation.json");
      const existing = "existing bytes must survive\n";
      writeFileSync(path, existing, { mode: 0o600 });
      chmodSync(path, 0o600);
      expect(() =>
        writePersonOnboardingInvitation(path, {
          schema_version: 1,
          kind: "echo-person-onboarding-invitation",
          authority_url: "https://authority.example",
          login_grant: "G".repeat(43),
          expires_at: "2026-08-21T00:15:00.000Z",
        }),
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(existing);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it("canonicalizes a private parent alias without following an invitation leaf", () => {
    withHome((home) => {
      const privateParent = join(home, "private-invitations");
      const parentAlias = join(home, "tmp-alias");
      mkdirSync(privateParent, { mode: 0o700 });
      chmodSync(privateParent, 0o700);
      symlinkSync(privateParent, parentAlias);
      const aliasPath = join(parentAlias, "employee-onboarding.json");
      const canonicalPath = join(privateParent, "employee-onboarding.json");

      expect(preflightPersonOnboardingInvitationOutput(aliasPath)).toBe(
        canonicalPath,
      );
      writePersonOnboardingInvitation(aliasPath, {
        schema_version: 1,
        kind: "echo-person-onboarding-invitation",
        authority_url: "https://authority.example",
        login_grant: "G".repeat(43),
        expires_at: "2026-08-21T00:15:00.000Z",
      });
      expect(readPersonOnboardingInvitation(aliasPath)).toMatchObject({
        login_grant: "G".repeat(43),
      });

      const leafAlias = join(parentAlias, "leaf-alias.json");
      symlinkSync(canonicalPath, leafAlias);
      expect(() => preflightPersonOnboardingInvitationOutput(leafAlias)).toThrow(
        "already exists",
      );
      expect(() => readPersonOnboardingInvitation(leafAlias)).toThrow("0600");
    });
  });

  it("installs only at the exact private path with private modes", () => {
    withHome((home) => {
      const store = new PersonSessionStore(home);
      const stored = store.install(
        "https://authority.example",
        AUTHORITY_ID,
        SESSION,
      );

      expect(store.paths.live).toBe(
        join(home, ".local/share/echo-brain/person/session.v1.json"),
      );
      expect(store.read()).toEqual(stored);
      expect(lstatSync(store.paths.directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(store.paths.live).mode & 0o777).toBe(0o600);
    });
  });

  it("gives one refresh claimant the old credential and installs only its rotation", () => {
    withHome((home) => {
      const store = new PersonSessionStore(home);
      store.install("https://authority.example", AUTHORITY_ID, SESSION);

      const claimed = store.claimRefresh();
      expect(claimed.stored.session.refresh_token).toBe(SESSION.refresh_token);
      expect(() => store.read()).toThrow(PersonClientSessionUnavailableError);
      expect(() => store.claimRefresh()).toThrow(/already claimed/);

      const next = {
        ...SESSION,
        access_token: "B".repeat(43),
        refresh_token: "S".repeat(43),
        access_expires_at: "2026-08-18T12:10:00.000Z",
      };
      store.completeRefresh(claimed, next);
      expect(store.read().session).toEqual(next);
    });
  });

  it("refuses a delayed refresh completion after an explicit install wins", () => {
    withHome((home) => {
      const store = new PersonSessionStore(home);
      store.install("https://authority.example", AUTHORITY_ID, SESSION);
      const claimed = store.claimRefresh();
      const installed = {
        ...SESSION,
        access_token: "C".repeat(43),
        refresh_token: "T".repeat(43),
        access_expires_at: "2026-08-18T12:20:00.000Z",
      };
      store.install("https://authority.example", AUTHORITY_ID, installed);

      expect(() =>
        store.completeRefresh(claimed, {
          ...SESSION,
          access_token: "B".repeat(43),
          refresh_token: "S".repeat(43),
          access_expires_at: "2026-08-18T12:10:00.000Z",
        }),
      ).toThrow(/stale completion/);
      expect(store.read().session).toEqual(installed);
    });
  });

  it("fails closed after an interrupted refresh and clears local logout state", () => {
    withHome((home) => {
      const store = new PersonSessionStore(home);
      store.install("https://authority.example", AUTHORITY_ID, SESSION);
      store.claimRefresh();
      expect(() => new PersonSessionStore(home).read()).toThrow(
        /sign in again/,
      );
    });

    withHome((home) => {
      const store = new PersonSessionStore(home);
      store.install("https://authority.example", AUTHORITY_ID, SESSION);
      expect(store.claimLogout().session.access_token).toBe(
        SESSION.access_token,
      );
      store.finishLogout();
      expect(() => store.read()).toThrow(PersonClientSessionUnavailableError);
    });
  });
});
