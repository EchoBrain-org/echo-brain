import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedTool } from '../../src/shared/protocol.js';
import { byTestId, cover, elements, flush, Held, ok, plainHooks, render, rpcFor, startStore, storeLifecycle, text, uncover } from './harness.js';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile: vi.fn() }));
vi.mock('preact/hooks', original => plainHooks(original));
const jira: ConnectedTool = { tool_id: 'jira', name: 'Jira', status: 'unlinked' };
let tools: ConnectedTool[];
let result: { status: string; failure_reason: string | null };
storeLifecycle(new Date('2026-10-31T12:00:00.000Z'));
beforeEach(() => {
  let attempts = 0;
  tools = [jira, { tool_id: 'slack', name: 'Slack', status: 'linked' }, { tool_id: 'confluence', name: 'Confluence', status: 'unlinked' }, { tool_id: 'granola', name: 'Granola', status: 'unavailable' }];
  result = { status: 'pending', failure_reason: null };
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(new Held(), {
    'account.tools': () => ok({ tools }),
    'tools.connect': () => ok({ attempt_id: `att_${++attempts}`, expires_at: '2026-10-31T12:30:00.000Z' }),
    'tools.status': () => ok(result),
    'tools.cancel': () => ok({ status: 'cancelled', failure_reason: null }),
  }, () => ({ active: [], archived: [] })));
});
const calls = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

describe('connected tools', () => {
  it('groups tools by connection and covers the page while another app is in front', async () => {
    tools[0] = { ...jira, status: 'revoked' };
    const store = await startStore(); await store.openTools(); await flush();
    const { Tools } = await import('../../src/renderer/screens/tools.js');
    const shown = render(Tools({ state: store.getState(), page: store.getState().tools! }));
    expect(elements(shown).filter(node => node.type === 'section' && node.props['aria-label']).map(node => node.props['aria-label']))
      .toEqual(['Needs attention', 'Connected', 'Available', 'Not turned on']);
    expect(byTestId(shown, 'tool-row').map(text)).toEqual(['JJiraConnection stopped. Reconnect to keep using it.Reconnect', 'SSlackConnectedManage',
      'CConfluenceNot connectedConnect', 'GGranolaNot turned on for your organization.']);
    cover(store); expect(store.pageCovered()).toBe(true);
    await uncover(store); expect(store.pageCovered()).toBe(false); expect(store.getState().tools?.items).toHaveLength(4);
  });

  it('a refused connection says why, and Try again starts a new attempt', async () => {
    result = { status: 'failed', failure_reason: 'account_mismatch' };
    const store = await startStore(); await store.openTools();
    void store.connectTool(jira); await flush(); await vi.advanceTimersByTimeAsync(2000);
    const sheet = store.getState().sheet!;
    expect(sheet).toMatchObject({ kind: 'tool-connect', phase: 'failed', reason: 'account_mismatch' });
    if (sheet.kind !== 'tool-connect') throw new Error('Missing connection sheet');
    const { ToolConnect } = await import('../../src/renderer/screens/tools.js');
    const shown = render(ToolConnect({ sheet }));
    expect(elements(shown).filter(node => node.type === 'h2').map(text)).toEqual(['Jira was not connected']);
    expect(text(byTestId(shown, 'tool-connect-failure'))).toBe('That Jira account does not match the one you connected before. Sign in with that account and try again.');
    void store.connectTool(jira); await flush();
    expect(calls('tools.connect')).toHaveLength(2);
    expect(store.getState().sheet).toMatchObject({ phase: 'waiting' });
    store.cancelConnect(); await flush();
    expect(store.getState().sheet).toBeNull(); expect(calls('tools.cancel')[0]).toMatchObject({ attempt_id: 'att_2', tool_id: 'jira' });
  });

  it('Cancel ends a waiting connection and polling, even after another app was in front', async () => {
    const store = await startStore(); await store.openTools(); void store.connectTool(jira); await flush();
    cover(store); expect(store.getState().sheet?.kind).toBe('tool-connect'); await uncover(store);
    store.closeSheet(); await flush();
    expect(store.getState().sheet).toBeNull(); expect(calls('tools.cancel')[0]).toMatchObject({ tool_id: 'jira', attempt_id: 'att_1' });
    const before = [calls('tools.status').length, calls('account.tools').length];
    await vi.advanceTimersByTimeAsync(10000);
    expect([calls('tools.status').length, calls('account.tools').length]).toEqual(before);
    expect(store.getState().tools?.items?.find(tool => tool.tool_id === 'jira')?.status).toBe('unlinked');
  });
});
