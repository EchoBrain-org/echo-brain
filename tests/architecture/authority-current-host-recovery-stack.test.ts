import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-current-host-recovery-v1.template.json",
);
const GUARD_POLICY = resolve(
  REPO,
  "deploy/organization-authority/authority-current-host-recovery-v1.guard",
);
const VALIDATION_TOOLS = resolve(
  REPO,
  "deploy/organization-authority/authority-current-host-recovery-v1.validation-tools.json",
);
const RUNBOOK = resolve(
  REPO,
  "docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md",
);
const SPRINT = resolve(
  REPO,
  "docs/product/2026-08-25-operational-confidence-sprint-v1.md",
);

type CloudFormationResource = {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Properties?: Record<string, unknown>;
};

type CloudFormationTemplate = {
  readonly Description: string;
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, CloudFormationResource>;
  readonly Outputs: Record<string, Record<string, unknown>>;
};

function template(): CloudFormationTemplate {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as CloudFormationTemplate;
}

function resource(
  stack: CloudFormationTemplate,
  logicalId: string,
): CloudFormationResource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}

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

describe("Authority current-host recovery floor stack", () => {
  it("selects exactly one root EBS volume through a constrained parameter", () => {
    const stack = template();
    const selection = resource(stack, "CurrentAuthorityRootVolumeSelection");
    const parameters = stack.Parameters;
    const body = selection.Properties!.BackupSelection as Record<
      string,
      unknown
    >;

    expect(parameters.AuthorityRootVolumeId).toMatchObject({
      Type: "AWS::EC2::Volume::Id",
    });
    expect(parameters.AuthorityRootVolumeKmsKeyArn).toMatchObject({
      Type: "String",
      AllowedPattern:
        "^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$",
    });
    expect(body.SelectionName).toBe("current-authority-root-volume-only");
    expect(body.Resources).toEqual([
      {
        "Fn::Sub":
          "arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/${AuthorityRootVolumeId}",
      },
    ]);
    expect(body).not.toHaveProperty("Conditions");
    expect(body).not.toHaveProperty("ListOfTags");
    expect(body).not.toHaveProperty("NotResources");

    const serialized = JSON.stringify(stack);
    expect(serialized).not.toMatch(/\bvol-[0-9a-f]{8,17}\b/);
  });

  it("uses a retained vault and reviewable backup cadence and retention", () => {
    const stack = template();
    const vault = resource(stack, "CurrentHostRecoveryVault");
    const plan = resource(stack, "CurrentHostRecoveryPlan");
    const parameters = stack.Parameters;
    const rule = (
      (plan.Properties!.BackupPlan as Record<string, unknown>)
        .BackupPlanRule as Record<string, unknown>[]
    )[0]!;

    expect(vault).toMatchObject({
      Type: "AWS::Backup::BackupVault",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BackupVaultName: {
          "Fn::Sub": "echo-authority-current-host-recovery-${AWS::AccountId}",
        },
      },
    });
    expect(vault.Properties).not.toHaveProperty("EncryptionKeyArn");
    expect(parameters.BackupScheduleExpression).toMatchObject({
      Type: "String",
      Default: "cron(0 9 ? * * *)",
      AllowedPattern: "^cron\\(.+\\)$",
    });
    expect(parameters.RecoveryPointRetentionDays).toMatchObject({
      Type: "Number",
      Default: 35,
      MinValue: 1,
      MaxValue: 3650,
    });
    expect(parameters.StartWindowMinutes).toMatchObject({
      Type: "Number",
      Default: 60,
      MinValue: 60,
    });
    expect(parameters.CompletionWindowMinutes).toMatchObject({
      Type: "Number",
      Default: 180,
      MinValue: 1,
    });
    expect(rule).toMatchObject({
      RuleName: "current-authority-root-volume",
      TargetBackupVault: { Ref: "CurrentHostRecoveryVault" },
      ScheduleExpression: { Ref: "BackupScheduleExpression" },
      StartWindowMinutes: { Ref: "StartWindowMinutes" },
      CompletionWindowMinutes: { Ref: "CompletionWindowMinutes" },
      Lifecycle: {
        DeleteAfterDays: { Ref: "RecoveryPointRetentionDays" },
      },
    });
  });

  it("separates backup and restore roles and exposes their exact operator references", () => {
    const stack = template();
    const backupRole = resource(stack, "CurrentHostBackupServiceRole");
    const restoreRole = resource(stack, "CurrentHostRestoreServiceRole");
    const selection = resource(stack, "CurrentAuthorityRootVolumeSelection");
    const body = selection.Properties!.BackupSelection as Record<
      string,
      unknown
    >;

    expect(backupRole.Type).toBe("AWS::IAM::Role");
    expect(restoreRole.Type).toBe("AWS::IAM::Role");
    expect(backupRole.Properties).not.toHaveProperty("RoleName");
    expect(restoreRole.Properties).not.toHaveProperty("RoleName");
    expect(backupRole.Properties).not.toHaveProperty("ManagedPolicyArns");
    expect(restoreRole.Properties).not.toHaveProperty("ManagedPolicyArns");
    expect(backupRole.Properties).toMatchObject({
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "backup.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
    });
    expect(restoreRole.Properties).toMatchObject({
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "backup.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
    });

    const backupPolicies = backupRole.Properties!.Policies as Record<
      string,
      unknown
    >[];
    const restorePolicies = restoreRole.Properties!.Policies as Record<
      string,
      unknown
    >[];
    expect(backupPolicies[0]!.PolicyName).toBe(
      "current-authority-root-volume-ebs-backup-only",
    );
    expect(restorePolicies[0]!.PolicyName).toBe(
      "current-authority-root-volume-ebs-restore-only",
    );

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

    const createSnapshot = backupStatements.find(
      (statement) => statement.Sid === "CreateSnapshotsOnlyFromSelectedVolume",
    );
    expect(createSnapshot!.Resource).toEqual([
      {
        "Fn::Sub":
          "arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:volume/${AuthorityRootVolumeId}",
      },
      {
        "Fn::Sub": "arn:${AWS::Partition}:ec2:${AWS::Region}::snapshot/*",
      },
    ]);
    const restoreKms = restoreStatements.find(
      (statement) => statement.Sid === "UseOnlyTheSelectedEbsKeyThroughEc2",
    );
    expect(restoreKms).toMatchObject({
      Resource: { Ref: "AuthorityRootVolumeKmsKeyArn" },
      Condition: {
        StringEquals: {
          "kms:ViaService": {
            "Fn::Sub": "ec2.${AWS::Region}.${AWS::URLSuffix}",
          },
        },
      },
    });
    const restoreGrant = restoreStatements.find(
      (statement) => statement.Sid === "GrantOnlyForAwsEbsRestoreOfSelectedKey",
    );
    expect(restoreGrant).toMatchObject({
      Resource: { Ref: "AuthorityRootVolumeKmsKeyArn" },
      Condition: { Bool: { "kms:GrantIsForAWSResource": "true" } },
    });
    const rolePolicies = JSON.stringify([
      backupRole.Properties!.Policies,
      restoreRole.Properties!.Policies,
    ]);
    expect(rolePolicies).not.toMatch(
      /AWSBackupServiceRolePolicy|dynamodb:|rds:|elasticfilesystem:|fsx:|eks:|ssm:|ec2:RunInstances|ec2:TerminateInstances|iam:PassRole|backup:CopyFromBackupVault/,
    );
    expect(body.IamRoleArn).toEqual({
      "Fn::GetAtt": ["CurrentHostBackupServiceRole", "Arn"],
    });
    expect(Object.keys(stack.Outputs)).toEqual(
      expect.arrayContaining([
        "SelectedRootVolumeArn",
        "BackupVaultName",
        "BackupVaultArn",
        "BackupPlanId",
        "BackupPlanArn",
        "BackupSelectionId",
        "BackupServiceRoleArn",
        "RestoreServiceRoleArn",
      ]),
    );
    expect(stack.Outputs.RestoreServiceRoleArn!.Description).toContain(
      "iam:PassRole",
    );
    expect(stack.Description).toContain("iam:PassRole");
  });

  it("contains no secret inputs or broad resource-selection mechanism", () => {
    const stack = template();
    const serialized = JSON.stringify(stack);

    expect(Object.keys(stack.Parameters)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/secret|credential|token|password/i),
      ]),
    );
    expect(serialized).not.toMatch(/get-secret-value|secretsmanager|asm-exec/i);
    expect(serialized).not.toMatch(/\"Resources\":\s*\[\s*\"\*\"/);
  });

  it("checks the exact recovery shape with a committed CloudFormation Guard policy", () => {
    const guard = readFileSync(GUARD_POLICY, "utf8");
    const runbook = readFileSync(RUNBOOK, "utf8");
    const validationTools = JSON.parse(
      readFileSync(VALIDATION_TOOLS, "utf8"),
    ) as {
      cfn_lint: {
        package: string;
        version: string;
        python_version: string;
        source: string;
        wheel: { name: string; url: string; sha256: string };
        dependencies: {
          universal: { name: string; url: string; sha256: string }[];
          assets: Record<
            string,
            { name: string; url: string; sha256: string }[]
          >;
        };
      };
      cfn_guard: {
        version: string;
        source: string;
        assets: Record<string, { name: string; sha256: string }>;
      };
    };

    expect(guard).toContain("CloudFormation Guard 3.2.1");
    expect(guard).toContain("rule exact_resource_inventory");
    expect(guard).toContain("%resource_count == 5");
    expect(guard).toContain("rule retained_recovery_vault");
    expect(guard).toContain("DeletionPolicy == 'Retain'");
    expect(guard).toContain("UpdateReplacePolicy == 'Retain'");
    expect(guard).toContain("EncryptionKeyArn not exists");
    expect(guard).toContain("rule exact_root_volume_selection");
    expect(guard).toContain("Conditions not exists");
    expect(guard).toContain("ListOfTags not exists");
    expect(guard).toContain("NotResources not exists");
    expect(guard).toContain("rule exact_backup_and_restore_roles");
    expect(guard).toContain("ManagedPolicyArns not exists");
    expect(guard).toContain("current-authority-root-volume-ebs-backup-only");
    expect(guard).toContain("current-authority-root-volume-ebs-restore-only");
    expect(guard).toContain("AuthorityRootVolumeKmsKeyArn");
    expect(guard).toContain("rule bounded_schedule_and_retention");
    expect(guard).toContain('"Ref": "RecoveryPointRetentionDays"');
    expect(validationTools.cfn_lint).toMatchObject({
      package: "cfn-lint",
      version: "1.55.1",
      python_version: "3.10",
      source:
        "https://github.com/aws-cloudformation/cfn-lint/releases/tag/v1.55.1",
      wheel: {
        name: "cfn_lint-1.55.1-py3-none-any.whl",
        url: "https://files.pythonhosted.org/packages/46/10/c0e57bb3864b7670fe21730fab920d8cc6673d944db63108fdae3065659a/cfn_lint-1.55.1-py3-none-any.whl",
        sha256:
          "4de4ced80c898ce0753b64fc5707bebf011601eb2d027d95e2ab3f91692b99d8",
      },
    });
    expect(validationTools.cfn_lint.dependencies.universal).toHaveLength(6);
    expect(
      Object.keys(validationTools.cfn_lint.dependencies.assets).sort(),
    ).toEqual(["aarch64-macos", "x86_64-linux"]);
    for (const dependency of [
      ...validationTools.cfn_lint.dependencies.universal,
      ...Object.values(validationTools.cfn_lint.dependencies.assets).flat(),
    ]) {
      expect(dependency.name).toMatch(/\.whl$/);
      expect(dependency.url).toMatch(/^https:\/\/files\.pythonhosted\.org\//);
      expect(dependency.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(validationTools.cfn_guard.version).toBe("3.2.1");
    expect(validationTools.cfn_guard.source).toBe(
      "https://github.com/aws-cloudformation/cloudformation-guard/releases/tag/3.2.1",
    );
    expect(Object.keys(validationTools.cfn_guard.assets).sort()).toEqual([
      "aarch64-linux",
      "aarch64-macos",
      "x86_64-linux",
      "x86_64-macos",
    ]);
    for (const asset of Object.values(validationTools.cfn_guard.assets)) {
      expect(asset.name).toMatch(/^cfn-guard-v3-.+-latest\.tar\.gz$/);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(runbook).toContain("`cfn-lint` 1.55.1");
    expect(runbook).toContain("CloudFormation Guard 3.2.1");
    expect(runbook).toContain(
      "authority-current-host-recovery-v1.validation-tools.json",
    );
    expect(runbook).toContain("authority-current-host-recovery-v1.guard");
    expect(runbook).toContain(
      "npm run check:authority-recovery-infrastructure",
    );
    expect(runbook).toContain(
      "authority-recovery-helper-v1.template.json",
    );
    expect(runbook).toContain("aws cloudformation validate-template \\");
    expect(runbook).toContain("`REVIEW_IN_PROGRESS`");
    expect(runbook).toContain("EnableTerminationProtection=true");
    expect(runbook).toContain("do not authorize\nexecution");
  });

  it("requires a documented source-encryption evidence gate and does not claim vault encryption protects EBS", () => {
    const stack = template();
    const serialized = JSON.stringify(stack);
    const runbook = readFileSync(RUNBOOK, "utf8");

    expect(stack.Description).toContain(
      "this template cannot inspect either live resource",
    );
    expect(serialized).toContain(
      "not independently encrypted by the backup vault",
    );
    expect(serialized).not.toContain("BackupVaultEncryptionKeyArn");
    expect(runbook).not.toContain("OwnerId:OwnerId");
    expect(runbook).toContain("account-scoped `describe-volumes`");
  });

  it("keeps the restore drill constrained to the restored volume and a reviewed isolated helper", () => {
    const runbook = readFileSync(RUNBOOK, "utf8");
    const sprint = readFileSync(SPRINT, "utf8");

    expect(runbook).toContain("`RestoreServiceRoleArn`");
    expect(runbook).toContain("`iam:PassRole`");
    expect(runbook).toContain("`backup:GetRecoveryPointRestoreMetadata`");
    expect(runbook).toContain("`backup:StartRestoreJob`");
    expect(runbook).toContain("`backup:DescribeRestoreJob`");
    expect(runbook).toContain("EBS-only inline policies");
    expect(runbook).toContain("Availability Zone");
    expect(runbook).toContain("This is validation of the restored volume's");
    expect(runbook).toContain("not a check of the helper root volume");
    expect(runbook).toContain("`Encrypted` is exactly `true`");
    expect(runbook).toContain("approved Authority-account KMS boundary");
    expect(runbook).toContain("reviewed-IaC");
    expect(runbook).toContain("no NAT, internet-gateway, transit-gateway");
    expect(runbook).toContain("Secrets Manager, ECR, Cloudflare, the tunnel");
    expect(runbook).toContain("offline pre-attachment smoke test");
    expect(runbook).toContain(
      "node --check tools/verify-authority-recovery.mjs",
    );
    expect(runbook).toContain(
      "./node_modules/.bin/vitest run --config vitest.config.ts tests/architecture/authority-recovery-verifier.test.ts",
    );
    expect(runbook).toContain("no network request or download");
    expect(runbook).toContain("both\n  commands must exit `0`");
    expect(runbook).toContain("Node runtime, locked dependency");
    expect(runbook).toContain("workspace build output");
    expect(runbook).toContain("enable termination protection");
    expect(runbook).toContain("AWS Backup Vault Lock is deliberately deferred");
    expect(runbook).toContain("`BackupServiceRoleArn`");
    expect(runbook).toContain("`backup:StartBackupJob`");
    expect(runbook).toContain("`iam:PassedToService=backup.amazonaws.com`");
    expect(runbook).toContain("`Lifecycle.DeleteAfterDays`");
    expect(runbook).toContain("aws backup start-backup-job \\");
    expect(runbook).toContain(
      "--lifecycle DeleteAfterDays=<approved-retention-days>",
    );
    expect(runbook).toContain("aws backup describe-backup-job \\");
    expect(runbook).toContain("scheduled plan's\n`RecoveryPointRetentionDays`");
    expect(runbook).toContain("expiry cannot be verified, do not acknowledge");
    expect(runbook).toContain("wait until account-scoped `describe-volumes`");
    expect(runbook).toContain(
      "aws backup get-recovery-point-restore-metadata \\",
    );
    expect(runbook).toContain("aws backup start-restore-job \\");
    expect(runbook).toContain("--resource-type EBS \\");
    expect(runbook).toContain("aws backup describe-restore-job \\");
    expect(runbook).toContain("delete only\nthat restored drill volume");
    expect(runbook).toContain("no private entry names or\npaths");
    expect(sprint).toContain("distinct backup and restore service\n  roles");
    expect(sprint).toContain("termination protection");
    expect(sprint).toContain("AWS Backup Vault Lock\n  is explicitly deferred");
    expect(sprint).toContain("`backup:StartBackupJob`");
    expect(sprint).toContain("`iam:PassedToService=backup.amazonaws.com`");
    expect(sprint).toContain(
      "`Lifecycle.DeleteAfterDays` equal to the\n  scheduled plan's retention",
    );
    expect(sprint).toContain(
      "the restored\n  volume itself, not the helper root",
    );
    expect(sprint).toContain("entry names, or paths");
    expect(sprint).toContain("restored\n  drill volume");
  });
});
