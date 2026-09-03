import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-journey-explorer-v1.template.json",
);
const HANDLER = resolve(
  REPO,
  "deploy/organization-authority/staging-journey-explorer-handler-v1.cjs",
);
const STAGING_LOG_GROUP =
  "/echo-brain/authority/authority-staging.echobrain.org";

type Resource = {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DependsOn?: unknown;
  readonly DeletionPolicy?: unknown;
  readonly UpdateReplacePolicy?: unknown;
};

type Template = {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, Resource>;
  readonly Outputs: Record<string, Record<string, unknown>>;
};

function template(): Template {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as Template;
}

function resource(stack: Template, logicalId: string): Resource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}

describe("staging Journey Explorer backend stack", () => {
  it("has an exact four-resource inventory and only the fixed staging input", () => {
    const stack = template();
    expect(stack.Parameters).toEqual({
      StagingLogGroupName: {
        Type: "String",
        Default: STAGING_LOG_GROUP,
        AllowedValues: [STAGING_LOG_GROUP],
        ConstraintDescription:
          "must be the one owned Authority staging runtime log group",
      },
    });
    expect(Object.keys(stack.Resources)).toEqual([
      "JourneyExplorerFunctionLogGroup",
      "JourneyExplorerExecutionRole",
      "CustomWidgetJourneyExplorer",
      "JourneyExplorerOperatorInvokePolicy",
    ]);
    expect(Object.values(stack.Resources).map((item) => item.Type)).toEqual([
      "AWS::Logs::LogGroup",
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::IAM::ManagedPolicy",
    ]);

    const serialized = JSON.stringify(stack);
    expect(serialized).toContain(STAGING_LOG_GROUP);
    expect(serialized).not.toContain("authority-prod");
    expect(serialized).not.toMatch(
      /prod\.echobrain\.org|AWS::Lambda::Permission|AWS::Lambda::Url/i,
    );
    expect(serialized).not.toMatch(
      /AWS::ApiGateway|AWS::CloudFront|AWS::DynamoDB|AWS::S3::Bucket/,
    );
  });

  it("retains only bounded structured logs for the Explorer function", () => {
    const logGroup = resource(template(), "JourneyExplorerFunctionLogGroup");
    expect(logGroup).toMatchObject({
      Type: "AWS::Logs::LogGroup",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        LogGroupName: "/echo-brain/authority/staging-journey-explorer-v1",
        RetentionInDays: 14,
      },
    });
  });

  it("grants the execution role only exact-source query access, query cancellation, and own-log writes", () => {
    const role = resource(template(), "JourneyExplorerExecutionRole");
    expect(role.Properties?.AssumeRolePolicyDocument).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });
    const policies = role.Properties?.Policies as readonly {
      readonly PolicyDocument: {
        readonly Statement: readonly Record<string, unknown>[];
      };
    }[];
    expect(policies).toHaveLength(1);
    expect(policies[0]!.PolicyDocument.Statement).toEqual([
      {
        Sid: "WriteOwnStructuredLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${JourneyExplorerFunctionLogGroup}:*",
        },
      },
      {
        Sid: "QueryExactStagingJourneyLogGroup",
        Effect: "Allow",
        Action: ["logs:StartQuery", "logs:GetQueryResults"],
        Resource: {
          "Fn::Sub":
            "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${StagingLogGroupName}",
        },
      },
      {
        Sid: "CancelTimedOutLogsInsightsQuery",
        Effect: "Allow",
        Action: "logs:StopQuery",
        Resource: "*",
      },
    ]);
    const serialized = JSON.stringify(role);
    expect(serialized).not.toMatch(
      /logs:(?:Unmask|GetLogRecord|FilterLogEvents|DescribeLogGroups|PutQueryDefinition)/,
    );
    expect(serialized.match(/"Resource":"\*"/g)).toHaveLength(1);
  });

  it("deploys the exact reviewed source as one bounded, non-public custom-widget Lambda", () => {
    const stack = template();
    const fn = resource(stack, "CustomWidgetJourneyExplorer");
    expect(fn.DependsOn).toBeUndefined();
    expect(fn.Properties).toMatchObject({
      FunctionName: {
        "Fn::Sub": "customWidget-${AWS::StackName}-journey-explorer",
      },
      Description: "Staging-only read-only content-free journey query backend.",
      Runtime: "nodejs24.x",
      Handler: "index.handler",
      Architectures: ["arm64"],
      Role: { "Fn::GetAtt": ["JourneyExplorerExecutionRole", "Arn"] },
      MemorySize: 256,
      Timeout: 20,
      ReservedConcurrentExecutions: 2,
      LoggingConfig: {
        LogFormat: "JSON",
        ApplicationLogLevel: "INFO",
        SystemLogLevel: "WARN",
        LogGroup: { Ref: "JourneyExplorerFunctionLogGroup" },
      },
      Environment: {
        Variables: {
          STAGING_JOURNEY_LOG_GROUP_NAME_V1: { Ref: "StagingLogGroupName" },
          STAGING_JOURNEY_QUERY_TIMEOUT_MS_V1: "12000",
        },
      },
    });
    expect(fn.Properties).not.toHaveProperty("VpcConfig");
    expect(fn.Properties).not.toHaveProperty("Layers");
    const code = fn.Properties?.Code as Record<string, unknown>;
    expect(code).toEqual({ ZipFile: readFileSync(HANDLER, "utf8") });

    const syntax = spawnSync(process.execPath, ["--check", HANDLER], {
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(code.ZipFile).not.toContain("SOURCE");
    expect(code.ZipFile).not.toMatch(
      /event\.(?:query|queryId)|@message|GetLogRecord|FilterLogEvents/,
    );
  });

  it("creates only an exact invoke policy for later approved Identity Center assignment", () => {
    const stack = template();
    const policy = resource(stack, "JourneyExplorerOperatorInvokePolicy");
    expect(policy.Properties).toEqual({
      ManagedPolicyName: {
        "Fn::Sub": "${AWS::StackName}-journey-explorer-invoke",
      },
      Description:
        "Lets an approved same-account staging operator invoke only the Journey Explorer backend.",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "InvokeStagingJourneyExplorerOnly",
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: {
              "Fn::GetAtt": ["CustomWidgetJourneyExplorer", "Arn"],
            },
          },
        ],
      },
    });
    expect(policy.Properties).not.toHaveProperty("Roles");
    expect(policy.Properties).not.toHaveProperty("Users");
    expect(policy.Properties).not.toHaveProperty("Groups");
    expect(stack.Outputs.JourneyExplorerOperatorInvokePolicyArn).toMatchObject({
      Value: { Ref: "JourneyExplorerOperatorInvokePolicy" },
    });
  });
});
