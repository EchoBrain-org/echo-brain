import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeClientUpdateStaging, planClientUpdateStaging, statusClientUpdateStaging } from '../../tools/client-update-staging.mjs';

const temporary: string[] = [];
const COMMIT = 'a'.repeat(40);
const UUID = '11111111-1111-4111-8111-111111111111';
const CHANGE_SET = `arn:aws:cloudformation:us-west-2:904560150024:changeSet/echo-client-update-staging-${UUID}/${UUID}`;
const STACK_ID = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-client-update-staging-v1/22222222-2222-4222-8222-222222222222';
const S3_CHANGE_SET = `arn:aws:cloudformation:us-west-2:904560150024:changeSet/echo-client-update-staging-s3-${UUID}/${UUID}`;
const S3_STACK_ID = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-client-update-staging-s3-v1/22222222-2222-4222-8222-222222222222';
const S3_FEED_URL = 'https://echo-feed-staging-123.s3.us-west-2.amazonaws.com/feed.json';
const TEMPLATE = Buffer.from('{"AWSTemplateFormatVersion":"2010-09-09","Resources":{}}\n');
const expected = [
  ['FeedBucket', 'AWS::S3::Bucket'],
  ['FeedBucketPolicy', 'AWS::S3::BucketPolicy'],
  ['FeedDistribution', 'AWS::CloudFront::Distribution'],
  ['FeedOriginAccessControl', 'AWS::CloudFront::OriginAccessControl'],
  ['FeedCachePolicy', 'AWS::CloudFront::CachePolicy'],
];

function fixture(hosting: 'cloudfront' | 's3' = 'cloudfront') {
  const directory = mkdtempSync(join(tmpdir(), 'echo-client-update-staging-'));
  chmodSync(directory, 0o700);
  temporary.push(directory);
  const receipt = join(directory, 'operation.json');
  const calls: string[][] = [];
  const state = { complete: false, executes: 0, stackExists: false, changeSetExists: false, changeSetReady: true, creates: 0 };
  const stackId = hosting === 's3' ? S3_STACK_ID : STACK_ID;
  const changeSet = hosting === 's3' ? S3_CHANGE_SET : CHANGE_SET;
  const stackName = hosting === 's3' ? 'echo-client-update-staging-s3-v1' : 'echo-client-update-staging-v1';
  const aws: (args: string[]) => any = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'sts') return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
    if (args[0] === 's3control' && args[1] === 'get-public-access-block') return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } };
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
      if (!state.stackExists) return { Stacks: [] };
      return { Stacks: [{ StackId: stackId, StackStatus: state.complete ? 'CREATE_COMPLETE' : 'CREATE_IN_PROGRESS', Outputs: state.complete ? [
        { OutputKey: 'BucketName', OutputValue: 'echo-feed-staging-123' },
        ...(hosting === 's3' ? [] : [{ OutputKey: 'DistributionId', OutputValue: 'D123456789ABC' }]),
        { OutputKey: 'FeedUrl', OutputValue: hosting === 's3' ? S3_FEED_URL : 'https://d111111abcdef8.cloudfront.net/feed.json' },
      ] : [] }] };
    }
    if (args[0] === 'cloudformation' && args[1] === 'describe-change-set') return !state.changeSetExists ? { Status: 'NOT_FOUND' } : !state.changeSetReady ? { Status: 'CREATE_IN_PROGRESS' } : { ChangeSetId: changeSet, StackId: stackId, StackName: stackName, Status: 'CREATE_COMPLETE', Changes: (hosting === 's3' ? expected.slice(0, 2) : expected).map(([LogicalResourceId, ResourceType]) => ({ ResourceChange: { LogicalResourceId, ResourceType, Action: 'Add' } })) };
    if (args[0] === 'cloudformation' && args[1] === 'get-template') return { TemplateBody: TEMPLATE.toString('utf8') };
    if (args[0] === 'cloudformation' && args[1] === 'describe-events') return { OperationEvents: [] };
    throw new Error(`unexpected aws ${args.join(' ')}`);
  };
  const awsNoOutput = (args: string[]) => {
    calls.push(args);
    if (args[0] !== 'cloudformation') throw new Error('non-cloudformation mutation');
    if (args[1] === 'create-change-set') { state.changeSetExists = true; state.creates += 1; }
    if (args[1] === 'execute-change-set') { state.executes += 1; state.stackExists = true; }
  };
  const dependencies = { aws, awsNoOutput, readTemplate: () => TEMPLATE, runtime: () => COMMIT, operationId: UUID };
  return { directory, receipt, calls, state, dependencies };
}

afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('client update staging feed operator', () => {
  it('plans only the five dedicated resources and requires the exact approved change set before execution', () => {
    const f = fixture();
    const planned = planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    expect(planned).toMatchObject({ state: 'planned', change_set_id: CHANGE_SET, feed_url: null });
    expect(f.calls.some(args => args.includes('execute-change-set'))).toBe(false);
    expect(f.calls.flat().some(value => /^(s3api|iam|ssm|secretsmanager)$/.test(value))).toBe(false);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: `${CHANGE_SET}x` }, f.dependencies)).toThrow('exact_change_set_approval_required');
    expect(f.state.executes).toBe(0);
    expect(executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies).state).toBe('executing');
    expect(f.state.executes).toBe(1);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8'))).toMatchObject({ source_sha: COMMIT, change_set_id: CHANGE_SET, state: 'executing' });
  });

  it('never repeats an uncertain execution and records only validated outputs after the stack completes', () => {
    const f = fixture();
    planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies)).not.toThrow();
    expect(f.state.executes).toBe(1);
    f.state.complete = true;
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies)).toMatchObject({ state: 'succeeded', feed_url: 'https://d111111abcdef8.cloudfront.net/feed.json' });
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies).state).toBe('succeeded');
  });

  it('persists the planning intent before creating a change set and resumes it without a duplicate create', () => {
    const f = fixture();
    f.state.changeSetReady = false;
    expect(planClientUpdateStaging({ output: f.receipt }, f.dependencies).state).toBe('planning');
    expect(f.state.creates).toBe(1);
    f.state.changeSetReady = true;
    expect(planClientUpdateStaging({ output: f.receipt }, f.dependencies)).toMatchObject({ state: 'planned', change_set_id: CHANGE_SET });
    expect(f.state.creates).toBe(1);
  });

  it('binds execution to the canonical remote change-set template', () => {
    const f = fixture();
    planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    const aws = f.dependencies.aws;
    f.dependencies.aws = (args: string[]) => args[0] === 'cloudformation' && args[1] === 'get-template'
      ? { TemplateBody: '{"Resources":{"Unexpected":{}}}' }
      : aws(args);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies)).toThrow('remote_template_binding_mismatch');
    expect(f.state.executes).toBe(0);
  });

  it('surfaces exact change-set early-validation failures before it becomes reviewable', () => {
    const f = fixture();
    const aws = f.dependencies.aws;
    f.dependencies.aws = (args: string[]) => args[0] === 'cloudformation' && args[1] === 'describe-events'
      ? { OperationEvents: [{ Status: 'VALIDATION_FAILED' }] }
      : aws(args);
    expect(() => planClientUpdateStaging({ output: f.receipt }, f.dependencies)).toThrow('predeploy_validation_failed');
    expect(f.state.executes).toBe(0);
  });

  it('refuses a change set that adds an unrelated resource before it can be executed', () => {
    const f = fixture();
    f.dependencies.aws = (args: string[]) => {
      if (args[0] === 'sts') return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
      if (args[1] === 'describe-stacks') return { Stacks: [] };
      if (args[1] === 'describe-change-set') return { ChangeSetId: CHANGE_SET, StackId: STACK_ID, StackName: 'echo-client-update-staging-v1', Status: 'CREATE_COMPLETE', Changes: [{ ResourceChange: { LogicalResourceId: 'UnexpectedRole', ResourceType: 'AWS::IAM::Role', Action: 'Add' } }] };
      throw new Error('unexpected');
    };
    expect(() => planClientUpdateStaging({ output: f.receipt }, f.dependencies)).toThrow('change_set_boundary_violation');
    expect(f.state.executes).toBe(0);
  });

  it('requires the exact reviewed runtime that created the plan', () => {
    const f = fixture();
    planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    f.dependencies.runtime = () => 'b'.repeat(40);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies)).toThrow('exact_reviewed_runtime_required');
    expect(f.state.executes).toBe(0);
  });

  it('marks a missing post-execution stack unconfirmed instead of retrying the change set', () => {
    const f = fixture();
    planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    f.dependencies.awsNoOutput = (args: string[]) => {
      if (args[1] === 'execute-change-set') f.state.executes += 1;
    };
    expect(executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies).state).toBe('unconfirmed');
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: CHANGE_SET }, f.dependencies)).toThrow('operation_unconfirmed');
    expect(f.state.executes).toBe(1);
  });
});

describe('direct S3 client update staging feed operator', () => {
  it('plans only the separate S3 bucket and policy, executes once, and records its exact regional HTTPS URL', () => {
    const f = fixture('s3');
    expect(planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toMatchObject({
      kind: 'echo-client-update-staging-s3-feed-operation-v1', state: 'planned', change_set_id: S3_CHANGE_SET,
    });
    expect(JSON.parse(readFileSync(f.receipt, 'utf8'))).toMatchObject({
      stack_name: 'echo-client-update-staging-s3-v1',
      inventory: [
        { logical_id: 'FeedBucket', resource_type: 'AWS::S3::Bucket', action: 'Add' },
        { logical_id: 'FeedBucketPolicy', resource_type: 'AWS::S3::BucketPolicy', action: 'Add' },
      ],
    });
    const creation = f.calls.find(args => args[1] === 'create-change-set');
    expect(creation).toContain('echo-client-update-staging-s3-v1');
    expect(creation?.find(value => value.startsWith('file://'))).toMatch(/\/deploy\/client-updates\/staging-feed-s3-v1\.template\.json$/);
    expect(f.calls.find(args => args[0] === 's3control')).toEqual(['s3control', 'get-public-access-block', '--account-id', '904560150024']);
    expect(executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies).state).toBe('executing');
    expect(executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies).state).toBe('executing');
    expect(f.state.executes).toBe(1);
    expect(f.calls.filter(args => args[0] === 's3control')).toHaveLength(2);
    f.state.complete = true;
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies)).toMatchObject({ state: 'succeeded', feed_url: S3_FEED_URL });
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).outputs).toEqual({ bucket_name: 'echo-feed-staging-123', distribution_id: null, feed_url: S3_FEED_URL });
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies).state).toBe('succeeded');
    expect(f.calls.flat()).not.toContain('echo-client-update-staging-v1');
    expect(f.calls.filter(args => args[0] === 's3control').every(args => args[1] === 'get-public-access-block')).toBe(true);
  });

  it('accepts an explicitly absent account public-access configuration', () => {
    const f = fixture('s3');
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => args[0] === 's3control' ? { PublicAccessBlockConfiguration: null } : aws(args);
    expect(planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies).state).toBe('planned');
    expect(f.state.creates).toBe(1);
  });

  it('refuses a concurrent planner that wins the receipt path during account inspection', () => {
    const f = fixture('s3');
    const other = fixture('s3');
    other.state.changeSetReady = false;
    other.dependencies.operationId = '22222222-2222-4222-8222-222222222222';
    planClientUpdateStaging({ output: other.receipt, hosting: 's3' }, other.dependencies);
    const competingReceipt = readFileSync(other.receipt);
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => {
      if (args[0] === 'sts' && !existsSync(f.receipt)) writeFileSync(f.receipt, competingReceipt, { flag: 'wx', mode: 0o600 });
      return aws(args);
    };
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('receipt_destination_exists');
    expect(f.state.creates).toBe(0);
    expect(readFileSync(f.receipt)).toEqual(competingReceipt);
  });

  it.each(['BlockPublicPolicy', 'RestrictPublicBuckets'])('stops before planning when account %s is enabled', flag => {
    const f = fixture('s3');
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => args[0] === 's3control'
      ? { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false, [flag]: true } }
      : aws(args);
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('account_public_access_blocks_s3_feed');
    expect(f.state.creates).toBe(0);
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('rechecks account restrictions before execution and preserves the planned receipt when blocked', () => {
    const f = fixture('s3');
    planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    const original = readFileSync(f.receipt);
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => args[0] === 's3control'
      ? { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: false } }
      : aws(args);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies)).toThrow('account_public_access_blocks_s3_feed');
    expect(readFileSync(f.receipt)).toEqual(original);
    expect(f.state.executes).toBe(0);
  });

  it.each([{}, { PublicAccessBlockConfiguration: {} }, { PublicAccessBlockConfiguration: { BlockPublicPolicy: 'false' } }])('does not treat an unknown account configuration as absent: %j', response => {
    const f = fixture('s3');
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => args[0] === 's3control' ? response : aws(args);
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('account_public_access_check_unconfirmed');
    expect(f.state.creates).toBe(0);
  });

  it('does not swallow an account inspection failure', () => {
    const f = fixture('s3');
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => { if (args[0] === 's3control') throw new Error('aws_operation_unconfirmed'); return aws(args); };
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('aws_operation_unconfirmed');
    expect(f.state.creates).toBe(0);
  });

  it.each([
    'https://another-bucket.s3.us-west-2.amazonaws.com/feed.json',
    'https://echo-feed-staging-123.s3.us-east-1.amazonaws.com/feed.json',
    'https://s3.us-west-2.amazonaws.com/echo-feed-staging-123/feed.json',
    'http://echo-feed-staging-123.s3-website-us-west-2.amazonaws.com/feed.json',
    'https://d111111abcdef8.cloudfront.net/feed.json',
    'https://updates.example.com/feed.json',
    `${S3_FEED_URL}?signature=example`,
    `${S3_FEED_URL}#fragment`,
    'https://user:pass@echo-feed-staging-123.s3.us-west-2.amazonaws.com/feed.json',
    'https://echo-feed-staging-123.s3.us-west-2.amazonaws.com:443/feed.json',
    'https://echo-feed-staging-123.s3.us-west-2.amazonaws.com/path/../feed.json',
  ])('rejects a completed stack with a noncanonical feed output: %s', feed => {
    const f = fixture('s3');
    planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies);
    f.state.complete = true;
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => {
      const response = aws(args);
      if (args[1] === 'describe-stacks') response.Stacks[0].Outputs.find((item: { OutputKey: string }) => item.OutputKey === 'FeedUrl').OutputValue = feed;
      return response;
    };
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies).state).toBe('unconfirmed');
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).outputs).toBeNull();
    expect(f.state.executes).toBe(1);
  });

  it.each(['bucket.with.dots', 'UPPERCASE', 'short-', 'a'])('rejects an invalid HTTPS bucket name even when feed output agrees: %s', bucket => {
    const f = fixture('s3');
    planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies);
    f.state.complete = true;
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => {
      const response = aws(args);
      if (args[1] === 'describe-stacks') response.Stacks[0].Outputs = [
        { OutputKey: 'BucketName', OutputValue: bucket },
        { OutputKey: 'FeedUrl', OutputValue: `https://${bucket}.s3.us-west-2.amazonaws.com/feed.json` },
      ];
      return response;
    };
    expect(statusClientUpdateStaging({ receipt: f.receipt }, f.dependencies).state).toBe('unconfirmed');
  });

  it('never converts or overwrites an existing CloudFront receipt', () => {
    const f = fixture();
    f.state.changeSetReady = false;
    planClientUpdateStaging({ output: f.receipt }, f.dependencies);
    const original = readFileSync(f.receipt);
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('receipt_destination_exists');
    expect(readFileSync(f.receipt)).toEqual(original);
    expect(f.state.creates).toBe(1);
  });

  it.each(['kind', 'stack_name', 'stack_id', 'change_set_name', 'change_set_id'])('rejects receipt %s from the other hosting lane', key => {
    const f = fixture('s3');
    planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    receipt[key] = ({ kind: 'echo-client-update-staging-feed-operation-v1', stack_name: 'echo-client-update-staging-v1', stack_id: STACK_ID, change_set_name: `echo-client-update-staging-${UUID}`, change_set_id: CHANGE_SET } as Record<string, string>)[key];
    writeFileSync(f.receipt, JSON.stringify(receipt));
    const before = f.calls.length;
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: receipt.change_set_id }, f.dependencies)).toThrow('receipt_invalid');
    expect(f.calls).toHaveLength(before);
    expect(f.state.executes).toBe(0);
  });

  it.each(['planning', 'execution'])('rejects resource injection during %s', stage => {
    const f = fixture('s3');
    if (stage === 'execution') planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => {
      const response = aws(args);
      if (args[1] === 'describe-change-set' && response.Changes) response.Changes.push({ ResourceChange: { LogicalResourceId: 'UnexpectedRole', ResourceType: 'AWS::IAM::Role', Action: 'Add' } });
      return response;
    };
    expect(() => stage === 'execution'
      ? executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies)
      : planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('change_set_boundary_violation');
    expect(f.state.executes).toBe(0);
  });

  it('refuses an existing S3 stack instead of updating, deleting, or reusing it', () => {
    const f = fixture('s3');
    f.state.stackExists = true;
    expect(() => planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies)).toThrow('staging_feed_stack_already_exists');
    expect(f.state.creates).toBe(0);
    expect(f.state.executes).toBe(0);
  });

  it('binds an S3 execution to the same source and canonical remote template as its plan', () => {
    const f = fixture('s3');
    planClientUpdateStaging({ output: f.receipt, hosting: 's3' }, f.dependencies);
    f.dependencies.runtime = () => 'b'.repeat(40);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies)).toThrow('exact_reviewed_runtime_required');
    f.dependencies.runtime = () => COMMIT;
    const aws = f.dependencies.aws;
    f.dependencies.aws = args => args[1] === 'get-template' ? { TemplateBody: '{"Resources":{"Unexpected":{}}}' } : aws(args);
    expect(() => executeClientUpdateStaging({ receipt: f.receipt, approveChangeSet: S3_CHANGE_SET }, f.dependencies)).toThrow('remote_template_binding_mismatch');
    expect(f.state.executes).toBe(0);
  });
});
