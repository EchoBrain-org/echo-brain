import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { dirname } from 'node:path';

// An explicit allowlist: diagnostics must never dump the runner environment.
const output = process.argv[2];
if (!output) throw new Error('Usage: node tools/ci-runner-info.mjs <output.json>');
const report = {
  schema_version: 1,
  source_sha: process.env.GITHUB_SHA,
  run_id: process.env.GITHUB_RUN_ID,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  job: process.env.GITHUB_JOB,
  image_os: process.env.ImageOS,
  image_version: process.env.ImageVersion,
  platform: process.platform,
  arch: process.arch,
  os_release: release(),
  node_version: process.version,
  cpu_model: cpus()[0]?.model,
  logical_cpus: cpus().length,
  available_parallelism: availableParallelism(),
  memory_bytes: totalmem(),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
