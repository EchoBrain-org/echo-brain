import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const WORKFLOW = resolve(REPO, ".github/workflows/ci.yml");
const DOCKERFILE = resolve(REPO, "deploy/organization-authority/Dockerfile");
const RECOVERY_VALIDATOR = resolve(
  REPO,
  "tools/validate-authority-recovery-templates.mjs",
);

function workflow() {
  return readFileSync(WORKFLOW, "utf8");
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
    const source = workflow();
    const concurrency = source.slice(
      source.indexOf("concurrency:"),
      source.indexOf("permissions:"),
    );

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
    const source = workflow();
    const build = source.slice(
      source.indexOf("- name: Build the clean V1 authority image"),
      source.indexOf(
        "- name: Assert the authority image build left the checkout clean",
      ),
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
    const source = workflow();

    expect(source).toMatch(/required-checks:\s*\n\s+name: CI required checks/);
    expect(source).toMatch(
      /needs: \[check, person-client-package, authority-container, authority-recovery-infrastructure\]/,
    );
    expect(source).toContain('test "$CHECK_RESULT" = success');
    expect(source).toContain('test "$PERSON_CLIENT_PACKAGE_RESULT" = success');
    expect(source).toContain('test "$AUTHORITY_CONTAINER_RESULT" = success');
    expect(source).toContain(
      'test "$AUTHORITY_RECOVERY_INFRASTRUCTURE_RESULT" = success',
    );
  });

  it("executes exact recovery-template validation as an independent proof", () => {
    const source = workflow();
    const validator = readFileSync(RECOVERY_VALIDATOR, "utf8");
    const job = source.slice(
      source.indexOf("  authority-recovery-infrastructure:"),
      source.indexOf("  required-checks:"),
    );

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
    const source = workflow();
    const authorityJob = source.slice(
      source.indexOf("  authority-container:"),
      source.indexOf("  required-checks:"),
    );

    expect(authorityJob).toContain("cache: npm");
    expect(authorityJob).toContain("- run: npm ci");
    expect(authorityJob).toContain(
      'npm run authority:local -- up "${authority_local_args[@]}"',
    );
    expect(authorityJob).toContain("--runtime-profile-sha256");
    expect(authorityJob).toContain("--no-build");
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
});
