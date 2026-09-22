import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "echo-projects-proof-"));
const binary = join(root, "proof");
const fixtures = join(repo, "tests/fixtures/project-context-v1/operations.json");
const errors = join(repo, "tests/fixtures/project-context-v1/invalid.json");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== "darwin")("native project CLI boundary", () => {
  beforeAll(() => {
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors",
      "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-module-cache-path", join(root, "modules"),
      ...["ui-support", "account", "projects", "uploads"].map(name => join(repo, `product/echo-overlay/${name}.swift`)),
      join(repo, "tests/fixtures/echo-projects-proof.swift"), "-o", binary], { stdio: "pipe", timeout: 120_000 });
  }, 120_000);
  it.each(["frozen-fixtures", "strict-replies", "independent-recovery", "round-trip", "unsupported", "inaccessible", "account-clear", "uncertain-mutation", "ui-round-trip", "ui-member", "ui-access-loss"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const script = join(folder, "client.mjs");
    const executable = join(folder, "echo-brain");
    const log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const value = name => args[args.indexOf(name) + 1];
const operations = JSON.parse(fs.readFileSync(${JSON.stringify(fixtures)},'utf8')).operations;
const errors = JSON.parse(fs.readFileSync(${JSON.stringify(errors)},'utf8')).errors;
if (args[1] === 'status') {
  console.log(JSON.stringify({schema_version:1,kind:'echo-person-client-status-v1',signed_in:true,display_name:'Ari',membership_type:'employee',connected_authority:'https://authority.example',installed_version:'1',membership_id:'mem_22222222-2222-4222-8222-222222222222',client_build:{source_sha:'a'.repeat(40),source_kind:'materialized-commit'}}));
} else {
  const id = args[1]+'-'+args[2];
  if ((mode === 'unsupported' && id === 'projects-list') || (mode === 'inaccessible' && id === 'projects-read')) {
    console.error(JSON.stringify(errors.find(x => x.id === (mode === 'unsupported' ? 'unavailable-project-capability' : 'individual-project-non-disclosure')).cli)); process.exit(1);
  }
  if (mode === 'uncertain-mutation' && id === 'projects-member-set') {
    console.error(JSON.stringify({ok:false,action:id,error:'Outcome unknown',code:'outcome_unknown',mutation_outcome:'unknown',request_id:value('--request-id')})); process.exit(1);
  }
  if (mode === 'ui-access-loss' && id === 'projects-read-context') {
    console.error(JSON.stringify({...errors.find(x => x.id === 'individual-project-non-disclosure').cli,action:id})); process.exit(1);
  }
  const operation = operations.find(x => x.id === id || x.id === id+'-v2');
  if (!operation) process.exit(2);
  const response = structuredClone(operation.http.response);
  if (mode.startsWith('ui-') && id === 'projects-list') {
    response.items.push({...response.items[0],project_id:'prj_44444444-4444-4444-8444-444444444444',name:'Beacon'});
    if (mode === 'ui-member') response.items.forEach(x => x.role = 'member');
  }
  if (mode === 'ui-member' && id === 'projects-read') response.role = 'member';
  if (id === 'updates-submit') {
    response.project_id = value('--project-id');
    response.audience = {kind:'project',project_id:value('--audience-project-id')};
  }
  if (response.request_id) response.request_id = value('--request-id');
  console.log(JSON.stringify(response));
}
`);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const result = spawnSync(binary, [mode, fixtures, executable], { encoding: "utf8", timeout: 45_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    if (mode === "uncertain-mutation") {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
      const writes = calls.filter(args => args[2] === "member-set");
      expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
    }
  });
});
