import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("exposes one stable aggregate required-check name", () => {
    expect(source).toMatch(/required-checks:\s*\n\s+name: CI required checks/);
    expect(source).toMatch(
      /needs: \[check, person-client-package, desktop-app, authority-container, authority-recovery-infrastructure\]/,
    );
    expect(source).toContain('test "$CHECK_RESULT" = success');
    expect(source).toContain('test "$PERSON_CLIENT_PACKAGE_RESULT" = success');
    expect(source).toContain('test "$DESKTOP_APP_RESULT" = success');
    expect(source).toContain('test "$AUTHORITY_CONTAINER_RESULT" = success');
    expect(source).toContain(
      'test "$AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT" = success',
    );
  });

  it("executes exact recovery-template validation as an independent proof", () => {
    const validator = readFileSync(RECOVERY_VALIDATOR, "utf8");
    const job = between("  authority-recovery-infrastructure:", "  required-checks:");

    expect(job).toContain("name: Authority recovery infrastructure");
    expect(job).toContain(
      "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
    );
    expect(job).toContain('python-version: "3.10"');
    expect(job).toContain("npm run check:authority-recovery-infrastructure");
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
    const authorityJob = between("  authority-container:", "  required-checks:");

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
    const personClientJob = between("  person-client-package:", "  authority-container:");

    expect(personClientJob).toContain(
      "tests/architecture/mac-person-cli-kit.test.ts",
    );
    expect(personClientJob).toContain(
      "tests/architecture/client-update-dispatch.test.ts",
    );
    expect(source).not.toMatch(/swift|echo-overlay|echo-onboarding/i);
  });

  it("builds, verifies, and installs only the macOS command-line kit in the macOS Person-client job", () => {
    const personClientJob = between("  person-client-package:", "  authority-container:");
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
    expect(personClientJob).not.toMatch(
      /--app\b|build:echo-overlay|person-onboarding-ui|ECHO Setup|Start ECHO\.command/,
    );
  });

  it("requires native macOS and Linux desktop tests and package proofs", () => {
    const desktopJob = between("  desktop-app:", "  authority-container:");
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
    // reports success to the aggregate. Only native platform setup may vary.
    const conditionalSteps = desktopJob
      .split(/(?=^      - )/m)
      .filter((step) => /^        if:/m.test(step));
    expect(conditionalSteps).toHaveLength(3);
    for (const [name, os] of [
      ["Prepare Linux for sandboxed Electron", "Linux"],
      ["Verify the macOS signature", "macOS"],
      ["Install and smoke the deb and validate its desktop launcher", "Linux"],
    ]) {
      expect(conditionalSteps).toContainEqual(
        expect.stringContaining(`- name: ${name}\n        if: runner.os == '${os}'`),
      );
    }
    expect(desktopJob).not.toMatch(/^    if:/m);
    expect(desktopJob).not.toMatch(
      /secrets\.|upload-artifact|--allow-dirty|continue-on-error|--publish always/,
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
