import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
});
