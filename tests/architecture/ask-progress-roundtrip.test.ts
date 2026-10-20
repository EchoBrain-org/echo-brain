import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  validatePersonAskProgressLineV3, validatePersonAskProgressResultLineV3, validatePersonAskProgressStepEventV1, validatePersonRunsRequestV1, validatePersonRunsResultV1,
  type PersonAnswerCitationV8, type PersonAskProgressStepEventV3,
} from '@echo-brain/organization-api';
import { derivedAtomIdentity } from '@echo-brain/organization-record/application/atom-identity';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import {
  allSourceAskFixture, AUTHORITY, CROSS_SOURCE_NEED, DOCUMENT_TEXT, PRIVATE_DOCUMENT_TEXT,
} from '../../services/organization-authority/test/fixtures/cross-source-ask-runtime.js';
import { JIRA_TEXT, SLACK_TEXT } from '../../services/organization-authority/test/fixtures/cross-source-live-fixture.js';

// Ask progress and internal links v1 (ADR-0039), end to end, where the root
// build is: the real Authority runtime streams a scripted research run; the
// real Person client runs `ask --live --progress` against it exactly as the
// desktop host runs it; the host's own line reader turns the printed lines
// into page notices; and the desktop's store takes them, then the answer, and
// opens what Ask named. A change on any of the three sides meets the others.
// The client asks /v7 first (the V8 answer, research tool contract v1); here
// each Authority is one from before /v7, which answers it with a 404 without
// the route header. So the client streams the V7 answer on /v6 (progress V2,
// ADR-0040), whose Ask may cite a follow-up, and falls back to V1 on /v5 for
// an Authority without /v6 either, as an older one answers.
//
// The desktop's modules are loaded by path, as approval-proposal-roundtrip
// loads the Authority's: the root typecheck never reads the app (its DOM and
// preact types), and preact itself, which only the store's view hook uses, is
// stood in for when the app's own dependencies are not installed.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../product/echo-desktop/src/renderer/api.js', () => ({ rpc, on: vi.fn(), dropFile: vi.fn() }));
vi.mock('preact/hooks', () => ({ useEffect: () => undefined, useState: (value: unknown) => [value, () => undefined] }));

const DESKTOP = resolve(import.meta.dirname, '../../product/echo-desktop/src');
const desktop = <T>(path: string): Promise<T> => import(/* @vite-ignore */ join(DESKTOP, path)) as Promise<T>;

type Json = Record<string, unknown>;
type Scope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly project_id: string } | { readonly kind: 'mine' };
type Expect = { readonly authority: string; readonly membership_id: string };
interface CliRun { readonly exit: number; readonly stdout: string; readonly stderr: string; readonly overflow: boolean }
type Source = Json & { readonly kind: 'record' | 'original' | 'transcript' | 'follow_up' | 'ticket' | 'page' | 'slack' | 'project' | 'person' | 'tool' | 'container'; readonly label: string };
interface Row { readonly type: 'searched' | 'read'; readonly sources?: readonly Json[]; readonly found?: number; readonly items?: readonly Source[] }
interface Progress { readonly started: number; readonly stage: string | null; readonly pending: number; readonly rows: readonly Row[] }
interface Receipt { readonly looked_through: number; readonly elapsed_ms: number; readonly rows: readonly Row[] }
interface Notice { readonly cancel_id: string; readonly expect: Expect; readonly step: Json }
interface Store {
  refreshStatus(): Promise<void>;
  ask(question: string, scope?: Scope): Promise<void>;
  askProgress(notice: Notice): void;
  cancelAsk(): void;
  openNamed(items: readonly Source[]): void;
  fullPageOffered(): boolean;
  openFullPage(): void;
  followUpShown(): { kind: string; item_id?: string; item?: Json | null } | null;
  getState(): {
    ask:{ asking: { progress: Progress } | null; shown: { answer: { sources: readonly Source[]; receipt?: Receipt }; receipt?: Receipt; took?: number } | null; failed: unknown } | null;
    sources: { records: Record<string, { loading: boolean; value?: { decisions: { items: { atom_id?: string; text: string }[] } } }>;
      evidence: { reads: Record<number, { loading: boolean; value?: { text: string } }> } | null;
      followUps: Record<string, { loading: boolean; value?: { item_id: string; state: string; owner: { membership_id: string; name: string }; expected: string | null } }> } | null;
  };
}
interface Views {
  answerView(raw: unknown, scope: Scope): Json; recordView(raw: unknown, asked: Json): Json; evidenceView(raw: unknown): Json; atomId(record: string, signal: string): string;
  openItemView(item: unknown): Json;
}
interface ProgressView { PROGRESS_AFTER_MS: number; searchedWords(row: Row): string }
const ok = (value: unknown) => ({ ok: true, value });
const flush = async (turns = 30) => { for (let i = 0; i < turns; i += 1) await Promise.resolve(); };
const QUESTION = 'Combine the Launchscope approved meeting, document, Jira ticket, and Slack message.';
const NOTE = 'Private planner note: weigh the Jira review against Slack.';
const ASK_AUDIT = "SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-agentic-ask-audit-v1%'";
const commitment = (item: PersonAnswerCitationV8) => canonicalSha256(item.citation);

/** Every object key anywhere in a value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { into.add(key); keysOf(item, into); }
  return into;
}
/** What a progress line may never carry, by key: research state, queries, bodies, ids, rounds, the answer or its receipt. */
const NEVER_KEYS = ['query', 'jql', 'notes', 'note', 'needs', 'need', 'plan', 'actions', 'text', 'body', 'excerpt', 'excerpts', 'evidence', 'id', 'short', 'round',
  'rounds', 'handle', 'receipt', 'receipt_sha256', 'response', 'error', 'result', 'looked_through', 'elapsed_ms'];

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The all-source Authority, a Person client signed in to it, and the
 * desktop's host and page on top: each page call the proof makes runs the
 * client command the host would, through the host's own views and line
 * reader, and every step the reader posts goes to the page's store.
 */
/** `route`: the newest Ask route the Authority has; one before /v7 answers it with a 404. */
async function app(options: { readonly route?: '/v6' | '/v5' } = {}) {
  const f = await allSourceAskFixture(roots, { notes: NOTE });
  const [{ runCli, lastJson }, ask, views, { askText }, progress, { openerOf }] = await Promise.all([
    desktop<{ runCli(cli: unknown, argv: readonly string[], dependencies: Json, onLine?: (line: string) => void): Promise<CliRun>; lastJson(text: string): unknown }>('host/cli.ts'),
    desktop<{
      askArgv(text: string, scope: Scope, expect: Expect): string[]; askRecordArgv(record: Json): string[]; askSourceArgv(ref: Json, scope: Scope): string[];
      askProgressLines(cancelId: string, expect: Expect, signal: AbortSignal, post: (notice: Notice) => void, refused?: () => void): (line: string) => void;
    }>('host/ask.ts'),
    desktop<Views>('host/views.ts'),
    desktop<{ askText(text: string): string }>('shared/query.ts'),
    desktop<ProgressView>('renderer/progress.ts'),
    desktop<{ openerOf(source: Source): { pane: string; meeting?: string; page: { kind: string; ref: Json } | null } }>('renderer/openers.ts'),
  ]);

  // The Person client, signed in with the session the Authority issued, reaching it over loopback HTTP.
  const home = join(roots[0]!, 'person-home');
  mkdirSync(home, { mode: 0o700 });
  new PersonSessionStore(home).install(AUTHORITY, f.initialized.authority_id, f.session);
  const asked: string[] = [];
  const loopback: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(AUTHORITY);
    if (url.pathname.endsWith('/person/ask')) asked.push(url.pathname);
    // An Authority from before /v7, and from before /v6 for the /v5 proof, has no such route: a 404 without the route header.
    if (url.pathname === '/v7/person/ask' || (options.route === '/v5' && url.pathname === '/v6/person/ask')) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'request failed' } }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    return fetch(`${f.origin}${url.pathname}${url.search}`, init);
  };
  const client = { home_directory: home, fetch: loopback };
  const account: Expect = { authority: AUTHORITY, membership_id: f.session.membership_id };

  const lines: string[] = [];
  const notices: Notice[] = [];
  const refused = vi.fn();
  const runs: CliRun[] = [];
  /** The host's live Asks, by the page's cancel id. */
  const asks = new Map<string, AbortController>();
  let store!: Store;
  // As the host's forAccount does: output its view refuses is a failure the page shows, never a throw.
  const viewed = (run: CliRun, view: (raw: unknown) => Json) => {
    try { return run.exit === 0 ? ok(view(lastJson(run.stdout))) : { ok: false, failure: { code: 'failed', retryable: false } }; }
    catch { return { ok: false, failure: { code: 'invalid_output', retryable: true } }; }
  };
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: Json) => {
    expect(params.expect ?? account).toEqual(account);
    if (method === 'ask.run') {
      const scope = params.scope as Scope;
      const abort = new AbortController();
      asks.set(params.cancel_id as string, abort);
      const read = ask.askProgressLines(params.cancel_id as string, account, abort.signal, notice => { notices.push(notice); store.askProgress(notice); }, refused);
      const run = await runCli(runPersonClientCli, ask.askArgv(askText(params.question as string), scope, account), { ...client, abort_signal: abort.signal },
        line => { lines.push(line); read(line); });
      runs.push(run);
      if (run.exit !== 0) return { ok: false, failure: { code: abort.signal.aborted ? 'cancelled' : 'failed', retryable: true } };
      // The page counts the Ask's time by its own clock; this one took long enough to keep its receipt.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now + progress.PROGRESS_AFTER_MS);
      return viewed(run, raw => views.answerView(raw, scope));
    }
    if (method === 'ask.cancel') { asks.get(params.cancel_id as string)?.abort(); return ok(null); }
    if (method === 'ask.record') return viewed(await runCli(runPersonClientCli, ask.askRecordArgv(params.record as Json), client), raw => views.recordView(raw, params.record as Json));
    if (method === 'ask.source') return viewed(await runCli(runPersonClientCli, ask.askSourceArgv(params.ref as Json, params.scope as Scope), client), views.evidenceView);
    // A follow-up's row, as the host reads one: the runs command, its result validated, the item as the page has it.
    if (method === 'runs' && (params.request as Json).operation === 'item') {
      const request = validatePersonRunsRequestV1(params.request);
      return viewed(await runCli(runPersonClientCli, ['runs', `--request=${JSON.stringify(request)}`], client),
        raw => views.openItemView((validatePersonRunsResultV1('item', (raw as { result: unknown }).result) as { item: unknown }).item));
    }
    return quiet(method, account);
  });

  // A fresh page, signed in as the client is.
  vi.resetModules();
  store = await desktop<Store>('renderer/store.ts');
  await store.refreshStatus();
  await flush();
  const audits = () => (f.database.prepare(ASK_AUDIT).all() as { body_json: string }[]).map(row => JSON.parse(row.body_json) as Json);
  return { f, store, views, progress, openerOf, account, lines, notices, refused, runs, audits, asked };
}

/** The steps the client printed before its last line. */
function stepsOf(lines: readonly string[]): PersonAskProgressStepEventV3[] {
  return lines.map(line => validatePersonAskProgressLineV3(JSON.parse(line)).progress);
}

/** The catalog's sources, as a step names them: follow-ups only on /v6, which alone reads them (ADR-0040). */
const SEARCHED_V1 = [{ kind: 'meetings' }, { kind: 'documents' }, { kind: 'tickets', tool_id: 'jira' }, { kind: 'slack' }];
const SEARCHED_V2 = [...SEARCHED_V1, { kind: 'follow_ups' }];

describe('Ask progress from the Authority through the Person client to the desktop page', () => {
  it.each([
    { route: '/v6' as const, older: false, schema: 7, sources: SEARCHED_V2 },
    { route: '/v5' as const, older: true, schema: 6, sources: SEARCHED_V1 },
  ])('streams each step to the page while the Authority works on $route, then folds into the audited receipt, and opens what it named', async ({ route, older, schema, sources }) => {
    const { f, store, views, lines, refused, runs, audits, asked } = await app({ route });
    try {
      // The desktop's atom ids are the Authority's own.
      expect(views.atomId(f.seeded.approved_record_sha256, 'd1')).toBe(derivedAtomIdentity(f.seeded.approved_record_sha256, 'd1'));

      // While the Authority is inside the writer's model call, the page already shows what it searched and read.
      let writing: { progress: Progress; lines: number; runs: number } | undefined;
      let writerError: unknown;
      f.beforeAnswerReturn(async () => {
        try {
          await vi.waitFor(() => expect(store.getState().ask?.asking?.progress.stage).toBe('writing'), { timeout: 10_000, interval: 10 });
          writing = { progress: structuredClone(store.getState().ask!.asking!.progress), lines: lines.length, runs: runs.length };
        } catch (error) { writerError = error; }
      });
      await store.ask(QUESTION, { kind: 'global' });
      expect(writerError).toBeUndefined();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ exit: 0, stderr: '', overflow: false });

      // --- The client: every step, in order, then the one final line, from the newest route this Authority has. ---
      expect(asked).toEqual(older ? ['/v7/person/ask', '/v6/person/ask', '/v5/person/ask'] : ['/v7/person/ask', '/v6/person/ask']);
      expect(asked.at(-1)).toBe(`${route}/person/ask`);
      const steps = stepsOf(lines.slice(0, -1));
      // A /v5 stream is V1 throughout: a V1 client reads every step of it.
      if (older) for (const step of steps) validatePersonAskProgressStepEventV1(step);
      const final = validatePersonAskProgressResultLineV3(JSON.parse(lines.at(-1)!));
      expect(final.result.schema_version).toBe(schema);
      expect(final.receipt).toBeDefined();
      const receipt = final.receipt!;
      // Everything up to the writer's stage reached the page while the Authority was still writing.
      const writerAt = steps.findIndex(step => step.type === 'stage' && step.stage === 'writing');
      expect(writerAt).toBeGreaterThan(0);
      expect(writing).toMatchObject({ runs: 0, lines: writerAt + 1 });

      const searched = steps.filter((step): step is Extract<PersonAskProgressStepEventV3, { type: 'searched' }> => step.type === 'searched');
      expect(searched).toHaveLength(1);
      expect(searched[0]!.sources).toEqual(sources);
      const named = steps.flatMap(step => step.type === 'read' ? step.items : []);
      expect(named.map(item => item.kind).sort()).toEqual(['decision', 'document_passage', 'slack_message', 'slack_message', 'ticket']);
      // The private document, the hidden meeting and the unapproved one match the search too: no count includes them.
      expect(searched[0]!.found).toBe(named.length);

      // Only the stage, source kinds, counts and the citation projection: never research state, queries, bodies or ids.
      for (const line of lines.slice(0, -1)) {
        const keys = keysOf(JSON.parse(line));
        for (const key of NEVER_KEYS) expect(keys.has(key), `${key} in ${line}`).toBe(false);
        for (const secret of [NOTE, CROSS_SOURCE_NEED, DOCUMENT_TEXT, PRIVATE_DOCUMENT_TEXT, JIRA_TEXT, SLACK_TEXT, f.seeded.approved_text, f.seeded.hidden_text, f.seeded.unapproved_text]) {
          expect(line).not.toContain(secret);
        }
        expect(line).not.toMatch(/"E\d+"/);
      }

      // The receipt names exactly what was named while it ran, rebuilt after the final check; the answer cites only named items.
      expect(receipt.rows.flatMap(row => row.type === 'read' ? row.items : []).map(commitment)).toEqual(named.map(commitment));
      expect(receipt.rows.filter(row => row.type === 'searched')).toEqual(searched);
      expect(receipt.looked_through).toBe(named.length);
      for (const citation of final.result.citations) expect(named.map(commitment)).toContain(commitment(citation));
      // The request's one audit record lists what was named, as citation commitments in naming order, never labels.
      const [audit, ...others] = audits();
      expect(others).toEqual([]);
      expect(audit).toMatchObject({ outcome: 'answered', named_citation_digests: named.map(commitment), response_sha256: canonicalSha256(final.result) });
      for (const item of named) expect(JSON.stringify(audit)).not.toContain(JSON.stringify(item.label));

      // --- The host: it took every step line as a step. ---
      expect(refused).not.toHaveBeenCalled();

      // --- The page with the answer: the rows it showed while the Authority wrote, folded into the receipt, its names opening the exact item. ---
      const shown = store.getState().ask!.shown!;
      expect(store.getState().ask!.asking).toBeNull();
      expect(shown.receipt).toEqual(views.answerView(JSON.parse(lines.at(-1)!), { kind: 'global' }).receipt);
      const pageNamed = shown.receipt!.rows.flatMap(row => row.type === 'read' ? row.items! : []);
      expect(pageNamed).toEqual(writing!.progress.rows[1]!.items);

      const decision = pageNamed.find(item => item.kind === 'record')!;
      const document = pageNamed.find(item => item.kind === 'original')!;

      // A named decision opens its meeting with that very item lit: its atom id is one of the record's items as the desktop reads them.
      store.openNamed([decision]);
      await vi.waitFor(() => expect(store.getState().sources?.records[f.seeded.approved_record_sha256]?.value).toBeDefined(), { timeout: 10_000, interval: 10 });
      const record = store.getState().sources!.records[f.seeded.approved_record_sha256]!.value!;
      expect(record.decisions.items.map(item => item.atom_id)).toContain(decision.atom_id);
      expect(store.fullPageOffered()).toBe(true);
      // A named document opens its cited passage, read where the Ask was asked.
      store.openNamed([document]);
      await vi.waitFor(() => expect(store.getState().sources?.evidence?.reads[0]?.value).toBeDefined(), { timeout: 10_000, interval: 10 });
      expect(store.getState().sources!.evidence!.reads[0]!.value!.text).toContain(DOCUMENT_TEXT);
    } finally { await f.close(); }
  });

  it('cites and names a follow-up on /v6, opens it beside the running Ask with its owner and status, and after the answer opens its item page (ADR-0040)', async () => {
    const { f, store, views, progress, openerOf, account, lines, refused, runs, audits } = await app();
    const EXPECTED = 'Send the Launchscope checklist to the pilot group';
    const DECIDED = 'Launchscope rolls out to the pilot group first.';
    const item_id = f.followUp(EXPECTED);
    try {
      // While the Authority is inside the writer's model call, the follow-up Ask named opens beside it, read as Home reads it.
      let whileAsking: { row?: Json; offered?: boolean; error?: unknown } = {};
      f.beforeAnswerReturn(async () => {
        try {
          await vi.waitFor(() => expect(store.getState().ask?.asking?.progress.stage).toBe('writing'), { timeout: 10_000, interval: 10 });
          const named = store.getState().ask!.asking!.progress.rows.flatMap(row => row.items ?? []).find(item => item.kind === 'follow_up')!;
          expect(named).toEqual({ kind: 'follow_up', label: EXPECTED, item_id });
          store.openNamed([named]);
          await vi.waitFor(() => expect(store.getState().sources?.followUps[item_id]?.value).toBeDefined(), { timeout: 10_000, interval: 10 });
          whileAsking = { row: store.getState().sources!.followUps[item_id]!.value as unknown as Json, offered: store.fullPageOffered() };
        } catch (error) { whileAsking = { error }; }
      });
      await store.ask(QUESTION, { kind: 'global' });
      expect(whileAsking.error).toBeUndefined();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ exit: 0, stderr: '', overflow: false });
      expect(refused).not.toHaveBeenCalled();

      // --- The Authority and the client: the follow-up was searched, named once its check passed, cited, and audited. ---
      const steps = stepsOf(lines.slice(0, -1));
      const final = validatePersonAskProgressResultLineV3(JSON.parse(lines.at(-1)!));
      expect(final.result.schema_version).toBe(7);
      const followUp = expect.objectContaining({ citation: { kind: 'follow_up', item_id }, kind: 'follow_up', label: EXPECTED, ref: `follow_up:${item_id}` });
      const searched = steps.filter(step => step.type === 'searched');
      expect(searched).toEqual([{ type: 'searched', sources: SEARCHED_V2, found: expect.any(Number) }]);
      const named = steps.flatMap(step => step.type === 'read' ? step.items : []);
      expect(named.filter(item => item.kind === 'follow_up')).toEqual([followUp]);
      expect(searched[0]!.type === 'searched' && searched[0]!.found).toBe(named.length);
      expect(final.result.citations).toContainEqual(followUp);
      const receiptNamed = final.receipt!.rows.flatMap(row => row.type === 'read' ? row.items : []);
      expect(receiptNamed.map(commitment)).toEqual(named.map(commitment));
      expect(receiptNamed).toContainEqual(followUp);
      const [audit] = audits();
      expect(audit).toMatchObject({ outcome: 'answered', named_citation_digests: named.map(commitment) });
      expect(audit!.named_citation_digests).toContain(canonicalSha256({ kind: 'follow_up', item_id }));
      // While it ran, nothing the follow-up's row or decision says left the Authority: only its citation projection.
      for (const line of lines.slice(0, -1)) {
        for (const secret of [DECIDED, 'Owner:', 'Expected:', 'still_open', NOTE]) expect(line).not.toContain(secret);
        const keys = keysOf(JSON.parse(line));
        for (const key of [...NEVER_KEYS, 'owner', 'status', 'check', 'decision', 'expected']) expect(keys.has(key), `${key} in ${line}`).toBe(false);
      }

      // --- The page: the follow-up opened beside Ask while it ran, without Open; the answer's source opens its item page. ---
      expect(whileAsking.row).toMatchObject({ item_id, state: 'open', expected: EXPECTED, owner: { membership_id: account.membership_id } });
      expect(whileAsking.offered).toBe(false);
      const shown = store.getState().ask!.shown!;
      const source = { kind: 'follow_up', label: EXPECTED, item_id };
      expect(shown.answer.sources).toContainEqual(source);
      expect(views.answerView(JSON.parse(lines.at(-1)!), { kind: 'global' }).sources).toContainEqual(source);
      expect(openerOf(source as Source)).toEqual({ pane: 'follow_up', page: { kind: 'follow_up', item_id } });
      expect(progress.searchedWords(shown.receipt!.rows[0]!)).toBe(`Searched meetings, documents, Jira, Slack and follow-ups · ${named.length} found`);
      // The audited answer names it, so the pane stays on it, and now offers Open: its item page, read again.
      expect(store.fullPageOffered()).toBe(true);
      store.openFullPage();
      expect(store.getState().ask).toBeNull();
      expect(store.followUpShown()).toMatchObject({ kind: 'item', item_id });
      await vi.waitFor(() => expect(store.followUpShown()?.item).toMatchObject({ item_id, state: 'open' }), { timeout: 10_000, interval: 10 });
    } finally { await f.close(); }
  });

  it('stops at Cancel: the Authority cancels the Ask and audits what was named, and the page keeps nothing', async () => {
    const { f, store, lines, notices, runs, audits } = await app();
    // The writer answers only once the proof is over: only the cancelled request ends the Ask.
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    try {
      let shownAtCancel = 0;
      f.beforeAnswerReturn(async () => {
        await vi.waitFor(() => expect(store.getState().ask?.asking?.progress.stage).toBe('writing'), { timeout: 10_000, interval: 10 });
        shownAtCancel = notices.length;
        store.cancelAsk();
        await released;
      });
      await store.ask(QUESTION, { kind: 'global' });
      // The client stopped without an answer line, and the page dropped the Ask with all it named.
      expect(runs).toHaveLength(1);
      expect(runs[0]!.exit).not.toBe(0);
      const steps = stepsOf(lines);
      expect(steps.at(-1)).toEqual({ type: 'stage', stage: 'writing' });
      expect(notices).toHaveLength(shownAtCancel);
      expect(store.getState().ask).toBeNull();
      expect(store.getState().sources).toBeNull();
      // The disconnect cancelled the Ask on the Authority, whose one audit record lists what was named before it.
      const named = steps.flatMap(step => step.type === 'read' ? step.items : []);
      expect(named.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(audits()).toHaveLength(1), { timeout: 10_000, interval: 10 });
      expect(audits()[0]).toMatchObject({ outcome: 'cancelled', named_citation_digests: named.map(commitment), citation_count: 0 });
    } finally { release(); await f.close(); }
  });
});

/** What else the page reads as it opens, answered quietly: nothing in the lists, no tools, no change. */
function quiet(method: string, account: Expect) {
  switch (method) {
    case 'app.status': return ok({ signed_in: true, account: { ...account, display_name: 'Owner', role: 'owner' }, client_version: 'test' });
    case 'app.setUnresolved': case 'notice.show': case 'log.changes': return ok(null);
    case 'account.tools': return ok({ tools: [] });
    case 'projects.list': case 'projects.members': case 'people.directory': case 'projects.directory': return ok({ items: [], next_cursor: null });
    case 'list.page': return ok({ items: [], next_cursor: null, meetings_held: false });
    case 'search.run': return ok({ items: [] });
    case 'changes.read': return ok({ kind: 'echo-person-changes-v1', check_again_after_seconds: 60, areas: { projects: `sha256:${'1'.repeat(64)}`, follow_ups: `sha256:${'2'.repeat(64)}`, reviews: `sha256:${'3'.repeat(64)}` } });
    case 'runs': return { ok: false, failure: { code: 'unavailable', retryable: true } };
  }
  throw new Error(`Unexpected request: ${method}`);
}
