#!/usr/bin/env node
// Plans which CI jobs a run needs; `CI required checks` accepts a skipped job
// only when this plan deselected it. Anything this script cannot verify
// selects every job.
//
// - A pull request into main skips the desktop and macOS Person-client jobs
//   when the tested merge commit leaves their inputs identical to main and
//   main's own `CI required checks` passed on that tree.
// - A push to main whose exact tree the merged pull request's head passed in
//   `CI required checks` runs the history-dependent docs check and the
//   Authority image (SHA provenance) instead of re-testing.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECK = 'CI required checks';
// `CI required checks` records the tree its run tested as a notice with this
// title, so a green result counts only for that tree.
export const TESTED_TREE = 'CI tested tree';
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

// The latest `CI required checks` on a commit: 'passed' only when every run
// succeeded and recorded `tree` as the tree it tested. A pull-request run
// tests a merge with its base, whose tree a stacked base can make differ from
// the head's.
async function requiredCheck(api, repository, commit, tree) {
  const checks = await api(`/repos/${repository}/commits/${commit}/check-runs?check_name=${encodeURIComponent(REQUIRED_CHECK)}&filter=latest&per_page=100`);
  const runs = checks.check_runs ?? [];
  if (checks.total_count !== runs.length || !runs.every((run) =>
    run.name === REQUIRED_CHECK && run.head_sha === commit && run.app?.id === GITHUB_ACTIONS_APP_ID &&
    Number.isSafeInteger(run.id))) {
    return 'unverifiable';
  }
  if (runs.some((run) => run.status === 'completed' && run.conclusion !== 'success')) return 'failed';
  if (runs.length === 0 || runs.some((run) => run.status !== 'completed')) return 'unfinished';
  for (const run of runs) {
    const annotations = await api(`/repos/${repository}/check-runs/${run.id}/annotations?per_page=100`);
    const tested = annotations.filter((annotation) => annotation.title === TESTED_TREE);
    if (tested.length !== 1 || tested[0].annotation_level !== 'notice' || tested[0].message !== tree) {
      return 'another tree';
    }
  }
  return 'passed';
}

// A fresh main run may still be running, or not yet report its required
// check. Wait about as long as a verified light run takes, well within the
// plan's timeout.
const BASE_CHECK_DELAYS = [0, 15_000, 15_000, 30_000, 30_000, 30_000, 30_000];

export async function selectPullRequestJobs({ event, sha, repository, git, api, sleep }) {
  const pullRequest = event?.pull_request;
  // Stacked pull requests are tested against a branch whose jobs may not
  // have run.
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
  const reason = `inputs compared with main ${base}`;
  if (Object.keys(JOB_INPUTS).every((job) => jobs[job])) return { mode: 'pull-request', reason, jobs };
  // A skipped job is vouched for only by main. Skip it only when main passed
  // on this tree, so a failure there keeps every later pull request red.
  const tree = gitOutput(git, ['rev-parse', '--verify', `${base}^{tree}`]);
  let check;
  for (const delay of BASE_CHECK_DELAYS) {
    if (delay) await sleep(delay);
    check = await requiredCheck(api, repository, base, tree);
    if (check !== 'unfinished') break;
  }
  if (check !== 'passed') return everything(`main ${base} has no green ${REQUIRED_CHECK} (${check})`);
  return { mode: 'pull-request', reason, jobs };
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
  const check = await requiredCheck(api, repository, head, pushed.tree.sha);
  if (check !== 'passed') {
    return everything(`pull request #${pullRequest.number} head has no green ${REQUIRED_CHECK} on this tree (${check})`);
  }
  return {
    mode: 'verified-main',
    reason: `tree of pull request #${pullRequest.number} head ${head}`,
    jobs: { ...VERIFIED_MAIN_JOBS },
  };
}

export async function selectJobs({ eventName, event, sha, repository, git, api, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  try {
    if (eventName === 'pull_request') return await selectPullRequestJobs({ event, sha, repository, git, api, sleep });
    if (eventName === 'push') return await verifyMainPush({ event, sha, repository, api, sleep });
    return everything(`${eventName} runs every job`);
  } catch (error) {
    return everything(`selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const env = process.env;
  const git = gitIn(resolve(import.meta.dirname, '..'));
  let selection;
  try {
    selection = await selectJobs({
      eventName: env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
      sha: env.GITHUB_SHA,
      repository: env.GITHUB_REPOSITORY,
      git,
      api: githubApi(env.GITHUB_API_URL, env.GITHUB_TOKEN),
    });
  } catch (error) {
    selection = everything(`selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Every job checks out GITHUB_SHA, so its tree is the tree this run tests.
  const tree = FULL_SHA.test(env.GITHUB_SHA ?? '') ? git(['rev-parse', '--verify', `${env.GITHUB_SHA}^{tree}`]) : undefined;
  const lines = [
    `mode=${selection.mode}`,
    `tree=${tree?.status === 0 && FULL_SHA.test(tree.stdout) ? tree.stdout : ''}`,
    ...JOB_OUTPUTS.map((job) => `${job}=${selection.jobs[job]}`),
  ];
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `CI job selection: ${selection.mode} (${selection.reason})\n`);
  }
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
