import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AuthorityRecoveryHelperBundleManifest } from "../../tools/build-authority-recovery-helper-bundle.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-recovery-helper-v1.template.json",
);
const GUARD = resolve(
  REPO,
  "deploy/organization-authority/authority-recovery-helper-v1.guard",
);
const BUNDLE_BUILDER = resolve(
  REPO,
  "tools/build-authority-recovery-helper-bundle.mjs",
);
const BUNDLE_WORKFLOW = resolve(
  REPO,
  ".github/workflows/authority-recovery-helper-bundle.yml",
);
const RUNBOOK = resolve(
  REPO,
  "docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md",
);

type Resource = Readonly<{
  Type: string;
  Properties: Record<string, unknown>;
}>;

type Template = Readonly<{
  Parameters: Record<string, Record<string, unknown>>;
  Resources: Record<string, Resource>;
}>;

function template(): Template {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as Template;
}

function resource(stack: Template, logicalId: string): Resource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}

describe("Authority isolated recovery helper stack", () => {
  it("creates only the bounded disposable helper environment", () => {
    const stack = template();
    expect(Object.keys(stack.Resources).sort()).toEqual([
      "RecoveryBundleS3Endpoint",
      "RecoveryEndpointIngress",
      "RecoveryEndpointSecurityGroup",
      "RecoveryEndpointSelfEgress",
      "RecoveryHelper",
      "RecoveryHelperInstanceProfile",
      "RecoveryHelperRole",
      "RecoveryHelperRouteTable",
      "RecoveryHelperRouteTableAssociation",
      "RecoveryHelperS3Egress",
      "RecoveryHelperSecurityGroup",
      "RecoveryHelperSsmEgress",
      "RecoveryHelperSubnet",
      "RecoverySsmEndpoint",
      "RecoverySsmMessagesEndpoint",
    ]);
    expect(JSON.stringify(stack)).not.toMatch(
      /AWS::Backup|AWS::SecretsManager|AWS::ECR|cloudflared|docker/i,
    );
  });

  it("requires exact network and immutable-bundle inputs rather than discovering them", () => {
    const stack = template();
    for (const key of [
      "VpcId",
      "AvailabilityZone",
      "HelperSubnetCidr",
      "HelperAmiId",
      "BundleBucketName",
      "BundleObjectKey",
      "BundleObjectVersion",
      "BundleSha256",
      "BundleSourceCommit",
      "S3PrefixListId",
      "OperationId",
      "ExpiresAt",
    ]) {
      expect(stack.Parameters[key]).toBeDefined();
    }
    expect(stack.Parameters.BundleObjectVersion).toMatchObject({
      AllowedPattern: "^[A-Za-z0-9._/+=-]{8,1024}$",
    });
    expect(stack.Parameters.BundleSha256).toMatchObject({
      AllowedPattern: "^[0-9a-f]{64}$",
    });
  });

  it("has no public address, no ingress, and only endpoint-scoped HTTPS egress", () => {
    const stack = template();
    const helper = resource(stack, "RecoveryHelper");
    const securityGroup = resource(stack, "RecoveryHelperSecurityGroup");
    const endpointGroup = resource(stack, "RecoveryEndpointSecurityGroup");
    const endpointIngress = resource(stack, "RecoveryEndpointIngress");
    const endpointSelfEgress = resource(stack, "RecoveryEndpointSelfEgress");
    const ssmEgress = resource(stack, "RecoveryHelperSsmEgress");
    const s3Egress = resource(stack, "RecoveryHelperS3Egress");
    expect(helper.Properties.NetworkInterfaces).toEqual([
      {
        DeviceIndex: "0",
        SubnetId: { Ref: "RecoveryHelperSubnet" },
        GroupSet: [
          { "Fn::GetAtt": ["RecoveryHelperSecurityGroup", "GroupId"] },
        ],
        AssociatePublicIpAddress: false,
        DeleteOnTermination: true,
      },
    ]);
    expect(securityGroup.Properties.SecurityGroupIngress).toEqual([]);
    expect(securityGroup.Properties.SecurityGroupEgress).toEqual([]);
    expect(endpointGroup.Properties.SecurityGroupIngress).toEqual([]);
    expect(endpointGroup.Properties.SecurityGroupEgress).toEqual([]);
    expect(endpointIngress.Properties).toMatchObject({
      GroupId: { "Fn::GetAtt": ["RecoveryEndpointSecurityGroup", "GroupId"] },
      SourceSecurityGroupId: {
        "Fn::GetAtt": ["RecoveryHelperSecurityGroup", "GroupId"],
      },
      FromPort: 443,
      ToPort: 443,
    });
    expect(endpointSelfEgress.Properties).toEqual({
      GroupId: {
        "Fn::GetAtt": ["RecoveryEndpointSecurityGroup", "GroupId"],
      },
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443,
      DestinationSecurityGroupId: {
        "Fn::GetAtt": ["RecoveryEndpointSecurityGroup", "GroupId"],
      },
      Description: "Suppress default egress with endpoint-group HTTPS only",
    });
    expect(ssmEgress.Properties).toMatchObject({
      GroupId: { "Fn::GetAtt": ["RecoveryHelperSecurityGroup", "GroupId"] },
      DestinationSecurityGroupId: {
        "Fn::GetAtt": ["RecoveryEndpointSecurityGroup", "GroupId"],
      },
      FromPort: 443,
      ToPort: 443,
    });
    expect(s3Egress.Properties).toMatchObject({
      GroupId: { "Fn::GetAtt": ["RecoveryHelperSecurityGroup", "GroupId"] },
      DestinationPrefixListId: { Ref: "S3PrefixListId" },
      FromPort: 443,
      ToPort: 443,
    });
  });

  it("uses an isolated route table, only SSM endpoints, and one version-pinned S3 path", () => {
    const stack = template();
    const routeTable = resource(stack, "RecoveryHelperRouteTable");
    const ssm = resource(stack, "RecoverySsmEndpoint");
    const messages = resource(stack, "RecoverySsmMessagesEndpoint");
    const s3 = resource(stack, "RecoveryBundleS3Endpoint");
    expect(routeTable.Properties).not.toHaveProperty("Routes");
    expect(ssm.Properties).toMatchObject({
      VpcEndpointType: "Interface",
      ServiceName: { "Fn::Sub": "com.amazonaws.${AWS::Region}.ssm" },
      PrivateDnsEnabled: true,
    });
    expect(messages.Properties).toMatchObject({
      VpcEndpointType: "Interface",
      ServiceName: {
        "Fn::Sub": "com.amazonaws.${AWS::Region}.ssmmessages",
      },
      PrivateDnsEnabled: true,
    });
    expect(s3.Properties).toMatchObject({
      VpcEndpointType: "Gateway",
      ServiceName: { "Fn::Sub": "com.amazonaws.${AWS::Region}.s3" },
      RouteTableIds: [{ Ref: "RecoveryHelperRouteTable" }],
    });
    expect(JSON.stringify(s3.Properties.PolicyDocument)).toContain(
      "s3:GetObjectVersion",
    );
    expect(JSON.stringify(s3.Properties.PolicyDocument)).toContain(
      "s3:VersionId",
    );
    expect(s3.Properties.PolicyDocument).toMatchObject({
      Statement: [
        {
          Principal: "*",
          Action: "s3:GetObjectVersion",
          Condition: {
            StringEquals: {
              "aws:PrincipalArn": {
                "Fn::GetAtt": ["RecoveryHelperRole", "Arn"],
              },
              "s3:VersionId": { Ref: "BundleObjectVersion" },
            },
          },
        },
      ],
    });
  });

  it("uses ARM64 Graviton, IMDSv2, encrypted disposable root storage, and expiry tags", () => {
    const stack = template();
    const helper = resource(stack, "RecoveryHelper");
    expect(stack.Parameters.HelperInstanceType).toMatchObject({
      Default: "t4g.small",
      AllowedValues: ["t4g.nano", "t4g.small", "t4g.medium"],
    });
    expect(helper.Properties.MetadataOptions).toEqual({
      HttpTokens: "required",
      HttpEndpoint: "enabled",
      HttpPutResponseHopLimit: 1,
    });
    expect(helper.Properties.BlockDeviceMappings).toEqual([
      {
        DeviceName: "/dev/xvda",
        Ebs: {
          Encrypted: true,
          DeleteOnTermination: true,
          VolumeType: "gp3",
        },
      },
    ]);
    expect(helper.Properties.InstanceInitiatedShutdownBehavior).toBe(
      "terminate",
    );
    expect(JSON.stringify(stack.Resources)).toContain("OperationId");
    expect(JSON.stringify(stack.Resources)).toContain("ExpiresAt");
  });

  it("allows the helper role to use SSM and one immutable bundle only", () => {
    const stack = template();
    const role = resource(stack, "RecoveryHelperRole");
    expect(role.Properties.ManagedPolicyArns).toEqual([
      {
        "Fn::Sub":
          "arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
      },
    ]);
    const text = JSON.stringify(role.Properties);
    expect(text).toContain("s3:GetObjectVersion");
    expect(text).toContain("s3:VersionId");
    expect(text).not.toMatch(/backup:|ec2:|secretsmanager|ecr|cloudflare/i);
  });

  it("downloads, hashes, smoke-tests, and marks the offline bundle ready before attachment", () => {
    const stack = template();
    const userData = JSON.stringify(
      resource(stack, "RecoveryHelper").Properties.UserData,
    );
    for (const required of [
      "aws s3api get-object",
      "--version-id '${BundleObjectVersion}'",
      "sha256sum -c -",
      "python3 -c 'import sqlite3'",
      "recovery-helper-bundle.manifest.json",
      "BundleSourceCommit",
      "v22.22.1",
      "npm_shrinkwrap_sha256!==h",
      "id ec2-user",
      'install -d -o ec2-user -g ec2-user -m 0755 \\"$source/node_modules/.vite-temp\\"',
      "runuser -u ec2-user",
      "authority-recovery-verifier.test.ts",
      ".bundle-ready",
    ]) {
      expect(userData).toContain(required);
    }
    expect(userData).not.toMatch(
      /docker|compose|secretsmanager|ecr|cloudflared/i,
    );
    expect(stack.Parameters.BundleObjectVersion!.AllowedPattern).not.toContain(
      "'",
    );
    expect(stack.Parameters.BundleObjectVersion!.AllowedPattern).not.toContain(
      "\\",
    );
  });

  it("pins the bundle build itself to clean Linux ARM64 source and the verifier prerequisites", () => {
    expectTypeOf<AuthorityRecoveryHelperBundleManifest>()
      .toHaveProperty("npm_shrinkwrap_sha256").toBeString();
    const builder = readFileSync(BUNDLE_BUILDER, "utf8");
    for (const required of [
      'process.platform !== "linux"',
      'process.arch !== "arm64"',
      'NODE_VERSION = "v22.22.1"',
      '"--porcelain=v1"',
      'run("npm", ["run", "build:workspaces"]',
      '"npm-shrinkwrap.json"',
      "npm_shrinkwrap_sha256",
      "services/organization-authority/dist/composition/verify-authority-state-lineage.js",
      "authority-recovery-verifier.test.ts",
      "archive_sha256",
      "recovery-helper-bundle.manifest.json",
    ]) {
      expect(builder).toContain(required);
    }
  });

  it("builds and exercises the operator bundle on a native ARM64 runner", () => {
    const workflow = readFileSync(BUNDLE_WORKFLOW, "utf8");
    for (const required of [
      "workflow_dispatch:",
      "runs-on: ubuntu-24.04-arm",
      'PRODUCT_NODE_VERSION: "22.22.1"',
      "build-authority-recovery-helper-bundle.mjs",
      'test "$(uname -m)" = aarch64',
      "value.source_commit !== process.env.GITHUB_SHA",
      "value.npm_shrinkwrap_sha256",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "retention-days: 1",
    ]) {
      expect(workflow).toContain(required);
    }
    expect(workflow).not.toMatch(
      /aws-actions|configure-aws-credentials|s3 cp/i,
    );
  });

  it("keeps the runbook bound to the helper stack, the complete gp3 restore metadata, and no-replay inspection", () => {
    const runbook = readFileSync(RUNBOOK, "utf8");
    for (const required of [
      "authority-recovery-helper-v1.template.json",
      "authority-recovery-helper-v1.guard",
      "build-authority-recovery-helper-bundle.mjs",
      "iops",
      "throughput",
      "3.3.40.0",
      "cloud-init status --wait",
      "helper-stack-deleted",
      "aws cloudformation delete-stack",
      "/opt/echo-authority-recovery/runtime/node /opt/echo-authority-recovery/source/tools/verify-authority-recovery.mjs",
      "ro,noload",
      "secondary device",
    ]) {
      expect(runbook).toContain(required);
    }
  });

  it("locks the helper shape with the committed Guard policy", () => {
    const guard = readFileSync(GUARD, "utf8");
    expect(guard).toContain("let all_resources = Resources.*");
    expect(guard).toContain("let standalone_routes = Resources.*[");
    expect(guard).toContain("%resource_count == 15");
    expect(guard).toContain("%standalone_route_count == 0");
    for (const rule of [
      "exact_helper_inventory",
      "no_ingress_and_endpoint_only_egress",
      "helper_role_has_no_operational_or_secret_access",
      "arm64_non_public_immutable_helper",
      "bounded_bundle_bootstrap",
    ]) {
      expect(guard).toContain(`rule ${rule}`);
    }
  });
});
