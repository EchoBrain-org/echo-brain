import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV8, type PersonAnswerPreviousV1 } from '@echo-brain/organization-api';
import { createAgenticAskV5, type AgenticAskAuditEntryV1, type AskFollowUpDraftV1 } from '../../src/answer-composition/agentic-ask-v1.js';
import { ANSWER_PROMPT, answerBlocksFollowUpsSchema, answerBlocksSchema } from '../../src/answer-composition/agentic-ask-v1-model-protocol.js';
import { FOLLOW_UP_RESOLVER_PROMPT } from '../../src/answer-composition/agentic-follow-up-resolver-v1.js';
import { parseAgenticDriverFinishV1, type AgenticResearchDriverSessionV1 } from '../../src/answer-composition/agentic-research-driver-v1.js';
import { askFollowUpItemIdV1 } from '../../src/answer-composition/ask-follow-ups-v1.js';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import type { EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import { checked, generation, record, result, writerReply } from './fixtures/agentic-scenarios.js';

/**
 * The follow-ups an Ask answer drafts (ADR-0053), end to end through the runner: research by a scripted driver, the
 * writer's one call, the release step, and the request's sink. Research stays read only; only a released answer saves.
 */
const REQUEST = 'ask_6b0f8a52-55a4-4f6e-9a39-0000000000aa';
const evidence = record('vendor', 'Approved: Sam Lee calls the vendor about the fixture delay.');
const packets = new WeakMap<AgenticResearchDriverSessionV1, unknown[]>();
const admit = (session: AgenticResearchDriverSessionV1, label = 'request') => session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256({ label }), payload_digests: (packets.get(session) ?? []).map(canonicalSha256), operation: 'messages' }, async () => ({ value: undefined }));
const found = { completed: true, follow_up_requested: true, parts: [{ question: 'The vendor call', notes: 'Approved.', needs: [{ need: 'who calls the vendor', kind: 'content', status: 'found', evidence: ['E1'] }] }] };
const drafted = [{ task: 'Call the vendor about the fixture delay', owner: 'Sam Lee', due_on: '2026-11-20', about: 'E1' }];

function harness(options: {
  readonly research?: (session: AgenticResearchDriverSessionV1) => Promise<void>;
  readonly reply?: unknown;
  readonly bound?: boolean;
  readonly desk?: Partial<EvidenceDeskPortV2>;
  readonly on_append?: () => void;
  readonly on_generate?: () => void;
} = {}) {
  const trace: string[] = [];
  const saved: (readonly AskFollowUpDraftV1[])[] = [];
  const audit: AgenticAskAuditEntryV1[] = [];
  const inputs: StructuredGenerationInput[] = [];
  const desk: EvidenceDeskPortV2 = { scope: { kind: 'global' }, search: async () => result([evidence]), open: async () => result([evidence]), list: async () => result([evidence]), revalidate: async () => checked, ...options.desk };
  const generate = vi.fn(async (input: StructuredGenerationInput) => {
    inputs.push(input); options.on_generate?.();
    return options.reply ?? { ...writerReply([{ text: 'Sam Lee calls the vendor.', evidence: ['E1'] }]), follow_ups: drafted };
  });
  const research = options.research ?? (async session => {
    await admit(session);
    await session.call('search', { query: 'vendor call' });
    await admit(session, 'observed');
    expect(await session.call('finish', found)).toMatchObject({ accepted: true });
  });
  const driver = { run: async (session: AgenticResearchDriverSessionV1) => {
    const released = [session.initial];
    const wrapped = { ...session, call: async (...args: Parameters<AgenticResearchDriverSessionV1['call']>) => { const value = await session.call(...args); released.push(value); return value; } };
    packets.set(wrapped, released); return research(wrapped);
  } };
  const sink = { save: vi.fn((drafts: readonly AskFollowUpDraftV1[]) => { trace.push('save'); saved.push(drafts); }) };
  const ask = createAgenticAskV5({
    desk, model: { generate }, generation, research_driver: driver, today: () => '2026-11-18',
    audit: { append: (entry: AgenticAskAuditEntryV1) => { trace.push('append'); audit.push(entry); options.on_append?.(); } },
    ...(options.bound === false ? {} : { follow_ups: { request_id: REQUEST, sink } }),
  });
  return { ask, sink, saved, trace, audit, inputs };
}

describe('Ask answers that draft follow-ups (ADR-0053)', () => {
  it('saves the checked drafts once, after the audit and the last check, and lists their ids on the answer', async () => {
    const h = harness();
    const output = await h.ask.answerWithResearch({ question: 'Ask Sam to call the vendor by Friday.' });
    const id = askFollowUpItemIdV1(REQUEST, 0);
    expect(output.research.stop).toMatchObject({ completed: true, follow_up_requested: true });
    expect(output.research.stop).not.toHaveProperty('unsupported_action');
    expect(output.response).toMatchObject({ outcome: 'answered', follow_ups: [id] });
    expect(output.follow_ups).toEqual([{ item_id: id, task: 'Call the vendor about the fixture delay', owner_name: 'Sam Lee', due_on: '2026-11-20', about: evidence.citation }]);
    expect(h.saved).toEqual([output.follow_ups]);
    expect(h.trace).toEqual(['append', 'save']);
    expect(h.inputs[0]!.schema).toBe(answerBlocksFollowUpsSchema);
    expect(h.audit[0]!.answer_sha256).not.toBeNull();
  });

  it('runs the writer with no evidence for a follow-up about nothing ECHO knows, and saves what it drafted', async () => {
    const search = vi.fn(async () => result([]));
    const h = harness({
      desk: { search },
      research: async session => { await admit(session); expect(await session.call('finish', { completed: true, follow_up_requested: true, parts: [] })).toMatchObject({ accepted: true }); },
      reply: { lists: [], blocks: [{ block: 'answer', sentences: [{ text: 'Drafted.', evidence: [] }] }], not_found: [], follow_ups: [{ task: 'Call the vendor', owner: 'Sam' }] },
    });
    const response = await h.ask.answer({ question: 'Ask Sam to call the vendor.' });
    expect(search).not.toHaveBeenCalled();
    // The loop's own plan for a finish that names nothing still gives a valid answer (the renderer's test lays its own plan).
    expect(validatePersonAnswerResponseV8(response)).toEqual(response);
    expect(h.saved).toEqual([[{ item_id: askFollowUpItemIdV1(REQUEST, 0), task: 'Call the vendor', owner_name: 'Sam' }]]);
  });

  it('saves nothing when the request is cancelled during its audit', async () => {
    const controller = new AbortController();
    const h = harness({ on_append: () => controller.abort() });
    await expect(h.ask.answer({ question: 'Ask Sam to call the vendor by Friday.', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.sink.save).not.toHaveBeenCalled();
  });

  it('saves nothing when the release access check refuses', async () => {
    let refuse = false;
    const h = harness({ on_generate: () => { refuse = true; },
      desk: { revalidate: async () => { if (refuse) throw new AuthorityOperationError('stale_access_state', 'Live evidence operation could not be completed'); return checked; } } });
    await expect(h.ask.answer({ question: 'Ask Sam to call the vendor by Friday.' })).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(h.sink.save).not.toHaveBeenCalled();
  });

  it('drafts nothing and lists nothing when the request binds no sink', async () => {
    const h = harness({ bound: false });
    const output = await h.ask.answerWithResearch({ question: 'Ask Sam to call the vendor by Friday.' });
    expect(output.response).not.toHaveProperty('follow_ups');
    expect(output).not.toHaveProperty('follow_ups');
    expect(h.inputs[0]!.schema).toBe(answerBlocksSchema);
    // Research asked for a follow-up this request cannot save: the answer says Ask could not act.
    expect(output.response.parts[0]!.gap_details).toMatchObject({ unsupported_action: true });
  });

  it('screens a follow-up turn against what the person typed, not the question the resolver rewrote from the previous answer', async () => {
    const text = 'The heater controller overshoots during the 45 degree soak and trips the fixture.';
    const ticket = Object.freeze({
      id: 'ticket-77', kind: 'ticket' as const, label: 'THERM-77: Heater overshoot', text, visibility: 'only_me' as const, occurred_at: '2026-11-10', receipt_sha256: canonicalSha256({ ticket: 77 }),
      citation: { kind: 'ticket' as const, tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10077', permalink: 'https://example.atlassian.net/browse/THERM-77', text_sha256: sha256Digest(text) },
    });
    const typed = 'assign that task to Sam';
    const rewritten = 'Assign the task the heater controller overshoots during the 45 degree soak to Sam';
    const replies: Record<string, unknown[]> = {
      resolver: [{ resolution: 'resolved', question: rewritten, about: [1] }],
      step: [{ parts: [{ question: rewritten, notes: '', needs: [{ need: 'the task', status: 'found', evidence: ['E1'] }] }], actions: [{ tool: 'finish', args: {} }] }],
      writer: [{ ...writerReply([{ text: 'The heater controller overshoots.', evidence: ['E1'] }]), follow_ups: [{ task: 'Fix why the heater controller overshoots during the soak', owner: 'Sam' }] }],
    };
    const roleOf = (input: StructuredGenerationInput) => input.system_prompt === FOLLOW_UP_RESOLVER_PROMPT ? 'resolver' : input.system_prompt.startsWith(ANSWER_PROMPT) ? 'writer' : 'step';
    const sink = { save: vi.fn() };
    const ask = createAgenticAskV5({
      desk: { scope: { kind: 'global' }, live_sources: [], search: async () => result([]), open: async () => result([]), list: async () => result([]), revalidate: async () => checked,
        openCitation: async () => result([ticket]) },
      model: { generate: async (input: StructuredGenerationInput) => { const reply = replies[roleOf(input)]!.shift(); if (reply === undefined) throw new Error(`unscripted ${roleOf(input)}`); return reply; } },
      generation, audit: { append: () => undefined }, today: () => '2026-11-18', follow_ups: { request_id: REQUEST, sink },
    });
    const previous: PersonAnswerPreviousV1 = { purpose: 'follow_up', question: 'What is wrong with the fixture?', asked_at: '2026-11-18T17:00:00.000Z',
      statements: [{ text: text, citation_indexes: [0] }],
      citations: [{ citation: ticket.citation, kind: 'ticket', label: ticket.label, visibility: 'only_me' }] };
    const response = await ask.answer({ question: typed, previous });
    expect(response.question).toBe(rewritten);
    expect(response).not.toHaveProperty('follow_ups');
    expect(sink.save).not.toHaveBeenCalled();
  });

  it('reads a researcher finish that asks for a follow-up only for a question, and lets it name nothing to research', () => {
    expect(parseAgenticDriverFinishV1({ completed: true, follow_up_requested: true, parts: [] }, true)).toEqual({ completed: true, follow_up_requested: true, parts: [] });
    expect(() => parseAgenticDriverFinishV1({ completed: true, follow_up_requested: true, parts: [] }, false)).toThrow(/follow_up_requested/u);
    expect(() => parseAgenticDriverFinishV1({ completed: true, follow_up_requested: 'yes', parts: [] }, true)).toThrow(/follow_up_requested/u);
    expect(() => parseAgenticDriverFinishV1({ completed: true, parts: [] }, true)).toThrow(/unsupported action or a follow-up/u);
  });
});
