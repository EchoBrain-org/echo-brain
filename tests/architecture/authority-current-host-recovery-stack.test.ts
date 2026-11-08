import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readTemplate, resource } from "../support/cloudformation-template.js";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-current-host-recovery-v1.template.json",
);
const VALIDATION_TOOLS = resolve(
  REPO,
  "deploy/organization-authority/authority-current-host-recovery-v1.validation-tools.json",
);

const template = () => readTemplate(TEMPLATE);

describe("Authority current-host recovery floor stack", () => {
  it("selects exactly one root EBS volume through a constrained parameter", () => {
    const stack = template();
    const parameters = stack.Parameters;

    expect(parameters.AuthorityRootVolumeId).toMatchObject({
      Type: "AWS::EC2::Volume::Id",
    });
    expect(parameters.AuthorityRootVolumeKmsKeyArn).toMatchObject({
      Type: "String",
      AllowedPattern:
        "^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$",
    });

    const serialized = JSON.stringify(stack);
    expect(serialized).not.toMatch(/\bvol-[0-9a-f]{8,17}\b/);
  });

  it("uses a retained vault and reviewable backup cadence and retention", () => {
    const stack = template();
    const vault = resource(stack, "CurrentHostRecoveryVault");
    const parameters = stack.Parameters;

    expect(vault.Properties).toMatchObject({
      BackupVaultName: {
        "Fn::Sub": "echo-authority-current-host-recovery-${AWS::AccountId}",
      },
    });
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
  });

  it("separates backup and restore roles and exposes their exact operator references", () => {
    const stack = template();
    const backupRole = resource(stack, "CurrentHostBackupServiceRole");
    const restoreRole = resource(stack, "CurrentHostRestoreServiceRole");

    // The Guard policy pins each role's trust statements and inline policies.
    for (const role of [backupRole, restoreRole]) {
      expect(role.Properties.AssumeRolePolicyDocument).toMatchObject({
        Version: "2012-10-17",
      });
    }
    const rolePolicies = JSON.stringify([
      backupRole.Properties!.Policies,
      restoreRole.Properties!.Policies,
    ]);
    expect(rolePolicies).not.toMatch(
      /AWSBackupServiceRolePolicy|dynamodb:|rds:|elasticfilesystem:|fsx:|eks:|ssm:|ec2:RunInstances|ec2:TerminateInstances|iam:PassRole|backup:CopyFromBackupVault/,
    );
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
  });

  it("does not claim vault encryption protects EBS", () => {
    const stack = template();
    const serialized = JSON.stringify(stack);

    expect(stack.Description).toContain(
      "this template cannot inspect either live resource",
    );
    expect(serialized).toContain(
      "not independently encrypted by the backup vault",
    );
  });
});
