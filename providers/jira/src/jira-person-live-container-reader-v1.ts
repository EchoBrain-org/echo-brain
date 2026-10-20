import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { PersonToolContainerCitationV1 } from '@echo-brain/organization-api';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReaderV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createAtlassianVerificationBatchV1 } from '@echo-brain/provider-runtime/atlassian-connection-verification-v1';
import { boundUtf8V1 } from '@echo-brain/provider-runtime/person-provider-v1';
import { createPersonToolContainerReaderV1, personToolContainerRowsV1, type PersonToolContainerV1 } from '@echo-brain/provider-runtime/person-tool-container-reader-v1';
import { JIRA_PROJECT_QUERY_MAX_BYTES_V1, type JiraCloudTransportV1 } from './jira-cloud-transport-v1.js';
import { parseJiraProject, verifyJiraConnectionV1 } from './jira-payload-v1.js';
import { copyJiraBindingV1, JIRA_ID, jiraArray, jiraFailure, jiraRecord, jiraString } from './jira-validation-v1.js';

/** Projects one project search reads when a search looks for candidates. */
const CANDIDATES_PAGE = 50;


/**
 * The Jira projects the asker can browse, as a tool container source (research tool contract v1). Jira's project search
 * applies the asker's own Browse projects permission; an exact project read applies it again. Construct once per request
 * from trusted ECHO state, never from model arguments.
 */
export async function createJiraPersonLiveContainerReaderV1(options: {
  readonly binding: PersonConnectorReadBindingV1;
  readonly transport: JiraCloudTransportV1;
  readonly signal?: AbortSignal;
  readonly expected_origin?: string;
  /** Trusted project-scope pin: the Jira project id an ECHO project maps. */
  readonly project?: string;
  /** The names of the visible ECHO projects mapped to each Jira project, by Jira project id. */
  readonly echo_projects: () => ReadonlyMap<string, readonly string[]>;
}): Promise<PersonLiveEvidenceReaderV1<PersonToolContainerCitationV1>> {
  if (options.project !== undefined && (typeof options.project !== 'string' || !JIRA_ID.test(options.project))) jiraFailure('invalid_request');
  const binding = copyJiraBindingV1(options.binding);
  const bindingDigest = canonicalSha256(binding);
  const { transport } = options;
  const fence = () => { if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('stale_access_state'); };
  if (canonicalSha256(copyJiraBindingV1(transport.binding)) !== bindingDigest) jiraFailure('unauthorized');
  const cloudid = binding.external_scope_id!;
  const apiPrefix = `https://api.atlassian.com/ex/jira/${cloudid}`;
  const pathPrefix = `/ex/jira/${cloudid}/rest/api/3`;
  let origin = options.expected_origin;
  const verification = createAtlassianVerificationBatchV1(async (signal?: AbortSignal) => (await verifyJiraConnectionV1(transport, { signal, expected_origin: origin })).origin);

  function project(raw: unknown): PersonToolContainerV1 {
    const parsed = parseJiraProject(raw, origin!, apiPrefix);
    return Object.freeze({ id: parsed.id, key: parsed.key, name: jiraString(jiraRecord(raw).name, 1024) });
  }
  async function search(query: Readonly<Record<string, string>>, maximum: number, signal?: AbortSignal) {
    const page = jiraRecord(await transport.request({ path: `${pathPrefix}/project/search`, query: { ...query, orderBy: 'key', action: 'browse' }, signal }));
    signal?.throwIfAborted();
    if (typeof page.isLast !== 'boolean') jiraFailure('invalid_output');
    const rows = jiraArray(page.values, maximum);
    const { containers, left_out } = personToolContainerRowsV1(rows, project);
    if (!page.isLast && rows.length === 0) jiraFailure('invalid_output');
    return { containers, left_out, rows: rows.length, last: page.isLast };
  }

  return createPersonToolContainerReaderV1({
    provider: {
      binding, tool: 'Jira', container: 'jira_project', noun: 'Jira project', failure: jiraFailure, fence,
      verify: async signal => (origin = await verification(signal)),
      permalink: (site, value) => `${site}/browse/${value.key}`,
      async page({ cursor, limit, signal }) {
        // The continuation is this reader's own offset, kept inside the request. It counts Jira's rows, those left out
        // too, so the next page starts where Jira's ended.
        const startAt = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(startAt) || startAt < 0) jiraFailure('invalid_request');
        const { containers, left_out, rows, last } = await search({ startAt: String(startAt), maxResults: String(limit) }, limit, signal);
        return { containers, left_out, ...(last ? {} : { next: String(startAt + rows) }) };
      },
      async candidates({ probe, signal }) {
        // A keyword cut to what the transport admits matches every key or name the whole one does; the reader matches the whole query.
        const { containers, left_out, last } = await search({ ...(probe === undefined ? {} : { query: boundUtf8V1(probe, JIRA_PROJECT_QUERY_MAX_BYTES_V1) }), maxResults: String(CANDIDATES_PAGE) }, CANDIDATES_PAGE, signal);
        return { containers, left_out, more: !last };
      },
      async exact(id, signal) {
        const value = project(await transport.request({ path: `${pathPrefix}/project/${id}`, signal }));
        signal?.throwIfAborted();
        return value;
      },
    },
    ...(options.project === undefined ? {} : { pinned: [options.project] }),
    echo_projects: options.echo_projects,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
