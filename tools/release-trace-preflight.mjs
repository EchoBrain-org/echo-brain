import { isAbsolute } from 'node:path';
import { privateFile, sha256 } from './lib/operator-io.mjs';
import { readCleanV1Release } from './clean-v1-release.mjs';
import { langsmithTraces } from './evals/research-loop/lib/release-check.mjs';

/** Check the canary's exported trace before spending calls on the full Ask round. */
export function releaseTracePreflight({ release: releasePath, runs, exportStatus }, { now = Date.now } = {}) {
  for (const path of [releasePath, runs, exportStatus]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('absolute_evidence_path_required');
  }
  privateFile(releasePath, 16384, 1);
  const release = readCleanV1Release(releasePath);
  const bytes = privateFile(runs, 16 * 1024 * 1024, 1);
  const exporter = JSON.parse(privateFile(exportStatus, 16384, 1));
  const exported = exporter.kind === 'echo-langsmith-tracing-status-v1' && exporter.enabled === true &&
    Number.isSafeInteger(exporter.exported) && exporter.exported > 0 &&
    ['failed', 'dropped', 'incomplete', 'pending'].every(key => exporter[key] === 0);
  const at = now();
  const traces = langsmithTraces(JSON.parse(bytes)).filter(trace => {
    const age = at - Date.parse(trace.started_at ?? '');
    return trace.release_sha === release.source_sha && trace.complete === true && Number.isFinite(age) && age >= 0 && age <= 15 * 60_000;
  });
  return { kind: 'echo-release-trace-preflight-v1', ready: exported && traces.length > 0,
    source_sha: release.source_sha, export_sha256: sha256(bytes), exporter_healthy: exported, recent_complete_candidate_traces: traces.length,
    observation: 'saved_evidence_only', next_action: exported && traces.length > 0 ? 'run_required_open_ended_questions' : 'repair_tracing_and_export_a_fresh_candidate_canary_trace' };
}
