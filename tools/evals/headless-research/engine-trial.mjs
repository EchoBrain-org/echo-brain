import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgenticAskV5, createAgenticResearchV1 } from '../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1.js';
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from '../../../packages/organization-authority-kernel/dist/answer-composition/agentic-research-v1.js';
import { SWEEP_RENDERER_V1 } from './core.mjs';
import { fixture, CASES, CONTEXT, FIXTURE_ITEMS } from './fixtures.mjs';
import { createClaudeResearchDriver } from './engine-driver.mjs';
import { generationPort } from './client.mjs';
import { assess } from './assess.mjs';

/** Live SDK, synthetic sources, actual request lifecycle and renderers. No staging credentials or endpoints. */
export async function engineTrial(caseName, onEvent = () => {}) {
  if (!(caseName in CASES) && caseName !== 'sweep') throw new Error('Unknown integration case');
  const f = fixture(), audit = [], calls = [], events = [], started = performance.now();
  const options = { desk: f.desk, model: generationPort(metrics => calls.push(metrics)),
    generation: { generation_adapter_id: 'synthetic-claude-writer', answer_model: 'sonnet', planner_model: 'sonnet', timeout_ms: 60_000, context_tokens: 200_000 },
    audit: { append: entry => { audit.push(entry); } }, asker: { display_name: CONTEXT.asked_by },
    time_context: { now: CONTEXT.now, time_zone: CONTEXT.time_zone }, today: () => CONTEXT.today, wall_ms: () => Date.parse(CONTEXT.now),
    research_driver: createClaudeResearchDriver({ onEvent: event => { events.push(event); onEvent(event); } }),
  };
  let output, rendered;
  if (caseName === 'sweep') {
    const record = FIXTURE_ITEMS.find(item => item.label.startsWith('DEMO-17:'));
    output = await createAgenticResearchV1(options).renderWithResearch({ trigger: 'sweep',
      brief: { goal: { kind: 'task', task: 'Recheck {{starting:1}} against the calibration change.' }, starting: [{ citation: record.citation, if_unreadable: 'report' }], options: { planner: false, list: false }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 },
      renderer: SWEEP_RENDERER_V1, trigger_input: { findings: [{ finding: 'Calibration work', expected: 'Calibration review completed.', citations: [record.citation] }] },
    });
    rendered = output.rendered;
  } else {
    output = await createAgenticAskV5(options).answerWithResearch({ question: CASES[caseName].question, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 });
    rendered = output.response;
  }
  const result = { case: caseName, engine: 'sdk-native-research-port', fixture: 'synthetic-v1', elapsed_ms: performance.now() - started,
    research: output.research, rendered, audit, writer_metrics: calls, events,
    renderer_outcome: audit.at(-1)?.outcome, renderer_fallbacks: audit.at(-1)?.fallbacks ?? 0 };
  return { ...result, checks: assess(result) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const caseName = process.argv[2] ?? 'projects', output = resolve(process.argv[3] ?? `tools/evals/headless-research/results/engine-${caseName}.json`);
  try {
    const result = await engineTrial(caseName, event => console.error(JSON.stringify(event)));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ case: caseName, elapsed_ms: result.elapsed_ms, checks: result.checks, stop: result.research.stop, output }));
    if (!result.checks.passed) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ case: caseName, error: error.message })); process.exitCode = 1; }
}
