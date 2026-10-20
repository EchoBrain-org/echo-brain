import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLimit, LIMIT_CASES } from './limit-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url)), runs = [];
for (const directory of process.argv.slice(2)) {
  for (const name of (await readdir(directory)).filter(n => /^(bounded|unbounded|writer-only)-.*\.json$/.test(n)).sort()) {
    const path = resolve(directory, name), raw = await readFile(path), r = JSON.parse(raw);
    const researchCost = r.research_metrics?.estimated_cost_usd ?? r.diagnostic?.estimated_cost_usd;
    const writerCost = r.writer_metrics.reduce((n, c) => n + c.estimated_cost_usd, 0);
    const misclassified = (r.bundle?.items ?? []).filter(i => i.cited_by_plan && !i.full).map(i => i.short);
    runs.push({ raw_file: relative(here, path), raw_sha256: createHash('sha256').update(raw).digest('hex'), mode: r.mode, case: r.case,
      valid_comparison: misclassified.length === 0, ...(misclassified.length ? { excluded_reason: 'Prototype adapter incorrectly promoted metadata-only plan citations to writer text.', misclassified } : {}),
      elapsed_ms: r.elapsed_ms, error: r.error, diagnostic: r.diagnostic, checks_at_run: r.checks, checks: assessLimit(r),
      research_metrics: r.research_metrics, writer_metrics: r.writer_metrics, estimated_cost_usd: r.mode === 'writer-only' ? writerCost : researchCost == null ? null : researchCost + writerCost,
      models: [...new Set(r.events.filter(e => e.model).map(e => e.model))],
      research: r.research ? { stop: r.research.stop, plan: r.research.plan, cost: r.research.cost, coverage: r.research.coverage,
        item_count: r.research.items.length, read_in_full: r.research.items.filter(i => i.read_in_full).length, tools: r.research.rounds.flatMap(round => round.actions.map(a => a.tool)),
        lists: r.research.lists?.map(l => ({ id: l.id, count: l.members.length, complete: l.complete })) } : undefined,
      rendered: r.rendered, renderer_outcome: r.renderer_outcome, renderer_fallbacks: r.renderer_fallbacks, uncapped_build: r.uncapped_build });
  }
}
const cases = Object.keys(LIMIT_CASES).map(name => ({ case: name, question: LIMIT_CASES[name].question,
  modes: Object.fromEntries(['bounded', 'unbounded', 'writer-only'].map(mode => { const selected = runs.filter(r => r.case === name && r.mode === mode && r.valid_comparison);
    return [mode, { runs: selected.length, passed: selected.filter(r => r.checks.passed).length, fact_recall: selected.map(r => r.checks.fact_recall), elapsed_seconds: selected.map(r => +(r.elapsed_ms / 1000).toFixed(2)),
      estimated_cost_usd: selected.map(r => r.estimated_cost_usd), error: selected.filter(r => r.error).map(r => r.error) }]; })) }));
const evidence = { kind: 'echo-synthetic-sdk-limit-comparison-v1', source_base: '819a9ef', original_prototype_commit: '86be445052952a1d3d585d609449ff835d698fc6',
  caveats: ['Synthetic-only; not a production workload or latency benchmark.', 'Model/provider/SDK intrinsic limits remain.', 'The first round retained the writer semantic repair check; no additional model repair was observed there. The final variant also removes that numerical repair restriction.',
    'Briefing scoring was corrected to accept two separate numbered entries sharing a renderer statement. Original checks and raw hashes are preserved.',
    'Runs affected by the metadata-as-text prototype adapter bug are retained but excluded; affected comparisons are rerun after the fix.',
    'Failed SDK runs can lack usage/cost; null is unknown, not zero.'], cases, runs };
await writeFile(resolve(here, 'limit-trial-results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ cases, runs: runs.length }, null, 2));
