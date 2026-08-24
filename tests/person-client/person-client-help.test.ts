import { runPersonClientCli } from "../../src/product/person-client/index.js";
import { describe, expect, it } from "vitest";

async function help(argv: readonly string[]): Promise<string> {
  let stdout = "";
  let stderr = "";
  await expect(
    runPersonClientCli(argv, {
      stdout: { write: (value) => ((stdout += String(value)), true) },
      stderr: { write: (value) => ((stderr += String(value)), true) },
    }),
  ).resolves.toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

describe("Person client help", () => {
  it("documents the supported Person commands without constructing a session", async () => {
    await expect(help(["--help"])).resolves.toContain(
      "usage: echo-brain person <command> [options]",
    );
    await expect(help(["--help"])).resolves.toContain("employee");
  });

  it("documents sign-in, reads, session commands, and nested employee commands", async () => {
    await expect(help(["login", "--help"])).resolves.toContain(
      "--invitation <path> | --authority-url <url>",
    );
    await expect(help(["records", "--help"])).resolves.toContain(
      "[--limit <1-100>] [--query <text>]",
    );
    await expect(help(["status", "--help"])).resolves.toContain(
      "echo-brain person status",
    );
    await expect(help(["logout", "--help"])).resolves.toContain(
      "echo-brain person logout",
    );
    await expect(help(["employee", "--help"])).resolves.toContain(
      "<list|invite|reissue|revoke>",
    );
    await expect(help(["employee", "list", "--help"])).resolves.toContain(
      "echo-brain person employee list",
    );
    await expect(help(["employee", "invite", "--help"])).resolves.toContain(
      "--name <name> --email <email> --out <absolute-path>",
    );
    await expect(help(["employee", "reissue", "--help"])).resolves.toContain(
      "--email <email> --out <absolute-path>",
    );
    await expect(help(["employee", "revoke", "--help"])).resolves.toContain(
      "--email <email>",
    );
  });
});
