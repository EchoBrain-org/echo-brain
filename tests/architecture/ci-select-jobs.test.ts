import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  JOB_INPUTS,
  REQUIRED_CHECK,
  gitIn,
  selectJobs,
  selectPullRequestJobs,
  verifyMainPush,
} from "../../tools/ci-select-jobs.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
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
afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

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
  return {
    sha,
    head,
    git: gitIn(root),
    event: { pull_request: { base: { ref: "main" }, head: { sha: head } } },
  };
}

function selectPaths(changed: string[]) {
  const merge = pullRequestMerge(changed);
  return selectPullRequestJobs({ event: merge.event, sha: merge.sha, git: merge.git });
}

describe("pull-request job selection", () => {
  it("skips the desktop and Person-client package jobs for an Authority-only change (#277)", () => {
    const selection = selectPaths([
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

  it("selects the desktop app alone for a desktop-only change (#299)", () => {
    const selection = selectPaths([
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

  it("selects the desktop app when a file moves out of its inputs", () => {
    const merge = pullRequestMerge(["services/organization-authority/src/moved.ts"], {
      renameFrom: "product/echo-desktop/src/moved.ts",
    });
    expect(selectPullRequestJobs({ event: merge.event, sha: merge.sha, git: merge.git }).jobs.desktop_app)
      .toBe(true);
  });

  it("selects every job unless the checkout is the tested merge of a pull request into main", () => {
    const merge = pullRequestMerge(["services/organization-authority/src/index.ts"]);
    const event = merge.event;
    for (const [reason, input] of [
      ["stacked", { event: { pull_request: { ...event.pull_request, base: { ref: "feat/base" } } }, sha: merge.sha }],
      ["no pull request", { event: {}, sha: merge.sha }],
      ["head moved", { event: { pull_request: { ...event.pull_request, head: { sha: "f".repeat(40) } } }, sha: merge.sha }],
      ["not the checkout", { event, sha: merge.head }],
      ["short sha", { event, sha: merge.sha.slice(0, 12) }],
    ] as const) {
      expect(selectPullRequestJobs({ ...input, git: merge.git }), reason)
        .toMatchObject({ mode: "full", jobs: EVERY_JOB });
    }
  });

  it("selects every job for a single-parent commit or a git failure", async () => {
    const merge = pullRequestMerge(["services/organization-authority/src/index.ts"]);
    const first = merge.git(["rev-parse", "HEAD^1"]).stdout;
    expect(selectPullRequestJobs({
      event: { pull_request: { base: { ref: "main" }, head: { sha: first } } },
      sha: merge.sha,
      git: (args) => args[0] === "rev-list" ? { status: 0, stdout: `${merge.sha} ${first}` } : merge.git(args),
    })).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    const failing = await selectJobs({
      eventName: "pull_request",
      event: merge.event,
      sha: merge.sha,
      repository: "EchoBrain-org/echo-brain",
      git: (args) => args[0] === "diff" ? { status: 128, stdout: "" } : merge.git(args),
      api: async () => { throw new Error("unused"); },
    });
    expect(failing).toMatchObject({ mode: "full", jobs: EVERY_JOB });
    expect(failing.reason).toContain("selection failed");
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

describe("verified main push", () => {
  const repository = "EchoBrain-org/echo-brain";
  const before = "b".repeat(40);
  const sha = "c".repeat(40);
  const head = "d".repeat(40);
  const tree = "e".repeat(40);
  const event = { ref: "refs/heads/main", before, after: sha, forced: false };
  const checksPath = `/repos/${repository}/commits/${head}/check-runs?check_name=CI%20required%20checks&filter=latest&per_page=100`;

  function responses(): Record<string, any> {
    return {
      [`/repos/${repository}/commits/${sha}/pulls?per_page=100`]: [
        { number: 301, merged_at: "2026-10-09T00:00:00Z", merge_commit_sha: sha, base: { ref: "main" }, head: { sha: head } },
      ],
      [`/repos/${repository}/git/commits/${sha}`]: { sha, tree: { sha: tree } },
      [`/repos/${repository}/git/commits/${head}`]: { sha: head, tree: { sha: tree } },
      [`/repos/${repository}/compare/${before}...${head}?per_page=1`]: { status: "ahead" },
      [checksPath]: {
        total_count: 1,
        check_runs: [{
          name: REQUIRED_CHECK, head_sha: head, app: { id: 15368, slug: "github-actions" },
          status: "completed", conclusion: "success",
        }],
      },
    };
  }

  async function verify(change: (fixture: Record<string, any>) => void = () => {}, input: Record<string, unknown> = {}) {
    const fixture = responses();
    change(fixture);
    const requested: string[] = [];
    const delays: number[] = [];
    const selection = await selectJobs({
      eventName: "push",
      event,
      sha,
      repository,
      git: () => { throw new Error("unused"); },
      api: async (path) => {
        requested.push(path);
        const value = fixture[path];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`unexpected ${path}`);
        return typeof value === "function" ? value() : structuredClone(value);
      },
      sleep: async (ms) => { delays.push(ms); },
      ...input,
    });
    return { selection, requested, delays };
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

  type Fixture = Record<string, any>;
  const pull = (fixture: Fixture) => fixture[`/repos/${repository}/commits/${sha}/pulls?per_page=100`][0];
  const run = (fixture: Fixture) => fixture[checksPath].check_runs[0];
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
    ["a head behind the previous main", (fixture: Fixture) => {
      fixture[`/repos/${repository}/compare/${before}...${head}?per_page=1`].status = "diverged";
    }],
    ["a failed required check", (fixture: Fixture) => { run(fixture).conclusion = "failure"; }],
    ["a running required check", (fixture: Fixture) => {
      run(fixture).status = "in_progress";
      run(fixture).conclusion = null;
    }],
    ["a required check from another app", (fixture: Fixture) => { run(fixture).app.id = 1; }],
    ["no required check", (fixture: Fixture) => { fixture[checksPath] = { total_count: 0, check_runs: [] }; }],
    ["a second failed required check", (fixture: Fixture) => {
      fixture[checksPath].check_runs.push({ ...run(fixture), conclusion: "failure" });
      fixture[checksPath].total_count = 2;
    }],
    ["an unread page of checks", (fixture: Fixture) => { fixture[checksPath].total_count = 101; }],
    ["an API error", (fixture: Fixture) => { fixture[checksPath] = new Error("GitHub API returned 502"); }],
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

  it("reads the pull request, both trees, the head ancestry, and the head's required check", async () => {
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
