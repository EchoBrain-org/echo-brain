import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_OUTPUTS, TESTED_TREE } from "../../tools/ci-select-jobs.mjs";

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

function steps(id: string) {
  return job(id).split(/(?=^      - )/m).slice(1);
}

/** The commands a check leg runs only for itself, in order. */
function legCommands(leg: string) {
  return steps("check")
    .filter((step) => step.includes(`        if: matrix.leg == '${leg}'\n`))
    .map((step) => step.match(/^        run: (.+)$/m)![1]!);
}

function aggregate(env: Record<string, string>) {
  const script = job("required-checks").split("        run: |\n")[1]!.replace(/^ {10}/gm, "");
  return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8" });
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
  it("runs every deterministic evaluator test in the tail leg", () => {
    const scripts = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).scripts as Record<string, string>;
    const commands = legCommands("tail").map((command) =>
      command.replace(/npm run ([\w:-]+)/g, (_match, name: string) => scripts[name] ?? ""),
    );
    const patterns = commands.flatMap((command) =>
      [...command.matchAll(/(?:^| && )node --test ([^&]+)/g)]
        .flatMap((match) => match[1]!.trim().split(/\s+/)),
    );
    const scheduled = new Set(globSync(patterns, { cwd: REPO }));
    const tests = globSync("tools/evals/*/test/**/*.test.mjs", { cwd: REPO });
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.filter((path) => !scheduled.has(path))).toEqual([]);
  });

  it("splits check into parallel legs that run npm run check and every later proof", () => {
    const check = job("check");
    expect(check).toContain(
      "      fail-fast: false\n      matrix:\n        leg: [static, vitest, tail]\n",
    );
    expect(check).not.toMatch(/^    (?:name|continue-on-error):|exclude:|include:/m);
    expect(check).toContain("          fetch-depth: 0\n");
    // A step is shared, belongs to exactly one declared leg, or uploads diagnostics.
    for (const step of steps("check")) {
      const conditions = step.match(/^        if: .*$/gm) ?? [];
      const expected = step.includes("uses: actions/upload-artifact@")
        ? ["        if: ${{ !cancelled() }}"]
        : conditions.filter((line) => /^        if: matrix\.leg == '(?:static|vitest|tail)'$/.test(line));
      expect(conditions, step).toEqual(expected);
      expect(step).not.toContain("continue-on-error:");
    }
    // The static leg runs npm run check up to vitest in its order; the other
    // legs first build what their proofs import, as npm run check did. Adding
    // a step to npm run check fails here until CI runs it too.
    const scripts = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).scripts;
    const commands = (scripts.check as string).split(" && ").map((command) => command.replace(/^(tsc|vitest) /, "npx $1 "));
    expect(commands.at(-1)).toBe("npx vitest run --config vitest.config.ts");
    expect(legCommands("static").join(" && ")).toContain(commands.slice(0, -1).join(" && "));
    expect(legCommands("static")[0]).toMatch(/^sudo -n python3 -B tests\/fixtures\/staging-release-posix-proof\.py /);
    expect(legCommands("vitest")).toEqual(["npm run build", `${commands.at(-1)} --maxWorkers=3`]);
    expect(legCommands("tail")).toEqual([
      "npm run build",
      "node tests/fixtures/person-onboarding-smoke.mjs",
      "npm run test:research-loop-eval",
      "npm run test:agentic-ask-eval",
      "npm run test:ask-follow-up-eval",
      "npm run test:ask-wording-eval",
      "npm run test:capacity",
      "npm run capacity:checkpoint",
    ]);
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
    expect(uploads[0]).toContain("name: check-diagnostics-${{ matrix.leg }}-${{ github.run_attempt }}\n");
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
    expect(required).toContain("          TESTED_TREE: ${{ needs.plan.outputs.tree }}\n");
    // The tested tree is recorded last, after every result passed.
    expect(required.trimEnd().split("\n").at(-1)).toBe(
      `          echo "::notice title=${TESTED_TREE}::$TESTED_TREE"`,
    );
    // Every planned job, including one added later, is checked against its selection.
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
      TESTED_TREE: "e".repeat(40),
    };
    const verifiedMain = {
      ...pullRequest,
      CHECK_RESULT: "skipped", CHECK_SELECTED: "false",
      DOCS_RESULT: "success", DOCS_SELECTED: "true",
      DESKTOP_APP_RESULT: "skipped", DESKTOP_APP_SELECTED: "false",
      AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT: "skipped", AUTHORITY_RECOVERY_INFRASTRUCTURE_SELECTED: "false",
    };
    for (const passing of [pullRequest, verifiedMain]) {
      const { status, stdout } = aggregate(passing);
      expect(status).toBe(0);
      expect(stdout).toBe(`::notice title=${TESTED_TREE}::${"e".repeat(40)}\n`);
    }
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
      const { status, stdout } = aggregate({ ...pullRequest, ...failing });
      expect(status, JSON.stringify(failing)).not.toBe(0);
      expect(stdout, JSON.stringify(failing)).not.toContain(TESTED_TREE);
    }
    for (const failing of [
      { DOCS_RESULT: "skipped" },
      { DOCS_RESULT: "failure" },
      { CHECK_SELECTED: "" },
      { CHECK_RESULT: "failure" },
      { AUTHORITY_CONTAINER_RESULT: "failure" },
    ]) {
      expect(aggregate({ ...verifiedMain, ...failing }).status, JSON.stringify(failing)).not.toBe(0);
    }
  });

  it("plans job selection in one dependency-free job with read-only access", () => {
    const plan = job("plan");
    expect(plan).toContain("    name: Select CI jobs\n");
    // Leaves room for the selector's 150-second wait on a running main.
    expect(plan).toContain("    timeout-minutes: 5\n");
    expect(gate("plan")).toEqual([]);
    expect(plan).toContain(
      "    permissions:\n      contents: read\n      pull-requests: read\n      checks: read\n    outputs:\n",
    );
    for (const output of [...JOB_OUTPUTS, "tree"]) {
      expect(plan).toContain(`      ${output}: \${{ steps.select.outputs.${output} }}\n`);
    }
    expect(plan.match(/^      [a-z_]+: \$\{\{ steps\.select\.outputs\.[a-z_]+ \}\}$/gm)).toHaveLength(JOB_OUTPUTS.length + 1);
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
    const scripts = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).scripts;
    expect(scripts["check:docs"]).toBe("node tools/check-docs.mjs");
    expect(scripts.check).toContain("npm run check:docs");
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
    // Every committed Guard policy validates its same-named template.
    const deployment = resolve(REPO, "deploy/organization-authority");
    const guards = globSync("*.guard", { cwd: deployment });
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      const template = guard.replace(/\.guard$/, ".template.json");
      expect(existsSync(resolve(deployment, template)), template).toBe(true);
      expect(validator).toContain(`"${guard}"`);
      expect(validator).toContain(`"${template}"`);
    }
    for (const required of [
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

  it("pins each Guard policy's rule names, so dropping or renaming a rule fails", () => {
    // The Guard policies are the stacks' only shape lock; their rule bodies stay in deploy/.
    const deployment = resolve(REPO, "deploy/organization-authority");
    const rules = (guard: string) =>
      [...readFileSync(resolve(deployment, guard), "utf8").matchAll(/^rule (\w+)/gm)].map((match) => match[1]);
    expect(Object.fromEntries(globSync("*.guard", { cwd: deployment }).sort().map((guard) => [guard, rules(guard)]))).toEqual({
      "authority-current-host-recovery-v1.guard": [
        "exact_resource_inventory",
        "retained_recovery_vault",
        "exact_root_volume_selection",
        "exact_backup_and_restore_roles",
        "bounded_schedule_and_retention",
      ],
      "authority-recovery-helper-v1.guard": [
        "exact_helper_inventory",
        "isolated_subnet_and_route_table",
        "no_ingress_and_endpoint_only_egress",
        "endpoint_boundary",
        "helper_role_has_no_operational_or_secret_access",
        "arm64_non_public_immutable_helper",
        "bounded_bundle_bootstrap",
      ],
      "authority-staging-host-v1.guard": [
        "exact_staging_slot_inventory",
        "host_toggle_leaves_the_slot_boundary_persistent",
        "network_has_no_ingress_and_required_bootstrap_and_tunnel_egress",
        "retained_state_and_trusted_delivery",
        "onboarding_transfer_is_exact_and_temporary",
        "onboarding_transfer_bucket_denies_untrusted_writes",
        "arm64_host_is_disposable_and_requires_imdsv2",
        "role_can_read_only_exact_bundle_and_own_secret",
        "readiness_waits_for_the_retained_volume",
        "wait_condition_curl_uses_empty_content_type",
      ],
      "authority-staging-journey-observability-v1.guard": [
        "exact_staging_journey_overview_inventory",
        "staging_only_input_boundary",
        "has_no_platform_or_data_resources",
        "metric_filter_is_staging_worker_liveness_only",
        "all_alarms_have_staging_namespace_and_explicit_delivery_behavior",
        "exact_staging_alarm_thresholds",
        "dashboard_is_owned_by_this_stack_and_has_a_literal_body",
        "dashboard_covers_canonical_research_and_historical_ask",
        "dashboard_has_no_custom_widget",
      ],
    });
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

  it("pulls every Docker Hub image by digest, from a mirror first with Docker Hub as fallback", () => {
    const authorityJob = job("authority-container");
    const mirror = authorityJob.indexOf("- name: Pull Docker Hub images through a mirror first");
    const buildx = authorityJob.indexOf("- uses: docker/setup-buildx-action@");
    expect(mirror).toBeGreaterThan(0);
    expect(buildx).toBeGreaterThan(mirror);
    // Docker pulls the BuildKit and Caddy images; BuildKit pulls the base image.
    expect(authorityJob).toContain('config["registry-mirrors"] = ["https://mirror.gcr.io"]');
    expect(authorityJob).toContain("sudo systemctl restart docker\n");
    expect(authorityJob).toContain(
      "          buildkitd-config-inline: |\n" +
      '            [registry."docker.io"]\n' +
      '              mirrors = ["mirror.gcr.io"]\n',
    );
    expect(source.match(/docker\/setup-buildx-action@/g)).toHaveLength(1);
    // Digest pins make the mirror unable to change what is pulled.
    const compose = readFileSync(resolve(REPO, "deploy/organization-authority/compose.clean-v1.yaml"), "utf8");
    const pulled = compose.match(/^ +image: [^"].*$/gm)!.map((line) => line.trim().slice("image: ".length));
    expect(pulled).toHaveLength(1);
    const caddy = pulled[0]!;
    expect(authorityJob.match(/caddy:\S+/g)).toEqual([caddy, caddy]);
    for (const image of [
      authorityJob.match(/driver-opts: image=(\S+)$/m)![1]!,
      caddy,
      ...[...readFileSync(DOCKERFILE, "utf8").matchAll(/^FROM (\S+)/gm)].map((match) => match[1]!),
    ]) {
      expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    }
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
      // The deb's root-relevant contents are checked before it is installed.
      "run: node scripts/check-deb.mjs dist-app/*.deb",
      "- name: Install and smoke the deb and validate its desktop launcher",
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
    expect(conditionalSteps).toHaveLength(5);
    expect(conditionalSteps).toContainEqual(expect.stringContaining(
      "- name: Preserve desktop diagnostics\n        if: ${{ !cancelled() }}",
    ));
    for (const [name, os] of [
      ["Prepare Linux for sandboxed Electron", "Linux"],
      ["Verify the macOS signature", "macOS"],
      ["Check the deb's root-run files and footprint against the commit", "Linux"],
      ["Install and smoke the deb and validate its desktop launcher", "Linux"],
    ]) {
      expect(conditionalSteps).toContainEqual(
        expect.stringContaining(`- name: ${name}\n        if: runner.os == '${os}'`),
      );
    }
    // Pull requests read only caches main saved, and a light run on main
    // skips this job: after a lockfile change, start from main's newest entry.
    const downloads = desktopJob.split(/(?=^      - )/m)
      .find((step) => step.includes("- name: Cache Electron and packaging-tool downloads"))!;
    const prefix = "desktop-downloads-v1-${{ runner.os }}-${{ runner.arch }}-";
    expect(downloads).toContain(`          key: ${prefix}\${{ hashFiles('product/echo-desktop/package-lock.json') }}\n`);
    expect(downloads).toContain(`          restore-keys: ${prefix}\n`);
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
    // The installed deb is smoked under Ubuntu's default userns restriction.
    expect(desktopJob).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1");
    expect(desktopJob).toContain("desktop-file-validate");
    expect(desktopJob).toContain("test \"$(stat -c '%U:%G %a' /opt/ECHO/chrome-sandbox)\" = 'root:root 755'");
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
    // A committed test.only must fail the e2e step rather than skip the rest.
    const playwright = readFileSync(
      resolve(REPO, "product/echo-desktop/playwright.config.ts"), "utf8",
    );
    expect(playwright).toContain("forbidOnly: !!process.env.CI,");
  });
});
