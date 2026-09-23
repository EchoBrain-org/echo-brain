import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "echo-documents-proof-"));
const binary = join(root, "proof");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== "darwin")("native document custody and bounded reader", () => {
  beforeAll(() => {
    execFileSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "-warnings-as-errors",
      "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-module-cache-path", join(root, "modules"),
      ...["ui-support", "account", "projects", "uploads"].map(file => join(repo, `product/echo-overlay/${file}.swift`)),
      join(repo, "tests/fixtures/echo-documents-proof.swift"), "-o", binary], { stdio: "pipe", timeout: 120_000 });
  }, 120_000);
  it.each(["snapshot", "bounds", "modern-recovery", "parser", "failures", "recovery", "minimal-saved", "restart-retry", "abandon", "association-retry", "round-trip", "unknown-retry", "retry-rejected-after-unknown", "pagination", "document-search-pages", "dissociation-project-scope", "download"])("handles %s", mode => {
    const folder = mkdtempSync(join(root, "case-"));
    const executable = join(folder, "echo-brain"), script = join(folder, "client.mjs"), log = join(folder, "calls.jsonl");
    writeFileSync(script, `import fs from 'node:fs';
import { createHash } from 'node:crypto';
const args=process.argv.slice(2), mode=${JSON.stringify(mode)}, log=${JSON.stringify(log)};
const flag=name=>args[args.indexOf(name)+1];
const prior=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const entry={args}; if(args[2]==='upload') entry.original=fs.readFileSync(flag('--file')).toString('base64');
fs.appendFileSync(log,JSON.stringify(entry)+'\\n');
if(args[1]==='status') { console.log(JSON.stringify({schema_version:1,kind:'echo-person-client-status-v1',signed_in:true,display_name:'Casey',membership_type:'employee',connected_authority:'https://authority.example',installed_version:'1',membership_id:'mem_original',client_build:{source_sha:'a'.repeat(40),source_kind:'materialized-commit'}})); process.exit(0); }
const bytes=fs.readFileSync(${JSON.stringify(join(folder, "Robot PRD.pdf"))});
const original=args[2]==='upload'?fs.readFileSync(flag('--file')):bytes;
const metadata={schema_version:1,kind:'echo-person-document-metadata-v1',request_id:['upload','retry'].includes(args[2])?flag('--request-id'):'11111111-1111-4111-8111-111111111111',document_id:'doc_'+'d'.repeat(64),filename:'Robot PRD.pdf',title:'Robot PRD',content_length:original.length,sha256:'sha256:'+createHash('sha256').update(original).digest('hex'),audience:{kind:'only_me'},project_id:null,detected_media_type:'application/pdf',received_at:'2026-09-23T00:00:00.000Z',state:'saved',extraction_state:'ready',extraction_detail:null,extractor:'fixture-v1',extracted_text_bytes:26};
if(['search-v2','read-v2','download-v2'].includes(args[2])) { delete metadata.project_id; metadata.schema_version=2; metadata.kind='echo-person-document-metadata-v2'; metadata.association_project_ids=args.includes('--project-id')?[flag('--project-id')]:[]; }
let result;
if(['upload','retry'].includes(args[2])) {
 if(mode==='unknown-retry'&&!prior.some(x=>x.args[2]==='upload')) { console.error(JSON.stringify({ok:false,action:'documents-upload',error:'Outcome unknown',code:'outcome_unknown',request_id:flag('--request-id'),mutation_outcome:'unknown'})); process.exit(1); }
 if(mode==='retry-rejected-after-unknown'&&!prior.some(x=>x.args[2]==='upload')) { console.error(JSON.stringify({ok:false,action:'documents-upload',error:'Outcome unknown',code:'outcome_unknown',request_id:flag('--request-id'),mutation_outcome:'unknown'})); process.exit(1); }
 if(mode==='retry-rejected-after-unknown') { console.error(JSON.stringify({ok:false,action:'documents-upload',error:'Rejected',code:'invalid_request',status:400,request_id:flag('--request-id'),mutation_outcome:'not_submitted'})); process.exit(1); }
 const {extraction_detail,extractor,extracted_text_bytes,...receipt}=metadata;result={...receipt,kind:'echo-person-document-receipt-v1',extraction_state:'extracting'};
} else if(args[2]==='abandon') result={schema_version:1,kind:'echo-person-document-abandoned-v1',request_id:flag('--request-id'),local_snapshot_removed:true,authority_outcome:'unchanged'};
else if(['associate','dissociate'].includes(args[2])) {
 if(mode==='association-retry'&&!prior.some(x=>x.args[2]==='associate')) { console.error(JSON.stringify({ok:false,action:'documents-associate',error:'Outcome unknown',code:'outcome_unknown',request_id:flag('--request-id'),mutation_outcome:'unknown'})); process.exit(1); }
 result={schema_version:1,kind:'echo-person-document-association-receipt-v1',request_id:flag('--request-id'),document_id:flag('--document-id'),project_id:flag('--project-id'),operation:args[2],received_at:'2026-09-23T00:00:00.000Z',state:'applied'};
} else if(args[2]==='search-v2') {
 const scoped=(suffix)=>({...metadata,document_id:'doc_'+suffix.repeat(64),filename:suffix+'.pdf',sha256:'sha256:'+suffix.repeat(64),audience:{kind:'project',project_id:flag('--project-id')},association_project_ids:[flag('--project-id')],excerpt:'First page',anchor:{kind:'page',start:1}});
 if(mode==='document-search-pages') result={schema_version:2,kind:'echo-person-document-search-result-v2',documents:args.includes('--cursor')?[scoped('b')]:'0123456789'.split('').map((_,index)=>scoped(index === 0 ? 'a' : String(index))),next_cursor:args.includes('--cursor')?null:'Y3Vyc29yMQ'};
 else if(mode==='dissociation-project-scope') result={schema_version:2,kind:'echo-person-document-search-result-v2',documents:prior.some(x=>x.args[2]==='dissociate')?[]:[scoped('d')],next_cursor:null};
 else result={schema_version:2,kind:'echo-person-document-search-result-v2',documents:[{...metadata,excerpt:'First page',anchor:{kind:'page',start:1}}],next_cursor:null};
}
else if(args[2]==='read-v2') { const next=args.includes('--cursor'); result={metadata,text:{schema_version:1,kind:'echo-person-document-text-v1',document_id:metadata.document_id,original_sha256:metadata.sha256,extractor:metadata.extractor,extraction_state:'ready',chunks:[{ordinal:next?1:0,anchor_kind:'page',anchor_start:next?2:1,text:next?'Second page':'First page'}],next_cursor:next?null:'Mg'}}; }
else if(args[2]==='download-v2') { fs.writeFileSync(flag('--out'),original);result={document_id:metadata.document_id,output_path:flag('--out'),content_length:original.length,sha256:metadata.sha256}; }
else process.exit(2);
console.log(JSON.stringify({ok:true,result}));
`);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const result = spawnSync(binary, [mode, executable, folder], { encoding: "utf8", timeout: 45_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    if (["pagination", "download"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[] });
      for (const { args } of calls.filter(call => ["read-v2", "download-v2"].includes(call.args[2]))) {
        expect(args[args.indexOf("--project-id") + 1]).toBe("prj_11111111-1111-4111-8111-111111111111");
      }
    }
    if (["restart-retry", "abandon", "association-retry"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[] });
      const changes = calls.filter(call => ["retry", "abandon", "associate"].includes(call.args[2]));
      expect(changes).toHaveLength(mode === "association-retry" ? 2 : 1);
      if (mode === "association-retry") expect(changes[0]).toEqual(changes[1]);
      for (const { args } of changes) {
        expect(args).not.toContain("--file");
        expect(args[args.indexOf("--expected-membership-id") + 1]).toBe("mem_original");
        expect(args[args.indexOf("--expected-authority") + 1]).toBe("https://authority.example");
      }
    }
    if (["round-trip", "unknown-retry"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; original?: string });
      const uploads = calls.filter(call => call.args[2] === "upload");
      expect(uploads).toHaveLength(2); expect(uploads[0]).toEqual(uploads[1]);
      expect(uploads[0].args[uploads[0].args.indexOf("--expected-membership-id") + 1]).toBe("mem_original");
      expect(uploads[0].args[uploads[0].args.indexOf("--expected-authority") + 1]).toBe("https://authority.example");
      expect(Buffer.from(uploads[0].original!, "base64")).toEqual(Buffer.from([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x37,0x0a,0xff,0,0xfe]));
    }
    if (["document-search-pages", "dissociation-project-scope"].includes(mode)) {
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[] });
      const searches = calls.filter(call => call.args[2] === "search-v2");
      expect(searches).toHaveLength(2);
      for (const { args } of searches) expect(args[args.indexOf("--project-id") + 1]).toBe("prj_11111111-1111-4111-8111-111111111111");
      if (mode === "document-search-pages") expect(searches[1].args).toContain("--cursor");
      else expect(calls.filter(call => call.args[2] === "dissociate")).toHaveLength(1);
    }
  });
});
