import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-observability-v1.template.json",
);

type CloudFormationResource = {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Properties?: Record<string, unknown>;
};

type CloudFormationTemplate = {
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

describe("Authority minimal observability stack", () => {
  it("declares a bounded, redirect-rejecting external descriptor check", () => {
    const stack = template();
    const check = resource(stack, "ExternalDescriptorCheck");
    const rule = resource(stack, "ExternalDescriptorSchedule");
    const permission = resource(stack, "AllowEventBridgeDescriptorCheckInvocation");
    const properties = check.Properties!;
    const code = (properties.Code as { ZipFile: string }).ZipFile;

    expect(stack.Parameters.AuthorityHost).toMatchObject({
      Type: "String",
    });
    expect(stack.Parameters.AuthorityHost.AllowedPattern).not.toContain("A-Z");
    expect(check.Type).toBe("AWS::Lambda::Function");
    expect(properties.Runtime).toBe("nodejs24.x");
    expect(properties.Timeout).toBeLessThanOrEqual(15);
    expect(properties.Environment).toEqual({
      Variables: {
        AUTHORITY_DESCRIPTOR_URL: {
          "Fn::Sub": "https://${AuthorityHost}/v1/authority-descriptor",
        },
      },
    });
    expect(code).toContain("node:https");
    expect(code).toContain("AbortController");
    expect(code).toMatch(/statusCode\s*>=\s*300/);
    expect(code).toContain("descriptor check failed");
    expect(code).not.toContain("console.");

    expect(rule.Type).toBe("AWS::Events::Rule");
    expect(rule.Properties).toMatchObject({
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
      Targets: [
        {
          Arn: { "Fn::GetAtt": ["ExternalDescriptorCheck", "Arn"] },
          Id: "ExternalDescriptorCheck",
        },
      ],
    });
    expect(permission.Type).toBe("AWS::Lambda::Permission");
    expect(permission.Properties).toMatchObject({
      Action: "lambda:InvokeFunction",
      FunctionName: { Ref: "ExternalDescriptorCheck" },
      Principal: "events.amazonaws.com",
      SourceArn: { "Fn::GetAtt": ["ExternalDescriptorSchedule", "Arn"] },
    });
  });

  it("delivers alarms to one encrypted email topic and retains short-lived logs", () => {
    const stack = template();
    const key = resource(stack, "AlertTopicKey");
    const topic = resource(stack, "AlertTopic");
    const topicPolicy = resource(stack, "AlertTopicPolicy");
    const subscription = resource(stack, "AlertEmailSubscription");
    const logGroups = Object.values(stack.Resources).filter(
      (value) => value.Type === "AWS::Logs::LogGroup",
    );

    expect(stack.Parameters.AlertEmail).toMatchObject({ Type: "String" });
    expect(key).toMatchObject({
      Type: "AWS::KMS::Key",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { EnableKeyRotation: true },
    });
    expect(JSON.stringify(key.Properties?.KeyPolicy)).toContain(
      "cloudwatch.amazonaws.com",
    );
    expect(JSON.stringify(key.Properties?.KeyPolicy)).toContain(
      "sns.amazonaws.com",
    );
    expect(topic).toMatchObject({
      Type: "AWS::SNS::Topic",
      Properties: { KmsMasterKeyId: { "Fn::GetAtt": ["AlertTopicKey", "Arn"] } },
    });
    expect(topicPolicy.Type).toBe("AWS::SNS::TopicPolicy");
    expect(JSON.stringify(topicPolicy.Properties)).toContain(
      "cloudwatch.amazonaws.com",
    );
    expect(JSON.stringify(topicPolicy.Properties)).not.toContain('"sns:*"');
    expect(subscription).toMatchObject({
      Type: "AWS::SNS::Subscription",
      Properties: { Endpoint: { Ref: "AlertEmail" }, Protocol: "email" },
    });
    expect(logGroups).toHaveLength(2);
    for (const logGroup of logGroups) {
      expect(logGroup.DeletionPolicy).toBe("Retain");
      expect(logGroup.UpdateReplacePolicy).toBe("Retain");
      expect(logGroup.Properties?.RetentionInDays).toBeLessThanOrEqual(14);
    }
  });

  it("alarms on external failure, missing schedule activity, and repeated runtime signals", () => {
    const stack = template();
    const failureFilter = resource(stack, "WorkerFailureMetricFilter");
    const readyFilter = resource(stack, "RuntimeReadyMetricFilter");
    const alarms = Object.entries(stack.Resources).filter(
      ([, value]) => value.Type === "AWS::CloudWatch::Alarm",
    );

    expect(failureFilter.Properties).toMatchObject({
      FilterPattern: '{ $.kind = "echo-clean-live-worker-failed-v1" }',
    });
    expect(readyFilter.Properties).toMatchObject({
      FilterPattern: '{ $.kind = "echo-clean-live-runtime-ready-v1" }',
    });
    expect(alarms).toHaveLength(4);
    for (const [, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions).toEqual([{ Ref: "AlertTopic" }]);
      expect(alarm.Properties?.OKActions).toEqual([{ Ref: "AlertTopic" }]);
    }
    expect(resource(stack, "ExternalDescriptorFailureAlarm").Properties).toMatchObject({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Threshold: 1,
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      TreatMissingData: "notBreaching",
    });
    expect(resource(stack, "ExternalDescriptorNoInvocationAlarm").Properties).toMatchObject({
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      TreatMissingData: "breaching",
    });
    for (const logicalId of [
      "RepeatedWorkerFailureAlarm",
      "RepeatedRuntimeReadyAlarm",
    ]) {
      expect(resource(stack, logicalId).Properties).toMatchObject({
        Period: 300,
        Statistic: "Sum",
        Threshold: 3,
        TreatMissingData: "notBreaching",
      });
    }
  });

  it("attaches narrowly scoped Docker log-write permissions to the supplied host role", () => {
    const stack = template();
    const policy = resource(stack, "AuthorityDockerLogWritePolicy");
    const statements = (
      policy.Properties!.PolicyDocument as { Statement: unknown[] }
    ).Statement;

    expect(stack.Parameters.AuthorityHostRoleName).toMatchObject({
      Type: "String",
    });
    expect(policy.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(policy.Properties?.Roles).toEqual([{ Ref: "AuthorityHostRoleName" }]);
    expect(statements).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: {
          "Fn::Sub": "${DockerRuntimeLogGroup.Arn}:*",
        },
      },
    ]);

    expect(resource(stack, "DockerRuntimeLogGroup").Properties).toMatchObject({
      LogGroupName: { "Fn::Sub": "/echo-brain/authority/${AuthorityHost}" },
    });

    const serialized = JSON.stringify(stack);
    expect(serialized).not.toMatch(
      /credential|secret|token|password|bearer|prompt|answer|note/i,
    );
    expect(Object.keys(stack.Outputs)).toEqual(
      expect.arrayContaining([
        "AlertTopicArn",
        "ExternalDescriptorCheckFunctionName",
        "ExternalDescriptorFailureAlarmName",
        "RepeatedWorkerFailureAlarmName",
        "DockerRuntimeLogGroupName",
      ]),
    );
  });
});
