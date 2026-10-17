import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStagingSyntheticPersonalMeetingProviderV1, StagingSyntheticMeetingStoreV1, writeStagingSyntheticCheckpointV1 } from '../src/staging-synthetic-personal-meeting-provider-v1.js';

const person = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test' };
const input = { id: 'synthetic-custom-dvt', title: 'DVT exception review', notes: 'Decision: waive the gate.', transcript: '' };
describe('custom synthetic meeting custody', () => {
  it('survives reopening, stays private to the source, and preserves notes versus transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-synthetic-custom-'));
    let db = new Database(join(dir, 'meetings.sqlite'));
    try {
      let provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(db) });
      const session = await provider.open(person, () => undefined);
      session.submit!(input);
      session.submit!(input);
      expect(() => session.submit!({ ...input, notes: 'A different decision.' })).toThrow('different content');
      const first = new StagingSyntheticMeetingStoreV1(db).get(session.identity.instance_id, input.id)!;
      expect(first.title).toBe('SYNTHETIC STAGING - DVT exception review');
      expect(first.content.map(b => b.kind)).toEqual(['note']);
      expect(first.capture.components).not.toContainEqual({ kind: 'transcript', state: 'available' });
      db.close(); db = new Database(join(dir, 'meetings.sqlite'));
      provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: new StagingSyntheticMeetingStoreV1(db) });
      const reopened = await provider.open(person, () => undefined);
      reopened.submit!(input);
      const source = provider.source({ source_adapter_id: reopened.identity.adapter_id, source_adapter_version: reopened.identity.version,
        source_adapter_instance_id: reopened.identity.instance_id }, () => undefined);
      const batch = await source.pull({ limit: 1, cursor: writeStagingSyntheticCheckpointV1({ folder: null, baseline: false, revisions: {}, manual: [input.id] }) });
      expect(batch.meetings).toEqual([first]);
      const other = await provider.open({ ...person, membership_id: 'mem_other' }, () => undefined);
      await expect(other.preview(input.id)).rejects.toMatchObject({ code: 'not_found' });
      reopened.submit!({ ...input, id: 'synthetic-custom-transcript', notes: '', transcript: 'Synthetic speaker: approve the waiver.' });
      expect(new StagingSyntheticMeetingStoreV1(db).get(reopened.identity.instance_id, 'synthetic-custom-transcript')!.content.map(b => b.kind)).toEqual(['transcript']);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves explicit event time through source pull without inventing it from receipt time', async () => {
    const db = new Database(':memory:');
    try {
      const store = new StagingSyntheticMeetingStoreV1(db);
      const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: store });
      const session = await provider.open(person, () => undefined);
      const timed = { ...input, started_at: '2026-10-17T00:00:00.000Z', ended_at: '2026-10-17T00:30:00.000Z', time_zone: 'America/Los_Angeles' };
      session.submit!(timed);
      const source = provider.source({ source_adapter_id: session.identity.adapter_id, source_adapter_version: session.identity.version, source_adapter_instance_id: session.identity.instance_id }, () => undefined);
      const batch = await source.pull({ limit: 1, cursor: writeStagingSyntheticCheckpointV1({ folder: null, baseline: false, revisions: {}, manual: [input.id] }) });
      expect(batch.meetings[0]?.time).toEqual({ actual_start_at: timed.started_at, actual_end_at: timed.ended_at, timezone: timed.time_zone });
      expect(() => session.submit!({ ...timed, started_at: '2026-10-16T00:00:00.000Z' })).toThrow('different content');
      session.submit!({ ...input, id: 'synthetic-custom-undated' });
      expect(store.get(session.identity.instance_id, 'synthetic-custom-undated')?.time).toBeUndefined();
      for (const invalid of [{ started_at: 'yesterday' }, { ended_at: timed.ended_at }, { started_at: timed.started_at, ended_at: '2026-10-15T00:00:00.000Z' }, { started_at: timed.started_at, time_zone: 'No/SuchZone' }]) {
        expect(() => session.submit!({ ...input, id: 'synthetic-custom-invalid', ...invalid })).toThrow();
      }
    } finally { db.close(); }
  });

  it('bounds storage while allowing a retry at the limit, and rechecks access before storing', async () => {
    const db = new Database(':memory:');
    try {
      let active = true;
      const store = new StagingSyntheticMeetingStoreV1(db);
      const provider = createStagingSyntheticPersonalMeetingProviderV1({ custom_store: store });
      const session = await provider.open(person, () => { if (!active) throw new Error('revoked'); });
      for (let i = 0; i < 100; i++) session.submit!({ ...input, id: `synthetic-custom-${i}` });
      session.submit!({ ...input, id: 'synthetic-custom-0' });
      expect(() => session.submit!(input)).toThrow('storage limit');
      active = false;
      expect(() => session.submit!(input)).toThrow('revoked');
      expect(store.get(session.identity.instance_id, input.id)).toBeUndefined();
    } finally { db.close(); }
  });
});
