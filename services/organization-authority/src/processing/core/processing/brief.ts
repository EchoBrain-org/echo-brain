import type { DecisionSet } from '../contracts/decision.js';
import type { DecisionBrief } from '../contracts/delivery.js';
import type { MeetingDocument } from '../contracts/meeting.js';

export function compileDecisionBrief(
  id: string,
  meeting: MeetingDocument,
  decisions: DecisionSet,
): DecisionBrief {
  if (decisions.meeting_id !== meeting.id) {
    throw new Error('decision set meeting_id does not match the meeting document');
  }
  if (decisions.meeting_revision !== meeting.provenance.canonical_revision) {
    throw new Error('decision set revision does not match the meeting document');
  }
  return {
    schema_version: 1,
    id,
    meeting: {
      id: meeting.id,
      ...(meeting.title === undefined ? {} : { title: meeting.title }),
      ...(meeting.time === undefined ? {} : { time: meeting.time }),
      participants: meeting.participants,
    },
    decisions: decisions.signals.filter((signal) => signal.kind === 'decision'),
    actions: decisions.signals.filter((signal) => signal.kind === 'action'),
    rationales: decisions.signals.filter((signal) => signal.kind === 'rationale'),
    provenance: {
      meeting_revision: decisions.meeting_revision,
      processor: decisions.processor,
      generated_at: decisions.generated_at,
    },
  };
}
