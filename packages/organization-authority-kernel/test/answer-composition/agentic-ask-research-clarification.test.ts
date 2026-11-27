import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { validatePersonAnswerResponseV8 } from '@echo-brain/organization-api';
import { createAgenticAskV5 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { AgenticResearchDriverV1 } from '../../src/answer-composition/agentic-research-driver-v1.js';
import type { EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { CONFLUENCE, JIRA, PAGES, section, ticketBody, ticketRow } from './fixtures/agentic-lists.js';
import { checked, finishOn, generation, record, result, scripted, searchFor, writerReply } from './fixtures/agentic-scenarios.js';

const question = 'Prepare a follow-up for the pilot team.';
const pilots = ['March pilot', 'June pilot'].map((label, at) => ({
  ...record(String(at + 1), at === 0 ? 'March pilot shipped on time.' : 'June pilot is waiting on packaging.'), label,
}));
const subjects = pilots.map((pilot, index) => ({ id: 'E' + (index + 1), label: pilot.label }));
const askWhich = (choices = subjects) => ({ parts: [], actions: [{ tool: 'clarify', args: { subjects: choices } }] });
const clarify = askWhich();

function harness(steps: readonly unknown[], driver?: AgenticResearchDriverV1, writer?: readonly unknown[], resolver?: readonly unknown[]) {
  const run = scripted({ steps, writer, resolver });
  const revalidate = vi.fn(async () => checked);
  const search = vi.fn(async () => result(pilots));
  const openCitation = vi.fn(async () => result(pilots));
  const append = vi.fn();
  const save = vi.fn();
  const ask = createAgenticAskV5({
    generation, model: run.model, desk: { scope: { kind: 'global' }, live_sources: [], revalidate,
      openCitation, search, list: async () => result([]), open: async () => result([]) },
    audit: { append }, research_driver: driver,
    follow_ups: { request_id: 'ask_00000000-0000-4000-8000-000000000001', sink: { save } },
  });
  return { ask, run, search, append, save, revalidate, openCitation };
}

describe('clarification discovered during Ask research', () => {
  it('asks about the two subjects it found, with checked choices, one release and no writer or draft', async () => {
    const h = harness([searchFor(question, 'pilot'), clarify]);
    const { response, receipt } = await h.ask.answerWithReceipt({ question, research_clarification: true, on_progress: () => {} });
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(response).toMatchObject({ outcome: 'clarify', question, citations: [], parts: [],
      choices: pilots.map(pilot => ({ label: pilot.label, question: expect.stringContaining(pilot.label), citation: pilot.citation })) });
    expect(h.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'clarify', rounds: 2, citation_count: 0 }));
    expect(receipt.looked_through).toBe(2);
    expect(JSON.stringify(h.run.of('step')[0]!.schema)).not.toContain('"clarify"');
    expect(JSON.stringify(h.run.of('step')[1]!.schema)).toContain('"clarify"');
    expect(h.run.of('writer')).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('checks distinct subject labels against the exact native tool results the model received', async () => {
    const h = harness([], { run: async session => {
      expect(session.research_clarification).toBe(true);
      const packet = await session.call('search', { query: 'pilot' });
      const admit = (operation: 'messages' | 'count_tokens', payload: unknown) => session.model_request({
        model: 'claude-fixture', operation, body_sha256: canonicalSha256(operation), payload_digests: [canonicalSha256(payload)],
      }, async () => ({ value: undefined }));
      const choose = (choices = subjects) => session.call('clarify', { subjects: choices });
      await admit('count_tokens', packet);
      await admit('messages', session.initial);
      expect(await choose()).toHaveProperty('error');
      await admit('messages', packet);
      expect(await choose([subjects[0]!, subjects[0]!])).toHaveProperty('error');
      expect(await choose([subjects[0]!, { ...subjects[1]!, id: 'E77' }])).toHaveProperty('error');
      expect(await session.call('clarify', { subjects, label: 'invented' })).toHaveProperty('error');
      expect(await choose()).toMatchObject({ accepted: true });
      await session.call('search', { query: 'after the decision' });
    } });
    const { response, receipt } = await h.ask.answerWithReceipt({ question, research_clarification: true, on_progress: () => {} });
    expect(response.choices?.map(choice => choice.label)).toEqual(pilots.map(pilot => pilot.label));
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(receipt.looked_through).toBe(2);
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each(['Jira', 'Confluence'] as const)('offers a reopenable %s body only after its inventory row has been opened and shown', async source => {
    const jira = source === 'Jira';
    const labels = ['Retail pilot', 'Partner pilot'];
    const row = { ...(jira ? ticketRow(1) : PAGES[0]!), label: labels.join(' and ') };
    const text = row.label + ' both need follow-up.';
    const body = jira ? { ...ticketBody(1, text), label: row.label } : section(row, text);
    const desk: EvidenceDeskPortV2 = {
      scope: { kind: 'global' }, live_sources: [jira ? JIRA : CONFLUENCE], revalidate: async () => checked,
      list: async () => result([row]), search: async () => result([row]), open: async () => result([body]),
      openCitation: async ({ citation }) => result(canonicalSha256(citation) === canonicalSha256(body.citation) ? [body] : []),
    };
    const ask = createAgenticAskV5({ generation, model: scripted({ steps: [] }).model, desk,
      audit: { append: vi.fn() }, research_driver: { run: async session => {
        const admit = (packet: unknown) => session.model_request({ model: 'fixture', operation: 'messages',
          body_sha256: canonicalSha256(packet), payload_digests: [canonicalSha256(packet)] }, async () => ({ value: undefined }));
        const choose = (id: string) => session.call('clarify', { subjects: labels.map(label => ({ id, label })) });
        const inventory = jira ? await session.call('list', { source: 'tickets' }) : await session.call('search', { source: 'pages', query: 'pilots' });
        await admit(inventory);
        expect(await choose('E1')).toHaveProperty('error');
        const opened = await session.call('open', { id: 'E1' });
        await admit(inventory);
        expect(await choose('E1')).toHaveProperty('error');
        await admit(opened);
        expect(await choose(jira ? 'E1' : 'E2')).toHaveProperty('accepted', true);
      } },
    });
    const offered = await ask.answer({ question, research_clarification: true });
    expect(offered.choices?.map(choice => choice.citation)).toEqual([body.citation, body.citation]);
    const clicked = createAgenticAskV5({ generation, desk, audit: { append: vi.fn() }, model: scripted({
      steps: [finishOn(question, ['E1'])], writer: [writerReply([{ text, evidence: ['E1'] }])],
    }).model });
    const selected = await clicked.answer({ question, research_clarification: true, research_subjects: [
      { label: labels[0]!, citation: offered.choices![0]!.citation! },
    ] });
    expect(selected).toMatchObject({ outcome: 'answered', citations: [{ citation: body.citation }] });
  });

  it('offers two subjects in one review and refuses a name beyond the preview until a model has read it', async () => {
    const choices = ['Retail pilot', 'Partner pilot'].map(label => ({ id: 'E1', label }));
    const review = { ...record('june', 'Retail pilot and March pilot started in June. ' + 'Background information. '.repeat(5_000) + 'Partner pilot launched.'), label: 'June review' };
    const h = harness([], { run: async session => {
      const admit = (packet: unknown) => session.model_request({ model: 'claude-fixture', operation: 'messages',
        body_sha256: canonicalSha256(packet), payload_digests: [canonicalSha256(packet)] }, async () => ({ value: undefined }));
      const preview = await session.call('search', { query: 'Retail pilot' });
      await admit(preview);
      expect(await session.call('clarify', { subjects: choices })).toHaveProperty('error');
      const visible = [choices[0]!, { id: 'E1', label: 'March pilot' }];
      expect(await session.call('clarify', { subjects: visible })).toHaveProperty('accepted', true);
    } });
    h.search.mockResolvedValue(result([review]));
    const partial = await h.ask.answer({ question, research_clarification: true });
    expect(partial.choices?.map(choice => choice.label)).toEqual(['Retail pilot', 'March pilot']);
    const named = { ...record('one', 'Retail pilot ships in March. Partner pilot ships in June.'), label: 'June review' };
    const repaired = harness([searchFor(question, 'pilot'), askWhich([choices[0]!, { id: 'E1', label: 'Partner trial' }]), askWhich(choices)]);
    repaired.search.mockResolvedValue(result([named]));
    const response = await repaired.ask.answer({ question, research_clarification: true });
    expect(response.choices?.map(choice => choice.label)).toEqual(['Retail pilot', 'Partner pilot']);
    expect(repaired.run.of('writer')).toHaveLength(0);
    expect(repaired.run.of('step')).toHaveLength(3);
  });

  it('does not draft from incomplete research when the planner cannot ground its proposed choices', async () => {
    const unsupported = askWhich([{ id: 'E1', label: 'Invented subject' }, subjects[1]!]);
    const h = harness([searchFor(question, 'pilot'), unsupported, unsupported]);
    await expect(h.ask.answer({ question, research_clarification: true })).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.run.of('writer')).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('releases no choices when the access check after the audit detects a changed snapshot', async () => {
    const h = harness([searchFor(question, 'pilot'), clarify]);
    h.append.mockImplementation(() => {
      h.revalidate.mockRejectedValue(new AuthorityOperationError('stale_access_state', 'Evidence access changed'));
    });
    await expect(h.ask.answer({ question, research_clarification: true })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(h.run.of('writer')).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('reopens a chosen subject, qualifies the original question and seeds its evidence before research', async () => {
    const selected = pilots[1]!;
    const wording = question + ' (' + selected.label + ')';
    const h = harness([finishOn(wording, ['E1'])], undefined, [writerReply([{ text: selected.text!, evidence: ['E1'] }])]);
    h.openCitation.mockResolvedValue(result([selected]));
    const res = await h.ask.answer({ question, research_clarification: true, research_subjects: [{ label: selected.label, citation: selected.citation }] });
    expect(h.openCitation).toHaveBeenCalledOnce();
    expect(JSON.parse(h.run.of('step')[0]!.user_prompt)).toMatchObject({ question: wording, opened: [{ title: selected.label }] });
    expect(JSON.parse(h.run.of('writer')[0]!.user_prompt)).toMatchObject({ question: wording });
    expect(res).toMatchObject({ outcome: 'answered', citations: [{ citation: selected.citation }] });
  });

  it.each(['pure', 'mixed', 'stale'] as const)('verifies a chosen subject before selecting the matching earlier message (%s)', async mode => {
    const subject = pilots[1]!;
    const live = 'Has the June pilot shipped?';
    const quote = 'Which pilot did I say I would ship?' + (mode === 'mixed' ? ' Has it shipped?' : '');
    const h = harness([finishOn(live, ['E1'])], undefined, [writerReply([{ text: subject.text!, evidence: ['E1'] }])],
      [{ thread: 'open', resolution: 'recall', recalled: [2], ...(mode === 'mixed' ? { question: live } : {}) }]);
    h.openCitation.mockResolvedValue(result(mode === 'stale' ? [] : [subject]));
    const task = h.ask.answer({ question: quote, research_clarification: true, research_subjects: [{ label: subject.label, citation: subject.citation }],
      previous: { purpose: 'follow_up', question: 'Pilot schedule?', asked_at: '2026-11-27T12:00:00.000Z', statements: [], citations: [],
        messages: ['I promised the March pilot.', 'I promised the June pilot.'] } });
    if (mode === 'stale') {
      await expect(task).rejects.toMatchObject({ code: 'stale_access_state' });
      expect(h.run.inputs).toHaveLength(0);
    } else {
      const response = await task;
      expect(response).toMatchObject({ question: quote, recalled: [1] });
      expect(JSON.parse(h.run.of('resolver')[0]!.user_prompt)).toMatchObject({ question: quote, selected_subjects: [subject.label] });
      expect(h.run.of('step')).toHaveLength(mode === 'mixed' ? 1 : 0);
      expect(response.citations).toHaveLength(mode === 'mixed' ? 1 : 0);
    }
    expect(h.openCitation).toHaveBeenCalledOnce();
  });

  it.each(['same ambiguity', 'different ambiguity'] as const)('retains the prior intent and asks only for an unsettled distinction (%s)', async kind => {
    const selected = pilots[1]!;
    const goals = kind === 'same ambiguity'
      ? [{ label: 'March pilot', question: 'Prepare a readiness brief for March pilot.' }, { label: 'June pilot', question: 'Prepare a readiness brief for June pilot.' }]
      : [{ label: 'Readiness brief', question: 'Prepare a readiness brief for the pilot.' }, { label: 'Supplier update', question: 'Prepare a supplier update for the pilot.' }];
    const h = harness([finishOn(goals[1]!.question, ['E1'])], undefined, [writerReply([{ text: selected.text!, evidence: ['E1'] }])],
      [{ resolution: 'clarify', choices: goals }]);
    h.openCitation.mockResolvedValue(result([selected]));
    const response = await h.ask.answer({ question: 'Draft it.', research_clarification: true,
      previous: { purpose: 'follow_up', question: 'Should we draft the readiness brief or supplier update?', asked_at: '2026-11-27T12:00:00.000Z', statements: [], citations: [] },
      research_subjects: [{ label: selected.label, citation: selected.citation }] });
    expect(h.run.of('resolver')).toHaveLength(1);
    expect(h.run.of('resolver')[0]!.user_prompt).not.toContain(selected.label);
    if (kind === 'same ambiguity') {
      expect(response).toMatchObject({ outcome: 'answered', question: 'Draft it.' });
      expect(JSON.parse(h.run.of('writer')[0]!.user_prompt).question).toContain(goals[1]!.question);
      expect(h.openCitation).toHaveBeenCalledOnce();
    } else {
      expect(response).toMatchObject({ outcome: 'clarify', choices: goals });
      expect(h.run.of('step')).toHaveLength(0);
      expect(h.save).not.toHaveBeenCalled();
    }
  });

  it.each(['missing', 'different source', 'changed label', 'changed version'] as const)('stops without exposing or acting on an unverifiable selection (%s)', async why => {
    const selected = pilots[0]!;
    const h = harness([]);
    const changed = { ...selected, label: 'New name', text: 'The subject was renamed.' };
    const replacement = why === 'missing' ? [] : why === 'different source' ? [{ ...pilots[1]!, label: selected.label }]
      : why === 'changed version' ? [{ ...selected, citation: record('replacement').citation }] : [changed];
    h.openCitation.mockResolvedValue(result(replacement));
    await expect(h.ask.answer({ question, research_clarification: true, research_subjects: [{ label: selected.label, citation: selected.citation }] }))
      .rejects.toMatchObject({ code: 'stale_access_state' });
    expect(h.run.inputs).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each(['opted in', 'older client', 'Ask again'] as const)('answers both pilots when a short comparison suffices (%s)', async mode => {
    const comparison = 'How are the pilots doing?';
    const written = writerReply(pilots.map((pilot, i) => ({ text: pilot.text!, evidence: ['E' + (i + 1)] })));
    const h = harness([searchFor(comparison, 'pilot'), finishOn(comparison, ['E1', 'E2'])], undefined, [written]);
    const res = await h.ask.answer({ question: comparison, ...(mode === 'older client' ? {} : { research_clarification: true }),
      ...(mode === 'Ask again' ? { previous: { purpose: 'ask_again', question: comparison, asked_at: '2026-11-27T12:00:00.000Z', statements: [], citations: [] } as const } : {}) });
    expect(res.outcome).toBe('answered');
    expect(res.citations.map(item => item.citation)).toEqual(pilots.map(pilot => pilot.citation));
    const statements = [res.direct, ...res.parts.flatMap(part => part.statements)].filter(value => value !== undefined);
    for (const [index, pilot] of pilots.entries()) {
      expect(statements).toContainEqual(expect.objectContaining({ text: pilot.text, citation_indexes: [index] }));
    }
    const step = h.run.of('step')[1]!;
    expect(JSON.stringify(step.schema).includes('"clarify"')).toBe(mode === 'opted in');
    expect(step.system_prompt.includes('findings for each subject')).toBe(mode === 'opted in');
  });
});
