import { describe, expect, it } from "vitest";
import type { ActionSignal } from "../../src/core/contracts/decision.js";
import type { DecisionBrief } from "../../src/core/contracts/delivery.js";
import {
  OWNER_PROPOSALS_MAX_V1,
  ownerProposalsV1,
  withoutProposedOwnersV1,
} from "../../src/core/processing/owner-proposals-v1.js";

function action(index: number, owner: string | null, text = `Send the launch plan ${index + 1}`): ActionSignal {
  return {
    id: `action-${index}`,
    kind: "action",
    text,
    subject: null,
    confidence: null,
    owner,
    due_at: null,
    evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }],
  };
}

function brief(actions: readonly ActionSignal[]): DecisionBrief {
  return {
    schema_version: 1,
    id: "brf_1",
    meeting: { id: "meeting-1", title: "Launch review", participants: [] },
    decisions: [{
      id: "decision-0", kind: "decision", text: "Ship the beta", subject: null, confidence: null, status: "decided",
      evidence: [{ meeting_id: "meeting-1", block_id: "transcript-1" }],
    }],
    actions,
    rationales: [],
    provenance: {
      meeting_revision: "revision-1",
      processor: { kind: "decision-processor", adapter_id: "llm", instance_id: "llm-1", version: "1" },
      generated_at: "2026-10-07T00:00:00.000Z",
    },
  };
}

describe("owner proposals V1", () => {
  it("offers only actions with displayable text and a canonical owner, in brief order", () => {
    const proposed = brief([
      action(0, "  Priya \t Shah "),
      action(1, null),
      action(2, "   "),
      action(3, "Jules\u0007"),
      action(4, "J".repeat(121)),
      action(5, "Rafael Moreno", " padded text "),
      action(6, "Cafe\u0301"),
    ]);
    expect(ownerProposalsV1(proposed)).toEqual([
      { action_index: 0, action_text: "Send the launch plan 1", owner: "Priya Shah" },
      { action_index: 6, action_text: "Send the launch plan 7", owner: "Caf\u00e9" },
    ]);
  });

  it("offers at most 40 proposals and none for a brief with more", () => {
    expect(OWNER_PROPOSALS_MAX_V1).toBe(40);
    const forty = brief(Array.from({ length: 40 }, (_, index) => action(index, "Participant")));
    expect(ownerProposalsV1(forty)).toHaveLength(40);
    const fortyOne = brief(Array.from({ length: 41 }, (_, index) => action(index, "Participant")));
    expect(ownerProposalsV1(fortyOne)).toEqual([]);
  });

  it("clears every proposed owner and leaves a brief without proposals byte-identical", () => {
    const plain = brief([action(0, null), action(1, null)]);
    expect(withoutProposedOwnersV1(plain)).toBe(plain);
    expect(JSON.stringify(withoutProposedOwnersV1(plain))).toBe(JSON.stringify(plain));

    const proposed = brief([action(0, "Priya Shah"), action(1, null)]);
    const cleared = withoutProposedOwnersV1(proposed);
    expect(cleared.actions.map((signal) => signal.owner)).toEqual([null, null]);
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(plain));
    expect(proposed.actions[0]!.owner).toBe("Priya Shah");
    expect(ownerProposalsV1(cleared)).toEqual([]);
  });
});
