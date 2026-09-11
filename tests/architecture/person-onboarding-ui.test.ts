import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
// The bridge ships alongside the offline kit, without repository dependencies.
import { execute, runOnboardingAction, withPrivateInvitation } from "../../deploy/release/person-onboarding-ui.mjs";

const status = (signedIn: boolean) => JSON.stringify({
  schema_version: 1,
  kind: "echo-person-client-status-v1",
  signed_in: signedIn,
  display_name: signedIn ? "Example Employee" : null,
  connected_authority: signedIn ? "https://authority.example.test" : null,
});

function fixture(outputs: Array<{ code: number; stdout?: string }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const events: unknown[] = [];
  return {
    calls,
    events,
    options: {
      kitRoot: "/fixture/kit",
      home: "/fixture/home",
      emit: (event: unknown) => events.push(event),
      withInvitation: async (_path: string, operation: (path: string) => Promise<{ code: number; stdout: string }>) => operation("/fixture/private/invitation.json"),
      run: async (command: string, args: string[], options: { onLine?: (line: string) => void } = {}) => {
        calls.push({ command, args });
        const output = outputs.shift();
        if (!output) throw new Error("unexpected command");
        for (const line of (output.stdout ?? "").split("\n")) options.onLine?.(line);
        return { code: output.code, stdout: output.stdout ?? "" };
      },
    },
  };
}

describe("graphical employee onboarding bridge", () => {
  it("installs before inspecting identity and never equates a local session with readiness", async () => {
    const subject = fixture([{ code: 0 }, { code: 0, stdout: status(true) }]);
    expect(await runOnboardingAction("prepare", undefined, subject.options)).toEqual({
      ok: true, phase: "signed-in", display_name: "Example Employee", authority: "https://authority.example.test",
    });
    expect(subject.calls.map((call) => call.args)).toEqual([
      ["/fixture/kit/Start ECHO.command", "--install-only"],
      ["person", "status"],
    ]);
    expect(subject.events).not.toContainEqual(expect.objectContaining({ phase: "ready" }));
  });

  it("offers invitation selection only after a successful install and valid signed-out status", async () => {
    const subject = fixture([{ code: 0 }, { code: 0, stdout: status(false) }]);
    expect(await runOnboardingAction("prepare", undefined, subject.options)).toEqual({ ok: true, phase: "needs-invitation" });
    const failed = fixture([{ code: 1, stdout: "private installer diagnostics" }]);
    expect(await runOnboardingAction("prepare", undefined, failed.options)).toMatchObject({ ok: false, phase: "install-failed" });
    expect(failed.calls).toHaveLength(1);
  });

  it("resumes after interrupted sign-in by checking the saved account without reinstalling", async () => {
    for (const signedIn of [false, true]) {
      const subject = fixture([{ code: 0, stdout: status(signedIn) }]);
      expect(await runOnboardingAction("status", undefined, subject.options)).toMatchObject({
        ok: true, phase: signedIn ? "signed-in" : "needs-invitation",
      });
      expect(subject.calls.map(call => call.args)).toEqual([["person", "status"]]);
      expect(subject.events).not.toContainEqual(expect.objectContaining({ phase: "ready" }));
    }
  });

  it("requires a successful permission-aware records response before continuing an existing person", async () => {
    const denied = fixture([{ code: 1, stdout: "private revoked membership details" }]);
    expect(await runOnboardingAction("continue", undefined, denied.options)).toMatchObject({ ok: false, phase: "access-failed" });
    const malformed = fixture([{ code: 0, stdout: status(true) }]);
    expect(await runOnboardingAction("continue", undefined, malformed.options)).toMatchObject({ ok: false, phase: "access-failed" });
    const accepted = fixture([{ code: 0, stdout: status(true) }, { code: 0, stdout: JSON.stringify({ ok: true, result: {
      schema_version: 1, kind: "echo-clean-person-record-list-v1", records: [{ private_content: "never-display" }],
    } }) }, { code: 0, stdout: status(true) }]);
    expect(await runOnboardingAction("continue", undefined, accepted.options)).toEqual({ ok: true, phase: "ready", authority: "https://authority.example.test" });
    expect(accepted.calls[0]?.args).toEqual(["person", "status"]);
    expect(accepted.calls[1]?.args).toEqual(["person", "records", "--limit", "1"]);
    expect(accepted.calls[2]?.args).toEqual(["person", "status"]);
    expect(JSON.stringify(accepted.events)).not.toContain("never-display");
  });

  it("forwards only safe login phases and requires the actual ready receipt and successful exit", async () => {
    const output = [
      JSON.stringify({ ok: true, phase: "open-browser", authorization_url: "https://example.test/private-authorization" }),
      JSON.stringify({ ok: true, phase: "ready", permission_aware_read: "passed" }),
    ].join("\n");
    const subject = fixture([{ code: 0, stdout: output }, { code: 0, stdout: status(true) }]);
    expect(await runOnboardingAction("start", "/fixture/employee.json", subject.options)).toEqual({ ok: true, phase: "ready", authority: "https://authority.example.test" });
    expect(subject.events).toContainEqual({ ok: true, phase: "sign-in" });
    expect(subject.calls[0]?.args).toEqual(["person", "start", "--invitation", "/fixture/private/invitation.json"]);
    expect(subject.calls[1]?.args).toEqual(["person", "status"]);
    expect(JSON.stringify(subject.events)).not.toContain("private-authorization");
    const failed = fixture([{ code: 1, stdout: output }]);
    expect(await runOnboardingAction("start", "/fixture/employee.json", failed.options)).toMatchObject({ ok: false, phase: "login-failed" });
    const absent = fixture([{ code: 0, stdout: "installer exited without a readiness receipt" }]);
    expect(await runOnboardingAction("start", "/fixture/employee.json", absent.options)).toMatchObject({ ok: false, phase: "login-failed" });
  });

  it("lets an existing person sign in through the browser without an invitation or raw browser output", async () => {
    const subject = fixture([{ code: 0, stdout: status(false) }, { code: 0, stdout: "private provider response https://example.test/never-show" }, {
      code: 0, stdout: status(true),
    }]);
    expect(await runOnboardingAction("login", "https://authority.example.test", subject.options)).toEqual({
      ok: true, phase: "signed-in", display_name: "Example Employee", authority: "https://authority.example.test",
    });
    expect(subject.calls.map(call => call.args)).toEqual([
      ["person", "status"],
      ["person", "login", "--authority-url", "https://authority.example.test", "--open-browser"],
      ["person", "status"],
    ]);
    expect(JSON.stringify(subject.events)).not.toContain("never-show");
  });

  it("does not replace an existing or unknown local session and requires a final signed-in status", async () => {
    const existing = fixture([{ code: 0, stdout: status(true) }]);
    expect(await runOnboardingAction("login", "https://authority.example.test", existing.options)).toMatchObject({ ok: false, phase: "status-failed" });
    expect(existing.calls).toEqual([{ command: "/fixture/home/Library/Application Support/ECHO/bin/echo-brain", args: ["person", "status"] }]);

    const readyReceipt = [
      JSON.stringify({ ok: true, phase: "open-browser", browser_opened: true }),
      JSON.stringify({ ok: true, phase: "ready", permission_aware_read: "passed" }),
    ].join("\n");
    const expired = fixture([{ code: 0, stdout: readyReceipt }, { code: 0, stdout: status(false) }]);
    expect(await runOnboardingAction("start", "/fixture/employee.json", expired.options)).toMatchObject({ ok: false, phase: "login-failed" });

    const revoked = fixture([{ code: 0, stdout: status(true) }, { code: 0, stdout: JSON.stringify({ ok: true, result: {
      schema_version: 1, kind: "echo-clean-person-record-list-v1", records: [],
    } }) }, { code: 0, stdout: status(false) }]);
    expect(await runOnboardingAction("continue", undefined, revoked.options)).toMatchObject({ ok: false, phase: "access-failed" });
  });

  it("rejects unknown actions and relative invitation paths before any subprocess", async () => {
    for (const [action, invitation] of [["start", "relative.json"], ["login", "http://authority.example.test"], ["unexpected", undefined]] as const) {
      const subject = fixture([]);
      expect(await runOnboardingAction(action, invitation, subject.options)).toMatchObject({ ok: false, phase: "invalid-request" });
      expect(subject.calls).toEqual([]);
    }
  });

  it("does not expose exception messages or provider output", async () => {
    const subject = fixture([]);
    subject.options.run = async () => { throw new Error("secret-grant-do-not-display"); };
    const result = await runOnboardingAction("prepare", undefined, subject.options);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify([result, subject.events])).not.toContain("secret-grant");
  });

  it("fails promptly without publishing an authorization URL when the browser cannot open", async () => {
    const subject = fixture([{ code: 0, stdout: JSON.stringify({
      ok: true, phase: "open-browser", browser_opened: false, authorization_url: "https://example.test/private-authorization",
    }) }]);
    expect(await runOnboardingAction("start", "/fixture/invitation.json", subject.options)).toMatchObject({ ok: false, phase: "browser-failed" });
    expect(JSON.stringify(subject.events)).not.toContain("private-authorization");
  });

  it("copies a downloaded invitation privately and removes the copy even after failed sign-in", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-setup-invitation-test-")));
    const invitation = join(root, "downloaded.json");
    let privatePath = "";
    try {
      writeFileSync(invitation, "synthetic invitation bytes", { mode: 0o644 });
      await expect(withPrivateInvitation(invitation, async (path) => {
        privatePath = path;
        expect(realpathSync(path)).toBe(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        expect(readFileSync(path, "utf8")).toBe("synthetic invitation bytes");
        throw new Error("simulated cancelled login");
      })).rejects.toThrow("simulated cancelled login");
      expect(existsSync(privatePath)).toBe(false);
      expect(existsSync(dirname(privatePath))).toBe(false);
      expect(readFileSync(invitation, "utf8")).toBe("synthetic invitation bytes");
      const link = join(root, "link.json");
      symlinkSync(invitation, link);
      let called = false;
      await expect(withPrivateInvitation(link, async () => { called = true; return { code: 0, stdout: "" }; })).rejects.toThrow();
      expect(called).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds a stalled child and suppresses output after timeout", async () => {
    const result = await execute(process.execPath, ["-e", "console.log('private child output'); setInterval(() => {}, 1000)"], { timeoutMs: 100 });
    expect(result).toEqual({ code: 1, stdout: "" });
  });

  it("names a known installer failure reason and ignores any other reason", async () => {
    const named = fixture([{ code: 1, stdout: JSON.stringify({ ok: false, phase: "install-failed", reason: "existing-install-mismatch" }) }]);
    const result = await runOnboardingAction("prepare", undefined, named.options);
    expect(result).toMatchObject({ ok: false, phase: "install-failed", reason: "existing-install-mismatch" });
    expect(result.message).toContain("earlier ECHO install");

    // Unknown reasons, inherited property names, and installer prose all fall
    // back to the generic message: the bridge never renders installer text.
    for (const stdout of [
      JSON.stringify({ ok: false, phase: "install-failed", reason: "invented-reason" }),
      JSON.stringify({ ok: false, phase: "install-failed", reason: "constructor" }),
      JSON.stringify({ ok: false, phase: "install-failed", reason: "__proto__" }),
      JSON.stringify({ ok: false, phase: "install-failed", reason: "private installer diagnostics" }),
      "private installer diagnostics",
    ]) {
      const subject = fixture([{ code: 1, stdout }]);
      const fallback = await runOnboardingAction("prepare", undefined, subject.options);
      expect(fallback, stdout).toEqual({
        ok: false,
        phase: "install-failed",
        message: "ECHO could not finish installing. Try again with the approved download from your owner.",
      });
    }
  });
});
