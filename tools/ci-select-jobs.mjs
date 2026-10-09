#!/usr/bin/env node
// Plans which CI jobs a run needs; `CI required checks` accepts a skipped job
// only when this plan deselected it. Anything this script cannot verify
// selects every job.
//
// - A pull request into main skips the desktop and macOS Person-client jobs
//   when the tested merge commit leaves their inputs identical to main.
// - A push to main whose tree is byte-identical to the head of the merged pull
//   request, already green in `CI required checks`, runs the history-dependent
//   docs check and the Authority image (SHA provenance) instead of re-testing.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECK = 'CI required checks';
// The ruleset expects `CI required checks` from this GitHub App.
const GITHUB_ACTIONS_APP_ID = 15368;
const FULL_SHA = /^[0-9a-f]{40}$/;

// Root install and build configuration, and the Person client with every
// workspace `node tools/build.mjs --person-client` compiles for it. Packaging
// reads every workspace manifest; it and the build require a clean checkout.
const SHARED_INPUTS = [
  '.github/workflows/ci.yml',
  'tools/ci-select-jobs.mjs',
  'package.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  ':(glob)packages/*/package.json',
  ':(glob)providers/**/package.json',
  ':(glob)services/*/package.json',
  'tsconfig.build.json',
  ':(glob)**/.gitignore',
  ':(glob)**/.gitattributes',
  'tools/build.mjs',
  'tools/pack-person-client.mjs',
  'src/product/person-client/',
  'packages/federation-protocol/',
  'packages/organization-protocol/',
  'packages/organization-api/',
  'providers/slack/client/',
  'providers/jira/client/',
  'providers/confluence/client/',
];

export const JOB_INPUTS = Object.freeze({
  desktop_app: Object.freeze([
    ...SHARED_INPUTS,
    'product/echo-desktop/',
    'tools/ci-runner-info.mjs',
    'tests/fixtures/project-context-v1/',
  ]),
  person_client_package: Object.freeze([
    ...SHARED_INPUTS,
    'tools/clean-v1-runtime-profile.mjs',
    'tools/clean-v1-release.mjs',
    'deploy/release/',
    ':(glob)deploy/organization-authority/compose.clean-v1*.yaml',
    ':(glob)deploy/organization-authority/Caddyfile.clean-v1*',
    'tests/fixtures/person-onboarding-smoke.mjs',
    'tests/architecture/mac-person-cli-kit.test.ts',
    'tests/architecture/client-update-dispatch.test.ts',
    'tests/person-client/client-update.test.ts',
    'tests/support/test-canonical-json.ts',
    'vitest.config.ts',
    'tsconfig.json',
  ]),
});

// The Authority container runs on every event, so it needs no plan output.
export const JOB_OUTPUTS = Object.freeze([
  'check',
  'docs',
  'person_client_package',
  'desktop_app',
  'authority_recovery_infrastructure',
]);

const EVERY_JOB = Object.freeze({
  check: true,
  docs: false, // check runs check:docs itself.
  person_client_package: true,
  desktop_app: true,
  authority_recovery_infrastructure: true,
});

const VERIFIED_MAIN_JOBS = Object.freeze({
  check: false,
  docs: true,
  person_client_package: false,
  desktop_app: false,
  authority_recovery_infrastructure: false,
});

function everything(reason) {
  return { mode: 'full', reason, jobs: { ...EVERY_JOB } };
}

export function gitIn(cwd) {
  return (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout.trim() };
  };
}

function gitOutput(git, args) {
  const result = git(args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function inputsChanged(git, base, head, paths) {
  const { status } = git(['diff', '--quiet', '--no-renames', base, head, '--', ...paths]);
  if (status === 0) return false;
  if (status === 1) return true;
  throw new Error('git diff failed');
}

export function selectPullRequestJobs({ event, sha, git }) {
  const pullRequest = event?.pull_request;
  // Stacked pull requests are tested against a branch whose jobs may not
  // have run; only main is known to have passed every job.
  if (pullRequest?.base?.ref !== 'main') return everything('pull request base is not main');
  if (!FULL_SHA.test(sha ?? '') || gitOutput(git, ['rev-parse', '--verify', 'HEAD']) !== sha) {
    return everything('checkout is not the tested merge commit');
  }
  const [commit, base, head, ...rest] = gitOutput(git, ['rev-list', '--parents', '-n', '1', sha]).split(' ');
  if (commit !== sha || !FULL_SHA.test(base ?? '') || head !== pullRequest.head?.sha || rest.length !== 0) {
    return everything('tested merge commit has an unexpected shape');
  }
  const jobs = { ...EVERY_JOB };
  for (const [job, paths] of Object.entries(JOB_INPUTS)) {
    jobs[job] = inputsChanged(git, base, sha, paths);
  }
  return { mode: 'pull-request', reason: `inputs compared with main ${base}`, jobs };
}

export function githubApi(apiUrl, token) {
  return async (path) => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    return response.json();
  };
}

const PULL_REQUEST_LOOKUP_DELAYS = [0, 5_000, 15_000];

async function mergedPullRequest(api, repository, sha, sleep) {
  for (const delay of PULL_REQUEST_LOOKUP_DELAYS) {
    if (delay) await sleep(delay);
    const pulls = await api(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
    const merged = pulls.filter((pull) =>
      pull.merged_at && pull.merge_commit_sha === sha && pull.base?.ref === 'main');
    // GitHub may associate a fresh merge commit with its pull request late.
    if (merged.length !== 0) return merged.length === 1 ? merged[0] : undefined;
  }
  return undefined;
}

export async function verifyMainPush({ event, sha, repository, api, sleep }) {
  const before = event?.before ?? '';
  if (event?.ref !== 'refs/heads/main' || event.forced !== false || event.after !== sha ||
      !FULL_SHA.test(sha ?? '') || !FULL_SHA.test(before) || /^0+$/.test(before)) {
    return everything('push is not a fast-forward of main');
  }
  const pullRequest = await mergedPullRequest(api, repository, sha, sleep);
  const head = pullRequest?.head?.sha ?? '';
  if (!FULL_SHA.test(head)) return everything('no single merged pull request produced this commit');

  const [pushed, tested] = await Promise.all([
    api(`/repos/${repository}/git/commits/${sha}`),
    api(`/repos/${repository}/git/commits/${head}`),
  ]);
  if (!FULL_SHA.test(pushed.tree?.sha ?? '') || pushed.tree.sha !== tested.tree?.sha) {
    return everything(`tree differs from pull request #${pullRequest.number} head`);
  }
  // The head contained the previous main, so its pull-request run tested this
  // exact tree rather than a merge with an older main.
  const comparison = await api(`/repos/${repository}/compare/${before}...${head}?per_page=1`);
  if (!['ahead', 'identical'].includes(comparison.status)) {
    return everything(`pull request #${pullRequest.number} head did not contain the previous main`);
  }
  const checks = await api(`/repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(REQUIRED_CHECK)}&filter=latest&per_page=100`);
  const runs = checks.check_runs ?? [];
  const green = runs.length !== 0 && checks.total_count === runs.length && runs.every((run) =>
    run.name === REQUIRED_CHECK && run.head_sha === head && run.app?.id === GITHUB_ACTIONS_APP_ID &&
    run.status === 'completed' && run.conclusion === 'success');
  if (!green) return everything(`pull request #${pullRequest.number} head has no green ${REQUIRED_CHECK}`);
  return {
    mode: 'verified-main',
    reason: `tree of pull request #${pullRequest.number} head ${head}`,
    jobs: { ...VERIFIED_MAIN_JOBS },
  };
}

export async function selectJobs({ eventName, event, sha, repository, git, api, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  try {
    if (eventName === 'pull_request') return selectPullRequestJobs({ event, sha, git });
    if (eventName === 'push') return await verifyMainPush({ event, sha, repository, api, sleep });
    return everything(`${eventName} runs every job`);
  } catch (error) {
    return everything(`selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const env = process.env;
  let selection;
  try {
    selection = await selectJobs({
      eventName: env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
      sha: env.GITHUB_SHA,
      repository: env.GITHUB_REPOSITORY,
      git: gitIn(resolve(import.meta.dirname, '..')),
      api: githubApi(env.GITHUB_API_URL, env.GITHUB_TOKEN),
    });
  } catch (error) {
    selection = everything(`selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = [`mode=${selection.mode}`, ...JOB_OUTPUTS.map((job) => `${job}=${selection.jobs[job]}`)];
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `CI job selection: ${selection.mode} (${selection.reason})\n`);
  }
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
