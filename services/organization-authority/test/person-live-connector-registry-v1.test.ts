import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { EvidenceSourceCapabilitiesV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceReaderV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { EVIDENCE_ANY_DATE_V1, EVIDENCE_DATE_FIELDS_V1, type EvidenceDateSelectionV1 } from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';
import { createConfluencePersonLiveEvidenceReaderV1 } from '@echo-brain/provider-confluence/confluence-person-live-evidence-reader-v1';
import { createJiraPersonLiveEvidenceReaderV1 } from '@echo-brain/provider-jira/jira-person-live-evidence-reader-v1';
import type { PersonLiveConnectorDefinitionV1 } from '../src/application/ports/person-context-live-runtime-v1.js';
import {
  CONFLUENCE_LIVE_CONNECTOR_V1, CONFLUENCE_PAGE_CAPABILITIES_V1, CONFLUENCE_SPACES_LIVE_CONNECTOR_V1, JIRA_ISSUE_CAPABILITIES_V1, JIRA_LIVE_CONNECTOR_V1,
  JIRA_PROJECTS_LIVE_CONNECTOR_V1, personLiveConnectorDefinitionsV1,
} from '../src/composition/person-live-connector-registry-v1.js';

const CLOUD = '00000000-0000-4000-8000-000000000007';
const SITE = 'https://echo-fixture.atlassian.net';
const binding = (tool_id: string): PersonConnectorReadBindingV1 => Object.freeze({ organization_id: 'org_fixture', principal_id: 'person-fixture', membership_id: 'mem_fixture',
  tool_id, external_scope_id: CLOUD, external_subject_id: 'fixture-account', read_grant_sha256: canonicalSha256({ grant: tool_id }) });
/** Recorded provider responses by path; any other request fails the read. */
const recorded = (tool_id: string, responses: Readonly<Record<string, unknown>>) => ({ binding: binding(tool_id), request: async ({ path }: { readonly path: string }) => {
  if (!(path in responses)) throw new Error(`Unrecorded provider request: ${path}`);
  return responses[path];
} });

/** One Jira issue that records every date Jira has. */
function jiraReader() {
  const prefix = `/ex/jira/${CLOUD}/rest/api/3`;
  const issue = { id: '10001', key: 'ECHO-1', self: `${SITE}/rest/api/3/issue/10001`, fields: { summary: 'Ship on Friday', status: { name: 'Open' }, assignee: null,
    project: { id: '10000', key: 'ECHO', self: `${SITE}/rest/api/3/project/10000` }, created: '2026-10-01T12:00:00.000Z', updated: '2026-10-02T12:00:00.000Z', duedate: '2026-10-03' } };
  return createJiraPersonLiveEvidenceReaderV1({ binding: binding('jira'), transport: recorded('jira', {
    '/oauth/token/accessible-resources': [{ id: CLOUD, url: SITE, scopes: ['read:jira-work', 'read:jira-user'] }],
    [`${prefix}/myself`]: { accountId: 'fixture-account', active: true, accountType: 'atlassian' },
    [`${prefix}/search/jql`]: { isLast: true, issues: [{ id: '10001' }] },
    [`${prefix}/issue/bulkfetch`]: { issues: [issue], issueErrors: [] },
  }) });
}
/** One Confluence page that records every date Confluence has. */
function confluenceReader() {
  const page = { id: '123', spaceId: '42', title: 'ECHO MRD', status: 'current', createdAt: '2026-10-01T12:00:00.000Z', version: { number: 3, createdAt: '2026-10-02T12:00:00.000Z' } };
  return createConfluencePersonLiveEvidenceReaderV1({ binding: binding('confluence'), transport: recorded('confluence', {
    '/oauth/token/accessible-resources': [{ id: CLOUD, url: SITE, scopes: ['read:page:confluence', 'read:space:confluence', 'search:confluence', 'read:confluence-user'] }],
    '/rest/api/user/current': { accountId: 'fixture-account', type: 'known', accountType: 'atlassian' },
    '/api/v2/pages': { results: [page] },
    '/api/v2/pages/123': page,
    '/rest/api/search': { results: [{ content: { id: '123', type: 'page' } }] },
  }) });
}

/** The reader applies a window, listed or searched, on exactly the dates its source declares, and its items carry exactly those dates. */
async function expectReaderHonors(reader: PersonLiveEvidenceReaderV1, capabilities: EvidenceSourceCapabilitiesV1) {
  const declared = new Set<EvidenceDateSelectionV1>([...Object.keys(capabilities.dates) as EvidenceDateSelectionV1[], ...(capabilities.any_date ? [EVIDENCE_ANY_DATE_V1] : [])]);
  for (const date_field of [...EVIDENCE_DATE_FIELDS_V1, EVIDENCE_ANY_DATE_V1]) {
    const dated = { since: '2026-10-01', until: '2026-10-03', date_field, limit: 5 };
    for (const read of [() => reader.list(dated), () => reader.search({ ...dated, query: 'ECHO' })]) {
      if (declared.has(date_field)) expect((await read()).items, date_field).toHaveLength(1);
      else await expect(read(), date_field).rejects.toMatchObject({ code: 'invalid_request' });
    }
  }
  const [item] = (await reader.list({ limit: 5 })).items;
  expect(Object.keys(item!.dates ?? {}).sort()).toEqual(Object.keys(capabilities.dates).sort());
}

const open: PersonLiveConnectorDefinitionV1['open'] = () => { throw new Error('A registration test never opens a connector'); };
const register = (...entries: readonly unknown[]) => personLiveConnectorDefinitionsV1({ live_connectors: entries as readonly PersonLiveConnectorDefinitionV1[] });

describe('live connector registrations (research tool contract v1)', () => {
  it('holds the Jira and Confluence readers to the dates their sources declare', async () => {
    await expectReaderHonors(await jiraReader(), JIRA_ISSUE_CAPABILITIES_V1);
    await expectReaderHonors(await confluenceReader(), CONFLUENCE_PAGE_CAPABILITIES_V1);
  });

  it('registers Jira projects and Confluence spaces as tool containers for the V8 answer only', () => {
    const containers = [JIRA_PROJECTS_LIVE_CONNECTOR_V1, CONFLUENCE_SPACES_LIVE_CONNECTOR_V1].map(entry => ({ ...entry, open }));
    expect(register({ ...JIRA_LIVE_CONNECTOR_V1, open }, { ...CONFLUENCE_LIVE_CONNECTOR_V1, open }, ...containers)
      .map(({ descriptor, scopes, minimum_response_version }) => [descriptor.source_id, descriptor.selector, descriptor.kind, descriptor.tool_id, scopes, minimum_response_version]))
      .toEqual([
        ['jira', 'tickets', 'ticket', 'jira', ['global', 'project'], 5],
        ['confluence', 'pages', 'page', 'confluence', ['global', 'project'], 6],
        ['jira_projects', 'jira_projects', 'tool_container', 'jira', ['global', 'project'], 8],
        ['confluence_spaces', 'confluence_spaces', 'tool_container', 'confluence', ['global', 'project'], 8],
      ]);
  });

  it('refuses a container an earlier answer would be asked to cite, or one that declares no capabilities', () => {
    const jira = { ...JIRA_PROJECTS_LIVE_CONNECTOR_V1, open };
    for (const minimum_response_version of [5, 6, 7]) expect(() => register({ ...jira, minimum_response_version })).toThrow('Live connector registration is invalid');
    const { capabilities: _capabilities, ...bare } = jira.descriptor;
    expect(() => register({ ...jira, descriptor: bare })).toThrow('Live connector registration is invalid');
    expect(() => register({ ...JIRA_LIVE_CONNECTOR_V1, open, minimum_response_version: 7 })).toThrow('Live connector registration is invalid');
  });
});
