import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  validatePersonAskProgressLineV1, validatePersonAskProgressResultLineV1,
  type PersonAnswerCitationV6, type PersonAskProgressStepEventV1, type PersonAskReceiptV1,
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
type Source = Json & { readonly kind: 'record' | 'original' | 'transcript' | 'ticket' | 'page' | 'slack'; readonly label: string };
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
  getState(): {
    ask: { asking: { progress: Progress } | null; shown: { answer: { sources: readonly Source[]; receipt?: Receipt }; receipt?: Receipt; took?: number } | null; failed: unknown } | null;
    sources: { records: Record<string, { loading: boolean; value?: { decisions: { items: { atom_id?: string; text: string }[] } } }>;
      evidence: { reads: Record<number, { loading: boolean; value?: { text: string } }> } | null } | null;
  };
}
interface Views { answerView(raw: unknown, scope: Scope): Json; recordView(raw: unknown, asked: Json): Json; evidenceView(raw: unknown): Json; atomId(record: string, signal: string): string }
interface ProgressView {
  PROGRESS_AFTER_MS: number; liveRows(progress: Progress): { type: string; row?: Row; done?: boolean }[]; stageWords(progress: Progress): string;
  searchedWords(row: Row): string; rowNames(items: readonly Source[]): { names: readonly { source: Source; items: readonly Source[] }[]; more: number }; receiptWords(receipt: Receipt, took: number): string;
}
const ok = (value: unknown) => ({ ok: true, value });
const flush = async (turns = 30) => { for (let i = 0; i < turns; i += 1) await Promise.resolve(); };
const QUESTION = 'Combine the Launchscope approved meeting, document, Jira ticket, and Slack message.';
const NOTE = 'Private planner note: weigh the Jira review against Slack.';
const ASK_AUDIT = "SELECT body_json FROM authority_person_read_decision_audit_v2 WHERE body_json LIKE '%echo-person-agentic-ask-audit-v1%'";
const commitment = (item: PersonAnswerCitationV6) => canonicalSha256(item.citation);

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
async function app() {
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
  const loopback: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(AUTHORITY);
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
    return quiet(method, account);
  });

  // A fresh page, signed in as the client is.
  vi.resetModules();
  store = await desktop<Store>('renderer/store.ts');
  await store.refreshStatus();
  await flush();
  const audits = () => (f.database.prepare(ASK_AUDIT).all() as { body_json: string }[]).map(row => JSON.parse(row.body_json) as Json);
  return { f, store, views, progress, openerOf, account, lines, notices, refused, runs, audits };
}

/** The steps the client printed before its last line. */
function stepsOf(lines: readonly string[]): PersonAskProgressStepEventV1[] {
  return lines.map(line => validatePersonAskProgressLineV1(JSON.parse(line)).progress);
}

describe('Ask progress from the Authority through the Person client to the desktop page', () => {
  it('streams each step to the page while the Authority works, then folds into the audited receipt, and opens what it named', async () => {
    const { f, store, views, progress, openerOf, account, lines, notices, refused, runs, audits } = await app();
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

      // --- The client: every step, in order, then the one final line. ---
      const steps = stepsOf(lines.slice(0, -1));
      const final = validatePersonAskProgressResultLineV1(JSON.parse(lines.at(-1)!));
      expect(final.result.schema_version).toBe(6);
      expect(final.receipt).toBeDefined();
      const receipt = final.receipt as PersonAskReceiptV1;
      // Everything up to the writer's stage reached the page while the Authority was still writing.
      const writerAt = steps.findIndex(step => step.type === 'stage' && step.stage === 'writing');
      expect(writerAt).toBeGreaterThan(0);
      expect(writing).toMatchObject({ runs: 0, lines: writerAt + 1 });

      const stages = steps.flatMap(step => step.type === 'stage' ? [step.stage] : []);
      // Research reads the question, searches, reads what it found; then the writer; the final check comes last.
      expect(stages.slice(0, 2)).toEqual(['reading', 'searching']);
      expect(steps.slice(writerAt)).toEqual([{ type: 'stage', stage: 'writing' }, { type: 'stage', stage: 'checking_access' }]);
      const searched = steps.filter((step): step is Extract<PersonAskProgressStepEventV1, { type: 'searched' }> => step.type === 'searched');
      expect(searched).toHaveLength(1);
      expect(searched[0]!.sources).toEqual([{ kind: 'meetings' }, { kind: 'documents' }, { kind: 'tickets', tool_id: 'jira' }, { kind: 'slack' }]);
      const named = steps.flatMap(step => step.type === 'read' ? step.items : []);
      // Each read follows the reading count that announced it.
      steps.forEach((step, at) => {
        if (step.type !== 'read') return;
        expect(steps.slice(0, at).reverse().find(earlier => earlier.type === 'stage')).toMatchObject({ type: 'stage', stage: 'reading', pending: step.items.length });
      });
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

      // --- The host: every step line became one notice for this Ask and account; the answer line did not. ---
      expect(refused).not.toHaveBeenCalled();
      expect(notices).toHaveLength(steps.length);
      expect(new Set(notices.map(notice => notice.cancel_id)).size).toBe(1);
      for (const notice of notices) expect(notice.expect).toEqual(account);

      // --- The page while the Authority wrote: the live line and its rows, from those notices alone. ---
      const live = writing!.progress;
      expect(progress.stageWords(live)).toBe('Writing');
      expect(live.pending).toBe(0);
      expect(progress.liveRows(live).map(row => [row.type, row.done])).toEqual([['searched', undefined], ['read', true]]);
      expect(progress.searchedWords(live.rows[0]!)).toBe(`Searched meetings, documents, Jira and Slack · ${named.length} found`);
      const read = live.rows[1]!.items!;
      expect(read).toHaveLength(named.length);
      expect(new Set(read.map(item => item.kind))).toEqual(new Set(['record', 'original', 'ticket', 'slack']));
      // "Read launchscope.md, #launchscope, Approved meeting +2": three names, each one place read once, the rest as +N.
      expect(progress.rowNames(read)).toEqual({ names: read.slice(0, 3).map(source => ({ source, items: [source] })), more: named.length - 3 });

      // --- The page with the answer: the rows folded into the receipt, its names opening the exact item. ---
      const shown = store.getState().ask!.shown!;
      expect(store.getState().ask!.asking).toBeNull();
      expect(shown.receipt).toEqual(views.answerView(JSON.parse(lines.at(-1)!), { kind: 'global' }).receipt);
      expect(progress.receiptWords(shown.receipt!, shown.took!)).toMatch(new RegExp(`^Looked through ${named.length} items · \\d+s$`));
      const pageNamed = shown.receipt!.rows.flatMap(row => row.type === 'read' ? row.items! : []);
      expect(pageNamed).toEqual(read);

      const decision = pageNamed.find(item => item.kind === 'record')!;
      expect(openerOf(decision)).toEqual({ pane: 'record', page: { kind: 'reader', ref: { kind: 'meeting', id: f.seeded.approved_record_sha256 } } });
      const document = pageNamed.find(item => item.kind === 'original')!;
      expect(openerOf(document)).toMatchObject({ pane: 'passages', page: { kind: 'reader', ref: { kind: 'document', id: expect.stringMatching(/^doc_[0-9a-f]{64}$/) } } });
      for (const external of pageNamed.filter(item => item.kind === 'ticket' || item.kind === 'slack')) expect(openerOf(external)).toEqual({ pane: 'external', page: null });

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
