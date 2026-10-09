import { runPersonClientCli } from "../../src/product/person-client/composition.js";
import { describe, expect, it, vi } from "vitest";

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
  it.each([
    [["tools", "connect", "--help"], "--tool jira [--no-wait]"],
    [["tools", "status", "--help"], "--tool jira --attempt-id <value>"],
    [["tools", "cancel", "--help"], "--tool jira --attempt-id <value>"],
    [["tools", "disconnect", "--help"], "--tool jira"],
    [["ask", "--help"], "--tickets"],
    [["tools", "--help"], "echo-brain person tools [<setup|connect|disconnect|status|cancel|project|meetings> --tool <tool>"],
    [["tools", "setup", "--help"], "--tool slack [--reconnect] [--existing-app <value>] [--no-wait]"],
    [["tools", "connect", "--help"], "--method dm-code --slack-user"],
    [["tools", "status", "--help"], "--tool slack --attempt-id <value>"],
    [["login", "--help"], "--invitation <path> | --authority-url <url>"],
    [["records", "--help"], "[--limit <1-100>] [--query <text>]"],
    [["status", "--help"], "echo-brain person status"],
    [["logout", "--help"], "echo-brain person logout"],
    [["ask", "--help"], "echo-brain person ask --question <text> [--project <project-id> | --mine]"],
    [["open", "--help"], "usage: echo-brain person open --ref <ref> [--cursor <next_cursor>]"],
    [["evidence", "search", "--help"], "echo-brain person evidence search [--query <text>]"],
    [["evidence", "open", "--help"], "echo-brain person evidence open --item <citation-json>"],
    [["ask-source", "--help"], "echo-brain person ask-source --source-id <source-id>"],
    [["transcript", "--help"], "echo-brain person transcript --approval-id <id> --source-id <source-id>"],
    [["employee", "--help"], "<list|invite|reissue|revoke>"],
    [["employee", "list", "--help"], "echo-brain person employee list"],
    [["employee", "invite", "--help"], "--name <name> --email <email> --out <absolute-path>"],
    [["employee", "reissue", "--help"], "--email <email> --out <absolute-path>"],
    [["employee", "revoke", "--help"], "--email <email>"],
    // Every versioned upload and project-context command documents itself without a session.
    [["updates", "submit-v3", "--help"], "--association-project-ids-json"],
    [["updates", "status-v3", "--help"], "--request-id <uuid>"],
    [["updates", "search-v3", "--help"], "--query <text>"],
    [["documents", "upload-v2", "--help"], "--audience-project-ids-json"],
    [["documents", "status-v2", "--help"], "--request-id <uuid>"],
    [["documents", "search-v2", "--help"], "--query <text>"],
    [["documents", "download-v2", "--help"], "--document-id <id>"],
    [["projects", "search-v2", "--help"], "--query <text>"],
    [["updates", "--help"], "<submit-v3|status-v3|search|search-v3>"],
    [["documents", "--help"], "<upload-v2|status-v2|pending|retry|abandon|search-v2|download-v2|associate|dissociate>"],
    [["projects", "--help"], "<list-v2|create|read-v2|rename|archive|unarchive|leave|members|directory|member-add|member-set|member-remove|associate|dissociate|search-v2>"],
  ])("documents %j with %s", async (argv, needle) => {
    await expect(help(argv)).resolves.toContain(needle);
  });

  it("starts the Person help with usage, the model-free list, open and scoped ask", async () => {
    const text = await help(["--help"]);
    expect(text).toContain("usage: echo-brain person <command> [options]");
    expect(text).toContain("employee");
    expect(text).toContain("directory   Find people in your organization by name.");
    expect(text.indexOf("Start here:")).toBeGreaterThan(-1);
    expect(text.indexOf("Start here:")).toBeLessThan(text.indexOf("Commands:"));
    expect(text).toContain("\nlist shows only what you can read now; next_cursor means more.\n");
    expect(text).toContain("  open --ref <ref>  ");
    expect(text).toContain("  ask --question <text> [--project <project-id> | --mine]  ");
  });

  it("documents the organization directory as a single command with no project", async () => {
    const text = await help(["directory", "--help"]);
    expect(text).toContain("usage: echo-brain person directory [--query <text>] [--limit <1-10>] [--cursor <opaque-base64url>]");
    expect(text).toContain("no project is needed");
    expect(text).not.toContain("--project-id");
  });

  it("documents list without overstating what it covers", async () => {
    // An agent reads this help: it must not overstate what list covers, and must say how a waiting page fails.
    const listHelp = await help(["list", "--help"]);
    expect(listHelp).toContain("not Slack messages or shared transcripts");
    expect(listHelp).toContain("fails with unavailable (503): retry the same --cursor later");
    expect(listHelp).toContain("usage: echo-brain person list [--project <project-id> | --mine] [--cursor <next_cursor>]");
  });

  it("refuses each retired command, and its help, as unknown before any session or network use", async () => {
    const retired = [
      ["documents", "upload"], ["documents", "status"], ["documents", "read"], ["documents", "read-v2"], ["documents", "search"], ["documents", "download"],
      ["projects", "list"], ["projects", "read"], ["projects", "feed"], ["projects", "feed-v2"], ["projects", "search"], ["projects", "read-context"], ["projects", "read-context-v2"],
      ["updates", "submit"], ["updates", "status"], ["updates", "read"], ["updates", "read-v3"],
      ["slack-connect-cancel"], ["slack-link"], ["slack-connect-begin"], ["slack-connect-status"], ["slack-disconnect"],
      ["jira"], ["jira", "connect"], ["jira", "complete"], ["jira", "disconnect"],
      ["tools", "bogus"], ["readable-search"],
    ];
    for (const argv of retired.flatMap(command => [command, [...command, "--help"]])) {
      let stdout = "";
      let stderr = "";
      const network = vi.fn();
      await expect(runPersonClientCli(argv, {
        fetch: network,
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
      }), argv.join(" ")).resolves.toBe(2);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toEqual({ ok: false, error: "usage: echo-brain person <command> [options]" });
      expect(network).not.toHaveBeenCalled();
    }
  });
});
