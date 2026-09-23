import { runPersonClientCli } from "../../src/product/person-client/composition.js";
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
    await expect(help(["--help"])).resolves.toContain("ask");
    await expect(help(["--help"])).resolves.toContain("start");
  });

  it("documents sign-in, reads, session commands, and nested employee commands", async () => {
    await expect(help(["tools", "--help"])).resolves.toContain("echo-brain person tools");
    await expect(help(["slack-link", "--help"])).resolves.toContain("echo-brain person slack-link");
    await expect(help(["start", "--help"])).resolves.toContain(
      "echo-brain person start --invitation <path>",
    );
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
    await expect(help(["ask", "--help"])).resolves.toContain(
      "echo-brain person ask --question <text> [--project <project-id>]",
    );
    await expect(help(["ask-source", "--help"])).resolves.toContain(
      "echo-brain person ask-source --source-id <source-id>",
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

  it("documents every versioned upload and project-context command without a session", async () => {
    const modern = [
      ["updates", "submit-v3", "--help", "--association-project-ids-json"],
      ["updates", "status-v3", "--help", "--request-id <uuid>"],
      ["updates", "read-v3", "--help", "--context-id <id>"],
      ["updates", "search-v3", "--help", "--query <text>"],
      ["documents", "upload-v2", "--help", "--audience-project-ids-json"],
      ["documents", "status-v2", "--help", "--request-id <uuid>"],
      ["documents", "read-v2", "--help", "--document-id <id>"],
      ["documents", "search-v2", "--help", "--query <text>"],
      ["documents", "download-v2", "--help", "--document-id <id>"],
      ["projects", "feed-v2", "--help", "--project-id <project-id>"],
      ["projects", "search-v2", "--help", "--query <text>"],
      ["projects", "read-context-v2", "--help", "--context-id <context-id>"],
    ] as const;
    for (const [parent, action, flag, required] of modern) {
      await expect(help([parent, action, flag])).resolves.toContain(required);
    }
    await expect(help(["updates", "--help"])).resolves.toContain("submit-v3|status|status-v3|search|search-v3|read|read-v3");
    await expect(help(["documents", "--help"])).resolves.toContain("upload|upload-v2|status|status-v2");
    await expect(help(["projects", "--help"])).resolves.toContain("feed|feed-v2|search|search-v2|read-context|read-context-v2");
  });
});
