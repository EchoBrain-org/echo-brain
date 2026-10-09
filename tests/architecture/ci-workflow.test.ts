import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_OUTPUTS } from "../../tools/ci-select-jobs.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const DOCKERFILE = resolve(REPO, "deploy/organization-authority/Dockerfile");
const RECOVERY_VALIDATOR = resolve(
  REPO,
  "tools/validate-authority-recovery-templates.mjs",
);

const source = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");

function between(from: string, to: string) {
  return source.slice(source.indexOf(from), source.indexOf(to));
}

const JOBS = source.indexOf("\njobs:\n");
const jobIds = [...source.slice(JOBS).matchAll(/^  ([a-z-]+):$/gm)].map((match) => match[1]);

function job(id: string) {
  const start = source.indexOf(`\n  ${id}:\n`, JOBS) + 1;
  expect(start, id).toBeGreaterThan(JOBS);
  const end = source.slice(start).search(/\n  [a-z-]+:\n/);
  return end === -1 ? source.slice(start) : source.slice(start, start + end + 1);
}

function gate(id: string) {
  return job(id).match(/^    (?:needs|if): .*$/gm) ?? [];
}

function aggregate(env: Record<string, string>) {
  const script = job("required-checks").split("        run: |\n")[1]!.replace(/^ {10}/gm, "");
  return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" }).status;
}

function dependencyInputs(dockerfile: string) {
  const dependencyInstall = dockerfile.indexOf("RUN npm ci");
  expect(dependencyInstall).toBeGreaterThan(0);
  return [
    ...dockerfile
      .slice(0, dependencyInstall)
      .matchAll(/^COPY\s+(.+?)\s+\.\/.*$/gm),
  ]
    .flatMap((match) => match[1].split(/\s+/))
    .filter(Boolean);
}

describe("CI workflow", () => {
  it("runs the research-loop evaluator as an unconditional required proof", () => {
    const check = job("check");
    const steps = check.split(/(?=^      - )/m);
    const research = steps.find((step) => step.includes("run: npm run test:research-loop-eval"));
    expect(research).toBeDefined();
    expect(research).not.toMatch(/if:|continue-on-error:/);
  });

  it("pins Ubuntu and prevents the dependency-free jobs from owning npm caches", () => {
    expect(source).not.toContain("ubuntu-latest");
    for (const id of ["plan", "docs", "authority-recovery-infrastructure"]) {
      const dependencyFree = job(id);
      expect(dependencyFree, id).toContain("package-manager-cache: false");
      expect(dependencyFree, id).not.toMatch(/cache: npm|npm ci/);
    }
  });

  it("retains bounded test diagnostics after failures without uploading builds or homes", () => {
    const uploads = source.split(/(?=^      - )/m)
      .filter((step) => step.includes("uses: actions/upload-artifact@"));
    expect(uploads).toHaveLength(2);
    for (const step of uploads) {
      expect(step).toContain("if: ${{ !cancelled() }}");
      expect(step).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
      expect(step).toContain("retention-days: 7");
      expect(step).toContain("github.run_attempt");
      expect(step).not.toMatch(/include-hidden-files|overwrite:|continue-on-error/);
    }
    expect(uploads[0]).toMatch(/path: \$\{\{ env.ECHO_CI_REPORT_DIR \}\}\n/);
    expect(uploads[1]).toMatch(/path: \|\n            \$\{\{ env.ECHO_CI_REPORT_DIR \}\}\n            product\/echo-desktop\/test-results\n/);
    expect(uploads[1]).toContain("runner.os");
    expect(uploads[1]).toContain("runner.arch");
  });

  it("only cancels superseded pull-request runs", () => {
    const concurrency = between("concurrency:", "permissions:");

    expect(concurrency).toContain("github.event_name == 'pull_request'");
    expect(concurrency).toContain("github.run_id");
    expect(concurrency).not.toContain(
      "github.event.pull_request.number || github.ref",
    );
    expect(concurrency).toMatch(
      /cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/,
    );
  });

  it("keeps pull-request BuildKit cache entries separate from canonical runs", () => {
    const build = between(
      "- name: Build the clean V1 authority image",
      "- name: Assert the authority image build left the checkout clean",
    );
    const prScope = "format('pr-{0}', github.event.pull_request.number)";
    const refScope = "format('ref-{0}', github.ref_name)";

    expect(build).toContain(
      "cache-from: type=gha,scope=authority-container-arm64-",
    );
    expect(build).toContain(
      "cache-to: type=gha,mode=max,scope=authority-container-arm64-",
    );
    expect(build).toContain(prScope);
    expect(build).toContain(refScope);
    expect(build).not.toContain("scope=authority-container-arm64\n");
  });

  it("exposes one stable aggregate required-check name over every job", () => {
    const required = job("required-checks");
    expect(source).toMatch(/required-checks:\s*\n\s+name: CI required checks/);
    expect(required).toContain("    if: ${{ always() }}\n");
    expect(required).toContain(
      "    needs: [plan, check, docs, person-client-package, desktop-app, authority-container, authority-recovery-infrastructure]\n",
    );
    expect(jobIds).toEqual([
      "plan", "check", "docs", "person-client-package", "desktop-app",
      "authority-container", "authority-recovery-infrastructure", "required-checks",
    ]);
    expect(required).toContain('test "$PLAN_RESULT" = success');
    expect(required).toContain('selected "$CHECK_RESULT" "$CHECK_SELECTED"');
    expect(required).toContain('selected "$DOCS_RESULT" "$DOCS_SELECTED"');
    expect(required).toContain(
      'selected "$PERSON_CLIENT_PACKAGE_RESULT" "$PERSON_CLIENT_PACKAGE_SELECTED"',
    );
    expect(required).toContain('selected "$DESKTOP_APP_RESULT" "$DESKTOP_APP_SELECTED"');
    expect(required).toContain('test "$AUTHORITY_CONTAINER_RESULT" = success');
    expect(required).toContain(
      'selected "$AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT" "$AUTHORITY_RECOVERY_INFRASTRUCTURE_SELECTED"',
    );
    expect(required).toContain(
      '            case "$2" in\n              true) test "$1" = success ;;\n              false) test "$1" = skipped ;;\n              *) return 1 ;;\n            esac\n',
    );
    for (const output of JOB_OUTPUTS) {
      const variable = output.toUpperCase();
      expect(required).toContain(`${variable}_SELECTED: \${{ needs.plan.outputs.${output} }}`);
      expect(required).toContain(`selected "$${variable}_RESULT" "$${variable}_SELECTED"`);
    }
  });

  it("accepts a skipped job only when the plan deselected it", () => {
    const pullRequest = {
      PLAN_RESULT: "success",
      CHECK_RESULT: "success", CHECK_SELECTED: "true",
      DOCS_RESULT: "skipped", DOCS_SELECTED: "false",
      PERSON_CLIENT_PACKAGE_RESULT: "skipped", PERSON_CLIENT_PACKAGE_SELECTED: "false",
      DESKTOP_APP_RESULT: "success", DESKTOP_APP_SELECTED: "true",
      AUTHORITY_CONTAINER_RESULT: "success",
      AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT: "success", AUTHORITY_RECOVERY_INFRASTRUCTURE_SELECTED: "true",
    };
    const verifiedMain = {
      ...pullRequest,
      CHECK_RESULT: "skipped", CHECK_SELECTED: "false",
      DOCS_RESULT: "success", DOCS_SELECTED: "true",
      DESKTOP_APP_RESULT: "skipped", DESKTOP_APP_SELECTED: "false",
      AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT: "skipped", AUTHORITY_RECOVERY_INFRASTRUCTURE_SELECTED: "false",
    };
    expect(aggregate(pullRequest)).toBe(0);
    expect(aggregate(verifiedMain)).toBe(0);
    for (const failing of [
      { PLAN_RESULT: "failure" },
      { PLAN_RESULT: "cancelled" },
      { DESKTOP_APP_RESULT: "skipped" },
      { DESKTOP_APP_RESULT: "failure" },
      { DESKTOP_APP_RESULT: "cancelled" },
      { DESKTOP_APP_SELECTED: "" },
      { PERSON_CLIENT_PACKAGE_RESULT: "success" },
      { PERSON_CLIENT_PACKAGE_RESULT: "failure" },
      { PERSON_CLIENT_PACKAGE_SELECTED: "" },
      { CHECK_RESULT: "skipped" },
      { DOCS_RESULT: "success" },
      { AUTHORITY_CONTAINER_RESULT: "skipped" },
      { AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT: "skipped" },
    ]) {
      expect(aggregate({ ...pullRequest, ...failing }), JSON.stringify(failing)).not.toBe(0);
    }
    for (const failing of [
      { DOCS_RESULT: "skipped" },
      { DOCS_RESULT: "failure" },
      { CHECK_SELECTED: "" },
      { CHECK_RESULT: "failure" },
      { AUTHORITY_CONTAINER_RESULT: "failure" },
    ]) {
      expect(aggregate({ ...verifiedMain, ...failing }), JSON.stringify(failing)).not.toBe(0);
    }
  });

  it("plans job selection in one dependency-free job with read-only access", () => {
    const plan = job("plan");
    expect(plan).toContain("    name: Select CI jobs\n");
    expect(gate("plan")).toEqual([]);
    expect(plan).toContain(
      "    permissions:\n      contents: read\n      pull-requests: read\n      checks: read\n    outputs:\n",
    );
    for (const output of JOB_OUTPUTS) {
      expect(plan).toContain(`      ${output}: \${{ steps.select.outputs.${output} }}\n`);
    }
    expect(plan.match(/^      [a-z_]+: \$\{\{ steps\.select\.outputs\.[a-z_]+ \}\}$/gm)).toHaveLength(JOB_OUTPUTS.length);
    expect(plan).toContain("          fetch-depth: 2\n          persist-credentials: false\n");
    expect(plan).toContain(
      "        id: select\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n        run: node tools/ci-select-jobs.mjs\n",
    );
    expect(plan).not.toMatch(/secrets\.|continue-on-error/);
    expect(source.match(/permissions:/g)).toHaveLength(2);
    expect(source).toContain("\npermissions:\n  contents: read\n\nenv:\n");
  });

  it("gates proofs on the plan while check and the Authority container always run on pull requests", () => {
    expect(gate("check")).toEqual([
      "    needs: plan",
      "    if: ${{ !cancelled() && (github.event_name == 'pull_request' || needs.plan.outputs.check == 'true') }}",
    ]);
    expect(gate("authority-container")).toEqual([]);
    for (const [id, output] of [
      ["docs", "docs"],
      ["person-client-package", "person_client_package"],
      ["desktop-app", "desktop_app"],
      ["authority-recovery-infrastructure", "authority_recovery_infrastructure"],
    ]) {
      expect(gate(id), id).toEqual([
        "    needs: plan",
        `    if: \${{ needs.plan.outputs.${output} == 'true' }}`,
      ]);
    }
  });

  it("replaces check on a verified main push with only the history-dependent docs proof", () => {
    const docs = job("docs");
    expect(docs).toContain("    name: Documentation history\n");
    expect(docs).toContain("          fetch-depth: 0\n");
    expect(docs).toContain("        run: node tools/check-docs.mjs\n");
    expect(docs.split(/(?=^      - )/m)).toHaveLength(4);
    const scripts = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).scripts;
    expect(scripts["check:docs"]).toBe("node tools/check-docs.mjs");
    expect(scripts.check).toContain("npm run check:docs");
    expect(job("check")).toContain("      - run: npm run check\n");
  });

  it("executes exact recovery-template validation as an independent proof", () => {
    const validator = readFileSync(RECOVERY_VALIDATOR, "utf8");
    const recovery = job("authority-recovery-infrastructure");

    expect(recovery).toContain("name: Authority recovery infrastructure");
    expect(recovery).toContain(
      "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
    );
    expect(recovery).toContain('python-version: "3.10"');
    expect(recovery).toContain("npm run check:authority-recovery-infrastructure");
    for (const required of [
      "authority-current-host-recovery-v1.template.json",
      "authority-current-host-recovery-v1.guard",
      "authority-recovery-helper-v1.template.json",
      "authority-recovery-helper-v1.guard",
      "authority-staging-journey-explorer-v1.template.json",
      "authority-staging-journey-explorer-v1.guard",
      "authority-current-host-recovery-v1.validation-tools.json",
      "downloadVerified",
      '"--output-format"',
      '"--no-index"',
      '"--no-deps"',
      '"check"',
    ]) {
      expect(validator).toContain(required);
    }
  });

  it("makes the dependency install depend only on the lockfile and workspace manifests", () => {
    const source = readFileSync(DOCKERFILE, "utf8");
    const workspaces = JSON.parse(
      readFileSync(resolve(REPO, "package.json"), "utf8"),
    ).workspaces as string[];
    const expectedInputs = [
      "package.json",
      "npm-shrinkwrap.json",
      ...workspaces.map((workspace) => `${workspace}/package.json`),
    ];

    expect(dependencyInputs(source)).toEqual(expectedInputs);
    expect(source.indexOf("COPY packages ./packages")).toBeGreaterThan(
      source.indexOf("RUN npm ci"),
    );
    expect(
      source.indexOf(
        "COPY services/organization-authority ./services/organization-authority",
      ),
    ).toBeGreaterThan(source.indexOf("RUN npm ci"));
  });

  it("reuses the local harness after retaining the exact Authority-image proof", () => {
    const authorityJob = job("authority-container");

    expect(authorityJob).toContain("cache: npm");
    expect(authorityJob).toContain("- run: npm ci");
    expect(authorityJob).toContain(
      'npm run authority:local -- up "${authority_local_args[@]}"',
    );
    expect(authorityJob).toContain("--runtime-profile-sha256");
    expect(authorityJob).toContain("--no-build");
    // The Compose profile requires the Nango integration, and the harness a private Nango key.
    expect(authorityJob).toContain("export ECHO_CLEAN_NANGO_INTEGRATION=slack");
    expect(authorityJob).toContain('export ECHO_LOCAL_NANGO_SECRET_KEY_FILE="$RUNNER_TEMP/');
    expect(authorityJob).toContain('export ECHO_LOCAL_NANGO_INTEGRATION="$ECHO_CLEAN_NANGO_INTEGRATION"');
    expect(authorityJob).not.toContain("curl --connect-timeout");
    expect(authorityJob).not.toContain('data="$deployment/clean-data"');
    expect(authorityJob).not.toContain('docker compose --file "$compose" up');
    expect(authorityJob).not.toContain('docker compose --file "$compose" down');
    expect(
      authorityJob.match(
        /services\/organization-authority\/dist\/clean-reset-main\.js/g,
      ),
    ).toHaveLength(1);
    expect(authorityJob).toContain('test "$authority_architecture" = arm64');
    expect(authorityJob).toContain(
      'test "$authority_source_sha" = "$GITHUB_SHA"',
    );
    expect(authorityJob).toContain(
      'test "$authority_node_version" = "v$PRODUCT_NODE_VERSION"',
    );
  });

  it("runs the macOS-only CLI-kit and update-dispatch proofs in the macOS Person-client job", () => {
    const personClientJob = job("person-client-package");

    expect(personClientJob).toContain(
      "tests/architecture/mac-person-cli-kit.test.ts",
    );
    expect(personClientJob).toContain(
      "tests/architecture/client-update-dispatch.test.ts",
    );
    expect(personClientJob).toContain("tests/person-client/client-update.test.ts");
    expect(source).not.toMatch(/swift|echo-overlay|echo-onboarding/i);
  });

  it("builds, verifies, and installs only the macOS command-line kit in the macOS Person-client job", () => {
    const personClientJob = job("person-client-package");
    const build = personClientJob.indexOf("npm run kit:person-onboarding --");
    const verify = personClientJob.indexOf(
      '"$kit_root/node" "$kit_root/verify-person-onboarding-kit.mjs" "$kit_root"',
    );
    const smoke = personClientJob.indexOf(
      'node tests/fixtures/person-onboarding-smoke.mjs --kit-root "$kit_root"',
    );

    expect(personClientJob).toContain("--target darwin-arm64");
    expect(personClientJob).toContain("--installation cli-kit");
    expect(personClientJob).toContain('test -x "$kit_root/Start-ECHO.sh"');
    expect(build).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(build);
    expect(smoke).toBeGreaterThan(verify);
    expect(personClientJob + job("desktop-app")).not.toMatch(
      /--app\b|build:echo-overlay|person-onboarding-ui|ECHO Setup|Start ECHO\.command/,
    );
  });

  it("requires native macOS and Linux desktop tests and package proofs", () => {
    const desktopJob = job("desktop-app");
    const steps = [
      "- name: Install repository dependencies",
      "run: node tools/build.mjs --person-client",
      "- name: Install the desktop app's locked dependencies",
      "run: npx --no install-electron",
      "run: npm run typecheck",
      "run: npx vitest run",
      "run: npm run build",
      "- name: Run the full desktop end-to-end suite",
      "run: npm run package",
      "- name: Verify release fuses and smoke the packaged app",
      'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
    ].map((step) => [step, desktopJob.indexOf(step)] as const);

    expect(desktopJob).toContain("name: ${{ matrix.name }} desktop app");
    expect(desktopJob).toContain("runs-on: ${{ matrix.runner }}");
    expect(desktopJob).toContain("fail-fast: false");
    expect(desktopJob).toContain(
      "- name: macOS arm64\n            runner: macos-15\n            arch: arm64",
    );
    expect(desktopJob).toContain(
      "- name: Linux x64\n            runner: ubuntu-24.04\n            arch: x64",
    );
    expect(desktopJob).toContain("TARGET_ARCH: ${{ matrix.arch }}");
    expect(desktopJob).toContain("process.arch !== process.env.TARGET_ARCH");
    expect(desktopJob).toContain("working-directory: product/echo-desktop");
    expect(desktopJob).toMatch(/^    timeout-minutes: 20$/m);
    expect(desktopJob).toContain("node-version: ${{ env.PRODUCT_NODE_VERSION }}");
    expect(desktopJob).toContain("product/echo-desktop/package-lock.json");
    for (const [index, [step, position]] of steps.entries()) {
      expect(position, step).toBeGreaterThan(index === 0 ? 0 : steps[index - 1]![1]);
    }
    // Shared tests and package proofs must not be skipped while the matrix
    // reports success to the aggregate. Native setup and diagnostic uploads
    // may vary; an upload must still run after a failed test.
    const conditionalSteps = desktopJob
      .split(/(?=^      - )/m)
      .filter((step) => /^        if:/m.test(step));
    expect(conditionalSteps).toHaveLength(4);
    expect(conditionalSteps).toContainEqual(expect.stringContaining(
      "- name: Preserve desktop diagnostics\n        if: ${{ !cancelled() }}",
    ));
    for (const [name, os] of [
      ["Prepare Linux for sandboxed Electron", "Linux"],
      ["Verify the macOS signature", "macOS"],
      ["Install and smoke the deb and validate its desktop launcher", "Linux"],
    ]) {
      expect(conditionalSteps).toContainEqual(
        expect.stringContaining(`- name: ${name}\n        if: runner.os == '${os}'`),
      );
    }
    // The plan alone gates the whole matrix; no leg is excluded or optional.
    expect(desktopJob.match(/^    if:.*$/gm)).toEqual([
      "    if: ${{ needs.plan.outputs.desktop_app == 'true' }}",
    ]);
    expect(desktopJob).not.toMatch(/exclude:|matrix\.[a-z-]+ ==/);
    expect(desktopJob).not.toMatch(
      /secrets\.|--allow-dirty|continue-on-error|--publish always/,
    );
    expect(desktopJob).toContain("xvfb-run -a dbus-run-session -- npx playwright test");
    expect(desktopJob).toContain("\n            npx playwright test\n");
    expect(desktopJob).toContain("xvfb-run -a dbus-run-session -- npm run smoke");
    expect(desktopJob).toContain("\n            npm run smoke\n");
    expect(desktopJob).toContain("npm run smoke -- /opt/ECHO/echo-desktop");
    expect(desktopJob).toContain("desktop-file-validate");
    expect(desktopJob).toContain("codesign --verify --deep --strict");
    const packager = readFileSync(
      resolve(REPO, "product/echo-desktop/scripts/package.mjs"), "utf8",
    );
    expect(packager).toContain("['scripts/build.mjs', '--release']");
    const smoke = readFileSync(
      resolve(REPO, "product/echo-desktop/scripts/smoke.mjs"), "utf8",
    );
    expect(smoke).toContain("result.build?.source_sha !== source");
    expect(smoke).toContain("result.build?.dirty !== false");
    expect(smoke).toContain("getCurrentFuseWire");
    expect(smoke).toContain("--remote-debugging-port=0");
  });
});
