import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { canonicalJson, canonicalSha256, sha256Digest, type Sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import { derivedAtomIdentity } from '../../../../packages/organization-record/src/application/atom-identity.js';
import { storableImpactCardV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { startOrganizationAuthorityApiRuntime } from '../../src/composition/organization-authority-api-runtime.js';
import { openConfluencePersonLiveRuntimeV1 } from '../../src/composition/confluence-person-live-runtime-v1.js';
import { openJiraPersonLiveRuntimeV1 } from '../../src/composition/jira-person-live-runtime-v1.js';
import { CONFLUENCE_LIVE_CONNECTOR_V1, JIRA_LIVE_CONNECTOR_V1 } from '../../src/composition/person-live-connector-registry-v1.js';
import { createPersonDocumentApplicationV1 } from '../../src/application/document-v1.js';
import { SqlitePersonDocumentRepositoryV1 } from '../../src/adapters/persistence/sqlite/document-v1.js';
import { SqliteImpactItemsV1 } from '../../src/adapters/persistence/sqlite/impact-items-v1.js';
import { SqliteTriggerRunsV1 } from '../../src/adapters/persistence/sqlite/trigger-runs-v1.js';
import { ownerGenesis, port, signInHttpSession, syntheticOidcProvider } from './owner-session.js';
import { CONFLUENCE_TEXT, crossSourceLiveFixture, JIRA_TEXT } from './cross-source-live-fixture.js';
import { seedCrossSourceRecords } from './cross-source-record-fixture.js';
import { authorization } from './project-context-sqlite.js';
import { FIXTURE_CONFLUENCE_CLOUD_V1 } from './fake-confluence-v1.js';
import { FIXTURE_JIRA_CLOUD_V1 } from './fake-jira-v1.js';

/**
 * One real Authority runtime for cross-source Ask: the owner genesis, a
 * synthetic OIDC sign-in, approved Granola records, a document, and Jira and
 * Confluence through their real readers, behind a scripted research model.
 * Shared by the cross-source HTTP proofs and the Ask progress round trip.
 */

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
interface CrossSourceAuthorityDatabaseV1 {
  prepare(sql: string): { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown };
  close(): void;
}

export const DOCUMENT_TEXT = 'Launchscope document: the rollout starts with the pilot group.';
export const PRIVATE_DOCUMENT_TEXT = 'Launchscope private document DENIED-DOCUMENT-8137.';
/** What the planner says it still needs: private research state that never leaves the Authority. */
export const CROSS_SOURCE_NEED = 'cross-source launch status';
type PromptItem = { readonly id: string; readonly text?: string; readonly title?: string; readonly full?: boolean };
type PromptResult = { readonly tool?: string; readonly args?: { readonly id?: string }; readonly results?: readonly string[] };
type Prompt = { readonly question: string; readonly step?: number; readonly last_results?: readonly PromptResult[]; readonly opened?: readonly PromptItem[]; readonly seen?: readonly PromptItem[]; readonly evidence?: readonly PromptItem[] };

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
    documents.uploadV2('synthetic-seed', { schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: randomUUID(), filename: 'launchscope.md', title: 'Launchscope document', content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: audience }, association_project_ids: [] }, bytes);
    const claim = repository.claimExtraction();
    if (claim === undefined) throw new Error('Missing synthetic document extraction claim');
    expect(repository.completeExtraction(claim, { status: 'ready', sourceSha256: claim.source_sha256, extractorVersion: 'cross-source-fixture-v1', chunks: [{ anchor_kind: 'paragraph', anchor_start: 1, text }], message: null })).toBe(true);
  }
  const live = crossSourceLiveFixture();
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
      if (input.user_prompt.includes(CONFLUENCE_TEXT)) expect(rows.some(row => row.body_json.includes('"tool_id":"confluence"'))).toBe(true);
      // A page opens as its sections, so its listed row stays without text: what the last step opened is never opened again.
      const justOpened = new Set(prompt.last_results?.flatMap(result => result.tool === 'open' && result.args?.id !== undefined ? [result.args.id] : []));
      const unopened = hits.filter(item => item.text === undefined && item.full !== true && !justOpened.has(item.id));
      if (unopened.length > 0) return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: 'open', evidence: [] }], notes }], actions: unopened.slice(0, 4).map(item => ({ tool: 'open', args: { id: item.id } })) };
      return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: 'found', evidence: hits.map(item => item.id) }], notes }], actions: [{ tool: 'finish', args: {} }] };
    }
    return { parts: [{ question: prompt.question, needs: [{ need: CROSS_SOURCE_NEED, status: prompt.step === 1 ? 'open' : 'not_found', evidence: [] }], notes }], actions: prompt.step === 1 ? [{ tool: 'search', args: { query: 'Launchscope' } }] : [{ tool: 'finish', args: {} }] };
  });
  const runtime = await startOrganizationAuthorityApiRuntime(f.config, {
    oidc_provider: f.oidc,
    live_connectors: [
      { ...JIRA_LIVE_CONNECTOR_V1, open: sessions => openJiraPersonLiveRuntimeV1({ state_directory: f.initialized.state_directory, sessions,
        configuration: { enabled: true, cloud_id: FIXTURE_JIRA_CLOUD_V1, integration_id: 'jira', nango_authorization: () => 'synthetic-only-nango-authorization' }, seams: { nango: live.jira.nango, fetch: live.jiraFetch } }) },
      { ...CONFLUENCE_LIVE_CONNECTOR_V1, open: sessions => openConfluencePersonLiveRuntimeV1({ state_directory: f.initialized.state_directory, sessions,
        configuration: { enabled: true, cloud_id: FIXTURE_CONFLUENCE_CLOUD_V1, integration_id: 'confluence', nango_authorization: () => 'synthetic-only-nango-authorization' }, seams: { nango: live.confluence.nango, fetch: live.confluenceFetch } }) },
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
  for (const [tool, nango] of [['jira', live.jira], ['confluence', live.confluence]] as const) {
    const connect = await post(`/v1/person/tools/${tool}/connect`, { schema_version: 1 });
    expect(connect.status).toBe(201); nango.finish();
    expect(await post(`/v1/person/tools/${tool}/status`, { schema_version: 1, attempt: connect.body.attempt })).toMatchObject({ status: 200, body: { status: 'complete' } });
  }
  // Ask, `/v7`: the V8 answer.
  const ask = () => post('/v7/person/ask', { schema_version: 3, question: 'Combine the Launchscope approved meeting, document, Jira ticket, and Confluence page.' });
  /**
   * One open follow-up (ADR-0033) on the approved Launchscope meeting, as its
   * impact check finds it and the owner, who approved the meeting, sends it to
   * themselves: one of the meeting's own actions, whose title is `expected`.
   * Ask finds it by those words, which ECHO holds, and reads nothing live for it.
   */
  const followUp = (expected: string): string => {
    const db = database as unknown as Database.Database;
    const runs = new SqliteTriggerRunsV1(db);
    const items = new SqliteImpactItemsV1(db);
    const owner = { organization_id: f.initialized.organization_id, principal_id: f.initialized.owner_principal_id, membership_id: f.initialized.owner_membership_id };
    const record_sha256 = seeded.approved_record_sha256;
    if (runs.impactRunsFor([record_sha256]).length === 0) {
      // These records are appended without the approval core, so no published approval stands behind the impact check's run.
      // Its guard is lifted for this one insert and restored, unchanged, before the transaction commits.
      const guard = 'authority_trigger_run_approved_record_v1';
      db.transaction(() => {
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").pluck().get(guard) as string;
        db.exec(`DROP TRIGGER ${guard}`);
        runs.enqueueApprovedRecord(db, { approval_id: seeded.approved_approval_id, proposal_approval_id: 'cross-source-public', record_sha256, reviewer: owner, decided_at: new Date().toISOString() });
        db.exec(sql);
      })();
    }
    const run = runs.impactRunsFor([record_sha256])[0]!;
    const claim = runs.claim(owner, run.run_id, 60_000);
    if (claim.kind !== 'claimed') throw new Error(`The impact check was not claimed: ${claim.kind}`);
    // The seeded record is the owner's own (Only me).
    const decision = { citation: { kind: 'approved_record' as const, atom_id: derivedAtomIdentity(record_sha256, 'd1') as Sha256Digest, record_sha256, policy_id: 'restricted-reviewer-person-v2' as const },
      kind: 'decision' as const, label: 'Launchscope', visibility: 'approver_only' as const };
    const card = storableImpactCardV1({ status: 'assessed', decided: [{ text: 'Launchscope rolls out to the pilot group first.', citation_index: 0 }], affected: [], unconfirmed: [], people: [], citations: [decision] }, []);
    const pointer = { kind: 'meeting_action', record_sha256, signal_id: 'a1' };
    const finished = runs.finish(run.run_id, claim.lease_token, { json: canonicalJson(card), sha256: canonicalSha256(card) }, transaction => items.insertForRun(transaction, run, [{
      item_key: canonicalSha256(pointer), pointer, relation: 'needs_updating', expected, owner_membership_id: owner.membership_id, owner_match: 'name',
    }]));
    if (!finished) throw new Error('The impact check did not finish');
    const [item] = items.forRun(run.run_id);
    expect(items.send({ run_id: run.run_id, by: owner.membership_id, command_id: 'send-follow-up', choices: [{ item_id: item!.item_id, include: true }] })).toMatchObject({ kind: 'sent', sent: 1 });
    return item!.item_id;
  };
  return { ...f, seeded, database: database as CrossSourceAuthorityDatabaseV1, live, prompts, generate, post, ask, origin, session, followUp,
    beforeAnswerReturn(callback: () => void | Promise<void>) { beforeAnswerReturn = callback; },
    async close() { await runtime.close(); database.close(); } };
}
