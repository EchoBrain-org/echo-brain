import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byTestId, cover, elements, fail, flush, Held, numbered, ok, plainHooks, project, render, rpcFor, startStore, storeLifecycle, text } from './harness.js';

const { rpc, dropFile } = vi.hoisted(() => ({ rpc: vi.fn(), dropFile: vi.fn() }));
vi.mock('../../src/renderer/api.js', () => ({ rpc, dropFile }));
vi.mock('preact/hooks', original => plainHooks(original));
const apollo = project(1, 29, { name: 'Apollo' }), beacon = project(2, 28, { name: 'Beacon' });
type Store = Awaited<ReturnType<typeof startStore>>;
let held: Held;
let active = [apollo, beacon];
storeLifecycle();
beforeEach(() => {
  held = new Held();
  active = [apollo, beacon];
  rpc.mockReset();
  rpc.mockImplementation(rpcFor(held, {
    'notes.submit': params => ok({ request_id: params.request_id, audience: params.audience }),
    'documents.upload': params => ok({ request_id: params.request_id, audience: params.audience, extraction: 'extracting' }),
    'documents.abandon': () => ok(null),
    'dialog.openDocument': () => ok({ handle: 'h1', name: 'Pricing.txt', size: 15 }),
  }, () => ({ active, archived: [] })));
  dropFile.mockReset().mockResolvedValue(ok({ handle: 'd1', name: 'Brief.md', size: 15 }));
});
const sent = (method: string) => rpc.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const told = () => sent('app.setUnresolved').at(-1);
const sheet = async (store: Store) => render((await import('../../src/renderer/screens/compose.js')).Compose({ state: store.getState() }));
const unknown = () => fail('unavailable', { retryable: true, mutation_outcome: 'unknown' });
const file = () => new File(['x'], 'Brief.md');
const props = (tree: unknown, id: string) => byTestId(tree, id)[0]!.props;
const shortcut = (tree: unknown) => (props(tree, 'compose').onKeyDown as (event: unknown) => void)({ key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, preventDefault: vi.fn() });
async function unconfirmed(store: Store) {
  const release = held.hold('notes.submit');
  const pending = store.sendCompose();
  release(unknown());
  await pending;
  await flush();
}

describe('where a capture goes and who can read it', () => {
  it.each(['shortcut', 'covered'] as const)('%s starts in no project even with a project on screen', async kind => {
    const store = await startStore();
    await store.openProject(apollo);
    if (kind === 'covered') { cover(store); store.openCompose(); }
    else store.openCapture();
    expect(store.getState().compose).toMatchObject({ place: 'none', projects: [], context: null });
  });

  it('Only me starts locked, while a widened Ask chip does not change the project capture uses', async () => {
    const store = await startStore();
    await store.openOnlyMe();
    store.openCompose();
    let shown = await sheet(store);
    expect(props(shown, 'capture-lock')).toMatchObject({ 'aria-pressed': true, 'aria-disabled': 'true' });
    expect(text(byTestId(shown, 'compose-readers'))).toBe('Only you can read this.');
    // Finish the private capture before opening one from a project.
    store.setComposeText('Private');
    await store.sendCompose();
    await store.openProject(apollo);
    store.widenScope();
    store.openCompose();
    expect(store.getState().compose?.projects).toEqual([apollo]);
    const before = sent('list.page').length;
    store.setComposeText('Launch moved to Friday');
    await store.sendCompose();
    await flush();
    expect(store.getState()).toMatchObject({ compose: null, toast: 'Saved to Apollo', route: { page: 'project' }, barScope: { kind: 'global' } });
    expect(sent('list.page').slice(before).map(params => params.scope)).toEqual([{ kind: 'project', project_id: apollo.project_id }]);
  });

  it('names the audience accessibly and saves a locked project with the keyboard shortcut', async () => {
    const store = await startStore();
    store.openCompose();
    let shown = await sheet(store);
    const group = elements(shown).find(node => node.props.role === 'group' && node.props['aria-label'] === 'Where it goes');
    expect(byTestId(group, 'capture-place')).toHaveLength(1);
    expect(byTestId(group, 'capture-lock')).toHaveLength(1);
    expect(props(shown, 'capture-place')).toMatchObject({ 'aria-haspopup': 'dialog', 'aria-expanded': false, 'aria-describedby': 'capture-readers' });
    store.openProjects();
    shown = await sheet(store);
    expect(props(shown, 'capture-place')).toMatchObject({ 'aria-expanded': true, 'aria-controls': 'projects-list' });
    expect(props(shown, 'projects-list').role).toBe('dialog');
    expect(byTestId(shown, 'projects-row').map(text)).toEqual(['Apollo', 'Beacon']);
    expect(props(shown, 'place-none')['aria-checked']).toBe(true);
    store.tickProject(apollo);
    shown = await sheet(store);
    expect(text(byTestId(shown, 'capture-place'))).toBe('Apollo');
    expect(text(byTestId(shown, 'compose-readers'))).toBe('Apollo members can read this.');
    expect(props(shown, 'capture-lock')['aria-pressed']).toBe(false);
    store.closeProjects();
    store.toggleOnlyMe();
    store.setComposeText('Kickoff moved to Monday');
    shortcut(await sheet(store));
    await flush();
    expect(sent('notes.submit')).toHaveLength(1);
    expect(sent('notes.submit')[0]).toMatchObject({ audience: { kind: 'only-me' }, project_ids: [apollo.project_id] });
  });

  it('keeps the selected projects when closed empty, and saves several with sorted ids', async () => {
    const store = await startStore();
    store.openCompose();
    store.setComposeText('Pricing for both teams');
    store.openProjects(); store.closeProjects();
    expect(store.getState().compose).toMatchObject({ place: 'none', picking: null });
    store.openProjects(); store.tickProject(beacon); store.tickProject(apollo); store.closeProjects();
    expect(text(byTestId(await sheet(store), 'capture-place'))).toBe('Beacon +1');
    expect(text(byTestId(await sheet(store), 'compose-readers'))).toBe('Members of Beacon and Apollo can read this.');
    store.openProjects();
    expect(elements(byTestId(await sheet(store), 'projects-row')).filter(node => node.type === 'input').map(node => node.props.checked)).toEqual([true, true]);
    store.openProjects();
    expect(store.getState().compose?.picking).toBeNull();
    store.openProjects(); store.tickProject(apollo); store.tickProject(beacon);
    expect(text(byTestId(await sheet(store), 'compose-readers'))).toBe('Choose one or more projects.');
    expect(props(await sheet(store), 'compose-send').disabled).toBe(true);
    await store.sendCompose(); shortcut(await sheet(store)); await flush();
    expect(sent('notes.submit')).toHaveLength(0);
    store.closeProjects();
    expect(store.getState().compose?.projects).toEqual([beacon, apollo]);
    await store.sendCompose();
    expect(sent('notes.submit')[0]).toMatchObject({ audience: { kind: 'projects', project_ids: [apollo.project_id, beacon.project_id] }, project_ids: [apollo.project_id, beacon.project_id] });
    expect(store.getState().toast).toBe('Saved to Beacon and Apollo');
  });

  it('Organization and No project clear the project choices and say who can read the capture', async () => {
    const store = await startStore();
    await store.openProject(apollo);
    store.openCompose(); store.setComposeText('Not for either team'); store.openProjects(); store.tickProject(beacon);
    store.choosePlace('team');
    expect(store.getState().compose).toMatchObject({ place: 'team', projects: [], picking: null });
    let shown = await sheet(store);
    expect(byTestId(shown, 'capture-lock')).toHaveLength(0);
    expect(text(byTestId(shown, 'compose-readers'))).toBe('Everyone in your org can read this.');
    expect(props(shown, 'compose-readers').class).toContain('warning');
    store.openProjects();
    shown = await sheet(store);
    expect(props(shown, 'place-team')['aria-checked']).toBe(true);
    expect(elements(byTestId(shown, 'projects-row')).filter(node => node.type === 'input').every(node => !node.props.checked)).toBe(true);
    store.choosePlace('none');
    expect(props(await sheet(store), 'capture-lock')).toMatchObject({ 'aria-pressed': true, 'aria-disabled': 'true' });
    await store.sendCompose();
    expect(sent('notes.submit')[0]).toMatchObject({ audience: { kind: 'only-me' }, project_ids: [] });
    expect(store.getState().toast).toBe('Saved for you');
  });

  it('pages the picker and accepts at most twenty projects, releasing a place when unticked', async () => {
    active = numbered(22);
    const store = await startStore();
    store.openCompose(); store.setComposeText('Quarterly numbers'); store.openProjects();
    expect(byTestId(await sheet(store), 'projects-find')).toHaveLength(1);
    expect(byTestId(await sheet(store), 'projects-more')).toHaveLength(1);
    (props(await sheet(store), 'projects-more').onClick as () => void)();
    await flush();
    await store.loadProjects(true);
    expect(store.getState().projects.items).toHaveLength(22);
    expect(byTestId(await sheet(store), 'projects-more')).toHaveLength(0);
    for (const entry of active) store.tickProject(entry);
    expect(store.getState().compose?.projects).toEqual(active.slice(0, 20));
    expect(text(byTestId(await sheet(store), 'projects-limit'))).toBe('Up to 20 projects.');
    const disabled = async () => elements(byTestId(await sheet(store), 'projects-row')).filter(node => node.type === 'input').map(node => node.props.disabled);
    expect((await disabled()).slice(19)).toEqual([false, true, true]);
    store.tickProject(active[0]!); store.tickProject(active[20]!);
    await store.sendCompose();
    expect(sent('notes.submit')[0]).toMatchObject({ audience: { kind: 'projects', project_ids: active.slice(1, 21).map(row => row.project_id).sort() }, project_ids: active.slice(1, 21).map(row => row.project_id).sort() });
  });
});

describe('files and unresolved captures', () => {
  it('a row drop starts in that project, and Start over keeps its projects and lock', async () => {
    const store = await startStore();
    store.openCapture(); store.closeCompose();
    await store.acceptDrop(file(), beacon);
    expect(store.getState().compose).toMatchObject({ projects: [beacon], place: 'projects', onlyMe: false, hidden: false, file: { handle: 'd1' } });
    store.openProjects();
    expect(byTestId(await sheet(store), 'projects-row').map(text)).toEqual(['Beacon', 'Apollo']);
    store.tickProject(apollo); store.closeProjects(); store.toggleOnlyMe(); store.removeFile(); store.setComposeText('Both teams need this');
    await unconfirmed(store);
    store.newCompose();
    expect(store.getState().compose?.confirmNew).toBe(true);
    store.newCompose();
    expect(store.getState().compose).toMatchObject({ text: '', status: 'editing', projects: [beacon, apollo], onlyMe: true });
    expect(text(byTestId(await sheet(store), 'capture-place'))).toBe('Beacon +1');
  });

  it('window drops use the page, while a sheet drop keeps its chosen audience', async () => {
    const store = await startStore();
    await store.acceptDrop(file(), 'window');
    expect(store.getState().compose?.place).toBe('none');
    store.closeCompose(); await store.openProject(beacon); await store.acceptDrop(file(), 'window');
    expect(store.getState().compose?.projects).toEqual([beacon]);
    store.toggleOnlyMe();
    await store.acceptDrop(file(), 'sheet');
    expect(store.getState().compose).toMatchObject({ projects: [beacon], onlyMe: true });
    await store.sendCompose();
    expect(sent('documents.upload')[0]).toMatchObject({ file_handle: 'd1', title: 'Brief.md', audience: { kind: 'only-me' }, project_ids: [beacon.project_id] });
    expect(store.getState().toast).toBe('Saved to Beacon · only you · Extracting text');
    await store.openOnlyMe(); await store.acceptDrop(file(), 'window');
    expect(store.getState().compose?.place).toBe('none');
  });

  it('a drop never changes written words or an unresolved save, and a text drop passes through', async () => {
    const store = await startStore();
    store.openCompose(); store.setComposeText('Half a thought');
    const event = { dataTransfer: { files: [] }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (props(await sheet(store), 'compose').onDrop as (event: unknown) => void)(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    store.closeCompose(); await store.acceptDrop(file(), beacon);
    expect(store.getState().compose).toMatchObject({ text: 'Half a thought', hidden: false, notice: 'The file was not attached. Save this note first.', place: 'none', file: null });
    await unconfirmed(store);
    await store.acceptDrop(file(), 'sheet');
    expect(store.getState().compose).toMatchObject({ text: 'Half a thought', notice: 'The file was not attached.', status: 'unknown' });
    expect(sent('documents.upload')).toHaveLength(0);
  });

  it('a note and a file are never sent together', async () => {
    const store = await startStore();
    store.openCompose(); store.setComposeText('Some words'); await store.attachFile();
    expect(store.getState().compose?.notice).toBe('Save this note before attaching a file.');
    expect(sent('dialog.openDocument')).toHaveLength(0);
    store.setComposeText(''); await store.attachFile();
    expect(text(byTestId(await sheet(store), 'compose-file'))).toContain('Pricing.txt · 15 bytes');
    expect(byTestId(await sheet(store), 'compose-body')).toHaveLength(0);
    expect(byTestId(await sheet(store), 'compose-attach')).toHaveLength(0);
    store.removeFile();
    expect(byTestId(await sheet(store), 'compose-body')).toHaveLength(1);
  });

  it('rejects a note over 8 KiB before sending, and accepts exactly 8 KiB', async () => {
    const store = await startStore();
    store.openCompose(); store.setComposeText(`Long note\n${'x'.repeat(8192)}`);
    await store.sendCompose();
    expect(store.getState().compose).toMatchObject({ notice: 'Up to 8 KiB of text.', status: 'editing' });
    expect(sent('notes.submit')).toHaveLength(0);
    expect(byTestId(await sheet(store), 'compose-error')).toHaveLength(0);
    store.setComposeText(`Long note\n${'x'.repeat(8182)}`);
    expect(store.getState().compose?.notice).toBeUndefined();
    await store.sendCompose();
    expect(Buffer.byteLength(sent('notes.submit')[0].text)).toBe(8192);
  });

  it.each(['team', 'locked'] as const)('an unconfirmed %s save locks its audience and says what may have happened', async kind => {
    const store = await startStore();
    store.openCompose(); store.setComposeText('Draft'); store.openProjects();
    if (kind === 'team') store.choosePlace('team');
    else { store.tickProject(apollo); store.tickProject(beacon); store.closeProjects(); store.toggleOnlyMe(); }
    await unconfirmed(store);
    const shown = await sheet(store);
    expect(text(byTestId(shown, 'compose-error'))).toBe(kind === 'team' ? 'This may not have been sent.' : 'This may not have been saved.');
    expect(props(shown, 'compose-body')).toMatchObject({ readOnly: true, value: 'Draft' });
    expect(props(shown, 'capture-place').disabled).toBe(true);
    if (kind === 'locked') expect(props(shown, 'capture-lock').disabled).toBe(true);
    expect(store.getState().toast).toBeNull();
    expect(told()).toEqual({ unresolved: true });
  });

  it('a retry refused for a known reason still leaves the original save unresolved', async () => {
    const store = await startStore();
    store.openCompose(); store.setComposeText('Draft'); await unconfirmed(store);
    const release = held.hold('notes.submit');
    const retry = store.sendCompose();
    release(fail('invalid_request', { mutation_outcome: 'not_submitted' })); await retry;
    expect(store.getState().compose?.status).toBe('unknown');
    expect(text(byTestId(await sheet(store), 'compose-error'))).toBe('This may not have been saved.');
    expect(sent('notes.submit')[0]).toEqual(sent('notes.submit')[1]);
  });

  it('tells the quit guard while a save is sending or unresolved, and clears it on success or abandonment', async () => {
    const store = await startStore();
    store.openCompose(); store.setComposeText('Draft');
    const release = held.hold('notes.submit'); const sending = store.sendCompose(); await flush();
    expect(told()).toEqual({ unresolved: true });
    release(ok({ request_id: sent('notes.submit')[0].request_id, audience: { kind: 'only-me' } })); await sending;
    expect(told()).toEqual({ unresolved: false });
    store.openCompose(); await store.attachFile();
    const uploaded = held.hold('documents.upload'); const uploading = store.sendCompose(); uploaded(unknown()); await uploading;
    expect(told()).toEqual({ unresolved: true, file: true });
    store.newCompose(); store.newCompose();
    expect(told()).toEqual({ unresolved: false });
  });

  it('a confirmed private save refreshes Only me; an organization save does not', async () => {
    const store = await startStore();
    await store.openOnlyMe();
    const before = sent('list.page').length;
    store.openCompose(); store.setComposeText('Second thoughts'); await store.sendCompose(); await flush();
    expect(store.getState().toast).toBe('Saved for you');
    expect(store.toastOpensOnlyMe(store.getState().toast!)).toBe(true);
    expect(sent('list.page')).toHaveLength(before + 1);
    store.openCompose(); store.setComposeText('Private project note'); store.openProjects(); store.tickProject(apollo); store.closeProjects(); store.toggleOnlyMe();
    await store.sendCompose(); await flush();
    expect(store.getState().toast).toBe('Saved to Apollo · only you');
    expect(store.toastOpensOnlyMe(store.getState().toast!)).toBe(false);
    expect(sent('list.page')).toHaveLength(before + 2);
    store.openCompose(); store.setComposeText('Everyone'); store.choosePlace('team'); await store.sendCompose(); await flush();
    expect(store.getState().toast).toBe('Shared with your organization');
    expect(sent('list.page')).toHaveLength(before + 2);
  });
});
