import {
  buildContextCaptureEnvelopeV1,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type AdapterOperationContext,
  type ContextCaptureContentV1,
  type SourceAdapterIdentityV1,
  type SourceAdapterV1,
  type SourceBatchV1,
  type SourcePullRequestV1,
} from '@echo-brain/organization-processing/core';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { parseJiraContextIssueV1 } from './jira-context-payload-v1.js';
import { jiraSiteOrigin, parseJiraProject } from './jira-payload-v1.js';
import { JIRA_ID, JIRA_PROJECT_KEY, copyJiraBindingV1, jiraArray, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

const JIRA_CONTEXT_SOURCE_FIELDS_V1 = 'summary,project,created,status,assignee,duedate,description,updated,labels,priority';
const JIRA_CONTEXT_SOURCE_MAX_LIMIT_V1 = 50;
const JIRA_CONTEXT_SOURCE_MAX_CURSOR_BYTES_V1 = 4096;

export interface JiraContextSourceReadGrantFenceV1 {
  requireCurrent(input: { readonly binding: PersonConnectorReadBindingV1; readonly signal?: AbortSignal }): Promise<void>;
}

export interface JiraContextSourceOptionsV1 {
  /** Existing person-bound authorized transport. This factory persists no credential. */
  readonly transport: JiraCloudTransportV1;
  /** Bound grant/membership fence supplied by Authority composition. */
  readonly read_grant_fence: JiraContextSourceReadGrantFenceV1;
  /** Fixed safe Jira project coordinate chosen by Authority composition. */
  readonly project: string;
  /** Stable installation identity chosen by Authority composition, never a model input. */
  readonly identity: SourceAdapterIdentityV1;
  /** The selected retention representation; Authority makes this policy choice. */
  readonly representation: 'pointer' | 'excerpt';
  readonly now?: () => Date;
}

function assertProject(value: string): string {
  if (!(JIRA_ID.test(value) || JIRA_PROJECT_KEY.test(value))) throw new Error('Jira context source project must be a Jira project id or key');
  return value;
}

function assertIdentity(value: SourceAdapterIdentityV1): SourceAdapterIdentityV1 {
  if (value.kind !== 'source' || value.adapter_id !== 'jira-context-capture' || value.version !== '1.0.0') {
    throw new Error('Jira context source identity is not supported');
  }
  jiraString(value.instance_id, 256);
  return Object.freeze({ ...value });
}

function requestLimit(value: number | undefined): number {
  const limit = value ?? JIRA_CONTEXT_SOURCE_MAX_LIMIT_V1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > JIRA_CONTEXT_SOURCE_MAX_LIMIT_V1) jiraFailure('invalid_request');
  return limit;
}

function requestCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, 'utf8') > JIRA_CONTEXT_SOURCE_MAX_CURSOR_BYTES_V1) jiraFailure('invalid_request');
  return jiraString(value, JIRA_CONTEXT_SOURCE_MAX_CURSOR_BYTES_V1);
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Jira context source clock is invalid');
  return value.toISOString();
}

/**
 * An inactive source adapter over an already-authorized personal Jira reader.
 * It is intentionally transport-only: activation, retention and scheduling
 * remain outside this provider package.
 */
export class JiraContextSourceV1 implements SourceAdapterV1<ContextCaptureContentV1> {
  readonly identity: SourceAdapterIdentityV1;
  private readonly binding: PersonConnectorReadBindingV1;
  private readonly transport: JiraCloudTransportV1;
  private readonly requireReadGrant: JiraContextSourceReadGrantFenceV1['requireCurrent'];
  private readonly pathPrefix: string;
  private readonly project: string;
  private readonly representation: 'pointer' | 'excerpt';
  private readonly now: () => Date;

  constructor(options: JiraContextSourceOptionsV1) {
    this.identity = assertIdentity(options.identity);
    this.binding = copyJiraBindingV1(options.transport.binding);
    const request = options.transport.request;
    if (typeof request !== 'function' || options.read_grant_fence === null || typeof options.read_grant_fence !== 'object' ||
        typeof options.read_grant_fence.requireCurrent !== 'function') throw new Error('Jira context source dependencies are invalid');
    // Capture callable seams at construction. A mutable options object cannot
    // swap a transport, fence or representation while a pull is in flight.
    this.transport = Object.freeze({ binding: this.binding, request: request.bind(options.transport) });
    this.requireReadGrant = options.read_grant_fence.requireCurrent.bind(options.read_grant_fence);
    this.project = assertProject(options.project);
    if (options.representation !== 'pointer' && options.representation !== 'excerpt') throw new Error('Jira context source representation is invalid');
    this.representation = options.representation;
    this.pathPrefix = `/ex/jira/${this.binding.external_scope_id}/rest/api/3`;
    this.now = options.now ?? (() => new Date());
  }

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const ok = config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id;
    return { ok, errors: ok ? [] : ['Jira context source identity mismatch'] };
  }

  async healthCheck(context?: AdapterOperationContext): Promise<AdapterHealth> {
    context?.signal.throwIfAborted();
    await this.requireCurrent(context?.signal);
    return { status: 'healthy', checked_at: canonicalNow(this.now) };
  }

  async pull(request: SourcePullRequestV1, context?: AdapterOperationContext): Promise<SourceBatchV1<ContextCaptureContentV1>> {
    context?.signal.throwIfAborted();
    const limit = requestLimit(request.limit);
    const cursor = requestCursor(request.cursor);
    await this.requireCurrent(context?.signal);
    context?.signal.throwIfAborted();
    const origin = await this.verifyConnection(context?.signal);
    const project = parseJiraProject(await this.transport.request({ path: `${this.pathPrefix}/project/${this.project}`, signal: context?.signal }), origin, `https://api.atlassian.com/ex/jira/${this.binding.external_scope_id}`);
    context?.signal.throwIfAborted();
    const page = jiraRecord(await this.transport.request({
      path: `${this.pathPrefix}/search/jql`,
      method: 'POST',
      body: {
        // The project identifier is validated above. No caller-provided JQL is accepted.
        jql: `project = ${project.id} ORDER BY updated ASC, id ASC`,
        maxResults: limit,
        fields: ['id'],
        ...(cursor === undefined ? {} : { nextPageToken: cursor }),
      },
      signal: context?.signal,
    }));
    context?.signal.throwIfAborted();
    if (typeof page.isLast !== 'boolean') jiraFailure('invalid_output');
    const next = page.nextPageToken === undefined || page.nextPageToken === null ? undefined : jiraString(page.nextPageToken, JIRA_CONTEXT_SOURCE_MAX_CURSOR_BYTES_V1);
    if (page.isLast ? next !== undefined : next === undefined) jiraFailure('invalid_output');
    if (next !== undefined && next === cursor) jiraFailure('invalid_output');
    const seen = new Set<string>();
    const sources = [] as ReturnType<typeof buildContextCaptureEnvelopeV1>[];
    for (const reference of jiraArray(page.issues, limit)) {
      const id = jiraString(jiraRecord(reference).id, 20, JIRA_ID);
      if (seen.has(id)) jiraFailure('invalid_output');
      seen.add(id);
      const raw = await this.transport.request({
        path: `${this.pathPrefix}/issue/${id}`,
        query: { fields: JIRA_CONTEXT_SOURCE_FIELDS_V1 },
        signal: context?.signal,
      });
      context?.signal.throwIfAborted();
      const capture = parseJiraContextIssueV1(raw, { cloudid: this.binding.external_scope_id!, origin, representation: this.representation });
      if (capture.id !== id || capture.project_id !== project.id) jiraFailure('invalid_output');
      sources.push(buildContextCaptureEnvelopeV1({
        identity: this.identity,
        external_id: `issue:${id}`,
        captured_at: canonicalNow(this.now),
        content: capture.content,
      }));
    }
    // The second fence makes grant revocation win over bytes fetched during this pull.
    await this.requireCurrent(context?.signal);
    context?.signal.throwIfAborted();
    return Object.freeze({ sources: Object.freeze(sources), ...(next === undefined ? {} : { next_cursor: next }) });
  }

  private async requireCurrent(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.requireReadGrant({ binding: this.binding, signal });
    signal?.throwIfAborted();
  }

  private async verifyConnection(signal?: AbortSignal): Promise<string> {
    const cloudid = this.binding.external_scope_id!;
    const resources = jiraArray(await this.transport.request({ path: '/oauth/token/accessible-resources', signal }), 256);
    const matches: Record<string, unknown>[] = [];
    for (const value of resources) {
      const resource = jiraRecord(value);
      const scopes = jiraArray(resource.scopes, 256).map(scope => jiraString(scope, 128));
      if (resource.id === cloudid && scopes.some(scope => scope.endsWith(':jira') || scope.includes(':jira-'))) matches.push(resource);
    }
    if (matches.length !== 1) jiraFailure('unauthorized');
    const selected = matches[0]!;
    const scopes = selected.scopes as readonly string[];
    if (!['read:jira-work', 'read:jira-user'].every(scope => scopes.includes(scope))) jiraFailure('unauthorized');
    const origin = jiraSiteOrigin(selected.url);
    const myself = jiraRecord(await this.transport.request({ path: `${this.pathPrefix}/myself`, signal }));
    if (jiraString(myself.accountId) !== this.binding.external_subject_id || myself.active !== true || myself.accountType !== 'atlassian') jiraFailure('unauthorized');
    return origin;
  }
}

export function createJiraContextSourceV1(options: JiraContextSourceOptionsV1): JiraContextSourceV1 {
  return new JiraContextSourceV1(options);
}
