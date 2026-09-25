import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const SOURCE = resolve(REPO, "product/echo-overlay/main.swift");
const PLIST = resolve(REPO, "product/echo-overlay/Info.plist");
const BUILDER = resolve(REPO, "tools/build-echo-overlay.mjs");
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
  copyFileSync(resolve(REPO, "product/echo-overlay/uploads.swift"), join(sourceRoot, "product", "echo-overlay", "uploads.swift"));
  copyFileSync(PLIST, join(sourceRoot, "product", "echo-overlay", "Info.plist"));
  for (const relative of ["product/echo-overlay/projects.swift", "product/echo-overlay/ui-support.swift", "product/echo-overlay/source-assembly.v1.json", "providers/slack/client/swift/slack-connected-tools.swift", "tools/lib/swift-source-assembly.mjs"]) {
    mkdirSync(dirname(join(sourceRoot, relative)), { recursive: true });
    copyFileSync(join(REPO, relative), join(sourceRoot, relative));
  }
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
    if (args.includes("-typecheck")) {
      if (process.env.ECHO_OVERLAY_FAIL_DIRECTION) return { status: 1, stdout: "", stderr: "forbidden dependency" };
      return { status: 0, stdout: "", stderr: "" };
    }
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
  it("refuses publication when Swift dependency isolation fails", () => {
    const subject = overlayFixture();
    const result = runOverlayBuilder(subject, subject.sourceSha, { ECHO_OVERLAY_FAIL_DIRECTION: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Swift dependency direction failed for neutral");
    expect(readFileSync(subject.toolLog, "utf8")).not.toContain("/usr/bin/ditto");
    expect(readdirSync(subject.output)).toEqual([]);
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
      "product/echo-overlay/main.swift does not match its committed source",
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
      "product/echo-overlay/people.swift does not match its committed source",
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
      "product/echo-overlay/account.swift does not match its committed source",
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
    expect(source).toContain('var arguments = ["person", "ask", "--question", question]');
    expect(source).toContain('arguments += ["--project", projectID]');
    expect(source).toContain('"person", "ask-source", "--source-id", reference.sourceID');
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

  it("routes ⌘⇧E to capture without reading the pasteboard or the selection", () => {
    const source = readFileSync(SOURCE, "utf8");
    const projects = readFileSync(resolve(REPO, "product/echo-overlay/projects.swift"), "utf8");

    expect(source).toContain("EventHotKeyID(signature: hotKeySignature, id: 2)");
    expect(source).toContain("UInt32(cmdKey | shiftKey)");
    expect(source).toContain("EventParamName(kEventParamDirectObject)");
    expect(source).toContain("EventParamType(typeEventHotKeyID)");
    expect(source).toContain("case captureHotKeyIdentifier.id:");
    expect(source).toContain("DispatchQueue.main.async { delegate.showCapture() }");
    expect(source).toContain("projects?.capture()");
    expect(source).toContain("if let captureHotKey { UnregisterEventHotKey(captureHotKey) }");
    expect(projects).toContain("func capture()");
    for (const text of [source, projects]) {
      expect(text).not.toMatch(
        /NSPasteboard\.general\.(string|data|propertyList|readObjects|pasteboardItems)|AXUIElement|kAXSelectedText/,
      );
    }
  });

  // Native source-card, project-scope, and composer behavior is exercised by
  // echo-overlay-sources-fixture.test.ts and echo-projects.test.ts. Keep source
  // checks here for the installed-client boundary and account-change wiring.
  it("bounds source reads through the installed client and invalidates them on account changes", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain('process.arguments = ["person", "records", "--record-sha256", recordSha256]');
    expect(source).toContain("maximumSourceProcessOutputBytes = 512 * 1024 + 1024");
    expect(source).toContain("BoundedReader(maximumBytes: maximumSourceProcessOutputBytes)");
    expect(source).not.toContain('process.arguments = ["person", "records", "--limit"');
    expect(source).toContain("func accountWillChange()");
    expect(source).toContain("func applicationDidDeactivate()");
    expect(source).toContain("activeSources?.cancel()");
    expect(source).toContain('home.askSubPage = { [weak self] in self?.controller?.sourcesCoverAnswer == true ? "Answer" : nil }');
    expect(source).toContain("home.closeAskSubPage = { [weak self] in self?.controller?.closeSourcesForBack() }");
    expect(source).toContain("controller?.onSourcesCoverChanged = { [weak home] in home?.askPageChanged() }");
    expect(source).toContain("home.onInvalidateAnswer = { [weak self] in self?.controller?.accountWillChange() }");
  });
  it("builds as a permission-minimal macOS agent app", () => {
    const source = readFileSync(SOURCE, "utf8");
    const plist = readFileSync(PLIST, "utf8");
    const builder = readFileSync(BUILDER, "utf8");

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
    expect(source).toContain("NSRunningApplication.runningApplications(");
    expect(source).toContain("withBundleIdentifier: overlayBundleIdentifier");
    expect(source).toContain("application.processIdentifier != currentProcessIdentifier");
    expect(source).toContain("application.terminate()");
    expect(source).toContain("overlayRetirementTimeoutSeconds");
    expect(source).toContain('CommandLine.arguments[1] == "--quit-running-overlay"');
  });
});
