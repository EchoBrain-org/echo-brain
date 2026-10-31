import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAwsCliAdapters,
  main,
  runAuthorityStaging,
} from "../../tools/authority-staging.mjs";
import type {
  ChangeSetPlan,
  ChangeSetRequest,
  LifecycleDependencies,
  StackStatus,
} from "../../tools/authority-staging.mjs";
import {
  readTemplate,
  resource,
  type CloudFormationResource,
} from "../support/cloudformation-template.js";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-data-backup-v1.template.json",
);
const GUARD_POLICY = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-data-backup-v1.guard",
);
const VALIDATOR = resolve(REPO, "tools/validate-authority-recovery-templates.mjs");
const readRepoFile = (path: string) => readFileSync(resolve(REPO, path), "utf8");
const TEMPLATE_SHA256 = createHash("sha256")
  .update(readFileSync(TEMPLATE))
  .digest("hex");

const ACCOUNT = "123456789012";
const VOLUME_ID = "vol-0123456789abcdef0";
const KEY_ARN = `arn:aws:kms:us-west-2:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555`;
const TOPIC_ARN = `arn:aws:sns:us-west-2:${ACCOUNT}:echo-authority-staging-observability-v1-authority-alerts`;
const SLOT_STACK = "echo-authority-staging-green";
const BACKUP_STACK = `${SLOT_STACK}-data-backup`;
const INPUT = Object.freeze({
  region: "us-west-2",
  operationId: "staging-data-backup-20261031",
  slotId: "staging-green-slot",
  stack: {
    name: SLOT_STACK,
    parameters: {
      OrgSlug: "green",
      AvailabilityZone: "us-west-2a",
      StagingAmiId: "ami-0d81b5e3fc6de11fe",
      AuthorityEcrRepositoryArn: `arn:aws:ecr:us-west-2:${ACCOUNT}:repository/echo-brain/authority`,
    },
  },
  edge: {
    accountId: "a".repeat(32),
    zoneId: "b".repeat(32),
    hostname: "staging.example.com",
  },
  backup: { alertTopicArn: TOPIC_ARN },
});
const BACKUP_LOGICAL_IDS = [
  "StagingDataBackupVault",
  "StagingDataBackupServiceRole",
  "StagingDataRestoreServiceRole",
  "StagingDataBackupPlan",
  "StagingDataVolumeSelection",
  "StagingDataBackupMissedAlarm",
] as const;
const EXPECTED_PARAMETERS = Object.freeze({
  DataVolumeId: VOLUME_ID,
  DataVolumeKmsKeyArn: KEY_ARN,
  AlertTopicArn: TOPIC_ARN,
  BackupScheduleExpression: "cron(0 9 ? * * *)",
  RecoveryPointRetentionDays: "35",
});

const template = () => readTemplate(TEMPLATE);
type VolumeFacts = Awaited<
  ReturnType<
    NonNullable<NonNullable<LifecycleDependencies["ec2"]>["describeVolume"]>
  >
>;
type KeyFacts = Awaited<
  ReturnType<NonNullable<LifecycleDependencies["kms"]>["describeKey"]>
>;

function inlinePolicyStatements(
  role: CloudFormationResource,
): Record<string, unknown>[] {
  const policies = role.Properties!.Policies as Record<string, unknown>[];
  expect(policies).toHaveLength(1);
  const document = policies[0]!.PolicyDocument as Record<string, unknown>;
  expect(document.Version).toBe("2012-10-17");
  return document.Statement as Record<string, unknown>[];
}

function actions(statements: readonly Record<string, unknown>[]): string[] {
  return statements
    .flatMap((statement) =>
      Array.isArray(statement.Action)
        ? (statement.Action as string[])
        : [statement.Action as string],
    )
    .sort();
}

describe("Authority staging data-backup stack", () => {
  it("selects exactly the slot's clean-data volume through a constrained parameter", () => {
    const stack = template();
    const body = resource(stack, "StagingDataVolumeSelection").Properties!
      .BackupSelection as Record<string, unknown>;

    expect(stack.Parameters.DataVolumeId).toMatchObject({
      Type: "AWS::EC2::Volume::Id",
    });
    expect(stack.Parameters.DataVolumeKmsKeyArn).toMatchObject({
      Type: "String",
      AllowedPattern:
        "^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$",
    });
    expect(body.SelectionName).toBe("authority-staging-clean-data-volume-only");
    expect(body.Resources).toEqual([
      {
        "Fn::Sub":
          "arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/${DataVolumeId}",
      },
    ]);
    expect(body).not.toHaveProperty("Conditions");
    expect(body).not.toHaveProperty("ListOfTags");
    expect(body).not.toHaveProperty("NotResources");
    expect(JSON.stringify(stack)).not.toMatch(/\bvol-[0-9a-f]{8,17}\b/);
  });

  it("retains its vault and uses the reviewed cadence and retention", () => {
    const stack = template();
    const vault = resource(stack, "StagingDataBackupVault");
    const rule = (
      (resource(stack, "StagingDataBackupPlan").Properties!.BackupPlan as Record<
        string,
        unknown
      >).BackupPlanRule as Record<string, unknown>[]
    )[0]!;

    expect(vault).toMatchObject({
      Type: "AWS::Backup::BackupVault",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { BackupVaultName: { Ref: "AWS::StackName" } },
    });
    expect(vault.Properties).not.toHaveProperty("EncryptionKeyArn");
    expect(vault.Properties).not.toHaveProperty("LockConfiguration");
    expect(stack.Parameters.BackupScheduleExpression).toMatchObject({
      Default: EXPECTED_PARAMETERS.BackupScheduleExpression,
      AllowedPattern: "^cron\\(.+\\)$",
    });
    expect(stack.Parameters.RecoveryPointRetentionDays).toMatchObject({
      Type: "Number",
      Default: Number(EXPECTED_PARAMETERS.RecoveryPointRetentionDays),
      MinValue: 1,
      MaxValue: 3650,
    });
    expect(rule).toEqual({
      RuleName: "authority-staging-clean-data",
      TargetBackupVault: { Ref: "StagingDataBackupVault" },
      ScheduleExpression: { Ref: "BackupScheduleExpression" },
      StartWindowMinutes: 60,
      CompletionWindowMinutes: 180,
      Lifecycle: { DeleteAfterDays: { Ref: "RecoveryPointRetentionDays" } },
      RecoveryPointTags: {
        Application: "echo-brain",
        Environment: "staging",
        Purpose: "authority-staging-data-backup",
      },
    });
    expect(Object.keys(stack.Parameters).sort()).toEqual(
      Object.keys(EXPECTED_PARAMETERS).sort(),
    );
  });

  it("separates EBS-only backup and restore roles bound to the verified key", () => {
    const stack = template();
    const backupRole = resource(stack, "StagingDataBackupServiceRole");
    const restoreRole = resource(stack, "StagingDataRestoreServiceRole");
    for (const role of [backupRole, restoreRole]) {
      expect(role.Properties).not.toHaveProperty("RoleName");
      expect(role.Properties).not.toHaveProperty("ManagedPolicyArns");
      expect(role.Properties).toMatchObject({
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "backup.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
      });
    }
    const backupStatements = inlinePolicyStatements(backupRole);
    const restoreStatements = inlinePolicyStatements(restoreRole);
    expect(actions(backupStatements)).toEqual(
      [
        "backup:CopyIntoBackupVault",
        "backup:DescribeBackupVault",
        "ec2:CopySnapshot",
        "ec2:CreateSnapshot",
        "ec2:CreateTags",
        "ec2:DeleteSnapshot",
        "ec2:DescribeSnapshots",
        "ec2:DescribeTags",
        "ec2:DescribeVolumes",
        "ec2:ModifySnapshotTier",
        "tag:GetResources",
      ].sort(),
    );
    expect(actions(restoreStatements)).toEqual(
      [
        "ec2:CreateVolume",
        "ec2:DeleteVolume",
        "ec2:DescribeSnapshots",
        "ec2:DescribeVolumes",
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext",
        "kms:ReEncryptFrom",
        "kms:ReEncryptTo",
      ].sort(),
    );
    expect(
      backupStatements.find(
        (statement) => statement.Sid === "CreateSnapshotsOnlyFromSelectedVolume",
      )!.Resource,
    ).toContainEqual({
      "Fn::Sub":
        "arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/${DataVolumeId}",
    });
    for (const statement of restoreStatements.filter((item) =>
      String(item.Action).includes("kms:"),
    ))
      expect(statement.Resource).toEqual({ Ref: "DataVolumeKmsKeyArn" });
    expect(
      JSON.stringify([
        backupRole.Properties!.Policies,
        restoreRole.Properties!.Policies,
      ]),
    ).not.toMatch(
      /AWSBackupServiceRolePolicy|dynamodb:|rds:|elasticfilesystem:|ssm:|ec2:RunInstances|ec2:TerminateInstances|iam:PassRole|backup:CopyFromBackupVault/,
    );
    expect(stack.Outputs.RestoreServiceRoleArn!.Description).toContain(
      "iam:PassRole",
    );
  });

  it("alarms on the existing staging alert topic after 30 hours without a completed backup", () => {
    const alarm = resource(template(), "StagingDataBackupMissedAlarm");
    expect(alarm.Properties).toEqual({
      AlarmDescription:
        "The Authority staging clean-data backup vault recorded no completed backup job in the last 30 hours.",
      AlarmActions: [{ Ref: "AlertTopicArn" }],
      OKActions: [{ Ref: "AlertTopicArn" }],
      Namespace: "AWS/Backup",
      MetricName: "NumberOfBackupJobsCompleted",
      Dimensions: [
        { Name: "BackupVaultName", Value: { Ref: "StagingDataBackupVault" } },
      ],
      Statistic: "Sum",
      Period: 3600,
      EvaluationPeriods: 30,
      DatapointsToAlarm: 30,
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
    });
  });

  it("holds exactly the reviewed inventory, with no secrets, under its committed Guard policy", () => {
    const stack = template();
    const serialized = JSON.stringify(stack);
    const guard = readFileSync(GUARD_POLICY, "utf8");

    expect(Object.keys(stack.Resources).sort()).toEqual(
      [...BACKUP_LOGICAL_IDS].sort(),
    );
    expect(serialized).not.toMatch(/get-secret-value|secretsmanager|asm-exec/i);
    expect(serialized).not.toMatch(/—/);
    expect(serialized).toContain(
      "not independently encrypted by the backup vault",
    );
    expect(guard).toContain("CloudFormation Guard 3.2.1");
    for (const rule of [
      "exact_resource_inventory",
      "retained_data_backup_vault",
      "exact_data_volume_selection",
      "exact_backup_and_restore_roles",
      "bounded_schedule_and_retention",
      "missed_backup_alarm",
    ])
      expect(guard).toContain(`rule ${rule}`);
    expect(guard).toContain("%resource_count == 6");
    expect(guard).toContain("LockConfiguration not exists");
    expect(readFileSync(VALIDATOR, "utf8")).toContain(
      '"authority-staging-data-backup-v1.guard"',
    );
  });
});

describe("staging data-backup recovery documents", () => {
  it("route the slot's clean-data volume to its own backup lane and rehearsal", () => {
    const runbook = readRepoFile(
      "docs/operations/RB-OPERATIONS-004-authority-staging-data-volume-backup.md",
    );
    const playbook = readRepoFile(
      "docs/operations/PB-OPERATIONS-001-authority-operator-lane.md",
    );
    const rootFloor = readRepoFile(
      "docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md",
    );
    const deployment = readRepoFile("deploy/organization-authority/README.md");

    expect(runbook).toContain("tested_at: null");
    expect(runbook).toContain("npm run authority:staging -- backup");
    expect(runbook).toContain("retention is not\na backup");
    expect(runbook).toContain("never from the input");
    expect(runbook).toContain("`alert_delivery_confirmed`");
    expect(runbook).toContain("sudo mount -o ro,noload,noexec,nodev,nosuid <restored-device>");
    expect(runbook).toContain("--clean-data <read-only-mount> \\");
    expect(runbook).toContain("`state/confluence-person-connections.sqlite`");
    expect(runbook).toContain("private-DNS `ssm` and\n  `ssmmessages` interface endpoints");
    expect(runbook).toContain("Coding agents do not start backup or restore jobs");
    expect(runbook).toContain("A verifier refusal leaves `tested_at: null`.");
    expect(playbook).toContain("| Back up the retained data volume | `authority:staging backup`");
    expect(playbook).toContain("Retention alone is not a backup.");
    expect(rootFloor).toContain("It does not reach the staging slot");
    expect(deployment).toContain("Retention alone is not a\n  backup.");
    expect(deployment).not.toContain(
      "Until the later retained-data-volume and replaceable-host programme",
    );
    expect(readRepoFile("README.md")).toContain("| `backup`    |");
    expect(readRepoFile("docs/operations/README.md")).toContain(
      "RB-OPERATIONS-004-authority-staging-data-volume-backup.md",
    );
    expect(readRepoFile("docs/components/operations-release.md")).toContain(
      "  - RB-OPERATIONS-004\n",
    );
  });
});

function slotStack(
  overrides: Partial<{
    terminationProtection: boolean;
    outputs: Record<string, string>;
  }> = {},
): StackStatus {
  return {
    exists: true,
    status: "UPDATE_COMPLETE",
    terminationProtection: overrides.terminationProtection ?? true,
    outputs: overrides.outputs ?? {
      AuthorityTunnelTokenSecretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:AuthorityTunnelTokenSecret-abc`,
      StagingDataVolumeId: VOLUME_ID,
      StagingHostInstanceId: "i-0123456789abcdef0",
      StagingHostReady: "true",
    },
  };
}

function cleanDataVolume(overrides: Record<string, unknown> = {}) {
  return {
    availabilityZone: "us-west-2a",
    encrypted: true,
    kmsKeyId: KEY_ARN,
    state: "in-use",
    tags: {
      "aws:cloudformation:logical-id": "StagingDataVolume",
      "aws:cloudformation:stack-name": SLOT_STACK,
      MountPath: "/srv/echo-authority-clean-v1/clean-data",
      Purpose: "authority-clean-data",
    },
    volumeId: VOLUME_ID,
    ...overrides,
  };
}

function sourceKey(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    arn: KEY_ARN,
    enabled: true,
    keyManager: "AWS",
    keyState: "Enabled",
    keyUsage: "ENCRYPT_DECRYPT",
    ...overrides,
  };
}

const EXISTING_BACKUP_STACK: StackStatus = {
  exists: true,
  outputs: {},
  status: "CREATE_COMPLETE",
  terminationProtection: true,
};

function fullInventory(action: "Add" | "Modify" = "Add") {
  return BACKUP_LOGICAL_IDS.map((logicalId) => ({
    action,
    logicalId,
    replacement: false as const,
    resourceType: "AWS::Backup::BackupVault",
  }));
}

function backupDependencies(
  options: {
    readonly slot?: StackStatus;
    readonly backupStack?: StackStatus;
    readonly volume?: Record<string, unknown>;
    readonly key?: Record<string, unknown>;
    readonly changeActions?: readonly Record<string, unknown>[];
    readonly matchesExpected?: boolean;
    readonly selectedVolumeArn?: string;
    readonly topic?: "confirmed" | "unsubscribed" | "unreadable" | "other";
  } = {},
) {
  const events: string[] = [];
  const requests: ChangeSetRequest[] = [];
  let backupStack: StackStatus = options.backupStack ?? { exists: false };
  const plan = (request: ChangeSetRequest): ChangeSetPlan => ({
    actions: (options.changeActions ??
      fullInventory()) as Extract<ChangeSetPlan, { kind: "change_set" }>["actions"],
    changeSetType: request.changeSetType,
    id: "change-set-backup-1",
    kind: "change_set",
    matchesExpected: options.matchesExpected ?? true,
    status: "CREATE_COMPLETE",
  });
  const dependencies: LifecycleDependencies = {
    cloudFormation: {
      describeStack: async ({ stackName }) => {
        events.push(`describe:${stackName}`);
        if (stackName === SLOT_STACK) return options.slot ?? slotStack();
        if (stackName === BACKUP_STACK) return backupStack;
        throw new Error(`unexpected stack ${stackName}`);
      },
      createChangeSet: async (request) => {
        events.push(`plan:${request.stackName}:${request.changeSetType}`);
        requests.push(request);
        if (!backupStack.exists)
          backupStack = {
            exists: true,
            outputs: {},
            status: "REVIEW_IN_PROGRESS",
            terminationProtection: false,
          };
        return plan(request);
      },
      describeChangeSet: async (request) => {
        events.push(`review:${request.stackName}:${request.changeSetType}`);
        requests.push(request);
        return plan(request);
      },
      executeChangeSet: async ({ stackName, changeSetType }) => {
        events.push(`execute:${stackName}:${changeSetType}`);
        backupStack = {
          exists: true,
          outputs: {
            SelectedDataVolumeArn:
              options.selectedVolumeArn ??
              `arn:aws:ec2:us-west-2:${ACCOUNT}:volume/${VOLUME_ID}`,
          },
          status:
            changeSetType === "CREATE" ? "CREATE_COMPLETE" : "UPDATE_COMPLETE",
          terminationProtection: backupStack.exists
            ? backupStack.terminationProtection
            : false,
        };
      },
      ensureTerminationProtection: async ({ stackName }) => {
        events.push(`protect:${stackName}`);
        if (stackName !== BACKUP_STACK)
          throw new Error("only the backup stack may be protected here");
        if (backupStack.exists)
          backupStack = { ...backupStack, terminationProtection: true };
      },
    },
    ec2: {
      describeImage: async () => {
        throw new Error("backup never inspects the host image");
      },
      describeVolume: async ({ volumeId }) => {
        events.push(`volume:${volumeId}`);
        return cleanDataVolume(options.volume) as VolumeFacts;
      },
    },
    sns: {
      describeTopic: async ({ topicArn }) => {
        events.push("topic");
        if (options.topic === "unreadable") throw new Error("access denied");
        return {
          subscriptionsConfirmed: options.topic === "unsubscribed" ? 0 : 1,
          topicArn:
            options.topic === "other" ? `${topicArn}-other` : topicArn,
        };
      },
    },
    kms: {
      describeKey: async ({ keyId }) => {
        events.push(`key:${keyId === KEY_ARN ? "source" : "other"}`);
        return sourceKey(options.key) as KeyFacts;
      },
    },
  };
  return { dependencies, events, requests };
}

describe("authority:staging backup", () => {
  it("plans a CREATE change set for the sibling stack from AWS-proven volume facts", async () => {
    const fake = backupDependencies();
    const receipt = await runAuthorityStaging(
      "backup",
      INPUT,
      fake.dependencies,
    );

    expect(fake.events).toEqual([
      `describe:${SLOT_STACK}`,
      `volume:${VOLUME_ID}`,
      "key:source",
      "topic",
      `describe:${BACKUP_STACK}`,
      `plan:${BACKUP_STACK}:CREATE`,
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      capabilities: ["CAPABILITY_IAM"],
      changeSetName: `echo-authority-backup-${INPUT.operationId}`,
      changeSetType: "CREATE",
      clientToken: INPUT.operationId,
      onStackFailure: "DO_NOTHING",
      parameterKeys: Object.keys(EXPECTED_PARAMETERS),
      parameters: EXPECTED_PARAMETERS,
      region: "us-west-2",
      stackName: BACKUP_STACK,
      templatePath: TEMPLATE,
      templateSha256: TEMPLATE_SHA256,
    });
    expect(receipt).toMatchObject({
      action: "backup",
      state: "planned",
      stack_name: SLOT_STACK,
      backup_stack_name: BACKUP_STACK,
      change_set_name: `echo-authority-backup-${INPUT.operationId}`,
      change_set_ready_for_review: true,
      no_changes: false,
      schedule_expression: "cron(0 9 ? * * *)",
      retention_days: 35,
      alert_delivery_confirmed: true,
      data_volume: {
        encrypted: true,
        key_enabled: true,
        key_manager: "AWS",
        same_account_key: true,
        slot_clean_data_volume: true,
      },
    });
    // Receipts are shared with reviewers: no account, volume or key identifier.
    expect(JSON.stringify(receipt)).not.toMatch(/vol-|arn:|123456789012/);
  });

  it("executes only the reviewed change set and protects the new stack before it holds anything", async () => {
    const fake = backupDependencies({
      backupStack: {
        exists: true,
        outputs: {},
        status: "REVIEW_IN_PROGRESS",
        terminationProtection: false,
      },
    });
    const receipt = await runAuthorityStaging("backup", INPUT, {
      ...fake.dependencies,
      execute: true,
    });

    expect(fake.events).toEqual([
      `describe:${SLOT_STACK}`,
      `volume:${VOLUME_ID}`,
      "key:source",
      "topic",
      `describe:${BACKUP_STACK}`,
      `review:${BACKUP_STACK}:CREATE`,
      `protect:${BACKUP_STACK}`,
      `execute:${BACKUP_STACK}:CREATE`,
      `describe:${BACKUP_STACK}`,
      `protect:${BACKUP_STACK}`,
      `describe:${BACKUP_STACK}`,
    ]);
    expect(fake.events.some((event) => event.startsWith("plan:"))).toBe(false);
    expect(receipt).toMatchObject({
      action: "backup",
      state: "executed",
      stack_status: "CREATE_COMPLETE",
      termination_protection: true,
    });
  });

  it.each([
    [
      "another stack's volume",
      {
        tags: {
          ...cleanDataVolume().tags,
          "aws:cloudformation:stack-name": "echo-authority-staging-blue",
        },
      },
      "data_volume_identity_mismatch",
    ],
    [
      "a non-data logical resource",
      {
        tags: {
          ...cleanDataVolume().tags,
          "aws:cloudformation:logical-id": "StagingHost",
        },
      },
      "data_volume_identity_mismatch",
    ],
    [
      "a volume without the clean-data purpose",
      { tags: { ...cleanDataVolume().tags, Purpose: "scratch" } },
      "data_volume_identity_mismatch",
    ],
    [
      "a volume for another mount",
      { tags: { ...cleanDataVolume().tags, MountPath: "/srv" } },
      "data_volume_identity_mismatch",
    ],
    [
      "a volume in another Availability Zone",
      { availabilityZone: "us-west-2b" },
      "data_volume_identity_mismatch",
    ],
    ["an errored volume", { state: "error" }, "data_volume_identity_mismatch"],
    ["a different volume", { volumeId: "vol-0fedcba9876543210" }, "data_volume_identity_mismatch"],
    ["an unencrypted volume", { encrypted: false }, "data_volume_not_encrypted"],
    ["a volume without a key", { kmsKeyId: undefined }, "data_volume_not_encrypted"],
    [
      "a key in another account",
      {
        kmsKeyId:
          "arn:aws:kms:us-west-2:210987654321:key/11111111-2222-3333-4444-555555555555",
      },
      "data_volume_key_foreign",
    ],
    [
      "a key in another Region",
      {
        kmsKeyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555`,
      },
      "data_volume_key_foreign",
    ],
  ])("refuses %s before any change set", async (_, volume, code) => {
    const fake = backupDependencies({ volume });
    await expect(
      runAuthorityStaging("backup", INPUT, fake.dependencies),
    ).rejects.toMatchObject({ code });
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ["a disabled key", { keyState: "Disabled", enabled: false }],
    ["a key pending deletion", { keyState: "PendingDeletion" }],
    ["an unknown key manager", { keyManager: "EXTERNAL_STORE" }],
    ["a signing key", { keyUsage: "SIGN_VERIFY" }],
    ["a key owned by another account", { accountId: "210987654321" }],
    ["a different key", { arn: `${KEY_ARN.slice(0, -1)}6` }],
  ])("refuses %s as the source-volume key", async (_, key) => {
    const fake = backupDependencies({ key });
    await expect(
      runAuthorityStaging("backup", INPUT, fake.dependencies),
    ).rejects.toMatchObject({ code: "data_volume_key_unusable" });
    expect(fake.requests).toEqual([]);
  });

  it("requires the backup input and an alert topic in the slot's account and Region", async () => {
    await expect(
      runAuthorityStaging(
        "backup",
        { ...INPUT, backup: undefined },
        backupDependencies().dependencies,
      ),
    ).rejects.toMatchObject({ code: "backup_input_required" });
    await expect(
      runAuthorityStaging(
        "backup",
        { ...INPUT, backup: { alertTopicArn: "not-an-arn" } },
        backupDependencies().dependencies,
      ),
    ).rejects.toMatchObject({ code: "backup_alert_topic_invalid" });
    await expect(
      runAuthorityStaging(
        "backup",
        { ...INPUT, backup: { alertTopicArn: TOPIC_ARN, extra: "x" } },
        backupDependencies().dependencies,
      ),
    ).rejects.toMatchObject({ code: "backup_property_not_allowed" });
    for (const alertTopicArn of [
      TOPIC_ARN.replace(ACCOUNT, "210987654321"),
      TOPIC_ARN.replace("us-west-2", "us-east-1"),
    ]) {
      const fake = backupDependencies();
      await expect(
        runAuthorityStaging(
          "backup",
          { ...INPUT, backup: { alertTopicArn } },
          fake.dependencies,
        ),
      ).rejects.toMatchObject({ code: "backup_alert_topic_foreign" });
      expect(fake.requests).toEqual([]);
    }
  });

  it("reports an alarm that would reach no one and refuses an unreadable topic", async () => {
    await expect(
      runAuthorityStaging(
        "backup",
        INPUT,
        backupDependencies({ topic: "unsubscribed" }).dependencies,
      ),
    ).resolves.toMatchObject({
      state: "planned",
      alert_delivery_confirmed: false,
    });
    for (const topic of ["unreadable", "other"] as const) {
      const fake = backupDependencies({ topic });
      await expect(
        runAuthorityStaging("backup", INPUT, fake.dependencies),
      ).rejects.toMatchObject({ code: "backup_alert_topic_unproven" });
      expect(fake.requests).toEqual([]);
    }
  });

  it("requires an initialized, termination-protected slot", async () => {
    await expect(
      runAuthorityStaging(
        "backup",
        INPUT,
        backupDependencies({ slot: { exists: false } }).dependencies,
      ),
    ).rejects.toMatchObject({ code: "slot_init_required" });
    await expect(
      runAuthorityStaging(
        "backup",
        INPUT,
        backupDependencies({ slot: slotStack({ terminationProtection: false }) })
          .dependencies,
      ),
    ).rejects.toMatchObject({ code: "slot_termination_protection_required" });
  });

  it("refuses a backup stack name that would exceed the vault-name limit", async () => {
    const fake = backupDependencies();
    await expect(
      runAuthorityStaging(
        "backup",
        {
          ...INPUT,
          stack: { ...INPUT.stack, name: `echo-authority-staging-${"x".repeat(20)}` },
        },
        fake.dependencies,
      ),
    ).rejects.toMatchObject({ code: "backup_stack_name_too_long" });
    expect(fake.events).toEqual([]);
  });

  it.each([
    ["a CREATE that omits a reviewed resource", undefined, fullInventory().slice(1)],
    [
      "a CREATE that adds an unreviewed resource",
      undefined,
      [
        ...fullInventory(),
        {
          action: "Add",
          logicalId: "ExtraTopic",
          replacement: false,
          resourceType: "AWS::SNS::Topic",
        },
      ],
    ],
    [
      "an UPDATE that removes the vault",
      EXISTING_BACKUP_STACK,
      [
        {
          action: "Remove",
          logicalId: "StagingDataBackupVault",
          replacement: false,
          resourceType: "AWS::Backup::BackupVault",
        },
      ],
    ],
    [
      "an UPDATE that modifies the selection",
      EXISTING_BACKUP_STACK,
      [
        {
          action: "Modify",
          logicalId: "StagingDataVolumeSelection",
          replacement: false,
          resourceType: "AWS::Backup::BackupSelection",
        },
      ],
    ],
    [
      "an UPDATE that may replace the plan",
      EXISTING_BACKUP_STACK,
      [
        {
          action: "Modify",
          logicalId: "StagingDataBackupPlan",
          replacement: "Conditional",
          resourceType: "AWS::Backup::BackupPlan",
        },
      ],
    ],
    [
      "an UPDATE that adds a resource",
      EXISTING_BACKUP_STACK,
      [fullInventory()[0]],
    ],
  ])("refuses %s", async (_, backupStack, changeActions) => {
    await expect(
      runAuthorityStaging(
        "backup",
        INPUT,
        backupDependencies({ backupStack, changeActions }).dependencies,
      ),
    ).rejects.toMatchObject({ code: "change_set_backup_boundary_violation" });
  });

  it("lets an existing stack retune only its plan and alarm in place", async () => {
    const fake = backupDependencies({
      backupStack: EXISTING_BACKUP_STACK,
      changeActions: [
        {
          action: "Modify",
          logicalId: "StagingDataBackupPlan",
          replacement: "False",
          resourceType: "AWS::Backup::BackupPlan",
        },
        {
          action: "Modify",
          logicalId: "StagingDataBackupMissedAlarm",
          replacement: false,
          resourceType: "AWS::CloudWatch::Alarm",
        },
      ],
    });
    await expect(
      runAuthorityStaging("backup", INPUT, fake.dependencies),
    ).resolves.toMatchObject({ state: "planned", change_set_ready_for_review: true });
    expect(fake.requests[0]).toMatchObject({ changeSetType: "UPDATE" });
    expect(fake.requests[0]).not.toHaveProperty("onStackFailure", "DO_NOTHING");
  });

  it("repairs a failed create by adding only the reviewed inventory", async () => {
    const fake = backupDependencies({
      backupStack: {
        exists: true,
        outputs: {},
        status: "CREATE_FAILED",
        terminationProtection: true,
      },
      changeActions: fullInventory().slice(3),
    });
    await expect(
      runAuthorityStaging("backup", INPUT, fake.dependencies),
    ).resolves.toMatchObject({ state: "planned" });
    expect(fake.requests[0]).toMatchObject({ changeSetType: "UPDATE" });
  });

  it("refuses to execute without a stored plan that still matches", async () => {
    await expect(
      runAuthorityStaging("backup", INPUT, {
        ...backupDependencies().dependencies,
        execute: true,
      }),
    ).rejects.toMatchObject({ code: "backup_plan_required" });
    const drifted = backupDependencies({
      backupStack: {
        exists: true,
        outputs: {},
        status: "REVIEW_IN_PROGRESS",
        terminationProtection: false,
      },
      matchesExpected: false,
    });
    await expect(
      runAuthorityStaging("backup", INPUT, {
        ...drifted.dependencies,
        execute: true,
      }),
    ).rejects.toMatchObject({ code: "change_set_not_reviewable" });
    expect(drifted.events.some((event) => event.startsWith("execute:"))).toBe(
      false,
    );
  });

  it("proves the executed stack selects exactly the verified volume", async () => {
    const fake = backupDependencies({
      backupStack: {
        exists: true,
        outputs: {},
        status: "REVIEW_IN_PROGRESS",
        terminationProtection: false,
      },
      selectedVolumeArn: `arn:aws:ec2:us-west-2:${ACCOUNT}:volume/vol-0fedcba9876543210`,
    });
    await expect(
      runAuthorityStaging("backup", INPUT, {
        ...fake.dependencies,
        execute: true,
      }),
    ).rejects.toMatchObject({ code: "backup_selection_unproven" });
  });

  it("accepts only --execute and --input on the command line", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-authority-staging-backup-"));
    try {
      const inputPath = join(root, "input.json");
      writeFileSync(inputPath, JSON.stringify(INPUT));
      for (const flag of ["--require-authority", "--initialize-blank-data-volume"])
        await expect(
          main(["backup", "--input", inputPath, flag], backupDependencies().dependencies),
        ).rejects.toMatchObject({
          code:
            flag === "--require-authority"
              ? "require_authority_requires_up"
              : "initialize_blank_data_volume_requires_up",
        });
      await expect(
        main(["backup", "--input", inputPath], backupDependencies().dependencies),
      ).resolves.toMatchObject({ action: "backup", state: "planned" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function withFakeAws(responses: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "echo-authority-staging-backup-aws-"));
  const log = join(root, "calls.log");
  writeFileSync(
    join(root, "aws"),
    `#!/bin/sh
set -eu
for argument in "$@"; do printf 'ARG=%s\\n' "$argument" >>"$FAKE_AWS_LOG"; done
printf 'END\\n' >>"$FAKE_AWS_LOG"
case " $* " in
  *" ec2 describe-volumes "*) printf '%s\\n' "$FAKE_AWS_VOLUME_RESPONSE" ;;
  *" kms describe-key "*) printf '%s\\n' "$FAKE_AWS_KEY_RESPONSE" ;;
  *" sns get-topic-attributes "*) printf '%s\\n' "$FAKE_AWS_TOPIC_RESPONSE" ;;
  *" cloudformation describe-change-set "*) printf '%s\\n' "$FAKE_AWS_DESCRIBE_RESPONSE" ;;
  *) printf '{}\\n' ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(join(root, "aws"), 0o700);
  const keys = [
    "FAKE_AWS_LOG",
    "FAKE_AWS_VOLUME_RESPONSE",
    "FAKE_AWS_KEY_RESPONSE",
    "FAKE_AWS_TOPIC_RESPONSE",
    "FAKE_AWS_DESCRIBE_RESPONSE",
    "PATH",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, responses, {
    FAKE_AWS_LOG: log,
    PATH: `${root}:${process.env.PATH ?? ""}`,
  });
  return {
    log,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { force: true, recursive: true });
    },
  };
}

describe("authority:staging backup AWS CLI adapters", () => {
  it("reads the clean-data volume and its key through bounded read-only calls", async () => {
    const fake = withFakeAws({
      FAKE_AWS_VOLUME_RESPONSE: JSON.stringify({
        Volumes: [
          {
            AvailabilityZone: "us-west-2a",
            Encrypted: true,
            KmsKeyId: KEY_ARN,
            State: "in-use",
            Tags: [
              { Key: "Purpose", Value: "authority-clean-data" },
              { Key: "MountPath", Value: "/srv/echo-authority-clean-v1/clean-data" },
            ],
            VolumeId: VOLUME_ID,
          },
        ],
      }),
      FAKE_AWS_KEY_RESPONSE: JSON.stringify({
        KeyMetadata: {
          AWSAccountId: ACCOUNT,
          Arn: KEY_ARN,
          Enabled: true,
          KeyManager: "AWS",
          KeyState: "Enabled",
          KeyUsage: "ENCRYPT_DECRYPT",
        },
      }),
    });
    try {
      const adapters = createAwsCliAdapters();
      await expect(
        adapters.ec2!.describeVolume!({ region: "us-west-2", volumeId: VOLUME_ID }),
      ).resolves.toEqual({
        availabilityZone: "us-west-2a",
        encrypted: true,
        kmsKeyId: KEY_ARN,
        state: "in-use",
        tags: {
          MountPath: "/srv/echo-authority-clean-v1/clean-data",
          Purpose: "authority-clean-data",
        },
        volumeId: VOLUME_ID,
      });
      await expect(
        adapters.kms!.describeKey({ region: "us-west-2", keyId: KEY_ARN }),
      ).resolves.toEqual(sourceKey());
      const calls = readFileSync(fake.log, "utf8");
      expect(calls).toContain(
        `ARG=ec2\nARG=describe-volumes\nARG=--region\nARG=us-west-2\nARG=--volume-ids\nARG=${VOLUME_ID}`,
      );
      expect(calls).toContain(
        `ARG=kms\nARG=describe-key\nARG=--region\nARG=us-west-2\nARG=--key-id\nARG=${KEY_ARN}`,
      );
      expect(calls).toContain("ARG=--profile\nARG=echo-prod");
    } finally {
      fake.restore();
    }
  });

  it("reads the alert topic's confirmed subscription count", async () => {
    for (const [attributes, expected] of [
      [{ TopicArn: TOPIC_ARN, SubscriptionsConfirmed: "0" }, 0],
      [{ TopicArn: TOPIC_ARN, SubscriptionsConfirmed: "2" }, 2],
    ] as const) {
      const fake = withFakeAws({
        FAKE_AWS_TOPIC_RESPONSE: JSON.stringify({ Attributes: attributes }),
      });
      try {
        await expect(
          createAwsCliAdapters().sns!.describeTopic({
            region: "us-west-2",
            topicArn: TOPIC_ARN,
          }),
        ).resolves.toEqual({ subscriptionsConfirmed: expected, topicArn: TOPIC_ARN });
        expect(readFileSync(fake.log, "utf8")).toContain(
          `ARG=sns\nARG=get-topic-attributes\nARG=--region\nARG=us-west-2\nARG=--topic-arn\nARG=${TOPIC_ARN}`,
        );
      } finally {
        fake.restore();
      }
    }
    for (const attributes of [
      {},
      { TopicArn: TOPIC_ARN },
      { TopicArn: TOPIC_ARN, SubscriptionsConfirmed: "-1" },
      { TopicArn: TOPIC_ARN, SubscriptionsConfirmed: 1 },
    ]) {
      const fake = withFakeAws({
        FAKE_AWS_TOPIC_RESPONSE: JSON.stringify({ Attributes: attributes }),
      });
      try {
        await expect(
          createAwsCliAdapters().sns!.describeTopic({
            region: "us-west-2",
            topicArn: TOPIC_ARN,
          }),
        ).rejects.toMatchObject({ code: "topic_response_invalid" });
      } finally {
        fake.restore();
      }
    }
  });

  it("refuses ambiguous or malformed volume and key responses", async () => {
    for (const [volume, key] of [
      [{ Volumes: [] }, { KeyMetadata: null }],
      [
        { Volumes: [{ VolumeId: VOLUME_ID }, { VolumeId: VOLUME_ID }] },
        { KeyMetadata: { Arn: KEY_ARN } },
      ],
      [
        { Volumes: [{ VolumeId: VOLUME_ID, AvailabilityZone: "us-west-2a", State: "in-use", Encrypted: "true" }] },
        { KeyMetadata: { Arn: KEY_ARN, AWSAccountId: ACCOUNT, KeyManager: "AWS", KeyState: "Enabled", Enabled: "yes", KeyUsage: "ENCRYPT_DECRYPT" } },
      ],
    ] as const) {
      const fake = withFakeAws({
        FAKE_AWS_VOLUME_RESPONSE: JSON.stringify(volume),
        FAKE_AWS_KEY_RESPONSE: JSON.stringify(key),
      });
      try {
        const adapters = createAwsCliAdapters();
        await expect(
          adapters.ec2!.describeVolume!({ region: "us-west-2", volumeId: VOLUME_ID }),
        ).rejects.toMatchObject({ code: "volume_response_invalid" });
        await expect(
          adapters.kms!.describeKey({ region: "us-west-2", keyId: KEY_ARN }),
        ).rejects.toMatchObject({ code: "key_response_invalid" });
      } finally {
        fake.restore();
      }
    }
  });

  it("matches a stored change set only against the complete backup parameter vector", async () => {
    const parameters = Object.entries(EXPECTED_PARAMETERS).map(
      ([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }),
    );
    const stored = {
      ChangeSetId: "arn:aws:cloudformation:us-west-2:123456789012:changeSet/x/1",
      Changes: [],
      Description: `echo-authority-staging-template-${TEMPLATE_SHA256}-CREATE`,
      OnStackFailure: "DO_NOTHING",
      Status: "CREATE_COMPLETE",
    };
    const request: ChangeSetRequest = {
      capabilities: ["CAPABILITY_IAM"],
      changeSetName: `echo-authority-backup-${INPUT.operationId}`,
      changeSetType: "CREATE",
      clientToken: INPUT.operationId,
      onStackFailure: "DO_NOTHING",
      parameterKeys: Object.keys(EXPECTED_PARAMETERS),
      parameters: EXPECTED_PARAMETERS,
      region: "us-west-2",
      stackName: BACKUP_STACK,
      templatePath: TEMPLATE,
      templateSha256: TEMPLATE_SHA256,
    };
    for (const [stack, matchesExpected] of [
      [{ ...stored, Parameters: parameters }, true],
      [{ ...stored, Parameters: parameters.slice(1) }, false],
      [
        {
          ...stored,
          Parameters: [
            ...parameters.slice(1),
            { ParameterKey: "DataVolumeId", ParameterValue: "vol-0fedcba9876543210" },
          ],
        },
        false,
      ],
      [
        {
          ...stored,
          Parameters: [
            ...parameters,
            { ParameterKey: "HostEnabled", ParameterValue: "false" },
          ],
        },
        false,
      ],
    ] as const) {
      const fake = withFakeAws({ FAKE_AWS_DESCRIBE_RESPONSE: JSON.stringify(stack) });
      try {
        await expect(
          createAwsCliAdapters().cloudFormation!.describeChangeSet(request),
        ).resolves.toMatchObject({ kind: "change_set", matchesExpected });
      } finally {
        fake.restore();
      }
    }
  });
});
