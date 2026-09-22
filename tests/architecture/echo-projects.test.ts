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
  it.each(["frozen-fixtures", "strict-replies", "independent-recovery", "round-trip", "unsupported", "inaccessible", "account-clear", "uncertain-mutation", "restart-recovery", "restart-create", "malformed-recovery", "recovery-store-failure", "ui-round-trip", "ui-member", "ui-access-loss", "cli-round-trip", "cli-unsupported", "cli-inaccessible", "cli-uncertain-mutation", "cli-ui-round-trip", "switch-project", "switch-account", "pagination", "demoted", "ui-upload-rejected", "ui-upload-unknown", "cli-ui-upload-unknown", "uncertain-overflow"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const script = join(folder, "client.mjs");
    const executable = join(folder, "echo-brain");
    const log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const value = name => args[args.indexOf(name) + 1];
const calls = fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse);
const state = ${JSON.stringify(join(folder, "saved.json"))};
const operations = JSON.parse(fs.readFileSync(${JSON.stringify(fixtures)},'utf8')).operations;
const errors = JSON.parse(fs.readFileSync(${JSON.stringify(errors)},'utf8')).errors;
if (args[1] === 'status') {
  console.log(JSON.stringify({schema_version:1,kind:'echo-person-client-status-v1',signed_in:true,display_name:'Ari',membership_type:'employee',connected_authority:'https://authority.example',installed_version:'1',membership_id:mode === 'switch-account' && calls.some(x => x[2] === 'read') ? 'mem_33333333-3333-4333-8333-333333333333' : 'mem_22222222-2222-4222-8222-222222222222',client_build:{source_sha:'a'.repeat(40),source_kind:'materialized-commit'}}));
} else {
  const id = args[1]+'-'+args[2];
  if ((mode === 'unsupported' && id === 'projects-list') || (mode === 'inaccessible' && id === 'projects-read')) {
    console.error(JSON.stringify(errors.find(x => x.id === (mode === 'unsupported' ? 'unavailable-project-capability' : 'individual-project-non-disclosure')).cli)); process.exit(1);
  }
  if (mode === 'uncertain-overflow' && id === 'projects-member-set') { console.log('x'.repeat(40000)); process.exit(0); }
  if ((mode === 'uncertain-mutation' || mode === 'restart-recovery') && id === 'projects-member-set') {
    console.error(JSON.stringify({ok:false,action:id,error:'Outcome unknown',code:'outcome_unknown',mutation_outcome:'unknown',request_id:value('--request-id')})); process.exit(1);
  }
  if (mode === 'restart-create' && id === 'projects-create' && calls.filter(x => x[1] === 'projects' && x[2] === 'create').length === 1) {
    console.error(JSON.stringify({ok:false,action:id,error:'Outcome unknown',code:'outcome_unknown',mutation_outcome:'unknown',request_id:value('--request-id')})); process.exit(1);
  }
  if (mode === 'ui-access-loss' && id === 'projects-read-context') {
    console.error(JSON.stringify({...errors.find(x => x.id === 'individual-project-non-disclosure').cli,action:id})); process.exit(1);
  }
  const operation = operations.find(x => x.id === id || x.id === id+'-v2');
  if (!operation) process.exit(2);
  let response = structuredClone(operation.http.response);
  if (mode.startsWith('ui-') && id === 'projects-list') {
    response.items.push({...response.items[0],project_id:'prj_44444444-4444-4444-8444-444444444444',name:'Beacon'});
    if (mode === 'ui-member') response.items.forEach(x => x.role = 'member');
  }
  if ((mode === 'ui-member' || (mode === 'demoted' && calls.filter(x => x[2] === 'read').length > 1)) && id === 'projects-read') response.role = 'member';
  if (mode === 'switch-project' && (id === 'projects-read' || id === 'projects-feed')) response.project_id = value('--project-id');
  if (mode === 'pagination' && id === 'projects-search') {
    response.next_cursor = args.includes('--cursor') ? null : 'eyJsYXN0Ijoicm93In0';
    if (args.includes('--cursor')) response.items[0].context_id = 'ctx_' + 'b'.repeat(64);
  }
  if (id === 'updates-submit') {
    response.project_id = value('--project-id');
    response.audience = {kind:'project',project_id:value('--audience-project-id')};
  }
  if (response.request_id) response.request_id = value('--request-id');
  if (id === 'updates-submit') {
    fs.writeFileSync(state,JSON.stringify(response));
    const repeated = calls.filter(x => x[1] === 'updates' && x[2] === 'submit').length > 1;
    if (mode === 'ui-upload-rejected' || mode === 'ui-upload-unknown') {
      const unknown = mode === 'ui-upload-unknown' && !repeated;
      console.error(JSON.stringify({ok:false,action:id,error:'Request failed',code:unknown ? 'outcome_unknown' : repeated ? 'conflict' : 'not_found',status:unknown ? 503 : repeated ? 409 : 404,mutation_outcome:unknown ? 'unknown' : 'not_submitted',request_id:value('--request-id')})); process.exit(1);
    }
  }
  if (id === 'updates-status' && fs.existsSync(state)) {
    response = {...JSON.parse(fs.readFileSync(state,'utf8')),kind:'echo-person-update-status-v2',status:'stored',metadata:'ready'}; delete response.state;
  }
  console.log(JSON.stringify(response));
}
`);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    if (mode.startsWith("cli-")) {
      const bridge = join(repo, "tests/fixtures/echo-projects-cli-bridge.mjs");
      const quoted = [process.execPath, bridge, mode, folder, log].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
      writeFileSync(executable, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700 });
    }
    const result = spawnSync(binary, [mode, fixtures, executable], { encoding: "utf8", timeout: 90_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    if (mode === "uncertain-mutation" || mode === "cli-uncertain-mutation" || mode === "uncertain-overflow") {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => (mode.startsWith("cli-") ? JSON.parse(line).args : JSON.parse(line)) as string[]);
      const writes = calls.filter(args => args[2] === "member-set");
      expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
    }
    if (mode === "restart-create") {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
      const writes = calls.filter(args => args[2] === "create");
      expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
    }
    if (mode === "cli-ui-round-trip") {
      const calls = readFileSync(join(folder, "http.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; body?: Record<string, unknown> });
      const save = calls.find(call => call.path === "/v2/person/updates" && call.body?.text);
      expect(save?.body).toMatchObject({ text: "We agreed to ship.\n", project_id: "prj_44444444-4444-4444-8444-444444444444", audience: { kind: "project", project_id: "prj_11111111-1111-4111-8111-111111111111" } });
      expect(calls.some(call => call.path.includes("ask") || call.path === "/v1/person/updates")).toBe(false);
    }
  }, 120_000);
});
