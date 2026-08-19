import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  createStructuredTextDecisionProcessor,
} from '../../services/organization-authority/src/processing/adapters/decision-processors/structured-text/structured-text-decision-processor.js';
import type { MeetingBatch, MeetingDocument } from '../../services/organization-authority/src/processing/core/contracts/meeting.js';
import {
  assertCanonicalMeetingBatch,
} from '../../services/organization-authority/src/processing/core/contracts/validation.js';

const FIXED_NOW = '2026-08-18T12:00:00.000Z';
const corpusPath = new URL(
  '../product/fixtures/phase1-synthetic-replay-corpus.v1.json',
  import.meta.url,
);

type Outcome = 'accept' | 'edit' | 'reject';

interface CorpusEntry {
  batch: MeetingBatch;
  metadata: {
    fixture_id: string;
    meeting_type: 'decision-review' | 'project-planning' | 'customer-debrief';
    reviewer_capacity_eligible: false;
  };
  resolution: {
    outcome: Outcome;
    instructions:
      | { operation: 'accept' | 'reject' }
      | { operation: 'replace'; target: 'decision[0].text'; replacement: string };
  };
}

interface SyntheticCorpus {
  manifest: {
    corpus_kind: 'synthetic';
    created_at: string;
    band_b_exit_declared_at: string;
    disposal_due_at: string;
    content_classification: 'invented-synthetic-no-real-meeting-data';
    disposal_enforcement: 'operator-removal-required';
    reviewer_capacity_eligible: false;
  };
  batches: CorpusEntry[];
}

const rawCorpus = readFileSync(corpusPath, 'utf8');
const corpus = JSON.parse(rawCorpus) as SyntheticCorpus;
const EXPECTED_RAW_CORPUS_SHA256 =
  '49bd3f10ba7f1f7de98f2c3292868efa603ef6b2afacea1bfad29a0fda21e636';
const EXPECTED_FIXTURE_IDS = [
  ...Array.from({ length: 8 }, (_, index) =>
    `phase1-synthetic-dr-${String(index + 1).padStart(2, '0')}`,
  ),
  'phase1-synthetic-dr-09-r1',
  'phase1-synthetic-dr-09-r2',
  ...Array.from({ length: 10 }, (_, index) =>
    `phase1-synthetic-pp-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 10 }, (_, index) =>
    `phase1-synthetic-cd-${String(index + 1).padStart(2, '0')}`,
  ),
];
const processor = createStructuredTextDecisionProcessor(
  { adapter_id: 'structured-text', instance_id: 'synthetic', settings: {} },
  { now: () => FIXED_NOW },
);

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function labeledText(meeting: MeetingDocument): {
  decision: string;
  action: string;
  rationale: string;
} {
  const text = meeting.content.map((block) => block.text ?? '').join('\n');
  const read = (label: string) => {
    const prefix = `${label}: `;
    const line = text.split('\n').find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) throw new Error(`${meeting.id} lacks ${label}`);
    return line.slice(prefix.length);
  };
  return {
    decision: read('Decision'),
    action: read('Action'),
    rationale: read('Rationale'),
  };
}

describe('Phase 1 synthetic replay corpus', () => {
  it('contains only the declared, disposable synthetic corpus shape', () => {
    expect(corpus.manifest).toEqual({
      corpus_kind: 'synthetic',
      created_at: '2026-08-18T00:00:00.000Z',
      band_b_exit_declared_at: '2026-08-18T00:00:00.000Z',
      disposal_due_at: '2026-08-25T00:00:00.000Z',
      content_classification: 'invented-synthetic-no-real-meeting-data',
      disposal_enforcement: 'operator-removal-required',
      reviewer_capacity_eligible: false,
    });
    expect(new Date(corpus.manifest.disposal_due_at).getTime()).toBe(
      new Date(corpus.manifest.band_b_exit_declared_at).getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(corpus.batches).toHaveLength(30);
    expect(createHash('sha256').update(rawCorpus).digest('hex')).toBe(
      EXPECTED_RAW_CORPUS_SHA256,
    );
    expect(rawCorpus).not.toMatch(/@[a-z0-9.-]+\.(?!example\.test|test)/i);

    const ids = new Set<string>();
    const observations = new Set<string>();
    const typeCounts = new Map<string, number>();
    const outcomeCounts = new Map<Outcome, number>();
    const familyOutcomeCounts = new Map<string, Map<Outcome, number>>();
    for (const entry of corpus.batches) {
      expect(Object.keys(entry.batch)).toEqual(['meetings']);
      expect(entry.batch.meetings).toHaveLength(1);
      assertCanonicalMeetingBatch(entry.batch);
      const [meeting] = entry.batch.meetings;
      expect(meeting).toBeDefined();
      expect(meeting!.context?.meeting_type).toBe(entry.metadata.meeting_type);
      expect(entry.metadata.reviewer_capacity_eligible).toBe(false);
      expect(meeting!.provenance.external_id).toMatch(/\.example\.test$/);
      expect(ids.has(meeting!.id)).toBe(false);
      ids.add(meeting!.id);
      const observation = JSON.stringify([
        meeting!.provenance.source.adapter_id,
        meeting!.provenance.source.instance_id,
        meeting!.provenance.external_id,
        meeting!.provenance.canonical_revision,
      ]);
      expect(observations.has(observation)).toBe(false);
      observations.add(observation);
      typeCounts.set(entry.metadata.meeting_type, (typeCounts.get(entry.metadata.meeting_type) ?? 0) + 1);
      outcomeCounts.set(entry.resolution.outcome, (outcomeCounts.get(entry.resolution.outcome) ?? 0) + 1);
      const family = familyOutcomeCounts.get(entry.metadata.meeting_type) ?? new Map<Outcome, number>();
      family.set(entry.resolution.outcome, (family.get(entry.resolution.outcome) ?? 0) + 1);
      familyOutcomeCounts.set(entry.metadata.meeting_type, family);
    }
    expect(corpus.batches.map((entry) => entry.metadata.fixture_id)).toEqual(
      EXPECTED_FIXTURE_IDS,
    );
    expect(Object.fromEntries(typeCounts)).toEqual({
      'decision-review': 10,
      'project-planning': 10,
      'customer-debrief': 10,
    });
    expect(Object.fromEntries(outcomeCounts)).toEqual({ accept: 18, edit: 6, reject: 6 });
    expect(
      Object.fromEntries(
        [...familyOutcomeCounts].map(([family, counts]) => [
          family,
          Object.fromEntries(counts),
        ]),
      ),
    ).toEqual({
      'decision-review': { accept: 6, edit: 2, reject: 2 },
      'project-planning': { accept: 6, edit: 2, reject: 2 },
      'customer-debrief': { accept: 6, edit: 2, reject: 2 },
    });

    const revisions = corpus.batches
      .map(({ batch }) => batch.meetings[0]!)
      .filter((meeting) => meeting.provenance.external_id === 'synthetic-dr-09.example.test');
    expect(revisions.map((meeting) => meeting.provenance.canonical_revision)).toEqual(['r1', 'r2']);
    expect(revisions[1]!.provenance.previous_revision).toBe(revisions[0]!.provenance.canonical_revision);
    expect(revisions[1]!.content).not.toEqual(revisions[0]!.content);
  });

  it('extracts one exact labeled signal of each kind with stable frozen-clock digests', async () => {
    const decisionSetDigests = new Set<string>();
    const report: Array<{ fixture_id: string; decision_set: unknown }> = [];
    for (const entry of corpus.batches) {
      const meeting = entry.batch.meetings[0]!;
      const context = {
        processor_version: processor.identity.version,
        input_fingerprint: `phase1-synthetic:${meeting.id}:${meeting.provenance.canonical_revision}`,
      };
      const first = await processor.extract(meeting, context);
      const second = await processor.extract(meeting, context);
      expect(digest(first)).toBe(digest(second));
      decisionSetDigests.add(digest(first));
      report.push({ fixture_id: entry.metadata.fixture_id, decision_set: first });
      expect(first.generated_at).toBe(FIXED_NOW);
      expect(first.meeting_id).toBe(meeting.id);
      expect(first.meeting_revision).toBe(meeting.provenance.canonical_revision);

      const decisions = first.signals.filter((signal) => signal.kind === 'decision');
      const actions = first.signals.filter((signal) => signal.kind === 'action');
      const rationales = first.signals.filter((signal) => signal.kind === 'rationale');
      expect(decisions).toHaveLength(1);
      expect(actions).toHaveLength(1);
      expect(rationales).toHaveLength(1);
      const expected = labeledText(meeting);
      expect(decisions[0]).toMatchObject({
        text: expected.decision,
        evidence: [{ meeting_id: meeting.id, block_id: 'notes-1', quote: `Decision: ${expected.decision}` }],
      });
      expect(actions[0]).toMatchObject({
        text: expected.action,
        evidence: [{ meeting_id: meeting.id, block_id: 'notes-1', quote: `Action: ${expected.action}` }],
      });
      expect(rationales[0]).toMatchObject({
        text: expected.rationale,
        evidence: [{ meeting_id: meeting.id, block_id: 'notes-1', quote: `Rationale: ${expected.rationale}` }],
      });

      if (entry.resolution.outcome === 'edit') {
        if (entry.resolution.instructions.operation !== 'replace') {
          throw new Error('synthetic edit has no replacement instruction');
        }
        expect(entry.resolution.instructions).toMatchObject({
          operation: 'replace',
          target: 'decision[0].text',
        });
        expect(entry.resolution.instructions.replacement).not.toBe(
          expected.decision,
        );
      } else {
        expect(entry.resolution.instructions).toEqual({ operation: entry.resolution.outcome });
      }
    }
    expect(decisionSetDigests.size).toBe(30);
    expect(digest(report)).toBe(
      'e3fbb624e1592e028dcdfdf933488c7198d920de4841286185bff7cc60d2ba08',
    );
  });
});
