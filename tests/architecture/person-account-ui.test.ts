import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const account = join(repo, "product/echo-overlay/account.swift");
const builder = join(repo, "tools/build-echo-overlay.mjs");
const roots: string[] = [];

afterAll(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("native Person account controls", () => {
  it("keeps browser sign-in in the installed client and never sends grants or URLs to the UI", () => {
    expect(existsSync(account)).toBe(true);
    const source = readFileSync(account, "utf8");
    expect(source).toContain('"person", "login", "--authority-url", origin, "--open-browser"');
    expect(source).toContain('"person", "login", "--invitation", invitation.path, "--open-browser"');
    expect(source).toContain("validateAuthorityOrigin");
    expect(source).toContain("UserDefaults.standard.set");
    expect(source).toContain("onSessionWillChange()");
    expect(source).toContain("AccountObservation");
    expect(source).toContain("func shutdown()");
    expect(source).toContain("activeOperation?.cancel()");
    expect(source).toContain("Sign out of this ECHO account?");
    expect(source).not.toMatch(/authorization_url|OAuthURL|grant|URLSession/);
  });

  it("builds account.swift into the overlay and binds it to the committed source", () => {
    const source = readFileSync(builder, "utf8");
    expect(source).toContain("const accountPath = 'product/echo-overlay/account.swift';");
    expect(source).toContain("regularFile(accountSource, 'Account Swift source')");
    expect(source).toContain("stagedAccount");
  });

  it("clears account-scoped surfaces and blocks an account change during a People mutation", () => {
    const source = readFileSync(join(repo, "product/echo-overlay/main.swift"), "utf8");
    expect(source).toContain("AccountController(");
    expect(source).toContain("controller?.accountWillChange()");
    expect(source).toContain("people?.conceal()");
    expect(source).toContain("people?.hasOutstandingMutation");
  });

  it.skipIf(process.platform !== "darwin")("strictly compiles the account interface without a real session", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-account-compile-")));
    roots.push(root);
    const proof = join(root, "proof.swift");
    writeFileSync(proof, "import AppKit\nimport Foundation\n@main enum Proof { static func main() {} }\n");
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", account, proof, "-o", join(root, "proof")], {
      stdio: "pipe", env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(root, "module-cache") },
    });
  });

  it.skipIf(process.platform !== "darwin")("strictly compiles the onboarding interface without a real session", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-onboarding-compile-")));
    roots.push(root);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", join(repo, "product/echo-onboarding/main.swift"), "-o", join(root, "proof")], {
      stdio: "pipe", env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(root, "module-cache") },
    });
  });

  it.skipIf(process.platform !== "darwin")("requires a stable permission-aware read, cancels the exact login process, and rejects stale requests", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-account-proof-")));
    roots.push(root);
    const binary = join(root, "proof");
    const cli = join(root, "cli.cjs");
    writeFileSync(join(root, "mode"), "ready");
    writeFileSync(join(root, "signed-in"), "false");
    writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
const mode = fs.readFileSync(root + "/mode", "utf8");
if (args[1] === "status") {
  const signedIn = fs.readFileSync(root + "/signed-in", "utf8") === "true";
  console.log(JSON.stringify({schema_version:1,kind:"echo-person-client-status-v1",signed_in:signedIn,display_name:signedIn ? "Person" : null,membership_type:signedIn ? "employee" : null,connected_authority:signedIn ? "https://authority.example.test" : null,installed_version:"1.2.3"}));
} else if (args[1] === "login") {
  if (mode === "cancel") setInterval(() => {}, 1000);
  else fs.writeFileSync(root + "/signed-in", "true");
} else if (args[1] === "records") {
  if (mode === "denied") process.exit(1);
  else console.log(JSON.stringify({ok:true,result:{schema_version:1,kind:"echo-clean-person-record-list-v1",records:[]}}));
}
`);
    chmodSync(cli, 0o700);
    writeFileSync(join(root, "proof.swift"), `import AppKit
import Foundation
@main enum Proof {
  static func main() {
    let observation = AccountObservation()
    let observedIdentity = AccountIdentity(displayName: "Person", role: "Employee", authority: "https://authority.example.test", version: "1.2.3")
    print("observed:\\(observation.accept(.unavailable)):\\(observation.accept(.unavailable)):\\(observation.accept(.signedIn(observedIdentity)))\\(observation.accept(.signedIn(observedIdentity)))\\(observation.accept(.signedOut))")
    let gate = AccountRequestGate()
    let stale = gate.replace(); let current = gate.replace()
    print("gate:\\(gate.accepts(stale)):\\(gate.accepts(current))")
    let running = AccountRunning()
    if CommandLine.arguments[2] == "cancel" {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.08) { running.cancel() }
    }
    let client = AccountClient(executable: URL(fileURLWithPath: CommandLine.arguments[1]))
    switch client.execute(.loginAuthority("https://authority.example.test"), running: running) {
    case .ready(let identity): print("ready:\\(identity.authority)")
    case .accessDenied: print("access-denied")
    case .cancelled: print("cancelled")
    default: print("other")
    }
  }
}
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", account, join(root, "proof.swift"), "-o", binary], {
      stdio: "pipe", env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(root, "module-cache") },
    });
    const run = (mode: string) => {
      writeFileSync(join(root, "mode"), mode); writeFileSync(join(root, "signed-in"), "false"); writeFileSync(join(root, "calls.jsonl"), "");
      return spawnSync(binary, [cli, mode], { encoding: "utf8", timeout: 10_000 });
    };
    const ready = run("ready");
    expect(ready.status, ready.stderr).toBe(0);
    expect(ready.stdout.trim().split("\n")).toEqual(["observed:false:false:truefalsetrue", "gate:false:true", "ready:https://authority.example.test"]);
    expect(readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
      ["person", "status"], ["person", "login", "--authority-url", "https://authority.example.test", "--open-browser"],
      ["person", "status"], ["person", "records", "--limit", "1"], ["person", "status"],
    ]);
    expect(run("denied").stdout.trim().split("\n").at(-1)).toBe("access-denied");
    expect(run("cancel").stdout.trim().split("\n").at(-1)).toBe("cancelled");
  });
});
