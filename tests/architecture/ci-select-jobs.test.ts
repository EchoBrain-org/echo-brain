import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  JOB_INPUTS,
  JOB_OUTPUTS,
  REQUIRED_CHECK,
  TESTED_TREE,
  gitIn,
  selectJobs,
  verifyMainPush,
} from "../../tools/ci-select-jobs.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
const REPOSITORY = "EchoBrain-org/echo-brain";
const EVERY_JOB = {
  check: true,
  docs: false,
  person_client_package: true,
  desktop_app: true,
  authority_recovery_infrastructure: true,
};
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "CI selector test",
  GIT_AUTHOR_EMAIL: "ci-selector@example.test",
  GIT_COMMITTER_NAME: "CI selector test",
  GIT_COMMITTER_EMAIL: "ci-selector@example.test",
};

const repositories: string[] = [];
afterAll(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

type Fixture = Record<string, any>;

const checksPath = (commit: string) =>
  `/repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=CI%20required%20checks&filter=latest&per_page=100`;
const annotationsPath = (id: number) => `/repos/${REPOSITORY}/check-runs/${id}/annotations?per_page=100`;

// A green `CI required checks` on `commit` that recorded testing `tree`.
function greenCheck(commit: string, tree: string, id = 7): Fixture {
  return {
    [checksPath(commit)]: {
      total_count: 1,
      check_runs: [{
        id, name: REQUIRED_CHECK, head_sha: commit, app: { id: 15368, slug: "github-actions" },
        status: "completed", conclusion: "success",
      }],
    },
    [annotationsPath(id)]: [
      { annotation_level: "notice", title: "", message: "Runner image notice" },
      { annotation_level: "notice", title: TESTED_TREE, message: tree },
    ],
  };
}

// Serves each fixture path, which may be a value, an Error, or a function.
function githubFixture(fixture: Fixture) {
  const requested: string[] = [];
  const delays: number[] = [];
  return {
    requested,
    delays,
    api: async (path: string) => {
      requested.push(path);
      const value = fixture[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected ${path}`);
      return typeof value === "function" ? value() : structuredClone(value);
    },
    sleep: async (ms: number) => { delays.push(ms); },
  };
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// A tested merge commit, as `refs/pull/N/merge`: main advances after the
// branch point, so a correct selector must compare with main, not the branch.
function pullRequestMerge(changed: string[], options: { renameFrom?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "echo-ci-select-"));
  repositories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  write(root, "README.md", "base\n");
  if (options.renameFrom) write(root, options.renameFrom, "moved\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
  git("checkout", "--quiet", "-b", "feature");
  if (options.renameFrom) git("rm", "--quiet", options.renameFrom);
  for (const path of changed) write(root, path, `changed ${path}\n`);
  git("add", "--all");
  git("commit", "--quiet", "--message", "feature");
  const head = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "main");
  write(root, "product/echo-desktop/MAIN.md", "main moved on\n");
  write(root, "src/product/person-client/MAIN.md", "main moved on\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "main");
  git("merge", "--quiet", "--no-ff", "--no-edit", "feature");
  const sha = git("rev-parse", "HEAD");
  const base = git("rev-parse", "HEAD^1");
  return {
    sha,
    head,
    base,
    baseTree: git("rev-parse", "HEAD^1^{tree}"),
    git: gitIn(root),
    event: { pull_request: { base: { ref: "main" }, head: { sha: head } } },
  };
}

type Merge = ReturnType<typeof pullRequestMerge>;

// An Authority-only change deselects both jobs; the cases below share one.
let authorityMerge: Merge | undefined;
const authorityOnly = () => (authorityMerge ??= pullRequestMerge(["services/organization-authority/src/index.ts"]));

// Selects for a merge whose main base passed, unless `change` alters that.
async function selectFor(merge: Merge, change: (fixture: Fixture) => void = () => {}, input: Record<string, unknown> = {}) {
  const fixture = greenCheck(merge.base, merge.baseTree);
  change(fixture);
  const github = githubFixture(fixture);
  const selection = await selectJobs({
    eventName: "pull_request",
    event: merge.event, sha: merge.sha, repository: REPOSITORY, git: merge.git, api: github.api, sleep: github.sleep,
    ...input,
  });
  return { selection, requested: github.requested, delays: github.delays };
}

async function selectPaths(changed: string[]) {
  return (await selectFor(pullRequestMerge(changed))).selection;
}

describe("pull-request job selection", () => {
  it("skips the desktop and Person-client package jobs for an Authority-only change (#277)", async () => {
    const selection = await selectPaths([
      "docs/architecture/connector-contracts.md",
      "services/organization-authority/src/application/ports/person-slack-reader-v1.ts",
      "services/organization-authority/src/composition/person-answer-v3-route.ts",
      "services/organization-authority/test/person-answer-v3-http.test.ts",
    ]);
    expect(selection.mode).toBe("pull-request");
    expect(selection.jobs).toEqual({
      check: true,
      docs: false,
      person_client_package: false,
      desktop_app: false,
      authority_recovery_infrastructure: true,
    });
  });

  it("selects the desktop app alone for a desktop-only change (#299)", async () => {
    const selection = await selectPaths([
      "product/echo-desktop/README.md",
      "product/echo-desktop/src/renderer/screens/home.tsx",
      "product/echo-desktop/test/e2e/projects.spec.ts",
    ]);
    expect(selection.jobs).toEqual({ ...EVERY_JOB, person_client_package: false });
  });

  const changes: Array<[string, boolean, boolean]> = [
    ["src/product/person-client/main.ts", true, true],
    ["packages/organization-api/src/index.ts", true, true],
    ["providers/jira/client/src/index.ts", true, true],
    ["packages/organization-record/package.json", true, true],
    ["providers/slack/server/package.json", true, true],
    ["npm-shrinkwrap.json", true, true],
    ["tsconfig.build.json", true, true],
    ["services/organization-authority/.gitignore", true, true],
    [".github/workflows/ci.yml", true, true],
    ["tools/ci-select-jobs.mjs", true, true],
    ["tools/ci-runner-info.mjs", true, false],
    ["tests/fixtures/project-context-v1/operations.json", true, false],
    ["deploy/release/start-person-cli-kit-macos.sh", false, true],
    ["deploy/organization-authority/Caddyfile.clean-v1.ec2", false, true],
    ["deploy/organization-authority/compose.clean-v1.yaml", false, true],
    ["tests/person-client/client-update.test.ts", false, true],
    ["tests/support/test-canonical-json.ts", false, true],
    ["vitest.config.ts", false, true],
    ["packages/organization-record/src/index.ts", false, false],
    ["providers/slack/server/src/index.ts", false, false],
    ["deploy/organization-authority/Dockerfile", false, false],
    ["tests/person-client/other.test.ts", false, false],
    ["tools/check-docs.mjs", false, false],
    ["docs/operations/RB-OPERATIONS-003-protect-canonical-source-and-releases.md", false, false],
  ];
  it("matches each job's inputs with the pathspecs git diff uses", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-ci-select-paths-"));
    repositories.push(root);
    for (const [path] of changes) write(root, path, "# changed\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["add", "--all"], { cwd: root, env: GIT_ENV });
    const [desktop, personClientPackage] = [JOB_INPUTS.desktop_app, JOB_INPUTS.person_client_package]
      .map((paths) => execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: root, encoding: "utf8" }))
      .map((listed) => new Set(listed.split("\0")));
    for (const [path, inDesktop, inPersonClientPackage] of changes) {
      expect({ path, desktop: desktop!.has(path), personClientPackage: personClientPackage!.has(path) })
        .toEqual({ path, desktop: inDesktop, personClientPackage: inPersonClientPackage });
    }
  });

  it("selects the desktop app when a file moves out of its inputs", async () => {
    const merge = pullRequestMerge(["services/organization-authority/src/moved.ts"], {
      renameFrom: "product/echo-desktop/src/moved.ts",
    });
    expect((await selectFor(merge)).selection.jobs.desktop_app).toBe(true);
  });

  it("selects every job unless the checkout is the tested merge of a pull request into main", async () => {
    const merge = authorityOnly();
    const event = merge.event;
    for (const [reason, input] of [
      ["stacked", { event: { pull_request: { ...event.pull_request, base: { ref: "feat/base" } } } }],
      ["no pull request", { event: {} }],
      ["head moved", { event: { pull_request: { ...event.pull_request, head: { sha: "f".repeat(40) } } } }],
      ["not the checkout", { sha: merge.head }],
      ["short sha", { sha: merge.sha.slice(0, 12) }],
    ] as const) {
      const { selection, requested } = await selectFor(merge, undefined, input);
      expect(selection, reason).toMatchObject({ mode: "full", jobs: EVERY_JOB });
      expect(requested, reason).toEqual([]);
    }
  });

  it("selects every job for a single-parent commit or a git failure", async () => {
    const merge = authorityOnly();
    expect((await selectFor(merge, undefined, {
      event: { pull_request: { base: { ref: "main" }, head: { sha: merge.base } } },
      git: (args: readonly string[]) => args[0] === "rev-list" ? { status: 0, stdout: `${merge.sha} ${merge.base}` } : merge.git(args),
    })).selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    const failing = await selectJobs({
      eventName: "pull_request",
      event: merge.event,
      sha: merge.sha,
      repository: REPOSITORY,
      git: (args) => args[0] === "diff" ? { status: 128, stdout: "" } : merge.git(args),
      api: async () => { throw new Error("unused"); },
    });
    expect(failing).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(failing.reason).toContain("selection failed");
  });

  it("deselects a job only when main's required check passed on the base tree", async () => {
    const merge = authorityOnly();
    const { selection, requested, delays } = await selectFor(merge);
    expect(selection).toMatchObject({ mode: "pull-request", jobs: { desktop_app: false, person_client_package: false } });
    expect(requested.sort()).toEqual(Object.keys(greenCheck(merge.base, merge.baseTree)).sort());
    expect(delays).toEqual([]);
  });

  it("reads nothing from GitHub when the change selects every job anyway", async () => {
    const { selection, requested } = await selectFor(pullRequestMerge(["src/product/person-client/main.ts"]));
    expect(selection).toMatchObject({ mode: "pull-request", jobs: EVERY_JOB });
    expect(requested).toEqual([]);
  });

  it("waits for main's required check to finish, then selects every job if it never does", async () => {
    const merge = authorityOnly();
    let reads = 0;
    const finishing = await selectFor(merge, (fixture) => {
      const green = fixture[checksPath(merge.base)];
      const running = structuredClone(green);
      running.check_runs[0].status = "in_progress";
      running.check_runs[0].conclusion = null;
      // GitHub reports the aggregate only once its dependencies finish.
      fixture[checksPath(merge.base)] = () => [{ total_count: 0, check_runs: [] }, running][reads++] ?? green;
    });
    expect(finishing.selection).toMatchObject({ mode: "pull-request", jobs: { desktop_app: false } });
    expect(finishing.delays).toEqual([15_000, 15_000]);
    const running = await selectFor(merge, (fixture) => {
      const run = fixture[checksPath(merge.base)].check_runs[0];
      run.status = "in_progress";
      run.conclusion = null;
    });
    expect(running.selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(running.delays).toEqual([15_000, 15_000, 30_000, 30_000, 30_000, 30_000]);
    expect(running.delays.reduce((total, delay) => total + delay, 0)).toBe(150_000);
  });

  type BaseCase = [string, (fixture: Fixture, merge: Merge) => void, number];
  const unverifiedBases: BaseCase[] = [
    ["a red base", (fixture, merge) => { fixture[checksPath(merge.base)].check_runs[0].conclusion = "failure"; }, 0],
    ["a cancelled base", (fixture, merge) => { fixture[checksPath(merge.base)].check_runs[0].conclusion = "cancelled"; }, 0],
    ["a base with no check", (fixture, merge) => { fixture[checksPath(merge.base)] = { total_count: 0, check_runs: [] }; }, 6],
    ["an API error", (fixture, merge) => { fixture[checksPath(merge.base)] = new Error("GitHub API returned 502"); }, 0],
    ["a base check from another app", (fixture, merge) => { fixture[checksPath(merge.base)].check_runs[0].app.id = 1; }, 0],
    ["a base check that tested another tree", (fixture) => { fixture[annotationsPath(7)][1].message = "f".repeat(40); }, 0],
    ["a base check that recorded no tree", (fixture) => { fixture[annotationsPath(7)].pop(); }, 0],
  ];
  it.each(unverifiedBases)("selects every job for %s", async (_name, change, waits) => {
    const merge = authorityOnly();
    const { selection, delays } = await selectFor(merge, (fixture) => change(fixture, merge));
    expect(selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(delays).toHaveLength(waits);
  });

  it("selects every job for a manual dispatch or any other event", async () => {
    for (const eventName of ["workflow_dispatch", "schedule", "merge_group"]) {
      const selection = await selectJobs({
        eventName,
        event: {},
        sha: "a".repeat(40),
        repository: "EchoBrain-org/echo-brain",
        git: () => { throw new Error("unused"); },
        api: async () => { throw new Error("unused"); },
      });
      expect(selection, eventName).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    }
  });
});

describe("plan outputs", () => {
  it("writes every job output and the tree that every job checks out", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-ci-select-output-"));
    repositories.push(root);
    writeFileSync(join(root, "event.json"), "{}");
    const revision = (spec: string) => execFileSync("git", ["rev-parse", spec], { cwd: REPO, encoding: "utf8" }).trim();
    execFileSync(process.execPath, [join(REPO, "tools/ci-select-jobs.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_SHA: revision("HEAD"),
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_API_URL: "http://127.0.0.1:9",
        GITHUB_TOKEN: "unused",
      },
    });
    expect(readFileSync(join(root, "output"), "utf8").split("\n")).toEqual([
      "mode=full",
      `tree=${revision("HEAD^{tree}")}`,
      ...JOB_OUTPUTS.map((job) => `${job}=${EVERY_JOB[job]}`),
      "",
    ]);
  });
});

describe("verified main push", () => {
  const repository = REPOSITORY;
  const before = "b".repeat(40);
  const sha = "c".repeat(40);
  const head = "d".repeat(40);
  const tree = "e".repeat(40);
  const event = { ref: "refs/heads/main", before, after: sha, forced: false };

  function responses(): Fixture {
    return {
      [`/repos/${repository}/commits/${sha}/pulls?per_page=100`]: [
        { number: 301, merged_at: "2026-10-09T00:00:00Z", merge_commit_sha: sha, base: { ref: "main" }, head: { sha: head } },
      ],
      [`/repos/${repository}/git/commits/${sha}`]: { sha, tree: { sha: tree } },
      [`/repos/${repository}/git/commits/${head}`]: { sha: head, tree: { sha: tree } },
      ...greenCheck(head, tree),
    };
  }

  async function verify(change: (fixture: Fixture) => void = () => {}, input: Record<string, unknown> = {}) {
    const fixture = responses();
    change(fixture);
    const github = githubFixture(fixture);
    const selection = await selectJobs({
      eventName: "push",
      event,
      sha,
      repository,
      git: () => { throw new Error("unused"); },
      api: github.api,
      sleep: github.sleep,
      ...input,
    });
    return { selection, requested: github.requested, delays: github.delays };
  }

  it("runs only the docs proof for a tree already green on its merged pull-request head", async () => {
    const { selection, delays } = await verify();
    expect(selection).toMatchObject({
      mode: "verified-main",
      jobs: {
        check: false,
        docs: true,
        person_client_package: false,
        desktop_app: false,
        authority_recovery_infrastructure: false,
      },
    });
    expect(selection.reason).toContain("#301");
    expect(delays).toEqual([]);
  });

  it("waits for GitHub to associate a fresh merge commit with its pull request", async () => {
    const pulls = `/repos/${repository}/commits/${sha}/pulls?per_page=100`;
    let lookups = 0;
    const { selection, delays } = await verify((fixture) => {
      const merged = fixture[pulls];
      fixture[pulls] = () => (++lookups === 1 ? [] : merged);
    });
    expect(selection.mode).toBe("verified-main");
    expect(delays).toEqual([5_000]);
    const missing = await verify((fixture) => { fixture[pulls] = []; });
    expect(missing.selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(missing.delays).toEqual([5_000, 15_000]);
  });

  const pull = (fixture: Fixture) => fixture[`/repos/${repository}/commits/${sha}/pulls?per_page=100`][0];
  const checks = (fixture: Fixture) => fixture[checksPath(head)];
  const run = (fixture: Fixture) => checks(fixture).check_runs[0];
  const tested = (fixture: Fixture) => fixture[annotationsPath(7)];
  const unverifiable: Array<[string, (fixture: Fixture) => void]> = [
    ["an unmerged pull request", (fixture: Fixture) => { pull(fixture).merged_at = null; }],
    ["another merge commit", (fixture: Fixture) => { pull(fixture).merge_commit_sha = head; }],
    ["a pull request into another branch", (fixture: Fixture) => { pull(fixture).base.ref = "release"; }],
    ["two merged pull requests", (fixture: Fixture) => {
      const pulls = fixture[`/repos/${repository}/commits/${sha}/pulls?per_page=100`];
      pulls.push({ ...pulls[0], number: 302 });
    }],
    ["a malformed head", (fixture: Fixture) => { pull(fixture).head.sha = "main"; }],
    ["a different tree", (fixture: Fixture) => {
      fixture[`/repos/${repository}/git/commits/${head}`].tree.sha = "f".repeat(40);
    }],
    // A stacked pull request's run tested a merge with its other base.
    ["a green run that tested a merge with another base", (fixture: Fixture) => {
      tested(fixture)[1].message = "f".repeat(40);
    }],
    ["a green run that recorded no tested tree", (fixture: Fixture) => { tested(fixture).pop(); }],
    ["a green run that recorded two trees", (fixture: Fixture) => { tested(fixture).push(tested(fixture)[1]); }],
    ["a tested tree recorded as a warning", (fixture: Fixture) => { tested(fixture)[1].annotation_level = "warning"; }],
    ["a failed required check", (fixture: Fixture) => { run(fixture).conclusion = "failure"; }],
    ["a running required check", (fixture: Fixture) => {
      run(fixture).status = "in_progress";
      run(fixture).conclusion = null;
    }],
    ["a required check from another app", (fixture: Fixture) => { run(fixture).app.id = 1; }],
    ["no required check", (fixture: Fixture) => { fixture[checksPath(head)] = { total_count: 0, check_runs: [] }; }],
    ["a second failed required check", (fixture: Fixture) => {
      checks(fixture).check_runs.push({ ...run(fixture), id: 8, conclusion: "failure" });
      checks(fixture).total_count = 2;
    }],
    ["a second green run on another tree", (fixture: Fixture) => {
      checks(fixture).check_runs.push({ ...run(fixture), id: 8 });
      checks(fixture).total_count = 2;
      fixture[annotationsPath(8)] = [{ annotation_level: "notice", title: TESTED_TREE, message: "f".repeat(40) }];
    }],
    ["an unread page of checks", (fixture: Fixture) => { checks(fixture).total_count = 101; }],
    ["an API error", (fixture: Fixture) => { fixture[checksPath(head)] = new Error("GitHub API returned 502"); }],
    ["an annotations API error", (fixture: Fixture) => { fixture[annotationsPath(7)] = new Error("GitHub API returned 502"); }],
  ];
  it.each(unverifiable)("selects every job for %s", async (_name, change) => {
    const { selection } = await verify(change);
    expect(selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
  });

  const pushes: Array<[string, Record<string, unknown>]> = [
    ["a forced push", { ...event, forced: true }],
    ["a push without the forced flag", { ref: event.ref, before, after: sha }],
    ["another branch", { ...event, ref: "refs/heads/release" }],
    ["a created branch", { ...event, before: "0".repeat(40) }],
    ["a stale event", { ...event, after: head }],
  ];
  it.each(pushes)("selects every job for %s without calling GitHub", async (_name, pushed) => {
    const { selection, requested } = await verify(undefined, { event: pushed });
    expect(selection).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(requested).toEqual([]);
  });

  it("reads the pull request, both trees, and the head's required check with the tree it tested", async () => {
    const fixture = responses();
    const requested: string[] = [];
    const selection = await verifyMainPush({
      event,
      sha,
      repository,
      api: async (path) => { requested.push(path); return structuredClone(fixture[path]); },
      sleep: async () => {},
    });
    expect(selection.mode).toBe("verified-main");
    expect(requested.sort()).toEqual(Object.keys(fixture).sort());
  });
});

describe("job input closures", () => {
  const tracked = (paths: readonly string[]) => new Set(
    execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: REPO, encoding: "utf8" })
      .split("\0").filter(Boolean),
  );
  const inputs = {
    desktop_app: tracked(JOB_INPUTS.desktop_app),
    person_client_package: tracked(JOB_INPUTS.person_client_package),
  };

  const repositoryFiles = [...tracked([])];
  const trackedAt = (path: string) =>
    repositoryFiles.filter((file) => file === path || file.startsWith(`${path}/`));

  // A path is covered when every tracked file at or below it, or below its
  // nearest tracked ancestor for build output, is a job input.
  function expectCovered(job: keyof typeof inputs, path: string) {
    let files = trackedAt(path);
    for (let parent = path; files.length === 0 && parent !== "."; parent = posix.dirname(parent)) {
      files = trackedAt(posix.dirname(parent));
    }
    expect(files.length, path).toBeGreaterThan(0);
    for (const file of files) expect(inputs[job].has(file), `${job} input ${file} (from ${path})`).toBe(true);
  }

  function jobSteps(id: string) {
    const start = WORKFLOW.indexOf(`\n  ${id}:\n`) + 1;
    expect(start).toBeGreaterThan(0);
    return WORKFLOW.slice(start, start + WORKFLOW.slice(start).search(/\n  [a-z-]+:\n/) + 1);
  }

  const rootManifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const workspaceByName = new Map<string, string>(rootManifest.workspaces.map((workspace: string) => [
    JSON.parse(readFileSync(join(REPO, workspace, "package.json"), "utf8")).name,
    workspace,
  ]));

  function personClientClosure() {
    const closure = new Set<string>();
    const visit = (workspace: string) => {
      if (closure.has(workspace)) return;
      closure.add(workspace);
      const config = JSON.parse(readFileSync(join(REPO, workspace, "tsconfig.json"), "utf8"));
      for (const reference of config.references ?? []) visit(posix.join(workspace, reference.path));
    };
    visit("src/product/person-client");
    return [...closure];
  }

  it("treats the install, build configuration, workflow, and selector as inputs of both jobs", () => {
    for (const job of ["desktop_app", "person_client_package"] as const) {
      for (const path of [
        ".github/workflows/ci.yml",
        "tools/ci-select-jobs.mjs",
        "package.json",
        "npm-shrinkwrap.json",
        "tsconfig.build.json",
        ".gitignore",
        "tools/build.mjs",
        "tools/pack-person-client.mjs",
        ...rootManifest.workspaces.map((workspace: string) => `${workspace}/package.json`),
      ]) expectCovered(job, path);
    }
  });

  it("covers the Person-client build closure in both jobs", () => {
    const build = readFileSync(join(REPO, "tools/build.mjs"), "utf8");
    const listed = build.slice(build.indexOf("const personClientWorkspaces = ["), build.indexOf("];", build.indexOf("const personClientWorkspaces")));
    const built = [...listed.matchAll(/\[('[^\]]+')\]/g)].map((match) =>
      match[1]!.split(",").map((part) => part.trim().slice(1, -1)).join("/"));
    expect(built).toHaveLength(7);
    expect(new Set(personClientClosure())).toEqual(new Set(built));
    for (const job of ["desktop_app", "person_client_package"] as const) {
      for (const workspace of built) expectCovered(job, workspace);
    }
  });

  it("covers everything the desktop job reads outside the desktop app", () => {
    const desktop = jobSteps("desktop-app");
    for (const path of desktop.match(/tools\/[a-z0-9-]+\.mjs/g) ?? []) expectCovered("desktop_app", path);
    const sources = execFileSync("git", ["ls-files", "--", "product/echo-desktop/src", "product/echo-desktop/test", "product/echo-desktop/scripts"], { cwd: REPO, encoding: "utf8" })
      .split("\n").filter(Boolean);
    const packages = new Set<string>();
    for (const source of sources) {
      const text = readFileSync(join(REPO, source), "utf8");
      for (const match of text.matchAll(/['"](@echo-brain\/[a-z-]+)/g)) packages.add(match[1]!);
      for (const match of text.matchAll(/join\(repository, '([^']+)'\)/g)) expectCovered("desktop_app", match[1]!);
      for (const match of text.matchAll(/\['(tools\/[^']+)'/g)) expectCovered("desktop_app", match[1]!);
    }
    expect(packages.size).toBeGreaterThan(0);
    for (const name of packages) expectCovered("desktop_app", workspaceByName.get(name)!);
    expectCovered("desktop_app", "tests/fixtures/project-context-v1/operations.json");
    expectCovered("desktop_app", "product/echo-desktop/package-lock.json");
  });

  it("covers every committed source the Person-client package job runs", async () => {
    const steps = jobSteps("person-client-package");
    for (const path of steps.match(/(?:tests|tools)\/[A-Za-z0-9/._-]+\.(?:mjs|ts)/g) ?? []) {
      expectCovered("person_client_package", path);
    }
    for (const script of steps.match(/npm run ([a-z:-]+)/g) ?? []) {
      const command: string = rootManifest.scripts[script.slice("npm run ".length)];
      expect(command, script).toMatch(/^node [a-z0-9/.-]+\.mjs/);
      expectCovered("person_client_package", command.split(" ")[1]!);
    }
    const { RUNTIME_PROFILE_FILES } = await import(pathToFileURL(join(REPO, "tools/clean-v1-runtime-profile.mjs")).href) as {
      RUNTIME_PROFILE_FILES: readonly string[];
    };
    for (const file of RUNTIME_PROFILE_FILES) expectCovered("person_client_package", `deploy/organization-authority/${file}`);
    const committed = readFileSync(join(REPO, "deploy/release/create-person-onboarding-kit.mjs"), "utf8");
    for (const match of committed.matchAll(/'((?:deploy|tools)\/[^']+)'/g)) expectCovered("person_client_package", match[1]!);
    for (const test of [
      "tests/architecture/mac-person-cli-kit.test.ts",
      "tests/architecture/client-update-dispatch.test.ts",
      "tests/person-client/client-update.test.ts",
    ]) {
      expect(steps).toContain(test);
      const text = readFileSync(join(REPO, test), "utf8");
      for (const match of text.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
        expectCovered("person_client_package", posix.join(posix.dirname(test), match[1]!).replace(/\.js$/, ".ts"));
      }
      for (const match of text.matchAll(/['"]((?:deploy|tools|src)\/[A-Za-z0-9/._-]+)['"]/g)) {
        expectCovered("person_client_package", match[1]!);
      }
    }
    expectCovered("person_client_package", "vitest.config.ts");
    expectCovered("person_client_package", "tsconfig.json");
  });
});
