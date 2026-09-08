import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isExpectedPersonEmail } from "../../packages/organization-api/src/person-session.js";

const repo = resolve(import.meta.dirname, "../..");
let root: string;
let binary: string;
let cli: string;

// Compiles the actual shipped client/panel code with a headless proof entrypoint.
// The only subprocess it can invoke is this fixture; no real session or server
// is used. Linux retains the HTTP authorization proof; macOS CI runs this too.
describe.skipIf(process.platform !== "darwin")("native owner People client", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "echo-people-proof-")));
    binary = join(root, "proof"); cli = join(root, "cli.cjs");
    const main = readFileSync(join(repo, "product/echo-overlay/main.swift"), "utf8");
    const entrypoint = main.indexOf("@main\nprivate enum EchoOverlayMain");
    expect(entrypoint).toBeGreaterThan(0);
    writeFileSync(join(root, "overlay.swift"), main.slice(0, entrypoint));
    writeFileSync(join(root, "proof.swift"), `import Foundation
@main enum Proof {
  static func main() throws {
    let args = CommandLine.arguments
    if args[1] == "destination" {
      let path = try PeopleClient.invitationDestination(in: URL(fileURLWithPath: args[2], isDirectory: true))
      print(path.path); return
    }
    if args[1] == "email" {
      for email in args.dropFirst(2) { print(PeopleClient.isInvitationEmail(email)) }
      return
    }
    if args[1] == "duplicate" {
      let invitation = PeopleInvitation(rawValue: args[2])!
      let membership = PeopleMembership(rawValue: args[3])!
      let employee = PeopleEmployee(email: "a@example.test", display_name: "Employee", membership_status: membership, invitation_state: invitation)
      print(PeopleClient.activeInvitationConflict(for: "a@example.test", in: [employee]) ?? "none")
      return
    }
    let owner = PeopleIdentity(name: "Owner", authority: "https://authority.example.test")
    let client = PeopleClient(executable: URL(fileURLWithPath: args[1]))
    let command: PeopleCommand
    switch args[2] {
    case "invite": command = .invite(name: "A '; touch forbidden #", email: "a@example.test", path: args[3])
    case "reissue": command = .reissue(email: "a@example.test", path: args[3])
    case "revoke": command = .revoke(email: "a@example.test")
    case "cancel-after": command = .invite(name: "A '; touch forbidden #", email: "a@example.test", path: args[3])
    default: command = .list
    }
    let running = RunningAsk()
    if args[2] == "cancel" { running.cancel() }
    if args[2] == "cancel-after" {
      let marker = args[3] + ".launched"
      DispatchQueue.global().async {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
          if FileManager.default.fileExists(atPath: marker) { running.cancel(); return }
          Thread.sleep(forTimeInterval: 0.005)
        }
        running.cancel()
      }
    }
    switch client.execute(command, owner: owner, running: running) {
    case .roster(let rows):
      print("roster:\\(rows.count):\\(rows.first?.mayReissue ?? false):\\(rows.first?.invitationLabel ?? \"\")")
    case .invitation(let path, _): print("invitation:" + path)
    case .revoked: print("revoked")
    case .unavailable: print("unavailable")
    case .unconfirmedMutation: print("unconfirmed:" + command.recoveryMessage)
    case .unconfirmedMutationAfterIdentityChange: print("unconfirmed:" + command.recoveryMessage)
    case .authorizationRejected(let message): print("access-denied:" + message)
    case .invitationSaveCommitted(let message): print("committed:" + message)
    case .rejected(let message): print("rejected:" + message)
    case .failed: print("failed")
    }
  }
}
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors",
      "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "Carbon",
      join(root, "overlay.swift"), join(repo, "product/echo-overlay/people.swift"), join(repo, "product/echo-overlay/account.swift"), join(root, "proof.swift"), "-o", binary],
    { timeout: 120_000, stdio: "pipe" });
    writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
const mode = fs.readFileSync(root + "/mode", "utf8");
if (args[1] === "status") {
  if (mode === "status-unavailable") process.exit(1);
  // Deliberately outlast the old 100ms cancellation timer. The proof must
  // wait for the management operation, not race the preceding status read.
  if (mode === "cancel-after-launch") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const role = mode === "employee" || mode === "switched" ? "employee" : mode === "unknown-role" ? "administrator" : "owner";
  console.log(JSON.stringify({schema_version:1,kind:"echo-person-client-status-v1",signed_in:mode !== "signed-out",display_name:"Owner",membership_type:role,connected_authority:"https://authority.example.test"}));
} else if (mode === "denied") {
  console.error(JSON.stringify({ok:false,error:"LOGIN_GRANT_MUST_NOT_DISPLAY"})); process.exitCode = 1;
} else if (mode === "auth-denied") {
  const action = { list: "employee-list", invite: "employee-invite", reissue: "employee-reissue", revoke: "employee-revoke" }[args[2]];
  console.error(JSON.stringify({ok:false,action,error:"PRIVATE_ERROR_MUST_NOT_DISPLAY",code:"owner_access_required",mutation_outcome:"rejected"})); process.exitCode = 1;
} else if (mode.startsWith("rejected-")) {
  const [code, mutation_outcome] = mode.slice("rejected-".length).split(":");
  const action = { list: "employee-list", invite: "employee-invite", reissue: "employee-reissue", revoke: "employee-revoke" }[args[2]];
  console.error(JSON.stringify({ok:false,action,error:"PRIVATE_ERROR_MUST_NOT_DISPLAY",code,mutation_outcome})); process.exitCode = 1;
} else if (mode === "cancel-after-launch") {
  fs.writeFileSync(args[args.indexOf("--out")+1] + ".launched", "ready");
  setInterval(() => {}, 1_000);
} else if (mode === "overflow") {
  process.stdout.write("x".repeat(256 * 1024));
} else if (mode === "invalid") {
  console.log("{invalid}");
} else {
  if (mode === "switch") fs.writeFileSync(root + "/mode", "switched");
  if (mode === "status-fails-after") fs.writeFileSync(root + "/mode", "status-unavailable");
  if (args[2] === "list") console.log(JSON.stringify({ok:true,result:{schema_version:1,kind:"echo-clean-person-employee-roster-v1",employees:[{email:"a@example.test",display_name:"Employee",membership_status:"active",invitation_state:mode === "redeemed" ? "redeemed" : "pending"}]}}));
  else if (args[2] === "revoke") console.log(JSON.stringify({ok:true,revoked:true}));
  else console.log(JSON.stringify({ok:true,output_path:mode === "wrong-path" ? "/unexpected" : args[args.indexOf("--out")+1],expires_at:"2026-09-07T20:59:51.177Z"}));
}
`);
    chmodSync(cli, 0o700);
  }, 120_000);

  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function run(mode: string, action = "list") {
    writeFileSync(join(root, "mode"), mode);
    writeFileSync(join(root, "calls.jsonl"), "");
    rmSync(join(root, "private invitation.json.launched"), { force: true });
    const result = spawnSync(binary, [cli, action, join(root, "private invitation.json")], { encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    return { result: result.stdout.trim(), calls, stderr: result.stderr };
  }

  it("shows validated owner roster results and only permits reissue before sign-in", () => {
    expect(run("owner").result).toBe("roster:1:true:Awaiting sign-in");
    expect(run("redeemed").result).toBe("roster:1:false:Onboarded");
  });

  it("blocks a duplicate active-roster invite with the next safe action", () => {
    const duplicate = (invitation: string, membership = "active") => execFileSync(binary, ["duplicate", invitation, membership], { encoding: "utf8" }).trim();
    expect(duplicate("pending")).toContain("reissue");
    expect(duplicate("expired")).toContain("reissue");
    expect(duplicate("redeemed")).toBe("This employee has already onboarded. Ask them to sign in.");
    expect(duplicate("none")).toBe("This employee is already a member. Ask them to sign in.");
    expect(duplicate("pending", "revoked")).toBe("none");
  });

  it.each(["employee", "unknown-role", "signed-out"])("does not invoke a management operation for %s", (mode) => {
    for (const operation of ["list", "invite", "reissue", "revoke"]) {
      const result = run(mode, operation);
      expect(result.result).toBe("unavailable");
      expect(result.calls).toEqual([["person", "status"]]);
    }
  });

  it("discards a roster if the account switches before the response is displayed", () => {
    expect(run("switch").result).toBe("unavailable");
    expect(run("status-fails-after").result).toBe("unavailable");
  });

  it("withholds the prior roster when the live list is denied or its response is malformed", () => {
    expect(run("auth-denied").result).toBe("access-denied:Owner access is required to manage people. Sign in with your owner account.");
    expect(run("denied").result).toBe("failed");
    expect(run("auth-denied", "invite").result).toBe("access-denied:Owner access is required to manage people. Sign in with your owner account.");
  });

  it.each(["switch", "status-fails-after"])("preserves a submitted mutation warning after %s", (mode) => {
    for (const action of ["invite", "reissue", "revoke"]) {
      const result = run(mode, action);
      expect(result.result).toContain("unconfirmed:");
      expect(result.result).toMatch(/[Rr]efresh/);
      expect(result.calls.filter((args) => args[1] === "employee")).toHaveLength(1);
      if (action !== "revoke") expect(result.result).toContain("folder");
      if (action === "reissue") expect(result.result).toContain("previous invitation");
    }
  });

  it("matches the Authority's new-invitation mailbox contract before choosing a folder", () => {
    const addresses = [
      "a@example.com", "a+b@example.com", "first.last@example.co.uk", "a_b-c%d@example.com",
      "o'connor@example.com", "a..b@example.com", ".a@example.com", "a.@example.com",
      "a+@example.com", "a@-example.com", "a@example-.com", "a@exam_ple.com",
      "a@localhost", "A@example.com", "a@example.com\n", "a@éxample.com", "a@@example.com", "",
      `${"a".repeat(64)}@example.com`, `${"a".repeat(65)}@example.com`,
      `a@${"a".repeat(63)}.com`, `a@${"a".repeat(64)}.com`,
      `a@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`,
      `a@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    ];
    const results = execFileSync(binary, ["email", ...addresses], { encoding: "utf8" }).trim().split("\n");
    expect(results).toEqual(addresses.map((email) => String(isExpectedPersonEmail(email))));
  });

  it("keeps invitation arguments literal and accepts only the requested output path", () => {
    const invitation = run("owner", "invite");
    expect(invitation.result).toBe(`invitation:${join(root, "private invitation.json")}`);
    expect(invitation.calls[1]).toEqual(["person", "employee", "invite", "--name", "A '; touch forbidden #", "--email", "a@example.test", "--out", join(root, "private invitation.json")]);
    expect(run("owner", "reissue").result).toMatch(/^invitation:/);
    expect(run("wrong-path", "invite").result).toMatch(/^unconfirmed:/);
    expect(run("owner", "revoke").result).toBe("revoked");
  });

  it.each([
    ["invalid_email", "not_submitted", "rejected:Enter a valid employee name and email address."],
    ["invalid_name", "not_submitted", "rejected:Enter a valid employee name and email address."],
    ["invitation_output_invalid", "not_submitted", "rejected:Could not save the invitation. Choose another location and try again."],
    ["employee_already_exists", "rejected", "rejected:Already a member. Refresh to check whether to reissue or sign in."],
    ["employee_onboarding_complete", "rejected", "rejected:This employee has already onboarded. Ask them to sign in."],
    ["request_rejected", "rejected", "rejected:The request was rejected. Refresh and try again."],
    ["outcome_unknown", "not_submitted", "rejected:The request was not sent. Check your connection and try again."],
  ])("shows a fixed actionable message for a known rejected mutation: %s", (code, outcome, expected) => {
    const result = run(`rejected-${code}:${outcome}`, "invite");
    expect(result.result).toBe(expected);
    expect(result.result).not.toContain("PRIVATE_ERROR_MUST_NOT_DISPLAY");
    expect(result.calls.filter((args) => args[1] === "employee")).toHaveLength(1);
  });

  it("reports a committed invitation whose private file could not be saved without encouraging another invite", () => {
    expect(run("rejected-invitation_save_failed:committed", "invite").result)
      .toBe("committed:Invitation was created, but the file could not be saved. Refresh, then reissue it into another folder.");
  });

  it.each(["denied", "overflow", "invalid", "rejected-outcome_unknown:unknown", "rejected-request_rejected:committed", "rejected-invitation_save_failed:rejected"])("warns that a malformed or unknown mutation outcome must not be retried: %s", (mode) => {
    const result = run(mode, "invite");
    expect(result.result).toMatch(/^unconfirmed:/);
    expect(result.result).toContain("refresh before retrying");
    expect(result.stderr).not.toContain("LOGIN_GRANT_MUST_NOT_DISPLAY");
    expect(result.result).not.toContain("PRIVATE_ERROR_MUST_NOT_DISPLAY");
    expect(result.calls.filter((args) => args[1] === "employee")).toHaveLength(1);
  });

  it("does not submit a cancelled command", () => {
    expect(run("owner", "cancel")).toMatchObject({ result: "unavailable", calls: [] });
  });

  it("warns when cancellation follows a launched mutation", () => {
    const result = run("cancel-after-launch", "cancel-after");
    expect(result.result).toMatch(/^unconfirmed:/);
    expect(result.calls.filter((args) => args[1] === "employee")).toHaveLength(1);
  });

  it("creates distinct private invitation folders without changing the selected parent", () => {
    const first = execFileSync(binary, ["destination", root], { encoding: "utf8" }).trim();
    const second = execFileSync(binary, ["destination", root], { encoding: "utf8" }).trim();
    expect(first).not.toBe(second);
    for (const path of [first, second]) {
      expect(path).toMatch(/\/ECHO-invitation-[^/]+\/person-invitation\.json$/);
      expect(execFileSync("/usr/bin/stat", ["-f", "%Lp", resolve(path, "..")], { encoding: "utf8" }).trim()).toBe("700");
    }
  });
});
