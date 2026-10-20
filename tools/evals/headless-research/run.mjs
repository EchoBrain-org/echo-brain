import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixture, CASES, FIXTURE_ITEMS } from './fixtures.mjs';
import { sdkResearch } from './research.mjs';
import { generationPort } from './client.mjs';
import { assess } from './assess.mjs';
import { createAgenticResearchLoopV1, createAgenticModelGateV1, createAskRendererV1, SWEEP_RENDERER_V1, ASK_STEP_PROMPT, STEP_PROMPT, TASK_RULE_PROMPT, ANSWER_PROMPT, AGENTIC_RESEARCH_LIVE_BUDGET_V1 as BUDGET, trimAgenticEvidenceBundleV1 } from './core.mjs';

const profile = { generation_adapter_id: 'synthetic-claude-sdk', planner_model: 'sonnet', answer_model: 'sonnet', timeout_ms: 30_000 };
function gate(f, model, signal, deadline, hooks = {}) {
  return createAgenticModelGateV1({ generation: profile, model, desk_revalidate: input => f.desk.revalidate(input), on_checked: () => {}, budget: BUDGET, now: performance.now.bind(performance), deadline, signal, is_deadline_expired: () => performance.now() >= deadline, ...hooks });
}
export async function trial(engine, caseName, onEvent = () => {}) {
  if (!['sdk', 'current'].includes(engine)) throw new Error('engine must be sdk or current');
  if (!(caseName in CASES) && caseName !== 'sweep') throw new Error('Unknown synthetic case');
  const f = fixture(), started = performance.now(), deadline = started + BUDGET.deadline_ms;
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new Error('trial_deadline')), BUDGET.deadline_ms);
  const calls = [], model = generationPort(metrics => calls.push(metrics));
  const isSweep = caseName === 'sweep';
  const startingItem = FIXTURE_ITEMS.find(i => i.label.startsWith('DEMO-17:'));
  const brief = { goal: isSweep ? { kind: 'task', task: 'Recheck the current state of {{starting:1}} against the approved calibration change.' } : { kind: 'question', question: CASES[caseName].question },
    starting: isSweep ? [{ citation: startingItem.citation, if_unreadable: 'report' }] : [], budget: BUDGET, options: isSweep ? { planner: false, list: false } : {} };
  let bundle, metrics;
  try {
    if (engine === 'sdk') ({ bundle, metrics } = await sdkResearch(f, brief, { signal: abort.signal, onEvent }));
    else {
      const loop = createAgenticResearchLoopV1({ desk: f.desk, brief, prompt: isSweep ? `${STEP_PROMPT}\n${TASK_RULE_PROMPT}` : ASK_STEP_PROMPT, prompt_budget: 250_000,
        step_span: 'ask_planner', context: f.context, scope: 'everything the asker can read', catalog: f.catalog, now: performance.now.bind(performance), remaining: () => deadline - performance.now(), signal: abort.signal,
        assert_live: () => abort.signal.throwIfAborted(), observed: () => ({ checked_at: f.context.now, model_ms: calls.reduce((n, c) => n + c.model_ms, 0), desk_ms: 0 }), wall_now: () => Date.parse(f.context.now) });
      bundle = { ...await loop.run(gate(f, model, abort.signal, deadline, loop.gate_hooks)), trigger: 'synthetic_headless_trial' };
      metrics = { calls: [...calls], model_calls: calls.reduce((n, c) => n + c.model_calls, 0), estimated_cost_usd: calls.reduce((n, c) => n + c.estimated_cost_usd, 0) };
    }
    const renderer = isSweep ? SWEEP_RENDERER_V1 : createAskRendererV1({ response_version: 8, answer_prompt: ANSWER_PROMPT, source_catalog: f.catalog.entries, scope: 'everything the asker can read', context: f.context, desk_scope: f.desk.scope });
    const beforeWriter = calls.length;
    const rendered = await renderer.render({ bundle, trigger_input: isSweep ? { findings: [{ finding: 'Calibration work', expected: 'Calibration review completed.', citations: [startingItem.citation] }] } : { question: CASES[caseName].question },
      gate: gate(f, model, abort.signal, deadline), signal: abort.signal, remaining: () => deadline - performance.now() - 1000, prompt_budget: () => 250_000 });
    await f.desk.revalidate({ signal: abort.signal, mode: 'full' });
    const response = isSweep ? rendered.result : rendered.result.response;
    const result = { engine, case: caseName, fixture: 'synthetic-v1', source_sha: '819a9efac47b6e53355f6227936c7c6c68ddfbb8', elapsed_ms: performance.now() - started,
      research_metrics: metrics, writer_metrics: calls.slice(beforeWriter), research: trimAgenticEvidenceBundleV1(bundle),
      rendered: response, renderer_outcome: rendered.outcome, renderer_fallbacks: rendered.fallbacks, cited: rendered.cited };
    return { ...result, checks: assess(result) };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const engine = process.argv[2] ?? 'sdk', caseName = process.argv[3] ?? 'projects';
  const output = resolve(process.argv[4] ?? fileURLToPath(new URL(`results/${engine}-${caseName}.json`, import.meta.url)));
  try {
    const result = await trial(engine, caseName, event => console.error(JSON.stringify(event)));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ engine, case: caseName, elapsed_ms: result.elapsed_ms, checks: result.checks, research_stop: result.research.stop, renderer_outcome: result.renderer_outcome, research_metrics: result.research_metrics, output }, null, 2));
    if (!result.checks.passed) process.exitCode = 1;
  } catch (error) {
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ engine, case: caseName, error: error.message, diagnostic: error.diagnostic ?? null }, null, 2), { mode: 0o600 });
    console.error(JSON.stringify({ error: error.message, diagnostic: error.diagnostic ?? null, output })); process.exitCode = 1;
  }
}
