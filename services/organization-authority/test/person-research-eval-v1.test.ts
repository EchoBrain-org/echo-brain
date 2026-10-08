import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonResearchEvalReadResponseV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { AgenticAskDeadlineErrorV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { describe, expect, it, vi } from 'vitest';
import { createPersonResearchEvalV1, PERSON_RESEARCH_EVAL_REREAD_MS_V1, PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 } from '../src/composition/person-research-eval-v1.js';
import type { CreatePersonResearchEvalOptionsV1 } from '../src/composition/person-research-eval-v1.js';
import { PersonRecordSearchIndexLagV1 } from '../src/composition/person-record-search-route.js';

// One deliberately broken definition beside the real ones: a question brief that also names starting evidence.
vi.mock('@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1', async importOriginal => {
  const real = await importOriginal<typeof import('@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1')>();
  const ask = real.AGENTIC_TRIGGER_DEFINITIONS_V1.find(definition => definition.name === 'ask')!;
  const started = { ...ask, name: 'ask_with_start', brief: (event: unknown) => ({ ...ask.brief(event), starting: [{ citation: { kind: 'approved_record' }, if_unreadable: 'fail' as const }] }) };
  return { ...real, AGENTIC_TRIGGER_DEFINITIONS_V1: Object.freeze([...real.AGENTIC_TRIGGER_DEFINITIONS_V1, started]) };
});

const record = { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' as const };
const PROJECT = 'prj_00000000-0000-4000-8000-000000000001' as const;
const OTHER_PROJECT = 'prj_00000000-0000-4000-8000-000000000002' as const;
const member = (name: string) => ({ principal_id: `principal-${name}`, membership_id: `member-${name}`, session_family_id: `family-${name}` });
const ask = (question: string) => ({ schema_version: 1 as const, trigger: 'ask', budget: 'live' as const, input: { question } });
const approved = (extra: { readonly budget?: 'live' | 'background'; readonly project_id?: `prj_${string}`; readonly mine?: true } = {}) => ({ schema_version: 1 as const, trigger: 'approved_record', input: { record }, ...extra });
/** The record route's open of `record`: one readable decision. */
const openedRecord = () => ({
  response: { schema_version: 2, kind: 'echo-person-record-search-v2', items: [] }, query_hit_counts: [],
  release: { active_pointer: { generation_id: canonicalSha256('generation'), manifest_sha256: canonicalSha256('manifest'), retrieval_contract_sha256: canonicalSha256('contract'), record_head: { position: 1, record_sha256: record.record_sha256 } }, record_read_audit_row_sha256: canonicalSha256('record read') },
  desk_items: [{ atom_id: record.atom_id, record_sha256: record.record_sha256, item_kind: 'decision', text: 'Approved: firmware shows two decimals.', policy_id: record.policy_id, record_position: 1, envelope_sha256: canonicalSha256('envelope'), atom_order: 0, audience_project_count: 1, label: 'Pricing review', visibility: 'project' }],
});

/** No records, no originals: research finishes as unusable and the writer is skipped, which is enough to exercise the registry. */
function harness(options: { readonly generate?: (input: StructuredGenerationInput) => Promise<unknown>; readonly openRecord?: () => unknown; readonly recordProjects?: () => readonly string[]; readonly small_scope_shortcut?: true } = {}) {
  let clock = 1_000_000;
  let revoked = false;
  const deskSearch = vi.fn(() => ({ items: [], truncated: false, receipt: canonicalSha256('inventory') }));
  const deskAuthorize = vi.fn((_input: { readonly access_token: string; readonly scope: unknown }) => { if (revoked) throw new AuthorityOperationError('unauthorized', 'grant revoked'); return { checked_at: '2026-10-06T00:00:00.000Z' }; });
  const openDeskCitation = vi.fn(options.openRecord ?? (() => { throw new AuthorityOperationError('not_found', 'record is not readable'); }));
  const recordProjects = vi.fn(options.recordProjects ?? (() => { throw new AuthorityOperationError('not_found', 'record is not readable'); }));
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
      deskAuthorize,
      deskSearch,
      revalidateDeskRelease: () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
    },
    records: {
      initializeDesk: () => { throw new PersonRecordSearchIndexLagV1(); },
      openDeskCitation,
      recordProjects,
      revalidateBatchRelease: () => ({ checked_at: '2026-10-06T00:00:00.000Z' }),
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
  return { application, generate, audits, read, settled, deskSearch, deskAuthorize, openDeskCitation, recordProjects, revoke: () => { revoked = true; }, advance: (ms: number) => { clock += ms; } };
}

describe('staging research evaluation runs', () => {
  it('runs an Ask in the background and delivers its research result, readable again only briefly', async () => {
    const h = harness();
    const receipt = await h.application.start({ access_token: 'token-a', request: ask('Why is DVT on hold?') });
    expect(receipt).toMatchObject({ kind: 'echo-person-research-eval-run-v1', status: 'running' });
    const result = await h.settled('token-a', receipt.run_id);
    expect(result).toMatchObject({ status: 'completed', research: { kind: 'echo-agentic-research-result-v1', trigger: 'ask', stop: { reason: 'unusable_step' } }, ask: { writer_evidence: [], response: { schema_version: 6 } } });
    expect(result).not.toHaveProperty('rendered');
    expect(result).not.toHaveProperty('trace');
    expect((await h.read('token-a', receipt.run_id)).status).toBe('completed');
    h.advance(PERSON_RESEARCH_EVAL_REREAD_MS_V1 + 1);
    await expect(h.read('token-a', receipt.run_id)).rejects.toMatchObject({ code: 'not_found' });
    // The only durable trace is the loop's content-free audit.
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits)).not.toContain('DVT');
  });

  it('records a deadline as a timed_out failure and frees the person for another run', async () => {
    const h = harness({ generate: async () => { throw new AgenticAskDeadlineErrorV1(); } });
    const run = await h.application.start({ access_token: 'token-a', request: ask('Too slow?') });
    expect(await h.settled('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'timed_out', message: 'The research run reached its deadline' } });
    await expect(h.application.start({ access_token: 'token-a', request: ask('Again?') })).resolves.toMatchObject({ status: 'running' });
  });

  it('refuses a second run while one is running for the same person, but not for another person', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ generate: async () => { await gate; return { parts: [{ question: 'Q', needs: [{ need: 'f', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] }; } });
    const first = await h.application.start({ access_token: 'token-a', request: ask('First?') });
    await expect(h.application.start({ access_token: 'token-a', request: ask('Second?') })).rejects.toMatchObject({ code: 'conflict' });
    const other = await h.application.start({ access_token: 'token-b', request: ask('Other?') });
    expect((await h.read('token-a', first.run_id)).status).toBe('running');
    release();
    expect((await h.settled('token-a', first.run_id)).status).toBe('completed');
    expect((await h.settled('token-b', other.run_id)).status).toBe('completed');
  });

  it('rechecks access before releasing a finished result', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: ask('Still mine?') });
    await vi.waitFor(() => expect(h.audits).toHaveLength(1));
    h.revoke();
    expect(await h.read('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } });
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('runs Ask with the served small-scope preload when it is configured', async () => {
    const h = harness({ small_scope_shortcut: true });
    const run = await h.application.start({ access_token: 'token-a', request: ask('Small project?') });
    expect((await h.settled('token-a', run.run_id)).status).toBe('completed');
    expect(h.deskSearch).toHaveBeenCalledWith(expect.objectContaining({ inventory_mode: 'items' }));
  });

  it.each([false, true])("never shows one person's run to another (trace: %s)", async traced => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Mine?'), ...(traced ? { capture_trace: true as const } : {}) } });
    await expect(h.read('token-b', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.settled('token-a', run.run_id)).status).toBe('completed');
  });

  it.each([false, true])('drops an unread result after it expires (trace: %s)', async traced => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Later?'), ...(traced ? { capture_trace: true as const } : {}) } });
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    h.advance(PERSON_RESEARCH_EVAL_RESULT_TTL_MS_V1 + 1);
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it("runs an approved record as the person who started it, in the record's project, on the background budget", async () => {
    const h = harness({ recordProjects: () => [PROJECT], openRecord: openedRecord });
    const run = await h.application.start({ access_token: 'token-a', request: approved() });
    const result = await h.settled('token-a', run.run_id);
    expect(result).toMatchObject({ status: 'completed', research: { trigger: 'approved_record', budget: { deadline_ms: 300_000 }, items: [expect.objectContaining({ id: 'E1', text: 'Approved: firmware shows two decimals.' })] } });
    expect(result).not.toHaveProperty('ask');
    // The scope comes from the record, looked up with the person's own access before the desk exists.
    expect(h.recordProjects).toHaveBeenCalledWith({ access_token: 'token-a', record_sha256: record.record_sha256 });
    expect(h.recordProjects.mock.invocationCallOrder[0]).toBeLessThan(h.deskAuthorize.mock.invocationCallOrder[0]!);
    expect(h.deskAuthorize).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-a', scope: { kind: 'project', project_id: PROJECT } }));
    expect(h.openDeskCitation).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-a', atom_id: record.atom_id, project_id: PROJECT }));
    expect(JSON.parse(h.generate.mock.calls[0]![0].user_prompt)).toMatchObject({ task: expect.stringMatching(/^A PM just approved record E1\. Find every ticket, PRD section and document in this project /u) });
    expect(h.audits).toEqual([expect.objectContaining({ trigger: 'approved_record', budget: 'background' })]);
  });

  it("returns an approved record's rendered impact card with the trimmed bundle it was written from", async () => {
    const card = { decided: [{ id: 'E1', text: 'The display shows two decimals.' }], affected: [] };
    const step = { parts: [{ question: 'Q', needs: [{ need: 'fact', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
    const h = harness({ recordProjects: () => [PROJECT], openRecord: openedRecord, generate: async input => input.system_prompt.startsWith('You write the content of an impact card') ? card : step });
    const run = await h.application.start({ access_token: 'token-a', request: approved() });
    const result = await h.settled('token-a', run.run_id);
    expect(result).toMatchObject({
      status: 'completed', research: { kind: 'echo-agentic-research-result-v1', trigger: 'approved_record' },
      rendered: { status: 'assessed', decided: [{ text: 'The display shows two decimals.', citation_index: 0 }], affected: [], people: [], citations: [{ citation: { kind: 'approved_record', atom_id: record.atom_id } }] },
    });
    expect(result).not.toHaveProperty('ask');
    // The evaluation's view: the trimmed bundle, never the server records.
    expect(result.research).not.toHaveProperty('server');
    expect(result.research).not.toHaveProperty('gathered_for');
    expect(h.audits).toEqual([expect.objectContaining({ trigger: 'approved_record', outcome: 'partial' })]);
  });

  it('reads everything the approver can read for a record in no project, or in more than one', async () => {
    for (const projects of [[], [PROJECT, OTHER_PROJECT]]) {
      const h = harness({ recordProjects: () => projects, openRecord: openedRecord });
      const run = await h.application.start({ access_token: 'token-a', request: approved({ budget: 'live' }) });
      // The request's own budget still overrides the definition's profile.
      expect(await h.settled('token-a', run.run_id), JSON.stringify(projects)).toMatchObject({ status: 'completed', research: { trigger: 'approved_record', budget: { deadline_ms: 90_000 } } });
      expect(h.deskAuthorize).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'global' } }));
      expect(h.openDeskCitation).toHaveBeenCalledWith(expect.not.objectContaining({ project_id: expect.anything() }));
    }
  });

  it('reports an approved record the person cannot read as not_found, before any desk or model call', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: approved() });
    expect(await h.settled('token-a', run.run_id)).toMatchObject({ status: 'failed', error: { code: 'not_found', message: 'Starting evidence is not available' } });
    expect(h.recordProjects).toHaveBeenCalledTimes(1);
    expect(h.deskAuthorize).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('runs a Sweep on its own background budget, listing a cited item it can no longer read and researching on', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { schema_version: 1, trigger: 'sweep', input: { findings: [{ finding: 'Two decimals shipped', expected: 'Record updated', citations: [record] }] } } });
    const result = await h.settled('token-a', run.run_id);
    expect(result).toMatchObject({ status: 'completed', research: { trigger: 'sweep', unreadable_starting: [record], budget: { deadline_ms: 300_000 } } });
    // Sweep has no renderer: research only.
    expect(result).not.toHaveProperty('rendered');
    expect(h.generate).toHaveBeenCalled();
    expect(h.audits).toEqual([expect.objectContaining({ trigger: 'sweep', budget: 'background' })]);
  });

  it("refuses an unknown trigger, input its definition rejects, the mine scope beyond Ask, a scope for a record's run, and a question brief Ask's writer would not run as given, before any run starts", async () => {
    const h = harness({ recordProjects: () => [PROJECT] });
    for (const request of [
      { schema_version: 1 as const, trigger: 'drift', input: {} },
      { schema_version: 1 as const, trigger: 'check', input: { record } },
      { schema_version: 1 as const, trigger: 'approved_record', input: { record: { ...record, kind: 'ticket' } } },
      { schema_version: 1 as const, trigger: 'sweep', input: { findings: [] } },
      { schema_version: 1 as const, trigger: 'ask', input: { question: 'x '.repeat(130).trim() } },
      { schema_version: 1 as const, trigger: 'sweep', mine: true as const, input: { findings: [{ finding: 'f', expected: 'e', citations: [record] }] } },
      approved({ mine: true }),
      approved({ project_id: PROJECT }),
      { schema_version: 1 as const, trigger: 'ask_with_start', input: { question: 'Why?' } },
    ]) await expect(h.application.start({ access_token: 'token-a', request }), JSON.stringify(request)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(h.recordProjects).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
    // Nothing was left running for the person.
    await expect(h.application.start({ access_token: 'token-a', request: ask('Still free?') })).resolves.toMatchObject({ status: 'running' });
  });

  it('stops running research on close', async () => {
    const seen: AbortSignal[] = [];
    const h = harness({ generate: async input => { seen.push(input.signal!); return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })); } });
    await h.application.start({ access_token: 'token-a', request: ask('Long?') });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    h.application.close();
    expect(seen[0]!.aborted).toBe(true);
  });

  it('exports exact model inputs and structured replies only for an opted-in, settled run', async () => {
    const h = harness();
    const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Which linked item blocks PVT?'), capture_trace: true } });
    const result = await h.settled('token-a', run.run_id);
    expect(result.trace).toMatchObject({ kind: 'echo-agentic-research-trace-v1', complete: true, dropped_events: 0 });
    const requests = result.trace!.events.filter(event => event.kind === 'model_request');
    expect(requests).toHaveLength(h.generate.mock.calls.length);
    requests.forEach((event, index) => {
      const { signal: _signal, ...expected } = h.generate.mock.calls[index]![0];
      expect(event.input).toEqual(expected);
      expect(event.input).not.toHaveProperty('signal');
    });
    expect(result.trace!.events.filter(event => event.kind === 'model_response')).toHaveLength(requests.length);
    expect(JSON.stringify(h.audits)).not.toContain('blocks PVT');
    expect(JSON.stringify(h.audits)).not.toContain('model_request');
    const first = result.trace!.events[0]!;
    (first.input as { user_prompt: string }).user_prompt = 'changed outside the registry';
    expect((await h.read('token-a', run.run_id)).trace!.events[0]).not.toMatchObject({ input: { user_prompt: 'changed outside the registry' } });
    h.advance(PERSON_RESEARCH_EVAL_REREAD_MS_V1 + 1);
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
    h.application.close();
  });

  it('withholds trace while running and discards it on close before late events can arrive', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ generate: async () => { await gate; throw new AgenticAskDeadlineErrorV1(); } });
    const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Pending?'), capture_trace: true } });
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    expect(await h.read('token-a', run.run_id)).toEqual(expect.not.objectContaining({ trace: expect.anything() }));
    h.application.close();
    release();
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rechecks source access before releasing a failed run trace and discards it when access is revoked', async () => {
    const h = harness({ generate: async () => { throw new AgenticAskDeadlineErrorV1(); } });
    const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Fail after input?'), capture_trace: true } });
    const first = await h.settled('token-a', run.run_id);
    expect(first).toMatchObject({ status: 'failed', error: { code: 'timed_out' }, trace: { complete: true, events: [expect.objectContaining({ kind: 'model_request' }), expect.objectContaining({ kind: 'model_error' })] } });
    const priorChecks = h.deskAuthorize.mock.calls.length;
    h.revoke();
    const revoked = await h.read('token-a', run.run_id);
    expect(h.deskAuthorize.mock.calls.length).toBeGreaterThan(priorChecks);
    expect(revoked).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } });
    expect(revoked).not.toHaveProperty('trace');
    await expect(h.read('token-a', run.run_id)).rejects.toMatchObject({ code: 'not_found' });
    h.application.close();
  });

  it('discards a completed trace on source-access revocation and never releases a trace without an established fence', async () => {
    const h = harness();
    const complete = await h.application.start({ access_token: 'token-a', request: { ...ask('Still permitted?'), capture_trace: true } });
    await vi.waitFor(() => expect(h.audits).toHaveLength(1));
    h.revoke();
    const refused = await h.settled('token-a', complete.run_id);
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'unauthorized' } });
    expect(refused).not.toHaveProperty('trace');
    h.application.close();

    const missing = harness();
    const unopened = await missing.application.start({ access_token: 'token-a', request: { ...approved(), capture_trace: true } });
    const failed = await missing.settled('token-a', unopened.run_id);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'not_found' } });
    expect(failed).not.toHaveProperty('trace');
    missing.application.close();
  });

  it('adds no runtime content capture when the private trace is enabled', async () => {
    const counts: number[] = [];
    for (const traced of [false, true]) {
      const capture = vi.fn();
      const h = harness({ generate: async input => {
        captureCoreRuntimeContentV1('model_request', input.user_prompt);
        return { parts: [{ question: 'Q', needs: [{ need: 'fact', status: 'not_found', evidence: [] }], notes: '' }], actions: [{ tool: 'finish', args: {} }] };
      } });
      await observeCoreRuntimeV1('ask_request', async () => {
        const run = await h.application.start({ access_token: 'token-a', request: { ...ask('Same runtime behavior?'), ...(traced ? { capture_trace: true as const } : {}) } });
        await h.settled('token-a', run.run_id);
      }, { observer: () => undefined, content_observer: capture });
      counts.push(capture.mock.calls.length);
      expect(JSON.stringify(capture.mock.calls)).not.toContain('echo-agentic-research-trace-v1');
      h.application.close();
    }
    expect(counts[1]).toBe(counts[0]);
  });
});
