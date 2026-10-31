import { runPersonClientCli } from "../../src/product/person-client/composition.js";
import type { PersonToolProviderV1 } from "@echo-brain/organization-api";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";

// Help and refusals never reach the store, but they still run against a home of their own.
const home = mkdtempSync(join(tmpdir(), "echo-person-help-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function run(argv: readonly string[], tool_providers?: readonly PersonToolProviderV1[]) {
  let stdout = "";
  let stderr = "";
  const network = vi.fn();
  const code = await runPersonClientCli(argv, {
    home_directory: home,
    fetch: network,
    ...(tool_providers === undefined ? {} : { tool_providers }),
    stdout: { write: (value) => ((stdout += String(value)), true) },
    stderr: { write: (value) => ((stderr += String(value)), true) },
  });
  return { code, stdout, stderr, network };
}

async function help(argv: readonly string[]): Promise<string> {
  const { code, stdout, stderr } = await run(argv);
  expect({ code, stderr }, argv.join(" ")).toEqual({ code: 0, stderr: "" });
  return stdout;
}

/** Every action the CLI dispatches, read from its RULES, so that no command can go without help. */
function dispatchedActions(): string[] {
  const path = join(import.meta.dirname, "../../src/product/person-client/commands.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const rules = source.statements.filter(ts.isVariableStatement).flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => declaration.name.getText(source) === "RULES")?.initializer;
  if (rules === undefined || !ts.isObjectLiteralExpression(rules)) throw new Error("commands.ts no longer declares RULES");
  return rules.properties.map((property) => (property.name as ts.Identifier | ts.StringLiteral).text);
}
const GROUPS = ["documents", "projects", "updates", "evidence", "employee"];
/** `projects-read-v2` is typed `projects read-v2`; any other action is one word. */
function command(action: string): string[] {
  const group = GROUPS.find((name) => action.startsWith(`${name}-`));
  return group === undefined ? [action] : [group, action.slice(group.length + 1)];
}
/** The commands a usage line names as `<one|two|three>`. */
const named = (usage: string) => /<([a-z0-9|-]+)>/.exec(usage)?.[1]?.split("|").sort();
/** The command each line under the top-level help's `Commands:` heading names. */
const listed = (usage: string) => /\nCommands:\n((?: {2}\S.*\n)+)/.exec(usage)?.[1]?.trimEnd().split("\n").map((line) => line.trim().split(" ")[0]).sort();

describe("Person client help", () => {
  it("documents every dispatched command, lists each top-level one, and each group names exactly its commands", async () => {
    const actions = dispatchedActions();
    expect(actions).toEqual(expect.arrayContaining(["login", "ask", "list", "projects-read-v2", "employee-invite"]));
    const top = await help(["--help"]);
    expect(top).toMatch(/^usage: echo-brain person <command> \[options\]\n/);
    expect(listed(top)).toEqual([...new Set(actions.map((action) => command(action)[0]))].sort());
    for (const action of actions) {
      expect(await help([...command(action), "--help"]), action).toMatch(/^usage: echo-brain person /);
    }
    for (const group of GROUPS) {
      expect(named(await help([group, "--help"])), group).toEqual(actions.filter((action) => action.startsWith(`${group}-`)).map((action) => command(action)[1]).sort());
    }
  });

  it("builds each tool verb's help from the registered tools", async () => {
    for (const verb of named(await help(["tools", "--help"])) ?? []) {
      expect(await help(["tools", verb, "--help"])).toMatch(new RegExp(`^usage: echo-brain person tools ${verb} --tool <tool> \\[options\\]\\n`));
    }
    const tool: PersonToolProviderV1 = { tool_id: "fixture", verbs: { connect: { description: "Connects the fixture.", requires: ["account"],
      options: { account: { type: "string" }, wait: { type: "boolean" } }, run: async () => undefined } } };
    expect(await run(["tools", "connect", "--help"], [tool])).toMatchObject({ code: 0, stderr: "",
      stdout: "usage: echo-brain person tools connect --tool <tool> [options]\n\n  --tool fixture --account <value> [--wait]\n      Connects the fixture.\n" });
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
    expect(listHelp).toContain("the notes, documents, imported meetings and approved meetings ask can read;");
    expect(listHelp).toContain("fails with unavailable (503): retry the same --cursor later");
    expect(listHelp).toContain("usage: echo-brain person list [--project <project-id> | --mine | --only-me] [--cursor <next_cursor>]");
    expect(listHelp).toContain("--only-me lists everything only you can read, filed in a project or not");
  });

  it("refuses an unknown command, group command or tool verb, and its help, before any session or network use", async () => {
    // Retired commands are refused only because RULES no longer has them; these reach that refusal each way.
    for (const argv of [["readable-search"], ["documents", "upload"], ["tools", "bogus"]].flatMap((name) => [name, [...name, "--help"]])) {
      const { code, stdout, stderr, network } = await run(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toEqual({ ok: false, error: "usage: echo-brain person <command> [options]" });
      expect(network).not.toHaveBeenCalled();
    }
  });
});
