import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
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
  preflightOnboardingInput,
} from "../../tools/authority-staging-onboarding-transfer.mjs";
import {
  awsCliArguments,
  sanitizedAwsEnvironment,
} from "../../tools/lib/operator-io.mjs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const INPUT_FILES = [
  "onboarding.clean-v1.json",
  "release.json",
  "runtime-profile.json",
  "oidc-config.json",
  "oidc-client-secret",
  "nango-secret-key",
  "llm-credential",
];
const REUSABLE_INPUT_FILES = [
  "onboarding.clean-v1.json",
  "release.json",
  "runtime-profile.json",
];
const STAGING_SYNTHETIC_MEETING_FILES = [
  "01-revenue-signal-calibration.json",
  "02-data-handling-review.json",
  "03-implementation-capacity-triage.json",
  "04-commercial-exception-review.json",
];
const temporary: string[] = [];

function privateDirectory(label: string) {
  const path = mkdtempSync(join(tmpdir(), label));
  chmodSync(path, 0o700);
  temporary.push(path);
  return path;
}

function privateFiles(label: string, names: readonly string[]) {
  const path = privateDirectory(label);
  for (const name of names) {
    const file = join(path, name);
    writeFileSync(file, `${name}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return path;
}

function inputDirectory() {
  return privateFiles("echo-authority-onboarding-input-", INPUT_FILES);
}

function reusableStagingInputDirectory() {
  return privateFiles("echo-authority-rehearsal-input-", REUSABLE_INPUT_FILES);
}

function stagingSyntheticMeetingsDirectory() {
  return privateFiles(
    "echo-authority-staging-meetings-",
    STAGING_SYNTHETIC_MEETING_FILES,
  );
}

function tarEntries(path: string) {
  const bytes = gunzipSync(readFileSync(path));
  const entries: { name: string; content: Buffer }[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(),
      8,
    );
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, content });
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  return entries;
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

function privateConfig(
  source: string,
  archive: string,
  stagingSyntheticMeetingsDir?: string,
  reuseCurrentProviderInputs?: boolean | string,
) {
  const path = join(archive, "input.json");
  writeFileSync(path, JSON.stringify({
    region: "us-west-2",
    operationId: "onboarding-transfer-001",
    stackName: "echo-authority-staging-test",
    privateInputDir: source,
    archiveDir: archive,
    ...(stagingSyntheticMeetingsDir === undefined
      ? {}
      : { stagingSyntheticMeetingsDir }),
    ...(reuseCurrentProviderInputs === undefined
      ? {}
      : { reuseCurrentProviderInputs }),
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("Authority staging onboarding input preflight", () => {
  it("accepts server-local provider input reuse only for the selected four-fixture rehearsal", () => {
    const source = reusableStagingInputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();

    const report = preflightOnboardingInput(
      privateConfig(source, archive, meetings, true),
    );

    expect(report).toMatchObject({
      ready: true,
      reuse_current_provider_inputs: true,
      required_files: REUSABLE_INPUT_FILES.map((name) => ({ name, state: "ready" })),
    });
  });

  it.each([false, "true"])('rejects reuseCurrentProviderInputs=%j', (reuseCurrentProviderInputs) => {
    const source = reusableStagingInputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    expect(() => preflightOnboardingInput(
      privateConfig(source, archive, meetings, reuseCurrentProviderInputs),
    )).toThrow("reuse_current_provider_inputs_invalid");
  });

  it("rejects provider input reuse without the selected four-fixture source", () => {
    const source = reusableStagingInputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    expect(() => preflightOnboardingInput(
      privateConfig(source, archive, undefined, true),
    )).toThrow("reuse_current_provider_inputs_requires_staging_synthetic_meetings");
  });
  it("reports the selected four-fixture directory alongside the ordinary private input", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();

    const report = preflightOnboardingInput(privateConfig(source, archive, meetings));

    expect(report).toMatchObject({ ready: true, staging_synthetic_meetings: { ready: true } });
  });

  it.each([false, true])("rejects a synthetic meeting over the host's 256 KiB limit in complete and reuse bundles (reuse=%s)", (reuseCurrentProviderInputs) => {
    const source = reuseCurrentProviderInputs ? reusableStagingInputDirectory() : inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    truncateSync(join(meetings, STAGING_SYNTHETIC_MEETING_FILES[0]), 256 * 1024 + 1);
    const config = privateConfig(source, output, meetings, reuseCurrentProviderInputs || undefined);

    const report = preflightOnboardingInput(config);

    expect(report.ready).toBe(false);
    expect(report.staging_synthetic_meetings?.required_files[0]).toMatchObject({
      name: STAGING_SYNTHETIC_MEETING_FILES[0],
      state: "too_large",
      detail: "exceeds 262144 bytes",
    });
    expect(() => createOnboardingInputArchive({
      sourceDir: source,
      stagingSyntheticMeetingsDir: meetings,
      ...(reuseCurrentProviderInputs ? { reuseCurrentProviderInputs: true } : {}),
      output: join(output, `${reuseCurrentProviderInputs ? "reuse" : "complete"}.tar.gz`),
    })).toThrow("input_file_too_large");
  });

  it("reports missing, extra, linked, and non-private selected fixtures without exposing extra names", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    rmSync(join(meetings, "01-revenue-signal-calibration.json"));
    rmSync(join(meetings, "03-implementation-capacity-triage.json"));
    symlinkSync("02-data-handling-review.json", join(meetings, "03-implementation-capacity-triage.json"));
    chmodSync(join(meetings, "04-commercial-exception-review.json"), 0o644);
    writeFileSync(join(meetings, "private-oracle.json"), "ignored", { mode: 0o600 });

    const report = preflightOnboardingInput(privateConfig(source, archive, meetings));
    const fixtures = report.staging_synthetic_meetings!;
    const states = new Map(fixtures.required_files.map((file) => [file.name, file.state]));

    expect(report.ready).toBe(false);
    expect(fixtures.directory_private).toBe(true);
    expect(states.get("01-revenue-signal-calibration.json")).toBe("missing");
    expect(states.get("03-implementation-capacity-triage.json")).toBe("not_private_regular");
    expect(states.get("04-commercial-exception-review.json")).toBe("not_private_regular");
    expect(fixtures.unexpected_file_count).toBe(1);
    expect(JSON.stringify(report)).not.toContain("private-oracle.json");
    expect(report.next_action).toBe(
      "remove 1 unexpected file from the staging synthetic meetings directory, then rerun preflight",
    );
  });

  it("rejects a selected fixture directory symlink before archive construction", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const linkedMeetings = join(archive, "linked-meetings");
    symlinkSync(meetings, linkedMeetings);
    const config = privateConfig(source, archive, linkedMeetings);

    expect(preflightOnboardingInput(config)).toMatchObject({
      ready: false,
      staging_synthetic_meetings: { directory_private: false, ready: false },
    });
    expect(() => planOnboardingTransfer(config, fakeAws())).toThrow(
      "staging_synthetic_meetings_directory_not_private",
    );
  });

  it("applies the aggregate limit across ordinary input and selected fixtures", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    for (const name of INPUT_FILES) truncateSync(join(source, name), 6 * 1024 * 1024);
    const totalBytes = 42 * 1024 * 1024 + STAGING_SYNTHETIC_MEETING_FILES
      .reduce((total, name) => total + readFileSync(join(meetings, name)).length, 0);

    const report = preflightOnboardingInput(privateConfig(source, archive, meetings));

    expect(report).toMatchObject({
      ready: false,
      total_bytes: totalBytes,
      bytes_over_limit: totalBytes - 40 * 1024 * 1024,
      staging_synthetic_meetings: { ready: true },
    });
  });

  it("reports a complete private input directory as ready without touching AWS", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const report = preflightOnboardingInput(privateConfig(source, archive));

    expect(report).toMatchObject({
      kind: "echo-authority-staging-onboarding-preflight-v1",
      state: "ready",
      ready: true,
      directory_private: true,
      unexpected_file_count: 0,
      next_action: "run plan",
    });
    expect(report.required_files).toHaveLength(INPUT_FILES.length);
    expect(
      report.required_files.every((file) => file.state === "ready"),
    ).toBe(true);
  });

  it("names every unusable required file instead of one opaque shape failure", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    // The three ways an operator actually arrives at the AWS step unready:
    // a credential never obtained, a file created empty, and one left readable.
    rmSync(join(source, "nango-secret-key"));
    writeFileSync(join(source, "llm-credential"), "", { mode: 0o600 });

    const report = preflightOnboardingInput(privateConfig(source, archive));

    expect(report.ready).toBe(false);
    expect(report.state).toBe("incomplete");
    const byName = new Map(
      report.required_files.map((file) => [file.name, file.state]),
    );
    expect(byName.get("nango-secret-key")).toBe("missing");
    expect(byName.get("llm-credential")).toBe("empty");
    expect(byName.get("release.json")).toBe("ready");
    expect(report.next_action).toContain("nango-secret-key");
    expect(report.next_action).toContain("llm-credential");
    // Metadata only. No file content may appear in a readiness report.
    expect(JSON.stringify(report)).not.toContain("oidc-client-secret\n");
  });

  it("redacts stray filenames and flags a non-private directory before any transfer", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    writeFileSync(join(source, "notes.txt"), "scratch\n", { mode: 0o600 });
    const strayReport = preflightOnboardingInput(privateConfig(source, archive));
    expect(strayReport.ready).toBe(false);
    expect(strayReport.unexpected_file_count).toBe(1);
    expect(JSON.stringify(strayReport)).not.toContain("notes.txt");
    expect(strayReport.next_action).toBe(
      "remove 1 unexpected file from the private input directory, then rerun preflight",
    );

    rmSync(join(source, "notes.txt"));
    chmodSync(source, 0o755);
    const openReport = preflightOnboardingInput(privateConfig(source, archive));
    expect(openReport).toMatchObject({
      ready: false,
      directory_private: false,
      next_action: "make the input directory a current-user 0700 directory",
    });
    chmodSync(source, 0o700);
  });

  it("gives an actionable aggregate-size diagnosis when every file is individually valid", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    for (const name of INPUT_FILES) truncateSync(join(source, name), 6 * 1024 * 1024);

    const report = preflightOnboardingInput(privateConfig(source, archive));

    expect(report).toMatchObject({
      ready: false,
      total_bytes: 42 * 1024 * 1024,
      total_bytes_limit: 40 * 1024 * 1024,
      bytes_over_limit: 2 * 1024 * 1024,
      next_action: "reduce total required input bytes by at least 2097152, to at most 41943040, then rerun preflight",
    });
    expect(report.required_files.every((file) => file.state === "ready")).toBe(true);
  });

  it("pins local AWS CLI calls to echo-prod without inherited endpoint, proxy, or CA overrides", () => {
    const environment = sanitizedAwsEnvironment({
      AWS_ACCESS_KEY_ID: "ambient-key",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_PROFILE: "wrong-profile",
      AWS_ENDPOINT_URL: "https://endpoint.example",
      AWS_ENDPOINT_URL_S3: "https://s3-endpoint.example",
      AWS_CA_BUNDLE: "/tmp/ca.pem",
      HTTPS_PROXY: "https://proxy.example",
      no_proxy: "localhost",
      KEEP_ME: "safe",
    });

    expect(environment).toMatchObject({
      AWS_PROFILE: "echo-prod",
      AWS_DEFAULT_PROFILE: "echo-prod",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
      KEEP_ME: "safe",
    });
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_S3",
      "AWS_CA_BUNDLE",
      "HTTPS_PROXY",
      "no_proxy",
    ]) expect(environment).not.toHaveProperty(key);
  });

  it("passes the approved AWS profile explicitly instead of relying on environment selection", () => {
    const fakeAwsArguments = awsCliArguments([
      "s3api",
      "put-object",
      "--bucket",
      "echo-authority-staging-onboarding",
    ]);

    expect(fakeAwsArguments).toEqual([
      "--no-cli-pager",
      "--profile",
      "echo-prod",
      "s3api",
      "put-object",
      "--bucket",
      "echo-authority-staging-onboarding",
    ]);
  });

  it("exits non-zero from the CLI when the input is not ready", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    rmSync(join(source, "oidc-client-secret"));
    const result = spawnSync(
      process.execPath,
      [
        new URL(
          "../../tools/authority-staging-onboarding-transfer.mjs",
          import.meta.url,
        ).pathname,
        "preflight",
        "--input",
        privateConfig(source, archive),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: false });
  });
});

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

function count(
  fake: ReturnType<typeof fakeAws>,
  service: string,
  operation: string,
) {
  return fake.calls.filter(
    ([actualService, actualOperation]) =>
      actualService === service && actualOperation === operation,
  ).length;
}

// Fresh private input, archive, and fake AWS, planned as the ordinary complete
// transfer or as the four-fixture rehearsal that reuses provider inputs.
function planned(
  fakeOptions: Parameters<typeof fakeAws>[0] = {},
  mode: "complete" | "reuse" = "complete",
) {
  const reuse = mode === "reuse";
  const source = reuse ? reusableStagingInputDirectory() : inputDirectory();
  const archive = privateDirectory("echo-authority-onboarding-archive-");
  const config = reuse
    ? privateConfig(source, archive, stagingSyntheticMeetingsDirectory(), true)
    : privateConfig(source, archive);
  const fake = fakeAws(fakeOptions);
  return { archive, fake, plan: planOnboardingTransfer(config, fake) };
}

function failOnSecondReplace() {
  let replacements = 0;
  return (path: string, receipt: unknown) => {
    replacements += 1;
    if (replacements === 2) throw new Error("post-send disk failure");
    writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  };
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("Authority staging onboarding transfer", () => {
  it("leaves thirty minutes for review before the fixed access expiry", () => {
    const { plan } = planned();
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
      stagingSyntheticMeetingsDir: undefined,
      output: join(output, "second.tar.gz"),
    });

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(first.path)).toEqual(readFileSync(second.path));
    expect(tarEntries(first.path).map((entry) => entry.name)).toEqual(INPUT_FILES);
  });

  it("rejects links and unexpected leaves before the archive can be uploaded", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    rmSync(join(source, "llm-credential"));
    symlinkSync("nango-secret-key", join(source, "llm-credential"));

    expect(() =>
      createOnboardingInputArchive({
        sourceDir: source,
        output: join(output, "onboarding.tar.gz"),
      }),
    ).toThrow("input_file_not_private_regular");
  });

  it("requires the Nango secret key and refuses a leftover Slack input", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    writeFileSync(join(source, "slack-bot-token"), "slack-bot-token\n", { mode: 0o600 });

    expect(() =>
      createOnboardingInputArchive({
        sourceDir: source,
        output: join(output, "leftover.tar.gz"),
      }),
    ).toThrow("input_directory_shape_invalid");
    rmSync(join(source, "slack-bot-token"));
    rmSync(join(source, "nango-secret-key"));

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
    expect(joined).toContain('"nango-secret-key"');
    expect(joined).toContain("oidc-client-secret nango-secret-key llm-credential; do");
    expect(joined).toContain('tr -d " ")" = 7');
    expect(joined).not.toContain("slack");
    expect(joined).toContain("doctor --input-dir \"$input\" >/dev/null 2>&1");
    expect(joined).toContain("prepare --input-dir \"$input\" >/dev/null 2>&1");
    expect(joined).toContain("authority-staging-onboarding-input-transferred");
    expect(joined).not.toContain("get-secret-value");
  });

  it("carries exactly the optional four-fixture corpus to the fixed host directory", () => {
    const source = inputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const archive = createOnboardingInputArchive({
      sourceDir: source,
      stagingSyntheticMeetingsDir: meetings,
      output: join(output, "onboarding.tar.gz"),
    });
    const commands = onboardingTransferSsmCommands({
      region: "us-west-2",
      stagingSyntheticMeetings: true,
      artifact: {
        ...archive,
        bucket: "echo-authority-staging-onboarding",
        keyArn: KEY_ARN,
        key: "authority-staging/onboarding/onboarding-transfer-001.tar.gz",
        version: "version-0001",
      },
    });
    const joined = commands.join("\n");

    const entries = tarEntries(archive.path);
    expect(entries.map((entry) => entry.name)).toEqual([
      ...INPUT_FILES,
      ...STAGING_SYNTHETIC_MEETING_FILES.map((name) => `staging-meetings/${name}`),
    ]);
    for (const name of STAGING_SYNTHETIC_MEETING_FILES) {
      expect(entries.find((entry) => entry.name === `staging-meetings/${name}`)?.content.toString("utf8"))
        .toBe(`${name}\n`);
    }
    expect(joined).toContain('"staging-meetings/01-revenue-signal-calibration.json"');
    expect(joined).toContain('test "$(find "$meetings" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 4');
    expect(joined).toContain('doctor --input-dir "$input" --staging-synthetic-meetings-dir "$meetings" >/dev/null 2>&1');
    expect(joined).toContain('prepare --input-dir "$input" --staging-synthetic-meetings-dir "$meetings" >/dev/null 2>&1');
  });

  it("archives only the three non-secret rehearsal inputs with the four fixed fixtures", () => {
    const source = reusableStagingInputDirectory();
    const output = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const archive = createOnboardingInputArchive({
      sourceDir: source,
      stagingSyntheticMeetingsDir: meetings,
      reuseCurrentProviderInputs: true,
      output: join(output, "rehearsal.tar.gz"),
    });

    expect(tarEntries(archive.path).map((entry) => entry.name)).toEqual([
      ...REUSABLE_INPUT_FILES,
      ...STAGING_SYNTHETIC_MEETING_FILES.map((name) => `staging-meetings/${name}`),
    ]);
    expect(readFileSync(archive.path).includes(Buffer.from("nango-secret-key"))).toBe(false);
    expect(readFileSync(archive.path).includes(Buffer.from("llm-credential"))).toBe(false);
  });

  it("persists reuse mode and invokes only host-local rehearsal input staging", () => {
    const source = reusableStagingInputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const config = privateConfig(source, archive, meetings, true);
    const fake = fakeAws();
    const plan = planOnboardingTransfer(config, fake);
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    rmSync(config);

    expect(receipt).toMatchObject({
      staging_synthetic_meetings: true,
      reuse_current_provider_inputs: true,
    });
    const result = executeOnboardingTransfer(plan.receipt_path, fake);
    expect(result).toMatchObject({
      action: "execute",
      state: "staged_awaiting_human",
      host_stage_path: "/srv/echo-authority-clean-v1/rehearsal-inputs/onboarding-transfer-001",
      next_human_action: expect.stringContaining("prepare-rehearsal --operation-id onboarding-transfer-001"),
    });
    if (!result.completion_path) throw new Error("staged reuse operation must return a completion receipt path");
    const completion = JSON.parse(readFileSync(result.completion_path, "utf8"));
    expect(completion).toMatchObject({
      state: "remote_staged",
      courier_cleanup_state: "complete",
      operation_id: "onboarding-transfer-001",
      artifact_sha256: receipt.sha256,
      region: "us-west-2",
      stack_name: "echo-authority-staging-test",
      instance_id: "i-12345678",
      host_stage_path: "/srv/echo-authority-clean-v1/rehearsal-inputs/onboarding-transfer-001",
    });
    expect(completion.next_human_action).toContain("replace-rehearsal --confirm-no-live-users --reuse-provider-inputs onboarding-transfer-001");
    expect(existsSync(plan.receipt_path)).toBe(false);
    const send = fake.calls.find((args) => args[0] === "ssm" && args[1] === "send-command")!;
    const parameters = JSON.parse(send[send.indexOf("--parameters") + 1]!) as { commands: string[] };
    const command = parameters.commands.join("\n");
    expect(command).toContain("stage-rehearsal-inputs --operation-id 'onboarding-transfer-001'");
    expect(command).toContain(`--artifact-sha256 '${receipt.sha256}'`);
    expect(command).not.toContain(" doctor ");
    expect(command).not.toContain(" prepare ");
    expect(command).not.toContain("nango-secret-key");
    expect(command).not.toContain("llm-credential");
  });

  it("keeps the remote-prepared transfer receipt when rehearsal completion cannot be written", () => {
    const { fake, plan } = planned({}, "reuse");

    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      writeStageReceipt: () => { throw new Error("disk unavailable"); },
    })).toThrow("rehearsal_stage_completion_unproven");
    expect(existsSync(plan.receipt_path)).toBe(true);
    expect(JSON.parse(readFileSync(plan.receipt_path, "utf8"))).toMatchObject({
      state: "remote_prepared",
      reuse_current_provider_inputs: true,
    });
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toMatchObject({
      state: "staged_awaiting_human",
    });
    expect(count(fake, "ssm", "send-command")).toBe(1);
  });

  it("keeps a recoverable tracking receipt if final rehearsal completion replacement fails after courier cleanup", () => {
    const { archive, fake, plan } = planned({}, "reuse");

    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceStageReceipt: () => { throw new Error("disk unavailable"); },
    })).toThrow("rehearsal_stage_completion_unproven");
    expect(existsSync(plan.receipt_path)).toBe(true);
    expect(fake.calls.some((args) => args[0] === "s3api" && args[1] === "delete-object")).toBe(true);
    const completionPath = join(archive, "rehearsal-inputs-onboarding-transfer-001.json");
    expect(JSON.parse(readFileSync(completionPath, "utf8"))).toMatchObject({
      state: "remote_staged",
      courier_cleanup_state: "pending",
    });

    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toMatchObject({
      state: "staged_awaiting_human",
    });
    expect(existsSync(plan.receipt_path)).toBe(false);
    expect(count(fake, "ssm", "send-command")).toBe(1);
  });

  it("blocks a new rehearsal plan when that operation already has a durable completion", () => {
    const source = reusableStagingInputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const fake = fakeAws();
    const plan = planOnboardingTransfer(
      privateConfig(source, archive, meetings, true),
      fake,
    );
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toMatchObject({
      state: "staged_awaiting_human",
    });

    expect(() => planOnboardingTransfer(
      privateConfig(source, archive, meetings, true),
      fake,
    )).toThrow("rehearsal_stage_completion_exists");
  });

  it("writes a rehearsal completion when cleanup reconciles an already submitted successful command", () => {
    const { fake, plan } = planned({}, "reuse");
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    Object.assign(receipt, {
      state: "ssm_submitted",
      command_id: "command-1",
      submission_started_at: "1970-01-01T00:00:00Z",
    });
    writeFileSync(plan.receipt_path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toMatchObject({
      action: "cleanup",
      state: "staged_awaiting_human",
    });
    expect(existsSync(plan.receipt_path)).toBe(false);
    expect(count(fake, "ssm", "send-command")).toBe(0);
  });

  it("binds the selected fixture mode into the receipt before the local controller can disappear", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const meetings = stagingSyntheticMeetingsDirectory();
    const config = privateConfig(source, archive, meetings);
    const fake = fakeAws();
    const plan = planOnboardingTransfer(config, fake);
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    rmSync(config);

    expect(receipt.staging_synthetic_meetings).toBe(true);
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    const send = fake.calls.find((args) => args[0] === "ssm" && args[1] === "send-command")!;
    const parameters = JSON.parse(send[send.indexOf("--parameters") + 1]!) as { commands: string[] };
    expect(parameters.commands.join("\n")).toContain('--staging-synthetic-meetings-dir "$meetings"');
  });

  it("uses no-output runners for AWS waits and distinct deterministic grant and clear execution tokens", () => {
    const { fake, plan } = planned();
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
    const { fake, plan } = planned({ ssmStatuses: Array(25).fill("InProgress") });
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(count(fake, "ssm", "get-command-invocation")).toBeGreaterThan(25);
  });

  it("does not send SSM when the pre-send submission receipt cannot be persisted", () => {
    const { fake, plan } = planned();
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: () => { throw new Error("disk unavailable"); },
    })).toThrow("ssm_command_submission_unproven");
    expect(called(fake, "ssm", "send-command")).toBe(false);
  });

  it("quarantines a post-send receipt-write failure until grant expiry plus the bounded delivery and execution margin", () => {
    const { fake, plan } = planned();
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: failOnSecondReplace(),
    })).toThrow("ssm_command_submission_unproven");
    expect(count(fake, "ssm", "send-command")).toBe(1);
    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_submission_quarantined");
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    expect(count(fake, "cloudformation", "execute-change-set")).toBe(1);
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    fake.setClock(Date.parse(receipt.access_expires_at) + 12 * 60 * 1000);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "cleaned" });
  });

  it("bases quarantine on the later pre-send timestamp and never reports an unknown send as prepared", () => {
    const { fake, plan } = planned({ grantWaitAdvanceMs: 40 * 60 * 1000 });
    expect(() => executeOnboardingTransfer(plan.receipt_path, {
      ...fake,
      replaceReceipt: failOnSecondReplace(),
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
    const { fake, plan } = planned({ invocationMissingCount: 1 });
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(count(fake, "ssm", "get-command-invocation")).toBe(2);
  });

  it("passes the plugin execution timeout, cancels at the local deadline, and refuses cleanup until cancellation is terminal", () => {
    const { fake, plan } = planned({ ssmStatuses: Array(100).fill("InProgress") });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    const send = fake.calls.find((args) => args[0] === "ssm" && args[1] === "send-command")!;
    const parameters = JSON.parse(send[send.indexOf("--parameters") + 1]!) as { executionTimeout: string[] };
    expect(parameters.executionTimeout).toEqual(["300"]);
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    expect(existsSync(plan.receipt_path)).toBe(true);
  });

  it("never lets public cleanup revoke or delete while the submitted SSM command is nonterminal, then reconciles exact success", () => {
    const { fake, plan } = planned({ ssmStatuses: Array(1000).fill("InProgress") });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    expect(() => cleanupOnboardingTransfer(plan.receipt_path, fake)).toThrow("ssm_command_terminal_unproven");
    expect(called(fake, "s3api", "delete-object")).toBe(false);
    fake.setSsmStatuses(["Success"]);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "prepared_cleaned" });
    expect(count(fake, "ssm", "send-command")).toBe(1);
  });

  it("cleans only after a cancellation reaches a terminal failed status", () => {
    const { fake, plan } = planned({ ssmStatuses: [...Array(73).fill("InProgress"), "Failed"] });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_failed_cleaned");
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
    expect(called(fake, "s3api", "delete-object")).toBe(true);
  });

  it("accepts the exact success marker when cancellation races with completion", () => {
    const { fake, plan } = planned({ ssmStatuses: [...Array(73).fill("InProgress"), "Cancelling", "Success"] });
    expect(executeOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "execute", state: "prepared" });
    expect(called(fake, "ssm", "cancel-command")).toBe(true);
  });

  it("cleans a head-verification failure and rejects a non-IAM change set without leaving recovery material", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const config = privateConfig(source, archive);
    expect(() => planOnboardingTransfer(config, fakeAws({ headFails: true }))).toThrow("head failed");
    expect(existsSync(join(archive, "onboarding-transfer-onboarding-transfer-001.json"))).toBe(false);
    expect(() => planOnboardingTransfer(config, fakeAws({ nonIamChange: true }))).toThrow("change_set_boundary_violation");
  });

  it("rejects an existing recovery receipt before it can upload a second object", () => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const config = privateConfig(source, archive);
    writeFileSync(join(archive, "onboarding-transfer-onboarding-transfer-001.json"), "{}\n", { mode: 0o600 });
    const fake = fakeAws();
    expect(() => planOnboardingTransfer(config, fake)).toThrow("receipt_destination_exists");
    expect(called(fake, "s3api", "put-object")).toBe(false);
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
    const { fake, plan } = planned({ putThrowsCommitted: true });

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

  it.each([
    ["ambiguous Put reconciliation cannot prove inventory", { inventoryFailsAfterPut: true }],
    ["Put reconciliation finds multiple versions", { ambiguousPut: true }],
  ] as const)("keeps an actionable uploading receipt and archive when %s", (_case, options) => {
    const source = inputDirectory();
    const archive = privateDirectory("echo-authority-onboarding-archive-");
    const fake = fakeAws({ putThrowsCommitted: true, ...options });
    const config = privateConfig(source, archive);

    expect(() => planOnboardingTransfer(config, fake)).toThrow("onboarding_transfer_cleanup_required");
    const receiptPath = join(archive, "onboarding-transfer-onboarding-transfer-001.json");
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(join(archive, "onboarding-transfer-001.tar.gz"))).toBe(true);
    if ("ambiguousPut" in options) {
      expect(() => cleanupOnboardingTransfer(receiptPath, fake)).toThrow("object_key_ownership_unproven");
      expect(existsSync(receiptPath)).toBe(true);
    }
  });

  it("preserves recovery material when exact absence is unproved and permits an explicit cleanup retry", () => {
    const { fake, plan } = planned({ deleteFailsOnce: true });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_transfer_cleanup_required");
    expect(existsSync(plan.receipt_path)).toBe(true);
    expect(cleanupOnboardingTransfer(plan.receipt_path, fake)).toEqual({ action: "cleanup", state: "prepared_cleaned" });
    expect(count(fake, "ssm", "send-command")).toBe(1);
  });

  it("refuses cleanup when post-delete exact-key inventory is truncated", () => {
    const { fake, plan } = planned({ truncateCleanupInventory: true });
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
    const { fake, plan } = planned();
    const receipt = JSON.parse(readFileSync(plan.receipt_path, "utf8"));
    receipt.access_expires_at = "1970-01-01T00:00:00Z";
    writeFileSync(plan.receipt_path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    expect(() => executeOnboardingTransfer(plan.receipt_path, fake)).toThrow("onboarding_grant_expired_cleaned");
    expect(existsSync(plan.receipt_path)).toBe(false);
  });
});
