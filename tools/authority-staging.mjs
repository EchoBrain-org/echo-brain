#!/usr/bin/env node

/**
 * Plan-first operator lifecycle for the one fixed Authority staging slot.
 *
 * This module deliberately owns orchestration rather than AWS credentials.
 * Production callers inject narrow CloudFormation, S3, and write-only secret
 * adapters. That keeps tests side-effect free and prevents this command from
 * acquiring a general purpose secret-reading capability. In particular, there
 * is intentionally no GetSecretValue implementation in this file.
 */

import { spawn } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateOrganizationAuthorityDescriptorResponse } from "@echo-brain/organization-api";
import { verifyOrganizationAuthorityPin } from "@echo-brain/organization-protocol";
import {
  installStagingEdgeToken,
  stagingEdgeStatus,
} from "./authority-staging-edge.mjs";
import { awsCliArguments, sanitizedAwsEnvironment, sha256 as sha256Hex } from "./lib/operator-io.mjs";

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const OPERATION_ID = /^staging-[a-z0-9][a-z0-9-]{7,63}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const S3_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,900}\.tar\.gz$/;
const S3_VERSION = /^[A-Za-z0-9._/+=-]{8,1024}$/;
const PARAMETER_VALUE = /^[\x20-\x7e]{1,2048}$/;
// Cloudflare tunnel names are derived as `echo-authority-${slotId}` and are
// limited to 63 characters, leaving 48 characters for the stable slot ID.
const SLOT_ID = /^staging-[a-z0-9][a-z0-9-]{7,39}$/;
const CHANGE_ACTION = /^(Add|Modify|Remove|Import|Dynamic)$/;
const LOGICAL_ID = /^[A-Za-z][A-Za-z0-9]{0,254}$/;
const RESOURCE_TYPE = /^AWS::[A-Za-z0-9:]+$/;
const HEALTHY_STACK_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);
const RECOVERABLE_UPDATE_STACK_STATUS = "UPDATE_ROLLBACK_COMPLETE";
const EDGE_RECEIPT_STATES = new Set(["ready", "incomplete", "absent"]);
const AWS_CLI_STANDARD_TIMEOUT_MS = 45_000;
const AWS_CLOUDFORMATION_WAIT_TIMEOUT_MS = 30 * 60_000;
const AWS_SSM_LIFECYCLE_WAIT_TIMEOUT_MS = 6 * 60_000;
const AWS_CLI_OUTPUT_MAX_BYTES = 256 * 1024;
const AWS_CLI_TERMINATE_GRACE_MS = 1_000;
const SSM_LIFECYCLE_RUN_TIMEOUT_SECONDS = 300;
const TEMPLATE_MAX_BYTES = 51200;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TEMPLATE_PATH = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.template.json",
);
const DATA_BACKUP_TEMPLATE_PATH = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-data-backup-v1.template.json",
);
// The backup vault takes the backup stack's name, and AWS Backup vault names
// stop at 50 characters.
const DATA_BACKUP_STACK_SUFFIX = "-data-backup";
const DATA_BACKUP_STACK_NAME_MAX = 50;
// Cadence and retention are reviewed constants, not per-run input: changing
// them is a code review that the account owner approves. They match the
// root-volume recovery floor in RB-OPERATIONS-002.
const DATA_BACKUP_SCHEDULE_EXPRESSION = "cron(0 9 ? * * *)";
const DATA_BACKUP_RETENTION_DAYS = "35";
const DATA_BACKUP_PARAMETER_KEYS = Object.freeze([
  "DataVolumeId",
  "DataVolumeKmsKeyArn",
  "AlertTopicArn",
  "BackupScheduleExpression",
  "RecoveryPointRetentionDays",
]);
const DATA_BACKUP_LOGICAL_IDS = new Set([
  "StagingDataBackupVault",
  "StagingDataBackupServiceRole",
  "StagingDataRestoreServiceRole",
  "StagingDataBackupPlan",
  "StagingDataVolumeSelection",
  "StagingDataBackupMissedAlarm",
]);
// Cadence, retention and alert-topic changes modify these in place. Anything
// else, such as a different volume or key, needs its own reviewed change.
const DATA_BACKUP_MODIFIABLE_LOGICAL_IDS = new Set([
  "StagingDataBackupPlan",
  "StagingDataBackupMissedAlarm",
]);
const DATA_VOLUME_ID = /^vol-[a-f0-9]{8,17}$/;
const KMS_KEY_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key\/[A-Za-z0-9-]+$/;
const SNS_TOPIC_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/;
const REGIONAL_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):[a-z0-9-]+:([a-z0-9-]+):([0-9]{12}):/;
const CLEAN_DATA_MOUNT = "/srv/echo-authority-clean-v1/clean-data";
const STAGING_AMI_ROOT_DEVICE = "/dev/sda1";
const BASE_PARAMETERS = new Set([
  "OrgSlug",
  "AvailabilityZone",
  "VpcCidr",
  "PublicSubnetCidr",
  "StagingAmiId",
  "StagingInstanceType",
  "DataVolumeSizeGiB",
  "AuthorityEcrRepositoryArn",
]);
const REQUIRED_PARAMETERS = new Set([
  "OrgSlug",
  "AvailabilityZone",
  "StagingAmiId",
  "AuthorityEcrRepositoryArn",
]);
const DEFAULT_PARAMETERS = Object.freeze({
  VpcCidr: "10.238.0.0/16",
  PublicSubnetCidr: "10.238.1.0/24",
  StagingInstanceType: "t4g.small",
  DataVolumeSizeGiB: "30",
});
const PERSISTENT_LOGICAL_IDS = new Set([
  "StagingDataVolume",
  "AuthorityTunnelTokenSecret",
  "StagingHostSetupBundle",
  "StagingOnboardingTransferKey",
  "StagingOnboardingTransferBucket",
  "StagingOnboardingTransferBucketPolicy",
  "StagingVpc",
  "StagingHostRole",
]);
const EPHEMERAL_HOST_LOGICAL_IDS = new Set([
  "StagingReady",
  "StagingReadyHandle",
  "StagingDataVolumeAttachment",
  "StagingHost",
]);
const SAFE_MODIFY_LOGICAL_IDS = new Set([
  "StagingHostLaunchTemplate",
  "StagingHostRole",
]);
const HOST_SETUP_PARAMETER_KEYS = Object.freeze([
  "HostSetupObjectKey",
  "HostSetupObjectVersion",
  "HostSetupSha256",
]);
const ONBOARDING_TRANSFER_PARAMETER_KEYS = Object.freeze([
  "OnboardingInputObjectKey",
  "OnboardingInputObjectVersion",
  "OnboardingInputAccessExpiresAt",
]);
const TEMPLATE_PARAMETER_KEYS = Object.freeze([
  ...BASE_PARAMETERS,
  "HostEnabled",
  "InitializeBlankDataVolume",
  "ResumeRetainedAuthority",
  ...HOST_SETUP_PARAMETER_KEYS,
  ...ONBOARDING_TRANSFER_PARAMETER_KEYS,
]);

class AwsCliError extends Error {
  constructor(code, safeEvents = []) {
    super(`authority staging AWS CLI failed: ${code}`);
    this.code = code;
    this.safeEvents = safeEvents;
  }
}

class LifecycleError extends Error {
  constructor(code, safeEvents = []) {
    super(`authority staging lifecycle refused: ${code}`);
    this.code = code;
    this.safeEvents = safeEvents;
  }
}

function refuse(code) {
  throw new LifecycleError(code);
}

function exactString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) refuse(code);
  return value;
}

function requiredObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    refuse(code);
  return value;
}

function onlyKeys(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(code);
  }
}

function validateParameters(value) {
  const raw = requiredObject(value, "stack_parameters_invalid");
  const entries = Object.entries(raw);
  if (entries.length === 0) refuse("stack_parameters_invalid");
  const parameters = { ...DEFAULT_PARAMETERS };
  for (const [key, item] of entries) {
    if (!BASE_PARAMETERS.has(key)) refuse("stack_parameter_not_allowed");
    parameters[key] = exactString(
      item,
      PARAMETER_VALUE,
      "stack_parameter_value_invalid",
    );
  }
  for (const key of REQUIRED_PARAMETERS) {
    if (parameters[key] === undefined) refuse("stack_parameter_required");
  }
  return Object.freeze(parameters);
}

function validateEdge(value) {
  const raw = requiredObject(value, "edge_invalid");
  onlyKeys(
    raw,
    new Set(["accountId", "zoneId", "hostname"]),
    "edge_property_not_allowed",
  );
  return Object.freeze({
    accountId: exactString(
      raw.accountId,
      /^[a-f0-9]{32}$/i,
      "edge_account_invalid",
    ),
    hostname: exactString(
      raw.hostname,
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      "edge_hostname_invalid",
    ).toLowerCase(),
    zoneId: exactString(raw.zoneId, /^[a-f0-9]{32}$/i, "edge_zone_invalid"),
  });
}

function validateHostSetup(value) {
  const raw = requiredObject(value, "host_setup_invalid");
  onlyKeys(
    raw,
    new Set(["path", "key", "sha256"]),
    "host_setup_property_not_allowed",
  );
  return Object.freeze({
    key: exactString(raw.key, S3_KEY, "host_setup_key_invalid"),
    path: exactString(raw.path, /^.{1,2048}$/, "host_setup_path_invalid"),
    sha256: exactString(raw.sha256, SHA256, "host_setup_sha256_invalid"),
  });
}

function validateBackup(value) {
  const raw = requiredObject(value, "backup_invalid");
  onlyKeys(raw, new Set(["alertTopicArn"]), "backup_property_not_allowed");
  return Object.freeze({
    alertTopicArn: exactString(
      raw.alertTopicArn,
      SNS_TOPIC_ARN,
      "backup_alert_topic_invalid",
    ),
  });
}

function checkedTemplate(templatePath = DEFAULT_TEMPLATE_PATH) {
  let metadata;
  let body;
  try {
    metadata = lstatSync(templatePath);
    if (metadata.isSymbolicLink() || !metadata.isFile())
      refuse("template_path_not_regular");
    if (metadata.size === 0 || metadata.size > TEMPLATE_MAX_BYTES)
      refuse("template_size_invalid");
    body = readFileSync(templatePath, "utf8");
    JSON.parse(body);
    if (statSync(templatePath).size !== metadata.size)
      refuse("template_changed_during_read");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    refuse("template_path_unreadable");
  }
  return Object.freeze({
    path: templatePath,
    sha256: sha256Hex(body),
  });
}

/** Validate the non-secret, operator-controlled staging configuration. */
export function validateStagingLifecycleInput(value) {
  const raw = requiredObject(value, "input_invalid");
  onlyKeys(
    raw,
    new Set([
      "region",
      "operationId",
      "slotId",
      "stack",
      "edge",
      "hostSetup",
      "authorityPinSha256",
      "backup",
    ]),
    "input_property_not_allowed",
  );
  const stack = requiredObject(raw.stack, "stack_invalid");
  onlyKeys(
    stack,
    new Set(["name", "parameters"]),
    "stack_property_not_allowed",
  );
  const input = {
    edge: validateEdge(raw.edge),
    operationId: exactString(
      raw.operationId,
      OPERATION_ID,
      "operation_id_invalid",
    ),
    region: exactString(raw.region, REGION, "region_invalid"),
    slotId: exactString(raw.slotId, SLOT_ID, "slot_id_invalid"),
    stack: Object.freeze({
      name: exactString(stack.name, STACK_NAME, "stack_name_invalid"),
      parameters: validateParameters(stack.parameters),
    }),
    template: checkedTemplate(),
  };
  if (raw.hostSetup !== undefined)
    input.hostSetup = validateHostSetup(raw.hostSetup);
  if (raw.authorityPinSha256 !== undefined)
    input.authorityPinSha256 = exactString(
      raw.authorityPinSha256,
      SHA256_DIGEST,
      "authority_pin_invalid",
    );
  if (raw.backup !== undefined) input.backup = validateBackup(raw.backup);
  return Object.freeze(input);
}

function lifecycleReceipt(input, action, state, fields = {}) {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-authority-staging-lifecycle-v1",
    action,
    state,
    operation_id: input.operationId,
    stack_name: input.stack.name,
    hostname: input.edge.hostname,
    ...fields,
  });
}

function outputMap(stack) {
  if (stack === null || typeof stack !== "object" || Array.isArray(stack))
    refuse("stack_status_invalid");
  if (stack.exists === false) return undefined;
  if (stack.exists !== true || typeof stack.status !== "string")
    refuse("stack_status_invalid");
  const outputs = requiredObject(stack.outputs, "stack_outputs_invalid");
  if (typeof stack.terminationProtection !== "boolean")
    refuse("stack_termination_protection_invalid");
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof key !== "string" || typeof value !== "string")
      refuse("stack_outputs_invalid");
  }
  if (stack.status === "REVIEW_IN_PROGRESS")
    return Object.freeze({
      pendingCreate: true,
      failedCreate: false,
      status: stack.status,
      terminationProtection: stack.terminationProtection,
      outputs: Object.freeze({ ...outputs }),
    });
  if (stack.status === "CREATE_FAILED")
    return Object.freeze({
      failedCreate: true,
      pendingCreate: false,
      status: stack.status,
      terminationProtection: stack.terminationProtection,
      outputs: Object.freeze({ ...outputs }),
    });
  if (
    !HEALTHY_STACK_STATUSES.has(stack.status) &&
    stack.status !== RECOVERABLE_UPDATE_STACK_STATUS
  ) {
    refuse("stack_status_invalid");
  }
  return Object.freeze({
    failedCreate: false,
    pendingCreate: false,
    updateRolledBack: stack.status === RECOVERABLE_UPDATE_STACK_STATUS,
    status: stack.status,
    terminationProtection: stack.terminationProtection,
    outputs: Object.freeze({ ...outputs }),
  });
}

function changeSetTypeFor(stack) {
  return stack === undefined || stack.pendingCreate === true
    ? "CREATE"
    : "UPDATE";
}

function requiredOutput(outputs, key) {
  const value = outputs[key];
  if (typeof value !== "string" || value.length === 0)
    refuse("stack_output_missing");
  return value;
}

function buildParameters(
  input,
  hostEnabled,
  setupArtifact = undefined,
  initializeBlankDataVolume = false,
  resumeRetainedAuthority = false,
) {
  const parameters = {
    ...input.stack.parameters,
    HostEnabled: hostEnabled ? "true" : "false",
    InitializeBlankDataVolume:
      hostEnabled && initializeBlankDataVolume ? "true" : "false",
    // An ordinary up deliberately only materializes retained state. The
    // accepted Authority resumes only for the independently pinned retained
    // restart, before CloudFormation signals ready.
    ResumeRetainedAuthority:
      hostEnabled && resumeRetainedAuthority ? "true" : "false",
    // Every lifecycle plan names the complete template vector. These transfer
    // controls are never lifecycle inputs, so their only safe value here is
    // the template default. That makes an outstanding transfer grant visible
    // as a reviewed-plan mismatch instead of silently inheriting it.
    HostSetupObjectKey: "",
    HostSetupObjectVersion: "",
    HostSetupSha256: "",
    OnboardingInputObjectKey: "",
    OnboardingInputObjectVersion: "",
    OnboardingInputAccessExpiresAt: "",
  };
  if (hostEnabled) {
    if (setupArtifact !== undefined) {
      parameters.HostSetupObjectKey = setupArtifact.key;
      parameters.HostSetupObjectVersion = setupArtifact.version;
      parameters.HostSetupSha256 = setupArtifact.sha256;
    }
  }
  return Object.freeze(parameters);
}

function changeSetName(input, action) {
  return `echo-authority-${action}-${input.operationId}`.slice(0, 128);
}

function changeSetRequest(
  input,
  action,
  type,
  hostEnabled,
  setupArtifact,
  initializeBlankDataVolume = false,
  resumeRetainedAuthority = false,
) {
  const edgePlanBinding =
    action === "slot-init" ? canonicalEdgePlanBinding(input) : undefined;
  return Object.freeze({
    capabilities: Object.freeze(["CAPABILITY_IAM"]),
    changeSetName: changeSetName(input, action),
    changeSetType: type,
    clientToken: input.operationId,
    edgePlanBinding,
    onStackFailure: type === "CREATE" ? "DO_NOTHING" : undefined,
    parameters: buildParameters(
      input,
      hostEnabled,
      setupArtifact,
      initializeBlankDataVolume,
      resumeRetainedAuthority,
    ),
    region: input.region,
    stackName: input.stack.name,
    templatePath: input.template.path,
    templateSha256: input.template.sha256,
  });
}

function adapterFunction(dependencies, name) {
  const value = dependencies?.cloudFormation?.[name];
  if (typeof value !== "function") refuse(`cloudformation_${name}_required`);
  return value;
}

function ec2AdapterFunction(dependencies, name) {
  const value = dependencies?.ec2?.[name];
  if (typeof value !== "function") refuse(`ec2_${name}_required`);
  return value;
}

async function assertStagingAmiRootDevice(input, dependencies) {
  const describeImage = ec2AdapterFunction(dependencies, "describeImage");
  let image;
  try {
    image = await describeImage({
      imageId: input.stack.parameters.StagingAmiId,
      region: input.region,
    });
  } catch {
    refuse("staging_ami_root_device_unproven");
  }
  if (
    image === null ||
    typeof image !== "object" ||
    Array.isArray(image) ||
    image.imageId !== input.stack.parameters.StagingAmiId ||
    image.state !== "available" ||
    image.rootDeviceName !== STAGING_AMI_ROOT_DEVICE ||
    image.rootDeviceType !== "ebs"
  ) {
    refuse("staging_ami_root_device_mismatch");
  }
}

async function describeNamedStack(region, stackName, dependencies) {
  const describeStack = adapterFunction(dependencies, "describeStack");
  return outputMap(await describeStack({ region, stackName }));
}

async function describeExactStack(input, dependencies) {
  return describeNamedStack(input.region, input.stack.name, dependencies);
}

function safeChangeActions(value) {
  if (!Array.isArray(value)) refuse("change_set_actions_invalid");
  return Object.freeze(
    value.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        refuse("change_set_actions_invalid");
      if (
        typeof item.action !== "string" ||
        !CHANGE_ACTION.test(item.action) ||
        typeof item.logicalId !== "string" ||
        !LOGICAL_ID.test(item.logicalId) ||
        typeof item.resourceType !== "string" ||
        !RESOURCE_TYPE.test(item.resourceType)
      ) {
        refuse("change_set_actions_invalid");
      }
      if (
        item.replacement !== undefined &&
        item.replacement !== true &&
        item.replacement !== false &&
        item.replacement !== "True" &&
        item.replacement !== "False" &&
        item.replacement !== "Conditional"
      ) {
        refuse("change_set_actions_invalid");
      }
      const replacement =
        item.replacement === "True"
          ? true
          : item.replacement === "False"
            ? false
            : (item.replacement ?? false);
      return Object.freeze({
        action: item.action,
        logical_id: item.logicalId,
        replacement,
        resource_type: item.resourceType,
      });
    }),
  );
}

function assertChangeBoundary(plan, action) {
  if (!plan.executable) return plan;
  for (const change of plan.actions) {
    if (
      PERSISTENT_LOGICAL_IDS.has(change.logical_id) &&
      (change.action === "Remove" ||
        change.replacement === true ||
        change.replacement === "Conditional")
    ) {
      refuse("change_set_persistent_boundary_violation");
    }
    if (change.action === "Dynamic" || change.action === "Import")
      refuse("change_set_host_boundary_violation");
    if (action !== "up" && action !== "down") continue;
    if (action === "up" && change.action === "Remove")
      refuse("change_set_host_boundary_violation");
    if (action === "down" && change.action === "Add")
      refuse("change_set_host_boundary_violation");
    if (
      (change.action === "Remove" || change.action === "Add") &&
      !EPHEMERAL_HOST_LOGICAL_IDS.has(change.logical_id)
    )
      refuse("change_set_host_boundary_violation");
    if (
      change.action === "Modify" &&
      !SAFE_MODIFY_LOGICAL_IDS.has(change.logical_id)
    ) {
      refuse("change_set_host_boundary_violation");
    }
  }
  return plan;
}

function checkedChangeSet(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    refuse("change_set_invalid");
  if (value.kind === "no_changes") {
    if (value.matchesExpected !== true) refuse("change_set_drifted");
    return Object.freeze({
      actions: Object.freeze([]),
      changeSetType: value.changeSetType,
      executable: false,
      kind: "no_changes",
    });
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.status !== "CREATE_COMPLETE" ||
    value.matchesExpected !== true ||
    !["CREATE", "UPDATE"].includes(value.changeSetType)
  ) {
    refuse("change_set_not_reviewable");
  }
  return Object.freeze({
    actions: safeChangeActions(value.actions),
    artifact: value.artifact,
    changeSetType: value.changeSetType,
    executable: true,
    id: value.id,
    kind: "change_set",
  });
}

async function planStack(
  input,
  action,
  hostEnabled,
  dependencies,
  setupArtifact,
  initializeBlankDataVolume = false,
  resumeRetainedAuthority = false,
) {
  const existing = await describeExactStack(input, dependencies);
  const createChangeSet = adapterFunction(dependencies, "createChangeSet");
  const request = changeSetRequest(
    input,
    action,
    changeSetTypeFor(existing),
    hostEnabled,
    setupArtifact,
    initializeBlankDataVolume,
    resumeRetainedAuthority,
  );
  const planned = await createChangeSet(request);
  const plan = checkedChangeSet(planned);
  return Object.freeze({
    edgePlanBinding: request.edgePlanBinding,
    existing,
    plan: assertChangeBoundary(plan, action),
  });
}

async function reviewedPlanStack(
  input,
  action,
  hostEnabled,
  dependencies,
  initializeBlankDataVolume = false,
  resumeRetainedAuthority = false,
) {
  const existing = await describeExactStack(input, dependencies);
  const describeChangeSet = adapterFunction(dependencies, "describeChangeSet");
  const expected = changeSetRequest(
    input,
    action,
    changeSetTypeFor(existing),
    hostEnabled,
    undefined,
    initializeBlankDataVolume,
    resumeRetainedAuthority,
  );
  const plan = assertChangeBoundary(
    checkedChangeSet(await describeChangeSet(expected)),
    action,
  );
  return Object.freeze({
    edgePlanBinding: expected.edgePlanBinding,
    existing,
    plan,
  });
}

async function executePlannedStack(
  input,
  plan,
  dependencies,
  stackName = input.stack.name,
) {
  if (!plan.executable)
    return describeNamedStack(input.region, stackName, dependencies);
  const executeChangeSet = adapterFunction(dependencies, "executeChangeSet");
  try {
    await executeChangeSet({
      changeSetId: plan.id,
      changeSetType: plan.changeSetType,
      clientRequestToken: input.operationId,
      region: input.region,
      stackName,
    });
  } catch (error) {
    if (error instanceof AwsCliError)
      throw new LifecycleError("change_set_execute_failed", error.safeEvents);
    refuse("change_set_execute_failed");
  }
  const current = await describeNamedStack(
    input.region,
    stackName,
    dependencies,
  );
  if (current === undefined) refuse("stack_missing_after_execute");
  if (current.updateRolledBack === true)
    refuse("change_set_execute_rolled_back");
  return current;
}

function publicPlan(plan, hostEnabled, edgePlanBinding = undefined) {
  return Object.freeze({
    change_set_actions: plan.actions,
    change_set_created: plan.kind === "change_set",
    change_set_ready_for_review: plan.executable,
    host_setup_artifact:
      plan.artifact === undefined
        ? undefined
        : Object.freeze({ ...plan.artifact }),
    host_enabled: hostEnabled,
    edge_coordinates: edgePlanBinding,
    no_changes: plan.kind === "no_changes",
  });
}

function canonicalEdgePlanBinding(input) {
  return Object.freeze({
    account_id: input.edge.accountId,
    hostname: input.edge.hostname,
    slot_id: input.slotId,
    zone_id: input.edge.zoneId,
  });
}

function edgeFunctions(dependencies) {
  return Object.freeze({
    install: dependencies?.edge?.installToken ?? installStagingEdgeToken,
    status: dependencies?.edge?.status ?? stagingEdgeStatus,
  });
}

function edgeInput(input, secretArn, dependencies) {
  const apiToken =
    dependencies?.cloudflareApiToken ?? process.env.ECHO_CLOUDFLARE_API_TOKEN;
  if (typeof apiToken !== "string" || apiToken.length === 0)
    refuse("cloudflare_api_token_required");
  if (isDynamicCloudflareReference(apiToken))
    refuse("cloudflare_api_token_resolution_required");
  return Object.freeze({
    ...input.edge,
    apiToken,
    operationId: input.operationId,
    secretArn,
    // Cloudflare ownership must survive new CloudFormation change-set IDs.
    slotId: input.slotId,
  });
}

function edgeDependencies(dependencies) {
  return Object.freeze({
    fetchImpl: dependencies?.fetchImpl,
    putSecretValue: dependencies?.putSecretValue,
  });
}

/**
 * `up` previously finished at the CloudFormation wait condition, which proves
 * only that the machine booted and the tunnel connector reported ready. It
 * never proved the Authority was serving, so every caller re-established that
 * fact by hand from logs, container labels, and database counts.
 *
 * This probe closes that gap with a content-free observation of the public
 * descriptor. It is deliberately reported rather than enforced by default: a
 * genuinely fresh slot has no onboarded Authority yet, and calling that a
 * failure would be false. `--require-authority` is for the down/up cycle, where
 * a prepared data volume is expected to come back serving.
 */
const AUTHORITY_DESCRIPTOR_PATH = "/v1/authority-descriptor";
const DESCRIPTOR_PROBE_ATTEMPTS = 20;
const DESCRIPTOR_PROBE_INTERVAL_MS = 6_000;
const DESCRIPTOR_PROBE_REQUEST_TIMEOUT_MS = 5_000;

function descriptorObservation(fields) {
  return Object.freeze({
    path: AUTHORITY_DESCRIPTOR_PATH,
    ...fields,
  });
}

async function probeAuthorityDescriptor(
  input,
  dependencies = {},
  options = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") refuse("descriptor_probe_unavailable");
  const sleepImpl =
    dependencies.sleepImpl ??
    ((milliseconds) =>
      new Promise((resolve_) => {
        setTimeout(resolve_, milliseconds);
      }));
  // One observation is enough to state the fact in the receipt. Waiting through
  // the full window only earns its cost when the caller is gating on the answer.
  const attemptLimit =
    dependencies.descriptorProbeAttempts ?? options.attempts ?? 1;
  const url = `https://${input.edge.hostname}${AUTHORITY_DESCRIPTOR_PATH}`;
  let lastStatus = null;
  let lastFailure = "unreachable";
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(DESCRIPTOR_PROBE_REQUEST_TIMEOUT_MS),
      });
    } catch {
      lastStatus = null;
      lastFailure = "unreachable";
      if (attempt < attemptLimit) await sleepImpl(DESCRIPTOR_PROBE_INTERVAL_MS);
      continue;
    }
    lastStatus = typeof response?.status === "number" ? response.status : null;
    if (lastStatus !== 200) {
      lastFailure = "http_status";
      if (attempt < attemptLimit) await sleepImpl(DESCRIPTOR_PROBE_INTERVAL_MS);
      continue;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      lastFailure = "body_invalid";
      if (attempt < attemptLimit) await sleepImpl(DESCRIPTOR_PROBE_INTERVAL_MS);
      continue;
    }
    // Validate the established public response envelope, while deliberately
    // retaining none of the response body in a receipt or log. A 200 from a
    // proxy, an unrelated application, or `{}` is not proof of Authority.
    let descriptor;
    try {
      descriptor = validateOrganizationAuthorityDescriptorResponse(body);
    } catch {
      lastFailure = "descriptor_invalid";
      if (attempt < attemptLimit) await sleepImpl(DESCRIPTOR_PROBE_INTERVAL_MS);
      continue;
    }
    if (input.authorityPinSha256 === undefined) {
      return descriptorObservation({
        accepted: false,
        serving: true,
        attempts: attempt,
        status: 200,
        failure_class: "descriptor_pin_required",
      });
    }
    try {
      verifyOrganizationAuthorityPin(
        descriptor.authority_descriptor,
        input.authorityPinSha256,
      );
    } catch {
      // A structurally valid descriptor for another Authority is a permanent
      // identity mismatch, not a delayed-start condition. Do not burn the
      // recovery probe window retrying it.
      return descriptorObservation({
        accepted: false,
        serving: true,
        attempts: attempt,
        status: 200,
        failure_class: "descriptor_pin_mismatch",
      });
    }
    return descriptorObservation({
      accepted: true,
      serving: true,
      attempts: attempt,
      status: 200,
      failure_class: null,
    });
  }
  return descriptorObservation({
    accepted: false,
    serving: false,
    attempts: attemptLimit,
    status: lastStatus,
    failure_class: lastFailure,
  });
}

function requiredAuthorityFailureCode(descriptor) {
  return descriptor.failure_class === "descriptor_pin_mismatch"
    ? "authority_descriptor_pin_mismatch"
    : "authority_descriptor_unready";
}

function executedUpFailureReceipt(input, failureClass, fields) {
  return lifecycleReceipt(input, "up", "failed", {
    ...fields,
    failure_class: failureClass,
  });
}

function refuseWithReceipt(code, receipt) {
  const error = new LifecycleError(code);
  // This is intentionally a sanitized, public receipt only. runCli emits it
  // before the controlled nonzero exit so automation can distinguish a probe
  // failure from a CloudFormation failure without ever receiving response data.
  error.receipt = receipt;
  throw error;
}

function safeEdgeState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    refuse("edge_receipt_invalid");
  if (typeof value.state !== "string" || !EDGE_RECEIPT_STATES.has(value.state))
    refuse("edge_receipt_invalid");
  return value.state;
}

async function initializedProtectedStack(input, dependencies) {
  const current = await describeExactStack(input, dependencies);
  if (current === undefined) refuse("slot_init_required");
  if (current.pendingCreate) refuse("slot_init_not_executed");
  if (current.failedCreate) refuse("slot_init_recovery_required");
  if (!current.terminationProtection)
    refuse("slot_termination_protection_required");
  return current;
}

async function prepareSetupArtifact(input, outputs, dependencies) {
  if (input.hostSetup === undefined) refuse("host_setup_required");
  const expectedBucket = requiredOutput(outputs, "HostSetupArtifactBucketName");
  const uploadObject = dependencies?.s3?.uploadObject;
  const assertObject = dependencies?.s3?.assertObject;
  if (typeof uploadObject !== "function") refuse("s3_uploadObject_required");
  if (typeof assertObject !== "function") refuse("s3_assertObject_required");
  let uploaded;
  try {
    uploaded = await uploadObject({
      bucket: expectedBucket,
      key: input.hostSetup.key,
      path: input.hostSetup.path,
      region: input.region,
      sha256: input.hostSetup.sha256,
    });
    if (
      uploaded === null ||
      typeof uploaded !== "object" ||
      typeof uploaded.version !== "string" ||
      !S3_VERSION.test(uploaded.version) ||
      typeof uploaded.sha256 !== "string" ||
      !SHA256.test(uploaded.sha256)
    ) {
      refuse("host_setup_upload_invalid");
    }
    await assertObject({
      bucket: expectedBucket,
      key: input.hostSetup.key,
      region: input.region,
      sha256: uploaded.sha256,
      version: uploaded.version,
    });
  } catch {
    refuse("host_setup_upload_unverified");
  }
  return Object.freeze({
    key: input.hostSetup.key,
    sha256: uploaded.sha256,
    version: uploaded.version,
  });
}

async function assertReviewedSetupArtifact(plan, outputs, input, dependencies) {
  const artifact = plan.artifact;
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    typeof artifact.key !== "string" ||
    !S3_KEY.test(artifact.key) ||
    typeof artifact.version !== "string" ||
    !S3_VERSION.test(artifact.version) ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256)
  ) {
    refuse("reviewed_host_setup_missing");
  }
  if (
    artifact.key !== input.hostSetup.key ||
    artifact.sha256 !== input.hostSetup.sha256
  ) {
    refuse("reviewed_host_setup_drifted");
  }
  const assertObject = dependencies?.s3?.assertObject;
  if (typeof assertObject !== "function") refuse("s3_assertObject_required");
  try {
    await assertObject({
      bucket: requiredOutput(outputs, "HostSetupArtifactBucketName"),
      key: artifact.key,
      region: input.region,
      sha256: artifact.sha256,
      version: artifact.version,
    });
  } catch {
    refuse("reviewed_host_setup_unverified");
  }
}

async function quiesceExactHost(input, outputs, dependencies) {
  const instanceId = requiredOutput(outputs, "StagingHostInstanceId");
  if (!/^i-[a-f0-9]{8,17}$/.test(instanceId))
    refuse("host_instance_id_invalid");
  const quiesceHost = dependencies?.ssm?.quiesceHost;
  if (typeof quiesceHost !== "function") refuse("ssm_quiesceHost_required");
  let result;
  try {
    result = await quiesceHost({
      instanceId,
      mountPath: CLEAN_DATA_MOUNT,
      region: input.region,
    });
  } catch {
    refuse("host_quiesce_failed");
  }
  if (
    result === null ||
    typeof result !== "object" ||
    result.composeStopped !== true ||
    result.dockerStopped !== true ||
    result.syncComplete !== true ||
    result.volumeUnmounted !== true ||
    result.volumeSafe !== true
  ) {
    refuse("host_quiesce_unproven");
  }
}

async function recoverExactHost(input, outputs, dependencies) {
  const instanceId = requiredOutput(outputs, "StagingHostInstanceId");
  if (!/^i-[a-f0-9]{8,17}$/.test(instanceId))
    refuse("host_instance_id_invalid");
  const recoverHost = dependencies?.ssm?.recoverHost;
  if (typeof recoverHost !== "function") refuse("ssm_recoverHost_required");
  let result;
  try {
    result = await recoverHost({
      instanceId,
      mountPath: CLEAN_DATA_MOUNT,
      region: input.region,
    });
  } catch {
    refuse("host_recovery_failed");
  }
  if (
    result === null ||
    typeof result !== "object" ||
    result.volumeMounted !== true ||
    result.dockerStarted !== true ||
    result.existingContainersStarted !== true
  ) {
    refuse("host_recovery_unproven");
  }
}

async function recoverCurrentRolledBackHost(input, dependencies) {
  const current = await describeExactStack(input, dependencies);
  if (
    current === undefined ||
    current.updateRolledBack !== true ||
    requiredOutput(current.outputs, "StagingHostReady") !== "true"
  ) {
    refuse("host_recovery_state_unproven");
  }
  await recoverExactHost(input, current.outputs, dependencies);
}

function assertSlotInitPlan(planned) {
  if (planned.existing?.updateRolledBack === true)
    refuse("slot_init_update_rollback_requires_lifecycle_retry");
  if (
    planned.existing !== undefined &&
    planned.existing.pendingCreate !== true &&
    planned.existing.failedCreate !== true &&
    planned.plan.executable
  ) {
    refuse("slot_init_existing_stack_change");
  }
  return planned;
}

async function runSlotInit(input, { execute = false, ...dependencies } = {}) {
  const planned = assertSlotInitPlan(
    execute
      ? await reviewedPlanStack(input, "slot-init", false, dependencies)
      : await planStack(input, "slot-init", false, dependencies),
  );
  if (!execute)
    return lifecycleReceipt(
      input,
      "slot-init",
      "planned",
      publicPlan(planned.plan, false, planned.edgePlanBinding),
    );

  const stack = await executePlannedStack(input, planned.plan, dependencies);
  if (stack.failedCreate) refuse("slot_init_failed_create_not_repaired");
  const ensureTerminationProtection = adapterFunction(
    dependencies,
    "ensureTerminationProtection",
  );
  try {
    await ensureTerminationProtection({
      region: input.region,
      stackName: input.stack.name,
    });
  } catch {
    refuse("slot_termination_protection_failed");
  }
  const protectedStack = await describeExactStack(input, dependencies);
  if (protectedStack?.terminationProtection !== true)
    refuse("slot_termination_protection_unproven");
  const secretArn = requiredOutput(
    protectedStack.outputs,
    "AuthorityTunnelTokenSecretArn",
  );
  const edge = edgeFunctions(dependencies);
  const edgeConfig = edgeInput(input, secretArn, dependencies);
  const installed = await edge.install(
    edgeConfig,
    edgeDependencies(dependencies),
  );
  if (safeEdgeState(installed) !== "ready") refuse("edge_install_unready");
  return lifecycleReceipt(input, "slot-init", "ready", {
    ...publicPlan(planned.plan, false, planned.edgePlanBinding),
    edge_ready: true,
    stack_status: protectedStack.status,
    termination_protection: true,
  });
}

async function runUp(
  input,
  {
    execute = false,
    initializeBlankDataVolume = false,
    requireAuthority = false,
    ...dependencies
  } = {},
) {
  // The descriptor schema proves liveness only. A retained-volume recovery
  // must also prove it is the independently accepted Authority before any AWS
  // action begins.
  if (requireAuthority && initializeBlankDataVolume)
    refuse("require_authority_conflicts_with_blank_data_volume");
  if (requireAuthority && input.authorityPinSha256 === undefined)
    refuse("authority_descriptor_pin_required");
  const current = await initializedProtectedStack(input, dependencies);
  const hostAlreadyEnabled =
    requiredOutput(current.outputs, "StagingHostReady") === "true";
  if (hostAlreadyEnabled) {
    // A descriptor gate may time out after CloudFormation has already enabled
    // the host. Re-running it must be a non-mutating verification, not a
    // needless down/up cycle or a second change-set execution.
    if (!(execute && requireAuthority)) refuse("host_already_enabled");
    // A completed rollback is recoverable only through a newly reviewed
    // lifecycle retry. Do not let its stale host-ready output turn this into a
    // descriptor-only success: the stack itself is not healthy.
    if (!HEALTHY_STACK_STATUSES.has(current.status))
      refuse("stack_status_invalid");
    const descriptor = await probeAuthorityDescriptor(input, dependencies, {
      attempts: DESCRIPTOR_PROBE_ATTEMPTS,
    });
    if (!descriptor.accepted) {
      const failureCode = requiredAuthorityFailureCode(descriptor);
      refuseWithReceipt(
        failureCode,
        executedUpFailureReceipt(input, failureCode, {
          authority_descriptor: descriptor,
          authority_accepted: false,
          authority_serving: descriptor.serving,
          host_enabled: true,
          host_ready: true,
          stack_status: current.status,
          verification_only: true,
        }),
      );
    }
    return lifecycleReceipt(input, "up", "executed", {
      authority_descriptor: descriptor,
      authority_accepted: true,
      authority_serving: true,
      host_enabled: true,
      host_ready: true,
      stack_status: current.status,
      verification_only: true,
    });
  }
  await assertStagingAmiRootDevice(input, dependencies);
  if (input.hostSetup === undefined) refuse("host_setup_required");
  const setupArtifact = execute
    ? undefined
    : await prepareSetupArtifact(input, current.outputs, dependencies);
  const planned = execute
    ? await reviewedPlanStack(
        input,
        "up",
        true,
        dependencies,
        initializeBlankDataVolume,
        requireAuthority,
      )
    : await planStack(
        input,
        "up",
        true,
        dependencies,
        setupArtifact,
        initializeBlankDataVolume,
        requireAuthority,
      );
  if (!execute)
    return lifecycleReceipt(input, "up", "planned", {
      ...publicPlan(planned.plan, true),
      initialize_blank_data_volume: initializeBlankDataVolume,
    });
  await assertReviewedSetupArtifact(
    planned.plan,
    current.outputs,
    input,
    dependencies,
  );
  const stack = await executePlannedStack(input, planned.plan, dependencies);
  const hostReady =
    requiredOutput(stack.outputs, "StagingHostReady") === "true";
  if (!hostReady)
    refuseWithReceipt(
      "host_ready_unproven",
      executedUpFailureReceipt(input, "host_ready_unproven", {
        ...publicPlan(planned.plan, true),
        authority_accepted: false,
        authority_serving: false,
        host_enabled: false,
        host_ready: false,
        initialize_blank_data_volume: initializeBlankDataVolume,
        stack_status: stack.status,
      }),
    );
  const descriptor = await probeAuthorityDescriptor(input, dependencies, {
    attempts: requireAuthority ? DESCRIPTOR_PROBE_ATTEMPTS : 1,
  });
  if (requireAuthority && !descriptor.accepted) {
    const failureCode = requiredAuthorityFailureCode(descriptor);
    refuseWithReceipt(
      failureCode,
      executedUpFailureReceipt(input, failureCode, {
        ...publicPlan(planned.plan, true),
        authority_descriptor: descriptor,
        authority_accepted: false,
        authority_serving: descriptor.serving,
        host_ready: hostReady,
        initialize_blank_data_volume: initializeBlankDataVolume,
        stack_status: stack.status,
      }),
    );
  }
  return lifecycleReceipt(input, "up", "executed", {
    ...publicPlan(planned.plan, true),
    initialize_blank_data_volume: initializeBlankDataVolume,
    stack_status: stack.status,
    // Machine readiness and Authority readiness are separate facts. Naming both
    // is what makes this receipt enough to decide on without a follow-up hunt.
    host_ready: hostReady,
    authority_serving: descriptor.serving,
    authority_accepted: descriptor.accepted,
    authority_descriptor: descriptor,
  });
}

async function runDown(input, { execute = false, ...dependencies } = {}) {
  const current = await initializedProtectedStack(input, dependencies);
  const hostEnabled =
    requiredOutput(current.outputs, "StagingHostReady") === "true";
  const planned = execute
    ? await reviewedPlanStack(input, "down", false, dependencies)
    : await planStack(input, "down", false, dependencies);
  if (!execute)
    return lifecycleReceipt(
      input,
      "down",
      "planned",
      publicPlan(planned.plan, false),
    );
  if (hostEnabled) await quiesceExactHost(input, current.outputs, dependencies);
  let stack;
  try {
    stack = await executePlannedStack(input, planned.plan, dependencies);
  } catch (error) {
    if (!hostEnabled) throw error;
    try {
      // CloudFormation can recreate the host while rolling an update back.
      // Re-read the terminal rollback outputs before touching any instance.
      await recoverCurrentRolledBackHost(input, dependencies);
    } catch {
      throw new LifecycleError(
        "change_set_execute_failed_host_recovery_failed",
        error instanceof LifecycleError ? error.safeEvents : [],
      );
    }
    throw new LifecycleError(
      "change_set_execute_failed_host_recovered",
      error instanceof LifecycleError ? error.safeEvents : [],
    );
  }
  return lifecycleReceipt(input, "down", "executed", {
    ...publicPlan(planned.plan, false),
    persistent_edge_preserved: true,
    persistent_state_boundary_preserved: true,
    stack_status: stack.status,
  });
}

async function runStatus(input, dependencies = {}) {
  const stack = await describeExactStack(input, dependencies);
  if (stack === undefined)
    return lifecycleReceipt(input, "status", "absent", { edge_checked: false });
  if (stack.pendingCreate)
    return lifecycleReceipt(input, "status", "planned", {
      edge_checked: false,
      stack_status: stack.status,
    });
  if (stack.failedCreate)
    return lifecycleReceipt(input, "status", "failed_create", {
      edge_checked: false,
      recovery_action: "slot-init",
      stack_status: stack.status,
      termination_protection: stack.terminationProtection,
    });
  if (stack.updateRolledBack)
    return lifecycleReceipt(input, "status", "update_rolled_back", {
      edge_checked: false,
      recovery_action:
        requiredOutput(stack.outputs, "StagingHostReady") === "true"
          ? "down"
          : "up",
      stack_status: stack.status,
      termination_protection: stack.terminationProtection,
    });
  if (!stack.terminationProtection)
    return lifecycleReceipt(input, "status", "unprotected", {
      edge_checked: false,
      recovery_action: "slot-init",
      stack_status: stack.status,
      termination_protection: false,
    });
  const hostReady =
    requiredOutput(stack.outputs, "StagingHostReady") === "true";
  // A stopped disposable host makes the edge's current state irrelevant to
  // this lifecycle decision. Return the known AWS fact before resolving any
  // Cloudflare token or making an external request.
  if (!hostReady)
    return lifecycleReceipt(input, "status", "host_down", {
      authority_serving: false,
      authority_accepted: false,
      edge_checked: false,
      host_enabled: false,
      host_ready: false,
      stack_status: stack.status,
      termination_protection: true,
    });
  const secretArn = requiredOutput(
    stack.outputs,
    "AuthorityTunnelTokenSecretArn",
  );
  const edge = edgeFunctions(dependencies);
  const status = await edge.status(
    edgeInput(input, secretArn, dependencies),
    edgeDependencies(dependencies),
  );
  const edgeState = safeEdgeState(status);
  const descriptor = await probeAuthorityDescriptor(input, dependencies);
  if (!descriptor.serving)
    return lifecycleReceipt(input, "status", "authority_unready", {
      authority_descriptor: descriptor,
      authority_accepted: false,
      authority_serving: false,
      edge_checked: true,
      edge_ready: edgeState === "ready",
      host_enabled: true,
      host_ready: true,
      stack_status: stack.status,
      termination_protection: true,
    });
  if (!descriptor.accepted)
    return lifecycleReceipt(
      input,
      "status",
      descriptor.failure_class === "descriptor_pin_mismatch"
        ? "authority_pin_mismatch"
        : "authority_unpinned",
      {
        authority_descriptor: descriptor,
        authority_accepted: false,
        authority_serving: true,
        edge_checked: true,
        edge_ready: edgeState === "ready",
        host_enabled: true,
        host_ready: true,
        stack_status: stack.status,
        termination_protection: true,
      },
    );
  return lifecycleReceipt(input, "status", edgeState, {
    authority_descriptor: descriptor,
    authority_accepted: true,
    authority_serving: true,
    edge_checked: true,
    edge_ready: edgeState === "ready",
    host_enabled: true,
    host_ready: true,
    stack_status: stack.status,
    termination_protection: true,
  });
}

function regionalArn(value, code) {
  const match = typeof value === "string" ? REGIONAL_ARN.exec(value) : null;
  if (match === null) refuse(code);
  return Object.freeze({
    partition: match[1],
    region: match[2],
    account: match[3],
  });
}

/**
 * Prove, from AWS rather than operator input, that the volume about to be
 * selected is the slot's encrypted clean-data volume and that its key is
 * usable in the same account. This is the source-encryption evidence gate of
 * RB-OPERATIONS-002, run on every plan and execute.
 */
async function verifiedDataVolume(input, outputs, dependencies) {
  const volumeId = exactString(
    requiredOutput(outputs, "StagingDataVolumeId"),
    DATA_VOLUME_ID,
    "data_volume_id_invalid",
  );
  // The slot stack created this secret, so its ARN names the slot's account.
  const slot = regionalArn(
    requiredOutput(outputs, "AuthorityTunnelTokenSecretArn"),
    "stack_outputs_invalid",
  );
  const describeVolume = ec2AdapterFunction(dependencies, "describeVolume");
  const describeKey = dependencies?.kms?.describeKey;
  if (typeof describeKey !== "function") refuse("kms_describeKey_required");
  let volume;
  try {
    volume = await describeVolume({ region: input.region, volumeId });
  } catch {
    refuse("data_volume_unproven");
  }
  if (volume === null || typeof volume !== "object")
    refuse("data_volume_unproven");
  const tags = volume.tags ?? {};
  if (
    volume.volumeId !== volumeId ||
    volume.availabilityZone !== input.stack.parameters.AvailabilityZone ||
    !["available", "in-use"].includes(volume.state) ||
    tags["aws:cloudformation:stack-name"] !== input.stack.name ||
    tags["aws:cloudformation:logical-id"] !== "StagingDataVolume" ||
    tags.Purpose !== "authority-clean-data" ||
    tags.MountPath !== CLEAN_DATA_MOUNT
  ) {
    refuse("data_volume_identity_mismatch");
  }
  if (
    volume.encrypted !== true ||
    typeof volume.kmsKeyId !== "string" ||
    !KMS_KEY_ARN.test(volume.kmsKeyId)
  ) {
    refuse("data_volume_not_encrypted");
  }
  const keyLocation = regionalArn(volume.kmsKeyId, "data_volume_not_encrypted");
  if (
    keyLocation.account !== slot.account ||
    keyLocation.region !== input.region
  ) {
    refuse("data_volume_key_foreign");
  }
  let key;
  try {
    key = await describeKey({ region: input.region, keyId: volume.kmsKeyId });
  } catch {
    refuse("data_volume_key_unproven");
  }
  if (
    key === null ||
    typeof key !== "object" ||
    key.arn !== volume.kmsKeyId ||
    key.accountId !== slot.account ||
    !["AWS", "CUSTOMER"].includes(key.keyManager) ||
    key.keyState !== "Enabled" ||
    key.enabled !== true ||
    key.keyUsage !== "ENCRYPT_DECRYPT"
  ) {
    refuse("data_volume_key_unusable");
  }
  const selectedVolumeArn = [
    `arn:${slot.partition}:ec2:${input.region}`,
    slot.account,
    `volume/${volumeId}`,
  ].join(":");
  return Object.freeze({
    kmsKeyArn: key.arn,
    selectedVolumeArn,
    slot,
    volumeId,
    // Booleans and the key manager only: identifiers stay out of receipts.
    evidence: Object.freeze({
      encrypted: true,
      key_enabled: true,
      key_manager: key.keyManager,
      same_account_key: true,
      slot_clean_data_volume: true,
    }),
  });
}

async function provenAlertTopic(input, dependencies) {
  const describeTopic = dependencies?.sns?.describeTopic;
  if (typeof describeTopic !== "function") refuse("sns_describeTopic_required");
  let topic;
  try {
    topic = await describeTopic({
      region: input.region,
      topicArn: input.backup.alertTopicArn,
    });
  } catch {
    refuse("backup_alert_topic_unproven");
  }
  if (
    topic === null ||
    typeof topic !== "object" ||
    topic.topicArn !== input.backup.alertTopicArn ||
    !Number.isSafeInteger(topic.subscriptionsConfirmed) ||
    topic.subscriptionsConfirmed < 0
  ) {
    refuse("backup_alert_topic_unproven");
  }
  return topic;
}

function dataBackupStackName(input) {
  const name = `${input.stack.name}${DATA_BACKUP_STACK_SUFFIX}`;
  if (name.length > DATA_BACKUP_STACK_NAME_MAX)
    refuse("backup_stack_name_too_long");
  return name;
}

function dataBackupChangeSetRequest(input, stackName, type, source) {
  const template = checkedTemplate(DATA_BACKUP_TEMPLATE_PATH);
  return Object.freeze({
    capabilities: Object.freeze(["CAPABILITY_IAM"]),
    changeSetName: changeSetName(input, "backup"),
    changeSetType: type,
    clientToken: input.operationId,
    onStackFailure: type === "CREATE" ? "DO_NOTHING" : undefined,
    parameterKeys: DATA_BACKUP_PARAMETER_KEYS,
    parameters: Object.freeze({
      DataVolumeId: source.volumeId,
      DataVolumeKmsKeyArn: source.kmsKeyArn,
      AlertTopicArn: input.backup.alertTopicArn,
      BackupScheduleExpression: DATA_BACKUP_SCHEDULE_EXPRESSION,
      RecoveryPointRetentionDays: DATA_BACKUP_RETENTION_DAYS,
    }),
    region: input.region,
    stackName,
    templatePath: template.path,
    templateSha256: template.sha256,
  });
}

/**
 * A new or repaired stack may only add the reviewed inventory; an existing
 * one may only retune its plan or alarm in place. Nothing is ever removed or
 * replaced, so a change set can never drop recovery points' vault or roles.
 */
function assertDataBackupChangeBoundary(plan, existing) {
  if (!plan.executable) return plan;
  const creating =
    existing === undefined ||
    existing.pendingCreate === true ||
    existing.failedCreate === true;
  const added = new Set();
  for (const change of plan.actions) {
    const known = DATA_BACKUP_LOGICAL_IDS.has(change.logical_id);
    const adds = creating && known && change.action === "Add";
    const tunes =
      change.action === "Modify" &&
      change.replacement === false &&
      (creating
        ? known
        : DATA_BACKUP_MODIFIABLE_LOGICAL_IDS.has(change.logical_id));
    if (!adds && !tunes) refuse("change_set_backup_boundary_violation");
    if (adds) added.add(change.logical_id);
  }
  if (
    plan.changeSetType === "CREATE" &&
    added.size !== DATA_BACKUP_LOGICAL_IDS.size
  ) {
    refuse("change_set_backup_boundary_violation");
  }
  return plan;
}

async function runBackup(input, { execute = false, ...dependencies } = {}) {
  if (input.backup === undefined) refuse("backup_input_required");
  const stackName = dataBackupStackName(input);
  const slot = await initializedProtectedStack(input, dependencies);
  const source = await verifiedDataVolume(input, slot.outputs, dependencies);
  const topic = regionalArn(
    input.backup.alertTopicArn,
    "backup_alert_topic_invalid",
  );
  if (topic.account !== source.slot.account || topic.region !== input.region)
    refuse("backup_alert_topic_foreign");
  const alertTopic = await provenAlertTopic(input, dependencies);
  const existing = await describeNamedStack(
    input.region,
    stackName,
    dependencies,
  );
  if (execute && existing === undefined) refuse("backup_plan_required");
  const request = dataBackupChangeSetRequest(
    input,
    stackName,
    changeSetTypeFor(existing),
    source,
  );
  const planChangeSet = adapterFunction(
    dependencies,
    execute ? "describeChangeSet" : "createChangeSet",
  );
  const plan = assertDataBackupChangeBoundary(
    checkedChangeSet(await planChangeSet(request)),
    existing,
  );
  const fields = {
    backup_stack_name: stackName,
    change_set_name: request.changeSetName,
    change_set_actions: plan.actions,
    change_set_created: plan.kind === "change_set",
    change_set_ready_for_review: plan.executable,
    no_changes: plan.kind === "no_changes",
    data_volume: source.evidence,
    // An alarm on a topic nobody confirmed reaches no one. Report it rather
    // than withhold the backup itself.
    alert_delivery_confirmed: alertTopic.subscriptionsConfirmed > 0,
    retention_days: Number(DATA_BACKUP_RETENTION_DAYS),
    schedule_expression: DATA_BACKUP_SCHEDULE_EXPRESSION,
  };
  if (!execute) return lifecycleReceipt(input, "backup", "planned", fields);

  const ensureTerminationProtection = adapterFunction(
    dependencies,
    "ensureTerminationProtection",
  );
  const protectStack = async () => {
    try {
      await ensureTerminationProtection({ region: input.region, stackName });
    } catch {
      refuse("backup_termination_protection_failed");
    }
  };
  // Protect a new stack's REVIEW_IN_PROGRESS shell before it holds anything.
  if (plan.executable && plan.changeSetType === "CREATE") await protectStack();
  const stack = await executePlannedStack(input, plan, dependencies, stackName);
  if (stack.failedCreate) refuse("backup_failed_create_not_repaired");
  await protectStack();
  const protectedStack = await describeNamedStack(
    input.region,
    stackName,
    dependencies,
  );
  if (protectedStack?.terminationProtection !== true)
    refuse("backup_termination_protection_unproven");
  if (
    requiredOutput(protectedStack.outputs, "SelectedDataVolumeArn") !==
    source.selectedVolumeArn
  ) {
    refuse("backup_selection_unproven");
  }
  return lifecycleReceipt(input, "backup", "executed", {
    ...fields,
    stack_status: protectedStack.status,
    termination_protection: true,
  });
}

/**
 * Execute one lifecycle action. `execute` defaults to false so a CloudFormation
 * change set is always available for review before it can mutate the slot.
 */
export async function runAuthorityStaging(action, rawInput, dependencies = {}) {
  const input = validateStagingLifecycleInput(rawInput);
  if (action === "slot-init") return runSlotInit(input, dependencies);
  if (action === "up") return runUp(input, dependencies);
  if (action === "down") return runDown(input, dependencies);
  if (action === "status") return runStatus(input, dependencies);
  if (action === "backup") return runBackup(input, dependencies);
  refuse("usage");
}

function echoHostedAwsEnvironment({ preserveCloudflareToken = false } = {}) {
  const environment = sanitizedAwsEnvironment(process.env);
  if (!preserveCloudflareToken) delete environment.ECHO_CLOUDFLARE_API_TOKEN;
  return environment;
}

function awsCliTimeoutMs(args) {
  if (args[0] === "cloudformation" && args[1] === "wait")
    return AWS_CLOUDFORMATION_WAIT_TIMEOUT_MS;
  if (
    args[0] === "ssm" &&
    args[1] === "wait" &&
    args[2] === "command-executed"
  ) {
    return AWS_SSM_LIFECYCLE_WAIT_TIMEOUT_MS;
  }
  return AWS_CLI_STANDARD_TIMEOUT_MS;
}

function safeBoundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new AwsCliError("limit_invalid");
  return value;
}

function isBoundedCliFailure(error) {
  return (
    error instanceof AwsCliError &&
    new Set([
      "deadline_exceeded",
      "output_limit_exceeded",
      "stdin_failed",
    ]).has(error.code)
  );
}

export function awsJson(
  args,
  { stdin, timeoutMs, maxOutputBytes } = {},
) {
  let boundedTimeoutMs;
  let boundedMaxOutputBytes;
  try {
    boundedTimeoutMs = safeBoundedInteger(
      timeoutMs,
      awsCliTimeoutMs(args),
      AWS_CLOUDFORMATION_WAIT_TIMEOUT_MS,
    );
    boundedMaxOutputBytes = safeBoundedInteger(
      maxOutputBytes,
      AWS_CLI_OUTPUT_MAX_BYTES,
      AWS_CLI_OUTPUT_MAX_BYTES,
    );
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "aws",
      awsCliArguments(args),
      {
        detached: true,
        env: echoHostedAwsEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminalFailure;
    let settled = false;
    let forceKillTimer;
    const deadlineTimer = setTimeout(
      () => terminate(new AwsCliError("deadline_exceeded")),
      boundedTimeoutMs,
    );
    function settle(error, result = undefined) {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(result);
    }
    function terminate(error) {
      if (terminalFailure !== undefined) return;
      terminalFailure = error;
      terminateProcessGroup("SIGTERM");
      forceKillTimer = setTimeout(
        () => {
          terminateProcessGroup("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          settle(terminalFailure);
        },
        AWS_CLI_TERMINATE_GRACE_MS,
      );
    }
    function terminateProcessGroup(signal) {
      if (typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    }
    function collect(chunks, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > boundedMaxOutputBytes) {
        terminate(new AwsCliError("output_limit_exceeded"));
        return;
      }
      chunks.push(bytes);
    }
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", () => settle(new AwsCliError("unavailable")));
    child.once("close", (code) => {
      if (terminalFailure !== undefined) {
        settle(terminalFailure);
        return;
      }
      if (code !== 0) {
        const failure = new AwsCliError("failed");
        failure.privateDiagnostic = Buffer.concat(stderr).toString("utf8");
        settle(failure);
        return;
      }
      try {
        const output = Buffer.concat(stdout).toString("utf8");
        settle(undefined, output === "" ? {} : JSON.parse(output));
      } catch {
        settle(new AwsCliError("response_invalid"));
      }
    });
    if (stdin === undefined) child.stdin.end();
    else {
      child.stdin.once("error", () =>
        terminate(new AwsCliError("stdin_failed")),
      );
      child.stdin.end(stdin);
    }
  });
}

function cloudFormationParameters(parameters) {
  return Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
}

function changeSetDescription(
  templateSha256,
  changeSetType,
  edgePlanBinding = undefined,
) {
  const edgeBindingSuffix =
    edgePlanBinding === undefined
      ? ""
      : `-edge-${sha256Hex(JSON.stringify(edgePlanBinding))}`;
  return `echo-authority-staging-template-${templateSha256}-${changeSetType}${edgeBindingSuffix}`;
}

function changeActions(payload) {
  if (!Array.isArray(payload.Changes)) return [];
  return payload.Changes.map((item) => ({
    action: item?.ResourceChange?.Action,
    logicalId: item?.ResourceChange?.LogicalResourceId,
    replacement: item?.ResourceChange?.Replacement,
    resourceType: item?.ResourceChange?.ResourceType,
  }));
}

function parametersMatch(payload, expected) {
  if (
    payload.Description !==
    changeSetDescription(
      expected.templateSha256,
      expected.changeSetType,
      expected.edgePlanBinding,
    )
  ) {
    return false;
  }
  if (
    payload.ChangeSetType !== undefined &&
    payload.ChangeSetType !== null &&
    payload.ChangeSetType !== expected.changeSetType
  ) {
    return false;
  }
  if (expected.changeSetType === "CREATE") {
    if (payload.OnStackFailure !== expected.onStackFailure) return false;
  } else if (
    payload.OnStackFailure !== undefined &&
    payload.OnStackFailure !== null
  ) {
    return false;
  }
  if (!Array.isArray(payload.Parameters)) return false;

  // Every lifecycle plan names the complete template vector. The only dynamic
  // values are the three HostSetup fields during execute: their exact S3
  // object version is intentionally learned from the stored plan and then
  // checked by assertReviewedSetupArtifact. Every other value must match.
  // In particular, accepting a subset would let an already-existing same-name
  // change set smuggle in an onboarding-transfer grant while still matching
  // the host lifecycle parameters. The data-backup stack names its own vector.
  const parameterKeys = expected.parameterKeys ?? TEMPLATE_PARAMETER_KEYS;
  const expectedEntries = Object.entries(expected.parameters);
  if (
    expectedEntries.length !== parameterKeys.length ||
    !parameterKeys.every((key) => Object.hasOwn(expected.parameters, key))
  ) {
    return false;
  }
  if (payload.Parameters.length !== parameterKeys.length) return false;

  const actual = new Map();
  for (const item of payload.Parameters) {
    const key = item?.ParameterKey;
    const value = item?.ParameterValue;
    if (typeof key !== "string" || typeof value !== "string") return false;
    // Map construction alone would silently collapse duplicate keys, turning a
    // malformed response into a false match.
    if (actual.has(key)) return false;
    actual.set(key, value);
  }
  if (!parameterKeys.every((key) => actual.has(key))) return false;
  const dynamicHostSetup =
    expected.parameters.HostEnabled === "true" &&
    HOST_SETUP_PARAMETER_KEYS.every(
      (key) => expected.parameters[key] === "",
    );
  for (const [key, value] of expectedEntries) {
    if (dynamicHostSetup && HOST_SETUP_PARAMETER_KEYS.includes(key)) continue;
    if (actual.get(key) !== value) return false;
  }
  return (
    !dynamicHostSetup ||
    HOST_SETUP_PARAMETER_KEYS.every((key) => {
      const value = actual.get(key);
      return value !== undefined && value.length > 0;
    })
  );
}

function normalizedChangeSet(payload, expected) {
  const matchesExpected = parametersMatch(payload, expected);
  // DescribeChangeSet does not return ChangeSetType reliably. Only an exact
  // request-bound description lets us derive it from the request we created.
  const changeSetType = matchesExpected ? expected.changeSetType : undefined;
  const parameters = new Map(
    Array.isArray(payload.Parameters)
      ? payload.Parameters.map((item) => [
          item?.ParameterKey,
          item?.ParameterValue,
        ])
      : [],
  );
  const artifact =
    parameters.get("HostEnabled") === "true"
      ? {
          key: parameters.get("HostSetupObjectKey"),
          sha256: parameters.get("HostSetupSha256"),
          version: parameters.get("HostSetupObjectVersion"),
        }
      : undefined;
  if (
    payload.Status === "FAILED" &&
    typeof payload.StatusReason === "string" &&
    /didn't contain changes|no updates are to be performed/i.test(
      payload.StatusReason,
    )
  ) {
    return Object.freeze({
      changeSetType,
      kind: "no_changes",
      matchesExpected,
    });
  }
  return Object.freeze({
    actions: changeActions(payload),
    artifact,
    changeSetType,
    id: payload.ChangeSetId,
    kind: "change_set",
    matchesExpected,
    status: payload.Status,
  });
}

async function describeAwsChangeSet(expected) {
  const result = await awsJson([
    "cloudformation",
    "describe-change-set",
    "--region",
    expected.region,
    "--stack-name",
    expected.stackName,
    "--change-set-name",
    expected.changeSetName,
    "--output",
    "json",
  ]);
  return normalizedChangeSet(result, expected);
}

function safeFailureEvents(payload) {
  if (!Array.isArray(payload.OperationEvents)) return [];
  return payload.OperationEvents.flatMap((item) => {
    if (
      item?.ResourceStatus !== "CREATE_FAILED" &&
      item?.ResourceStatus !== "UPDATE_FAILED" &&
      item?.ResourceStatus !== "DELETE_FAILED"
    ) {
      return [];
    }
    if (
      typeof item.LogicalResourceId !== "string" ||
      !LOGICAL_ID.test(item.LogicalResourceId) ||
      typeof item.ResourceType !== "string" ||
      !RESOURCE_TYPE.test(item.ResourceType)
    ) {
      return [];
    }
    return [
      Object.freeze({
        logical_id: item.LogicalResourceId,
        resource_status: item.ResourceStatus,
        resource_type: item.ResourceType,
      }),
    ];
  });
}

async function failedStackEvents(region, stackName) {
  try {
    const result = await awsJson([
      "cloudformation",
      "describe-events",
      "--region",
      region,
      "--stack-name",
      stackName,
      "--filters",
      "FailedEvents=true",
      "--output",
      "json",
    ]);
    return safeFailureEvents(result);
  } catch {
    return [];
  }
}

/**
 * Default operational adapters. They call the locally authenticated AWS CLI,
 * never call a Secrets Manager read API, and keep the connector token on the
 * put-secret-value child's stdin rather than in an argument, receipt, or log.
 */
export function createAwsCliAdapters() {
  async function runSsmCommandWithExactSuccess({
    commands,
    instanceId,
    region,
    successMarker,
    unprovenCode,
  }) {
    const sent = await awsJson([
      "ssm",
      "send-command",
      "--region",
      region,
      "--document-name",
      "AWS-RunShellScript",
      "--instance-ids",
      instanceId,
      "--timeout-seconds",
      String(SSM_LIFECYCLE_RUN_TIMEOUT_SECONDS),
      "--parameters",
      JSON.stringify({
        commands,
        executionTimeout: [String(SSM_LIFECYCLE_RUN_TIMEOUT_SECONDS)],
      }),
      "--output",
      "json",
    ]);
    const commandId = sent.Command?.CommandId;
    if (typeof commandId !== "string" || commandId.length === 0)
      throw new AwsCliError("ssm_command_response_invalid");
    await awsJson(
      [
        "ssm",
        "wait",
        "command-executed",
        "--region",
        region,
        "--command-id",
        commandId,
        "--instance-id",
        instanceId,
      ],
      { timeoutMs: AWS_SSM_LIFECYCLE_WAIT_TIMEOUT_MS },
    );
    const result = await awsJson([
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
    ]);
    if (
      result.Status !== "Success" ||
      result.StandardOutputContent !== successMarker
    ) {
      throw new AwsCliError(unprovenCode);
    }
  }

  return Object.freeze({
    cloudFormation: Object.freeze({
      async describeStack({ region, stackName }) {
        try {
          const result = await awsJson([
            "cloudformation",
            "describe-stacks",
            "--region",
            region,
            "--stack-name",
            stackName,
            "--output",
            "json",
          ]);
          const stack = result.Stacks?.[0];
          if (!stack || typeof stack.StackStatus !== "string")
            throw new AwsCliError("stack_response_invalid");
          const outputs = Object.fromEntries(
            (stack.Outputs ?? []).flatMap((item) =>
              typeof item?.OutputKey === "string" &&
              typeof item?.OutputValue === "string"
                ? [[item.OutputKey, item.OutputValue]]
                : [],
            ),
          );
          return Object.freeze({
            exists: true,
            outputs: Object.freeze(outputs),
            status: stack.StackStatus,
            terminationProtection: stack.EnableTerminationProtection === true,
          });
        } catch (error) {
          if (
            error instanceof AwsCliError &&
            /does not exist/i.test(error.privateDiagnostic ?? "")
          ) {
            return Object.freeze({ exists: false });
          }
          throw error;
        }
      },
      async createChangeSet(expected) {
        try {
          const args = [
            "cloudformation",
            "create-change-set",
            "--region",
            expected.region,
            "--stack-name",
            expected.stackName,
            "--change-set-name",
            expected.changeSetName,
            "--change-set-type",
            expected.changeSetType,
            "--client-token",
            expected.clientToken,
            "--template-body",
            `file://${expected.templatePath}`,
            "--description",
            changeSetDescription(
              expected.templateSha256,
              expected.changeSetType,
              expected.edgePlanBinding,
            ),
            "--capabilities",
            ...expected.capabilities,
            "--parameters",
            JSON.stringify(cloudFormationParameters(expected.parameters)),
            "--output",
            "json",
          ];
          if (expected.changeSetType === "CREATE")
            args.push("--on-stack-failure", "DO_NOTHING");
          await awsJson(args);
        } catch (error) {
          if (
            error instanceof AwsCliError &&
            /already exists/i.test(error.privateDiagnostic ?? "")
          ) {
            return describeAwsChangeSet(expected);
          }
          throw error;
        }
        try {
          await awsJson([
            "cloudformation",
            "wait",
            "change-set-create-complete",
            "--region",
            expected.region,
            "--stack-name",
            expected.stackName,
            "--change-set-name",
            expected.changeSetName,
          ]);
        } catch {
          // A no-change set is FAILED by design. Describe below identifies the
          // safe, expected case without putting the service reason in output.
        }
        return describeAwsChangeSet(expected);
      },
      async describeChangeSet(expected) {
        return describeAwsChangeSet(expected);
      },
      async executeChangeSet({
        changeSetId,
        changeSetType,
        clientRequestToken,
        region,
        stackName,
      }) {
        const request = [
          "cloudformation",
          "execute-change-set",
          "--region",
          region,
          "--change-set-name",
          changeSetId,
          "--client-request-token",
          clientRequestToken,
        ];
        try {
          await awsJson(request);
        } catch (error) {
          // A bounded local CLI failure does not establish whether AWS received
          // the request. Preserve that ambiguity for operator recovery instead
          // of sending another execution request from this process.
          if (isBoundedCliFailure(error)) throw error;
          // The service accepts a client token precisely so an uncertain
          // request can be retried without starting a second update.
          await awsJson(request);
        }
        try {
          await awsJson([
            "cloudformation",
            "wait",
            changeSetType === "CREATE"
              ? "stack-create-complete"
              : "stack-update-complete",
            "--region",
            region,
            "--stack-name",
            stackName,
          ]);
        } catch {
          throw new AwsCliError(
            "stack_operation_failed",
            await failedStackEvents(region, stackName),
          );
        }
      },
      async ensureTerminationProtection({ region, stackName }) {
        await awsJson([
          "cloudformation",
          "update-termination-protection",
          "--region",
          region,
          "--stack-name",
          stackName,
          "--enable-termination-protection",
        ]);
      },
    }),
    ec2: Object.freeze({
      async describeImage({ imageId, region }) {
        const result = await awsJson([
          "ec2",
          "describe-images",
          "--region",
          region,
          "--image-ids",
          imageId,
          "--output",
          "json",
        ]);
        const images = result.Images;
        if (!Array.isArray(images) || images.length !== 1)
          throw new AwsCliError("ami_root_mapping_response_invalid");
        const image = images[0];
        if (
          image === null ||
          typeof image !== "object" ||
          typeof image.ImageId !== "string" ||
          typeof image.RootDeviceName !== "string" ||
          typeof image.RootDeviceType !== "string" ||
          typeof image.State !== "string"
        ) {
          throw new AwsCliError("ami_root_mapping_response_invalid");
        }
        return Object.freeze({
          imageId: image.ImageId,
          rootDeviceName: image.RootDeviceName,
          rootDeviceType: image.RootDeviceType,
          state: image.State,
        });
      },
      async describeVolume({ region, volumeId }) {
        const result = await awsJson([
          "ec2",
          "describe-volumes",
          "--region",
          region,
          "--volume-ids",
          volumeId,
          "--output",
          "json",
        ]);
        const volumes = result.Volumes;
        if (!Array.isArray(volumes) || volumes.length !== 1)
          throw new AwsCliError("volume_response_invalid");
        const volume = volumes[0];
        if (
          volume === null ||
          typeof volume !== "object" ||
          typeof volume.VolumeId !== "string" ||
          typeof volume.AvailabilityZone !== "string" ||
          typeof volume.State !== "string" ||
          typeof volume.Encrypted !== "boolean"
        ) {
          throw new AwsCliError("volume_response_invalid");
        }
        const tags = {};
        for (const tag of Array.isArray(volume.Tags) ? volume.Tags : []) {
          if (typeof tag?.Key === "string" && typeof tag?.Value === "string")
            tags[tag.Key] = tag.Value;
        }
        return Object.freeze({
          availabilityZone: volume.AvailabilityZone,
          encrypted: volume.Encrypted,
          kmsKeyId:
            typeof volume.KmsKeyId === "string" ? volume.KmsKeyId : undefined,
          state: volume.State,
          tags: Object.freeze(tags),
          volumeId: volume.VolumeId,
        });
      },
    }),
    kms: Object.freeze({
      async describeKey({ keyId, region }) {
        const result = await awsJson([
          "kms",
          "describe-key",
          "--region",
          region,
          "--key-id",
          keyId,
          "--output",
          "json",
        ]);
        const key = result.KeyMetadata;
        if (
          key === null ||
          typeof key !== "object" ||
          typeof key.Arn !== "string" ||
          typeof key.AWSAccountId !== "string" ||
          typeof key.KeyManager !== "string" ||
          typeof key.KeyState !== "string" ||
          typeof key.Enabled !== "boolean" ||
          typeof key.KeyUsage !== "string"
        ) {
          throw new AwsCliError("key_response_invalid");
        }
        return Object.freeze({
          accountId: key.AWSAccountId,
          arn: key.Arn,
          enabled: key.Enabled,
          keyManager: key.KeyManager,
          keyState: key.KeyState,
          keyUsage: key.KeyUsage,
        });
      },
    }),
    sns: Object.freeze({
      async describeTopic({ region, topicArn }) {
        const result = await awsJson([
          "sns",
          "get-topic-attributes",
          "--region",
          region,
          "--topic-arn",
          topicArn,
          "--output",
          "json",
        ]);
        const attributes = result.Attributes;
        const confirmed = Number(attributes?.SubscriptionsConfirmed);
        if (
          typeof attributes?.TopicArn !== "string" ||
          typeof attributes.SubscriptionsConfirmed !== "string" ||
          !Number.isSafeInteger(confirmed) ||
          confirmed < 0
        ) {
          throw new AwsCliError("topic_response_invalid");
        }
        return Object.freeze({
          subscriptionsConfirmed: confirmed,
          topicArn: attributes.TopicArn,
        });
      },
    }),
    s3: Object.freeze({
      async uploadObject({ bucket, key, path, region, sha256 }) {
        const sourcePath = resolve(path);
        let source;
        try {
          source = lstatSync(sourcePath);
          if (source.isSymbolicLink() || !source.isFile())
            throw new AwsCliError("bundle_source_not_regular");
        } catch (error) {
          if (error instanceof AwsCliError) throw error;
          throw new AwsCliError("bundle_source_unreadable");
        }
        const calculated = sha256Hex(readFileSync(sourcePath));
        if (sha256 !== undefined && sha256 !== calculated)
          throw new AwsCliError("bundle_source_checksum_mismatch");
        const result = await awsJson([
          "s3api",
          "put-object",
          "--region",
          region,
          "--bucket",
          bucket,
          "--key",
          key,
          "--body",
          sourcePath,
          "--metadata",
          `sha256=${calculated}`,
          "--output",
          "json",
        ]);
        if (
          typeof result.VersionId !== "string" ||
          !S3_VERSION.test(result.VersionId)
        )
          throw new AwsCliError("bundle_upload_response_invalid");
        return Object.freeze({ sha256: calculated, version: result.VersionId });
      },
      async assertObject({ bucket, key, region, sha256, version }) {
        const result = await awsJson([
          "s3api",
          "head-object",
          "--region",
          region,
          "--bucket",
          bucket,
          "--key",
          key,
          "--version-id",
          version,
          "--output",
          "json",
        ]);
        if (result.Metadata?.sha256 !== sha256)
          throw new AwsCliError("object_checksum_metadata_mismatch");
      },
    }),
    putSecretValue: async ({ clientRequestToken, secretArn, secretString }) => {
      const region = secretArn.match(
        /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):/,
      )?.[1];
      if (region === undefined) throw new AwsCliError("secret_arn_invalid");
      await awsJson(
        [
          "secretsmanager",
          "put-secret-value",
          "--region",
          region,
          "--secret-id",
          secretArn,
          "--client-request-token",
          clientRequestToken,
          "--secret-string",
          "file:///dev/stdin",
          "--output",
          "json",
        ],
        // The host resolves :SecretString:token through asm-exec. The raw
        // connector value stays in this process and the AWS CLI child's stdin.
        { stdin: JSON.stringify({ token: secretString }) },
      );
    },
    ssm: Object.freeze({
      async quiesceHost({ instanceId, mountPath, region }) {
        // Retained-volume `up` refuses a staged candidate, an operation lock
        // and a held staging release guard, and only a running host can clear
        // them. Refuse before stopping anything so the host keeps serving.
        const absent = (path) => `test ! -e '${path}' -a ! -L '${path}'`;
        const commands = [
          "set -eu",
          `mountpoint -q '${mountPath}'`,
          absent(`${mountPath}/release/candidate.clean-v1.json`),
          absent(`${mountPath}/.authority-operation-lock`),
          absent(`${dirname(mountPath)}/.staging-release-guard`),
          "containers=$(docker ps --quiet)",
          'if [ -n "$containers" ]; then docker stop $containers >/dev/null; fi',
          'test -z "$(docker ps --quiet)"',
          "systemctl stop docker",
          "! systemctl is-active --quiet docker",
          "sync",
          `umount '${mountPath}'`,
          `! mountpoint -q '${mountPath}'`,
          "printf 'authority-staging-quiesced\\n'",
        ];
        await runSsmCommandWithExactSuccess({
          commands,
          instanceId,
          region,
          successMarker: "authority-staging-quiesced\n",
          unprovenCode: "ssm_quiesce_unproven",
        });
        return Object.freeze({
          composeStopped: true,
          dockerStopped: true,
          syncComplete: true,
          volumeSafe: true,
          volumeUnmounted: true,
        });
      },
      async recoverHost({ instanceId, mountPath, region }) {
        const commands = [
          "set -eu",
          `mountpoint -q '${mountPath}' || mount '${mountPath}'`,
          `mountpoint -q '${mountPath}'`,
          "systemctl start docker",
          "systemctl is-active --quiet docker",
          "containers=$(docker ps --all --quiet)",
          'if [ -n "$containers" ]; then docker start $containers >/dev/null; fi',
          'test "$(docker ps --all --quiet | sort)" = "$(docker ps --quiet | sort)"',
          "printf 'authority-staging-recovered\\n'",
        ];
        await runSsmCommandWithExactSuccess({
          commands,
          instanceId,
          region,
          successMarker: "authority-staging-recovered\n",
          unprovenCode: "ssm_recovery_unproven",
        });
        return Object.freeze({
          dockerStarted: true,
          existingContainersStarted: true,
          volumeMounted: true,
        });
      },
    }),
  });
}

function parseCli(argv) {
  const [action, ...rest] = argv;
  if (!["slot-init", "up", "down", "status", "backup"].includes(action))
    refuse("usage");
  let inputPath;
  let execute = false;
  let initializeBlankDataVolume = false;
  let requireAuthority = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--execute" && !execute) {
      execute = true;
      continue;
    }
    if (flag === "--require-authority" && !requireAuthority) {
      requireAuthority = true;
      continue;
    }
    if (
      flag === "--initialize-blank-data-volume" &&
      !initializeBlankDataVolume
    ) {
      initializeBlankDataVolume = true;
      continue;
    }
    if (flag === "--input" && inputPath === undefined) {
      inputPath = rest[index + 1];
      index += 1;
      continue;
    }
    refuse("usage");
  }
  if (typeof inputPath !== "string" || inputPath.length === 0) refuse("usage");
  if (initializeBlankDataVolume && action !== "up")
    refuse("initialize_blank_data_volume_requires_up");
  if (requireAuthority && action !== "up")
    refuse("require_authority_requires_up");
  // This is a reviewed host-bootstrap intent. A plan does not probe the
  // descriptor, but must bind the same resume parameter that its execute will
  // require from CloudFormation.
  if (requireAuthority && initializeBlankDataVolume)
    refuse("require_authority_conflicts_with_blank_data_volume");
  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch {
    refuse("input_file_invalid");
  }
  return Object.freeze({
    action,
    execute,
    initializeBlankDataVolume,
    requireAuthority,
    input,
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const {
    action,
    execute,
    initializeBlankDataVolume,
    requireAuthority,
    input,
  } = parseCli(argv);
  const defaults = createAwsCliAdapters();
  return runAuthorityStaging(action, input, {
    ...defaults,
    ...dependencies,
    cloudFormation: dependencies.cloudFormation ?? defaults.cloudFormation,
    ec2: dependencies.ec2 ?? defaults.ec2,
    kms: dependencies.kms ?? defaults.kms,
    putSecretValue: dependencies.putSecretValue ?? defaults.putSecretValue,
    s3: dependencies.s3 ?? defaults.s3,
    sns: dependencies.sns ?? defaults.sns,
    ssm: dependencies.ssm ?? defaults.ssm,
    execute,
    initializeBlankDataVolume,
    requireAuthority,
  });
}

function controlledFailureCode(error) {
  return error instanceof LifecycleError ? error.code : "unexpected";
}

function isDynamicCloudflareReference(value) {
  return (
    typeof value === "string" &&
    /^\{\{resolve:secretsmanager:arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+:SecretString:[A-Za-z0-9_.-]+\}\}$/.test(
      value,
    )
  );
}

async function reexecWithAsmExecIfNeeded() {
  const action = process.argv[2];
  if (!new Set(["slot-init", "status"]).has(action)) return false;
  const token = process.env.ECHO_CLOUDFLARE_API_TOKEN;
  const slotInitPlan =
    action === "slot-init" && !process.argv.slice(3).includes("--execute");
  if (slotInitPlan) {
    if (
      typeof token === "string" &&
      token.length > 0 &&
      !isDynamicCloudflareReference(token)
    ) {
      throw new LifecycleError(
        "cloudflare_api_token_dynamic_reference_required",
      );
    }
    return false;
  }
  if (process.env.ECHO_AUTHORITY_STAGING_ASM_EXEC === "1") {
    if (typeof token !== "string" || token.length === 0)
      throw new LifecycleError("cloudflare_api_token_required");
    if (isDynamicCloudflareReference(token))
      throw new LifecycleError("cloudflare_api_token_resolution_failed");
    return false;
  }
  // Status must describe AWS first: several recovery states deliberately skip
  // Cloudflare. A healthy status reaches edgeInput, whose controlled sentinel
  // below triggers the same resolved re-exec only when the edge is required.
  if (action === "status") {
    if (
      typeof token === "string" &&
      token.length > 0 &&
      !isDynamicCloudflareReference(token)
    ) {
      throw new LifecycleError(
        "cloudflare_api_token_dynamic_reference_required",
      );
    }
    return false;
  }
  return reexecWithAsmExec();
}

async function reexecWithAsmExec() {
  const token = process.env.ECHO_CLOUDFLARE_API_TOKEN;
  if (!isDynamicCloudflareReference(token))
    throw new LifecycleError("cloudflare_api_token_dynamic_reference_required");
  const environment = {
    ...echoHostedAwsEnvironment({ preserveCloudflareToken: true }),
    ECHO_AUTHORITY_STAGING_ASM_EXEC: "1",
  };
  const child = spawn(
    "asm-exec",
    [
      "--",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { env: environment, stdio: "inherit" },
  );
  const code = await new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise(127));
    child.once("close", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  process.exitCode = code;
  return true;
}

async function runCli() {
  if (await reexecWithAsmExecIfNeeded()) {
    process.exitCode ??= 1;
    return;
  }
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (
      process.argv[2] === "status" &&
      process.env.ECHO_AUTHORITY_STAGING_ASM_EXEC !== "1" &&
      error instanceof LifecycleError &&
      error.code === "cloudflare_api_token_resolution_required"
    ) {
      if (await reexecWithAsmExec()) process.exitCode ??= 1;
      return;
    }
    if (error instanceof LifecycleError && error.receipt !== undefined) {
      process.stdout.write(`${JSON.stringify(error.receipt)}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCli();
  } catch (error) {
    // Error strings can contain provider responses. Keep the command's output
    // a controlled code so a connector or management token cannot leak.
    process.stderr.write(
      `authority staging lifecycle failed: ${controlledFailureCode(error)}\n`,
    );
    process.exitCode = 1;
  }
}
