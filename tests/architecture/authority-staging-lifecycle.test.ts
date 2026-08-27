import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAwsCliAdapters,
  runAuthorityStaging,
  validateStagingLifecycleInput,
} from "../../tools/authority-staging.mjs";
import type { StagingLifecycleReceipt } from "../../tools/authority-staging.mjs";

const DECLARED_LIFECYCLE_STATES = [
  "planned",
  "ready",
  "executed",
  "absent",
  "incomplete",
  "failed_create",
  "update_rolled_back",
  "unprotected",
] as const satisfies readonly StagingLifecycleReceipt["state"][];

type MissingDeclaredLifecycleState = Exclude<
  StagingLifecycleReceipt["state"],
  (typeof DECLARED_LIFECYCLE_STATES)[number]
>;
const ALL_DECLARED_LIFECYCLE_STATES_ARE_COVERED: MissingDeclaredLifecycleState extends never
  ? true
  : never = true;

const TOKEN = "cf-management-token-not-a-real-secret";
const CLI = fileURLToPath(
  new URL("../../tools/authority-staging.mjs", import.meta.url),
);
const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/tunnel-abc";

it("keeps every public lifecycle receipt state typechecked", () => {
  expect(ALL_DECLARED_LIFECYCLE_STATES_ARE_COVERED).toBe(true);
  expect(DECLARED_LIFECYCLE_STATES).toContain("update_rolled_back");
});

function withFakeAws() {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-staging-aws-"));
  const aws = join(root, "aws");
  const executeCount = join(root, "execute-count");
  const log = join(root, "calls.log");
  const stdin = join(root, "stdin.json");
  writeFileSync(
    aws,
    `#!/bin/sh
set -eu
for argument in "$@"; do printf 'ARG=%s\\n' "$argument" >>"$FAKE_AWS_LOG"; done
printf 'PROFILE_ENV=%s\\n' "\${AWS_PROFILE-unset}" >>"$FAKE_AWS_LOG"
printf 'DEFAULT_PROFILE_ENV=%s\\n' "\${AWS_DEFAULT_PROFILE-unset}" >>"$FAKE_AWS_LOG"
printf 'ACCESS_KEY_ENV=%s\\n' "\${AWS_ACCESS_KEY_ID-unset}" >>"$FAKE_AWS_LOG"
printf 'SECRET_KEY_ENV=%s\\n' "\${AWS_SECRET_ACCESS_KEY-unset}" >>"$FAKE_AWS_LOG"
printf 'SESSION_TOKEN_ENV=%s\\n' "\${AWS_SESSION_TOKEN-unset}" >>"$FAKE_AWS_LOG"
printf 'WEB_IDENTITY_ENV=%s\\n' "\${AWS_WEB_IDENTITY_TOKEN_FILE-unset}" >>"$FAKE_AWS_LOG"
printf 'CONFIG_FILE_ENV=%s\\n' "\${AWS_CONFIG_FILE-unset}" >>"$FAKE_AWS_LOG"
printf 'CREDENTIALS_FILE_ENV=%s\\n' "\${AWS_SHARED_CREDENTIALS_FILE-unset}" >>"$FAKE_AWS_LOG"
printf 'TOKEN_ENV=%s\\nEND\\n' "\${ECHO_CLOUDFLARE_API_TOKEN-unset}" >>"$FAKE_AWS_LOG"
case " $* " in
  *" cloudformation execute-change-set "*)
    count=0
    if [ -f "$FAKE_AWS_EXECUTE_COUNT" ]; then count=$(cat "$FAKE_AWS_EXECUTE_COUNT"); fi
    count=$((count + 1))
    printf '%s\\n' "$count" >"$FAKE_AWS_EXECUTE_COUNT"
    if [ "$count" -le "\${FAKE_AWS_EXECUTE_FAILURES:-0}" ]; then exit 75; fi
    ;;
esac
case " $* " in
  *" secretsmanager put-secret-value "*) cat >"$FAKE_AWS_STDIN" ;;
  *) cat >/dev/null ;;
esac
case " $* " in
  *" cloudformation describe-change-set "*) printf '%s\\n' "$FAKE_AWS_DESCRIBE_RESPONSE" ;;
  *" cloudformation describe-stacks "*)
    if [ -n "\${FAKE_AWS_STACK_RESPONSE-}" ]; then
      printf '%s\\n' "$FAKE_AWS_STACK_RESPONSE"
    else
      printf '{}\\n'
    fi
    ;;
  *) printf '{}\\n' ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(aws, 0o700);
  return { aws, executeCount, log, root, stdin };
}

function withFakeAsmExec() {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-staging-asm-"));
  const asmExec = join(root, "asm-exec");
  const log = join(root, "calls.log");
  writeFileSync(
    asmExec,
    `#!/bin/sh
set -eu
case "\${ECHO_CLOUDFLARE_API_TOKEN-}" in
  '{{resolve:secretsmanager:'*) token_kind=dynamic ;;
  *) token_kind=unexpected ;;
esac
printf 'PROFILE_ENV=%s\\n' "\${AWS_PROFILE-unset}" >"$FAKE_ASM_LOG"
printf 'DEFAULT_PROFILE_ENV=%s\\n' "\${AWS_DEFAULT_PROFILE-unset}" >>"$FAKE_ASM_LOG"
printf 'ACCESS_KEY_ENV=%s\\n' "\${AWS_ACCESS_KEY_ID-unset}" >>"$FAKE_ASM_LOG"
printf 'SECRET_KEY_ENV=%s\\n' "\${AWS_SECRET_ACCESS_KEY-unset}" >>"$FAKE_ASM_LOG"
printf 'SESSION_TOKEN_ENV=%s\\n' "\${AWS_SESSION_TOKEN-unset}" >>"$FAKE_ASM_LOG"
printf 'WEB_IDENTITY_ENV=%s\\n' "\${AWS_WEB_IDENTITY_TOKEN_FILE-unset}" >>"$FAKE_ASM_LOG"
printf 'CONFIG_FILE_ENV=%s\\n' "\${AWS_CONFIG_FILE-unset}" >>"$FAKE_ASM_LOG"
printf 'CREDENTIALS_FILE_ENV=%s\\n' "\${AWS_SHARED_CREDENTIALS_FILE-unset}" >>"$FAKE_ASM_LOG"
printf 'TOKEN_KIND=%s\\n' "$token_kind" >>"$FAKE_ASM_LOG"
exit 86
`,
    { mode: 0o700 },
  );
  chmodSync(asmExec, 0o700);
  return { asmExec, log, root };
}

function withReexecingFakeAsmExec() {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-staging-asm-child-"));
  const asmExec = join(root, "asm-exec");
  writeFileSync(
    asmExec,
    `#!/bin/sh
set -eu
test "$1" = "--"
shift
export ECHO_CLOUDFLARE_API_TOKEN='resolved-test-token-not-a-real-secret'
export FAKE_AWS_STACK_RESPONSE="$FAKE_AWS_STACK_RESPONSE_AFTER_ASM"
exec "$@"
`,
    { mode: 0o700 },
  );
  chmodSync(asmExec, 0o700);
  return { asmExec, root };
}
const INPUT = Object.freeze({
  region: "us-west-2",
  operationId: "staging-change-20260826",
  slotId: "staging-green-slot",
  stack: {
    name: "echo-authority-staging-green",
    parameters: {
      OrgSlug: "green",
      AvailabilityZone: "us-west-2a",
      StagingAmiId: "ami-0123456789abcdef0",
      AuthorityEcrRepositoryArn:
        "arn:aws:ecr:us-west-2:123456789012:repository/echo-brain/authority",
    },
  },
  edge: {
    accountId: "a".repeat(32),
    zoneId: "b".repeat(32),
    hostname: "staging.example.com",
  },
  hostSetup: {
    path: "/private/tmp/authority-staging-host-setup.tar.gz",
    key: "authority-staging/host-setup.tar.gz",
    sha256: "c".repeat(64),
  },
});

function stack(hostEnabled = false, terminationProtection = true) {
  return {
    exists: true as const,
    status: hostEnabled ? "CREATE_COMPLETE" : "UPDATE_COMPLETE",
    terminationProtection,
    outputs: {
      AuthorityTunnelTokenSecretArn: SECRET_ARN,
      HostSetupArtifactBucketName: "echo-authority-staging-artifacts",
      StagingHostInstanceId: hostEnabled ? "i-0123456789abcdef0" : "disabled",
      StagingHostReady: hostEnabled ? "true" : "false",
    },
  };
}

function safeAction(request: {
  readonly changeSetType: "CREATE" | "UPDATE";
  readonly parameters: Record<string, string>;
}) {
  if (request.changeSetType === "CREATE")
    return {
      action: "Add",
      logicalId: "StagingVpc",
      replacement: false,
      resourceType: "AWS::EC2::VPC",
    };
  const enabled = request.parameters.HostEnabled === "true";
  return {
    action: enabled ? "Add" : "Remove",
    logicalId: "StagingHost",
    replacement: false,
    resourceType: "AWS::EC2::Instance",
  };
}

function dependencies(
  options: {
    readonly initialStack?:
      | {
          readonly exists: true;
          readonly status: string;
          readonly outputs: Readonly<Record<string, string>>;
          readonly terminationProtection: boolean;
        }
      | { readonly exists: false };
    readonly quiesce?: "success" | "failure";
    readonly recover?: "success" | "failure";
    readonly executeFailure?: boolean;
    readonly rollbackInstanceId?: string;
    readonly updateFailureStatus?: string;
    readonly terminationProtectionFailures?: number;
    readonly slotInitExistingChange?: boolean;
    readonly changeAction?: {
      readonly action: string;
      readonly logicalId: string;
      readonly replacement: boolean | "True" | "False" | "Conditional";
      readonly resourceType: string;
    };
  } = {},
) {
  const events: string[] = [];
  const plans: Array<{
    readonly onStackFailure?: "DO_NOTHING";
    readonly parameters: Record<string, string>;
  }> = [];
  let status = options.initialStack ?? stack(false);
  let terminationProtectionFailures =
    options.terminationProtectionFailures ?? 0;
  let executeFailures = options.executeFailure === true ? 1 : 0;
  let plannedHostEnabled = false;
  const plan = (request: {
    readonly parameters: Record<string, string>;
    readonly changeSetType: "CREATE" | "UPDATE";
    readonly changeSetName: string;
  }) => {
    plannedHostEnabled = request.parameters.HostEnabled === "true";
    if (
      request.changeSetType === "UPDATE" &&
      request.changeSetName.includes("-slot-init-") &&
      status.exists &&
      status.status !== "CREATE_FAILED" &&
      options.slotInitExistingChange !== true
    ) {
      return {
        changeSetType: request.changeSetType,
        kind: "no_changes" as const,
        matchesExpected: true,
      };
    }
    return {
      actions: [options.changeAction ?? safeAction(request)],
      artifact:
        request.parameters.HostEnabled === "true"
          ? {
              key: INPUT.hostSetup.key,
              sha256: INPUT.hostSetup.sha256,
              version: "version-0001",
            }
          : undefined,
      changeSetType: request.changeSetType,
      id: "change-set-123",
      kind: "change_set" as const,
      matchesExpected: true,
      status: "CREATE_COMPLETE" as const,
    };
  };
  const cloudFormation = {
    describeStack: async () => {
      events.push("describe-stack");
      return status;
    },
    createChangeSet: async (request: {
      readonly parameters: Record<string, string>;
      readonly changeSetType: "CREATE" | "UPDATE";
      readonly changeSetName: string;
      readonly onStackFailure?: "DO_NOTHING";
    }) => {
      events.push(
        `plan:${request.changeSetType}:${request.parameters.HostEnabled}`,
      );
      plans.push(request);
      return plan(request);
    },
    describeChangeSet: async (request: {
      readonly parameters: Record<string, string>;
      readonly changeSetType: "CREATE" | "UPDATE";
      readonly changeSetName: string;
      readonly onStackFailure?: "DO_NOTHING";
    }) => {
      events.push(
        `review:${request.changeSetType}:${request.parameters.HostEnabled}`,
      );
      return plan(request);
    },
    executeChangeSet: async (request: {
      readonly changeSetType: "CREATE" | "UPDATE";
    }) => {
      events.push("execute-change-set");
      if (executeFailures > 0) {
        executeFailures -= 1;
        if (request.changeSetType === "CREATE")
          status = {
            exists: true,
            outputs: {},
            status: "CREATE_FAILED",
            terminationProtection: false,
          };
        else if (status.exists)
          status = {
            ...status,
            outputs: {
              ...status.outputs,
              StagingHostInstanceId:
                options.rollbackInstanceId ??
                status.outputs.StagingHostInstanceId,
            },
            status: options.updateFailureStatus ?? "UPDATE_ROLLBACK_COMPLETE",
          };
        throw new Error("simulated failure");
      }
      status = {
        ...stack(plannedHostEnabled),
        status:
          request.changeSetType === "CREATE"
            ? "CREATE_COMPLETE"
            : "UPDATE_COMPLETE",
        terminationProtection:
          request.changeSetType === "UPDATE" && status.exists
            ? status.terminationProtection
            : false,
      };
    },
    ensureTerminationProtection: async () => {
      events.push("ensure-termination-protection");
      if (terminationProtectionFailures > 0) {
        terminationProtectionFailures -= 1;
        throw new Error("simulated protection failure");
      }
      if (status.exists) status = { ...status, terminationProtection: true };
    },
  };
  const edgeInputs: Array<Record<string, unknown>> = [];
  const recoveredInstanceIds: string[] = [];
  const edge = {
    installToken: async (input: Record<string, unknown>) => {
      events.push("edge-install-token");
      edgeInputs.push(input);
      return { state: "ready" as const };
    },
    status: async () => {
      events.push("edge-status");
      return { state: "ready" as const };
    },
  };
  const s3 = {
    uploadObject: async (request: Record<string, unknown>) => {
      events.push("s3-upload-object");
      expect(request).toMatchObject({
        bucket: "echo-authority-staging-artifacts",
        key: INPUT.hostSetup.key,
        sha256: INPUT.hostSetup.sha256,
      });
      return { sha256: INPUT.hostSetup.sha256, version: "version-0001" };
    },
    assertObject: async () => {
      events.push("s3-assert-object");
    },
  };
  const ssm = {
    quiesceHost: async () => {
      events.push("ssm-quiesce-host");
      if (options.quiesce === "failure") throw new Error("not safe");
      return {
        composeStopped: true,
        dockerStopped: true,
        syncComplete: true,
        volumeSafe: true,
        volumeUnmounted: true,
      };
    },
    recoverHost: async ({ instanceId }: { readonly instanceId: string }) => {
      events.push("ssm-recover-host");
      recoveredInstanceIds.push(instanceId);
      if (options.recover === "failure") throw new Error("not recoverable");
      return {
        dockerStarted: true,
        existingContainersStarted: true,
        volumeMounted: true,
      };
    },
  };
  return {
    edgeInputs,
    events,
    plans,
    recoveredInstanceIds,
    dependencies: { cloudFormation, cloudflareApiToken: TOKEN, edge, s3, ssm },
  };
}

describe("Authority staging lifecycle", () => {
  it("creates a reviewable slot-init change set by default without an edge mutation", async () => {
    const fixture = dependencies({ initialStack: { exists: false } });
    const receipt = await runAuthorityStaging(
      "slot-init",
      INPUT,
      fixture.dependencies,
    );

    expect(receipt).toMatchObject({
      action: "slot-init",
      state: "planned",
      change_set_actions: [
        { action: "Add", logical_id: "StagingVpc", replacement: false },
      ],
    });
    expect(fixture.events).toEqual(["describe-stack", "plan:CREATE:false"]);
    expect(fixture.plans[0]?.parameters).toMatchObject({
      VpcCidr: "10.238.0.0/16",
      PublicSubnetCidr: "10.238.1.0/24",
      StagingInstanceType: "t4g.small",
      DataVolumeSizeGiB: "30",
    });
    expect(fixture.plans[0]?.onStackFailure).toBe("DO_NOTHING");
  });

  it.each(["Dynamic", "Import"])(
    "rejects %s actions for slot-init before any edge mutation",
    async (action) => {
      const fixture = dependencies({
        changeAction: {
          action,
          logicalId: "StagingVpc",
          replacement: false,
          resourceType: "AWS::EC2::VPC",
        },
        initialStack: { exists: false },
      });

      await expect(
        runAuthorityStaging("slot-init", INPUT, fixture.dependencies),
      ).rejects.toThrow("change_set_host_boundary_violation");
      expect(fixture.events).not.toContain("edge-install-token");
    },
  );

  it("only executes the already-created slot-init change set, then installs the fixed edge", async () => {
    const fixture = dependencies({ initialStack: { exists: false } });
    await runAuthorityStaging("slot-init", INPUT, fixture.dependencies);
    const receipt = await runAuthorityStaging("slot-init", INPUT, {
      ...fixture.dependencies,
      execute: true,
    });

    expect(receipt).toMatchObject({
      action: "slot-init",
      state: "ready",
      edge_ready: true,
    });
    expect(fixture.events).toEqual([
      "describe-stack",
      "plan:CREATE:false",
      "describe-stack",
      "review:CREATE:false",
      "execute-change-set",
      "describe-stack",
      "ensure-termination-protection",
      "describe-stack",
      "edge-install-token",
    ]);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(JSON.stringify(receipt)).not.toContain(SECRET_ARN);
  });

  it.each([
    ["unknown", "edge_receipt_invalid"],
    ["incomplete", "edge_install_unready"],
  ])("refuses an installed edge state of %s", async (state, failure) => {
    const fixture = dependencies();

    await expect(
      runAuthorityStaging("slot-init", INPUT, {
        ...fixture.dependencies,
        edge: {
          ...fixture.dependencies.edge,
          installToken: async () => ({ state: state as "ready" }),
        },
        execute: true,
      }),
    ).rejects.toThrow(failure);
  });

  it("reuses a CREATE plan while CloudFormation reports REVIEW_IN_PROGRESS", async () => {
    const fixture = dependencies({
      initialStack: {
        exists: true,
        status: "REVIEW_IN_PROGRESS",
        terminationProtection: false,
        outputs: {},
      },
    });
    const receipt = await runAuthorityStaging("slot-init", INPUT, {
      ...fixture.dependencies,
      execute: true,
    });

    expect(receipt).toMatchObject({ action: "slot-init", state: "ready" });
    expect(fixture.events).toContain("review:CREATE:false");
    expect(fixture.events).not.toContain("review:UPDATE:false");
  });

  it("preserves and repairs a typed failed CREATE instead of planning a fresh slot", async () => {
    const fixture = dependencies({
      initialStack: { exists: false },
      executeFailure: true,
    });
    await runAuthorityStaging("slot-init", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("slot-init", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("change_set_execute_failed");

    const failed = await runAuthorityStaging(
      "status",
      INPUT,
      fixture.dependencies,
    );
    expect(failed).toMatchObject({
      action: "status",
      edge_checked: false,
      recovery_action: "slot-init",
      stack_status: "CREATE_FAILED",
      state: "failed_create",
    });

    const repair = { ...INPUT, operationId: "staging-change-20260827" };
    const repairPlan = await runAuthorityStaging(
      "slot-init",
      repair,
      fixture.dependencies,
    );
    expect(repairPlan).toMatchObject({
      change_set_created: true,
      state: "planned",
    });
    expect(fixture.events).toContain("plan:UPDATE:false");
    await expect(
      runAuthorityStaging("slot-init", repair, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).resolves.toMatchObject({
      edge_ready: true,
      state: "ready",
      termination_protection: true,
    });
  });

  it("retries and proves termination protection before publishing the edge", async () => {
    const fixture = dependencies({
      initialStack: { exists: false },
      terminationProtectionFailures: 1,
    });
    await runAuthorityStaging("slot-init", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("slot-init", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("slot_termination_protection_failed");
    expect(fixture.events).not.toContain("edge-install-token");

    await expect(
      runAuthorityStaging("status", INPUT, fixture.dependencies),
    ).resolves.toMatchObject({
      edge_checked: false,
      recovery_action: "slot-init",
      state: "unprotected",
    });

    const retry = { ...INPUT, operationId: "staging-change-20260827" };
    await expect(
      runAuthorityStaging("slot-init", retry, fixture.dependencies),
    ).resolves.toMatchObject({ no_changes: true, state: "planned" });
    await expect(
      runAuthorityStaging("slot-init", retry, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).resolves.toMatchObject({
      edge_ready: true,
      state: "ready",
      termination_protection: true,
    });
    expect(
      fixture.events.lastIndexOf("ensure-termination-protection"),
    ).toBeLessThan(fixture.events.lastIndexOf("edge-install-token"));
  });

  it("uploads and verifies a local bundle to the exact stack output before planning up", async () => {
    const fixture = dependencies();
    const receipt = await runAuthorityStaging(
      "up",
      INPUT,
      fixture.dependencies,
    );
    expect(receipt).toMatchObject({
      action: "up",
      state: "planned",
      host_enabled: true,
      host_setup_artifact: {
        key: INPUT.hostSetup.key,
        sha256: INPUT.hostSetup.sha256,
        version: "version-0001",
      },
    });
    expect(fixture.events).toEqual([
      "describe-stack",
      "s3-upload-object",
      "s3-assert-object",
      "describe-stack",
      "plan:UPDATE:true",
    ]);
    expect(fixture.plans[0]?.parameters.InitializeBlankDataVolume).toBe(
      "false",
    );
  });

  it("requires an explicit audited flag before an initial blank volume can be formatted", async () => {
    const fixture = dependencies();
    const receipt = await runAuthorityStaging("up", INPUT, {
      ...fixture.dependencies,
      initializeBlankDataVolume: true,
    });
    expect(receipt).toMatchObject({ initialize_blank_data_volume: true });
    expect(fixture.plans[0]?.parameters.InitializeBlankDataVolume).toBe("true");
  });

  it("refuses to execute a reviewed up plan for a different setup artifact", async () => {
    const fixture = dependencies();
    fixture.dependencies.cloudFormation.describeChangeSet = async (
      request,
    ) => ({
      actions: [safeAction(request)],
      artifact: {
        key: INPUT.hostSetup.key,
        sha256: "d".repeat(64),
        version: "version-0001",
      },
      changeSetType: "UPDATE",
      id: "change-set-123",
      kind: "change_set",
      matchesExpected: true,
      status: "CREATE_COMPLETE",
    });

    await expect(
      runAuthorityStaging("up", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("reviewed_host_setup_drifted");
    expect(fixture.events).not.toContain("execute-change-set");
  });

  it("refuses an up plan if the host is already enabled", async () => {
    const fixture = dependencies({ initialStack: stack(true) });
    await expect(
      runAuthorityStaging("up", INPUT, fixture.dependencies),
    ).rejects.toThrow("host_already_enabled");
    expect(fixture.events).toEqual(["describe-stack"]);
  });

  it("reports a completed update rollback and executes a newly reviewed matching retry", async () => {
    const fixture = dependencies({
      initialStack: {
        ...stack(false),
        status: "UPDATE_ROLLBACK_COMPLETE",
      },
    });
    await expect(
      runAuthorityStaging("status", INPUT, fixture.dependencies),
    ).resolves.toMatchObject({
      edge_checked: false,
      recovery_action: "up",
      stack_status: "UPDATE_ROLLBACK_COMPLETE",
      state: "update_rolled_back",
    });
    await expect(
      runAuthorityStaging("up", INPUT, fixture.dependencies),
    ).resolves.toMatchObject({
      action: "up",
      change_set_ready_for_review: true,
      state: "planned",
    });
    expect(fixture.events).not.toContain("edge-status");
    expect(fixture.events).toContain("plan:UPDATE:true");
    await expect(
      runAuthorityStaging("up", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).resolves.toMatchObject({
      action: "up",
      stack_status: "UPDATE_COMPLETE",
      state: "executed",
    });
  });

  it.each([
    "UPDATE_ROLLBACK_IN_PROGRESS",
    "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    "UPDATE_ROLLBACK_FAILED",
    "ROLLBACK_COMPLETE",
  ])("blocks lifecycle mutation while the stack is %s", async (status) => {
    const fixture = dependencies({
      initialStack: { ...stack(false), status },
    });
    await expect(
      runAuthorityStaging("up", INPUT, fixture.dependencies),
    ).rejects.toThrow("stack_status_invalid");
    expect(fixture.events).toEqual(["describe-stack"]);
  });

  it("does not let slot-init mask a completed update rollback", async () => {
    const fixture = dependencies({
      initialStack: {
        ...stack(false),
        status: "UPDATE_ROLLBACK_COMPLETE",
      },
    });
    await expect(
      runAuthorityStaging("slot-init", INPUT, fixture.dependencies),
    ).rejects.toThrow("slot_init_update_rollback_requires_lifecycle_retry");
    expect(fixture.events).not.toContain("edge-install-token");
  });

  it("quiesces the exact current host before an already-reviewed down executes", async () => {
    const fixture = dependencies({ initialStack: stack(true) });
    await runAuthorityStaging("down", INPUT, fixture.dependencies);
    const receipt = await runAuthorityStaging("down", INPUT, {
      ...fixture.dependencies,
      execute: true,
    });
    expect(receipt).toMatchObject({ action: "down", state: "executed" });
    expect(fixture.events).toContain("ssm-quiesce-host");
    expect(fixture.events.indexOf("ssm-quiesce-host")).toBeLessThan(
      fixture.events.indexOf("execute-change-set"),
    );
  });

  it("refuses down execution when exact mount quiescence cannot be proven", async () => {
    const fixture = dependencies({
      initialStack: stack(true),
      quiesce: "failure",
    });
    await runAuthorityStaging("down", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("down", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("host_quiesce_failed");
    expect(fixture.events).not.toContain("execute-change-set");
  });

  it("recovers the current rolled-back host when CloudFormation fails after quiescence", async () => {
    const replacementInstanceId = "i-fedcba98765432100";
    const fixture = dependencies({
      initialStack: stack(true),
      executeFailure: true,
      rollbackInstanceId: replacementInstanceId,
    });
    await runAuthorityStaging("down", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("down", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("change_set_execute_failed_host_recovered");
    expect(fixture.events.slice(-4)).toEqual([
      "ssm-quiesce-host",
      "execute-change-set",
      "describe-stack",
      "ssm-recover-host",
    ]);
    expect(fixture.recoveredInstanceIds).toEqual([replacementInstanceId]);
  });

  it("reports an explicit failure when a quiesced host cannot be recovered", async () => {
    const fixture = dependencies({
      initialStack: stack(true),
      executeFailure: true,
      recover: "failure",
    });
    await runAuthorityStaging("down", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("down", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("change_set_execute_failed_host_recovery_failed");
    expect(fixture.events).toContain("ssm-recover-host");
  });

  it("refuses host recovery until CloudFormation reaches a proven rollback-complete state", async () => {
    const fixture = dependencies({
      initialStack: stack(true),
      executeFailure: true,
      updateFailureStatus: "UPDATE_ROLLBACK_IN_PROGRESS",
    });
    await runAuthorityStaging("down", INPUT, fixture.dependencies);
    await expect(
      runAuthorityStaging("down", INPUT, {
        ...fixture.dependencies,
        execute: true,
      }),
    ).rejects.toThrow("change_set_execute_failed_host_recovery_failed");
    expect(fixture.events).not.toContain("ssm-recover-host");
  });

  it("refuses any reviewed plan that removes a retained state boundary", async () => {
    const fixture = dependencies({
      changeAction: {
        action: "Remove",
        logicalId: "StagingDataVolume",
        replacement: false,
        resourceType: "AWS::EC2::Volume",
      },
    });
    await expect(
      runAuthorityStaging("down", INPUT, fixture.dependencies),
    ).rejects.toThrow("change_set_persistent_boundary_violation");
  });

  it("refuses conditional replacement of a persistent slot resource", async () => {
    const fixture = dependencies({
      changeAction: {
        action: "Modify",
        logicalId: "StagingHostRole",
        replacement: "Conditional",
        resourceType: "AWS::IAM::Role",
      },
    });
    await expect(
      runAuthorityStaging("up", INPUT, fixture.dependencies),
    ).rejects.toThrow("change_set_persistent_boundary_violation");
  });

  it("normalizes CloudFormation's string replacement values before review", async () => {
    const fixture = dependencies({
      changeAction: {
        action: "Add",
        logicalId: "StagingHost",
        replacement: "False",
        resourceType: "AWS::EC2::Instance",
      },
    });
    const receipt = await runAuthorityStaging(
      "up",
      INPUT,
      fixture.dependencies,
    );
    expect(receipt).toMatchObject({
      change_set_actions: [{ logical_id: "StagingHost", replacement: false }],
    });
  });

  it("uses the stable slot identifier for Cloudflare ownership across new change-set IDs", async () => {
    const fixture = dependencies({ initialStack: { exists: false } });
    await runAuthorityStaging("slot-init", INPUT, fixture.dependencies);
    await runAuthorityStaging("slot-init", INPUT, {
      ...fixture.dependencies,
      execute: true,
    });
    const second = { ...INPUT, operationId: "staging-change-20260827" };
    await runAuthorityStaging("slot-init", second, fixture.dependencies);
    await runAuthorityStaging("slot-init", second, {
      ...fixture.dependencies,
      execute: true,
    });

    expect(fixture.edgeInputs).toHaveLength(2);
    expect(new Set(fixture.edgeInputs.map((value) => value.slotId))).toEqual(
      new Set([INPUT.slotId]),
    );
    expect(
      new Set(fixture.edgeInputs.map((value) => value.operationId)),
    ).toEqual(new Set([INPUT.operationId, second.operationId]));
  });

  it("refuses to use slot-init to mutate an existing stable stack", async () => {
    const fixture = dependencies({ slotInitExistingChange: true });
    await expect(
      runAuthorityStaging("slot-init", INPUT, fixture.dependencies),
    ).rejects.toThrow("slot_init_existing_stack_change");
    expect(fixture.events).not.toContain("execute-change-set");
    expect(fixture.events).not.toContain("edge-install-token");
  });

  it("rejects a raw management token in lifecycle input", async () => {
    const fixture = dependencies();
    await expect(
      runAuthorityStaging(
        "slot-init",
        { ...INPUT, apiToken: TOKEN },
        fixture.dependencies,
      ),
    ).rejects.toThrow("input_property_not_allowed");
  });

  it("bounds the slot identifier used to derive the Cloudflare tunnel name", () => {
    expect(() =>
      validateStagingLifecycleInput({
        ...INPUT,
        slotId: `staging-${"a".repeat(40)}`,
      }),
    ).not.toThrow();
    expect(() =>
      validateStagingLifecycleInput({
        ...INPUT,
        slotId: `staging-${"a".repeat(41)}`,
      }),
    ).toThrow("slot_id_invalid");
    expect(() =>
      validateStagingLifecycleInput({
        ...INPUT,
        edge: { ...INPUT.edge, tunnelName: "operator-selected-name" },
      }),
    ).toThrow("edge_property_not_allowed");
  });

  it("uses only the committed template and keeps AWS secret access write-only", async () => {
    const fixture = dependencies();
    await expect(
      runAuthorityStaging(
        "slot-init",
        { ...INPUT, templatePath: "/private/tmp/alternate.json" },
        fixture.dependencies,
      ),
    ).rejects.toThrow("input_property_not_allowed");

    const source = readFileSync(CLI, "utf8");
    expect(source).not.toMatch(/["'](?:batch-)?get-secret-value["']/);
    expect(source).toContain('"put-secret-value",\n          "--region",');
    expect(source).toContain(
      '"--secret-string",\n          "file:///dev/stdin"',
    );
    expect(source).toContain(
      '"describe-events",\n      "--region",\n      region,',
    );
    expect(source).toContain('"--filters",\n      "FailedEvents=true"');
    expect(source).not.toContain('"describe-stack-events"');
    expect(source).toContain("delete environment.ECHO_CLOUDFLARE_API_TOKEN");
  });

  it("rejects a raw outer-process Cloudflare token before it can reach AWS or Cloudflare", () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "slot-init", "--input", "missing.json"],
      {
        encoding: "utf8",
        env: { ...process.env, ECHO_CLOUDFLARE_API_TOKEN: TOKEN },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "cloudflare_api_token_dynamic_reference_required",
    );
    expect(result.stderr).not.toContain(TOKEN);
  });

  it("does not require Cloudflare secret resolution for a slot-init plan", () => {
    const environment = { ...process.env };
    delete environment.ECHO_CLOUDFLARE_API_TOKEN;
    delete environment.ECHO_AUTHORITY_STAGING_ASM_EXEC;
    const result = spawnSync(
      process.execPath,
      [CLI, "slot-init", "--input", "missing.json"],
      {
        encoding: "utf8",
        env: environment,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("input_file_invalid");
    expect(result.stderr).not.toContain("cloudflare_api_token");
  });

  it("rejects a raw status token before describing AWS", () => {
    const aws = withFakeAws();
    const inputPath = join(aws.root, "input.json");
    writeFileSync(inputPath, JSON.stringify(INPUT), { mode: 0o600 });
    try {
      const result = spawnSync(
        process.execPath,
        [CLI, "status", "--input", inputPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ECHO_CLOUDFLARE_API_TOKEN: TOKEN,
            FAKE_AWS_LOG: aws.log,
            PATH: `${aws.root}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "cloudflare_api_token_dynamic_reference_required",
      );
      expect(result.stderr).not.toContain(TOKEN);
      expect(() => readFileSync(aws.log, "utf8")).toThrow();
    } finally {
      rmSync(aws.root, { force: true, recursive: true });
    }
  });

  it("reports an AWS-only recovery status before resolving the Cloudflare token", () => {
    const aws = withFakeAws();
    const asm = withFakeAsmExec();
    const inputPath = join(aws.root, "input.json");
    writeFileSync(inputPath, JSON.stringify(INPUT), { mode: 0o600 });
    try {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ECHO_CLOUDFLARE_API_TOKEN:
          "{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/cloudflare-management-abc:SecretString:cloudflare_api_token}}",
        FAKE_ASM_LOG: asm.log,
        FAKE_AWS_LOG: aws.log,
        FAKE_AWS_STACK_RESPONSE: JSON.stringify({
          Stacks: [
            {
              EnableTerminationProtection: false,
              Outputs: [],
              StackStatus: "CREATE_FAILED",
            },
          ],
        }),
        PATH: `${aws.root}:${asm.root}:${process.env.PATH ?? ""}`,
      };
      delete environment.ECHO_AUTHORITY_STAGING_ASM_EXEC;
      const result = spawnSync(
        process.execPath,
        [CLI, "status", "--input", inputPath],
        { encoding: "utf8", env: environment },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "status",
        edge_checked: false,
        recovery_action: "slot-init",
        state: "failed_create",
      });
      expect(readFileSync(aws.log, "utf8")).toContain(
        "ARG=cloudformation\nARG=describe-stacks",
      );
      expect(readFileSync(aws.log, "utf8")).toContain("TOKEN_ENV=unset");
      expect(() => readFileSync(asm.log, "utf8")).toThrow();
    } finally {
      rmSync(aws.root, { force: true, recursive: true });
      rmSync(asm.root, { force: true, recursive: true });
    }
  });

  it("resolves the Cloudflare token only after status proves the stack is healthy", () => {
    const aws = withFakeAws();
    const asm = withFakeAsmExec();
    const inputPath = join(aws.root, "input.json");
    writeFileSync(inputPath, JSON.stringify(INPUT), { mode: 0o600 });
    try {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ECHO_CLOUDFLARE_API_TOKEN:
          "{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/cloudflare-management-abc:SecretString:cloudflare_api_token}}",
        FAKE_ASM_LOG: asm.log,
        FAKE_AWS_LOG: aws.log,
        FAKE_AWS_STACK_RESPONSE: JSON.stringify({
          Stacks: [
            {
              EnableTerminationProtection: true,
              Outputs: [
                {
                  OutputKey: "AuthorityTunnelTokenSecretArn",
                  OutputValue: SECRET_ARN,
                },
                {
                  OutputKey: "StagingHostReady",
                  OutputValue: "false",
                },
              ],
              StackStatus: "UPDATE_COMPLETE",
            },
          ],
        }),
        PATH: `${aws.root}:${asm.root}:${process.env.PATH ?? ""}`,
      };
      delete environment.ECHO_AUTHORITY_STAGING_ASM_EXEC;
      const result = spawnSync(
        process.execPath,
        [CLI, "status", "--input", inputPath],
        { encoding: "utf8", env: environment },
      );
      expect(result.status).toBe(86);
      expect(readFileSync(aws.log, "utf8")).toContain(
        "ARG=cloudformation\nARG=describe-stacks",
      );
      const call = readFileSync(asm.log, "utf8");
      expect(call).toContain("TOKEN_KIND=dynamic");
      expect(call).not.toContain("cloudflare-management-abc");
    } finally {
      rmSync(aws.root, { force: true, recursive: true });
      rmSync(asm.root, { force: true, recursive: true });
    }
  });

  it("rechecks AWS in the resolved child before touching an edge whose stack rolled back", () => {
    const aws = withFakeAws();
    const asm = withReexecingFakeAsmExec();
    const inputPath = join(aws.root, "input.json");
    writeFileSync(inputPath, JSON.stringify(INPUT), { mode: 0o600 });
    const healthy = {
      Stacks: [
        {
          EnableTerminationProtection: true,
          Outputs: [
            {
              OutputKey: "AuthorityTunnelTokenSecretArn",
              OutputValue: SECRET_ARN,
            },
            { OutputKey: "StagingHostReady", OutputValue: "false" },
          ],
          StackStatus: "UPDATE_COMPLETE",
        },
      ],
    };
    const rolledBack = {
      Stacks: [
        {
          EnableTerminationProtection: true,
          Outputs: [
            {
              OutputKey: "AuthorityTunnelTokenSecretArn",
              OutputValue: SECRET_ARN,
            },
            { OutputKey: "StagingHostReady", OutputValue: "false" },
          ],
          StackStatus: "UPDATE_ROLLBACK_COMPLETE",
        },
      ],
    };
    try {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ECHO_CLOUDFLARE_API_TOKEN:
          "{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/cloudflare-management-abc:SecretString:cloudflare_api_token}}",
        FAKE_AWS_LOG: aws.log,
        FAKE_AWS_STACK_RESPONSE: JSON.stringify(healthy),
        FAKE_AWS_STACK_RESPONSE_AFTER_ASM: JSON.stringify(rolledBack),
        PATH: `${aws.root}:${asm.root}:${process.env.PATH ?? ""}`,
      };
      delete environment.ECHO_AUTHORITY_STAGING_ASM_EXEC;
      const result = spawnSync(
        process.execPath,
        [CLI, "status", "--input", inputPath],
        { encoding: "utf8", env: environment },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "status",
        edge_checked: false,
        recovery_action: "up",
        state: "update_rolled_back",
      });
      const calls = readFileSync(aws.log, "utf8");
      expect(calls.match(/ARG=describe-stacks/g)).toHaveLength(2);
      expect(result.stdout).not.toContain("resolved-test-token");
      expect(result.stderr).not.toContain("resolved-test-token");
    } finally {
      rmSync(aws.root, { force: true, recursive: true });
      rmSync(asm.root, { force: true, recursive: true });
    }
  });

  it("pins and sanitizes the AWS profile used by asm-exec", () => {
    const fake = withFakeAsmExec();
    try {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        AWS_ACCESS_KEY_ID: "fake-ambient-access-key",
        AWS_CONFIG_FILE: "/private/tmp/wrong-aws-config",
        AWS_DEFAULT_PROFILE: "wrong-default-profile",
        AWS_PROFILE: "wrong-profile",
        AWS_SECRET_ACCESS_KEY: "fake-ambient-secret-key",
        AWS_SESSION_TOKEN: "fake-ambient-session-token",
        AWS_SHARED_CREDENTIALS_FILE: "/private/tmp/wrong-aws-credentials",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/private/tmp/wrong-web-identity",
        ECHO_CLOUDFLARE_API_TOKEN:
          "{{resolve:secretsmanager:arn:aws:secretsmanager:us-west-2:123456789012:secret:echo/staging/cloudflare-management-abc:SecretString:cloudflare_api_token}}",
        FAKE_ASM_LOG: fake.log,
        PATH: `${fake.root}:${process.env.PATH ?? ""}`,
      };
      delete environment.ECHO_AUTHORITY_STAGING_ASM_EXEC;
      const result = spawnSync(
        process.execPath,
        [CLI, "slot-init", "--input", "missing.json", "--execute"],
        { encoding: "utf8", env: environment },
      );
      expect(result.status).toBe(86);
      const call = readFileSync(fake.log, "utf8");
      expect(call).toContain("PROFILE_ENV=echo-prod");
      expect(call).toContain("DEFAULT_PROFILE_ENV=echo-prod");
      expect(call).toContain("ACCESS_KEY_ENV=unset");
      expect(call).toContain("SECRET_KEY_ENV=unset");
      expect(call).toContain("SESSION_TOKEN_ENV=unset");
      expect(call).toContain("WEB_IDENTITY_ENV=unset");
      expect(call).toContain("CONFIG_FILE_ENV=unset");
      expect(call).toContain("CREDENTIALS_FILE_ENV=unset");
      expect(call).toContain("TOKEN_KIND=dynamic");
      expect(call).not.toContain("cloudflare-management-abc");
    } finally {
      rmSync(fake.root, { force: true, recursive: true });
    }
  });

  it("retries an uncertain ExecuteChangeSet request with the same client token", async () => {
    const fake = withFakeAws();
    const previous = {
      count: process.env.FAKE_AWS_EXECUTE_COUNT,
      failures: process.env.FAKE_AWS_EXECUTE_FAILURES,
      log: process.env.FAKE_AWS_LOG,
      path: process.env.PATH,
    };
    try {
      process.env.FAKE_AWS_EXECUTE_COUNT = fake.executeCount;
      process.env.FAKE_AWS_EXECUTE_FAILURES = "1";
      process.env.FAKE_AWS_LOG = fake.log;
      process.env.PATH = `${fake.root}:${previous.path ?? ""}`;
      const adapters = createAwsCliAdapters();
      await adapters.cloudFormation!.executeChangeSet({
        changeSetId: "change-set-execute-retry",
        changeSetType: "UPDATE",
        clientRequestToken: INPUT.operationId,
        region: INPUT.region,
        stackName: INPUT.stack.name,
      });
      const calls = readFileSync(fake.log, "utf8");
      expect(readFileSync(fake.executeCount, "utf8")).toBe("2\n");
      expect(
        calls.match(
          new RegExp(
            `ARG=--client-request-token\\nARG=${INPUT.operationId}`,
            "g",
          ),
        ),
      ).toHaveLength(2);
      expect(calls).toContain("ARG=wait\nARG=stack-update-complete");
    } finally {
      if (previous.count === undefined)
        delete process.env.FAKE_AWS_EXECUTE_COUNT;
      else process.env.FAKE_AWS_EXECUTE_COUNT = previous.count;
      if (previous.failures === undefined)
        delete process.env.FAKE_AWS_EXECUTE_FAILURES;
      else process.env.FAKE_AWS_EXECUTE_FAILURES = previous.failures;
      if (previous.log === undefined) delete process.env.FAKE_AWS_LOG;
      else process.env.FAKE_AWS_LOG = previous.log;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      rmSync(fake.root, { force: true, recursive: true });
    }
  });

  it("leaves a quiesced host stopped when both idempotent execute attempts are uncertain", async () => {
    const fake = withFakeAws();
    const fixture = dependencies({ initialStack: stack(true) });
    const previous = {
      count: process.env.FAKE_AWS_EXECUTE_COUNT,
      failures: process.env.FAKE_AWS_EXECUTE_FAILURES,
      log: process.env.FAKE_AWS_LOG,
      path: process.env.PATH,
    };
    try {
      process.env.FAKE_AWS_EXECUTE_COUNT = fake.executeCount;
      process.env.FAKE_AWS_EXECUTE_FAILURES = "2";
      process.env.FAKE_AWS_LOG = fake.log;
      process.env.PATH = `${fake.root}:${previous.path ?? ""}`;
      const adapters = createAwsCliAdapters();
      await expect(
        runAuthorityStaging("down", INPUT, {
          ...fixture.dependencies,
          cloudFormation: {
            ...fixture.dependencies.cloudFormation,
            executeChangeSet: adapters.cloudFormation!.executeChangeSet,
          },
          execute: true,
        }),
      ).rejects.toThrow("change_set_execute_failed_host_recovery_failed");
      const calls = readFileSync(fake.log, "utf8");
      expect(readFileSync(fake.executeCount, "utf8")).toBe("2\n");
      expect(
        calls.match(
          new RegExp(
            `ARG=--client-request-token\\nARG=${INPUT.operationId}`,
            "g",
          ),
        ),
      ).toHaveLength(2);
      expect(fixture.events).toContain("ssm-quiesce-host");
      expect(fixture.events).not.toContain("ssm-recover-host");
    } finally {
      if (previous.count === undefined)
        delete process.env.FAKE_AWS_EXECUTE_COUNT;
      else process.env.FAKE_AWS_EXECUTE_COUNT = previous.count;
      if (previous.failures === undefined)
        delete process.env.FAKE_AWS_EXECUTE_FAILURES;
      else process.env.FAKE_AWS_EXECUTE_FAILURES = previous.failures;
      if (previous.log === undefined) delete process.env.FAKE_AWS_LOG;
      else process.env.FAKE_AWS_LOG = previous.log;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      rmSync(fake.root, { force: true, recursive: true });
    }
  });

  it("drives the default AWS CLI adapter with bounded create and write-only secret arguments", async () => {
    const fake = withFakeAws();
    const previous = {
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      configFile: process.env.AWS_CONFIG_FILE,
      defaultProfile: process.env.AWS_DEFAULT_PROFILE,
      describe: process.env.FAKE_AWS_DESCRIBE_RESPONSE,
      log: process.env.FAKE_AWS_LOG,
      path: process.env.PATH,
      profile: process.env.AWS_PROFILE,
      secretKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      sharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      stdin: process.env.FAKE_AWS_STDIN,
      token: process.env.ECHO_CLOUDFLARE_API_TOKEN,
      webIdentity: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
    };
    try {
      process.env.PATH = `${fake.root}:${previous.path ?? ""}`;
      process.env.FAKE_AWS_LOG = fake.log;
      process.env.FAKE_AWS_STDIN = fake.stdin;
      process.env.ECHO_CLOUDFLARE_API_TOKEN = TOKEN;
      process.env.AWS_ACCESS_KEY_ID = "fake-ambient-access-key";
      process.env.AWS_CONFIG_FILE = "/private/tmp/wrong-aws-config";
      process.env.AWS_DEFAULT_PROFILE = "wrong-default-profile";
      process.env.AWS_PROFILE = "wrong-profile";
      process.env.AWS_SECRET_ACCESS_KEY = "fake-ambient-secret-key";
      process.env.AWS_SESSION_TOKEN = "fake-ambient-session-token";
      process.env.AWS_SHARED_CREDENTIALS_FILE =
        "/private/tmp/wrong-aws-credentials";
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE =
        "/private/tmp/wrong-web-identity";
      const adapters = createAwsCliAdapters();
      await adapters.putSecretValue!({
        clientRequestToken: "d".repeat(64),
        secretArn: SECRET_ARN,
        secretString: "connector-token-not-a-real-secret",
      });
      const secretCall = readFileSync(fake.log, "utf8");
      expect(secretCall).toContain("ARG=secretsmanager\nARG=put-secret-value");
      expect(secretCall).toContain("ARG=--profile\nARG=echo-prod");
      expect(secretCall).toContain("ARG=--region\nARG=us-west-2");
      expect(secretCall).toContain(
        "ARG=--secret-string\nARG=file:///dev/stdin",
      );
      expect(secretCall).toContain("TOKEN_ENV=unset");
      expect(secretCall).toContain("PROFILE_ENV=echo-prod");
      expect(secretCall).toContain("DEFAULT_PROFILE_ENV=echo-prod");
      expect(secretCall).toContain("ACCESS_KEY_ENV=unset");
      expect(secretCall).toContain("SECRET_KEY_ENV=unset");
      expect(secretCall).toContain("SESSION_TOKEN_ENV=unset");
      expect(secretCall).toContain("WEB_IDENTITY_ENV=unset");
      expect(secretCall).toContain("CONFIG_FILE_ENV=unset");
      expect(secretCall).toContain("CREDENTIALS_FILE_ENV=unset");
      expect(secretCall).not.toContain(TOKEN);
      expect(secretCall).not.toContain("connector-token-not-a-real-secret");
      expect(JSON.parse(readFileSync(fake.stdin, "utf8"))).toEqual({
        token: "connector-token-not-a-real-secret",
      });

      writeFileSync(fake.log, "");
      const templateSha256 = "e".repeat(64);
      const changeSetResponse = {
        ChangeSetId: "change-set-default-adapter",
        Changes: [
          {
            ResourceChange: {
              Action: "Add",
              LogicalResourceId: "StagingVpc",
              ResourceType: "AWS::EC2::VPC",
            },
          },
        ],
        Parameters: [{ ParameterKey: "HostEnabled", ParameterValue: "false" }],
        Status: "CREATE_COMPLETE",
      };
      const typeCases = [
        {
          expectedMatch: true,
          name: "omitted CREATE response type",
          requestType: "CREATE" as const,
          response: {
            ...changeSetResponse,
            Description: `echo-authority-staging-template-${templateSha256}-CREATE`,
            OnStackFailure: "DO_NOTHING",
          },
        },
        {
          expectedMatch: true,
          name: "null CREATE response type",
          requestType: "CREATE" as const,
          response: {
            ...changeSetResponse,
            ChangeSetType: null,
            Description: `echo-authority-staging-template-${templateSha256}-CREATE`,
            OnStackFailure: "DO_NOTHING",
          },
        },
        {
          expectedMatch: true,
          name: "omitted UPDATE response type and failure policy",
          requestType: "UPDATE" as const,
          response: {
            ...changeSetResponse,
            Description: `echo-authority-staging-template-${templateSha256}-UPDATE`,
          },
        },
        {
          expectedMatch: true,
          name: "null UPDATE response type",
          requestType: "UPDATE" as const,
          response: {
            ...changeSetResponse,
            ChangeSetType: null,
            Description: `echo-authority-staging-template-${templateSha256}-UPDATE`,
            OnStackFailure: null,
          },
        },
        {
          expectedMatch: false,
          name: "UPDATE request with explicit CREATE response type",
          requestType: "UPDATE" as const,
          response: {
            ...changeSetResponse,
            ChangeSetType: "CREATE",
            Description: `echo-authority-staging-template-${templateSha256}-UPDATE`,
          },
        },
      ];
      for (const [index, typeCase] of typeCases.entries()) {
        process.env.FAKE_AWS_DESCRIBE_RESPONSE = JSON.stringify(
          typeCase.response,
        );
        const plan = await adapters.cloudFormation!.createChangeSet({
          capabilities: ["CAPABILITY_IAM"],
          changeSetName: `echo-authority-${typeCase.requestType.toLowerCase()}-staging-adapter-test-${index}`,
          changeSetType: typeCase.requestType,
          clientToken: `staging-adapter-test-00${index + 1}`,
          ...(typeCase.requestType === "CREATE"
            ? { onStackFailure: "DO_NOTHING" as const }
            : {}),
          parameters: { HostEnabled: "false" },
          region: "us-west-2",
          stackName: "echo-authority-staging-adapter-test",
          templatePath: "/private/tmp/committed-template.json",
          templateSha256,
        });
        expect(plan.matchesExpected, typeCase.name).toBe(
          typeCase.expectedMatch,
        );
        if (typeCase.expectedMatch)
          expect(plan).toMatchObject({
            changeSetType: typeCase.requestType,
            status: "CREATE_COMPLETE",
          });
      }

      // The pre-binding live description remains non-reviewable, even though
      // its other fields would have matched a CREATE request.
      process.env.FAKE_AWS_DESCRIBE_RESPONSE = JSON.stringify({
        ...changeSetResponse,
        Description: `echo-authority-staging-template-${templateSha256}`,
        OnStackFailure: "DO_NOTHING",
      });
      const legacyCreate = await adapters.cloudFormation!.createChangeSet({
        capabilities: ["CAPABILITY_IAM"],
        changeSetName: "echo-authority-slot-init-staging-adapter-test-legacy",
        changeSetType: "CREATE",
        clientToken: "staging-adapter-test-003",
        onStackFailure: "DO_NOTHING",
        parameters: { HostEnabled: "false" },
        region: "us-west-2",
        stackName: "echo-authority-staging-adapter-test",
        templatePath: "/private/tmp/committed-template.json",
        templateSha256,
      });
      expect(legacyCreate.matchesExpected).toBe(false);

      // Nor can an explicit, conflicting response type be used as a CREATE
      // plan just because its request-bound description matches.
      process.env.FAKE_AWS_DESCRIBE_RESPONSE = JSON.stringify({
        ...changeSetResponse,
        ChangeSetType: "UPDATE",
        Description: `echo-authority-staging-template-${templateSha256}-CREATE`,
        OnStackFailure: "DO_NOTHING",
      });
      const conflictingCreate = await adapters.cloudFormation!.createChangeSet({
        capabilities: ["CAPABILITY_IAM"],
        changeSetName: "echo-authority-slot-init-staging-adapter-test-conflict",
        changeSetType: "CREATE",
        clientToken: "staging-adapter-test-004",
        onStackFailure: "DO_NOTHING",
        parameters: { HostEnabled: "false" },
        region: "us-west-2",
        stackName: "echo-authority-staging-adapter-test",
        templatePath: "/private/tmp/committed-template.json",
        templateSha256,
      });
      expect(conflictingCreate.matchesExpected).toBe(false);
      const createCalls = readFileSync(fake.log, "utf8");
      expect(createCalls).toContain("ARG=--on-stack-failure\nARG=DO_NOTHING");
      expect(createCalls.match(/ARG=--profile\nARG=echo-prod/g)).toHaveLength(
        21,
      );
      expect(createCalls.match(/^PROFILE_ENV=echo-prod$/gm)).toHaveLength(21);
      expect(createCalls.match(/ACCESS_KEY_ENV=unset/g)).toHaveLength(21);
      expect(createCalls.match(/^TOKEN_ENV=unset$/gm)).toHaveLength(21);
    } finally {
      if (previous.accessKey === undefined)
        delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previous.accessKey;
      if (previous.configFile === undefined) delete process.env.AWS_CONFIG_FILE;
      else process.env.AWS_CONFIG_FILE = previous.configFile;
      if (previous.defaultProfile === undefined)
        delete process.env.AWS_DEFAULT_PROFILE;
      else process.env.AWS_DEFAULT_PROFILE = previous.defaultProfile;
      if (previous.describe === undefined)
        delete process.env.FAKE_AWS_DESCRIBE_RESPONSE;
      else process.env.FAKE_AWS_DESCRIBE_RESPONSE = previous.describe;
      if (previous.log === undefined) delete process.env.FAKE_AWS_LOG;
      else process.env.FAKE_AWS_LOG = previous.log;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.profile === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = previous.profile;
      if (previous.secretKey === undefined)
        delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous.secretKey;
      if (previous.sessionToken === undefined)
        delete process.env.AWS_SESSION_TOKEN;
      else process.env.AWS_SESSION_TOKEN = previous.sessionToken;
      if (previous.sharedCredentialsFile === undefined)
        delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      else
        process.env.AWS_SHARED_CREDENTIALS_FILE =
          previous.sharedCredentialsFile;
      if (previous.stdin === undefined) delete process.env.FAKE_AWS_STDIN;
      else process.env.FAKE_AWS_STDIN = previous.stdin;
      if (previous.token === undefined)
        delete process.env.ECHO_CLOUDFLARE_API_TOKEN;
      else process.env.ECHO_CLOUDFLARE_API_TOKEN = previous.token;
      if (previous.webIdentity === undefined)
        delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
      else process.env.AWS_WEB_IDENTITY_TOKEN_FILE = previous.webIdentity;
      rmSync(fake.root, { force: true, recursive: true });
    }
  });
});
