import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateOrganizationApiError,
  validateOrganizationDirectorySearchV1,
  validateOrganizationDirectoryV1,
  validatePersonUpdateRequestId,
  validatePersonUpdateSubmitV1,
  validatePersonUpdateSubmitV2,
  validatePersonUpdateReceiptV2,
  validatePersonUpdateStatusV2,
  validatePersonUploadContentV2,
  validatePersonUploadSearchResultV2,
  validatePersonUploadSearchV2,
  validateProjectContextAssociateV1,
  validateProjectContextBrowseV1,
  validateProjectContextDissociateV1,
  validateProjectContextFeedV1,
  validateProjectContextReadV1,
  validateProjectContextReadRequestV1,
  validateProjectContextSearchResultV1,
  validateProjectContextSearchV1,
  validateProjectCreateReceiptV1,
  validateProjectCreateV1,
  validateProjectDirectorySearchV1,
  validateProjectDirectoryV1,
  validateProjectListV1,
  validateProjectMemberAddV1,
  validateProjectMemberRemoveV1,
  validateProjectMemberSetV1,
  validateProjectMembersV1,
  validateProjectMutationReceiptV1,
  validateProjectPageRequestV1,
  validateProjectSummaryV1,
} from '@echo-brain/organization-api';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const FIXTURES = resolve(REPOSITORY_ROOT, 'tests/fixtures/project-context-v1');

type JsonRecord = Record<string, unknown>;
interface OperationFixture {
  readonly id: string;
  readonly argv: readonly string[];
  readonly http: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly status: number;
    readonly body?: unknown;
    readonly response: unknown;
  };
}
interface InvalidFixture {
  readonly id: string;
  readonly validator: string;
  readonly value: unknown;
}
interface ErrorFixture {
  readonly id: string;
  readonly http_status: number;
  readonly http: unknown;
  readonly cli: JsonRecord;
  readonly ui?: string;
}
interface VisibilityFixture {
  readonly id: string;
  readonly cli: readonly string[];
  readonly body: unknown;
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T;
}

const operations = fixture<{ schema_version: number; kind: string; operations: OperationFixture[] }>('operations.json');
const invalid = fixture<{ schema_version: number; kind: string; cases: InvalidFixture[]; errors: ErrorFixture[] }>('invalid.json');
const visibility = fixture<{ schema_version: number; kind: string; submits: VisibilityFixture[] }>('visibility.json');

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function body(operation: OperationFixture): JsonRecord {
  return operation.http.body as JsonRecord;
}

function assertArgvMatchesWire(operation: OperationFixture): void {
  const path = new URL(operation.http.path, 'https://authority.example');
  const value = operation.http.body === undefined ? undefined : body(operation);
  switch (operation.id) {
    case 'projects-list':
      expect(option(operation.argv, 'limit')).toBe(path.searchParams.get('limit'));
      expect(option(operation.argv, 'cursor')).toBe(path.searchParams.get('cursor'));
      expect(validateProjectPageRequestV1({
        limit: Number(path.searchParams.get('limit')),
        cursor: path.searchParams.get('cursor'),
      })).toEqual({ limit: 10, cursor: 'eyJsYXN0Ijoicm93In0' });
      return;
    case 'projects-create':
      expect(option(operation.argv, 'request-id')).toBe(value!.request_id);
      expect(option(operation.argv, 'name')).toBe(value!.name);
      return;
    case 'projects-read':
      expect(path.pathname.split('/').at(-1)).toBe(option(operation.argv, 'project-id'));
      return;
    case 'projects-read-context':
      expect(path.pathname.split('/').at(-3)).toBe(option(operation.argv, 'project-id'));
      expect(path.pathname.split('/').at(-1)).toBe(option(operation.argv, 'context-id'));
      return;
    case 'updates-status-v2':
      expect(path.pathname.split('/').at(-1)).toBe(option(operation.argv, 'request-id'));
      return;
    case 'updates-read-v2':
      expect(path.pathname.split('/').at(-1)).toBe(option(operation.argv, 'context-id'));
      return;
    default:
      break;
  }
  expect(value, operation.id).toBeDefined();
  for (const [flag, field] of [
    ['request-id', 'request_id'], ['project-id', 'project_id'],
    ['membership-id', 'membership_id'], ['context-id', 'context_id'],
    ['name', 'name'], ['query', 'query'], ['limit', 'limit'], ['cursor', 'cursor'],
  ] as const) {
    const argument = option(operation.argv, flag);
    if (argument !== undefined) expect(String(value![field]), `${operation.id} --${flag}`).toBe(argument);
  }
  if (operation.id === 'projects-member-set') expect(option(operation.argv, 'role')).toBe(value!.role);
  if (operation.id === 'updates-submit-v2') {
    const audience = value!.audience as JsonRecord;
    expect(option(operation.argv, 'visibility')).toBe(audience.kind);
    expect(option(operation.argv, 'audience-project-id')).toBe(audience.project_id);
  }
}

const requestValidators: Readonly<Record<string, (value: unknown) => unknown>> = {
  'projects-create': validateProjectCreateV1,
  'projects-members': validateProjectContextBrowseV1,
  'projects-directory': validateProjectDirectorySearchV1,
  'person-directory': validateOrganizationDirectorySearchV1,
  'projects-member-add': validateProjectMemberAddV1,
  'projects-member-set': validateProjectMemberSetV1,
  'projects-member-remove': validateProjectMemberRemoveV1,
  'projects-associate': validateProjectContextAssociateV1,
  'projects-dissociate': validateProjectContextDissociateV1,
  'projects-feed': validateProjectContextBrowseV1,
  'projects-search': validateProjectContextSearchV1,
  'updates-submit-v2': validatePersonUpdateSubmitV2,
  'updates-search-v2': validatePersonUploadSearchV2,
};

const responseValidators: Readonly<Record<string, (value: unknown) => unknown>> = {
  'projects-list': validateProjectListV1,
  'projects-create': validateProjectCreateReceiptV1,
  'projects-read': validateProjectSummaryV1,
  'projects-members': validateProjectMembersV1,
  'projects-directory': validateProjectDirectoryV1,
  'person-directory': validateOrganizationDirectoryV1,
  'projects-member-add': validateProjectMutationReceiptV1,
  'projects-member-set': validateProjectMutationReceiptV1,
  'projects-member-remove': validateProjectMutationReceiptV1,
  'projects-associate': validateProjectMutationReceiptV1,
  'projects-dissociate': validateProjectMutationReceiptV1,
  'projects-feed': validateProjectContextFeedV1,
  'projects-search': validateProjectContextSearchResultV1,
  'projects-read-context': validateProjectContextReadV1,
  'updates-submit-v2': validatePersonUpdateReceiptV2,
  'updates-status-v2': validatePersonUpdateStatusV2,
  'updates-search-v2': validatePersonUploadSearchResultV2,
  'updates-read-v2': validatePersonUploadContentV2,
};

const invalidValidators: Readonly<Record<string, (value: unknown) => unknown>> = {
  'person-update-v1-submit': validatePersonUpdateSubmitV1,
  'person-update-v2-submit': validatePersonUpdateSubmitV2,
  'project-create': validateProjectCreateV1,
  'project-member-set': validateProjectMemberSetV1,
  'project-browse': validateProjectContextBrowseV1,
  'project-search': validateProjectContextSearchV1,
  'project-feed': validateProjectContextFeedV1,
};

describe('project-context-v1 contract fixtures', () => {
  it('freeze every PC-04 command and every matching HTTP response shape', () => {
    expect(operations).toMatchObject({ schema_version: 1, kind: 'echo-project-context-command-fixtures-v1' });
    expect(operations.operations.map(({ id }) => id)).toEqual([
      'projects-list', 'projects-create', 'projects-read', 'projects-members',
      'projects-directory', 'person-directory', 'projects-member-add', 'projects-member-set', 'projects-member-remove',
      'projects-associate', 'projects-dissociate', 'projects-feed', 'projects-search',
      'projects-read-context', 'updates-submit-v2', 'updates-status-v2',
      'updates-search-v2', 'updates-read-v2',
    ]);
    for (const operation of operations.operations) {
      expect(operation.argv.length, operation.id).toBeGreaterThanOrEqual(2);
      expect(operation.http.path, operation.id).toMatch(/^\/v[12]\/person\//);
      expect(responseValidators[operation.id], operation.id).toBeTypeOf('function');
      expect(responseValidators[operation.id]!(operation.http.response)).toEqual(operation.http.response);
      const validator = requestValidators[operation.id];
      if (operation.http.method === 'POST') {
        expect(operation.http.body, operation.id).toBeDefined();
        expect(validator, operation.id).toBeTypeOf('function');
        expect(validator!(operation.http.body)).toEqual(operation.http.body);
      } else {
        expect(operation.http.body, operation.id).toBeUndefined();
      }
      assertArgvMatchesWire(operation);
    }
  });

  it('keeps read routes explicit and V2 upload status bound to the caller request ID', () => {
    const projectRead = operations.operations.find(({ id }) => id === 'projects-read-context')!;
    const [, , , , projectId, , contextId] = projectRead.http.path.split('/');
    expect(validateProjectContextReadRequestV1({ project_id: projectId, context_id: contextId })).toEqual({ project_id: projectId, context_id: contextId });
    const uploadStatus = operations.operations.find(({ id }) => id === 'updates-status-v2')!;
    const requestId = uploadStatus.http.path.split('/').at(-1)!;
    expect(validatePersonUpdateRequestId(requestId)).toBe(requestId);
    expect((uploadStatus.http.response as JsonRecord).request_id).toBe(requestId);
  });

  it('rejects every invalid fixture through its public codec', () => {
    expect(invalid).toMatchObject({ schema_version: 1, kind: 'echo-project-context-invalid-fixtures-v1' });
    for (const testCase of invalid.cases) {
      expect(invalidValidators[testCase.validator], testCase.id).toBeTypeOf('function');
      expect(() => invalidValidators[testCase.validator]!(testCase.value), testCase.id).toThrow();
    }
  });

  it('uses one sanitized error envelope and preserves unavailable versus invisible semantics', () => {
    for (const error of invalid.errors) {
      expect(validateOrganizationApiError(error.http)).toEqual(error.http);
      expect(error.cli.ok).toBe(false);
      expect(error.cli.error).toBeTypeOf('string');
      expect(error.cli.status).toBe(error.http_status);
    }
    const probe = invalid.errors.find(({ id }) => id === 'unavailable-project-capability')!;
    const invisible = invalid.errors.find(({ id }) => id === 'individual-project-non-disclosure')!;
    expect(probe.http).toEqual(invisible.http);
    expect(probe.ui).toBe('not_live_yet');
    expect(invisible.ui).toBe('not_found');
  });

  it('preserves a mutation request ID through 4xx and unknown outcomes without fallback', () => {
    const rejected = invalid.errors.find(({ id }) => id === 'v2-submit-canonical-4xx')!;
    const unknown = invalid.errors.find(({ id }) => id === 'v2-submit-unknown-outcome')!;
    expect(rejected.cli).toMatchObject({ code: 'invalid_request', mutation_outcome: 'not_submitted', request_id: '00000000-0000-4000-8000-000000000006' });
    expect(unknown.cli).toMatchObject({ code: 'outcome_unknown', mutation_outcome: 'unknown', request_id: rejected.cli.request_id });
    expect(JSON.stringify(invalid)).not.toContain('unsupported_operation');
  });

  it('defines every V2 visibility and keeps the one association independent from it', () => {
    expect(visibility).toMatchObject({ schema_version: 1, kind: 'echo-project-context-upload-visibility-fixtures-v1' });
    expect(visibility.submits.map(({ id }) => id)).toEqual([
      'only-me-default-without-association',
      'team-with-independent-association',
      'project-audience-with-different-single-association',
    ]);
    for (const submit of visibility.submits) {
      expect(validatePersonUpdateSubmitV2(submit.body)).toEqual(submit.body);
    }
    const onlyMe = visibility.submits[0]!;
    const team = visibility.submits[1]!;
    const project = visibility.submits[2]!;
    expect(option(onlyMe.cli, 'visibility')).toBeUndefined();
    expect((onlyMe.body as JsonRecord).project_id).toBeNull();
    expect(option(team.cli, 'visibility')).toBe('team');
    expect((team.body as JsonRecord).project_id).toBe(option(team.cli, 'project-id'));
    const projectAudience = (project.body as JsonRecord).audience as JsonRecord;
    expect(projectAudience.project_id).toBe(option(project.cli, 'audience-project-id'));
    expect((project.body as JsonRecord).project_id).toBe(option(project.cli, 'project-id'));
    expect((project.body as JsonRecord).project_id).not.toBe(projectAudience.project_id);
  });
});
