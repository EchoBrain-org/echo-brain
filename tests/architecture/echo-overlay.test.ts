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
    expect(source).toContain('identityText = "Signed in as \\(firstName)"');
    expect(source).toContain(
      "displayName.split(whereSeparator: { $0.isWhitespace }).first",
    );
    expect(source).toContain("identityTimeoutSeconds: TimeInterval = 5");
    expect(source).not.toMatch(
      /NSFullUserName|NSUserName|URLSession|https?:\/\/|addGlobalMonitorForEvents/,
    );
  });

  it("provides one bounded multiline composer with native editing shortcuts", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain("private let maximumQuestionScalars = 240");
    expect(source).toContain("private let maximumQuestionUniqueTerms = 32");
    expect(source).toContain("private let maximumQuestionTermBytes = 64");
    expect(source).toContain("private let maximumRawQuestionUTF16Units = 4_096");
    expect(source).toContain("private final class QuestionTextView: NSTextView");
    expect(source).not.toContain("NSSearchField");
    expect(source).toContain("precomposedStringWithCanonicalMapping");
    expect(source).toContain(
      "trimmingCharacters(in: .whitespacesAndNewlines)",
    );
    expect(source).toContain("CharacterSet.controlCharacters");
    expect(source).toContain(
      'NSRegularExpression(pattern: "[\\\\p{L}\\\\p{N}]+")',
    );
    expect(source).toContain("override func performKeyEquivalent(with event: NSEvent)");
    expect(source).toContain('case "a": selectAll(nil)');
    expect(source).toContain('case "c": copy(nil)');
    expect(source).toContain('case "x": cut(nil)');
    expect(source).toContain('case "v": paste(nil)');
    expect(source).toContain("!event.modifierFlags.contains(.shift)");
    expect(source).toContain("if hasMarkedText()");
    expect(source).toContain("else if uniqueTermCount == 0");
    expect(source).toContain("resultingLength <= maximumRawQuestionUTF16Units");
    expect(source).toContain("\\(maximumRawQuestionUTF16Units.formatted())");
    expect(source).toContain("composerHeightConstraint");
    expect(source).toContain("composerScrollView.hasVerticalScroller = contentHeight > 132");
  });

  it("keeps the result surface simple while citation details are deferred", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain('NSButton(title: "Copy answer"');
    expect(source).toContain("NSPasteboard.general.setString(answer, forType: .string)");
    expect(source).toContain('askButton.title = "Cancel"');
    expect(source).toContain('statusLabel.stringValue = "Thinking…"');
    expect(source).toContain('announce("ECHO is thinking.")');
    expect(source).toContain("resetCopyFeedback()");
    expect(source).toContain("refreshQuestionPresentation(preservingStatus: true)");
    expect(source).toContain("notification: .announcementRequested");
    expect(source).toContain("answerHeader.isHidden = true");
    expect(source).toContain("panel.titleVisibility = .hidden");
    expect(source).not.toContain("citationLabel");
    expect(source).not.toContain('"Citations:');
    expect(source).not.toContain('"Policies:');
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
