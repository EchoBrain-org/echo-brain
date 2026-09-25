import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeClientUpdateStaging, planClientUpdateStaging, statusClientUpdateStaging } from '../../tools/client-update-staging.mjs';

const temporary: string[] = [];
const COMMIT = 'a'.repeat(40);
const UUID = '11111111-1111-4111-8111-111111111111';
const CHANGE_SET = `arn:aws:cloudformation:us-west-2:904560150024:changeSet/echo-client-update-staging-${UUID}/${UUID}`;
const STACK_ID = 'arn:aws:cloudformation:us-west-2:904560150024:stack/echo-client-update-staging-v1/22222222-2222-4222-8222-222222222222';
const TEMPLATE = Buffer.from('{"AWSTemplateFormatVersion":"2010-09-09","Resources":{}}\n');
const expected = [
  ['FeedBucket', 'AWS::S3::Bucket'],
  ['FeedBucketPolicy', 'AWS::S3::BucketPolicy'],
  ['FeedDistribution', 'AWS::CloudFront::Distribution'],
  ['FeedOriginAccessControl', 'AWS::CloudFront::OriginAccessControl'],
  ['FeedCachePolicy', 'AWS::CloudFront::CachePolicy'],
];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-client-update-staging-'));
  chmodSync(directory, 0o700);
  temporary.push(directory);
  const receipt = join(directory, 'operation.json');
  const calls: string[][] = [];
  const state = { complete: false, executes: 0, stackExists: false, changeSetExists: false, changeSetReady: true, creates: 0 };
  const aws: (args: string[]) => any = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'sts') return { Account: '904560150024', Arn: 'arn:aws:sts::904560150024:assumed-role/AWSReservedSSO_AdministratorAccess_abc/operator' };
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
      if (!state.stackExists) return { Stacks: [] };
      return { Stacks: [{ StackId: STACK_ID, StackStatus: state.complete ? 'CREATE_COMPLETE' : 'CREATE_IN_PROGRESS', Outputs: state.complete ? [
        { OutputKey: 'BucketName', OutputValue: 'echo-feed-staging-123' },
        { OutputKey: 'DistributionId', OutputValue: 'D123456789ABC' },
        { OutputKey: 'FeedUrl', OutputValue: 'https://d111111abcdef8.cloudfront.net/feed.json' },
      ] : [] }] };
    }
    if (args[0] === 'cloudformation' && args[1] === 'describe-change-set') return !state.changeSetExists ? { Status: 'NOT_FOUND' } : !state.changeSetReady ? { Status: 'CREATE_IN_PROGRESS' } : { ChangeSetId: CHANGE_SET, StackId: STACK_ID, StackName: 'echo-client-update-staging-v1', Status: 'CREATE_COMPLETE', Changes: expected.map(([LogicalResourceId, ResourceType]) => ({ ResourceChange: { LogicalResourceId, ResourceType, Action: 'Add' } })) };
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
