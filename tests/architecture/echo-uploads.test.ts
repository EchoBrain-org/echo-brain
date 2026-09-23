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

  it.each(["round-trip", "multi-project", "snapshot-replay", "file-bounds", "parser-bounds", "recovery", "switch-before", "switch-after",
    "submit-switch-after", "unknown-submit", "oversized-read", "cancel-before", "window", "window-account-change", "window-recovery", "window-uncertain", "window-stranded"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const script = join(folder, "client.mjs");
    const executable = join(folder, "echo-brain");
    const log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)};
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const calls = prior.filter(x => x.args[1] === 'status').length;
const member = mode === 'switch-before' || (mode.includes('switch-after') && calls > 0) || (mode === 'window-stranded' && prior.some(x => ['submit','submit-v3'].includes(x.args[2]))) ? 'mem_other' : 'mem_original';
const value = name => args[args.indexOf(name) + 1];
const entry = { args };
if (['submit','submit-v3'].includes(args[2])) entry.original = fs.readFileSync(value('--file'), 'utf8');
fs.appendFileSync(log, JSON.stringify(entry)+'\\n');
if (mode === 'window-account-change' && ['submit','submit-v3'].includes(args[2])) await new Promise(resolve => setTimeout(resolve, 250));
const coordinates = { context_id: 'ctx_'+'b'.repeat(64), received_at: '2026-09-21T00:00:00.000Z', audience: { kind: 'only_me' } };
let result;
if (args[1] === 'status') result = { schema_version:1,kind:'echo-person-client-status-v1',signed_in:true,display_name:'Casey',membership_type:'employee',connected_authority:'https://authority.example',installed_version:'1',membership_id:member,client_build:{source_sha:'a'.repeat(40),source_kind:'materialized-commit'} };
else if ((mode === 'unknown-submit' || (mode === 'window-uncertain' && ['submit','submit-v3'].includes(args[2])))) { console.error('private raw provider detail'); process.exit(1); }
else if (mode === 'oversized-read') { console.log('x'.repeat(140000)); process.exit(0); }
else if (args[1] === 'projects') { console.error(JSON.stringify({ok:false,action:'projects-list',error:'Person Authority rejected the request',code:'not_found',status:404})); process.exit(1); }
else if (args[2] === 'submit-v3' || args[2] === 'status-v3') result = { schema_version:3,kind: args[2] === 'submit-v3' ? 'echo-person-update-receipt-v3' : 'echo-person-update-status-v3',...coordinates,request_id:value('--request-id'),audience: mode === 'multi-project' ? {kind:'projects',project_ids:['prj_11111111-1111-4111-8111-111111111111','prj_22222222-2222-4222-8222-222222222222']} : {kind:'only_me'},association_project_ids:mode === 'multi-project' ? ['prj_11111111-1111-4111-8111-111111111111','prj_22222222-2222-4222-8222-222222222222'] : [],...(args[2] === 'submit-v3' ? {state:'received'} : {status:'stored',metadata:'ready'}) };
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
    if (mode === "window-stranded") {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[] });
      // One save; nothing retried it under the other account.
      expect(calls.filter(call => ["submit", "submit-v3"].includes(call.args[2]))).toHaveLength(1);
      expect(calls.some(call => call.args[2] === "status" && call.args[1] === "updates")).toBe(false);
    }
    if (["snapshot-replay", "window-uncertain", "window"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; original?: string });
      const writes = calls.filter(call => ["submit", "submit-v3"].includes(call.args[2]));
      // "window" sends a second note (then leaves "Saved" with Escape).
      expect(writes).toHaveLength(2);
      if (mode !== "window") expect(writes[0]).toEqual(writes[1]);
      expect(writes[0]?.original).toBe(`${mode === "window" ? "\t\n\t" : ""}Original café note.\nSecond line preserved.\n`);
      if (mode === "window") {
        // The compose sheet has no title field: the title is the first non-empty
        // line, and sharing defaults to Only me after the separate content page.
        expect(writes[0]?.args[writes[0].args.indexOf("--title") + 1]?.normalize("NFC")).toBe("Original café note.");
        expect(writes[0]?.args[writes[0].args.indexOf("--audience") + 1]).toBe("only-me");
        expect(writes[0]?.args.some(arg => arg === "--project-id" || arg === "--audience-project-id")).toBe(false);
        // The home bar is now Ask. Saved originals still have direct client
        // parser/read coverage in the round-trip fixture, but this UI path
        // must not quietly revive the removed browse/search route.
        expect(calls.some(call => call.args[1] === "updates" && ["search", "read"].includes(call.args[2]))).toBe(false);
      }
    }
  });
});
