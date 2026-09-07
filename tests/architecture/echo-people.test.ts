import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    writeFileSync(join(root, "overlay.swift"), main.slice(0, main.indexOf("@main\nprivate enum EchoOverlayMain")));
    writeFileSync(join(root, "proof.swift"), `import Foundation
@main enum Proof {
  static func main() throws {
    let args = CommandLine.arguments
    if args[1] == "destination" {
      let path = try PeopleClient.invitationDestination(in: URL(fileURLWithPath: args[2], isDirectory: true))
      print(path.path); return
    }
    let owner = PeopleIdentity(name: "Owner", authority: "https://authority.example.test")
    let client = PeopleClient(executable: URL(fileURLWithPath: args[1]))
    let command: PeopleCommand
    switch args[2] {
    case "invite": command = .invite(name: "A '; touch forbidden #", email: "a@example.test", path: args[3])
    case "reissue": command = .reissue(email: "a@example.test", path: args[3])
    case "revoke": command = .revoke(email: "a@example.test")
    default: command = .list
    }
    let running = RunningAsk()
    if args[2] == "cancel" { running.cancel() }
    switch client.execute(command, owner: owner, running: running) {
    case .roster(let rows):
      print("roster:\\(rows.count):\\(rows.first?.mayReissue ?? false)")
    case .invitation(let path, _): print("invitation:" + path)
    case .revoked: print("revoked")
    case .unavailable: print("unavailable")
    case .failed: print("failed")
    }
  }
}
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors",
      "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "Carbon",
      join(root, "overlay.swift"), join(repo, "product/echo-overlay/people.swift"), join(root, "proof.swift"), "-o", binary],
    { timeout: 120_000, stdio: "pipe" });
    writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
const mode = fs.readFileSync(root + "/mode", "utf8");
if (args[1] === "status") {
  const role = mode === "employee" || mode === "switched" ? "employee" : mode === "unknown-role" ? "administrator" : "owner";
  console.log(JSON.stringify({schema_version:1,kind:"echo-person-client-status-v1",signed_in:mode !== "signed-out",display_name:"Owner",membership_type:role,connected_authority:"https://authority.example.test"}));
} else if (mode === "denied") {
  console.error(JSON.stringify({ok:false,error:"LOGIN_GRANT_MUST_NOT_DISPLAY"})); process.exitCode = 1;
} else if (mode === "overflow") {
  process.stdout.write("x".repeat(256 * 1024));
} else if (mode === "invalid") {
  console.log("{invalid}");
} else {
  if (mode === "switch") fs.writeFileSync(root + "/mode", "switched");
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
    const result = spawnSync(binary, [cli, action, join(root, "private invitation.json")], { encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    return { result: result.stdout.trim(), calls, stderr: result.stderr };
  }

  it("shows validated owner roster results and only permits reissue before sign-in", () => {
    expect(run("owner").result).toBe("roster:1:true");
    expect(run("redeemed").result).toBe("roster:1:false");
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
  });

  it("keeps invitation arguments literal and accepts only the requested output path", () => {
    const invitation = run("owner", "invite");
    expect(invitation.result).toBe(`invitation:${join(root, "private invitation.json")}`);
    expect(invitation.calls[1]).toEqual(["person", "employee", "invite", "--name", "A '; touch forbidden #", "--email", "a@example.test", "--out", join(root, "private invitation.json")]);
    expect(run("owner", "reissue").result).toMatch(/^invitation:/);
    expect(run("wrong-path", "invite").result).toBe("failed");
    expect(run("owner", "revoke").result).toBe("revoked");
  });

  it.each(["denied", "overflow", "invalid"])("fails closed for %s without exposing command output or retrying a mutation", (mode) => {
    const result = run(mode, "invite");
    expect(result.result).toBe("failed");
    expect(result.stderr).not.toContain("LOGIN_GRANT_MUST_NOT_DISPLAY");
    expect(result.calls.filter((args) => args[1] === "employee")).toHaveLength(1);
  });

  it("does not submit a cancelled command", () => {
    expect(run("owner", "cancel")).toMatchObject({ result: "unavailable", calls: [] });
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
