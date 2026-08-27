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
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installStagingEdgeToken,
  stagingEdgeStatus,
} from "./authority-staging-edge.mjs";

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const OPERATION_ID = /^staging-[a-z0-9][a-z0-9-]{7,63}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const S3_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,900}\.tar\.gz$/;
const S3_VERSION = /^[A-Za-z0-9._/+=-]{8,1024}$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
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
const ECHO_HOSTED_STAGING_AWS_PROFILE = "echo-prod";
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
const TEMPLATE_MAX_BYTES = 51200;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TEMPLATE_PATH = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.template.json",
);
const CLEAN_DATA_MOUNT = "/srv/echo-authority-clean-v1/clean-data";
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

function checkedTemplate() {
  const templatePath = DEFAULT_TEMPLATE_PATH;
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
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  });
}

/** Validate the non-secret, operator-controlled staging configuration. */
export function validateStagingLifecycleInput(value) {
  const raw = requiredObject(value, "input_invalid");
  onlyKeys(
    raw,
    new Set(["region", "operationId", "slotId", "stack", "edge", "hostSetup"]),
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
) {
  const parameters = {
    ...input.stack.parameters,
    HostEnabled: hostEnabled ? "true" : "false",
    InitializeBlankDataVolume:
      hostEnabled && initializeBlankDataVolume ? "true" : "false",
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
) {
  return Object.freeze({
    capabilities: Object.freeze(["CAPABILITY_IAM"]),
    changeSetName: changeSetName(input, action),
    changeSetType: type,
    clientToken: input.operationId,
    onStackFailure: type === "CREATE" ? "DO_NOTHING" : undefined,
    parameters: buildParameters(
      input,
      hostEnabled,
      setupArtifact,
      initializeBlankDataVolume,
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

async function describeExactStack(input, dependencies) {
  const describeStack = adapterFunction(dependencies, "describeStack");
  return outputMap(
    await describeStack({ region: input.region, stackName: input.stack.name }),
  );
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
) {
  const existing = await describeExactStack(input, dependencies);
  const createChangeSet = adapterFunction(dependencies, "createChangeSet");
  const planned = await createChangeSet(
    changeSetRequest(
      input,
      action,
      changeSetTypeFor(existing),
      hostEnabled,
      setupArtifact,
      initializeBlankDataVolume,
    ),
  );
  const plan = checkedChangeSet(planned);
  return Object.freeze({
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
  );
  const plan = assertChangeBoundary(
    checkedChangeSet(await describeChangeSet(expected)),
    action,
  );
  return Object.freeze({ existing, plan });
}

async function executePlannedStack(input, plan, dependencies) {
  if (!plan.executable) return describeExactStack(input, dependencies);
  const executeChangeSet = adapterFunction(dependencies, "executeChangeSet");
  try {
    await executeChangeSet({
      changeSetId: plan.id,
      changeSetType: plan.changeSetType,
      clientRequestToken: input.operationId,
      region: input.region,
      stackName: input.stack.name,
    });
  } catch (error) {
    if (error instanceof AwsCliError)
      throw new LifecycleError("change_set_execute_failed", error.safeEvents);
    refuse("change_set_execute_failed");
  }
  const current = await describeExactStack(input, dependencies);
  if (current === undefined) refuse("stack_missing_after_execute");
  if (current.updateRolledBack === true)
    refuse("change_set_execute_rolled_back");
  return current;
}

function publicPlan(plan, hostEnabled) {
  return Object.freeze({
    change_set_actions: plan.actions,
    change_set_created: plan.kind === "change_set",
    change_set_ready_for_review: plan.executable,
    host_setup_artifact:
      plan.artifact === undefined
        ? undefined
        : Object.freeze({ ...plan.artifact }),
    host_enabled: hostEnabled,
    no_changes: plan.kind === "no_changes",
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
      publicPlan(planned.plan, false),
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
    ...publicPlan(planned.plan, false),
    edge_ready: true,
    stack_status: protectedStack.status,
    termination_protection: true,
  });
}

async function runUp(
  input,
  { execute = false, initializeBlankDataVolume = false, ...dependencies } = {},
) {
  if (input.hostSetup === undefined) refuse("host_setup_required");
  const current = await initializedProtectedStack(input, dependencies);
  if (requiredOutput(current.outputs, "StagingHostReady") === "true")
    refuse("host_already_enabled");
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
      )
    : await planStack(
        input,
        "up",
        true,
        dependencies,
        setupArtifact,
        initializeBlankDataVolume,
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
  return lifecycleReceipt(input, "up", "executed", {
    ...publicPlan(planned.plan, true),
    initialize_blank_data_volume: initializeBlankDataVolume,
    stack_status: stack.status,
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
  const secretArn = requiredOutput(
    stack.outputs,
    "AuthorityTunnelTokenSecretArn",
  );
  const edge = edgeFunctions(dependencies);
  const status = await edge.status(
    edgeInput(input, secretArn, dependencies),
    edgeDependencies(dependencies),
  );
  return lifecycleReceipt(input, "status", safeEdgeState(status), {
    edge_checked: true,
    stack_status: stack.status,
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
  refuse("usage");
}

function echoHostedAwsEnvironment({ preserveCloudflareToken = false } = {}) {
  const environment = { ...process.env };
  for (const key of AMBIENT_AWS_CREDENTIAL_KEYS) delete environment[key];
  environment.AWS_PROFILE = ECHO_HOSTED_STAGING_AWS_PROFILE;
  environment.AWS_DEFAULT_PROFILE = ECHO_HOSTED_STAGING_AWS_PROFILE;
  if (!preserveCloudflareToken) delete environment.ECHO_CLOUDFLARE_API_TOKEN;
  return environment;
}

function awsJson(args, { stdin } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "aws",
      ["--no-cli-pager", "--profile", ECHO_HOSTED_STAGING_AWS_PROFILE, ...args],
      {
        env: echoHostedAwsEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => rejectPromise(new AwsCliError("unavailable")));
    child.once("close", (code) => {
      if (code !== 0) {
        const failure = new AwsCliError("failed");
        failure.privateDiagnostic = stderr;
        rejectPromise(failure);
        return;
      }
      try {
        resolvePromise(stdout === "" ? {} : JSON.parse(stdout));
      } catch {
        rejectPromise(new AwsCliError("response_invalid"));
      }
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

function cloudFormationParameters(parameters) {
  return Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
}

function changeSetDescription(templateSha256, changeSetType) {
  return `echo-authority-staging-template-${templateSha256}-${changeSetType}`;
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
    changeSetDescription(expected.templateSha256, expected.changeSetType)
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
  const actual = new Map(
    payload.Parameters.map((item) => [
      item?.ParameterKey,
      item?.ParameterValue,
    ]),
  );
  return Object.entries(expected.parameters).every(
    ([key, value]) => actual.get(key) === value,
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
        } catch {
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
        const calculated = createHash("sha256")
          .update(readFileSync(sourcePath))
          .digest("hex");
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
        const commands = [
          "set -eu",
          "containers=$(docker ps --quiet)",
          'if [ -n "$containers" ]; then docker stop $containers >/dev/null; fi',
          'test -z "$(docker ps --quiet)"',
          "systemctl stop docker",
          "! systemctl is-active --quiet docker",
          "sync",
          `mountpoint -q '${mountPath}'`,
          `umount '${mountPath}'`,
          `! mountpoint -q '${mountPath}'`,
          "printf 'authority-staging-quiesced\\n'",
        ];
        const sent = await awsJson([
          "ssm",
          "send-command",
          "--region",
          region,
          "--document-name",
          "AWS-RunShellScript",
          "--instance-ids",
          instanceId,
          "--parameters",
          JSON.stringify({ commands }),
          "--output",
          "json",
        ]);
        const commandId = sent.Command?.CommandId;
        if (typeof commandId !== "string" || commandId.length === 0)
          throw new AwsCliError("ssm_command_response_invalid");
        await awsJson([
          "ssm",
          "wait",
          "command-executed",
          "--region",
          region,
          "--command-id",
          commandId,
          "--instance-id",
          instanceId,
        ]);
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
          result.StandardOutputContent !== "authority-staging-quiesced\n"
        ) {
          throw new AwsCliError("ssm_quiesce_unproven");
        }
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
        const sent = await awsJson([
          "ssm",
          "send-command",
          "--region",
          region,
          "--document-name",
          "AWS-RunShellScript",
          "--instance-ids",
          instanceId,
          "--parameters",
          JSON.stringify({ commands }),
          "--output",
          "json",
        ]);
        const commandId = sent.Command?.CommandId;
        if (typeof commandId !== "string" || commandId.length === 0)
          throw new AwsCliError("ssm_command_response_invalid");
        await awsJson([
          "ssm",
          "wait",
          "command-executed",
          "--region",
          region,
          "--command-id",
          commandId,
          "--instance-id",
          instanceId,
        ]);
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
          result.StandardOutputContent !== "authority-staging-recovered\n"
        ) {
          throw new AwsCliError("ssm_recovery_unproven");
        }
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
  if (!["slot-init", "up", "down", "status"].includes(action)) refuse("usage");
  let inputPath;
  let execute = false;
  let initializeBlankDataVolume = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--execute" && !execute) {
      execute = true;
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
  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch {
    refuse("input_file_invalid");
  }
  return Object.freeze({ action, execute, initializeBlankDataVolume, input });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { action, execute, initializeBlankDataVolume, input } = parseCli(argv);
  const defaults = createAwsCliAdapters();
  return runAuthorityStaging(action, input, {
    ...defaults,
    ...dependencies,
    cloudFormation: dependencies.cloudFormation ?? defaults.cloudFormation,
    putSecretValue: dependencies.putSecretValue ?? defaults.putSecretValue,
    s3: dependencies.s3 ?? defaults.s3,
    ssm: dependencies.ssm ?? defaults.ssm,
    execute,
    initializeBlankDataVolume,
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
