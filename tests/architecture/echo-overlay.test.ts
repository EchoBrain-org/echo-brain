import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
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
  copyFileSync(resolve(REPO, "product/echo-overlay/people.swift"), join(sourceRoot, "product", "echo-overlay", "people.swift"));
  copyFileSync(resolve(REPO, "product/echo-overlay/account.swift"), join(sourceRoot, "product", "echo-overlay", "account.swift"));
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

// The installer runs only against this synthetic HOME. Native validation tools are
// replaced in the copied script; production has no test bypass or PATH override.
function installerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-installer-")));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const kit = join(root, "kit");
  const fake = join(root, "tools");
  for (const path of [home, kit, fake]) mkdirSync(path, { mode: 0o700 });
  const tool = (name: string, body: string) => {
    writeFileSync(join(fake, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  };
  tool("uname", 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi');
  tool("codesign", 'exit 0');
  tool("lipo", 'echo arm64');
  tool("PlistBuddy", 'echo org.echobrain.echo-overlay');
  tool("ditto", 'unzip -q "$3" -d "$4"');
  tool("stat", `exec "${process.execPath}" -e 'const s=require("node:fs").statSync(process.argv[2]); console.log(process.argv[1]==="%u"?s.uid:(s.mode&511).toString(8))' "$2" "$3"`);
  tool("tar", 'if [[ "${REFUSE_ARCHIVE:-}" == yes && "$*" == *pair.pending.tar.gz* ]]; then exit 1; fi\nexec /usr/bin/tar "$@"');
  tool("mv", `if [[ -n "\${FAIL_MOVE:-}" && "$1|$2" == *"$FAIL_MOVE"* && ! -e "${root}/injected" ]]; then
  touch "${root}/injected"
  if [[ "\${INTERRUPT_MOVE:-}" == yes ]]; then /bin/mv "$@"; kill -TERM "$PPID"; exit 0; fi
  exit 1
fi
exec /bin/mv "$@"`);
  let installer = readFileSync(INSTALLER, "utf8");
  for (const name of ["ditto", "codesign", "lipo"])
    installer = installer.replaceAll(`/usr/bin/${name}`, join(fake, name));
  installer = installer.replaceAll("/usr/libexec/PlistBuddy", join(fake, "PlistBuddy"));
  writeFileSync(join(kit, "Start ECHO.command"), installer);
  writeFileSync(join(kit, "node"), `#!/usr/bin/env bash\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(kit, "verify-person-onboarding-kit.mjs"), 'if (process.env.REJECT_KIT) process.exit(1);\n');
  writeFileSync(join(kit, "clean-v1-release.mjs"), `import {readFileSync} from 'node:fs';
if(process.argv[2] === 'field') console.log(JSON.parse(readFileSync(process.argv[3]))[process.argv[4]]);\n`);
  writeFileSync(join(kit, "kit-manifest.v1.json"), '{}');
  const support = join(home, "Library/Application Support/ECHO");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  const session = join(support, "synthetic-session.json");
  writeFileSync(session, 'synthetic compatible session', { mode: 0o600 });
  function prepare(release: number) {
    const version = `0.1.${release}`;
    const sha = String(release).repeat(40);
    writeFileSync(join(kit, "release.json"), JSON.stringify({ "release-id": `release-${release}`, "client-version": version, "source-sha": sha }));
    const contents = join(root, "ECHO.app/Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), "synthetic ECHO plist");
    writeFileSync(join(contents, "MacOS/ECHO"), `#!/usr/bin/env bash\n# ${sha}\nexit \${REFUSE_RETIREMENT:-0}\n`, { mode: 0o755 });
    writeFileSync(join(contents, "Resources/build-identity.v1.json"), JSON.stringify({ schema_version: 1, kind: "echo-overlay-build-identity-v1", product_version: version, source_sha: sha, platform: "darwin", architecture: "arm64" }));
    rmSync(join(kit, "ECHO.app.zip"), { force: true });
    execFileSync("zip", ["-qr", join(kit, "ECHO.app.zip"), "ECHO.app"], { cwd: root });
    mkdirSync(join(root, "package/dist"), { recursive: true });
    writeFileSync(join(root, "package/dist/main.js"), `console.log('${version}');\n`);
    execFileSync("tar", ["-czf", join(kit, "person-client.tgz"), "-C", root, "package"]);
  }
  function install(release: number, env: Record<string, string> = {}) {
    prepare(release);
    return spawnSync("bash", [join(kit, "Start ECHO.command"), "--install-only"], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, ...env } });
  }
  function pair(release: number) {
    expect(JSON.parse(readFileSync(join(home, "Applications/ECHO.app/Contents/Resources/build-identity.v1.json"), "utf8")).source_sha).toBe(String(release).repeat(40));
    const wrapper = join(support, "bin/echo-brain");
    expect(readFileSync(wrapper, "utf8")).toContain(`release-${release}/`);
    expect(execFileSync("bash", [wrapper], { encoding: "utf8" }).trim()).toBe(`0.1.${release}`);
    expect(readFileSync(session, "utf8")).toBe("synthetic compatible session");
  }
  return { root, home, support, install, pair };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("native ECHO hotkey overlay", () => {
  it("bounds retained installer releases and keeps rollback apps out of discovery", () => {
    const subject = installerFixture();
    let previousSlots: string[] = [];
    for (const release of [1, 2, 2, 3, 4]) {
      const installed = subject.install(release);
      expect(installed.status, installed.stderr).toBe(0);
      subject.pair(release);
      const slots = readdirSync(join(subject.support, "overlay-backups"));
      if (release === 2 && previousSlots.length) expect(slots).toEqual(previousSlots);
      if (release === 2) previousSlots = slots;
    }
    expect(readdirSync(join(subject.support, "releases")).sort()).toEqual(["release-3", "release-4"]);
    expect(readdirSync(join(subject.support, "bin"))).toEqual(["echo-brain"]);
    const slots = readdirSync(join(subject.support, "overlay-backups"));
    expect(slots).toHaveLength(1);
    const slot = join(subject.support, "overlay-backups", slots[0]!);
    expect(statSync(slot).mode & 0o777).toBe(0o700);
    expect(existsSync(join(slot, "ECHO.app"))).toBe(false);
    expect(existsSync(join(slot, "pair.tar.gz"))).toBe(true);
    const restored = join(subject.root, "restored");
    mkdirSync(restored);
    execFileSync("tar", ["-xzf", join(slot, "pair.tar.gz"), "-C", restored]);
    expect(JSON.parse(readFileSync(join(restored, "ECHO.app/Contents/Resources/build-identity.v1.json"), "utf8")).source_sha).toBe("3".repeat(40));
    expect(execFileSync("bash", [join(restored, "echo-brain")], { encoding: "utf8" }).trim()).toBe("0.1.3");
  });

  it.each([
    "bin/echo-brain|", "Applications/ECHO.app|", "|DEST_APP", "|DEST_WRAPPER",
  ])("preserves a matched pair and skips pruning when interrupted at %s", (transition) => {
    const subject = installerFixture();
    for (const release of [1, 2]) expect(subject.install(release).status).toBe(0);
    const point = transition.replace("DEST_APP", join(subject.home, "Applications/ECHO.app"))
      .replace("DEST_WRAPPER", join(subject.support, "bin/echo-brain"));
    const result = subject.install(3, { FAIL_MOVE: point, INTERRUPT_MOVE: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("setup was interrupted");
    for (const slot of readdirSync(join(subject.support, "overlay-backups"))) {
      expect(existsSync(join(subject.support, "overlay-backups", slot, "ECHO.app"))).toBe(false);
    }
    subject.pair(3);
    expect(readdirSync(join(subject.support, "releases"))).toContain("release-1");
    expect(subject.install(3).status).toBe(0);
    subject.pair(3);
  });

  it.each([
    "bin/echo-brain|", "Applications/ECHO.app|", "|DEST_APP", "|DEST_WRAPPER", "retirement",
  ])("restores the prior pair without pruning when activation fails at %s", (transition) => {
    const subject = installerFixture();
    for (const release of [1, 2]) expect(subject.install(release).status).toBe(0);
    const point = transition.replace("DEST_APP", join(subject.home, "Applications/ECHO.app"))
      .replace("DEST_WRAPPER", join(subject.support, "bin/echo-brain"));
    const result = subject.install(3, transition === "retirement" ? { REFUSE_RETIREMENT: "1" } : { FAIL_MOVE: point });
    expect(result.status).toBe(1);
    subject.pair(2);
    expect(readdirSync(join(subject.support, "releases"))).toContain("release-1");
  });

  it("preserves unrelated and unmarked legacy artifacts and refuses symlink cleanup", () => {
    const subject = installerFixture();
    expect(subject.install(1).status).toBe(0);
    const artifacts = [
      join(subject.home, "Applications/Other.app"),
      join(subject.home, "Downloads/ECHO.app"),
      join(subject.home, "Library/LaunchAgents/legacy-echo.plist"),
      join(subject.support, "releases/legacy/keep"),
      join(subject.support, "bin/.echo-brain.previous.legacy/keep"),
      join(subject.support, "overlay-backups/previous.legacy/ECHO.app/keep"),
    ];
    for (const path of artifacts) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "unrelated");
    }
    symlinkSync(join(subject.home, "Downloads"), join(subject.support, "releases/release-1/external"));
    for (const release of [2, 3, 4]) {
      expect(subject.install(release).status).toBe(0);
      subject.pair(release);
    }
    for (const path of artifacts) expect(readFileSync(path, "utf8")).toBe("unrelated");
    expect(existsSync(join(subject.support, "releases/release-1"))).toBe(true);
    const before = readdirSync(join(subject.support, "releases"));
    expect(subject.install(5, { REJECT_KIT: "1" }).status).toBe(1);
    expect(readdirSync(join(subject.support, "releases"))).toEqual(before);
    subject.pair(4);
  });

  it("keeps recovery material and skips pruning when rollback archiving fails", () => {
    const subject = installerFixture();
    for (const release of [1, 2]) expect(subject.install(release).status).toBe(0);
    const result = subject.install(3, { REFUSE_ARCHIVE: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private rollback cleanup could not complete");
    subject.pair(3);
    expect(readdirSync(join(subject.support, "releases")).sort()).toEqual(["release-1", "release-2", "release-3"]);
    const slots = readdirSync(join(subject.support, "overlay-backups"));
    expect(slots.some(slot => existsSync(join(subject.support, "overlay-backups", slot, "ECHO.app")))).toBe(true);
    const wrappers = readdirSync(join(subject.support, "bin")).filter(name => name.startsWith(".echo-brain.previous."));
    expect(wrappers).toHaveLength(1);
    expect(execFileSync("bash", [join(subject.support, "bin", wrappers[0]!, "echo-brain")], { encoding: "utf8" }).trim()).toBe("0.1.2");
  });

  it("refuses another install or conflicting release ID without changing the active pair", () => {
    const subject = installerFixture();
    expect(subject.install(1).status).toBe(0);
    const lock = join(subject.support, ".installer-lock");
    mkdirSync(lock, { mode: 0o700 });
    const locked = subject.install(2);
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("installer lock");
    subject.pair(1);
    rmSync(lock, { recursive: true });
    writeFileSync(join(subject.support, "releases/release-1/kit-manifest.v1.json"), '{"changed":true}');
    const collision = subject.install(1);
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain("different release artifacts");
    subject.pair(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("distinguishes the graphical setup from the installed product", () => {
    const plist = readFileSync(join(REPO, "product/echo-onboarding/Info.plist"), "utf8");
    expect(plist).toContain('<key>CFBundleDisplayName</key><string>ECHO Setup</string>');
    const builder = readFileSync(join(REPO, "deploy/release/create-person-onboarding-kit.mjs"), "utf8");
    expect(builder).toContain("join(stagingParent, 'ECHO Setup.app')");
    expect(builder).toContain("contents: graphical ? ['ECHO Setup.app']");
  });

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
    const peopleChangedAfterStatus = runOverlayBuilder(subject, subject.sourceSha, {
      ECHO_OVERLAY_MUTATE_AFTER_STATUS_PATH: join(
        subject.sourceRoot, "product", "echo-overlay", "people.swift",
      ),
    });
    expect(peopleChangedAfterStatus.status).toBe(1);
    expect(peopleChangedAfterStatus.stderr).toContain(
      "People Swift source does not match its committed source",
    );
    expect(existsSync(subject.toolLog)).toBe(false);

    execFileSync("git", ["-C", subject.sourceRoot, "checkout", "--", "."]);
    const accountChangedAfterStatus = runOverlayBuilder(subject, subject.sourceSha, {
      ECHO_OVERLAY_MUTATE_AFTER_STATUS_PATH: join(
        subject.sourceRoot, "product", "echo-overlay", "account.swift",
      ),
    });
    expect(accountChangedAfterStatus.status).toBe(1);
    expect(accountChangedAfterStatus.stderr).toContain(
      "Account Swift source does not match its committed source",
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

  it("keeps the answer visible while loading permission-checked source cards", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain('PillButton(title: "Copy answer"');
    expect(source).toContain("final class PillButton: NSButton");
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
    expect(source).toContain('PillButton(title: "Sources (0)"');
    expect(source).toContain('process.arguments = ["person", "records", "--record-sha256", recordSha256]');
    expect(source).toContain("maximumSourceProcessOutputBytes = 512 * 1024 + 1024");
    expect(source).toContain("BoundedReader(maximumBytes: maximumSourceProcessOutputBytes)");
    expect(source).toContain("private struct DisplaySource");
    expect(source).toContain("fileprivate static func parseSourceRecord");
    expect(source).toContain("isSha256(citation.atom_id)");
    expect(source).toContain("isSha256(citation.record_sha256)");
    expect(source).toContain("records.count == 1");
    expect(source).toContain("recordSha256 == source.recordSha256");
    expect(source).toContain('event["policy_id"] as? String == source.policyID');
    expect(source).toContain("sourceRequestIdentifier == identifier");
    expect(source).toContain("currentSources = []");
    expect(source).toContain("private func clearFetchedSources()");
    expect(source).not.toContain('process.arguments = ["person", "records", "--limit"');
    expect(source).toContain("Source details are unavailable.");
    expect(source).toContain("Visible to active organization members");
    expect(source).toContain("Only the approver");
    expect(source).toContain("func accountWillChange()");
    expect(source).toContain("func applicationDidDeactivate()");
    expect(source).toContain("activeSources?.cancel()");
    expect(source).toContain("Back to answer");
    const hidePanel = source.slice(source.indexOf("func hidePanel()"), source.indexOf("func shutdown()"));
    const deactivate = source.slice(source.indexOf("func applicationDidDeactivate()"), source.indexOf("func windowShouldClose"));
    expect(hidePanel).toContain("clearFetchedSources()");
    expect(deactivate).toContain("clearFetchedSources()");
  });

  it("uses the ECHO brand palette", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain("The warm dark palette published by echobrain.org");
    expect(source).toContain("enum EchoTheme");
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
      "if self.sourcePaneOpen { self.showAnswer() } else { self.hidePanel() }",
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
