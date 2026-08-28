import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOnboardingInputArchive,
  cleanupOnboardingTransfer,
  executeOnboardingTransfer,
  onboardingTransferSsmCommands,
  planOnboardingTransfer,
} from "../../tools/authority-staging-onboarding-transfer.mjs";
import { spawnSync } from "node:child_process";

const INPUT_FILES = [
  "onboarding.clean-v1.json",
  "release.json",
  "runtime-profile.json",
  "oidc-config.json",
  "oidc-client-secret",
  "slack-bot-token",
  "slack-signing-secret",
  "granola-credential",
  "llm-credential",
];
const temporary: string[] = [];

function privateDirectory(label: string) {
  const path = mkdtempSync(join(tmpdir(), label));
  chmodSync(path, 0o700);
  temporary.push(path);
  return path;
}

function inputDirectory() {
  const path = privateDirectory("echo-authority-onboarding-input-");
  for (const name of INPUT_FILES) {
    const file = join(path, name);
    writeFileSync(file, `${name}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return path;
}

const KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/11111111-1111-1111-1111-111111111111";

function fakeAws(options: {
  headFails?: boolean;
  nonIamChange?: boolean;
  ssmFails?: boolean;
  deleteFailsOnce?: boolean;
  preexistingKey?: boolean;
  putThrowsCommitted?: boolean;
  ambiguousPut?: boolean;
  inventoryFailsAfterPut?: boolean;
  headMismatchAfterPut?: boolean;
  invocationMissingCount?: number;
  inventoryMode?: "delete-marker" | "multipart" | "truncated";
  truncateCleanupInventory?: boolean;
  grantWaitAdvanceMs?: number;
  ssmStatuses?: string[];
} = {}) {
  const calls: string[][] = [];
  let active = false;
  let expiresAt = "2030-01-01T00:00:00Z";
  let objectSha = "";
  let clock = 0;
  const ssmStatuses = [...(options.ssmStatuses ?? [])];
  let deleteFails = options.deleteFailsOnce === true ? 1 : 0;
  let putAttempted = false;
  let deleteAttempted = false;
  let deleteCalls = 0;
  let objectVersions = options.preexistingKey ? ["preexist-0001"] : [];
  let invocationMissing = options.invocationMissingCount ?? 0;
  const stack = () => ({
    Stacks: [
      {
        StackStatus: "UPDATE_COMPLETE",
        EnableTerminationProtection: true,
        Outputs: [
          { OutputKey: "OnboardingTransferBucketName", OutputValue: "echo-authority-onboarding" },
          { OutputKey: "OnboardingTransferKeyArn", OutputValue: KEY_ARN },
          { OutputKey: "StagingHostInstanceId", OutputValue: "i-12345678" },
          { OutputKey: "StagingHostReady", OutputValue: "true" },
        ],
        Parameters: [
          { ParameterKey: "HostEnabled", ParameterValue: "true" },
          { ParameterKey: "OnboardingInputObjectKey", ParameterValue: active ? "authority-staging/onboarding/onboarding-transfer-001.tar.gz" : "" },
          { ParameterKey: "OnboardingInputObjectVersion", ParameterValue: active ? "version-0001" : "" },
          { ParameterKey: "OnboardingInputAccessExpiresAt", ParameterValue: active ? expiresAt : "" },
        ],
      },
    ],
  });
  const json = (args: readonly string[]) => {
    calls.push([...args]);
    const command = args.slice(0, 2).join(" ");
    if (command === "cloudformation describe-stacks") return stack();
    if (command === "s3api put-object") {
      objectSha = (args[args.indexOf("--metadata") + 1] as string).replace("sha256=", "");
      putAttempted = true;
      objectVersions = options.ambiguousPut ? ["version-0001", "version-0002"] : ["version-0001"];
      if (options.putThrowsCommitted) throw new Error("simulated post-commit disconnect");
      return { VersionId: "version-0001" };
    }
    if (command === "s3api head-object") {
      if (options.headFails) throw new Error("head failed");
      return {
        Metadata: { sha256: options.headMismatchAfterPut && putAttempted ? "0".repeat(64) : objectSha },
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: KEY_ARN,
      };
    }
    if (command === "cloudformation create-change-set") {
      const values = JSON.parse(args[args.indexOf("--parameters") + 1] as string) as { ParameterKey: string; ParameterValue: string }[];
      expiresAt = values.find((item) => item.ParameterKey === "OnboardingInputAccessExpiresAt")?.ParameterValue ?? expiresAt;
      return {};
    }
    if (command === "cloudformation describe-change-set") {
      const name = args[args.indexOf("--change-set-name") + 1];
      const grant = name.includes("onboarding-grant");
      return {
        Status: "CREATE_COMPLETE",
        ChangeSetId: grant ? "grant-change-set" : "clear-change-set",
        Changes: options.nonIamChange
          ? [{ ResourceChange: { Action: "Modify", LogicalResourceId: "StagingHost", ResourceType: "AWS::EC2::Instance" } }]
          : [{ ResourceChange: { Action: grant ? "Add" : "Remove", LogicalResourceId: "StagingHostOnboardingInputAccess", ResourceType: "AWS::IAM::Policy" } }],
      };
    }
    if (command === "ssm send-command") return { Command: { CommandId: "command-1" } };
    if (command === "ssm get-command-invocation") {
      if (invocationMissing > 0) {
        invocationMissing -= 1;
        throw new Error("InvocationDoesNotExist");
      }
      const status = options.ssmFails ? "Failed" : (ssmStatuses.shift() ?? "Success");
      return { Status: status, StandardOutputContent: status === "Success" ? "authority-staging-onboarding-input-transferred\n" : "" };
    }
    if (command === "s3api delete-object") {
      deleteCalls += 1;
      if (deleteFails > 0) {
        deleteAttempted = true;
        return {};
      }
      const version = args[args.indexOf("--version-id") + 1];
      objectVersions = objectVersions.filter((candidate) => candidate !== version);
      return {};
    }
    if (command === "s3api list-object-versions") {
      if (options.truncateCleanupInventory === true && deleteCalls > 0)
        return { Versions: [], DeleteMarkers: [], IsTruncated: true };
      if (options.inventoryMode === "truncated") return { Versions: [], DeleteMarkers: [], IsTruncated: true };
      if (options.inventoryFailsAfterPut && putAttempted) throw new Error("inventory unavailable");
      if (deleteAttempted && deleteFails > 0) deleteFails -= 1;
      if (objectVersions.length) {
        return {
          Versions: objectVersions.map((VersionId) => ({
            Key: "authority-staging/onboarding/onboarding-transfer-001.tar.gz",
            VersionId,
          })),
          DeleteMarkers: [],
        };
      }
      if (options.inventoryMode === "delete-marker") {
        return { Versions: [], DeleteMarkers: [{ Key: "authority-staging/onboarding/onboarding-transfer-001.tar.gz", VersionId: "marker-0001" }] };
      }
      return { Versions: [], DeleteMarkers: [] };
    }
    if (command === "s3api list-multipart-uploads") {
      return options.inventoryMode === "multipart"
        ? { Uploads: [{ Key: "authority-staging/onboarding/onboarding-transfer-001.tar.gz", UploadId: "upload-0001" }] }
        : { Uploads: [] };
    }
    throw new Error(`unexpected JSON command ${command}`);
  };
  const noOutput = (args: readonly string[]) => {
    calls.push([...args]);
    const command = args.slice(0, 2).join(" ");
    if (command === "cloudformation execute-change-set") {
      const id = args[args.indexOf("--change-set-name") + 1];
      active = id === "grant-change-set";
      return;
    }
    if (command === "cloudformation wait") {
      if (args[2] === "stack-update-complete") clock += options.grantWaitAdvanceMs ?? 0;
      return;
    }
    if (command === "ssm wait" || command === "ssm cancel-command") return;
    throw new Error(`unexpected no-output command ${command}`);
  };
  return {
    aws: { json, noOutput, now: () => clock, sleep: (milliseconds: number) => { clock += milliseconds; } },
    calls,
    setSsmStatuses(next: string[]) { ssmStatuses.splice(0, ssmStatuses.length, ...next); },
    setClock(next: number) { clock = next; },
  };
}

function privateConfig(source: string, archive: string) {
  const path = join(archive, "input.json");
  writeFileSync(path, JSON.stringify({
    region: "us-west-2",
    operationId: "onboarding-transfer-001",
    stackName: "echo-authority-staging-test",
    privateInputDir: source,
    archiveDir: archive,
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function called(
  fake: ReturnType<typeof fakeAws>,
  service: string,
  operation: string,
) {
  return fake.calls.some(
    ([actualService, actualOperation]) =>
      actualService === service && actualOperation === operation,
  );
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("Authority staging onboarding transfer", () => {
  it("leaves thirty minutes for review before the fixed access expiry", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const plan = planOnboardingTransfer(privateConfig(source, archive), fakeAws());
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));

    expect(receipt.access_expires_at).toBe("1970-01-01T00:30:00Z");
  });

  it("creates a deterministic private archive from exactly the established input leaves", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    const first = createOnboardingInputArchive({
      sourceDir: source,
      output: join(output, "first.tar.gz"),
    });
    const second = createOnboardingInputArchive({
      sourceDir: source,
      output: join(output, "second.tar.gz"),
    });

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(first.path)).toEqual(readFileSync(second.path));
  });

  it("rejects links and unexpected leaves before the archive can be uploaded", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    rmSync(join(source, "llm-credential"));
    symlinkSync("slack-bot-token", join(source, "llm-credential"));

    expect(() =>
      createOnboardingInputArchive({
        sourceDir: source,
        output: join(output, "onboarding.tar.gz"),
      }),
    ).toThrow("input_file_not_private_regular");
  });

  it("requires the Slack signing secret in the private input shape", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    rmSync(join(source, "slack-signing-secret"));

    expect(() =>
      createOnboardingInputArchive({
        sourceDir: source,
        output: join(output, "onboarding.tar.gz"),
      }),
    ).toThrow("input_directory_shape_invalid");
  });

  it("uses a bounded SSM command that retries IAM propagation, extracts no links, and suppresses onboarding output", () => {
    const commands = onboardingTransferSsmCommands({
      region: "us-west-2",
      artifact: {
        bucket: "echo-authority-staging-onboarding",
        keyArn: KEY_ARN,
        key: "authority-staging/onboarding/onboarding-transfer-001.tar.gz",
        version: "version-0001",
        sha256: "a".repeat(64),
      },
    });
    const joined = commands.join("\n");

    expect(commands[0]).toBe("set -eu");
    expect(joined).not.toContain("pipefail");
    expect(joined).toContain("for attempt in $(seq 1 20)");
    expect(joined).toContain("--version-id 'version-0001'");
    expect(joined).toContain("--expected-bucket-owner '123456789012'");
    expect(joined).toContain("member.issym() or member.islnk()");
    expect(joined).toContain("maximum_total_bytes");
    expect(joined).toContain('"slack-signing-secret"');
    expect(joined).toContain("slack-bot-token slack-signing-secret granola-credential");
    expect(joined).toContain('tr -d " ")" = 9');
    expect(joined).toContain("doctor --input-dir \"$input\" >/dev/null 2>&1");
    expect(joined).toContain("prepare --input-dir \"$input\" >/dev/null 2>&1");
    expect(joined).toContain("authority-staging-onboarding-input-transferred");
    expect(joined).not.toContain("get-secret-value");
  });

  it("uses no-output runners for AWS waits and distinct deterministic grant and clear execution tokens", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws();
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(fake.calls.some((args) => args[0] === "cloudformation" && args[1] === "describe-stacks" && args[2] === "--region")).toBe(true);
    const waits = fake.calls.filter((args) => args[1] === "wait");
    expect(waits.length).toBeGreaterThan(0);
    const executeCalls = fake.calls.filter((args) => args[0] === "cloudformation" && args[1] === "execute-change-set");
    const tokens = executeCalls.map((args) => args[args.indexOf("--client-request-token") + 1]);
    expect(new Set(tokens).size).toBe(2);
  });

  it("cleans successfully after a failed SSM command and keeps no secret sentinel in receipt or AWS arguments", () => {
    const source = inputDirectory();
    writeFileSync(join(source, "llm-credential"), "SECRET-SENTINEL", { mode: 0o600 });
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmFails: true });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(readFileSync(plan.receipt_path, "utf8")).not.toContain("SECRET-SENTINEL");
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_failed_cleaned");
    expect(existsSync(plan.receipt_path)).toBe(false);
    expect(JSON.stringify(fake.calls)).not.toContain("SECRET-SENTINEL");
  });

  it("polls an in-progress SSM command past the waiter window before a terminal success", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmStatuses: Array(25).fill("InProgress") });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(fake.calls.filter((args) => args[0] === "ssm" && args[1] === "get-command-invocation").length).toBeGreaterThan(25);
  });

  it("does not send SSM when the pre-send submission receipt cannot be persisted", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws();
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: () => { throw new Error("disk unavailable"); },
    })).toThrow("ssm_command_submission_unproven");
    expect(called(fake, "ssm", "send-command")).toBe(false);
  });

  it("quarantines a post-send receipt-write failure until grant expiry plus the bounded delivery and execution margin", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws();
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    let replacements = 0;
    const persist = (path: string, receipt: unknown) => {
      replacements += 1;
      if (replacements === 2) throw new Error("post-send disk failure");
      writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    };
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: persist,
    })).toThrow("ssm_command_submission_unproven");
    expect(fake.calls.filter((args) => args[0] === "ssm" && args[1] === "send-command")).toHaveLength(1);
    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_submission_quarantined");
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    expect(fake.calls.filter((args) => args[0] === "cloudformation" && args[1] === "execute-change-set")).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    fake.setClock(Date.parse(receipt.access_expires_at) + 12 * 60 * 1000);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "cleaned" });
  });

  it("bases quarantine on the later pre-send timestamp and never reports an unknown send as prepared", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ grantWaitAdvanceMs: 40 * 60 * 1000 });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    let replacements = 0;
    const persist = (path: string, receipt: unknown) => {
      replacements += 1;
      if (replacements === 2) throw new Error("post-send disk failure");
      writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    };
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: persist,
    })).toThrow("ssm_command_submission_unproven");
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    const oldUnsafeThreshold = Date.parse(receipt.access_expires_at) + 12 * 60 * 1000;
    fake.setClock(oldUnsafeThreshold);
    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_submission_quarantined");
    fake.setClock(Math.max(
      Date.parse(receipt.access_expires_at),
      Date.parse(receipt.submission_started_at) + 10 * 60 * 1000,
    ) + 2 * 60 * 1000);
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_outcome_unproven_cleaned");
    expect(existsSync(plan.receipt_path)).toBe(false);
  });

  it("treats an initial InvocationDoesNotExist as bounded pending before exact success", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ invocationMissingCount: 1 });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(fake.calls.filter((args) => args[0] === "ssm" && args[1] === "get-command-invocation")).toHaveLength(2);
  });

  it("passes the plugin execution timeout, cancels at the local deadline, and refuses cleanup until cancellation is terminal", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmStatuses: Array(100).fill("InProgress") });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    const send = fake.calls.find((args) => args[0] === "ssm" && args[1] === "send-command")!;
    const parameters = JSON.parse(send[send.indexOf("--parameters") + 1]!) as { executionTimeout: string[] };
    expect(parameters.executionTimeout).toEqual(["300"]);
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    expect(existsSync(plan.receipt_path)).toBe(true);
  });

  it("never lets public cleanup revoke or delete while the submitted SSM command is nonterminal, then reconciles exact success", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmStatuses: Array(1000).fill("InProgress") });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    fake.setSsmStatuses(["Success"]);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "prepared_cleaned" });
    expect(fake.calls.filter((args) => args[0] === "ssm" && args[1] === "send-command")).toHaveLength(1);
  });

  it("cleans only after a cancellation reaches a terminal failed status", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmStatuses: [...Array(73).fill("InProgress"), "Failed"] });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_failed_cleaned");
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
    expect(called(fake, "s3api", "delete-object")).toBe(true);
  });

  it("accepts the exact success marker when cancellation races with completion", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ ssmStatuses: [...Array(73).fill("InProgress"), "Cancelling", "Success"] });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
  });

  it("cleans a head-verification failure and rejects a non-IAM change set without leaving recovery material", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const config = privateConfig(source, archive);
    expect(() => planOnboardingTransfer(config, fakeAws({ headFails: true }))).toThrow("head failed");
    expect(existsSync(join(archive, "onboarding-transfer-001.json"))).toBe(false);
    expect(() => planOnboardingTransfer(config, fakeAws({ nonIamChange: true }))).toThrow("change_set_boundary_violation");
  });

  it("rejects an existing recovery receipt before it can upload a second object", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const config = privateConfig(source, archive);
    writeFileSync(join(archive, "onboarding-transfer-onboarding-transfer-001.json"), "{}\n", { mode: 0o600 });
    const fake = fakeAws();
    expect(() => planOnboardingTransfer(config, fake)).toThrow("receipt_destination_exists");
    expect(fake.calls.some((args) => args[0] === "s3" && args[1] === "put-object")).toBe(false);
  });

  it("refuses a preexisting exact courier key before PutObject", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ preexistingKey: true });
    expect(() => planOnboardingTransfer(privateConfig(source, archive), fake)).toThrow("object_key_not_empty");
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "put-object")).toBe(false);
    expect(fake.calls.some((args) => args[0] === "s3api" && ["delete-object", "abort-multipart-upload"].includes(args[1]!))).toBe(false);
  });

  it.each(["delete-marker", "multipart", "truncated"] as const)("refuses %s inventory without deleting or aborting a foreign key", (inventoryMode) => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ inventoryMode });
    expect(() => planOnboardingTransfer(privateConfig(source, archive), fake)).toThrow();
    expect(fake.calls.some((args) => args[0] === "s3api" && ["delete-object", "abort-multipart-upload"].includes(args[1]!))).toBe(false);
  });

  it("exits nonzero with controlled stderr for CLI usage and invalid receipts", () => {
    const script = join(process.cwd(), "tools", "authority-staging-onboarding-transfer.mjs");
    const usage = spawnSync(process.execPath, [script, "bad"], { encoding: "utf8" });
    expect(usage.status).toBe(1);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toContain("authority staging onboarding transfer failed: usage");
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const invalid = join(archive, "invalid.json");
    writeFileSync(invalid, "{}\n", { mode: 0o600 });
    const receipt = spawnSync(process.execPath, [script, "cleanup", "--receipt", invalid], { encoding: "utf8" });
    expect(receipt.status).toBe(1);
    expect(receipt.stdout).toBe("");
    expect(receipt.stderr).toContain("authority staging onboarding transfer failed: receipt_invalid");
  });

  it("cannot call S3 when writing the pre-Put recovery receipt fails", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws();
    expect(() => planOnboardingTransfer(privateConfig(source, archive), {
      ...fake,
      writeReceipt: () => { throw new Error("receipt write failed"); },
    })).toThrow("receipt write failed");
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "put-object")).toBe(false);
  });

  it("recovers a sole version committed before a PutObject client error, then plans and cleans normally", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ putThrowsCommitted: true });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);

    expect(existsSync(plan.receipt_path)).toBe(true);
    const put = fake.calls.find((args) => args[0] === "s3api" && args[1] === "put-object")!;
    expect(put.slice(put.indexOf("--if-none-match"), put.indexOf("--if-none-match") + 2)).toEqual(["--if-none-match", "*"]);
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "head-object")).toBe(true);
    expect(fake.calls.some((args) => args[0] === "cloudformation" && args[1] === "create-change-set")).toBe(true);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "delete-object")).toBe(true);
    expect(existsSync(plan.receipt_path)).toBe(false);
  });

  it("does not adopt or delete a sole committed version whose metadata does not prove ownership", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ putThrowsCommitted: true, headMismatchAfterPut: true });
    expect(() => planOnboardingTransfer(privateConfig(source, archive), fake)).toThrow("object_key_not_owned");
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "delete-object")).toBe(false);
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "abort-multipart-upload")).toBe(false);
  });

  it("keeps an actionable uploading receipt and archive when ambiguous Put reconciliation cannot prove inventory", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ putThrowsCommitted: true, inventoryFailsAfterPut: true });
    const config = privateConfig(source, archive);

    expect(() => planOnboardingTransfer(config, fake)).toThrow("onboarding_transfer_cleanup_required");
    const receiptPath = join(archive, "onboarding-transfer-onboarding-transfer-001.json");
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(join(archive, "onboarding-transfer-001.tar.gz"))).toBe(true);
  });

  it("keeps an actionable uploading receipt and archive when Put reconciliation finds multiple versions", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ putThrowsCommitted: true, ambiguousPut: true });
    const config = privateConfig(source, archive);

    expect(() => planOnboardingTransfer(config, fake)).toThrow("onboarding_transfer_cleanup_required");
    const receiptPath = join(archive, "onboarding-transfer-onboarding-transfer-001.json");
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(join(archive, "onboarding-transfer-001.tar.gz"))).toBe(true);
    expect(() => cleanupOnboardingTransfer(receiptPath, fake)).toThrow("object_key_ownership_unproven");
    expect(existsSync(receiptPath)).toBe(true);
  });

  it("preserves recovery material when exact absence is unproved and permits an explicit cleanup retry", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ deleteFailsOnce: true });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_cleanup_required");
    expect(existsSync(plan.receipt_path)).toBe(true);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "prepared_cleaned" });
    expect(fake.calls.filter((args) => args[0] === "ssm" && args[1] === "send-command")).toHaveLength(1);
  });

  it("refuses cleanup when post-delete exact-key inventory is truncated", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ truncateCleanupInventory: true });
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    const inventoryCall = (args: string[]) =>
      args[0] === "s3api" &&
      ["list-object-versions", "list-multipart-uploads"].includes(args[1]!);
    const inventoryCalls = fake.calls.filter(inventoryCall).length;

    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow(
      "object_key_absence_unproven",
    );
    expect(fake.calls.filter(inventoryCall)).toHaveLength(inventoryCalls + 2);
    expect(existsSync(plan.receipt_path)).toBe(true);
  });

  it("refuses an expiring grant before execution and cleans its courier object", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws();
    const plan = planOnboardingTransfer(privateConfig(source, archive), fake);
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    receipt.access_expires_at = "1970-01-01T00:00:00Z";
    writeFileSync(plan.receipt_path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_grant_expired_cleaned");
    expect(existsSync(plan.receipt_path)).toBe(false);
  });
});
