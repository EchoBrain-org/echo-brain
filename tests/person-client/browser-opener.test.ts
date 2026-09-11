import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openAuthorizationUrl } from "../../src/product/person-client/commands.js";

const authorizationUrl = "https://identity.example/authorize?state=private-state";

function spawnResult(input: Partial<ReturnType<typeof spawnSync>>): ReturnType<typeof spawnSync> {
  return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null, ...input };
}

describe("Person browser opener", () => {
  it("uses trusted native macOS and Linux openers without a shell", () => {
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const spawn = ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      return spawnResult({ status: 0 });
    }) as typeof spawnSync;

    expect(openAuthorizationUrl(authorizationUrl, { platform: "darwin", spawn_sync: spawn })).toBe(true);
    expect(openAuthorizationUrl(authorizationUrl, { platform: "linux", spawn_sync: spawn })).toBe(true);
    expect(calls).toEqual([
      { command: "/usr/bin/open", args: [authorizationUrl], options: { stdio: "ignore", timeout: 10_000, shell: false } },
      { command: "/usr/bin/xdg-open", args: [authorizationUrl], options: { stdio: "ignore", timeout: 10_000, shell: false } },
    ]);
  });

  it("does not attempt a browser launch on an unsupported platform", () => {
    let called = false;
    const spawn = (() => {
      called = true;
      return spawnResult({ status: 0 });
    }) as typeof spawnSync;

    expect(openAuthorizationUrl(authorizationUrl, { platform: "win32", spawn_sync: spawn })).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false when xdg-open is missing, fails, or times out", () => {
    for (const result of [
      spawnResult({ status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
      spawnResult({ status: 1 }),
      spawnResult({ status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }),
    ]) {
      const spawn = (() => result) as typeof spawnSync;
      expect(openAuthorizationUrl(authorizationUrl, { platform: "linux", spawn_sync: spawn })).toBe(false);
    }
  });
});
