import { once } from 'node:events';
import { vi } from 'vitest';
import { PERSON_ASK_PROGRESS_HEADER_V1 } from '@echo-brain/organization-api';
import type { StructuredGenerationPort } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import type { PersonLiveEvidenceSourceV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { SqlitePersonAgenticAskAuditV1 } from '../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { SqlitePersonOriginalContextRetrievalV1 } from '../../src/adapters/persistence/sqlite/person-original-context-retrieval-v1.js';
import { SqlitePersonSessionRepository } from '../../src/adapters/persistence/sqlite/sqlite-person-session-repository.js';
import { JIRA_LIVE_CONNECTOR_V1 } from '../../src/composition/person-live-connector-registry-v1.js';
import type { CreatePersonLiveAnswerRouteOptionsV1 } from '../../src/composition/person-live-answer-route-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../../src/composition/person-record-search-route.js';
import { createOrganizationAuthorityHttpServer } from '../../src/presentation/organization-authority-http-server.js';
import type { FixturePerson, OpenItemsFixtureV1 } from './open-items.js';

/** The streamed Ask routes over HTTP, behind the real server, over the open-items Authority state (ADR-0039, ADR-0040). */

type Server = ReturnType<typeof createOrganizationAuthorityHttpServer>;
const servers: Server[] = [];
const empty = Object.freeze({ items: Object.freeze([]), truncated: false, receipt_digests: Object.freeze([]) });

/** Closes every server a test started; each test file runs it after each test. */
export async function closeAskServers(): Promise<void> {
  for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}

/** The live Ask's options as the runtime composes them: Jira opened as the fixture's desk opens it, and the follow-up sources. */
export function liveAskOptions(f: OpenItemsFixtureV1, model: StructuredGenerationPort): CreatePersonLiveAnswerRouteOptionsV1 {
  const sessions = f.openItemsOptions.sessions;
  const jira = (name: FixturePerson): PersonLiveEvidenceSourceV1 => ({
    tool_id: 'jira', search: vi.fn(async () => empty as never), open: vi.fn(async () => empty as never), list: vi.fn(async () => empty as never),
    openCitation: vi.fn(async ({ citation }) => f.openCitation(name, citation as never) as never), revalidate: vi.fn(async () => {}), assertCurrent: vi.fn(() => {}),
  });
  const repository = new SqlitePersonSessionRepository(f.db);
  return {
    authority_id: 'authority', organization_id: f.person.organization_id, state_lineage_id: 'lineage',
    sessions: sessions as never, originals: new SqlitePersonOriginalContextRetrievalV1(f.db, sessions, f.person.organization_id),
    records: { initializeDesk() { throw new PersonRecordSearchIndexLagV1(); } } as never,
    model, generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 1_000 },
    audit: new SqlitePersonAgenticAskAuditV1(f.db),
    memberships: { membership: (id: string) => repository.read(transaction => transaction.membership(id)) },
    live_sources: [{ ...JIRA_LIVE_CONNECTOR_V1, application: { source: async ({ access_token }) => jira(access_token as FixturePerson) } }],
    follow_ups: { runs: f.runs, items: f.items, people: f.directory, records: f.records, on_live_failure: () => {} },
  };
}

/** Serves the given person routes behind the real server; its origin. */
export async function serveAsk(routes: Omit<Parameters<typeof createOrganizationAuthorityHttpServer>[0], 'descriptor' | 'sessions' | 'oidc_provider' | 'expected_issuer'>): Promise<string> {
  const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', ...routes });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

/** A client's Ask of `question` on `path`, asking for `progress` unless told otherwise; `progress: null` sends no progress header. */
export function askClient(defaults: { readonly path: string; readonly progress: string; readonly question: string }) {
  return (base: string, input: { readonly path?: string; readonly progress?: string | null; readonly token?: FixturePerson | 'stranger'; readonly mine?: true } = {}) => fetch(`${base}${input.path ?? defaults.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.token ?? 'mina'}`,
      ...(input.progress === null ? {} : { [PERSON_ASK_PROGRESS_HEADER_V1]: input.progress ?? defaults.progress }) },
    body: JSON.stringify({ schema_version: 3, question: defaults.question, ...(input.mine === true ? { mine: true } : {}) }),
  });
}

/** Every event of a whole progress stream. */
export function decodeAll<E>(decoder: { push(text: string): Iterable<E>; end(): unknown }, text: string): readonly E[] {
  const events = [...decoder.push(text)];
  decoder.end();
  return events;
}

/** The bodies of the Ask's audit rows of one kind, in the order they were written. */
export const auditBodies = (f: OpenItemsFixtureV1, kind: string) => (f.db.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE context_kind = 'answer_composition'").all() as { body_json: string }[])
  .map(row => JSON.parse(row.body_json) as Record<string, unknown>).filter(body => body.kind === kind);
