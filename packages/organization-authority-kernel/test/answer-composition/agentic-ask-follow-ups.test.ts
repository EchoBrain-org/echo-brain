import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  validatePersonAnswerResponseV8, validatePersonAskProgressStepEventV3, validatePersonAskReceiptV3, validatePersonFollowUpEvidenceV1, type PersonAskProgressStepEventV3,
  type PersonFollowUpEvidenceV1,
} from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV5 } from '../../src/answer-composition/agentic-ask-v1.js';
import { ANSWER_PROMPT, ASK_STEP_PROMPT, FOLLOW_UPS_ANSWER_GUIDANCE, FOLLOW_UPS_STEP_GUIDANCE } from '../../src/answer-composition/agentic-ask-v1-model-protocol.js';
import { citationOfAgenticEvidenceItemV1, describeAgenticEvidenceItemV1 } from '../../src/answer-composition/agentic-evidence-bundle-v1.js';
import type { StructuredGenerationInput } from '../../src/answer-composition/structured-generation-v1.js';
import { evidenceDeskSourceV2, type EvidenceDeskItemV2, type EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from '../../src/shared/follow-up-evidence-v1.js';
import { result } from './fixtures/agentic-scenarios.js';

/**
 * Follow-ups in the research loop and the Ask writer (ADR-0040): the prompt
 * text and step schema that name them, list owner and status applied by the
 * desk, dated reads refused before the desk, loose source names, and how a
 * model and a citation see one.
 */

const JIRA = { source_id: 'jira', kind: 'ticket', selector: 'tickets', description: 'Live work items.', metadata_only_list: true, tool_id: 'jira' } as const;
const generation = { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 };
const checked = { checked_at: '2026-10-16T00:00:00.000Z' };
const question = 'What are my open tasks?';
const decision = { title: 'THERM DVT recovery sync', first_line: 'Ship fan curve v2 before DVT.', ref: `meeting:sha256:${'a'.repeat(64)}` } as const;

function followUp(n: number, value: Omit<PersonFollowUpEvidenceV1, 'item_id' | 'kind'>): EvidenceDeskItemV2 {
  const fields = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: `itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a1${n}`, kind: 'ticket', ...value }));
  return Object.freeze({ id: `follow-up-${n}`, ...fields, visibility: 'team', receipt_sha256: canonicalSha256(`follow-up-${n}`) });
}
const fanCurve = followUp(1, { title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open', due_at: '2026-10-20', check: { verdict: 'still_open', checked_at: '2026-10-15T09:30:00.000Z' }, decision, expected: 'Reflect the v2 fan curve' });
const thresholds = followUp(2, { title: 'THERM-46 Alarm thresholds', owner: 'Mara Lind', status: 'open', decision });

function deskWith(live: NonNullable<EvidenceDeskPortV2['live_sources']>, items: readonly EvidenceDeskItemV2[] = [fanCurve, thresholds]) {
  return {
    scope: { kind: 'global' as const }, live_sources: live,
    search: vi.fn(async (_input: Parameters<EvidenceDeskPortV2['search']>[0]) => result(items)),
    list: vi.fn(async (input: Parameters<EvidenceDeskPortV2['list']>[0]) => input.source === 'follow_ups' ? result(items) : result([])),
    open: vi.fn(async () => result([items[0]!])),
    revalidate: vi.fn(async () => checked),
  } satisfies EvidenceDeskPortV2;
}
const step = (status: 'open' | 'found', actions: readonly unknown[], evidence: readonly string[] = []) =>
  ({ parts: [{ question, notes: '', needs: [{ need: 'Open follow-ups', status, evidence: status === 'found' ? evidence : [] }] }], actions });
/** A scripted model: what each call was given, in order. Step calls are the research agent's. */
function scripted(replies: unknown[]) {
  const inputs: StructuredGenerationInput[] = [];
  return {
    inputs,
    steps: () => inputs.filter(input => input.system_prompt.startsWith("You are Echo's research agent")),
    writer: () => inputs.find(input => input.system_prompt.startsWith("You write Echo's final answer")),
    model: { generate: async (input: StructuredGenerationInput) => { inputs.push(input); return replies.shift() ?? { sentences: [], not_found: [] }; } },
  };
}
const userOf = (input: StructuredGenerationInput) => JSON.parse(input.user_prompt) as Record<string, unknown> & { last_results: Record<string, unknown>[]; seen: Record<string, unknown>[] };
const listSources = (input: StructuredGenerationInput): readonly string[] => {
  const actions = (input.schema as { properties: { actions: { items: { anyOf: { properties: { tool: { enum: string[] }; args: { properties: { source?: { enum: string[] } } } } }[] } } } }).properties.actions.items.anyOf;
  return actions.find(action => action.properties.tool.enum[0] === 'list')!.properties.args.properties.source!.enum;
};
const asker = { display_name: 'Mara Lind' };

describe('follow-ups in research and the Ask writer (ADR-0040)', () => {
  it('tells research and the writer about follow-ups only when the catalog lists them, keeping the live guidance for tools', async () => {
    const followUpsOnly = scripted([
      step('open', [{ tool: 'list', args: { source: 'follow_ups', owner: 'Mara Lind', status: 'open' } }]),
      step('found', [{ tool: 'finish', args: {} }], ['E1']),
      { sentences: [{ text: 'You own the open fan curve follow-up.', evidence: ['E1'] }], not_found: [] },
    ]);
    await createAgenticAskV5({ desk: deskWith([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]), model: followUpsOnly.model, audit: { append: () => undefined }, generation, asker }).answer({ question });
    expect(followUpsOnly.steps()[0]!.system_prompt).toBe(`${ASK_STEP_PROMPT}\n\n${FOLLOW_UPS_STEP_GUIDANCE}`);
    expect(followUpsOnly.writer()!.system_prompt).toBe(`${ANSWER_PROMPT}\n\n${FOLLOW_UPS_ANSWER_GUIDANCE}`);
    expect(listSources(followUpsOnly.steps()[0]!)).toEqual(['meetings', 'documents', 'follow_ups']);
    expect((userOf(followUpsOnly.steps()[0]!).source_catalog as { source: string }[]).at(-1)).toEqual({ source: 'follow_ups', kind: 'follow_up', description: FOLLOW_UPS_SOURCE_DESCRIPTOR_V1.description, metadata_only_list: false, capabilities: FOLLOW_UPS_SOURCE_DESCRIPTOR_V1.capabilities });

    const withTools = scripted([step('open', [{ tool: 'finish', args: {} }])]);
    await createAgenticAskV5({ desk: deskWith([JIRA, FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]), model: withTools.model, audit: { append: () => undefined }, generation }).answer({ question }).catch(() => undefined);
    const toolsPrompt = withTools.steps()[0]!.system_prompt;
    expect(toolsPrompt.startsWith(`${ASK_STEP_PROMPT}\n\nLive sources report current tool context`)).toBe(true);
    expect(toolsPrompt.endsWith(`\n\n${FOLLOW_UPS_STEP_GUIDANCE}`)).toBe(true);
    expect(listSources(withTools.steps()[0]!)).toEqual(['meetings', 'documents', 'tickets', 'follow_ups']);

    // A desk without follow-ups, as task research binds, leaves its prompts exactly what they were before follow-ups existed.
    const without = scripted([step('open', [{ tool: 'finish', args: {} }])]);
    await createAgenticAskV5({ desk: deskWith([JIRA]), model: without.model, audit: { append: () => undefined }, generation }).answer({ question }).catch(() => undefined);
    const withoutPrompt = without.steps()[0]!.system_prompt;
    expect(withoutPrompt).toBe(toolsPrompt.slice(0, -`\n\n${FOLLOW_UPS_STEP_GUIDANCE}`.length));
    expect(withoutPrompt).not.toContain('follow_ups');
    expect(listSources(without.steps()[0]!)).toEqual(['meetings', 'documents', 'tickets']);
  });

  it('lists follow-ups by owner and status at the desk, and the writer and answer see each as a follow-up', async () => {
    const desk = deskWith([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]);
    const run = scripted([
      step('open', [{ tool: 'list', args: { source: 'follow_ups', owner: ' @Mara ', status: 'In progress', kind: 'action' } }]),
      step('found', [{ tool: 'finish', args: {} }], ['E1', 'E2']),
      { sentences: [{ text: 'You have two open follow-ups: the fan curve, due Oct 20, and the alarm thresholds.', evidence: ['E1', 'E2'] }], not_found: [] },
    ]);
    const answer = await createAgenticAskV5({ desk, model: run.model, audit: { append: () => undefined }, generation, asker }).answer({ question });

    expect(desk.list).toHaveBeenCalledTimes(1);
    const input = desk.list.mock.calls[0]![0];
    expect(input).toMatchObject({ source: 'follow_ups', owner: 'Mara', status: 'open' });
    // Owner and status never default follow-ups to a meeting kind, and kind is a meeting filter only.
    expect(input).not.toHaveProperty('kinds');
    const listed = userOf(run.steps()[1]!);
    // Each filter's outcome comes back with the result (research tool contract v1): kind is ignored, owner and status applied.
    expect(listed.last_results).toEqual([{ tool: 'list', args: { source: 'follow_ups', owner: '@Mara', status: 'In progress', kind: 'action' }, list: 'L1', items: ['E1', 'E2'], more: false, filters: { kind: 'ignored', owner: 'applied', status: 'applied' }, note: 'follow_ups takes no kind; ignored' }]);
    expect(listed.seen).toEqual([
      { id: 'E1', source: 'follow_ups', kind: 'follow_up', title: 'THERM-48 Fan curve v2', provenance: { kind: 'follow_up' }, attributes: { owner: 'Mara Lind', status: 'open', due_at: '2026-10-20' }, dates: { checked: '2026-10-15T09:30:00.000Z' }, text: fanCurve.text, full: true },
      { id: 'E2', source: 'follow_ups', kind: 'follow_up', title: 'THERM-46 Alarm thresholds', provenance: { kind: 'follow_up' }, attributes: { owner: 'Mara Lind', status: 'open' }, text: thresholds.text, full: true },
    ]);
    expect((JSON.parse(run.writer()!.user_prompt) as { evidence: unknown[] }).evidence).toEqual([
      { id: 'E1', source: 'follow_ups', kind: 'follow_up', title: 'THERM-48 Fan curve v2', provenance: { kind: 'follow_up' }, attributes: { owner: 'Mara Lind', status: 'open', due_at: '2026-10-20' }, dates: { checked: '2026-10-15T09:30:00.000Z' }, text: fanCurve.text },
      { id: 'E2', source: 'follow_ups', kind: 'follow_up', title: 'THERM-46 Alarm thresholds', provenance: { kind: 'follow_up' }, attributes: { owner: 'Mara Lind', status: 'open' }, text: thresholds.text },
    ]);
    expect(validatePersonAnswerResponseV8(answer).citations).toEqual([fanCurve, thresholds].map(item => ({ citation: item.citation, kind: 'follow_up', label: item.label, visibility: 'team', ref: item.ref })));
  });

  it('keeps owner and status notes truthful for sources that ignore them', async () => {
    const noteFor = async (live: NonNullable<EvidenceDeskPortV2['live_sources']>) => {
      const run = scripted([step('open', [{ tool: 'list', args: { source: 'documents', owner: 'Mara', status: 'open' } }]), step('open', [{ tool: 'finish', args: {} }])]);
      await createAgenticAskV5({ desk: deskWith(live), model: run.model, audit: { append: () => undefined }, generation }).answer({ question }).catch(() => undefined);
      return userOf(run.steps()[1]!).last_results[0]!.note;
    };
    // A source says itself which filters it takes (research tool contract v1), whatever else the catalog holds.
    expect(await noteFor([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1])).toBe('documents takes no status; ignored; documents takes no owner; ignored; nothing more to list');
    expect(await noteFor([])).toBe('documents takes no status; ignored; documents takes no owner; ignored; nothing more to list');
  });

  it("reads follow-ups by their own dates, and refuses a due date and statuses outside open and done before the desk", async () => {
    const desk = deskWith([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]);
    const run = scripted([
      step('open', [
        { tool: 'list', args: { source: 'follow_ups', since: '2026-10-09' } },
        { tool: 'search', args: { source: 'follow_ups', query: 'fan curve', until: '2026-10-16' } },
        { tool: 'search', args: { source: 'follow_ups', query: 'fan curve', date_field: 'due' } },
        { tool: 'list', args: { source: 'follow_ups', status: 'unsent' } },
      ]),
      step('open', [{ tool: 'finish', args: {} }]),
    ]);
    await createAgenticAskV5({ desk, model: run.model, audit: { append: () => undefined }, generation }).answer({ question }).catch(() => undefined);
    // A window with no date field reads any of a follow-up's own dates (research tool contract v1).
    expect(desk.list).toHaveBeenCalledTimes(1);
    expect(desk.list.mock.calls[0]![0]).toMatchObject({ source: 'follow_ups', since: '2026-10-09', date_field: 'any' });
    expect(desk.search).toHaveBeenCalledTimes(1);
    expect(desk.search.mock.calls[0]![0]).toMatchObject({ source: 'follow_ups', until: '2026-10-16', date_field: 'any' });
    // A due date belongs to the item a follow-up is on, and open and done are its only statuses: both refused, never sent.
    const results = userOf(run.steps()[1]!).last_results;
    expect(results[2]).toMatchObject({ filters: { date_field: 'refused' }, note: 'refused: follow_ups: date_field must be created, sent, reassigned, checked' });
    expect(results[3]).toMatchObject({ filters: { status: 'refused' }, note: 'refused: follow_ups: status must be open or done' });
    expect(results.map(value => value.error)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('resolves loose follow-up source names to the follow-ups source', async () => {
    const desk = deskWith([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]);
    const run = scripted([
      step('open', [{ tool: 'list', args: { source: 'Open items' } }, { tool: 'search', args: { source: 'follow-ups', query: 'THERM-48' } }]),
      step('open', [{ tool: 'finish', args: {} }]),
    ]);
    await createAgenticAskV5({ desk, model: run.model, audit: { append: () => undefined }, generation }).answer({ question }).catch(() => undefined);
    expect(desk.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'follow_ups' }));
    expect(desk.search).toHaveBeenCalledWith(expect.objectContaining({ source: 'follow_ups', query: 'THERM-48', kinds: ['follow_up'] }));
  });

  it('streams an Ask in progress V3: its search names follow-ups, and its reads and receipt name each follow-up it read (ADR-0039)', async () => {
    const run = scripted([
      step('open', [{ tool: 'list', args: { source: 'follow_ups', owner: 'Mara Lind', status: 'open' } }]),
      step('found', [{ tool: 'finish', args: {} }], ['E1']),
      { sentences: [{ text: 'You own the open fan curve follow-up.', evidence: ['E1'] }], not_found: [] },
    ]);
    const audits: Record<string, unknown>[] = [];
    const events: PersonAskProgressStepEventV3[] = [];
    const { response, receipt } = await createAgenticAskV5({ desk: deskWith([FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]), model: run.model, audit: { append: entry => { audits.push(entry as never); } }, generation, asker })
      .answerWithReceipt({ question, on_progress: event => { events.push(event); } });
    const named = [fanCurve, thresholds].map(item => ({ citation: item.citation, kind: 'follow_up', label: item.label, visibility: 'team', ref: item.ref }));
    for (const event of events) expect(validatePersonAskProgressStepEventV3(event)).toEqual(event);
    expect(events.filter(event => event.type !== 'stage')).toEqual([
      { type: 'searched', sources: [{ kind: 'follow_ups' }], found: 2 },
      { type: 'read', items: named },
    ]);
    // Nothing a follow-up's text holds (its owner, decision or check) travels in a step: only its citation projection.
    expect(JSON.stringify(events)).not.toContain('Mara');
    expect(JSON.stringify(events)).not.toContain(decision.first_line);
    expect(validatePersonAnswerResponseV8(response).citations).toEqual([named[0]]);
    expect(validatePersonAskReceiptV3(receipt)).toEqual({ looked_through: 2, elapsed_ms: receipt.elapsed_ms, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 2 }, { type: 'read', items: named }] });
    expect(audits.at(-1)).toMatchObject({ named_citation_digests: [fanCurve, thresholds].map(item => canonicalSha256(item.citation)) });
  });

  it('describes and cites a follow-up as its own kind, with the ref that opens its item page', () => {
    // An item a desk released without a dispatcher source still belongs to follow-ups, never meetings.
    expect(evidenceDeskSourceV2(fanCurve)).toBe('follow_ups');
    expect(describeAgenticEvidenceItemV1({ short: 'E3', source: 'follow_ups', item: fanCurve })).toEqual({
      id: 'E3', source: 'follow_ups', kind: 'follow_up', title: 'THERM-48 Fan curve v2', provenance: { kind: 'follow_up' }, attributes: { owner: 'Mara Lind', status: 'open', due_at: '2026-10-20' },
      // A follow-up's own dates (research tool contract v1): its last check here.
      dates: { checked: '2026-10-15T09:30:00.000Z' },
    });
    expect(citationOfAgenticEvidenceItemV1(fanCurve)).toEqual({ citation: fanCurve.citation, kind: 'follow_up', label: 'THERM-48 Fan curve v2', visibility: 'team', ref: `follow_up:${fanCurve.citation.kind === 'follow_up' ? fanCurve.citation.item_id : ''}` });
  });
});
