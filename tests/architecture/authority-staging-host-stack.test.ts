import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTemplate,
  resource,
  type CloudFormationTemplate,
} from "../support/cloudformation-template.js";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-host-v1.template.json",
);

const template = () => readTemplate(TEMPLATE);

function userDataSub(
  stack: CloudFormationTemplate,
): readonly [string, Record<string, unknown>] {
  const data = resource(stack, "StagingHostLaunchTemplate").Properties!
    .LaunchTemplateData as Record<string, unknown>;
  return (
    data.UserData as {
      readonly "Fn::Base64": {
        readonly "Fn::Sub": readonly [string, Record<string, unknown>];
      };
    }
  )["Fn::Base64"]["Fn::Sub"];
}

describe("Authority staging host stack", () => {
  it("creates a persistent slot and makes only host lifecycle resources conditional", () => {
    const stack = template();

    for (const parameter of [
      "HostEnabled",
      "InitializeBlankDataVolume",
      "ResumeRetainedAuthority",
    ]) {
      expect(stack.Parameters[parameter], parameter).toMatchObject({
        Default: "false",
        AllowedValues: ["true", "false"],
      });
    }
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
    expect(
      stack.Rules.RetainedAuthorityResumeRequiresEnabledNonblankHost,
    ).toEqual({
      RuleCondition: {
        "Fn::Equals": [{ Ref: "ResumeRetainedAuthority" }, "true"],
      },
      Assertions: [
        {
          Assert: {
            "Fn::Equals": [{ Ref: "HostEnabled" }, "true"],
          },
          AssertDescription:
            "ResumeRetainedAuthority may be true only when HostEnabled is true",
        },
        {
          Assert: {
            "Fn::Equals": [{ Ref: "InitializeBlankDataVolume" }, "false"],
          },
          AssertDescription:
            "ResumeRetainedAuthority may be true only for a nonblank retained-volume restart",
        },
      ],
    });

    // The Guard policy pins the other unconditional and host-only resources.
    for (const logicalId of [
      "StagingPublicSubnet",
      "StagingHostSecurityGroup",
      "StagingHostLaunchTemplate",
    ]) {
      expect(resource(stack, logicalId).Condition).toBeUndefined();
    }
  });

  it("retains the encrypted state boundary, empty tunnel container, and private versioned setup bucket", () => {
    const stack = template();
    const dataVolume = resource(stack, "StagingDataVolume");
    const bucket = resource(stack, "StagingHostSetupBundle");
    const onboardingBucket = resource(stack, "StagingOnboardingTransferBucket");

    expect(dataVolume.Properties).toMatchObject({
      AvailabilityZone: { Ref: "AvailabilityZone" },
    });
    expect(JSON.stringify(dataVolume.Properties?.Tags)).toContain(
      "/srv/echo-authority-clean-v1/clean-data",
    );
    expect(onboardingBucket.Properties).toMatchObject({
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      },
      LifecycleConfiguration: {
        Rules: [
          expect.objectContaining({
            Id: "short-lived-onboarding-transfer-backstop",
            ExpirationInDays: 1,
          }),
        ],
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              KMSMasterKeyID: {
                "Fn::GetAtt": ["StagingOnboardingTransferKey", "Arn"],
              },
            },
          },
        ],
      },
    });
    expect(bucket.Properties).not.toHaveProperty("LifecycleConfiguration");
    expect(bucket.Properties).not.toHaveProperty("OwnershipControls");
  });

  it("uses an ARM64 launch template with IMDSv2 and a disposable encrypted root", () => {
    const stack = template();

    expect(stack.Parameters.StagingInstanceType).toMatchObject({
      Default: "t4g.small",
      AllowedValues: ["t4g.nano", "t4g.small", "t4g.medium"],
    });
    expect(resource(stack, "StagingHost").Properties).toMatchObject({
      LaunchTemplate: {
        LaunchTemplateId: { Ref: "StagingHostLaunchTemplate" },
      },
    });
  });

  it("limits the host role to SSM, one setup bundle version, its own secret, and one ECR repository", () => {
    const stack = template();
    const role = resource(stack, "StagingHostRole");
    const serialized = JSON.stringify(role.Properties);

    expect(serialized).not.toMatch(/ec2:|backup:|kms:\*|s3:\*/i);
  });

  it("creates a separate temporary exact-version onboarding grant without changing host user data", () => {
    const stack = template();
    const access = resource(stack, "StagingHostOnboardingInputAccess");
    const serialized = JSON.stringify(access.Properties);

    expect(stack.Conditions.OnboardingInputTransferCondition).toEqual({
      "Fn::And": [
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OnboardingInputObjectKey" }, ""] }] },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OnboardingInputObjectVersion" }, ""] }] },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "OnboardingInputAccessExpiresAt" }, ""] }] },
      ],
    });
    expect(access).toMatchObject({
      Type: "AWS::IAM::Policy",
      Condition: "OnboardingInputTransferCondition",
      Properties: {
        PolicyName: "read-exact-staging-onboarding-input",
        Roles: [{ Ref: "StagingHostRole" }],
      },
    });
    expect(serialized).not.toMatch(/s3:\*|kms:\*/i);
    expect(access.Properties?.PolicyDocument).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "s3:GetObjectVersion",
          Resource: {
            "Fn::Sub":
              "arn:${AWS::Partition}:s3:::${StagingOnboardingTransferBucket}/${OnboardingInputObjectKey}",
          },
          Condition: {
            StringEquals: {
              "s3:VersionId": { Ref: "OnboardingInputObjectVersion" },
            },
            DateLessThan: {
              "aws:CurrentTime": { Ref: "OnboardingInputAccessExpiresAt" },
            },
          },
        },
        {
          Effect: "Allow",
          Action: "kms:Decrypt",
          Resource: { "Fn::GetAtt": ["StagingOnboardingTransferKey", "Arn"] },
          Condition: {
            StringEquals: {
              "kms:ViaService": { "Fn::Sub": "s3.${AWS::Region}.amazonaws.com" },
              "kms:EncryptionContext:aws:s3:arn": {
                "Fn::Sub":
                  "arn:${AWS::Partition}:s3:::${StagingOnboardingTransferBucket}/${OnboardingInputObjectKey}",
              },
            },
            DateLessThan: {
              "aws:CurrentTime": { Ref: "OnboardingInputAccessExpiresAt" },
            },
          },
        },
      ],
    });
  });

  it("makes the onboarding courier bucket TLS-only and require the exact CMK without granting access", () => {
    const stack = template();
    const policy = resource(stack, "StagingOnboardingTransferBucketPolicy");
    const statements = (policy.Properties?.PolicyDocument as { Statement: readonly Record<string, unknown>[] }).Statement;

    // The Guard policy pins each Deny statement exactly, but not their count.
    expect(statements).toHaveLength(4);
  });

  it("signals only machine configuration, tunnel connection, and retained-state materialization after the data attachment", () => {
    const stack = template();
    const launchTemplate = resource(stack, "StagingHostLaunchTemplate");
    const userData = JSON.stringify(
      (launchTemplate.Properties!.LaunchTemplateData as Record<string, unknown>)
        .UserData,
    );

    for (const required of [
      "--region '${AWS::Region}'",
      "--version-id '${HostSetupObjectVersion}'",
      "--tunnel-secret-arn '${AuthorityTunnelTokenSecret}'",
      "--ecr-registry '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}'",
      "--data-volume-id '${StagingDataVolume}'",
      "expected_volume_serial=$(printf '%s' '${StagingDataVolume}' | tr -d '-')",
      "lsblk -dn -o SERIAL",
      "InitializeBlankDataVolumeArgument",
      "http://127.0.0.1:20241/ready",
      "tunnel_ready=true",
      "machine-tunnel-retained-state-ready",
      "bootstrap-stage-unavailable",
      "bootstrap_stage_file=/run/echo-authority-staging-bootstrap-stage",
      "staging bootstrap stage: %s",
      "machine configuration, tunnel connection, retained-state materialization, and applicable retained Authority resume are ready",
    ]) {
      expect(userData).toContain(required);
    }
    expect(userData).toContain("--initialize-blank-data-volume");
    expect(userData).toContain('"InitializeBlankDataVolumeCondition"');
    const substitutions = userDataSub(stack)[1];
    expect(substitutions.ResumeRetainedAuthority).toEqual({
      Ref: "ResumeRetainedAuthority",
    });
    expect(userData).toContain(
      "bootstrap-not-started|initial-apt-update|initial-apt-install|snapd-socket|snapd-ready|aws-cli-install|aws-cli-ready|setup-bundle-download|setup-bundle-verify|setup-bundle-extract|data-volume-discovery|machine-bootstrap|tunnel-token-install|tunnel-service|tunnel-ready|retained-state-materialization|retained-state-resume|ready-signal",
    );
    expect(userData.match(/--header 'Content-Type:'/g)).toHaveLength(2);
    expect(userData).not.toMatch(
      /github\.com|raw\.githubusercontent|secretstring/i,
    );
    expect(userData).not.toMatch(/terminal_green|authority-descriptor|https/i);
    expect(userData).not.toMatch(/retry [0-9]+ [0-9]+ apt-get/);
    expect(userData).not.toMatch(/retry [0-9]+ [0-9]+ systemctl/);
  });

  it("renders executable shell quoting and valid WaitCondition JSON", () => {
    const stack = template();
    const ready = resource(stack, "StagingReady");
    const userData = userDataSub(stack)[0];

    expect(userData).not.toContain('\\"');
    expect(() =>
      execFileSync("bash", ["-n"], { input: userData }),
    ).not.toThrow();
    const successPayload = userData.match(/--data-binary '([^']+)' "\$ready_handle"/);
    expect(successPayload).not.toBeNull();
    expect(JSON.parse(successPayload![1]!) as { readonly Status: string }).toMatchObject({
      Status: "SUCCESS",
    });
    const failureFunction = userData.match(/signal_failure\(\) \{([\s\S]*?)\n\}/);
    expect(failureFunction).not.toBeNull();
    expect(failureFunction![1]).toContain("safe_stage=$(safe_bootstrap_stage)");
    expect(failureFunction![1]).toContain('"Data":"%s"');
    expect(failureFunction![1]).toContain('"$safe_stage" "$safe_stage"');
    expect(failureFunction![1]).not.toMatch(
      /BASH_COMMAND|LINENO|printenv|env|journal|tail|secret|token|password/i,
    );
    const failureFormat = failureFunction![1].match(
      /printf '([^']+)' "\$safe_stage" "\$safe_stage"/,
    );
    expect(failureFormat).not.toBeNull();
    const renderedFailure = failureFormat![1]!
      .replace("%s", "machine-bootstrap")
      .replace("%s", "machine-bootstrap");
    expect(JSON.parse(renderedFailure)).toEqual({
      Status: "FAILURE",
      Reason: "staging bootstrap stage: machine-bootstrap",
      UniqueId: "staging-host",
      Data: "machine-bootstrap",
    });
    const stageWriter = userData.match(
      /set_bootstrap_stage\(\) \{([\s\S]*?)\n\}/,
    );
    expect(stageWriter).not.toBeNull();
    expect(stageWriter![1]).toContain('printf \'%s\\n\' "$stage" >"$bootstrap_stage_file"');
    expect(stageWriter![1]).not.toMatch(
      /BASH_COMMAND|LINENO|\$\?|error|log|journal|tail|secret|token|password/i,
    );
    expect(userData).toContain(
      'install -o root -g root -m 0600 /dev/null "$bootstrap_stage_file"',
    );
    const resumeAssignment = userData.indexOf(
      "resume_retained_authority='${ResumeRetainedAuthority}'",
    );
    const resumeExport = userData.indexOf(
      "export bootstrap_stage_file resume_retained_authority",
    );
    const bootstrapFunctionExport = userData.indexOf(
      "export -f allowed_bootstrap_stage set_bootstrap_stage retry download_setup_bundle bootstrap_main",
    );
    const bootstrapChild = userData.indexOf(
      "timeout --signal=TERM --kill-after=10 800 bash -Eeuo pipefail -c bootstrap_main",
    );
    expect(resumeAssignment).toBeGreaterThan(-1);
    expect(resumeExport).toBeGreaterThan(resumeAssignment);
    expect(bootstrapFunctionExport).toBeGreaterThan(resumeExport);
    expect(bootstrapChild).toBeGreaterThan(bootstrapFunctionExport);
    const deadline = userData.match(
      /timeout --signal=TERM --kill-after=10 ([0-9]+) bash -Eeuo pipefail -c bootstrap_main/,
    );
    expect(deadline).not.toBeNull();
    expect(Number(deadline![1]) + 10 + 3 * 15 + 2).toBeLessThan(
      Number(ready.Properties?.Timeout),
    );
    expect(userData.match(/--connect-timeout 5 --max-time 15/g)).toHaveLength(2);
    const successSignal = userData.lastIndexOf("signal_success\n");
    const disableErrTrap = userData.lastIndexOf("trap - ERR\n");
    const removeStageFile = userData.lastIndexOf(
      'rm -f -- "$bootstrap_stage_file"',
    );
    expect(successSignal).toBeLessThan(disableErrTrap);
    expect(disableErrTrap).toBeLessThan(removeStageFile);

    const bootstrapMain = userData.match(
      /bootstrap_main\(\) \{([\s\S]*?)\n\}/,
    );
    expect(bootstrapMain).not.toBeNull();
    const stagedOperations = [
      ["initial-apt-update", "apt-get update"],
      [
        "initial-apt-install",
        "apt-get install -y --no-install-recommends ca-certificates curl snapd",
      ],
      ["snapd-socket", "systemctl enable --now snapd.socket"],
      ["snapd-ready", "timeout 60 snap wait system seed.loaded"],
      ["aws-cli-install", "timeout 120 snap install aws-cli --classic"],
      ["aws-cli-ready", "/snap/bin/aws --version >/dev/null"],
      ["setup-bundle-download", "retry 6 10 download_setup_bundle"],
      ["setup-bundle-verify", "sha256sum -c -"],
      ["setup-bundle-extract", "tar --extract --gzip"],
      ["data-volume-discovery", "expected_volume_serial="],
      ["machine-bootstrap", '"$workdir/bootstrap-ubuntu-arm64.sh"'],
      [
        "tunnel-token-install",
        "/usr/local/sbin/install-echo-authority-tunnel-token",
      ],
      [
        "tunnel-service",
        "systemctl enable --now cloudflared-echo-authority.service",
      ],
      ["tunnel-ready", "[[ $tunnel_ready == true ]]"],
      [
        "retained-state-materialization",
        "/srv/echo-authority-clean-v1/restore-clean-v1-host.sh materialize",
      ],
      [
        "retained-state-resume",
        "/srv/echo-authority-clean-v1/restore-clean-v1-host.sh resume",
      ],
    ] as const;
    for (const [stage, operation] of stagedOperations) {
      const assignment = bootstrapMain![1]!.indexOf(
        `set_bootstrap_stage ${stage}`,
      );
      const operationIndex = bootstrapMain![1]!.indexOf(operation, assignment);
      const nextAssignment = bootstrapMain![1]!.indexOf(
        "\n  set_bootstrap_stage ",
        assignment + 1,
      );
      expect(assignment, stage).toBeGreaterThan(-1);
      expect(operationIndex, stage).toBeGreaterThan(assignment);
      if (nextAssignment !== -1) {
        expect(operationIndex, stage).toBeLessThan(nextAssignment);
      }
    }
    const materializeIndex = bootstrapMain![1]!.indexOf(
      "/srv/echo-authority-clean-v1/restore-clean-v1-host.sh materialize",
    );
    const resumeGuardIndex = bootstrapMain![1]!.indexOf(
      "if [[ $resume_retained_authority == true ]]; then",
    );
    const resumeIndex = bootstrapMain![1]!.indexOf(
      "/srv/echo-authority-clean-v1/restore-clean-v1-host.sh resume",
    );
    const readySignalIndex = bootstrapMain![1]!.indexOf(
      "set_bootstrap_stage ready-signal",
    );
    expect(materializeIndex).toBeLessThan(resumeGuardIndex);
    expect(resumeGuardIndex).toBeLessThan(resumeIndex);
    expect(resumeIndex).toBeLessThan(readySignalIndex);
    const downloadFunction = userData.match(
      /download_setup_bundle\(\) \{([\s\S]*?)\n\}/,
    );
    expect(downloadFunction).not.toBeNull();
    const removePartial = downloadFunction![1]!.indexOf(
      'rm -f -- "$setup_bundle_partial"',
    );
    const getExactObject = downloadFunction![1]!.indexOf(
      "timeout 20 /snap/bin/aws --cli-connect-timeout 5 --cli-read-timeout 15 s3api get-object",
    );
    expect(removePartial).toBeGreaterThan(-1);
    expect(getExactObject).toBeGreaterThan(removePartial);
    expect(userData).toContain('mkdir -p "$workdir"');
    expect(userData).toContain('setup_bundle_partial="$setup_bundle.partial"');
    expect(userData).toContain('mv "$setup_bundle_partial" "$setup_bundle"');
    expect(userData).toContain('grep -qx "$expected_volume_serial"');
  });

  it("exports only orchestrator identifiers and never a secret value", () => {
    const stack = template();
    expect(Object.keys(stack.Outputs).sort()).toEqual([
      "AuthorityTunnelTokenSecretArn",
      "HostSetupArtifactBucketName",
      "OnboardingTransferBucketName",
      "OnboardingTransferKeyArn",
      "StagingDataVolumeId",
      "StagingHostInstanceId",
      "StagingHostReady",
      "StagingHostRoleName",
    ]);
    const serialized = JSON.stringify(stack.Outputs);
    expect(serialized).not.toMatch(
      /secretstring|secretbinary|cloudflare.*value/i,
    );
    expect(stack.Outputs.StagingHostReady?.Description).toContain(
      "When ResumeRetainedAuthority is true, it additionally required the accepted retained Authority to reach terminal green before ready.",
    );
    expect(stack.Outputs.StagingHostReady?.Description).toContain(
      "It never attests public HTTPS or independent descriptor-pin acceptance.",
    );
  });
});
