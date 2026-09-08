import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "echo-overlay-source-fixture-"));
const executable = join(temporaryRoot, "source-fixture");

beforeAll(() => {
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-D",
      "ECHO_OVERLAY_SOURCE_FIXTURE",
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
      join(REPO, "product/echo-overlay/main.swift"),
      join(REPO, "product/echo-overlay/people.swift"),
      "-o",
      executable,
    ],
    { stdio: "pipe" },
  );
});

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

describe("native answer source parser", () => {
  it.each([
    "valid-answer",
    "duplicate-atom",
    "valid-source",
    "mismatched-source",
    "mismatched-policy",
    "empty-source",
  ])("handles %s fixtures through the compiled Swift parser", (mode) => {
    expect(spawnSync(executable, [mode]).status).toBe(0);
  });
});
