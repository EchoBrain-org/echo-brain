// The reader on an approved meeting: read whole, as the source pane reads it,
// it keeps what opening a meeting by its ref used to show and wait for: an
// untitled meeting named as its row names it, and a read that may take as long.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedRecord, ListItem } from '../../src/shared/protocol.js';
import { HOST_TIMEOUT_MS } from '../../src/shared/protocol.js';
import { elements, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));

const RECORD = `sha256:${'7'.repeat(64)}`;
/** The meeting's row in Only me, as the Authority names one with no title. */
const row: ListItem = { ref: { kind: 'meeting', id: RECORD }, title: 'Approved meeting', added_at: '2026-09-22T09:15:00.000Z', visibility: 'only-me', projects: [] };
let record: ApprovedRecord;

storeLifecycle();
beforeEach(() => {
  record = {
    approved_at: '2026-09-22T09:15:00.000Z', all_day: false, participants: ['Ari'], participants_more: false, visibility: 'approver',
    decisions: { items: [{ text: 'Keep annual plans as priced.', excerpts: [], atom_id: `sha256:${'1'.repeat(64)}` }] }, actions: { items: [] }, rationales: { items: [] },
  };
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), { 'ask.record': () => ok(record) }, () => ({ active: [], archived: [] })));
});

/** The reader's heading, once the row is opened from Only me. */
async function heading(): Promise<string> {
  const store = await startStore();
  await store.openOnlyMe();
  await store.openListItem(row);
  const { Reader } = await import('../../src/renderer/screens/reader.js');
  const shown = render(Reader({ state: store.getState(), reader: store.getState().reader!, backTo: 'Only me' }));
  return text(elements(shown).find(node => node.type === 'h1'));
}

describe('a meeting in the reader', () => {
  it('with no title is named as its row names it, never "Untitled meeting"', async () => {
    expect(await heading()).toBe('Approved meeting');
  });

  it('with a title is named by it', async () => {
    record = { ...record, title: 'Pricing review' };
    expect(await heading()).toBe('Pricing review');
  });

  it('is read with as long a wait as opening it by its ref had', () => {
    expect(HOST_TIMEOUT_MS['ask.record']).toBeGreaterThanOrEqual(HOST_TIMEOUT_MS['open.ref']);
  });
});
