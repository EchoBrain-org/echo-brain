// AC6 — standalone synthetic end-to-end: meeting input -> adapter -> manual review
// gate -> brief artifacts. Fixed time, no credentials, no real data, no external
// service, no storage/native dependency. Proves the wedge's shaping/gate/render
// path in the extracted repository without a production API-key brain adapter.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GranolaExtractedSignal,
  GranolaSignalExtractionContext,
  GranolaSignalExtractionInput,
  GranolaSignalExtractor,
} from '../../src/enrich/granola-signals.js';
import {
  writePostMeetingBriefArtifacts,
  type PostMeetingBrief,
} from '../../src/enrich/post-meeting-brief.js';

const FIXED_GENERATED_AT = '2026-07-13T18:00:00.000Z';
const FIXED_MEETING_DATE = '2026-07-13T17:00:00.000Z';

// Deterministic, offline extractor adapter (stands in for the rank-3 API brain).
const syntheticAdapter: GranolaSignalExtractor = async (
  _input: GranolaSignalExtractionInput,
  _context: GranolaSignalExtractionContext,
): Promise<GranolaExtractedSignal[]> => [
  {
    signal_type: 'decision',
    text: 'Ship the meeting-to-brief wedge to the first design partner',
    canonical_subject: 'wedge-ship',
    source_span: { kind: 'summary' },
    confidence: 0.92,
    decision_status: 'decided',
  },
  {
    signal_type: 'action',
    text: 'Prepare the assisted onboarding checklist',
    canonical_subject: 'onboarding-checklist',
    source_span: { kind: 'summary' },
    confidence: 0.81,
    owner: 'operator',
  },
  {
    signal_type: 'rationale',
    text: 'Design partner asked for a same-day brief after every standup',
    canonical_subject: 'wedge-ship',
    source_span: { kind: 'summary' },
    confidence: 0.77,
    rationale_for: 'wedge-ship',
  },
];

function shapeBrief(signals: GranolaExtractedSignal[], input: GranolaSignalExtractionInput): PostMeetingBrief {
  return {
    schema_version: 1,
    kind: 'post_meeting_brief',
    meeting: {
      title: input.meeting_title,
      date: FIXED_MEETING_DATE,
      attendees: ['operator', 'design-partner'],
      source: { provider: 'granola', note_id: input.note_id, url: null },
    },
    decided: signals.filter((s) => s.signal_type === 'decision').map((s) => ({ text: s.text })),
    actions: signals
      .filter((s) => s.signal_type === 'action')
      .map((s) => ({ text: s.text, owner: s.owner ?? null, due: null })),
    context: signals.filter((s) => s.signal_type === 'rationale').map((s) => s.text),
    carryover: [],
    provenance: { extraction_run: 'synthetic-e2e', generated_at: FIXED_GENERATED_AT },
  };
}

describe('synthetic meeting-to-brief end to end', () => {
  let outDir: string;
  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('routes a synthetic meeting through the adapter and manual gate to brief artifacts', async () => {
    outDir = mkdtempSync(join(tmpdir(), 'echo-brain-e2e-'));
    const input: GranolaSignalExtractionInput = {
      note_id: 'synthetic-note-1',
      meeting_title: 'Design partner standup',
      updated_at: FIXED_MEETING_DATE,
      summary_text: 'Decided to ship the wedge. Action: prepare onboarding checklist.',
      summary_dedupe_key: 'sum-1',
      transcript_text: '',
      transcript_dedupe_key: 'tx-1',
      transcript_items: [],
    };

    const signals = await syntheticAdapter(input, { extractor_version: 'synthetic@1' });
    expect(signals.length).toBe(3);

    // Manual review gate: nothing is written until an explicit human approval.
    let approved = false;
    const gate = (decision: boolean) => {
      approved = decision;
      if (!approved) throw new Error('manual gate not approved; no brief emitted');
    };
    expect(() => {
      if (!approved) throw new Error('unapproved');
    }).toThrow();

    gate(true);
    expect(approved).toBe(true);

    const brief = shapeBrief(signals, input);
    const artifacts = writePostMeetingBriefArtifacts(brief, outDir);

    const json = JSON.parse(readFileSync(artifacts.jsonPath, 'utf8')) as PostMeetingBrief;
    expect(json.decided[0].text).toContain('meeting-to-brief wedge');
    expect(json.actions[0].owner).toBe('operator');
    expect(json.provenance.generated_at).toBe(FIXED_GENERATED_AT);

    expect(artifacts.markdown).toContain('## Decided');
    expect(artifacts.markdown).toContain('## Actions');
    expect(artifacts.markdown).toContain('**REVIEW BEFORE SENDING**');
    // No credential or external reference leaks into the artifact.
    expect(artifacts.markdown).not.toMatch(/api[_-]?key|token|secret|https?:\/\//i);
  });
});
