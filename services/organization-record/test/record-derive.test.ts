import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OrganizationRecordDerivedStore,
  OrganizationRecordFollower,
  OrganizationRecordIngest,
  OrganizationRecordLogReader,
  type JsonObject,
  type OrganizationRecordAlert,
} from '../src/index.js';
import type { OrganizationRecordLogReaderPort } from '../src/application/ports.js';
import {
  derivedApprovalGroupId,
  derivedAtomId,
  derivedMeetingSnapshotId,
} from '../src/derive/identity.js';
import { projectOrganizationRecord } from '../src/derive/projection.js';
import {
  acceptingVerifier,
  approvalEnvelope,
  fixedClock,
  INSTALLATION_ALPHA,
  openStores,
  ORGANIZATION_ID,
  recordingSigner,
  rejectionEnvelope,
  removeTemporaryDirectories,
  temporaryStateDirectory,
} from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

/**
 * Microtask depth that lands a callback inside the follower's settle window:
 * after runLoop has read `pending` for the last time and returned, and before
 * the promise finalizer that clears `running`.
 */
const SETTLE_WINDOW_HOPS = 2;

function afterMicrotasks(hops: number, action: () => void): void {
  let chain = Promise.resolve();
  for (let hop = 0; hop < hops; hop += 1) chain = chain.then(() => undefined);
  void chain.then(action);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface DeriveContext {
  readonly stores: ReturnType<typeof openStores>;
  readonly ingest: OrganizationRecordIngest;
  readonly follower: OrganizationRecordFollower;
  readonly reader: OrganizationRecordLogReader;
  readonly alerts: OrganizationRecordAlert[];
}

/**
 * A context whose appends fire no nudge, so a test can decide exactly when the
 * follower runs. This is also the shape a crashed process leaves behind: rows
 * in the log, nothing derived.
 */
function quietContext(): DeriveContext {
  const stores = openStores();
  const alerts: OrganizationRecordAlert[] = [];
  const reader = new OrganizationRecordLogReader(stores.log.database);
  return {
    stores,
    reader,
    alerts,
    follower: new OrganizationRecordFollower({
      logReader: reader,
      derived: stores.derived,
      alert: (alert) => alerts.push(alert),
    }),
    ingest: new OrganizationRecordIngest({
      log: stores.log,
      authority: acceptingVerifier(),
      receiptSigner: recordingSigner(),
      clock: fixedClock(500),
    }),
  };
}

function deriveContext(): DeriveContext {
  const stores = openStores();
  const alerts: OrganizationRecordAlert[] = [];
  const reader = new OrganizationRecordLogReader(stores.log.database);
  const follower = new OrganizationRecordFollower({
    logReader: reader,
    derived: stores.derived,
    alert: (alert) => alerts.push(alert),
  });
  return {
    stores,
    reader,
    follower,
    alerts,
    ingest: new OrganizationRecordIngest({
      log: stores.log,
      authority: acceptingVerifier(),
      receiptSigner: recordingSigner(),
      clock: fixedClock(500),
      onAppended: () => follower.nudge(),
      alert: (alert) => alerts.push(alert),
    }),
  };
}

describe('organization record derive projections', () => {
  it('derives approval-scoped atoms, snapshot, and participants', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    await context.follower.drain();

    const row = context.stores.log.rows()[0]!;
    const atoms = context.stores.derived.atoms();
    expect(atoms.map((atom) => atom.signal_id).sort()).toEqual(['s1', 's2', 's3']);
    expect(atoms.map((atom) => atom.kind).sort()).toEqual([
      'action',
      'decision',
      'rationale',
    ]);

    const decision = atoms.find((atom) => atom.signal_id === 's1')!;
    expect(decision).toMatchObject({
      atom_id: derivedAtomId(row.record_hash, 's1'),
      approval_group: derivedApprovalGroupId(INSTALLATION_ALPHA, row.idempotency_key),
      kind: 'decision',
      status: 'decided',
      subject: 'roadmap',
      confidence: 0.9,
      restricted: 1,
      reviewer_principal_id: 'prn_zhen',
      reviewer_display_name: 'Zhen',
      reviewed_at: '2026-08-06T16:30:00.000Z',
      log_position: 1,
    });
    // The verified principal is the identity of record; the display name is
    // carried but never load-bearing.
    expect(decision.owner).toBeNull();
    expect(decision.due_at).toBeNull();

    const action = atoms.find((atom) => atom.signal_id === 's2')!;
    expect(action).toMatchObject({ owner: 'p2', due_at: '2026-08-14T00:00:00.000Z' });
    expect(action.status).toBeNull();

    const snapshots = context.stores.derived.meetingSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      snapshot_id: derivedMeetingSnapshotId(row.record_hash, 'mtg_roadmap', 'rev-1'),
      meeting_id: 'mtg_roadmap',
      meeting_revision: 'rev-1',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      source_external_id: 'granola-meeting-1',
      title: 'Roadmap review',
    });

    const observations = context.stores.derived.participantObservations();
    expect(observations.map((observation) => observation.participant_id).sort()).toEqual([
      'p1',
      'p2',
    ]);
    // Observations stay observations: no principal id anywhere on the row.
    expect(Object.keys(observations[0]!)).not.toContain('principal_id');
  });

  it('derives the five v1 edge types and no others', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    await context.follower.drain();

    const row = context.stores.log.rows()[0]!;
    const snapshotId = derivedMeetingSnapshotId(row.record_hash, 'mtg_roadmap', 'rev-1');
    const edges = context.stores.derived.edges();
    const byType = new Map<string, number>();
    for (const edge of edges) byType.set(edge.edge_type, (byType.get(edge.edge_type) ?? 0) + 1);

    expect([...byType.keys()].sort()).toEqual([
      'attended-by',
      'derived-from',
      'from-meeting',
      'listed-participant',
      'supports',
    ]);
    expect(byType.get('derived-from')).toBe(3);
    expect(byType.get('from-meeting')).toBe(3);
    expect(byType.get('listed-participant')).toBe(2);
    // Only an explicit approved 'attended' fact makes an attendance edge; the
    // no_show participant is listed and nothing more.
    expect(byType.get('attended-by')).toBe(1);

    const supports = edges.filter((edge) => edge.edge_type === 'supports');
    expect(supports).toEqual([
      {
        edge_type: 'supports',
        from_id: derivedAtomId(row.record_hash, 's3'),
        to_id: derivedAtomId(row.record_hash, 's1'),
        log_position: 1,
      },
    ]);
    expect(
      edges.every(
        (edge) => edge.edge_type !== 'derived-from' || edge.to_id === row.record_hash,
      ),
    ).toBe(true);
    expect(
      edges
        .filter((edge) => edge.edge_type === 'attended-by')
        .every((edge) => edge.from_id === snapshotId),
    ).toBe(true);
  });

  it('keeps meeting snapshots approval-scoped instead of merging them', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(
      approvalEnvelope({
        envelope_id: 'ore_approval_2',
        idempotency_key: 'e'.repeat(64),
        meeting_revision: 'rev-2',
        participants: [
          {
            id: 'p1',
            display_name: 'Zhen',
            identities: [{ kind: 'email', value: 'zhen@example.test' }],
            roles: ['organizer'],
            response_status: 'accepted',
            attendance: 'attended',
          },
        ],
      }),
    );
    await context.follower.drain();

    const snapshots = context.stores.derived.meetingSnapshots();
    // Same meeting, two approvals, two snapshots. V1 deliberately does not
    // merge, so a restricted atom resolves against the exact facts approved
    // with it.
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((snapshot) => snapshot.meeting_id === 'mtg_roadmap')).toBe(true);
    expect(new Set(snapshots.map((snapshot) => snapshot.log_position))).toEqual(
      new Set([1, 2]),
    );

    const observations = context.stores.derived.participantObservations();
    expect(observations).toHaveLength(3);
    const bySnapshot = new Map<string, number>();
    for (const observation of observations) {
      bySnapshot.set(
        observation.snapshot_id,
        (bySnapshot.get(observation.snapshot_id) ?? 0) + 1,
      );
    }
    expect([...bySnapshot.values()].sort()).toEqual([1, 2]);
  });

  it('derives a rejection as an act with no candidate content', async () => {
    const context = deriveContext();
    await context.ingest.append(rejectionEnvelope());
    await context.follower.drain();

    const rejections = context.stores.derived.rejections();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      meeting_id: 'mtg_pricing',
      reviewer_principal_id: 'prn_zhen',
      rejected_at: '2026-08-06T17:00:00.000Z',
      reason: 'Not a shared decision yet',
      reconsider_after: '2026-09-01T00:00:00.000Z',
      log_position: 1,
    });
    expect(context.stores.derived.atoms()).toEqual([]);
    expect(context.stores.derived.meetingSnapshots()).toEqual([]);
    expect(context.stores.derived.edges().map((edge) => edge.edge_type)).toEqual([
      'derived-from',
    ]);
  });

  it('carries a non-restricted intent through to the atoms', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope({ restricted: false }));
    await context.follower.drain();
    expect(context.stores.derived.atoms().every((atom) => atom.restricted === 0)).toBe(true);
  });
});

describe('organization record derive determinism', () => {
  it('reproduces the canonical content digest on a full rebuild', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());
    await context.ingest.append(
      approvalEnvelope({
        envelope_id: 'ore_approval_3',
        idempotency_key: 'f'.repeat(64),
        meeting_id: 'mtg_pricing',
        meeting_revision: 'rev-9',
      }),
    );
    await context.follower.drain();
    const incremental = context.stores.derived.contentDigest();

    // A rebuild is a fresh derived store, cursor at zero, replayed from the
    // log. Not file-byte identity: SQLite page layout varies across versions.
    const rebuiltPath = join(temporaryStateDirectory(), 'rebuilt.sqlite');
    const rebuilt = OrganizationRecordDerivedStore.open(rebuiltPath, {
      organization_id: ORGANIZATION_ID,
      clock: fixedClock(900),
    });
    const rebuiltFollower = new OrganizationRecordFollower({
      logReader: context.reader,
      derived: rebuilt,
      batchSize: 1,
    });
    expect(rebuilt.cursorPosition()).toBe(0);
    await rebuiltFollower.drain();

    expect(rebuilt.cursorPosition()).toBe(3);
    expect(rebuilt.contentDigest()).toBe(incremental);
    rebuilt.close();
  });

  it('is a pure function of log content', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    const row = context.stores.log.rows()[0]!;
    expect(projectOrganizationRecord(row)).toEqual(projectOrganizationRecord(row));
  });
});

describe('organization record derive atomicity and catch-up', () => {
  it('commits every row, edge, and the cursor together or not at all', async () => {
    const context = quietContext();
    await context.ingest.append(approvalEnvelope());

    // Plant one of the record's own atom rows so the per-record transaction
    // fails partway, exactly as a crash mid-write would leave it.
    const row = context.stores.log.rows()[0]!;
    const projection = projectOrganizationRecord(row);
    const planted = projection.atoms[1]!;
    context.stores.derived.database
      .prepare(
        `INSERT INTO organization_derived_atom (
           atom_id, log_position, record_hash, approval_group, signal_id, kind, text,
           subject, status, owner, due_at, confidence, evidence, restricted,
           reviewer_principal_id, reviewer_display_name, reviewed_at
         ) VALUES (@atom_id, @log_position, @record_hash, @approval_group, @signal_id, @kind,
           @text, @subject, @status, @owner, @due_at, @confidence, @evidence, @restricted,
           @reviewer_principal_id, @reviewer_display_name, @reviewed_at)`,
      )
      .run(planted);

    await context.follower.drain();

    expect(context.follower.halted).toBe(true);
    expect(context.stores.derived.cursorPosition()).toBe(0);
    expect(context.stores.derived.atoms()).toHaveLength(1);
    expect(context.stores.derived.meetingSnapshots()).toEqual([]);
    expect(context.stores.derived.participantObservations()).toEqual([]);
    expect(context.stores.derived.edges()).toEqual([]);
    expect(context.alerts.map((alert) => alert.kind)).toContain('derive-halted');
  });

  it('heals a crash between append and derive with the startup catch-up', async () => {
    const stores = openStores();
    // No follower is wired while these append: the nudge is simply lost.
    const ingest = new OrganizationRecordIngest({
      log: stores.log,
      authority: acceptingVerifier(),
      receiptSigner: recordingSigner(),
      clock: fixedClock(500),
    });
    await ingest.append(approvalEnvelope());
    await ingest.append(rejectionEnvelope());
    expect(stores.derived.cursorPosition()).toBe(0);

    const follower = new OrganizationRecordFollower({
      logReader: new OrganizationRecordLogReader(stores.log.database),
      derived: stores.derived,
    });
    const progress = await follower.drain();
    expect(progress).toEqual({ cursor_position: 2, records_derived: 2, halted: false });
    expect(stores.derived.atoms()).toHaveLength(3);
    expect(stores.derived.rejections()).toHaveLength(1);
  });

  it('derives a concurrent submission burst completely', async () => {
    const context = deriveContext();
    await Promise.all([
      context.ingest.append(approvalEnvelope()),
      context.ingest.append(rejectionEnvelope()),
      context.ingest.append(
        approvalEnvelope({
          envelope_id: 'ore_approval_3',
          idempotency_key: 'f'.repeat(64),
        }) as JsonObject,
      ),
    ]);
    await context.follower.drain();

    expect(context.stores.derived.cursorPosition()).toBe(3);
    expect(context.stores.log.rows()).toHaveLength(3);
  });

  it('halts with an operator alert on an unprocessable record instead of skipping', async () => {
    const context = deriveContext();
    await context.ingest.append(approvalEnvelope());
    // Ingest-time payload validation should make this impossible; the point is
    // what happens if it ever is not.
    const unprocessable = {
      ...(approvalEnvelope({
        envelope_id: 'ore_broken',
        idempotency_key: 'h'.repeat(64),
      }) as JsonObject),
      payload: { schema_version: 1 },
    };
    await context.ingest.append(unprocessable);
    await context.follower.drain();

    expect(context.stores.derived.cursorPosition()).toBe(1);
    expect(context.follower.halted).toBe(true);
    const halt = context.alerts.find((alert) => alert.kind === 'derive-halted')!;
    expect(halt.log_position).toBe(2);
    expect(halt.message).toMatch(/cannot be derived/);

    // Staleness stays visible and truth is untouched. A later catch-up must
    // not come back looking healthy.
    expect(context.stores.log.rows()).toHaveLength(2);
    const progress = await context.follower.drain();
    expect(progress).toEqual({ cursor_position: 1, records_derived: 1, halted: true });
  });

  it('restarts when a nudge lands in the settle window after the loop goes quiet', async () => {
    const context = quietContext();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());

    const reader = new OrganizationRecordLogReader(context.stores.log.database);
    let visibleHead = 1;
    let armed = true;
    let drainingAtNudge: boolean | null = null;

    // Record 2 stays invisible until the race is armed, so the loop genuinely
    // runs out of work and unwinds before the nudge arrives.
    const racingReader: OrganizationRecordLogReaderPort = {
      readAfter: (position, limit) => {
        const batch = reader
          .readAfter(position, limit)
          .filter((row) => row.position <= visibleHead);
        if (batch.length === 0 && armed) {
          armed = false;
          // Land the nudge a few microtasks from here: runLoop has read
          // `pending` for the last time and returned, but the finalizer that
          // clears `running` has not run yet. Without the finalizer restart
          // this wake is lost and the cursor never reaches 2.
          afterMicrotasks(SETTLE_WINDOW_HOPS, () => {
            visibleHead = 2;
            drainingAtNudge = follower.draining;
            follower.nudge();
          });
        }
        return batch;
      },
    };

    const follower = new OrganizationRecordFollower({
      logReader: racingReader,
      derived: context.stores.derived,
      alert: (alert) => context.alerts.push(alert),
    });

    follower.nudge();
    // Deliberately no drain() and no second nudge: only the in-window nudge
    // and the follower's own restart can move the cursor.
    await waitFor(
      () => context.stores.derived.cursorPosition() === 2,
      'the settle-window nudge to derive record 2',
    );

    expect(drainingAtNudge).toBe(true);
    expect(follower.halted).toBe(false);
    expect(context.stores.derived.rejections()).toHaveLength(1);
  });

  it('rolls the record back when a participant observation conflicts', async () => {
    const context = quietContext();
    await context.ingest.append(approvalEnvelope());
    const row = context.stores.log.rows()[0]!;
    const projection = projectOrganizationRecord(row);

    // An unrelated snapshot carries the planted observation, so the record's
    // own snapshot insert still succeeds and the conflict is the observation.
    const decoySnapshotId = derivedMeetingSnapshotId(row.record_hash, 'mtg_decoy', 'rev-0');
    context.stores.derived.database
      .prepare(
        `INSERT INTO organization_derived_meeting_snapshot (
           snapshot_id, log_position, record_hash, meeting_id, meeting_revision,
           source_adapter_id, source_instance_id, source_external_id, title, meeting_time
         ) VALUES (?, 1, ?, 'mtg_decoy', 'rev-0', 'granola', 'primary', 'decoy', NULL, NULL)`,
      )
      .run(decoySnapshotId, row.record_hash);
    context.stores.derived.database
      .prepare(
        `INSERT INTO organization_derived_participant_observation (
           observation_id, snapshot_id, participant_id, display_name, identities,
           roles, response_status, attendance
         ) VALUES (?, ?, 'p2', NULL, '[]', '[]', NULL, NULL)`,
      )
      .run(projection.participant_observations[1]!.observation_id, decoySnapshotId);

    await context.follower.drain();

    expect(context.follower.halted).toBe(true);
    expect(context.stores.derived.cursorPosition()).toBe(0);
    expect(context.stores.derived.atoms()).toEqual([]);
    expect(context.stores.derived.edges()).toEqual([]);
    // Only the planted rows survive: the record committed nothing at all.
    expect(context.stores.derived.participantObservations()).toHaveLength(1);
    expect(context.stores.derived.meetingSnapshots()).toHaveLength(1);
    expect(context.alerts.map((alert) => alert.kind)).toContain('derive-halted');
  });

  it('rolls the record back when an edge conflicts', async () => {
    const context = quietContext();
    await context.ingest.append(approvalEnvelope());
    const projection = projectOrganizationRecord(context.stores.log.rows()[0]!);
    const planted = projection.edges[0]!;
    context.stores.derived.database
      .prepare(
        `INSERT INTO organization_derived_edge (edge_type, from_id, to_id, log_position)
         VALUES (@edge_type, @from_id, @to_id, @log_position)`,
      )
      .run(planted);

    await context.follower.drain();

    expect(context.follower.halted).toBe(true);
    expect(context.stores.derived.cursorPosition()).toBe(0);
    // Edges insert last, so everything the record wrote before the conflict
    // must roll back with it.
    expect(context.stores.derived.atoms()).toEqual([]);
    expect(context.stores.derived.meetingSnapshots()).toEqual([]);
    expect(context.stores.derived.participantObservations()).toEqual([]);
    expect(context.stores.derived.edges()).toHaveLength(1);
    expect(context.alerts.map((alert) => alert.kind)).toContain('derive-halted');
  });

  it('deduplicates a repeated supports link in the projector', async () => {
    const context = quietContext();
    await context.ingest.append(
      approvalEnvelope({ supports_signal_ids: ['s1', 's1', 's2', 's1'] }),
    );
    const row = context.stores.log.rows()[0]!;
    const projection = projectOrganizationRecord(row);

    // Naming the same sibling twice is valid log content, so it resolves in
    // the pure projector rather than at a lenient insert.
    expect(
      projection.edges.filter((edge) => edge.edge_type === 'supports'),
    ).toEqual([
      {
        edge_type: 'supports',
        from_id: derivedAtomId(row.record_hash, 's3'),
        to_id: derivedAtomId(row.record_hash, 's1'),
        log_position: 1,
      },
      {
        edge_type: 'supports',
        from_id: derivedAtomId(row.record_hash, 's3'),
        to_id: derivedAtomId(row.record_hash, 's2'),
        log_position: 1,
      },
    ]);

    await context.follower.drain();
    expect(context.follower.halted).toBe(false);
    expect(context.stores.derived.cursorPosition()).toBe(1);
    expect(
      context.stores.derived.edges().filter((edge) => edge.edge_type === 'supports'),
    ).toHaveLength(2);
  });

  it('refuses to derive a record out of order', async () => {
    const context = quietContext();
    await context.ingest.append(approvalEnvelope());
    await context.ingest.append(rejectionEnvelope());
    const secondRow = context.stores.log.rows()[1]!;
    expect(() =>
      context.stores.derived.commitRecord(projectOrganizationRecord(secondRow)),
    ).toThrow(/cannot commit position 2/);
    expect(context.stores.derived.cursorPosition()).toBe(0);
  });
});
