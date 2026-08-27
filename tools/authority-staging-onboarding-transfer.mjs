#!/usr/bin/env node

/**
 * Transfers the first staging onboarding input without SSH, a shell session,
 * or a long-lived S3 read grant. The encrypted, versioned staging bucket is a
 * courier only: one uploaded object version is granted to the host for one
 * bounded SSM command, then the object, local archive, receipt, and IAM grant
 * are removed.
 *
 * This tool never parses or prints onboarding values. The established host
 * wrapper remains the authority for semantic input validation and preparation.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.template.json",
);
const OPERATION = /^onboarding-[a-z0-9][a-z0-9-]{7,63}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;
const STACK = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._/+=-]{8,1024}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const INSTANCE = /^i-[a-f0-9]{8,17}$/;
const SUCCESS = "authority-staging-onboarding-input-transferred\n";
// The expiry is fixed in the reviewed change set. Leave enough runway for a
// human approval without weakening the eight-minute pre-execution safety gate.
const PLAN_ACCESS_WINDOW_MS = 30 * 60 * 1000;
// SendCommand delivery and the RunShellScript plugin each have a 300-second
// bound. Add two minutes for clock skew and final propagation before treating
// an accepted send with no returned/persisted command ID as statically dead.
const SSM_SUBMISSION_WINDOW_MS = 10 * 60 * 1000;
const SSM_SUBMISSION_BUFFER_MS = 2 * 60 * 1000;
const MAXIMUM_INPUT_FILE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_INPUT_TOTAL_BYTES = 40 * 1024 * 1024;
const INPUT_FILES = Object.freeze([
  "onboarding.clean-v1.json",
  "release.json",
  "runtime-profile.json",
  "oidc-config.json",
  "oidc-client-secret",
  "slack-bot-token",
  "granola-credential",
  "llm-credential",
]);
const AMBIENT_AWS_CREDENTIAL_KEYS = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
]);

class TransferError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new TransferError(code);
}

function exact(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) refuse(code);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function privateDirectory(path, code) {
  let real;
  let state;
  try {
    real = realpathSync(path);
    state = lstatSync(real);
  } catch {
    refuse(code);
  }
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (state.mode & 0o777) !== 0o700 ||
    state.uid !== process.getuid()
  )
    refuse(code);
  if (real === REPO || real.startsWith(`${REPO}${sep}`)) refuse(`${code}_inside_repo`);
  return real;
}

function privateRegularFile(path, code) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    refuse(code);
  }
  if (
    state.isSymbolicLink() ||
    !state.isFile() ||
    (state.mode & 0o777) !== 0o600 ||
    state.uid !== process.getuid()
  ) {
    refuse(code);
  }
  return state;
}

function regularFile(path, code) {
  let state;
  try {
    state = lstatSync(path);
  } catch {
    refuse(code);
  }
  if (state.isSymbolicLink() || !state.isFile()) refuse(code);
  return state;
}

function pathOutsideRepository(path, code) {
  const absolute = resolve(path);
  const parent = privateDirectory(dirname(absolute), `${code}_parent`);
  const candidate = resolve(parent, basename(absolute));
  if (candidate === REPO || candidate.startsWith(`${REPO}${sep}`)) refuse(code);
  return candidate;
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) refuse("archive_header_invalid");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) refuse("archive_header_invalid");
  writeString(buffer, offset, length, `${encoded}\0`);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

/** Build an exact, deterministic archive from the established input shape. */
export function createOnboardingInputArchive({ sourceDir, output }) {
  const source = privateDirectory(sourceDir, "input_directory_not_private");
  const destination = pathOutsideRepository(output, "archive_inside_repo");
  if (existsSync(destination)) refuse("archive_destination_exists");
  if (!basename(destination).endsWith(".tar.gz")) refuse("archive_suffix_invalid");

  const actual = new Set(readdirSync(source));
  if (
    actual.size !== INPUT_FILES.length ||
    INPUT_FILES.some((name) => !actual.has(name))
  ) {
    refuse("input_directory_shape_invalid");
  }
  const chunks = [];
  let totalBytes = 0;
  for (const name of INPUT_FILES) {
    const path = resolve(source, name);
    const state = privateRegularFile(path, "input_file_not_private_regular");
    if (state.size > MAXIMUM_INPUT_FILE_BYTES) refuse("input_file_too_large");
    totalBytes += state.size;
    if (totalBytes > MAXIMUM_INPUT_TOTAL_BYTES) refuse("input_total_too_large");
    const content = readFileSync(path);
    chunks.push(tarHeader(name, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  writeFileSync(destination, archive, { encoding: undefined, flag: "wx", mode: 0o600 });
  chmodSync(destination, 0o600);
  return Object.freeze({ path: destination, sha256: sha256(archive) });
}

function parseConfig(path) {
  privateRegularFile(path, "transfer_input_not_private_regular");
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse("transfer_input_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    refuse("transfer_input_invalid");
  const allowed = new Set([
    "region",
    "operationId",
    "stackName",
    "privateInputDir",
    "archiveDir",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    refuse("transfer_input_property_not_allowed");
  return Object.freeze({
    archiveDir: exact(value.archiveDir, /^\/.+/, "archive_directory_invalid"),
    operationId: exact(value.operationId, OPERATION, "operation_id_invalid"),
    privateInputDir: exact(value.privateInputDir, /^\/.+/, "input_directory_invalid"),
    region: exact(value.region, REGION, "region_invalid"),
    stackName: exact(value.stackName, STACK, "stack_name_invalid"),
  });
}

function awsEnvironment() {
  const environment = { ...process.env, AWS_PROFILE: "echo-prod" };
  for (const key of AMBIENT_AWS_CREDENTIAL_KEYS) delete environment[key];
  return environment;
}

function defaultAwsJson(args) {
  try {
    return JSON.parse(
      execFileSync("aws", args, {
        encoding: "utf8",
        env: awsEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    if (
      args[0] === "ssm" &&
      args[1] === "get-command-invocation" &&
      String(error?.stderr ?? "").includes("InvocationDoesNotExist")
    ) {
      throw new TransferError("ssm_invocation_pending");
    }
    refuse("aws_operation_failed");
  }
}

function defaultAwsNoOutput(args) {
  try {
    execFileSync("aws", args, {
      encoding: "utf8",
      env: awsEnvironment(),
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    refuse("aws_operation_failed");
  }
}

const DEFAULT_AWS = Object.freeze({ json: defaultAwsJson, noOutput: defaultAwsNoOutput });

function awsJson(args, aws = DEFAULT_AWS) {
  return aws.json(args);
}

function awsNoOutput(args, aws = DEFAULT_AWS) {
  return aws.noOutput(args);
}

function templateSha256() {
  regularFile(TEMPLATE, "template_unreadable");
  return sha256(readFileSync(TEMPLATE));
}

function checkedStack(region, stackName, aws) {
  const response = awsJson([
    "cloudformation",
    "describe-stacks",
    "--region",
    region,
    "--stack-name",
    stackName,
    "--output",
    "json",
  ], aws);
  const stack = response.Stacks?.[0];
  if (
    !stack ||
    stack.StackStatus !== "UPDATE_COMPLETE" ||
    stack.EnableTerminationProtection !== true
  ) {
    refuse("staging_stack_not_ready");
  }
  const output = Object.fromEntries(
    (stack.Outputs ?? []).flatMap((item) =>
      typeof item?.OutputKey === "string" && typeof item?.OutputValue === "string"
        ? [[item.OutputKey, item.OutputValue]]
        : [],
    ),
  );
  const bucket = exact(output.OnboardingTransferBucketName, BUCKET, "bucket_invalid");
  const keyArn = exact(output.OnboardingTransferKeyArn, /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key\/[A-Fa-f0-9-]{36}$/, "transfer_key_arn_invalid");
  const instanceId = exact(output.StagingHostInstanceId, INSTANCE, "host_not_enabled");
  if (output.StagingHostReady !== "true") refuse("host_not_ready");
  const parameterValues = Object.fromEntries(
    (stack.Parameters ?? []).flatMap((item) =>
      typeof item?.ParameterKey === "string" && typeof item?.ParameterValue === "string"
        ? [[item.ParameterKey, item.ParameterValue]]
        : [],
    ),
  );
  return Object.freeze({
    bucket,
    keyArn,
    instanceId,
    parameterKeys: Object.freeze(Object.keys(parameterValues)),
    parameterValues: Object.freeze(parameterValues),
  });
}

function transferKey(operationId) {
  return `authority-staging/onboarding/${operationId}.tar.gz`;
}

function accountFromKeyArn(keyArn) {
  return keyArn.split(":")[4];
}

function exactKeyInventory(
  { bucket, key, keyArn, region },
  aws,
  unprovenCode = "object_key_inventory_unproven",
) {
  const owner = accountFromKeyArn(keyArn);
  const versions = awsJson([
    "s3api", "list-object-versions", "--region", region, "--bucket", bucket,
    "--prefix", key, "--expected-bucket-owner", owner, "--output", "json",
  ], aws);
  const multipart = awsJson([
    "s3api", "list-multipart-uploads", "--region", region, "--bucket", bucket,
    "--prefix", key, "--expected-bucket-owner", owner, "--output", "json",
  ], aws);
  if (versions.IsTruncated === true || multipart.IsTruncated === true)
    refuse(unprovenCode);
  return Object.freeze({
    versions: Object.freeze((versions.Versions ?? []).filter((item) => item?.Key === key)),
    deleteMarkers: Object.freeze((versions.DeleteMarkers ?? []).filter((item) => item?.Key === key)),
    uploads: Object.freeze((multipart.Uploads ?? []).filter((item) => item?.Key === key)),
  });
}

function assertExactKeyAbsent(input, aws) {
  const inventory = exactKeyInventory(input, aws);
  if (inventory.versions.length || inventory.deleteMarkers.length || inventory.uploads.length)
    refuse("object_key_not_empty");
}

function uploadExactObject({ archive, bucket, key, keyArn, region }, aws) {
  const input = { archive, bucket, key, keyArn, region };
  let response;
  try {
    response = awsJson([
    "s3api",
    "put-object",
    "--region",
    region,
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    archive.path,
    "--expected-bucket-owner",
    accountFromKeyArn(keyArn),
    "--server-side-encryption",
    "aws:kms",
    "--ssekms-key-id",
    keyArn,
    "--if-none-match",
    "*",
    "--metadata",
    `sha256=${archive.sha256}`,
    "--output",
    "json",
    ], aws);
  } catch {
    let inventory;
    try {
      inventory = exactKeyInventory(input, aws);
    } catch {
      // The caller has already persisted an uploading receipt.  Do not infer
      // that a transport failure meant S3 rejected the write.
      refuse("ambiguous_upload_cleanup_required");
    }
    if (inventory.versions.length === 0 && inventory.deleteMarkers.length === 0 && inventory.uploads.length === 0)
      refuse("upload_not_committed");
    if (inventory.deleteMarkers.length || inventory.uploads.length || inventory.versions.length !== 1)
      refuse("ambiguous_upload_cleanup_required");
    response = { VersionId: inventory.versions[0]?.VersionId };
    const recovered = Object.freeze({ ...archive, bucket, key, keyArn, version: exact(response.VersionId, VERSION, "object_version_invalid") });
    try {
      verifyExactObject(recovered, region, aws);
    } catch (error) {
      if (error instanceof TransferError && error.code === "object_checksum_or_encryption_unverified")
        refuse("object_key_not_owned");
      refuse("object_key_ownership_unproven");
    }
    return recovered;
  }
  const version = exact(response.VersionId, VERSION, "object_version_invalid");
  return Object.freeze({ ...archive, bucket, key, keyArn, version });
}

function verifyExactObject(artifact, region, aws) {
  const head = awsJson([
    "s3api",
    "head-object",
    "--region",
    region,
    "--bucket",
    artifact.bucket,
    "--key",
    artifact.key,
    "--version-id",
    artifact.version,
    "--expected-bucket-owner",
    accountFromKeyArn(artifact.keyArn),
    "--output",
    "json",
  ], aws);
  if (
    head.Metadata?.sha256 !== artifact.sha256 ||
    head.ServerSideEncryption !== "aws:kms" ||
    head.SSEKMSKeyId !== artifact.keyArn
  ) {
    refuse("object_checksum_or_encryption_unverified");
  }
}

function parameters(values, previousKeys) {
  const supplied = new Set(Object.keys(values));
  return [
    ...previousKeys
      .filter((key) => !supplied.has(key))
      .map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
    ...Object.entries(values).map(([ParameterKey, ParameterValue]) => ({
      ParameterKey,
      ParameterValue,
    })),
  ];
}

function newChangeSetName(operationId, purpose) {
  return `echo-authority-${purpose}-${operationId}`;
}

function clientToken(purpose, changeSetId) {
  return `echo-authority-${purpose}-${sha256(changeSetId).slice(0, 48)}`;
}

function createAndReadChangeSet({ region, stackName, operationId, purpose, values }, aws) {
  const changeSetName = newChangeSetName(operationId, purpose);
  const stack = checkedStack(region, stackName, aws);
  awsJson([
    "cloudformation",
    "create-change-set",
    "--region",
    region,
    "--stack-name",
    stackName,
    "--change-set-name",
    changeSetName,
    "--change-set-type",
    "UPDATE",
    "--client-token",
    clientToken(`create-${purpose}`, `${stackName}:${changeSetName}`),
    "--template-body",
    `file://${TEMPLATE}`,
    "--capabilities",
    "CAPABILITY_IAM",
    "--parameters",
    JSON.stringify(parameters(values, stack.parameterKeys)),
    "--output",
    "json",
  ], aws);
  try {
    awsNoOutput([
      "cloudformation",
      "wait",
      "change-set-create-complete",
      "--region",
      region,
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
    ], aws);
  } catch {
    // The following describe yields only a controlled refusal code.
  }
  const response = awsJson([
    "cloudformation",
    "describe-change-set",
    "--region",
    region,
    "--stack-name",
    stackName,
    "--change-set-name",
    changeSetName,
    "--output",
    "json",
  ], aws);
  if (response.Status !== "CREATE_COMPLETE" || typeof response.ChangeSetId !== "string")
    refuse("change_set_not_reviewable");
  const actions = (response.Changes ?? []).map((change) => ({
    action: change?.ResourceChange?.Action,
    logicalId: change?.ResourceChange?.LogicalResourceId,
    type: change?.ResourceChange?.ResourceType,
  }));
  const expectedAction = purpose === "onboarding-grant" ? "Add" : "Remove";
  if (
    actions.length !== 1 ||
    actions[0]?.action !== expectedAction ||
    actions[0]?.logicalId !== "StagingHostOnboardingInputAccess" ||
    actions[0]?.type !== "AWS::IAM::Policy"
  ) {
    refuse("change_set_boundary_violation");
  }
  return response.ChangeSetId;
}

function executeChangeSet({ region, stackName, purpose, changeSetId }, aws) {
  awsNoOutput([
    "cloudformation",
    "execute-change-set",
    "--region",
    region,
    "--change-set-name",
    changeSetId,
    "--client-request-token",
    clientToken(`execute-${purpose}`, changeSetId),
  ], aws);
  awsNoOutput([
    "cloudformation",
    "wait",
    "stack-update-complete",
    "--region",
    region,
    "--stack-name",
    stackName,
  ], aws);
}

function accessExpiry(now = Date.now) {
  return new Date(now() + PLAN_ACCESS_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function timestamp(now = Date.now) {
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function grantParameters(artifact, expiresAt) {
  return Object.freeze({
    OnboardingInputObjectKey: artifact.key,
    OnboardingInputObjectVersion: artifact.version,
    OnboardingInputAccessExpiresAt: expiresAt,
  });
}

function clearParameters() {
  return Object.freeze({
    OnboardingInputObjectKey: "",
    OnboardingInputObjectVersion: "",
    OnboardingInputAccessExpiresAt: "",
  });
}

/** The only remote code path. It emits one fixed success marker and nothing else. */
export function onboardingTransferSsmCommands({ artifact, region }) {
  return Object.freeze([
    "set -eu",
    "umask 077",
    "workdir=$(mktemp -d /var/tmp/echo-authority-onboarding.XXXXXX)",
    'trap \'rm -rf -- "$workdir"\' EXIT',
    'archive="$workdir/onboarding.tar.gz"',
    "downloaded=false",
    "for attempt in $(seq 1 20); do",
    `  if '/snap/bin/aws' s3api get-object --region '${region}' --expected-bucket-owner '${accountFromKeyArn(artifact.keyArn)}' --bucket '${artifact.bucket}' --key '${artifact.key}' --version-id '${artifact.version}' "$archive" >/dev/null 2>/dev/null; then downloaded=true; break; fi`,
    "  sleep 3",
    "done",
    'test "$downloaded" = true',
    `printf '%s  %s\\n' '${artifact.sha256}' "$archive" | sha256sum -c - >/dev/null`,
    'input="$workdir/input"',
    'python3 - "$archive" "$input" <<\'PY\'\nimport os\nimport sys\nimport tarfile\n\narchive, destination = sys.argv[1:]\nexpected = ["onboarding.clean-v1.json", "release.json", "runtime-profile.json", "oidc-config.json", "oidc-client-secret", "slack-bot-token", "granola-credential", "llm-credential"]\nmaximum_file_bytes = 10 * 1024 * 1024\nmaximum_total_bytes = 40 * 1024 * 1024\nwith tarfile.open(archive, "r:gz") as source:\n    members = source.getmembers()\n    if [member.name for member in members] != expected:\n        raise SystemExit(1)\n    if any(not member.isreg() or member.issym() or member.islnk() or member.size > maximum_file_bytes for member in members):\n        raise SystemExit(1)\n    if sum(member.size for member in members) > maximum_total_bytes:\n        raise SystemExit(1)\n    os.mkdir(destination, 0o700)\n    for member in members:\n        source_file = source.extractfile(member)\n        if source_file is None:\n            raise SystemExit(1)\n        target = os.path.join(destination, member.name)\n        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)\n        with os.fdopen(descriptor, "wb") as output:\n            while True:\n                chunk = source_file.read(131072)\n                if not chunk:\n                    break\n                output.write(chunk)\n        os.chmod(target, 0o600)\nPY',
    'chmod 0700 "$input"',
    'for name in onboarding.clean-v1.json release.json runtime-profile.json oidc-config.json oidc-client-secret slack-bot-token granola-credential llm-credential; do test -f "$input/$name" && test ! -L "$input/$name"; done',
    'test "$(find "$input" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 8',
    '/srv/echo-authority-clean-v1/onboard-clean-v1.sh doctor --input-dir "$input" >/dev/null 2>&1',
    '/srv/echo-authority-clean-v1/onboard-clean-v1.sh prepare --input-dir "$input" >/dev/null 2>&1',
    `printf '${SUCCESS.trim()}\\n'`,
  ]);
}

function submitSsmTransfer({ artifact, instanceId, region }, aws) {
  const sent = awsJson([
    "ssm",
    "send-command",
    "--region",
    region,
    "--document-name",
    "AWS-RunShellScript",
    "--timeout-seconds",
    "300",
    "--instance-ids",
    instanceId,
    "--parameters",
    JSON.stringify({
      commands: onboardingTransferSsmCommands({ artifact, region }),
      executionTimeout: ["300"],
    }),
    "--cloud-watch-output-config",
    "CloudWatchOutputEnabled=false",
    "--output",
    "json",
  ], aws);
  const commandId = sent.Command?.CommandId;
  if (typeof commandId !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(commandId))
    refuse("ssm_command_invalid");
  return commandId;
}

function pollSsmTransfer({ commandId, instanceId, region }, aws) {
  const now = aws.now ?? Date.now;
  const sleep = aws.sleep ?? ((milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));
  const deadline = now() + 6 * 60 * 1000;
  let cancelling = false;
  let cancellationDeadline = 0;
  for (;;) {
    let result;
    try {
      result = awsJson([
        "ssm",
        "get-command-invocation",
        "--region",
        region,
        "--command-id",
        commandId,
        "--instance-id",
        instanceId,
        "--output",
        "json",
      ], aws);
    } catch {
      result = { Status: "Pending" };
    }
    if (result.Status === "Success") {
      if (result.StandardOutputContent !== SUCCESS) refuse("ssm_outcome_unproven");
      return "success";
    }
    if (["Cancelled", "Failed", "TimedOut", "Undeliverable", "Terminated"].includes(result.Status))
      return "terminal_failure";
    if (!cancelling && now() >= deadline) {
      try {
        awsNoOutput([
          "ssm",
          "cancel-command",
          "--region",
          region,
          "--command-id",
          commandId,
          "--instance-ids",
          instanceId,
        ], aws);
      } catch {
        // A cancel response is not evidence the command stopped. Reconcile.
      }
      cancelling = true;
      cancellationDeadline = now() + 2 * 60 * 1000;
    }
    if (cancelling && now() >= cancellationDeadline)
      refuse("ssm_command_terminal_unproven");
    sleep(5000);
  }
}

function deleteExactObject({ artifact, region }, aws) {
  awsJson([
    "s3api",
    "delete-object",
    "--region",
    region,
    "--bucket",
    artifact.bucket,
    "--key",
    artifact.key,
    "--expected-bucket-owner",
    accountFromKeyArn(artifact.keyArn),
    "--version-id",
    artifact.version,
    "--output",
    "json",
  ], aws);
  const inventory = exactKeyInventory(
    { ...artifact, region },
    aws,
    "object_key_absence_unproven",
  );
  if (
    inventory.versions.length ||
    inventory.deleteMarkers.length ||
    inventory.uploads.length
  )
    refuse("object_key_absence_unproven");
}

function writeReceipt(path, receipt) {
  const directory = privateDirectory(dirname(path), "receipt_directory_not_private");
  const destination = resolve(directory, basename(path));
  if (existsSync(destination)) refuse("receipt_destination_exists");
  writeFileSync(destination, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(destination, 0o600);
  return destination;
}

function replaceReceipt(path, receipt) {
  privateRegularFile(path, "receipt_not_private_regular");
  const temporary = `${path}.tmp`;
  if (existsSync(temporary)) refuse("receipt_temporary_exists");
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function readReceipt(path) {
  privateRegularFile(path, "receipt_not_private_regular");
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse("receipt_invalid");
  }
  if (
    receipt?.kind !== "echo-authority-staging-onboarding-transfer-v1" ||
    !["uploading", "uploaded", "planned", "ssm_submitting", "ssm_submitted", "remote_prepared"].includes(receipt?.state) ||
    exact(receipt.region, REGION, "receipt_invalid") === undefined ||
    exact(receipt.operation_id, OPERATION, "receipt_invalid") === undefined ||
    exact(receipt.stack_name, STACK, "receipt_invalid") === undefined ||
    exact(receipt.instance_id, INSTANCE, "receipt_invalid") === undefined ||
    exact(receipt.bucket, BUCKET, "receipt_invalid") === undefined ||
    exact(receipt.key_arn, /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key\/[A-Fa-f0-9-]{36}$/, "receipt_invalid") === undefined ||
    exact(receipt.sha256, SHA256, "receipt_invalid") === undefined ||
    typeof receipt.object_key !== "string" ||
    !/^authority-staging\/onboarding\/onboarding-[a-z0-9][a-z0-9-]{7,63}\.tar\.gz$/.test(receipt.object_key) ||
    (receipt.state === "uploading" && (
      receipt.object_version !== null ||
      exact(receipt.access_expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "receipt_invalid") === undefined ||
      receipt.change_set_id !== null
    )) ||
    (receipt.state !== "uploading" && (
      exact(receipt.object_version, VERSION, "receipt_invalid") === undefined ||
      exact(receipt.access_expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "receipt_invalid") === undefined
    )) ||
    (["planned", "ssm_submitting", "ssm_submitted", "remote_prepared"].includes(receipt.state) && typeof receipt.change_set_id !== "string") ||
    (receipt.state === "uploaded" && receipt.change_set_id !== null) ||
    (["uploading", "uploaded", "planned", "ssm_submitting"].includes(receipt.state) && receipt.command_id !== null) ||
    (["ssm_submitted", "remote_prepared"].includes(receipt.state) &&
      exact(receipt.command_id, /^[A-Za-z0-9-]{8,128}$/, "receipt_invalid") === undefined) ||
    (["uploading", "uploaded", "planned"].includes(receipt.state) && receipt.submission_started_at !== null) ||
    (["ssm_submitting", "ssm_submitted", "remote_prepared"].includes(receipt.state) &&
      exact(receipt.submission_started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "receipt_invalid") === undefined) ||
    receipt.template_sha256 !== templateSha256()
  ) {
    refuse("receipt_invalid");
  }
  return Object.freeze(receipt);
}

function receiptPath(config) {
  return resolve(config.archiveDir, `onboarding-transfer-${config.operationId}.json`);
}

function preflightReceiptPath(path) {
  const directory = privateDirectory(dirname(path), "receipt_directory_not_private");
  const destination = resolve(directory, basename(path));
  if (existsSync(destination) || existsSync(`${destination}.tmp`))
    refuse("receipt_destination_exists");
  return destination;
}

function artifactFromReceipt(receipt) {
  return Object.freeze({
    bucket: receipt.bucket,
    key: receipt.object_key,
    keyArn: receipt.key_arn,
    version: receipt.object_version,
    sha256: receipt.sha256,
  });
}

function artifactFromUploadingReceipt(receipt, aws) {
  const input = {
    bucket: receipt.bucket,
    key: receipt.object_key,
    keyArn: receipt.key_arn,
    region: receipt.region,
  };
  const inventory = exactKeyInventory(input, aws);
  if (inventory.versions.length === 0 && inventory.deleteMarkers.length === 0 && inventory.uploads.length === 0)
    return undefined;
  if (inventory.versions.length !== 1 || inventory.deleteMarkers.length || inventory.uploads.length)
    refuse("object_key_ownership_unproven");
  const artifact = Object.freeze({
    ...input,
    version: exact(inventory.versions[0]?.VersionId, VERSION, "object_version_invalid"),
    sha256: receipt.sha256,
  });
  try {
    verifyExactObject(artifact, receipt.region, aws);
  } catch (error) {
    if (error instanceof TransferError && error.code === "object_checksum_or_encryption_unverified")
      refuse("object_key_not_owned");
    refuse("object_key_ownership_unproven");
  }
  return artifact;
}

function archivePathForReceipt(path, receipt) {
  return resolve(dirname(path), `${receipt.operation_id}.tar.gz`);
}

function removeLocalRecoveryMaterial(receiptPathname, receipt) {
  const archivePath = archivePathForReceipt(receiptPathname, receipt);
  if (existsSync(archivePath)) privateRegularFile(archivePath, "archive_cleanup_refused");
  privateRegularFile(receiptPathname, "receipt_not_private_regular");
  if (existsSync(archivePath)) rmSync(archivePath);
  rmSync(receiptPathname);
}

function grantIsAbsent(receipt, aws) {
  const stack = checkedStack(receipt.region, receipt.stack_name, aws);
  const values = stack.parameterValues;
  const current = [
    values.OnboardingInputObjectKey,
    values.OnboardingInputObjectVersion,
    values.OnboardingInputAccessExpiresAt,
  ];
  if (current.every((value) => value === "")) return true;
  if (
    values.OnboardingInputObjectKey !== receipt.object_key ||
    values.OnboardingInputObjectVersion !== receipt.object_version ||
    values.OnboardingInputAccessExpiresAt !== receipt.access_expires_at
  ) refuse("onboarding_grant_state_unexpected");
  const changeSetId = createAndReadChangeSet({
    region: receipt.region,
    stackName: receipt.stack_name,
    operationId: receipt.operation_id,
    purpose: "onboarding-clear",
    values: clearParameters(),
  }, aws);
  executeChangeSet({
    region: receipt.region,
    stackName: receipt.stack_name,
    purpose: "onboarding-clear",
    changeSetId,
  }, aws);
  const after = checkedStack(receipt.region, receipt.stack_name, aws).parameterValues;
  return (
    after.OnboardingInputObjectKey === "" &&
    after.OnboardingInputObjectVersion === "" &&
    after.OnboardingInputAccessExpiresAt === ""
  );
}

function reconcileSubmittedReceipt(receiptPathname, receipt, aws) {
  if (receipt.state === "ssm_submitting") {
    const safeAfter = Math.max(
      Date.parse(receipt.access_expires_at),
      Date.parse(receipt.submission_started_at) + SSM_SUBMISSION_WINDOW_MS,
    ) + SSM_SUBMISSION_BUFFER_MS;
    const now = (aws.now ?? Date.now)();
    if (!Number.isFinite(safeAfter) || !Number.isFinite(now) || now < safeAfter)
      refuse("ssm_command_submission_quarantined");
    return receipt;
  }
  if (receipt.state !== "ssm_submitted") return receipt;
  const outcome = pollSsmTransfer({
    commandId: receipt.command_id,
    instanceId: receipt.instance_id,
    region: receipt.region,
  }, aws);
  if (outcome === "terminal_failure") return receipt;
  const remotePrepared = Object.freeze({ ...receipt, state: "remote_prepared" });
  try {
    replaceReceipt(receiptPathname, remotePrepared);
  } catch {
    refuse("remote_prepare_receipt_unproven");
  }
  return remotePrepared;
}

function cleanupReceipt(receiptPathname, receipt, aws) {
  receipt = reconcileSubmittedReceipt(receiptPathname, receipt, aws);
  if (!grantIsAbsent(receipt, aws)) refuse("onboarding_grant_absence_unproven");
  if (receipt.state === "uploading") {
    const artifact = artifactFromUploadingReceipt(receipt, aws);
    if (artifact !== undefined) deleteExactObject({ artifact, region: receipt.region }, aws);
  } else {
    deleteExactObject({ artifact: artifactFromReceipt(receipt), region: receipt.region }, aws);
  }
  removeLocalRecoveryMaterial(receiptPathname, receipt);
  return Object.freeze({
    action: "cleanup",
    state: receipt.state === "remote_prepared" ? "prepared_cleaned" : "cleaned",
  });
}

export function planOnboardingTransfer(configPath, { aws = DEFAULT_AWS, writeReceipt: persistReceipt = writeReceipt } = {}) {
  const config = parseConfig(configPath);
  const plannedReceiptPath = preflightReceiptPath(receiptPath(config));
  let archive;
  let receipt;
  let path;
  try {
    archive = createOnboardingInputArchive({
      sourceDir: config.privateInputDir,
      output: resolve(config.archiveDir, `${config.operationId}.tar.gz`),
    });
    const stack = checkedStack(config.region, config.stackName, aws);
    if (
      stack.parameterValues.OnboardingInputObjectKey !== "" ||
      stack.parameterValues.OnboardingInputObjectVersion !== "" ||
      stack.parameterValues.OnboardingInputAccessExpiresAt !== ""
    ) {
      refuse("onboarding_transfer_cleanup_required");
    }
    // No receipt exists until this exact key is proved empty. A collision is
    // not ours, even though it shares the deterministic operation key.
    assertExactKeyAbsent({
      bucket: stack.bucket,
      key: transferKey(config.operationId),
      keyArn: stack.keyArn,
      region: config.region,
    }, aws);
    receipt = Object.freeze({
      schema_version: 1,
      kind: "echo-authority-staging-onboarding-transfer-v1",
      state: "uploading",
      operation_id: config.operationId,
      region: config.region,
      stack_name: config.stackName,
      instance_id: stack.instanceId,
      bucket: stack.bucket,
      key_arn: stack.keyArn,
      object_key: transferKey(config.operationId),
      object_version: null,
      sha256: archive.sha256,
      // The short grant lifetime starts with plan, not after an uncertain
      // upload or later change-set work.
      access_expires_at: accessExpiry(aws.now ?? Date.now),
      change_set_id: null,
      command_id: null,
      submission_started_at: null,
      template_sha256: templateSha256(),
    });
    path = persistReceipt(plannedReceiptPath, receipt);
    const artifact = uploadExactObject({
      archive,
      bucket: stack.bucket,
      key: receipt.object_key,
      keyArn: stack.keyArn,
      region: config.region,
    }, aws);
    receipt = Object.freeze({
      ...receipt,
      state: "uploaded",
      object_version: artifact.version,
    });
    replaceReceipt(path, receipt);
    verifyExactObject(artifact, config.region, aws);
    const changeSetId = createAndReadChangeSet({
      region: config.region,
      stackName: config.stackName,
      operationId: config.operationId,
      purpose: "onboarding-grant",
      values: grantParameters(artifact, receipt.access_expires_at),
    }, aws);
    receipt = Object.freeze({
      ...receipt,
      state: "planned",
      change_set_id: changeSetId,
    });
    replaceReceipt(path, receipt);
    return Object.freeze({ action: "plan", state: "planned", receipt_path: path });
  } catch (error) {
    if (receipt !== undefined && path !== undefined) {
      if (error instanceof TransferError && error.code === "object_key_not_owned") {
        // The empty-key proof raced a foreign writer.  Keep that foreign
        // version intact; only our local, never-uploaded recovery material is
        // safe to remove.
        removeLocalRecoveryMaterial(path, receipt);
        throw error;
      }
      if (error instanceof TransferError && [
        "ambiguous_upload_cleanup_required",
        "object_key_ownership_unproven",
      ].includes(error.code))
        refuse("onboarding_transfer_cleanup_required");
      try {
        cleanupReceipt(path, receipt, aws);
      } catch {
        refuse("onboarding_transfer_cleanup_required");
      }
    } else if (archive !== undefined && existsSync(archive.path)) rmSync(archive.path);
    throw error;
  }
}

export function executeOnboardingTransfer(receiptPathname, { aws = DEFAULT_AWS, replaceReceipt: persistReceipt = replaceReceipt } = {}) {
  let receipt = readReceipt(receiptPathname);
  if (receipt.state === "ssm_submitted") {
    const reconciled = reconcileSubmittedReceipt(receiptPathname, receipt, aws);
    if (reconciled.state !== "remote_prepared") {
      try {
        cleanupReceipt(receiptPathname, reconciled, aws);
      } catch {
        refuse("onboarding_transfer_cleanup_required");
      }
      refuse("onboarding_transfer_failed_cleaned");
    }
    cleanupReceipt(receiptPathname, reconciled, aws);
    return Object.freeze({ action: "execute", state: "prepared" });
  }
  if (receipt.state === "ssm_submitting") {
    reconcileSubmittedReceipt(receiptPathname, receipt, aws);
    cleanupReceipt(receiptPathname, receipt, aws);
    refuse("onboarding_transfer_outcome_unproven_cleaned");
  }
  if (receipt.state !== "planned") refuse("receipt_not_planned");
  if (Date.parse(receipt.access_expires_at) - (aws.now ?? Date.now)() < 8 * 60 * 1000) {
    try {
      cleanupReceipt(receiptPathname, receipt, aws);
    } catch {
      refuse("onboarding_transfer_cleanup_required");
    }
    refuse("onboarding_grant_expired_cleaned");
  }
  let transferFailure;
  try {
    executeChangeSet({
      region: receipt.region,
      stackName: receipt.stack_name,
      purpose: "onboarding-grant",
      changeSetId: receipt.change_set_id,
    }, aws);
    const submitting = Object.freeze({
      ...receipt,
      state: "ssm_submitting",
      submission_started_at: timestamp(aws.now ?? Date.now),
    });
    try {
      persistReceipt(receiptPathname, submitting);
    } catch {
      refuse("ssm_command_submission_unproven");
    }
    receipt = submitting;
    const commandId = submitSsmTransfer({ artifact: artifactFromReceipt(receipt), instanceId: receipt.instance_id, region: receipt.region }, aws);
    const submitted = Object.freeze({ ...receipt, state: "ssm_submitted", command_id: commandId });
    try {
      persistReceipt(receiptPathname, submitted);
    } catch {
      refuse("ssm_command_submission_unproven");
    }
    receipt = submitted;
    const outcome = pollSsmTransfer({ commandId, instanceId: receipt.instance_id, region: receipt.region }, aws);
    if (outcome === "terminal_failure") refuse("ssm_outcome_unproven");
    try {
      const remotePrepared = Object.freeze({ ...receipt, state: "remote_prepared" });
      persistReceipt(receiptPathname, remotePrepared);
      receipt = remotePrepared;
    } catch {
      refuse("remote_prepare_receipt_unproven");
    }
  } catch (error) {
    if (
      error instanceof TransferError &&
      ["ssm_command_terminal_unproven", "ssm_command_submission_unproven", "ssm_command_submission_quarantined", "remote_prepare_receipt_unproven"].includes(error.code)
    )
      throw error;
    transferFailure = error;
  }
  try {
    cleanupReceipt(receiptPathname, receipt, aws);
  } catch {
    refuse("onboarding_transfer_cleanup_required");
  }
  if (transferFailure !== undefined) refuse("onboarding_transfer_failed_cleaned");
  return Object.freeze({ action: "execute", state: "prepared" });
}

export function cleanupOnboardingTransfer(receiptPathname, { aws = DEFAULT_AWS } = {}) {
  const receipt = readReceipt(receiptPathname);
  return cleanupReceipt(receiptPathname, receipt, aws);
}

function usage() {
  refuse("usage");
}

function runCli(argv) {
  const [action, flag, value] = argv;
  if (action === "plan" && flag === "--input" && typeof value === "string" && argv.length === 3)
    return planOnboardingTransfer(value);
  if (action === "execute" && flag === "--receipt" && typeof value === "string" && argv.length === 3)
    return executeOnboardingTransfer(value);
  if (action === "cleanup" && flag === "--receipt" && typeof value === "string" && argv.length === 3)
    return cleanupOnboardingTransfer(value);
  return usage();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    const code = error instanceof TransferError ? error.code : "unexpected";
    process.stderr.write(`authority staging onboarding transfer failed: ${code}\n`);
    process.exitCode = 1;
  }
}
