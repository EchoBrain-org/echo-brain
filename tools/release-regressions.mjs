import { spawnSync } from 'node:child_process';

// Fast, offline proofs of failures seen in recent releases. These run existing
// regressions; they do not replace npm run check, CI, or live acceptance.
process.umask(0o022);
const tests = [
  'tests/architecture/client-update-publish.test.ts',
  'tests/architecture/release-readiness.test.ts',
  'tests/person-client/person-client-session-store.test.ts',
  'packages/organization-authority-kernel/test/answer-composition/renderers/ask-renderer-v1.test.ts',
  'packages/organization-authority-kernel/test/answer-composition/agentic-research-loop-v1.test.ts',
  'providers/openrouter/test/claude-research.test.ts',
];
for (const [command, args] of [
  ['npm', ['run', 'build']],
  ['npx', ['--no-install', 'vitest', 'run', ...tests]],
  [process.execPath, ['--test', 'tools/evals/research-loop/test/reach.test.mjs']],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
