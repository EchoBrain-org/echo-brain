import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.template.json",
);
const GUARD = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.guard",
);
const VALIDATOR = resolve(
  REPO,
  "tools/validate-authority-recovery-templates.mjs",
);

type CloudFormationResource = {
  readonly Type: string;
  readonly Condition?: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly DependsOn?: string | string[];
  readonly CreationPolicy?: Record<string, unknown>;
  readonly Properties?: Record<string, unknown>;
};

type CloudFormationTemplate = {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Conditions: Record<string, unknown>;
  readonly Rules: Record<string, unknown>;
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

describe("Authority staging host stack", () => {
  it("creates a persistent slot and makes only host lifecycle resources conditional", () => {
    const stack = template();

    expect(stack.Parameters.HostEnabled).toMatchObject({
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(stack.Parameters.InitializeBlankDataVolume).toMatchObject({
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(stack.Conditions.HostEnabledCondition).toEqual({
      "Fn::Equals": [{ Ref: "HostEnabled" }, "true"],
    });
    expect(stack.Rules.BootstrapArtifactRequiredWhenHostEnabled).toBeDefined();
    expect(stack.Rules.BlankInitializationRequiresHostEnabled).toEqual({
      RuleCondition: {
        "Fn::Equals": [{ Ref: "InitializeBlankDataVolume" }, "true"],
      },
      Assertions: [
        {
          Assert: {
            "Fn::Equals": [{ Ref: "HostEnabled" }, "true"],
          },
          AssertDescription:
            "InitializeBlankDataVolume may be true only on an explicitly reviewed host-creation change set",
        },
      ],
    });

    for (const logicalId of [
      "StagingVpc",
      "StagingPublicSubnet",
      "StagingHostSecurityGroup",
      "StagingHostSetupBundle",
      "AuthorityTunnelTokenSecret",
      "StagingHostRole",
      "StagingDataVolume",
      "StagingHostLaunchTemplate",
    ]) {
      expect(resource(stack, logicalId).Condition).toBeUndefined();
    }
    for (const logicalId of [
      "StagingReadyHandle",
      "StagingHost",
      "StagingDataVolumeAttachment",
      "StagingReady",
    ]) {
      expect(resource(stack, logicalId).Condition).toBe("HostEnabledCondition");
    }
  });

  it("creates a dedicated public VPC with zero host ingress and only required bootstrap and tunnel egress", () => {
    const stack = template();
    const subnet = resource(stack, "StagingPublicSubnet");
    const route = resource(stack, "StagingInternetRoute");
    const securityGroup = resource(stack, "StagingHostSecurityGroup");
    const httpsEgress = resource(stack, "StagingHostHttpsEgress");

    expect(resource(stack, "StagingVpc").Type).toBe("AWS::EC2::VPC");
    expect(resource(stack, "StagingInternetGateway").Type).toBe(
      "AWS::EC2::InternetGateway",
    );
    expect(subnet.Properties).toMatchObject({ MapPublicIpOnLaunch: true });
    expect(route.Properties).toEqual({
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: "StagingInternetGateway" },
      RouteTableId: { Ref: "StagingPublicRouteTable" },
    });
    expect(securityGroup.Properties).toMatchObject({
      SecurityGroupIngress: [],
      SecurityGroupEgress: [],
    });
    expect(httpsEgress.Properties).toEqual({
      GroupId: { "Fn::GetAtt": ["StagingHostSecurityGroup", "GroupId"] },
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443,
      CidrIp: "0.0.0.0/0",
      Description:
        "HTTPS for version-pinned bootstrap, registry, SSM, and tunnel control traffic",
    });
    expect(resource(stack, "StagingHostAptHttpEgress").Properties).toEqual({
      GroupId: { "Fn::GetAtt": ["StagingHostSecurityGroup", "GroupId"] },
      IpProtocol: "tcp",
      FromPort: 80,
      ToPort: 80,
      CidrIp: "0.0.0.0/0",
      Description: "HTTP for Ubuntu package mirrors during bootstrap",
    });
    for (const [logicalId, protocol, description] of [
      [
        "StagingHostCloudflaredTcpEgress",
        "tcp",
        "Cloudflare Tunnel TCP transport",
      ],
      [
        "StagingHostCloudflaredUdpEgress",
        "udp",
        "Cloudflare Tunnel QUIC transport",
      ],
    ]) {
      expect(resource(stack, logicalId).Properties).toEqual({
        GroupId: { "Fn::GetAtt": ["StagingHostSecurityGroup", "GroupId"] },
        IpProtocol: protocol,
        FromPort: 7844,
        ToPort: 7844,
        CidrIp: "0.0.0.0/0",
        Description: description,
      });
    }
  });

  it("retains the encrypted state boundary, empty tunnel container, and private versioned setup bucket", () => {
    const stack = template();
    const dataVolume = resource(stack, "StagingDataVolume");
    const secret = resource(stack, "AuthorityTunnelTokenSecret");
    const bucket = resource(stack, "StagingHostSetupBundle");

    for (const value of [dataVolume, secret, bucket]) {
      expect(value.DeletionPolicy).toBe("Retain");
      expect(value.UpdateReplacePolicy).toBe("Retain");
    }
    expect(dataVolume.Properties).toMatchObject({
      AvailabilityZone: { Ref: "AvailabilityZone" },
      Encrypted: true,
      VolumeType: "gp3",
    });
    expect(JSON.stringify(dataVolume.Properties?.Tags)).toContain(
      "/srv/echo-authority-clean-v1/clean-data",
    );
    expect(secret.Properties).not.toHaveProperty("SecretString");
    expect(secret.Properties).not.toHaveProperty("GenerateSecretString");
    expect(secret.Properties).not.toHaveProperty("Name");
    expect(bucket.Properties).toMatchObject({
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  it("uses an ARM64 launch template with IMDSv2 and a disposable encrypted root", () => {
    const stack = template();
    const launchTemplate = resource(stack, "StagingHostLaunchTemplate");
    const data = launchTemplate.Properties!.LaunchTemplateData as Record<
      string,
      unknown
    >;

    expect(stack.Parameters.StagingInstanceType).toMatchObject({
      Default: "t4g.small",
      AllowedValues: ["t4g.nano", "t4g.small", "t4g.medium"],
    });
    expect(data.ImageId).toEqual({ Ref: "StagingAmiId" });
    expect(data.MetadataOptions).toEqual({
      HttpTokens: "required",
      HttpEndpoint: "enabled",
      HttpPutResponseHopLimit: 2,
    });
    expect(data.BlockDeviceMappings).toEqual([
      {
        DeviceName: "/dev/xvda",
        Ebs: {
          DeleteOnTermination: true,
          Encrypted: true,
          VolumeSize: 30,
          VolumeType: "gp3",
        },
      },
    ]);
    expect(resource(stack, "StagingHost").Properties).toMatchObject({
      InstanceInitiatedShutdownBehavior: "terminate",
      LaunchTemplate: {
        LaunchTemplateId: { Ref: "StagingHostLaunchTemplate" },
      },
    });
  });

  it("limits the host role to SSM, one setup bundle version, its own secret, and one ECR repository", () => {
    const stack = template();
    const role = resource(stack, "StagingHostRole");
    const serialized = JSON.stringify(role.Properties);

    expect(role.Properties?.ManagedPolicyArns).toEqual([
      {
        "Fn::Sub":
          "arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
      },
    ]);
    expect(serialized).toContain("s3:GetObjectVersion");
    expect(serialized).toContain("s3:VersionId");
    expect(serialized).toContain("secretsmanager:GetSecretValue");
    expect(serialized).toContain("AuthorityTunnelTokenSecret");
    expect(serialized).toContain("ecr:GetAuthorizationToken");
    expect(serialized).toContain("ecr:BatchCheckLayerAvailability");
    expect(serialized).toContain("ecr:BatchGetImage");
    expect(serialized).toContain("ecr:GetDownloadUrlForLayer");
    expect(serialized).toContain("AuthorityEcrRepositoryArn");
    expect(serialized).not.toMatch(/ec2:|backup:|kms:\*|s3:\*/i);
  });

  it("signals only machine configuration, tunnel connection, and retained-state materialization after the data attachment", () => {
    const stack = template();
    const launchTemplate = resource(stack, "StagingHostLaunchTemplate");
    const userData = JSON.stringify(
      (launchTemplate.Properties!.LaunchTemplateData as Record<string, unknown>)
        .UserData,
    );
    const attachment = resource(stack, "StagingDataVolumeAttachment");
    const ready = resource(stack, "StagingReady");

    for (const parameter of [
      "HostSetupObjectKey",
      "HostSetupObjectVersion",
      "HostSetupSha256",
      "AuthorityEcrRepositoryArn",
    ]) {
      expect(stack.Parameters[parameter]).toBeDefined();
    }
    for (const required of [
      "apt-get install -y --no-install-recommends ca-certificates curl snapd",
      "snap install aws-cli --classic",
      "/snap/bin/aws s3api get-object",
      "--region '${AWS::Region}'",
      "--version-id '${HostSetupObjectVersion}'",
      "sha256sum -c -",
      "bootstrap-ubuntu-arm64.sh",
      "--region '${AWS::Region}'",
      "--tunnel-secret-arn '${AuthorityTunnelTokenSecret}'",
      "--ecr-registry '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}'",
      "--data-volume-id '${StagingDataVolume}'",
      "expected_volume_serial=$(printf '%s' '${StagingDataVolume}' | tr -d '-')",
      "lsblk -dn -o SERIAL",
      "InitializeBlankDataVolumeArgument",
      "/usr/local/sbin/install-echo-authority-tunnel-token",
      "systemctl enable --now cloudflared-echo-authority.service",
      "http://127.0.0.1:20241/ready",
      "tunnel_ready=true",
      "/srv/echo-authority-clean-v1/restore-clean-v1-host.sh materialize",
      "machine-tunnel-materialization-ready",
      "machine-tunnel-materialization-not-ready",
      "machine configuration, tunnel connection, and retained-state materialization are ready",
      "machine configuration, tunnel connection, or retained-state materialization failed",
      "--header 'Content-Type:'",
    ]) {
      expect(userData).toContain(required);
    }
    expect(userData).toContain("--initialize-blank-data-volume");
    expect(userData).toContain('"InitializeBlankDataVolumeCondition"');
    expect(userData).toContain("signal_failure");
    expect(userData.match(/--header 'Content-Type:'/g)).toHaveLength(2);
    expect(userData).not.toMatch(
      /github\.com|raw\.githubusercontent|secretstring/i,
    );
    expect(userData).not.toMatch(/terminal_green|authority-descriptor|https/i);
    expect(attachment.DeletionPolicy).toBeUndefined();
    expect(attachment.UpdateReplacePolicy).toBeUndefined();
    expect(attachment.Properties).toEqual({
      Device: "/dev/sdf",
      InstanceId: { Ref: "StagingHost" },
      VolumeId: { Ref: "StagingDataVolume" },
    });
    expect(ready.DependsOn).toBe("StagingDataVolumeAttachment");
    expect(ready.Properties).toEqual({
      Count: 1,
      Handle: { Ref: "StagingReadyHandle" },
      Timeout: "900",
    });
  });

  it("renders executable shell quoting and valid WaitCondition JSON", () => {
    const stack = template();
    const launchTemplate = resource(stack, "StagingHostLaunchTemplate");
    const userData = (
      (launchTemplate.Properties!.LaunchTemplateData as Record<string, unknown>)
        .UserData as {
        readonly "Fn::Base64": {
          readonly "Fn::Sub": readonly [string, Record<string, unknown>];
        };
      }
    )["Fn::Base64"]["Fn::Sub"][0];

    expect(userData).not.toContain('\\"');
    expect(() =>
      execFileSync("bash", ["-n"], { input: userData }),
    ).not.toThrow();
    const payloads = [
      ...userData.matchAll(/--data-binary '([^']+)' "\$ready_handle"/g),
    ].map((match) => JSON.parse(match[1]!) as { readonly Status: string });
    expect(payloads.map((payload) => payload.Status)).toEqual([
      "FAILURE",
      "SUCCESS",
    ]);
    expect(userData).toContain('mkdir -p "$workdir"');
    expect(userData).toContain('grep -qx "$expected_volume_serial"');
    expect(userData).toContain('"$workdir/bootstrap-ubuntu-arm64.sh"');
  });

  it("exports only orchestrator identifiers and never a secret value", () => {
    const stack = template();
    expect(Object.keys(stack.Outputs).sort()).toEqual([
      "AuthorityTunnelTokenSecretArn",
      "HostSetupArtifactBucketName",
      "StagingDataVolumeId",
      "StagingHostInstanceId",
      "StagingHostReady",
      "StagingHostRoleName",
    ]);
    const serialized = JSON.stringify(stack.Outputs);
    expect(serialized).not.toMatch(
      /secretstring|secretbinary|cloudflare.*value/i,
    );
  });

  it("locks the staging-slot shape with the committed Guard policy", () => {
    const guard = readFileSync(GUARD, "utf8");
    const validator = readFileSync(VALIDATOR, "utf8");
    expect(guard).toContain("CloudFormation Guard 3.2.1");
    expect(guard).toContain("%resource_count == 22");
    expect(guard).toContain("%host_resource_count == 4");
    for (const rule of [
      "exact_staging_slot_inventory",
      "host_toggle_leaves_the_slot_boundary_persistent",
      "network_has_no_ingress_and_required_bootstrap_and_tunnel_egress",
      "retained_state_and_trusted_delivery",
      "arm64_host_is_disposable_and_requires_imdsv2",
      "role_can_read_only_exact_bundle_and_own_secret",
      "readiness_waits_for_the_retained_volume",
      "wait_condition_curl_uses_empty_content_type",
    ]) {
      expect(guard).toContain(`rule ${rule}`);
    }
    expect(validator).toContain("authority-staging-host-v1.template.json");
    expect(validator).toContain("authority-staging-host-v1.guard");
  });
});
