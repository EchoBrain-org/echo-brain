import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { readPersonOnboardingInvitation } from "../../src/product/person-client/onboarding-invitation.js";
import { runPersonClientCli } from "../../src/product/person-client/commands.js";

// Only the browser handoff and Authority response are simulated. Exercise the
// real CLI and strict invitation reader without a session or live network.
vi.mock("../../src/product/person-client/browser-login-handoff.js", () => ({
  startPersonLoopbackHandoff: async () => ({
    url: "http://127.0.0.1:12345/" + "U".repeat(43), token: "H".repeat(43),
    wait: async () => ({ kind: "error", code: "retryable" }),
    close: async () => {},
  }),
}));
const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "echo-guidance-"));
  roots.push(home);
  const parent = join(home, "ECHO-invitation-test");
  mkdirSync(parent, { mode: 0o700 });
  const path = join(parent, "invitation ' $().json");
  const invitation = { schema_version: 2, kind: "echo-person-onboarding-invitation", authority_url: "https://authority.example", login_grant: "A".repeat(43), expected_email: "person@example.test", expires_at: "2026-09-11T20:15:00.000Z" };
  writeFileSync(path, canonicalJson(invitation) + "\n", { mode: 0o600 });
  return { home, path, invitation };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("onboarding guidance", () => {
  it("offers a safely quoted chmod command only for an otherwise valid current-user file", () => {
    const { path } = fixture();
    chmodSync(path, 0o644);
    const before = readFileSync(path);
    let message = "";
    try { readPersonOnboardingInvitation(path); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("chmod 600 ");
    execFileSync("/bin/sh", ["-c", message.split("For your file, run: ")[1]]);
    expect(readPersonOnboardingInvitation(path).schema_version).toBe(2);
    expect(readFileSync(path)).toEqual(before);
    const linked = path + ".link";
    symlinkSync(path, linked);
    expect(() => readPersonOnboardingInvitation(linked)).toThrow("bounded current-user");
    chmodSync(path, 0o644);
    writeFileSync(path, "x".repeat(8193));
    expect(() => readPersonOnboardingInvitation(path)).toThrow("bounded current-user");
  });

  it("explains missing nested exports without exposing invitation content", () => {
    const { path } = fixture();
    rmSync(path);
    expect(() => readPersonOnboardingInvitation(path)).toThrow("ECHO-invitation-<random>");
  });

  it("separates the invitation deadline from the browser attempt and explains loopback", async () => {
    const { home, path, invitation } = fixture();
    let stdout = "";
    let stderr = "";
    const status = await runPersonClientCli(["login", "--invitation", path], {
      home_directory: home,
      stdout: { write: value => ((stdout += String(value)), true) },
      stderr: { write: value => ((stderr += String(value)), true) },
      fetch: async () => new Response(JSON.stringify({ authorization_url: "https://identity.example/authorize?state=test", expires_at: "2026-09-11T20:10:00.000Z" }), { status: 201, headers: { "content-type": "application/json" } }),
    });
    expect(status).toBe(1); // Simulated retryable browser outcome.
    expect(stdout, stderr).not.toBe("");
    const event = JSON.parse(stdout.trim());
    expect(event.timing).toContain(invitation.expires_at);
    expect(event.timing).toContain("2026-09-11T20:10:00.000Z");
    expect(event.timing).toContain("127.0.0.1");
    expect(event.timing).toContain("10 minutes");
    expect(stdout + stderr).not.toContain(invitation.login_grant);
    expect(stdout + stderr).not.toContain(invitation.expected_email);
    expect(existsSync(join(home, ".local/share/echo-brain/person/session.json"))).toBe(false);
  });
});
