import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/client-updates/staging-feed-v1.template.json",
);

type Resource = {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Properties?: Record<string, unknown>;
};

type Template = {
  readonly Resources: Record<string, Resource>;
  readonly Outputs: Record<string, { readonly Value: unknown }>;
};

function template(): Template {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as Template;
}

function resource(stack: Template, logicalId: string): Resource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}

describe("CLI update staging-feed stack", () => {
  it("keeps the feed private and exposes only HTTPS GET/HEAD through its exact CloudFront distribution", () => {
    const stack = template();
    const bucket = resource(stack, "FeedBucket");
    const originAccessControl = resource(stack, "FeedOriginAccessControl");
    const cachePolicy = resource(stack, "FeedCachePolicy");
    const distribution = resource(stack, "FeedDistribution");
    const bucketPolicy = resource(stack, "FeedBucketPolicy");

    expect(Object.keys(stack.Resources).sort()).toEqual([
      "FeedBucket",
      "FeedBucketPolicy",
      "FeedCachePolicy",
      "FeedDistribution",
      "FeedOriginAccessControl",
    ]);
    expect(bucket).toMatchObject({
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
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: "Enabled" },
      },
    });
    expect(originAccessControl).toMatchObject({
      Type: "AWS::CloudFront::OriginAccessControl",
      Properties: {
        OriginAccessControlConfig: {
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
    });

    const artifactCache = cachePolicy.Properties?.CachePolicyConfig as Record<
      string,
      unknown
    >;
    expect(artifactCache).toMatchObject({
      MinTTL: 31536000,
      DefaultTTL: 31536000,
      MaxTTL: 31536000,
      ParametersInCacheKeyAndForwardedToOrigin: {
        CookiesConfig: { CookieBehavior: "none" },
        HeadersConfig: { HeaderBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
        EnableAcceptEncodingBrotli: false,
        EnableAcceptEncodingGzip: false,
      },
    });

    const config = distribution.Properties?.DistributionConfig as Record<
      string,
      unknown
    >;
    expect(distribution.Type).toBe("AWS::CloudFront::Distribution");
    expect(config).toMatchObject({
      Enabled: true,
      ViewerCertificate: { CloudFrontDefaultCertificate: true },
    });
    expect(config).not.toHaveProperty("Aliases");
    expect(config).not.toHaveProperty("CNAMEs");
    const origin = (config.Origins as Array<Record<string, unknown>>)[0];
    expect(origin).toMatchObject({
      Id: "FeedBucketOrigin",
      OriginAccessControlId: {
        "Fn::GetAtt": ["FeedOriginAccessControl", "Id"],
      },
      S3OriginConfig: { OriginAccessIdentity: "" },
    });

    const feedBehavior = config.DefaultCacheBehavior as Record<string, unknown>;
    const artifactBehavior = (config.CacheBehaviors as Array<
      Record<string, unknown>
    >)[0];
    for (const behavior of [feedBehavior, artifactBehavior]) {
      expect(behavior).toMatchObject({
        AllowedMethods: ["GET", "HEAD"],
        CachedMethods: ["GET", "HEAD"],
        Compress: false,
        TargetOriginId: "FeedBucketOrigin",
        ViewerProtocolPolicy: "https-only",
      });
      expect(behavior).not.toHaveProperty("OriginRequestPolicyId");
      expect(behavior).not.toHaveProperty("ForwardedValues");
      expect(behavior).not.toHaveProperty("TrustedKeyGroups");
      expect(behavior).not.toHaveProperty("TrustedSigners");
    }
    expect(feedBehavior.CachePolicyId).toBe(
      "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    );
    expect(artifactBehavior).toMatchObject({
      PathPattern: "artifacts/*",
      CachePolicyId: { Ref: "FeedCachePolicy" },
    });

    const statements = (bucketPolicy.Properties?.PolicyDocument as Record<
      string,
      unknown
    >).Statement as Array<Record<string, unknown>>;
    const allowRead = statements.find(
      ({ Sid }) => Sid === "AllowOnlyThisDistributionToReadPublishedObjects",
    );
    expect(allowRead).toEqual({
      Sid: "AllowOnlyThisDistributionToReadPublishedObjects",
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: [
        { "Fn::Sub": "${FeedBucket.Arn}/feed.json" },
        { "Fn::Sub": "${FeedBucket.Arn}/artifacts/*" },
      ],
      Condition: {
        StringEquals: {
          "AWS:SourceArn": {
            "Fn::Sub": "arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${FeedDistribution}",
          },
        },
      },
    });
    expect(statements).toContainEqual({
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [
        { "Fn::GetAtt": ["FeedBucket", "Arn"] },
        { "Fn::Sub": "${FeedBucket.Arn}/*" },
      ],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    });
    expect(stack.Outputs).toMatchObject({
      BucketName: { Value: { Ref: "FeedBucket" } },
      DistributionId: { Value: { Ref: "FeedDistribution" } },
      FeedUrl: {
        Value: {
          "Fn::Sub": "https://${FeedDistribution.DomainName}/feed.json",
        },
      },
    });
  });
});
