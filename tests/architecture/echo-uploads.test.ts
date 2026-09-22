import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const root = mkdtempSync(join(tmpdir(), "echo-uploads-proof-"));
roots.push(root);
const binary = join(root, "proof");

afterAll(() => roots.forEach(path => rmSync(path, { recursive: true, force: true })));

describe.skipIf(process.platform !== "darwin")("native upload CLI boundary", () => {
  beforeAll(() => {
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors",
      "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-module-cache-path", join(root, "modules"),
      join(repo, "product/echo-overlay/ui-support.swift"), join(repo, "product/echo-overlay/account.swift"),
      join(repo, "product/echo-overlay/projects.swift"), join(repo, "product/echo-overlay/uploads.swift"), join(repo, "tests/fixtures/echo-uploads-proof.swift"), "-o", binary],
    { stdio: "pipe", timeout: 120_000 });
  }, 120_000);

  it.each(["round-trip", "snapshot-replay", "file-bounds", "parser-bounds", "recovery", "switch-before", "switch-after",
    "submit-switch-after", "unknown-submit", "oversized-read", "cancel-before", "window", "window-account-change", "window-recovery", "window-uncertain"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const script = join(folder, "client.mjs");
    const executable = join(folder, "echo-brain");
    const log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)};
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const calls = prior.filter(x => x.args[1] === 'status').length;
const member = mode === 'switch-before' || (mode.includes('switch-after') && calls > 0) ? 'mem_other' : 'mem_original';
const value = name => args[args.indexOf(name) + 1];
const entry = { args };
if (args[2] === 'submit') entry.original = fs.readFileSync(value('--file'), 'utf8');
fs.appendFileSync(log, JSON.stringify(entry)+'\\n');
if (mode === 'window-account-change' && args[2] === 'submit') await new Promise(resolve => setTimeout(resolve, 250));
const coordinates = { context_id: 'ctx_'+'b'.repeat(64), received_at: '2026-09-21T00:00:00.000Z', audience: { kind: 'only_me' } };
let result;
if (args[1] === 'status') result = { schema_version:1,kind:'echo-person-client-status-v1',signed_in:true,display_name:'Casey',membership_type:'employee',connected_authority:'https://authority.example',installed_version:'1',membership_id:member,client_build:{source_sha:'a'.repeat(40),source_kind:'materialized-commit'} };
else if ((mode === 'unknown-submit' || (mode === 'window-uncertain' && args[2] === 'submit'))) { console.error('private raw provider detail'); process.exit(1); }
else if (mode === 'oversized-read') { console.log('x'.repeat(140000)); process.exit(0); }
else if (args[1] === 'projects') { console.error(JSON.stringify({ok:false,action:'projects-list',error:'Person Authority rejected the request',code:'not_found',status:404})); process.exit(1); }
else if (args[2] === 'submit') result = { schema_version:2,kind:'echo-person-update-receipt-v2',...coordinates,request_id:value('--request-id'),audience:{kind:value('--visibility') === 'team' ? 'team' : 'only_me'},project_id:null,state:'received' };
else if (args[2] === 'status') result = { schema_version:2,kind:'echo-person-update-status-v2',...coordinates,request_id:value('--request-id'),project_id:null,status:'stored',metadata:'ready' };
else if (args[2] === 'search') result = { schema_version:2,kind:'echo-person-upload-search-v2',results:[{...coordinates,title:'Client memo',excerpt:'Original café note.'}] };
else if (args[2] === 'read') result = { schema_version:2,kind:'echo-person-upload-content-v2',...coordinates,title:'Client memo',text:'Original café note.\\nSecond line preserved.\\n' };
else process.exit(2);
console.log(JSON.stringify(result));
`);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const result = spawnSync(binary, [mode, executable, folder], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    if (["switch-before", "cancel-before"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[] });
      expect(calls.every(call => call.args[1] === "status")).toBe(true);
    }
    if (["snapshot-replay", "window-uncertain", "window"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; original?: string });
      const writes = calls.filter(call => call.args[2] === "submit");
      expect(writes).toHaveLength(mode === "window" ? 1 : 2);
      if (mode !== "window") expect(writes[0]).toEqual(writes[1]);
      expect(writes[0]?.original).toBe(`${mode === "window" ? "\t\n\t" : ""}Original café note.\nSecond line preserved.\n`);
      if (mode === "window") expect(writes[0]?.args[writes[0].args.indexOf("--title") + 1]?.normalize("NFC")).toBe("Original café note.");
    }
  });
});
