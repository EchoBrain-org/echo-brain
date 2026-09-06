import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const SOURCE = resolve(REPO, "product/echo-overlay/main.swift");
const PLIST = resolve(REPO, "product/echo-overlay/Info.plist");
const BUILDER = resolve(REPO, "tools/build-echo-overlay.mjs");
const CI = resolve(REPO, ".github/workflows/ci.yml");
const INSTALLER = resolve(
  REPO,
  "deploy/release/start-person-onboarding-kit.sh",
);
const temporaryRoots: string[] = [];

function overlayFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-overlay-builder-")));
  temporaryRoots.push(root);
  const sourceRoot = join(root, "source");
  const output = join(root, "output");
  mkdirSync(join(sourceRoot, "tools"), { recursive: true, mode: 0o700 });
  mkdirSync(join(sourceRoot, "product", "echo-overlay"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  copyFileSync(BUILDER, join(sourceRoot, "tools", "build-echo-overlay.mjs"));
  copyFileSync(SOURCE, join(sourceRoot, "product", "echo-overlay", "main.swift"));
  copyFileSync(PLIST, join(sourceRoot, "product", "echo-overlay", "Info.plist"));
  execFileSync("git", ["init", "-q", sourceRoot]);
  execFileSync("git", ["-C", sourceRoot, "add", "."]);
  execFileSync("git", [
    "-C",
    sourceRoot,
    "-c",
    "user.name=Overlay Test",
    "-c",
    "user.email=overlay@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const sourceSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const toolLog = join(root, "tool-log.txt");
  const preload = join(root, "fake-macos-tools.cjs");
  writeFileSync(
    preload,
    `const child = require("node:child_process");
const fs = require("node:fs");
const original = child.spawnSync;
let changedAfterInitialStatus = false;
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "arm64" });
child.spawnSync = (command, args, options) => {
  if (command === "git") {
    const result = original(command, args, options);
    if (!changedAfterInitialStatus && args[0] === "status" && process.env.ECHO_OVERLAY_MUTATE_AFTER_STATUS_PATH) {
      changedAfterInitialStatus = true;
      fs.appendFileSync(process.env.ECHO_OVERLAY_MUTATE_AFTER_STATUS_PATH, "// changed after status\\n");
    }
    return result;
  }
  fs.appendFileSync(process.env.ECHO_OVERLAY_TOOL_LOG, command + "\\n");
  if (command === "/usr/bin/xcrun") {
    fs.writeFileSync(args[args.indexOf("-o") + 1], "fake executable");
    if (process.env.ECHO_OVERLAY_MUTATE_PATH) fs.appendFileSync(process.env.ECHO_OVERLAY_MUTATE_PATH, "// changed\\n");
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command === "/usr/bin/ditto") {
    fs.writeFileSync(args.at(-1), "fake archive");
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command === "/usr/bin/plutil") return { status: 0, stdout: process.env.ECHO_OVERLAY_EXPECTED_SHA + "\\n", stderr: "" };
  if (command === "/usr/bin/codesign") return { status: 0, stdout: "", stderr: "" };
  throw new Error("unexpected fake tool: " + command);
};
`,
    { mode: 0o600 },
  );
  return { root, sourceRoot, output, sourceSha, preload, toolLog };
}

function runOverlayBuilder(
  subject: ReturnType<typeof overlayFixture>,
  sourceSha = subject.sourceSha,
  environment: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--require",
      subject.preload,
      join(subject.sourceRoot, "tools", "build-echo-overlay.mjs"),
      "--source-sha",
      sourceSha,
      "--version",
      "0.1.0",
      "--output",
      join(subject.output, "ECHO.app.zip"),
    ],
    {
      cwd: subject.sourceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ECHO_OVERLAY_TOOL_LOG: subject.toolLog,
        ECHO_OVERLAY_EXPECTED_SHA: subject.sourceSha,
        ...environment,
      },
    },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("native ECHO hotkey overlay", () => {
  it("binds the requested source SHA to a clean committed build before and after fake native tooling", () => {
    const subject = overlayFixture();
    const mismatched = runOverlayBuilder(subject, "a".repeat(40));
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("source SHA must match clean committed source");
    expect(existsSync(subject.toolLog)).toBe(false);

    writeFileSync(
      join(subject.sourceRoot, "product", "echo-overlay", "main.swift"),
      "// dirty\n",
    );
    const dirty = runOverlayBuilder(subject);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("build requires clean, committed source");
    expect(existsSync(subject.toolLog)).toBe(false);

    execFileSync("git", ["-C", subject.sourceRoot, "checkout", "--", "."]);
    const changedAfterStatus = runOverlayBuilder(subject, subject.sourceSha, {
      ECHO_OVERLAY_MUTATE_AFTER_STATUS_PATH: join(
        subject.sourceRoot,
        "product",
        "echo-overlay",
        "main.swift",
      ),
    });
    expect(changedAfterStatus.status).toBe(1);
    expect(changedAfterStatus.stderr).toContain(
      "Swift source does not match its committed source",
    );
    expect(existsSync(subject.toolLog)).toBe(false);

    execFileSync("git", ["-C", subject.sourceRoot, "checkout", "--", "."]);
    const changedDuringBuild = runOverlayBuilder(subject, subject.sourceSha, {
      ECHO_OVERLAY_MUTATE_PATH: join(
        subject.sourceRoot,
        "product",
        "echo-overlay",
        "main.swift",
      ),
    });
    expect(changedDuringBuild.status).toBe(1);
    expect(changedDuringBuild.stderr).toContain("source changed while the overlay was building");
    expect(existsSync(join(subject.output, "ECHO.app.zip"))).toBe(false);

    execFileSync("git", ["-C", subject.sourceRoot, "checkout", "--", "."]);
    rmSync(subject.toolLog, { force: true });
    const built = runOverlayBuilder(subject);
    expect(built.status, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout)).toMatchObject({ source_sha: subject.sourceSha });
    expect(readFileSync(subject.toolLog, "utf8")).toContain("/usr/bin/xcrun");
    expect(readFileSync(subject.toolLog, "utf8")).toContain("/usr/bin/ditto");
  });

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

    expect(source).toContain('PillButton(title: "Copy answer"');
    expect(source).toContain("private final class PillButton: NSButton");
    expect(source).toContain("override func drawFocusRingMask()");
    expect(source).not.toContain("bezelColor");
    expect(source).toContain("NSPasteboard.general.setString(answer, forType: .string)");
    expect(source).toContain('askButton.title = "Cancel"');
    expect(source).toContain('statusLabel.stringValue = "Thinking…"');
    expect(source).toContain("private func setThinking(_ thinking: Bool)");
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

  it("uses the ECHO brand palette", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain("The warm dark palette published by echobrain.org");
    expect(source).toContain("private enum EchoTheme");
    expect(source).toContain("static let ink = NSColor(srgbRed: 36 / 255");
    expect(source).toContain("static let text = NSColor(srgbRed: 240 / 255");
    expect(source).toContain("static let goldBright = NSColor(srgbRed: 240 / 255");
    expect(source).toContain("static let ember = NSColor(srgbRed: 234 / 255");
    expect(source).toContain("panel.appearance = NSAppearance(named: .darkAqua)");
    expect(source).toContain("panel.isMovableByWindowBackground = true");
    expect(source).toContain(
      "styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel]",
    );
    expect(source).toContain("func summon()");
    expect(source).toContain("if panel.isKeyWindow {");
    expect(source).toContain("controller?.summon()");
    expect(source).toContain("private func placePanel()");
    expect(source).toContain("NSMouseInRect(mouse, $0.frame, false)");
    expect(source).toContain("area.maxY - area.height * 0.2 - size.height");
    expect(source).toContain("composer.selectAll(nil)");
    expect(source).toContain("if activeAsk == nil, !hasConversation {");
    expect(source).toContain("limitLabel.isHidden = !(nearLimit ||");
    expect(source).not.toContain("NSVisualEffectView");
    expect(source).not.toContain("root.material = .hudWindow");
  });

  it("keeps an active Ask alive when the panel hides", () => {
    const source = readFileSync(SOURCE, "utf8");
    const hidePanel = source.match(
      /func hidePanel\(\) \{([\s\S]*?)\n    \}/,
    )?.[1];
    const shutdown = source.match(
      /func shutdown\(\) \{([\s\S]*?)\n    \}/,
    )?.[1];

    expect(hidePanel).toContain("cancelIdentityLookup()");
    expect(hidePanel).toContain("panel.orderOut(nil)");
    expect(hidePanel).not.toContain("cancelActiveAsk()");
    expect(source).toContain("if panel.isKeyWindow {\n                hidePanel()");
    expect(source).toContain(
      "func windowShouldClose(_ sender: NSWindow) -> Bool {\n        hidePanel()\n        return false",
    );
    expect(source).toContain(
      "panel.onCancel = { [weak self] in self?.hidePanel() }",
    );
    expect(source).toContain("func shutdown()");
    expect(shutdown).toContain("cancelActiveAsk()");
    expect(shutdown).toContain("cancelIdentityLookup()");
    expect(source).toContain("controller?.shutdown()");
    expect(source).not.toContain("cancelAndHide");
  });

  it("lets the answer area absorb spare height instead of hand-laying-out text", () => {
    const source = readFileSync(SOURCE, "utf8");

    // The only flexible row is the answer area: a near-zero-priority spring claims the
    // slack, every stack row hugs at required priority, and the empty-state label floats
    // in the middle instead of pinning the area to its own height.
    expect(source).toContain(
      "answerArea.heightAnchor.constraint(equalToConstant: 10_000)",
    );
    expect(source).toContain("answerSpring.priority = NSLayoutConstraint.Priority(1)");
    expect(source).toContain(
      "answerArea.heightAnchor.constraint(greaterThanOrEqualToConstant: 140)",
    );
    expect(source).toContain("header.setHuggingPriority(.required, for: .vertical)");
    expect(source).toContain(
      "composerCard.bottomAnchor.constraint(equalTo: promptRow.bottomAnchor)",
    );
    expect(source).toContain("askButton.heightAnchor.constraint(equalToConstant: 46)");
    expect(source).not.toContain("NSStackView(views: [composerCard, askButton])");
    expect(source).toContain("statusRow.setHuggingPriority(.required, for: .vertical)");
    expect(source).toContain(
      "emptyAnswerLabel.centerYAnchor.constraint(equalTo: answerArea.centerYAnchor)",
    );
    expect(source).toContain(
      "emptyAnswerLabel.topAnchor.constraint(greaterThanOrEqualTo: answerArea.topAnchor",
    );
    expect(source).toContain(
      "NSAttributedString(string: answer.answer, attributes: Self.answerAttributes)",
    );
    expect(source).toContain(
      "answerView.scrollRangeToVisible(NSRange(location: 0, length: 0))",
    );
    // Content hugging is meaningless on NSStackView (no intrinsic size) and manual frame
    // surgery on the text view masks layout bugs instead of fixing them.
    expect(source).not.toMatch(
      /(header|statusRow|answerHeader)\.setContentHuggingPriority/,
    );
    expect(source).not.toContain("layoutAnswerText");
    expect(source).not.toContain("answerView.frame.size.height");
    expect(source).not.toContain("layoutManager.ensureLayout(for: textContainer)\n        let textHeight");
  });

  it("builds as a permission-minimal macOS agent app", () => {
    const source = readFileSync(SOURCE, "utf8");
    const plist = readFileSync(PLIST, "utf8");
    const builder = readFileSync(BUILDER, "utf8");
    const ci = readFileSync(CI, "utf8");
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
    expect(ci).toContain("npm run build:echo-overlay --");
    expect(ci).toContain('--source-sha "$GITHUB_SHA"');
    expect(ci).toContain('--version "$package_version"');
    expect(ci).toContain('--output "$app_archive"');
    expect(ci).toContain('--app "$app_archive"');
    expect(installer).toContain(
      'app_destination="$applications_root/ECHO.app"',
    );
    expect(installer).toContain('/usr/bin/diff -qr "$staged_app"');
    expect(installer).toContain("validate_overlay_identity");
    expect(source).toContain("NSRunningApplication.runningApplications(");
    expect(source).toContain("withBundleIdentifier: overlayBundleIdentifier");
    expect(source).toContain("application.processIdentifier != currentProcessIdentifier");
    expect(source).toContain("application.terminate()");
    expect(source).toContain("overlayRetirementTimeoutSeconds");
    expect(source).toContain('CommandLine.arguments[1] == "--quit-running-overlay"');
    expect(installer).toContain(
      '"$app_destination/Contents/MacOS/ECHO" --quit-running-overlay',
    );
    const retireRunningOverlay = installer.indexOf(
      '"$app_destination/Contents/MacOS/ECHO" --quit-running-overlay',
    );
    expect(retireRunningOverlay).toBeGreaterThan(
      installer.indexOf('mv "$wrapper_pending" "$wrapper_destination"'),
    );
    expect(installer).toContain(
      "restore_prior_pair_after_retirement_failure",
    );
    expect(installer).toContain(
      'mv "$app_backup" "$app_destination"',
    );
    expect(installer).toContain(
      'mv "$wrapper_backup" "$wrapper_destination"',
    );
    expect(installer).not.toContain("/usr/bin/open");
    expect(installer).not.toMatch(/LaunchAgent|launchctl/);
  });
});
