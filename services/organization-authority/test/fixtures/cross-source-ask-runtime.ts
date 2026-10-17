import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { liveSourceDescriptorV2 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { startOrganizationAuthorityApiRuntime } from '../../src/composition/organization-authority-api-runtime.js';
import { openJiraPersonLiveRuntimeV1 } from '../../src/composition/jira-person-live-runtime-v1.js';
import { LEGACY_TICKET_CONNECTOR_V1 } from '../../src/composition/person-live-connector-registry-v1.js';
import { createPersonDocumentApplicationV1 } from '../../src/application/document-v1.js';
import { SqlitePersonDocumentRepositoryV1 } from '../../src/adapters/persistence/sqlite/document-v1.js';
import { ownerGenesis, port, signInHttpSession, syntheticOidcProvider } from './owner-session.js';
import { crossSourceLiveFixture, JIRA_TEXT, SLACK_TEXT } from './cross-source-live-fixture.js';
import { seedCrossSourceRecords } from './cross-source-record-fixture.js';
import { authorization } from './project-context-sqlite.js';
import { FIXTURE_JIRA_CLOUD_V1 } from './fake-jira-v1.js';

/**
 * One real Authority runtime for cross-source Ask: the owner genesis, a
 * synthetic OIDC sign-in, approved Granola records, a document, Jira through
 * the real Jira reader and Slack, behind a scripted research model. Shared by
 * the cross-source HTTP proofs and the Ask progress round trip.
 */

// No production root registers a Slack live connector; these fixtures exercise the slack_message live kind.
export const SLACK_LIVE_CONNECTOR = Object.freeze({
  descriptor: liveSourceDescriptorV2({ source: 'slack' }),
  scopes: Object.freeze(['global'] as const), minimum_response_version: 5 as const,
});
export const AUTHORITY = 'https://authority.example.test';
const EMAIL = 'cross-source@example.test';
const OIDC = { issuer: 'https://issuer.example.test', client_id: 'cross-source-client', redirect_uri: `${AUTHORITY}/v2/session/oidc/callback`, tenant: { kind: 'issuer' as const }, id_token_algorithms: ['RS256'] };

/** A fresh owner genesis and its runtime configuration; its state directory is pushed to `owned` for the caller to remove. */
export async function crossSourceAuthorityFixture(owned: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-cross-source-ask-')));
  chmodSync(root, 0o700); owned.push(root);
  const owner = ownerGenesis({ root, oidc: OIDC, email: EMAIL, authority_url: AUTHORITY, revision: 'cross-source-http-test' });
  const initialized = owner.initialized;
  const oidc = syntheticOidcProvider(OIDC, () => EMAIL);
  const config = { state_directory: initialized.state_directory, host: '127.0.0.1' as const, port: await port(), authority_url: AUTHORITY, oidc: OIDC, client_authentication: { method: 'none' as const }, pkce_sealing_key: owner.pkce };
  const login = async (origin: string) => (await signInHttpSession(origin, oidc, owner.login_grant)).access_token;
  const signIn = (origin: string) => signInHttpSession(origin, oidc, owner.login_grant);
  return { initialized, config, oidc, login, signIn };
}

/** The runtime's Authority database, as the proofs read its audit rows. */
export interface CrossSourceAuthorityDatabaseV1 {
  prepare(sql: string): { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown };
  close(): void;
}

export const DOCUMENT_TEXT = 'Launchscope document: the rollout starts with the pilot group.';
export const PRIVATE_DOCUMENT_TEXT = 'Launchscope private document DENIED-DOCUMENT-8137.';
/** What the planner says it still needs: private research state that never leaves the Authority. */
export const CROSS_SOURCE_NEED = 'cross-source launch status';
type PromptItem = { readonly id: string; readonly text?: string; readonly title?: string; readonly full?: boolean };
type Prompt = { readonly question: string; readonly step?: number; readonly last_results?: readonly { readonly results?: readonly string[] }[]; readonly opened?: readonly PromptItem[]; readonly seen?: readonly PromptItem[]; readonly evidence?: readonly PromptItem[] };

/**
 * The runtime with every source: it searches "Launchscope", opens what it
 * found only in part, finishes on all of it, and writes one sentence per
 * evidence item. `notes` is the planner's private note on every call.
 * `beforeAnswerReturn` runs inside the writer's model call, awaited.
 */
export async function allSourceAskFixture(owned: string[], options: { readonly notes?: string } = {}) {
  const f = await crossSourceAuthorityFixture(owned);
  const seeded = await seedCrossSourceRecords(f.initialized.state_directory, f.initialized);
  const database = openAuthorityDatabase(join(f.initialized.state_directory, 'authority.sqlite'), { fileMustExist: true });
  const repository = new SqlitePersonDocumentRepositoryV1(database);
  for (const [actor, text, audience] of [
    [{ organization_id: f.initialized.organization_id, principal_id: f.initialized.owner_principal_id, membership_id: f.initialized.owner_membership_id, membership_type: 'owner' as const }, DOCUMENT_TEXT, 'team'],
    [seeded.hidden_actor, PRIVATE_DOCUMENT_TEXT, 'only_me'],
  ] as const) {
    const documents = createPersonDocumentApplicationV1({ repository, authenticate: () => authorization(actor) });
    const bytes = Buffer.from(text);
    documents.upload('synthetic-seed', { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: randomUUID(), filename: 'launchscope.md', title: 'Launchscope document', content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: audience }, project_id: null }, bytes);
    const claim = repository.claimExtraction();
    if (claim === undefined) throw new Error('Missing synthetic document extraction claim');
    expect(repository.completeExtraction(claim, { status: 'ready', sourceSha256: claim.source_sha256, extractorVersion: 'cross-source-fixture-v1', chunks: [{ anchor_kind: 'paragraph', anchor_start: 1, text }], message: null })).toBe(true);
  }
  const live = crossSourceLiveFixture(f.initialized);
  const prompts: string[] = [];
  const notes = options.notes ?? '';
  let beforeAnswerReturn: (() => void | Promise<void>) | undefined;
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    prompts.push(input.user_prompt);
    expect(input.user_prompt).not.toContain(seeded.hidden_text);
    expect(input.user_prompt).not.toContain(seeded.unapproved_text);
    expect(input.user_prompt).not.toContain(PRIVATE_DOCUMENT_TEXT);
    const prompt = JSON.parse(input.user_prompt) as Prompt;
    if ((input.schema.properties as Record<string, unknown>).sentences !== undefined) {
      await beforeAnswerReturn?.();
      return { sentences: (prompt.evidence ?? []).map(item => ({ text: item.text!, evidence: [item.id] })), not_found: [] };
    }
    // A result names its items by id; their details are in seen.
    const returned = new Set(prompt.last_results?.flatMap(result => result.results ?? []));
    const hits = prompt.opened?.length ? [...prompt.opened, ...(prompt.seen ?? [])] : (prompt.seen ?? []).filter(item => returned.has(item.id));
    if (hits.length > 0) {
      const rows = database.prepare("SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-live-evidence-release-audit-v1%'").all() as { body_json: string }[];
      // Every provider passage has crossed the real durable release boundary before the next model call.
      if (input.user_prompt.includes(JIRA_TEXT)) expect(rows.some(row => row.body_json.includes('"tool_id":"jira"'))).toBe(true);
      if (input.user_prompt.includes(SLACK_TEXT)) expect(rows.some(row => row.body_json.includes('"tool_id":"slack"'))).toBe(true);
      const unopened = hits.filter(item => item.text === undefined && item.full !== true);
      if (unopened.length > 0) return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: 'open', evidence: [] }], notes }], actions: unopened.slice(0, 4).map(item => ({ tool: 'open', args: { id: item.id } })) };
      return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: 'found', evidence: hits.map(item => item.id) }], notes }], actions: [{ tool: 'finish', args: {} }] };
    }
    return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: prompt.step === 1 ? 'open' : 'not_found', evidence: [] }], notes }], actions: prompt.step === 1 ? [{ tool: 'search', args: { query: 'Launchscope' } }] : [{ tool: 'finish', args: {} }] };
  });
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, {
    oidc_provider: f.oidc,
    live_connectors: [
      { ...LEGACY_TICKET_CONNECTOR_V1, open: sessions => openJiraPersonLiveRuntimeV1({ state_directory: f.initialized.state_directory, sessions,
        configuration: { enabled: true, cloud_id: FIXTURE_JIRA_CLOUD_V1, integration_id: 'jira', nango_authorization: () => 'synthetic-only-nango-authorization' }, seams: { nango: live.jira.nango, fetch: live.jiraFetch } }) },
      { ...SLACK_LIVE_CONNECTOR, open: live.slackFactory },
    ],
    answer_composition_generation: { structured_output: { generate }, generation: { generation_adapter_id: 'synthetic', planner_model: 'synthetic', answer_model: 'synthetic', timeout_ms: 25_000 } },
  });
  const origin = `http://127.0.0.1:${runtime.address.port}`;
  const session = await f.signIn(origin);
  const token = session.access_token;
  const post = async (path: string, body: unknown, bearer = token) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const connect = await post('/v1/person/tools/jira/connect', { schema_version: 1 });
  expect(connect.status).toBe(201); live.jira.finish();
  expect(await post('/v1/person/tools/jira/status', { schema_version: 1, attempt: connect.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
  const ask = () => post('/v4/person/ask', { schema_version: 3, question: 'Combine the Launchscope approved meeting, document, Jira ticket, and Slack message.' });
  return { ...f, seeded, database: database as CrossSourceAuthorityDatabaseV1, live, prompts, generate, post, ask, origin, session,
    beforeAnswerReturn(callback: () => void | Promise<void>) { beforeAnswerReturn = callback; },
    async close() { await runtime.close(); database.close(); } };
}
