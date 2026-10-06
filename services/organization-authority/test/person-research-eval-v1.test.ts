import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonResearchEvalReadResponseV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { describe, expect, it, vi } from 'vitest';
import { createPersonResearchEvalV1, PERSON_RESEARCH_EVAL_REREAD_MS_V1, PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 } from '../src/composition/person-research-eval-v1.js';
import type { CreatePersonResearchEvalOptionsV1 } from '../src/composition/person-research-eval-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';

const record = { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' as const };
const member = (name: string) => ({ principal_id: `principal-${name}`, membership_id: `member-${name}`, session_family_id: `family-${name}` });

/** No records, no originals: research finishes as unusable and the writer is skipped, which is enough to exercise the registry. */
function harness(options: { readonly generate?: (input: StructuredGenerationInput) => Promise<unknown>; readonly openRecord?: () => never; readonly small_scope_shortcut?: true } = {}) {
  let clock = 1_000_000;
  let revoked = false;
  const deskSearch = vi.fn(() => ({ items: [], truncated: false, receipt: canonicalSha256('inventory') }));
  const tokens = new Map([['token-a', member('a')], ['token-b', member('b')]]);
  const audits: unknown[] = [];
  const generate = vi.fn(options.generate ?? (async () => ({ parts: [{ question: 'Q', needs: [{ need: 'fact', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] })));
  const dependencies = {
    authority_id: 'authority-1', organization_id: 'organization-1', state_lineage_id: 'lineage-1',
    sessions: { authenticateAccess: ({ access_token }: { readonly access_token: string }) => {
      const value = tokens.get(access_token);
      if (value === undefined) throw new AuthorityOperationError('unauthorized', 'person authentication failed');
      return value;
    } },
    originals: {
      deskAuthorize: () => { if (revoked) throw new AuthorityOperationError('unauthorized', 'grant revoked'); return { checked_at: '2026-10-06T00:00:00.000Z' }; },
      deskSearch,
      revalidateDeskRelease: () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
    },
    records: {
      initializeDesk: () => { throw new PersonRecordSearchIndexLagV1(); },
      openDeskCitation: options.openRecord ?? (() => { throw new AuthorityOperationError('not_found', 'record is not readable'); }),
    },
    model: { generate },
    generation: { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 },
    audit: { forRequest: () => ({ append: (entry: unknown) => { audits.push(entry); } }), forLiveRequest: () => ({ record: async () => canonicalSha256('release') }) },
    now: () => clock,
    ...(options.small_scope_shortcut === true ? { small_scope_shortcut: true } : {}),
  } as unknown as CreatePersonResearchEvalOptionsV1;
  const application = createPersonResearchEvalV1(dependencies);
  const read = async (token: string, run_id: string) => validatePersonResearchEvalReadResponseV1(await application.read({ access_token: token, request: { schema_version: 1, run_id } }));
  const settled = async (token: string, run_id: string) => {
    let value = await read(token, run_id);
    await vi.waitFor(async () => { if (value.status === 'running') value = await read(token, run_id); expect(value.status).not.toBe('running'); });
    return value;
  };
  return { application, generate, audits, read, settled, deskSearch, revoke: () => { revoked = true; }, advance: (ms: number) => { clock += ms; } };
}

describe('staging research evaluation runs', () => {
  it('runs an Ask in the background and delivers its research result, readable again only briefly', async () => {
    const h = harness();
    const receipt = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Why is DVT on hold?' } });
    expect(receipt).toMatchObject({ kind: 'echo-person-research-eval-run-v1', status: 'running' });
    const result = await h.settled('token-a', receipt.run_id);
    expect(result).toMatchObject({ status: 'completed', research: { kind: 'echo-agentic-research-result-v1', trigger: 'ask', stop: { reason: 'unusable_step' } }, ask: { writer_evidence: [], response: { schema_version: 6 } } });
    expect((await h.read('token-a', receipt.run_id)).status).toBe('completed');
    h.advance(PERSON_RESEARCH_EVAL_REREAD_MS_V1 + 1);
    await expect(h.read('token-a', receipt.run_id)).rejects.toMatchObject({ code: 'not_found' });
    // The only durable trace is the loop's content-free audit.
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits)).not.toContain('DVT');
  });

  it('records a deadline as a timed_out failure and frees the person for another run', async () => {
    const h = harness({ generate: async () => { throw new AgenticAskDeadlineErrorV1(); } });
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Too slow?' } });
    expect(await h.settled('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'timed_out', message: 'The research run reached its deadline' } });
    await expect(h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Again?' } })).resolves.toMatchObject({ status: 'running' });
  });

  it('refuses a second run while one is running for the same person, but not for another person', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ generate: async () => { await gate; return { parts: [{ question: 'Q', needs: [{ need: 'f', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }; } });
    const first = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'First?' } });
    await expect(h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Second?' } })).rejects.toMatchObject({ code: 'conflict' });
    const other = await h.application.start({ access_token: 'token-b', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Other?' } });
    expect((await h.read('token-a', first.run_id)).status).toBe('running');
    release();
    expect((await h.settled('token-a', first.run_id)).status).toBe('completed');
    expect((await h.settled('token-b', other.run_id)).status).toBe('completed');
  });

  it('rechecks access before releasing a finished result', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Still mine?' } });
    await vi.waitFor(() => expect(h.audits).toHaveLength(1));
    h.revoke();
    expect(await h.read('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } });
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('runs Ask with the served small-scope preload when it is configured', async () => {
    const h = harness({ small_scope_shortcut: true });
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Small project?' } });
    expect((await h.settled('token-a', run.run_id)).status).toBe('completed');
    expect(h.deskSearch).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: 'items' }));
  });

  it("never shows one person's run to another", async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Mine?' } });
    await expect(h.read('token-b', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.settled('token-a', run.run_id)).status).toBe('completed');
  });

  it('drops an unread result after it expires', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Later?' } });
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    h.advance(PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 + 1);
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a Check whose starting record is not readable as not_found, before any model call', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'check', budget: 'background', record } });
    expect(await h.settled('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'not_found', message: 'Starting evidence is not available' } });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('stops running research on close', async () => {
    const seen: AbortSignal[] = [];
    const h = harness({ generate: async input => { seen.push(input.signal!); return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })); } });
    await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'ask', budget: 'live', question: 'Long?' } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    h.application.close();
    expect(seen[0]!.aborted).toBe(true);
  });
});
