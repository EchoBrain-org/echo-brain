/** The canonical synthetic-demo corpus and an oracle processor, shared by the evaluator and its Authority command tests. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  DecisionProcessorAdapter,
  DecisionSet,
  ExtractedSignal,
  MeetingDocument,
} from "@echo-brain/organization-processing/core";
import { loadSyntheticDemoMeetingCorpusV1 } from "../src/source/synthetic-demo-meeting-source-v1.js";

const meetingsDirectory = fileURLToPath(new URL("../../../demo/meetings", import.meta.url));
const expectationsPath = fileURLToPath(new URL("../../../demo/expectations.json", import.meta.url));
const identity = {
  kind: "decision-processor" as const,
  adapter_id: "synthetic-demo-pre-slack-test",
  instance_id: "synthetic-demo-pre-slack-test",
  version: "1.0.0",
};

interface ExpectedSignal {
  readonly evidence_block_ids: readonly string[];
  readonly plain_language_fact: string;
  readonly required_text_clauses?: readonly (readonly string[])[];
  readonly due_date?: string;
}

interface ExpectedMeeting {
  readonly meeting_id: string;
  readonly required_decisions: readonly ExpectedSignal[];
  readonly required_actions: readonly ExpectedSignal[];
  readonly required_rationales: readonly ExpectedSignal[];
}

interface Oracle {
  readonly meeting_expectations: readonly ExpectedMeeting[];
}

export async function fixture(): Promise<{ readonly meetings: readonly MeetingDocument[]; readonly oracle: Oracle }> {
  const [corpus, oracle] = await Promise.all([
    loadSyntheticDemoMeetingCorpusV1(meetingsDirectory),
    readFile(expectationsPath, "utf8").then((value) => JSON.parse(value) as Oracle),
  ]);
  return { meetings: corpus.meetings, oracle };
}

function signal(
  meeting: MeetingDocument,
  kind: ExtractedSignal["kind"],
  expected: ExpectedSignal,
  index: number,
): ExtractedSignal {
  const evidence = expected.evidence_block_ids.map((block_id) => ({ meeting_id: meeting.id, block_id }));
  const base = {
    id: `${meeting.id}:${kind}:${index}`,
    text: expected.plain_language_fact,
    subject: null,
    confidence: 1,
    evidence,
  };
  if (kind === "decision") {
    return {
      ...base,
      kind,
      status: "decided",
    };
  }
  if (kind === "action") {
    return {
      ...base,
      kind,
      owner: null,
      due_at: `${expected.due_date!}T12:00:00.000Z`,
    };
  }
  return { ...base, kind, supports_signal_ids: [] };
}

export function processor(
  oracle: Oracle,
  mutate?: (signals: ExtractedSignal[], meeting: MeetingDocument) => void,
): DecisionProcessorAdapter {
  return {
    identity,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: "healthy", checked_at: "2026-08-30T00:00:00.000Z" }),
    extract: async (meeting) => {
      const expected = oracle.meeting_expectations.find((item) => item.meeting_id === meeting.id)!;
      const signals = [
        ...expected.required_decisions.map((item, index) => signal(meeting, "decision", item, index)),
        ...expected.required_actions.map((item, index) => signal(meeting, "action", item, index)),
        ...expected.required_rationales.map((item, index) => signal(meeting, "rationale", item, index)),
      ];
      mutate?.(signals, meeting);
      return {
        schema_version: 1,
        meeting_id: meeting.id,
        meeting_revision: meeting.provenance.canonical_revision,
        processor: identity,
        generated_at: "2026-08-30T00:00:00.000Z",
        signals,
      } satisfies DecisionSet;
    },
  };
}
