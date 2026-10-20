import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonAnswerResponseV7, validatePersonFollowUpEvidenceV1, type PersonFollowUpEvidenceV1 } from '@echo-brain/organization-api';
import { describe, expect, it, vi } from 'vitest';
import { createAgenticAskV3, createAgenticAskV4 } from '../../src/answer-composition/agentic-ask-v1.js';
import type { EvidenceDeskItemV2, EvidenceDeskPortV2, EvidenceDeskResultV2 } from '../../src/shared/evidence-desk-v2.js';
import {
  FOLLOW_UPS_SOURCE_DESCRIPTOR_V1,
  followUpDeskFieldsV1,
  followUpInStatusV1,
  followUpOwnerMatchesV1,
} from '../../src/shared/follow-up-evidence-v1.js';

const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const record = `sha256:${'a'.repeat(64)}` as const;
const evidence: PersonFollowUpEvidenceV1 = validatePersonFollowUpEvidenceV1({
  item_id: itemId, kind: 'ticket', title: 'THERM-48 Fan curve v2', owner: 'Mara Lind', status: 'open', due_at: '2026-10-20',
  check: { verdict: 'still_open', checked_at: '2026-10-15T09:30:00.000Z' },
  decision: { title: 'THERM DVT recovery sync', first_line: 'Ship fan curve v2 before DVT.', ref: `meeting:${record}` },
  expected: 'Reflect the v2 fan curve',
});
const fields = followUpDeskFieldsV1(evidence);
const item: EvidenceDeskItemV2 = Object.freeze({ id: 'follow-up-1', ...fields, visibility: 'team', receipt_sha256: canonicalSha256('follow-up-release') });
const result = (value: EvidenceDeskItemV2): EvidenceDeskResultV2 => ({ items: [value], truncated: false, receipt_digests: [value.receipt_sha256] });
const checked = { checked_at: '2026-10-16T00:00:00.000Z' };
const generation = { generation_adapter_id: 'fixture', planner_model: 'fixture', answer_model: 'fixture', timeout_ms: 30_000 };
const question = 'What are my open tasks?';
const step = (status: 'open' | 'found', actions: readonly unknown[]) => ({ parts: [{ question, notes: '', needs: [{ need: 'Open follow-ups', status, evidence: status === 'found' ? ['E1'] : [] }] }], actions });

function deskFor(scope: EvidenceDeskPortV2['scope']): EvidenceDeskPortV2 {
  return {
    scope, live_sources: [FOLLOW_UPS_SOURCE_DESCRIPTOR_V1],
    search: vi.fn(async () => result(item)), list: vi.fn(async () => result(item)), open: vi.fn(async () => result(item)),
    revalidate: vi.fn(async () => checked),
  };
}
/** The source catalog the first research step is shown, and the research model is never asked again. */
async function catalogOf(create: typeof createAgenticAskV3 | typeof createAgenticAskV4, scope: EvidenceDeskPortV2['scope']): Promise<readonly string[]> {
  const prompts: string[] = [];
  const replies = [step('open', [{ tool: 'finish', args: {} }]), step('open', [{ tool: 'finish', args: {} }]), { sentences: [], not_found: ['Open follow-ups'] }];
  await create({ desk: deskFor(scope), model: { generate: async input => { prompts.push(input.user_prompt); return replies.shift() ?? { sentences: [], not_found: [] }; } }, audit: { append: () => undefined }, generation })
    .answer({ question }).catch(() => undefined);
  return (JSON.parse(prompts[0]!).source_catalog as { source: string }[]).map(entry => entry.source);
}

describe('Follow-ups as Ask evidence (ADR-0040)', () => {
  it('projects one follow-up to desk fields: its title, owner, status, due date, check and decision', () => {
    expect(fields).toEqual({
      kind: 'follow_up', citation: { kind: 'follow_up', item_id: itemId }, ref: `follow_up:${itemId}`, label: 'THERM-48 Fan curve v2',
      attributes: { owner: 'Mara Lind', status: 'open', due_at: '2026-10-20' },
      dates: { checked: '2026-10-15T09:30:00.000Z' },
      text: 'On: ticket\nExpected: Reflect the v2 fan curve\nLatest check: still open on 2026-10-15\nDecision: THERM DVT recovery sync\nDecided: Ship fan curve v2 before DVT.',
    });
    // An owner who cannot read the decision gets no decision line; nothing absent is invented.
    const owned = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: itemId, kind: 'action', title: 'Send the DVT schedule', owner: 'Dana', status: 'unsent' }));
    expect(owned).toMatchObject({ label: 'Send the DVT schedule', attributes: { owner: 'Dana', status: 'not sent yet' }, text: 'On: meeting action\nLatest check: none yet' });
    expect(owned.attributes).not.toHaveProperty('due_at');
    expect(owned).not.toHaveProperty('dates');
  });

  it("carries ECHO's own dates as the desk's: created, sent, reassigned and checked, each once it happened (research tool contract v1)", () => {
    const dated = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ ...evidence, created_at: '2026-10-08T09:00:00.000Z', sent_at: '2026-10-08T09:05:00.000Z', reassigned_at: '2026-10-09T14:00:00.000Z' }));
    expect(dated.dates).toEqual({ created: '2026-10-08T09:00:00.000Z', sent: '2026-10-08T09:05:00.000Z', reassigned: '2026-10-09T14:00:00.000Z', checked: '2026-10-15T09:30:00.000Z' });
    // Its due date is its tool's, an attribute shown with a live read: never one of ECHO's dates a list filters on.
    expect(dated.dates).not.toHaveProperty('due');
    const unsent = followUpDeskFieldsV1(validatePersonFollowUpEvidenceV1({ item_id: itemId, kind: 'action', title: 'Send the DVT schedule', owner: 'Dana', status: 'unsent', created_at: '2026-10-08T09:00:00.000Z' }));
    expect(unsent.dates).toEqual({ created: '2026-10-08T09:00:00.000Z' });
    // The text keeps its lines; the dates are the item's own fields.
    expect(dated.text).toBe(fields.text);
    expect(Object.keys(FOLLOW_UPS_SOURCE_DESCRIPTOR_V1.capabilities!.dates).sort()).toEqual(Object.keys(dated.dates!).sort());
  });

  it('filters owner by every whole word of a name and status by state', () => {
    expect(followUpOwnerMatchesV1('Mara Lind', 'mara')).toBe(true);
    expect(followUpOwnerMatchesV1('Mara Lind', '@Lind mara')).toBe(true);
    expect(followUpOwnerMatchesV1('Mara Lind', 'Dana')).toBe(false);
    expect(followUpOwnerMatchesV1('Mara Lind', ' @ ')).toBe(false);
    // Whole words only: a filter word inside another name is not that name.
    expect(followUpOwnerMatchesV1('Maria Gomez', 'Ari')).toBe(false);
    expect(followUpOwnerMatchesV1('Jordan Ellis', 'Dan')).toBe(false);
    expect(followUpOwnerMatchesV1('Wei Lin', 'Li Wei')).toBe(false);
    expect(followUpOwnerMatchesV1('S. Okafor', 'okafor')).toBe(true);
    expect(followUpInStatusV1('open', 'open')).toBe(true);
    expect(followUpInStatusV1('done', 'done')).toBe(true);
    for (const state of ['unsent', 'not_relevant'] as const) for (const status of ['open', 'done'] as const) expect(followUpInStatusV1(state, status)).toBe(false);
  });

  it('appears in the source catalog only for V7 answers outside Mine', async () => {
    expect(await catalogOf(createAgenticAskV4, { kind: 'global' })).toEqual(['meetings', 'documents', 'follow_ups']);
    expect(await catalogOf(createAgenticAskV3, { kind: 'global' })).toEqual(['meetings', 'documents']);
    expect(await catalogOf(createAgenticAskV4, { kind: 'mine' })).toEqual(['meetings', 'documents']);
  });

  it('cites a follow-up in a V7 answer with the ref that opens its item page', async () => {
    const desk = deskFor({ kind: 'global' });
    const replies = [
      step('open', [{ tool: 'search', args: { source: 'follow_ups', query: 'fan curve' } }]),
      step('open', [{ tool: 'open', args: { id: 'E1' } }]),
      step('found', [{ tool: 'finish', args: {} }]),
      { sentences: [{ text: 'Mara owns the open fan curve follow-up.', evidence: ['E1'] }], not_found: [] },
    ];
    const answer = await createAgenticAskV4({ desk, model: { generate: async () => replies.shift()! }, audit: { append: () => undefined }, generation }).answer({ question });
    expect(validatePersonAnswerResponseV7(answer)).toMatchObject({ schema_version: 7, outcome: 'answered', citations: [{ citation: fields.citation, kind: 'follow_up', label: fields.label, visibility: 'team', ref: fields.ref }] });
    expect(desk.search).toHaveBeenCalledWith(expect.objectContaining({ source: 'follow_ups', query: 'fan curve', kinds: ['follow_up'] }));
  });
});
