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
  it.each(["frozen-fixtures", "strict-replies", "independent-recovery", "round-trip", "unsupported", "inaccessible", "account-clear", "uncertain-mutation", "restart-recovery", "restart-create", "malformed-recovery", "recovery-store-failure", "ui-round-trip", "ui-member", "ui-access-loss", "cli-round-trip", "cli-unsupported", "cli-inaccessible", "cli-uncertain-mutation", "cli-ui-round-trip", "switch-project", "switch-account", "pagination", "demoted", "ui-upload-rejected", "ui-upload-unknown", "cli-ui-upload-unknown", "uncertain-overflow", "ui-people", "ui-associate", "ui-recovery", "ui-recovery-pending", "ui-create", "ui-create-skip", "ui-create-read-fail", "ui-create-account", "ui-drop", "ui-search-controls", "ui-documents"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const script = join(folder, "client.mjs");
    const executable = join(folder, "echo-brain");
    const log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  // The created project's first read fails once, after a valid create receipt.
  if (mode === 'ui-create-read-fail' && id === 'projects-read' && calls.filter(x => x[1] === 'projects' && x[2] === 'read').length === 1) {
    console.error(JSON.stringify({ok:false,action:id,error:'Unavailable',code:'unavailable',status:503})); process.exit(1);
  }
  const listedDocument={schema_version:1,kind:'echo-person-document-metadata-v1',request_id:'11111111-1111-4111-8111-111111111111',document_id:'doc_'+'d'.repeat(64),filename:'Robot PRD.pdf',title:'Robot PRD',content_length:12000,sha256:'sha256:'+'a'.repeat(64),audience:{kind:'project',project_id:value('--project-id')},project_id:value('--project-id'),detected_media_type:'application/pdf',received_at:'2026-09-21T00:00:00.000Z',state:'saved',extraction_state:'ready',extraction_detail:null,extractor:'fixture-v1',extracted_text_bytes:21};
  if (id === 'documents-search') { console.log(JSON.stringify({ok:true,result:{schema_version:1,kind:'echo-person-document-search-result-v1',documents:mode==='ui-documents'?[{...listedDocument,excerpt:'First page',anchor:{kind:'page',start:1}}]:[],next_cursor:null}})); process.exit(0); }
  if (id === 'documents-read' && mode==='ui-documents') {
    const next=args.includes('--cursor'); console.log(JSON.stringify({ok:true,result:{metadata:listedDocument,text:{schema_version:1,kind:'echo-person-document-text-v1',document_id:listedDocument.document_id,original_sha256:listedDocument.sha256,extractor:listedDocument.extractor,extraction_state:'ready',chunks:[{ordinal:next?1:0,anchor_kind:'page',anchor_start:next?2:1,text:next?'Second page':'First page'}],next_cursor:next?null:'Mg'}}}));process.exit(0);
  }
  if (id === 'documents-upload' || id === 'documents-status') {
    let document;
    if (id === 'documents-upload') {
      const bytes = fs.readFileSync(value('--file'));
      document = {schema_version:1,kind:'echo-person-document-receipt-v1',request_id:value('--request-id'),document_id:'doc_'+'c'.repeat(64),filename:value('--file').split('/').pop(),title:value('--title'),content_length:bytes.length,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),audience:{kind:'project',project_id:value('--audience-project-id')},project_id:value('--project-id'),detected_media_type:'text/plain',received_at:'2026-09-21T00:00:00.000Z',state:'saved',extraction_state:'extracting'};
      fs.writeFileSync(state,JSON.stringify(document));
      if (['ui-create','ui-create-skip','ui-create-account'].includes(mode) && calls.filter(x=>x[1]==='documents'&&x[2]==='upload').length===1) {
        const unknown=mode!=='ui-create-skip';console.error(JSON.stringify({ok:false,action:id,error:'Request failed',code:unknown?'outcome_unknown':'invalid_request',status:unknown?503:400,mutation_outcome:unknown?'unknown':'not_submitted',request_id:value('--request-id')}));process.exit(1);
      }
    } else document = {...JSON.parse(fs.readFileSync(state,'utf8')),kind:'echo-person-document-metadata-v1',extraction_state:'ready',extraction_detail:null,extractor:'fixture-v1',extracted_text_bytes:12};
    console.log(JSON.stringify({ok:true,result:document}));process.exit(0);
  }
  const operation = operations.find(x => x.id === id || x.id === id+'-v2');
  if (!operation) process.exit(2);
  let response = structuredClone(operation.http.response);
  const beacon = 'prj_44444444-4444-4444-8444-444444444444';
  if (mode.startsWith('ui-') && id === 'projects-list') {
    response.items.push({...response.items[0],project_id:beacon,name:'Beacon'});
    if (mode === 'ui-member') response.items.forEach(x => x.role = 'member');
  }
  // UI modes: every scoped reply names the project the command asked for.
  if (mode.startsWith('ui-') && args.includes('--project-id') && 'project_id' in response) {
    response.project_id = value('--project-id');
    if (id === 'projects-read') response.name = response.project_id === beacon ? 'Beacon' : 'Apollo';
  }
  if (mode.startsWith('ui-') && ['projects-associate', 'projects-dissociate'].includes(id)) response.context_id = value('--context-id');
  if (mode.startsWith('ui-') && ['projects-member-set', 'projects-member-remove'].includes(id)) response.membership_id = value('--membership-id');
  // The viewer (Ari) plus Bea, so a lead has someone else to manage.
  if (['ui-round-trip', 'ui-people', 'ui-member'].includes(mode) && id === 'projects-members' && !calls.some(x => x[2] === 'member-remove')) {
    response.items.push({membership_id:'mem_33333333-3333-4333-8333-333333333333',display_name:'Bea',role:'member'});
  }
  if (mode === 'ui-people' && id === 'projects-directory') {
    response.items = [{membership_id:'mem_55555555-5555-4555-8555-555555555555',display_name:'Cleo'}];
  }
  if ((mode === 'ui-member' || (mode === 'demoted' && calls.filter(x => x[2] === 'read').length > 1)) && id === 'projects-read') response.role = 'member';
  if (mode === 'switch-project' && (id === 'projects-read' || id === 'projects-feed')) response.project_id = value('--project-id');
  if (mode === 'pagination' && id === 'projects-search') {
    response.next_cursor = args.includes('--cursor') ? null : 'eyJsYXN0Ijoicm93In0';
    if (args.includes('--cursor')) response.items[0].context_id = 'ctx_' + 'b'.repeat(64);
  }
  if (mode === 'pagination' && id === 'projects-list') {
    response.next_cursor = args.includes('--cursor') ? null : 'eyJsYXN0Ijoicm93In0';
    if (args.includes('--cursor')) response.items = [{...response.items[0],project_id:beacon,name:'Beacon'}];
  }
  if (mode === 'pagination' && id === 'projects-members') {
    response.next_cursor = args.includes('--cursor') ? null : 'eyJsYXN0Ijoicm93In0';
    if (args.includes('--cursor')) response.items = [{membership_id:'mem_33333333-3333-4333-8333-333333333333',display_name:'Bea',role:'member'}];
  }
  if (id === 'updates-submit') {
    const visibility = value('--visibility');
    response.project_id = args.includes('--project-id') ? value('--project-id') : null;
    response.audience = visibility === 'project' ? {kind:'project',project_id:value('--audience-project-id')} : {kind:visibility === 'team' ? 'team' : 'only_me'};
  }
  if (response.request_id) response.request_id = value('--request-id');
  if (id === 'updates-submit') {
    fs.writeFileSync(state,JSON.stringify(response));
    const repeated = calls.filter(x => x[1] === 'updates' && x[2] === 'submit').length > 1;
    const submitted = calls.filter(x => x[1] === 'updates' && x[2] === 'submit').length;
    // New project files: the first save's outcome is unknown (ui-create) or
    // canonically rejected (ui-create-skip); later saves succeed.
    if (['ui-create', 'ui-create-skip', 'ui-create-account'].includes(mode) && submitted === 1) {
      const unknown = mode !== 'ui-create-skip';
      console.error(JSON.stringify({ok:false,action:id,error:'Request failed',code:unknown ? 'outcome_unknown' : 'invalid_request',status:unknown ? 503 : 400,mutation_outcome:unknown ? 'unknown' : 'not_submitted',request_id:value('--request-id')})); process.exit(1);
    }
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
    if (mode.includes("ui-")) {
      // The UI proofs drive the window; the CLI log shows what actually ran.
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => (mode.startsWith("cli-") ? JSON.parse(line).args : JSON.parse(line)) as string[]);
      const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
      const apollo = "prj_11111111-1111-4111-8111-111111111111", beacon = "prj_44444444-4444-4444-8444-444444444444";
      const context = "ctx_" + "a".repeat(64);
      const op = (name: string) => calls.filter(args => args[1] === "projects" && args[2] === name);
      const submits = calls.filter(args => (args[1] === "updates" && args[2] === "submit") || (args[1] === "documents" && args[2] === "upload"));
      const roundTrip = ["ui-round-trip", "cli-ui-round-trip", "ui-member", "ui-access-loss", "ui-upload-rejected", "ui-upload-unknown", "cli-ui-upload-unknown"].includes(mode);
      if (roundTrip) {
        // The project-page bar ran the scoped project search, not global Ask.
        expect(calls.some(args => args[1] === "projects" && args[2] === "search" && flag(args, "--project-id") === apollo && flag(args, "--query") === "ship")).toBe(true);
        expect(submits).toHaveLength(mode === "ui-member" || mode === "ui-access-loss" ? 0 : mode.endsWith("ui-upload-unknown") ? 2 : mode === "ui-round-trip" ? 3 : 1);
        // One To choice (Apollo) maps to audience = association = Apollo, and
        // the title comes from the first non-empty line.
        for (const args of mode === "ui-round-trip" ? submits.slice(0, 1) : submits) {
          expect(flag(args, args[1] === "documents" ? "--audience" : "--visibility")).toBe("project");
          expect(flag(args, "--audience-project-id")).toBe(apollo);
          expect(flag(args, "--project-id")).toBe(apollo);
          expect(flag(args, "--title")).toBe("We agreed to ship.");
        }
        // Retry same save replays the identical write (same request id).
        if (mode.endsWith("ui-upload-unknown")) expect(submits[0]).toEqual(submits[1]);
      }
      if (mode === "ui-round-trip") {
        // Choosing Only me inside Apollo sends only-me with no project at
        // all; choosing Organization sends team with no project at all.
        expect(flag(submits[1], "--visibility")).toBe("only-me");
        expect(flag(submits[2], "--visibility")).toBe("team");
        for (const args of submits.slice(1)) expect(args.some(arg => arg === "--project-id" || arg === "--audience-project-id")).toBe(false);
        expect(new Set(submits.map(args => flag(args, "--request-id"))).size).toBe(3);
      }
      if (mode === "ui-search-controls") {
        // Clearing a search and Escape (field editor, window) each brought
        // the feed back; a search and a click made during a load still ran.
        const scoped = calls.filter(args => args[1] === "projects" && ["search", "feed", "read-context"].includes(args[2]));
        const searches = scoped.filter(args => args[2] === "search").map(args => flag(args, "--query"));
        expect(searches).toEqual(["ship", "ship", "late"]);
        scoped.forEach((args, index) => {
          if (args[2] === "search" && flag(args, "--query") === "ship") expect(scoped[index + 1]?.[2]).toBe("feed");
        });
        expect(op("read-context").length).toBeGreaterThanOrEqual(2);
        expect(submits).toHaveLength(0);
      }
      if (mode === "ui-member" || mode.startsWith("ui-recovery") || mode === "ui-drop") expect(op("member-set").length + op("member-remove").length).toBe(0);
      if (mode === "ui-people") {
        // Only confirmed changes ran, each on the person the alert named;
        // a cancelled alert and an alert left open across concealment ran nothing.
        expect(op("directory").map(args => flag(args, "--query"))).toEqual(["cleo"]);
        expect(op("member-set").map(args => [flag(args, "--project-id"), flag(args, "--membership-id"), flag(args, "--role")]))
          .toEqual([[apollo, "mem_55555555-5555-4555-8555-555555555555", "member"]]);
        expect(op("member-remove").map(args => [flag(args, "--project-id"), flag(args, "--membership-id")]))
          .toEqual([[apollo, "mem_33333333-3333-4333-8333-333333333333"]]);
        // Each change re-read the roster.
        const after = (name: string) => calls.slice(calls.findIndex(args => args[2] === name) + 1);
        expect(after("member-set").some(args => args[2] === "members")).toBe(true);
        expect(after("member-remove").some(args => args[2] === "members")).toBe(true);
      }
      if (mode === "ui-associate") {
        // "Add to project" associated the read original with Beacon only;
        // "Remove from this project" dissociated it from the open Beacon.
        expect(op("associate").map(args => [flag(args, "--project-id"), flag(args, "--context-id")])).toEqual([[beacon, context]]);
        expect(op("dissociate").map(args => [flag(args, "--project-id"), flag(args, "--context-id")])).toEqual([[beacon, context]]);
        expect(calls.findIndex(args => args[2] === "associate")).toBeLessThan(calls.findIndex(args => args[2] === "dissociate"));
        expect(submits).toHaveLength(0);
      }
      if (mode.startsWith("ui-recovery")) expect(op("create")).toHaveLength(0);
      if (mode === "ui-create") {
        // One save at a time: the second file waited until the first was
        // reconciled, then saved with its own request id to the new project.
        expect(op("create")).toHaveLength(1);
        expect(submits).toHaveLength(2);
        expect(calls.findIndex(args => args[2] === "status")).toBeLessThan(calls.lastIndexOf(submits[1]));
        expect(new Set(submits.map(args => flag(args, "--request-id"))).size).toBe(2);
        for (const args of submits) {
          expect(flag(args, args[1] === "documents" ? "--audience" : "--visibility")).toBe("project");
          expect(flag(args, "--audience-project-id")).toBe(apollo);
          expect(flag(args, "--project-id")).toBe(apollo);
        }
        expect(submits.map(args => flag(args, "--title"))).toEqual(["Alpha", "Beta"]);
      }
      if (mode === "ui-create-skip") {
        expect(op("create")).toHaveLength(1);
        expect(submits.map(args => flag(args, "--title"))).toEqual(["Alpha", "Beta"]);
        expect(new Set(submits.map(args => flag(args, "--request-id"))).size).toBe(2);
      }
      if (mode === "ui-create-account") {
        // The queue stopped on the unconfirmed first file; the account change
        // started nothing more.
        expect(op("create")).toHaveLength(1);
        expect(submits).toHaveLength(1);
      }
      if (mode === "ui-create-read-fail") {
        // The receipt confirmed the create: a failed reopen never leads to a
        // second create, only a re-read of the same project.
        expect(op("create")).toHaveLength(1);
        expect(op("read").map(args => flag(args, "--project-id"))).toEqual([apollo, apollo]);
      }
      if (mode === "ui-drop") expect(submits).toHaveLength(0);
    }
    if (mode === "cli-ui-round-trip") {
      const calls = readFileSync(join(folder, "http.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; body?: Record<string, unknown> });
      const save = calls.find(call => call.path === "/v2/person/updates" && call.body?.text);
      expect(save?.body).toMatchObject({ text: "We agreed to ship.\n", project_id: "prj_11111111-1111-4111-8111-111111111111", audience: { kind: "project", project_id: "prj_11111111-1111-4111-8111-111111111111" } });
      expect(calls.some(call => call.path.includes("ask") || call.path === "/v1/person/updates")).toBe(false);
    }
  }, 120_000);
});
