import type { AdapterIdentity } from "./adapter.js";
import type { ActionSignal, DecisionSignal, RationaleSignal } from "./decision.js";
import type { MeetingParticipant, MeetingTime } from "./meeting.js";

export interface DecisionBrief {
  schema_version: 1;
  id: string;
  meeting: {
    id: string;
    title?: string;
    time?: MeetingTime;
    participants: readonly MeetingParticipant[];
  };
  decisions: readonly DecisionSignal[];
  actions: readonly ActionSignal[];
  rationales: readonly RationaleSignal[];
  provenance: {
    meeting_revision: string;
    processor: AdapterIdentity & { kind: 'decision-processor' };
    generated_at: string;
  };
}
