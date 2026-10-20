import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdkResearch } from './research.mjs';
import { runClaude } from './client.mjs';
import { limitFixture, LIMIT_CASES, assessLimit } from './limit-fixtures.mjs';
import { unlimitedCore, stripSizeBounds } from './unlimited-core.mjs';
import { createAgenticModelGateV1, createAskRendererV1, ANSWER_PROMPT, AGENTIC_RESEARCH_LIVE_BUDGET_V1 as BUDGET, trimAgenticEvidenceBundleV1 } from './core.mjs';

export const UNLIMITED_BUDGET = Object.freeze({ deadline_ms: Infinity, writer_reserve_ms: 0, max_rounds: Infinity, max_model_calls: Infinity });

/** Provider/SDK defaults remain; no experiment-defined time, turns, calls, cost, input or output-size ceiling. */
function unlimitedGate(f, signal, calls, onEvent) {
  let count = 0, repairs = 0;
  return { stats: () => ({ calls: count, repairs, stopped: false }),
    async withRepair(_role, system, user, schema, _timeout, parse) {
      let prompt = user;
      for (;;) {
        signal.throwIfAborted(); await f.desk.revalidate(); count++;
        const reply = await runClaude({ prompt: JSON.stringify(prompt), system, schema: stripSizeBounds(schema), unbounded: true, signal, onEvent });
        calls.push(reply.metrics); await f.desk.revalidate();
        try { return parse(reply.value); }
        catch (error) {
          repairs++; onEvent({ event: 'writer_repair', reason: error.message });
          prompt = { ...user, rejected_response: reply.value, validation_error: error.message };
        }
      }
    },
  };
}

export async function renderLimit(bundle, f, question, { unbounded, signal, deadline, calls, onEvent }) {
  const core = unbounded ? await unlimitedCore() : { createAskRendererV1, ANSWER_PROMPT };
  const model = { generate: async input => {
    const reply = await runClaude({ prompt: input.user_prompt, system: input.system_prompt, schema: input.schema, signal, timeoutMs: input.timeout_ms, onEvent });
    calls.push(reply.metrics); return reply.value;
  } };
  const gate = unbounded ? unlimitedGate(f, signal, calls, onEvent) : createAgenticModelGateV1({
    generation: { generation_adapter_id: 'synthetic-claude-sdk', answer_model: 'sonnet', timeout_ms: 30_000 }, model,
    desk_revalidate: () => f.desk.revalidate(), on_checked: () => {}, budget: BUDGET, now: performance.now.bind(performance), deadline, signal, is_deadline_expired: () => performance.now() >= deadline,
  });
  const renderer = core.createAskRendererV1({ response_version: 8, answer_prompt: core.ANSWER_PROMPT, source_catalog: f.catalog.entries,
    scope: 'everything the asker can read', context: f.context, desk_scope: f.desk.scope });
  return renderer.render({ bundle: { ...bundle, budget: unbounded ? UNLIMITED_BUDGET : BUDGET }, trigger_input: { question }, gate, signal,
    remaining: () => unbounded ? Infinity : deadline - performance.now() - 1000, prompt_budget: () => unbounded ? Infinity : 250_000 });
}

export async function limitTrial(mode, name, onEvent = () => {}, replay) {
  if (!['bounded', 'unbounded', 'writer-only'].includes(mode)) throw new Error('Invalid mode');
  const unbounded = mode === 'unbounded', f = limitFixture(name, unbounded), started = performance.now(), deadline = started + BUDGET.deadline_ms;
  const abort = new AbortController(), signal = abort.signal;
  const timer = mode !== 'bounded' ? undefined : setTimeout(() => abort.abort(new Error('trial_deadline')), BUDGET.deadline_ms);
  const question = LIMIT_CASES[name].question, calls = [], events = [];
  const record = event => { events.push({ elapsed_ms: performance.now() - started, ...event }); onEvent(event); };
  let bundle, metrics;
  try {
    if (replay) { bundle = replay.bundle; metrics = replay.research_metrics; }
    else ({ bundle, metrics } = await sdkResearch(f, { goal: { kind: 'question', question }, starting: [], budget: unbounded ? UNLIMITED_BUDGET : BUDGET, options: {} }, { unbounded, signal, onEvent: record }));
    const rendered = await renderLimit(bundle, f, question, { unbounded: mode !== 'bounded', signal, deadline, calls, onEvent: record });
    await f.desk.revalidate();
    const result = { mode, case: name, question, synthetic: true, elapsed_ms: performance.now() - started, research_metrics: metrics, writer_metrics: calls,
      research: trimAgenticEvidenceBundleV1(bundle), bundle, rendered: rendered.result.response, renderer_outcome: rendered.outcome, renderer_fallbacks: rendered.fallbacks, events,
      ...(mode !== 'bounded' ? { uncapped_build: (await unlimitedCore()).manifest } : {}) };
    return { ...result, checks: assessLimit(result) };
  } catch (error) {
    const result = { mode, case: name, question, synthetic: true, error: error.message, diagnostic: error.diagnostic, elapsed_ms: performance.now() - started, research_metrics: metrics, writer_metrics: calls, events, ...(bundle ? { bundle, research: trimAgenticEvidenceBundleV1(bundle) } : {}) };
    return { ...result, checks: assessLimit(result) };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, name, target, replayFile] = process.argv.slice(2);
  if (!target) throw new Error('Usage: node limit-trial.mjs bounded|unbounded|writer-only CASE OUTPUT [REPLAY_FILE]');
  const replay = replayFile ? JSON.parse(await readFile(replayFile, 'utf8')) : undefined;
  const result = await limitTrial(mode, name, event => console.error(JSON.stringify({ mode, case: name, ...event })), replay);
  await mkdir(dirname(resolve(target)), { recursive: true }); await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ mode, case: name, checks: result.checks, error: result.error, elapsed_ms: result.elapsed_ms, output: target }));
  if (!result.checks.passed) process.exitCode = 1;
}
