import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const MAIN = join(REPO, "product/echo-overlay/main.swift");
const FIXTURE = join(REPO, "tests/fixtures/echo-overlay-source-proof.swift");
const temporaryRoot = mkdtempSync(join(tmpdir(), "echo-overlay-source-fixture-"));
const executable = join(temporaryRoot, "source-fixture");

describe.skipIf(process.platform !== "darwin")("native answer source parser", () => {
beforeAll(() => {
  const main = readFileSync(MAIN, "utf8");
  const appEntry = "@main\nprivate enum EchoOverlayMain";
  const entryIndex = main.indexOf(appEntry);
  expect(entryIndex).toBeGreaterThan(0);
  const proofSource = join(temporaryRoot, "source-proof.swift");
  writeFileSync(
    proofSource,
    `${main.slice(0, entryIndex)}${readFileSync(FIXTURE, "utf8")}`,
  );
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      "-warnings-as-errors",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-module-cache-path",
      join(temporaryRoot, "swift-module-cache"),
      "-framework",
      "AppKit",
      "-framework",
      "Carbon",
      proofSource,
      join(REPO, "product/echo-overlay/ui-support.swift"), join(REPO, "product/echo-overlay/people.swift"),
      join(REPO, "product/echo-overlay/account.swift"),
      join(REPO, "providers/slack/client/swift/slack-connected-tools.swift"),
      "-o",
      executable,
    ],
    { stdio: "pipe", timeout: 120_000 },
  );
}, 120_000);

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  it.each([
    "valid-answer",
    "duplicate-atom",
    "grouped-record",
    "inconsistent-policy",
    "answer-scalar-limit",
    "unknown-citation-field",
    "cancelled-source-work",
    "source-failure-isolation",
    "progressive-source-delivery",
    "cancelled-source-batch",
    "valid-source",
    "optional-source-metadata",
    "absent-source-metadata",
    "source-card-layout",
    "source-card-minimal",
    "source-card-narrow",
    "source-final-success",
    "selected-source-priority",
    "uncited-answer-layout",
    "untitled-source",
    "panel-resigns-key",
    "large-source",
    "mismatched-source",
    "mismatched-policy",
    "empty-source",
  ])("handles %s fixtures through the compiled Swift parser", (mode) => {
    expect(spawnSync(executable, [mode]).status).toBe(0);
  });
});
