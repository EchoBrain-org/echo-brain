import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { limitTrial } from './limit-trial.mjs';
import { LIMIT_CASES } from './limit-fixtures.mjs';

const directory = resolve(process.argv[2] ?? `tools/evals/headless-research/results/limits-${Date.now()}`);
const cases = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(LIMIT_CASES);
await mkdir(directory, { recursive: true });
const summary = [];
for (const [index, name] of cases.entries()) {
  for (const mode of index % 2 ? ['unbounded', 'bounded'] : ['bounded', 'unbounded']) {
    console.log(JSON.stringify({ event: 'case_start', mode, case: name }));
    const result = await limitTrial(mode, name, event => console.log(JSON.stringify({ mode, case: name, ...event })));
    const output = resolve(directory, `${mode}-${name}.json`);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const researchCost = result.research_metrics?.estimated_cost_usd ?? result.diagnostic?.estimated_cost_usd;
    const entry = { mode, case: name, output, elapsed_ms: result.elapsed_ms, error: result.error, checks: result.checks,
      estimated_cost_usd: researchCost == null ? null : researchCost + result.writer_metrics.reduce((sum, call) => sum + call.estimated_cost_usd, 0) };
    summary.push(entry); console.log(JSON.stringify({ event: 'case_end', ...entry }));
    await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  }
}
console.log(JSON.stringify({ event: 'suite_complete', directory, passed: summary.filter(r => r.checks.passed).length, total: summary.length }));
