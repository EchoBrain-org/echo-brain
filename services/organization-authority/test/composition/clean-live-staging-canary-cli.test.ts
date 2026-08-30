import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";

const state = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock(
  "../../src/composition/staging-synthetic-private-dm-canary-client-v1.js",
  () => ({
    requestStagingSyntheticPrivateDmCanaryV1: state.request,
  }),
);

const { runOrganizationAuthorityServiceCli } = await import(
  "../../src/composition/organization-authority-service-cli.js"
);

const RELEASE_ID = "clean-v1-staging-canary";
const previousReleaseId = process.env.ECHO_CLEAN_RELEASE_ID;

afterEach(() => {
  state.request.mockReset();
  if (previousReleaseId === undefined) delete process.env.ECHO_CLEAN_RELEASE_ID;
  else process.env.ECHO_CLEAN_RELEASE_ID = previousReleaseId;
});

describe("clean live staging canary CLI", () => {
  it("uses the existing private socket client without opening a runtime", async () => {
    process.env.ECHO_CLEAN_RELEASE_ID = RELEASE_ID;
    state.request.mockResolvedValue({
      schema_version: 1,
      kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
      release_id: RELEASE_ID,
      approval_outcome: "staged",
      approval_id: "apr_private",
    });
    const stdout: string[] = [];

    await expect(
      runOrganizationAuthorityServiceCli(
        ["staging-private-dm-canary", "--release-id", RELEASE_ID],
        { stdout: (value) => stdout.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(0);

    expect(state.request).toHaveBeenCalledExactlyOnceWith({
      release_id: RELEASE_ID,
    });
    expect(stdout).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-staging-synthetic-private-dm-canary-receipt-v1",
        release_id: RELEASE_ID,
        approval_outcome: "staged",
        approval_id: "apr_private",
      } as never)}\n`,
    ]);
  });

  it("refuses a requested release that differs from the running service", async () => {
    process.env.ECHO_CLEAN_RELEASE_ID = RELEASE_ID;

    await expect(
      runOrganizationAuthorityServiceCli(
        ["staging-private-dm-canary", "--release-id", "clean-v1-other-release"],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).resolves.toBe(1);

    expect(state.request).not.toHaveBeenCalled();
  });
});
