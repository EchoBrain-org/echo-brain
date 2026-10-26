// The host's side of Ask progress (ADR-0039): the command an Ask runs, and
// what of its printed lines reaches the page.
import { describe, expect, it, vi } from 'vitest';
import { askArgv, askProgressLines, askRecordArgv, askSourceArgv } from '../../src/host/ask.js';
import type { AskProgressNotice, Expect } from '../../src/shared/protocol.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const EXPECT: Expect = { authority: 'https://authority.example.test', membership_id: 'mem_00000000-0000-4000-8000-000000000001' };
const CANCEL = '00000000-0000-4000-8000-000000000001';
const decision = { citation: { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' },
  kind: 'decision', label: 'Tuesday sync', visibility: 'team', ref: `meeting:${sha('2')}` };
const line = (value: unknown) => JSON.stringify(value);

describe('the command an Ask runs', () => {
  it('asks every Ask, Mine included, on /v7 with its progress, as the account the page shows', () => {
    const project = 'prj_00000000-1111-4111-8111-111111111111';
    // The client refuses to ask as any other account, so no step of another reaches the page.
    const asked = ['ask', '--question=What did we agree?', '--progress', `--expected-membership-id=${EXPECT.membership_id}`, `--expected-authority=${EXPECT.authority}`];
    expect(askArgv('What did we agree?', { kind: 'global' }, EXPECT)).toEqual(asked);
    expect(askArgv('What did we agree?', { kind: 'project', project_id: project }, EXPECT)).toEqual([...asked, `--project=${project}`]);
    expect(askArgv('What did we agree?', { kind: 'mine' }, EXPECT)).toEqual([...asked, '--mine']);
  });

  it('reads what it cites: a meeting by its record, a passage where it was asked', () => {
    const project = 'prj_00000000-1111-4111-8111-111111111111';
    expect(askRecordArgv({ record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' })).toEqual(['records', `--record-sha256=${sha('2')}`]);
    const ref = { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha('6') };
    const passage = ['ask-source', `--source-id=${ref.source_id}`, '--revision-id=r1', `--source-sha256=${sha('4')}`, `--representation-sha256=${sha('5')}`, `--anchor-sha256=${sha('6')}`];
    expect(askSourceArgv(ref, { kind: 'global' })).toEqual(passage);
    expect(askSourceArgv(ref, { kind: 'mine' })).toEqual(passage);
    expect(askSourceArgv({ ...ref, document_id: `doc_${'a'.repeat(64)}` }, { kind: 'project', project_id: project }))
      .toEqual([...passage, `--document-id=doc_${'a'.repeat(64)}`, `--project=${project}`]);
  });
});

describe('the progress lines of an Ask', () => {
  it('post each valid step, tagged with its Ask and account, and nothing else the command printed', () => {
    const posted: AskProgressNotice[] = [];
    const refused = vi.fn();
    const read = askProgressLines(CANCEL, { ...EXPECT, display_name: 'Maya' } as Expect, new AbortController().signal, notice => posted.push(notice), refused);
    read(line({ ok: true, progress: { type: 'stage', stage: 'searching' } }));
    read(line({ ok: true, progress: { type: 'searched', sources: [{ kind: 'meetings' }], found: 3 } }));
    read('not json');
    read(line({ ok: true, progress: { type: 'stage', stage: 'reading', note: 'Mara owns THERM-48' } }));
    read(line({ ok: true, progress: { type: 'read', items: [decision] } }));
    // The answer line is the command's result, never a step.
    read(line({ ok: true, result: { schema_version: 8 } }));
    expect(refused).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { cancel_id: CANCEL, expect: EXPECT, step: { type: 'stage', stage: 'searching' } },
      { cancel_id: CANCEL, expect: EXPECT, step: { type: 'searched', sources: [{ kind: 'meetings' }], found: 3 } },
      { cancel_id: CANCEL, expect: EXPECT, step: { type: 'read', items: [
        { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' }, atom_id: sha('1') },
      ] } },
    ]);
  });

  it('post nothing once the Ask was cancelled or timed out', () => {
    const posted: AskProgressNotice[] = [];
    const abort = new AbortController();
    const read = askProgressLines(CANCEL, EXPECT, abort.signal, notice => posted.push(notice));
    read(line({ ok: true, progress: { type: 'stage', stage: 'searching' } }));
    abort.abort();
    read(line({ ok: true, progress: { type: 'stage', stage: 'writing' } }));
    expect(posted.map(notice => notice.step)).toEqual([{ type: 'stage', stage: 'searching' }]);
  });
});
