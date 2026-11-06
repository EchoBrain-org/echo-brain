import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { request } from 'node:https';
import { releaseRoundStatus } from '../../tools/release-readiness.mjs';
import { releaseTracePreflight } from '../../tools/release-trace-preflight.mjs';
import { releasePreflight } from '../../tools/release-preflight.mjs';
import { publicationFailure, publicationFetch } from '../../tools/lib/publication-transport.mjs';
import { canonicalJsonForTest } from '../support/test-canonical-json.js';
import { cleanReleaseRecord } from '../support/clean-v1-release.js';

const dirs: string[] = [];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const write = (path: string, value: unknown) => writeFileSync(path, canonicalJsonForTest(value) + '\n', { mode: 0o600 });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-round-')); chmodSync(dir, 0o700); dirs.push(dir);
  const release = cleanReleaseRecord();
  const releasePath = join(dir, 'release.json'); write(releasePath, release);
  const hash = digest(readFileSync(releasePath));
  const now = Date.now();
  const config: any = { schema_version: 1, kind: 'echo-release-round-v1', release: releasePath, prepared: null, server_receipts: [], publication_receipt: null, research_check: null, client_proofs: [] };
  const round = join(dir, 'round.json');
  const artifacts = [
    { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'cli-kit' },
    { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'cli-kit' },
    { platform: 'darwin', architecture: 'arm64', libc: null, installation: 'electron' },
    { platform: 'linux', architecture: 'x64', libc: 'glibc', installation: 'electron' },
  ].map((target, index) => ({ ...target, sha256: String(index + 1).repeat(64) }));
  const manifest = { release_id: release.release_id, release_sha256: hash, source_sha: release.source_sha, sequence: 21, channel: 'test', expires_at: new Date(now + 86400000).toISOString(), artifacts };
  const prepared = { manifest, payload: Buffer.from(JSON.stringify(manifest)) };
  const server: any = { state: 'succeeded', request: { action: 'status', created_at: Math.floor(now / 1000), target: { instance: 'fixture' }, accepted: { sha256: hash, release_id: release.release_id }, candidate: { sha256: hash, release_id: release.release_id } } };
  const publication: any = { release_id: release.release_id, source_sha: release.source_sha, release_sha256: hash, manifest_sha256: digest(prepared.payload), state: 'succeeded', verified_objects: 5, object_count: 5, metadata_fresh: true };
  const dependencies = { now: () => now, inspectPrepared: () => prepared, readServer: () => server, readPublication: () => publication };
  const status = () => { write(round, config); return releaseRoundStatus(round, dependencies); };
  return { dir, config, round, release, hash, prepared, server, publication, dependencies, status };
}

describe('release progress from saved evidence', () => {
  it('lists missing work without claiming current live state or authorizing writes', () => {
    const f = fixture(); const result = f.status();
    expect(result.observation).toBe('saved_evidence_only');
    expect(result.remaining).toContain('prepare_four_target_feed_for_combined_review');
    expect(result.remaining.filter(item => item.startsWith('verify_native_'))).toHaveLength(4);
    expect(result.research_coverage_passed).toBe(false);
  });
  it('derives publication from its receipt, while keeping native delivery and expired evidence explicit', () => {
    const f = fixture(); Object.assign(f.config, { prepared: f.dir, server_receipts: ['/status'], publication_receipt: '/publication' });
    expect(f.status().recorded_phase).toBe('client_published');
    f.publication.metadata_fresh = false;
    expect(f.status().remaining).toContain('renew_expired_feed_metadata');
    f.server.request.created_at -= 301;
    expect(f.status().remaining).toContain('obtain_fresh_accepted_server_status');
    f.publication.state = 'unconfirmed';
    expect(f.status().remaining).toContain('reconcile_existing_publication_receipt');
  });
  it('resumes after promotion with a fresh status and publication, never another stage', () => {
    const f = fixture(); f.config.prepared = f.dir;
    const previous = { sha256: 'a'.repeat(64), release_id: 'previous-release' };
    const receipts: Record<string, any> = {};
    const add = (action: string, minutesAgo: number, accepted = previous) => {
      const path = `/${Object.keys(receipts).length}-${action}`;
      receipts[path] = { ...f.server, request: { ...f.server.request, action, accepted, created_at: f.server.request.created_at - minutesAgo * 60 } };
      f.config.server_receipts.push(path);
    };
    Object.assign(f.dependencies, { readServer: (path: string) => receipts[path] });
    add('stage', 30); add('canary', 25); add('promote', 10);
    let result = f.status();
    expect(result.recorded_phase).toBe('promoted');
    expect(result.next_action).toBe('obtain_fresh_status_then_publish_approved_feed');
    expect(result.remaining).toEqual(expect.arrayContaining(['obtain_fresh_accepted_server_status', 'publish_approved_feed']));
    expect(result.remaining).not.toContain('complete_combined_review_then_promote_and_publish');
    add('status', 0, f.server.request.accepted);
    result = f.status();
    expect(result.recorded_phase).toBe('server_accepted');
    expect(result.next_action).toBe('obtain_fresh_status_then_publish_approved_feed');
    f.config.publication_receipt = '/publication'; f.publication.state = 'publishing'; f.publication.verified_objects = 2;
    expect(f.status().next_action).toBe('obtain_fresh_status_then_resume_approved_publication');
  });
  it('does not let publication hide an uncertain server operation', () => {
    const f = fixture(); Object.assign(f.config, { prepared: f.dir, server_receipts: ['/status'], publication_receipt: '/publication' });
    f.server.state = 'unconfirmed';
    expect(f.status().recorded_phase).toBe('operation_incomplete');
    expect(f.status().remaining).toContain('reconcile_existing_server_receipt_with_original_tooling');
  });
  it('rejects evidence from a different release and mutable handoff status flags', () => {
    const f = fixture(); f.config.state = 'released';
    expect(f.status).toThrow('release_round_invalid'); delete f.config.state;
    f.config.server_receipts = ['/wrong']; f.server.request.candidate.sha256 = '0'.repeat(64);
    expect(f.status).toThrow('server_release_mismatch');
  });
  it('requires every formal question from the exact candidate', () => {
    const f = fixture(); f.config.research_check = join(f.dir, 'research.json');
    const report = { kind: 'echo-research-release-check-v1', passed: true, questions: ['what-happened-yesterday', 'current-projects-and-leads', 'open-items-and-owners'].map(case_id => ({ case_id, passed: true, release_sha: f.release.source_sha, trace_id: case_id })) };
    write(f.config.research_check, report); expect(f.status().research_coverage_passed).toBe(true);
    report.questions[0].release_sha = '0'.repeat(40);
    write(f.config.research_check, report); expect(f.status().research_coverage_passed).toBe(false);
  });
  it('requires native A-to-B evidence and detects a changed proof file', () => {
    const f = fixture(); f.config.prepared = f.dir;
    const evidence = join(f.dir, 'observed.json'); write(evidence, { fixture: true });
    const proof: any = { kind: 'echo-release-client-proof-v1', target: 'macos-kit', release_id: f.release.release_id, source_sha: f.release.source_sha, artifact_sha256: f.prepared.manifest.artifacts[1].sha256,
      native: true, seat: 'test mac', baseline_source_sha: 'f'.repeat(40), method: 'signed-feed-update', checks: Object.fromEntries(['baseline', 'available_without_activation', 'activation', 'authenticated_read', 'cited_ask'].map(name => [name, { passed: true, path: evidence, sha256: digest(readFileSync(evidence)) }])) };
    const path = join(f.dir, 'proof.json'); write(path, proof); f.config.client_proofs = [path];
    expect(f.status().client_proofs).toHaveLength(1);
    proof.native = false; write(path, proof); expect(f.status).toThrow('client_proof_binding_invalid');
    proof.native = true; write(path, proof); write(evidence, { changed: true });
    expect(f.status).toThrow('client_proof_evidence_changed');
  });
});

it('checks build prerequisites before work and never claims remote readiness', () => {
  const commands: string[] = [];
  const deps = { run: (command: string, args: string[]) => { commands.push(command); return { status: command === 'zip' ? 1 : 0, stdout: command === 'npm' ? '10.9.4' : args[0] === 'status' ? '' : 'version' }; },
    nodeVersion: '22.22.1', umask: 0o077, statfs: () => ({ bavail: 20 * 1024 ** 3, bsize: 1 }) };
  const result = releasePreflight({ target: 'linux' }, deps);
  expect(result.ready).toBe(false);
  expect(result.checks.filter(check => !check.passed).map(check => check.check)).toEqual(['zip', 'test_umask_022']);
  expect(commands).not.toContain('aws'); expect(result.live_checks_required).toContain('runtime_trace_export');
});

it('uses a separate connection for every bounded public GET and does not follow redirects', async () => {
  let connections = 0;
  const server = createServer((req, res) => { res.writeHead(req.url === '/redirect' ? 302 : 200, { location: '/destination' }); res.end('fixture'); });
  server.on('connection', () => connections++);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const transport = ((url: URL, options: any, callback: any) => {
    expect(options.agent).toBe(false);
    return httpRequest({ hostname: '127.0.0.1', port, path: url.pathname, ...options }, callback);
  }) as typeof request;
  try {
    for (let i = 0; i < 2; i++) expect(await (await publicationFetch('https://fixture.test/object', { redirect: 'manual', signal: AbortSignal.timeout(1000) }, transport)).text()).toBe('fixture');
    expect(connections).toBe(2);
    const redirected = await publicationFetch('https://fixture.test/redirect', { redirect: 'manual' }, transport);
    expect(redirected.status).toBe(302); await redirected.body?.cancel();
    await expect(publicationFetch('http://fixture.test/', { redirect: 'manual' }, transport)).rejects.toThrow('public_request_invalid');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('never records arbitrary exception prose in publication diagnostics', () => {
  expect(publicationFailure(new Error('private_upstream_body'), true)).toEqual({ code: 'publication_operation_failed', recovery: 'replace-status' });
});


it('requires an actual recent complete candidate trace, not just access to LangSmith', () => {
  const f = fixture(); const runs = join(f.dir, 'runs.json'); const exportStatus = join(f.dir, 'exporter.json');
  const now = f.dependencies.now();
  const root = { id: 'fixture-trace', name: 'ECHO ask', is_root: true, start_time: new Date(now).toISOString(), metadata: { release_sha: f.release.source_sha, complete: true }, outputs: { result: {} } };
  const stage = { id: 'fixture-research', name: 'research', parent_run_ids: ['fixture-trace'], outputs: { research: { goal: { question: 'canary' } } } };
  const exporter = { kind: 'echo-langsmith-tracing-status-v1', enabled: true, exported: 1, failed: 0, dropped: 0, incomplete: 0, pending: 0 };
  write(exportStatus, exporter); write(runs, [root, stage]);
  const check = () => releaseTracePreflight({ release: f.config.release, runs, exportStatus }, { now: () => now });
  expect(check().ready).toBe(true);
  root.metadata.release_sha = '0'.repeat(40); write(runs, [root, stage]); expect(check().ready).toBe(false);
  root.metadata.release_sha = f.release.source_sha; root.start_time = new Date(now - 900001).toISOString();
  write(runs, [root, stage]); expect(check().ready).toBe(false);
  root.start_time = new Date(now).toISOString(); write(runs, [root, stage]);
  exporter.failed = 1; write(exportStatus, exporter); expect(check().ready).toBe(false);
});
