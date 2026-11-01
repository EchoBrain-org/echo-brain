import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readTemplate, resource } from "../support/cloudformation-template.js";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/client-updates/staging-feed-s3-v1.template.json",
);

const template = () => readTemplate(TEMPLATE);

describe("CLI update S3-only staging-feed stack", () => {
  it("retains an encrypted versioned bucket with public ACLs disabled and no website or named bucket", () => {
    const stack = template();
    expect(Object.keys(stack.Resources).sort()).toEqual([
      "FeedBucket",
      "FeedBucketPolicy",
    ]);
    const bucket = resource(stack, "FeedBucket");
    expect(bucket).toEqual({
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: false,
        },
        VersioningConfiguration: { Status: "Enabled" },
      },
    });
    expect(Object.keys(stack.Outputs).sort()).toEqual([
      "BucketName",
      "FeedUrl",
    ]);
    expect(stack.Outputs).toMatchObject({
      BucketName: { Value: { Ref: "FeedBucket" } },
      FeedUrl: {
        Value: {
          "Fn::Sub": "https://${FeedBucket}.s3.${AWS::Region}.${AWS::URLSuffix}/feed.json",
        },
      },
    });
  });

  it("grants public HTTPS reads only for published objects, never listing or writing", () => {
    const stack = template();
    expect(resource(stack, "FeedBucketPolicy")).toEqual({
      Type: "AWS::S3::BucketPolicy",
      Properties: {
        Bucket: { Ref: "FeedBucket" },
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowPublicReadOfPublishedObjects",
              Effect: "Allow",
              Principal: "*",
              Action: "s3:GetObject",
              Resource: [
                { "Fn::Sub": "${FeedBucket.Arn}/feed.json" },
                { "Fn::Sub": "${FeedBucket.Arn}/artifacts/*" },
              ],
              Condition: { Bool: { "aws:SecureTransport": "true" } },
            },
            {
              Sid: "DenyInsecureTransport",
              Effect: "Deny",
              Principal: "*",
              Action: "s3:*",
              Resource: [
                { "Fn::GetAtt": ["FeedBucket", "Arn"] },
                { "Fn::Sub": "${FeedBucket.Arn}/*" },
              ],
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            },
          ],
        },
      },
    });
  });
});
