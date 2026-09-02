import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const SOURCE = resolve(REPO, "product/echo-overlay/main.swift");
const PLIST = resolve(REPO, "product/echo-overlay/Info.plist");
const BUILDER = resolve(REPO, "tools/build-echo-overlay.mjs");
const INSTALLER = resolve(
  REPO,
  "deploy/release/start-person-onboarding-kit.sh",
);

describe("native ECHO hotkey overlay", () => {
  it("uses the installed Person CLI for questions and the authenticated first name", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain("RegisterEventHotKey");
    expect(source).toContain("OptionBits(kEventHotKeyExclusive)");
    expect(source).toContain("UInt32(cmdKey)");
    expect(source).toContain(
      '"Library/Application Support/ECHO/bin/echo-brain"',
    );
    expect(source).toContain(
      'process.arguments = ["person", "ask", "--question", question]',
    );
    expect(source).toContain('process.arguments = ["person", "status"]');
    expect(source).toContain("status.display_name");
    expect(source).toContain('identityLabel.stringValue = "Signed in as \\(firstName)"');
    expect(source).toContain(
      "displayName.split(whereSeparator: { $0.isWhitespace }).first",
    );
    expect(source).toContain("identityTimeoutSeconds: TimeInterval = 5");
    expect(source).not.toMatch(
      /NSFullUserName|NSUserName|URLSession|https?:\/\/|addGlobalMonitorForEvents/,
    );
  });

  it("builds as a permission-minimal macOS agent app", () => {
    const plist = readFileSync(PLIST, "utf8");
    const builder = readFileSync(BUILDER, "utf8");
    const installer = readFileSync(INSTALLER, "utf8");

    expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(plist).not.toMatch(
      /NSMicrophoneUsageDescription|NSAppleEventsUsageDescription|NSScreenCaptureUsageDescription/,
    );
    expect(builder).toContain("process.platform !== 'darwin'");
    expect(builder).toContain("process.arch !== 'arm64'");
    expect(builder).toContain("'swiftc'");
    expect(builder).toContain("'-warnings-as-errors'");
    expect(builder).toContain("'--options', 'runtime'");
    expect(builder).toContain("'--verify', '--deep', '--strict'");
    expect(installer).toContain(
      'app_destination="$applications_root/ECHO.app"',
    );
    expect(installer).toContain('/usr/bin/diff -qr "$staged_app"');
    expect(installer).toContain("validate_overlay_identity");
    expect(installer).not.toContain("/usr/bin/open");
    expect(installer).not.toMatch(/LaunchAgent|launchctl/);
  });
});
