import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  SqlitePrivateSlackApprovalTerminalAuthorityV1,
} from "../../src/composition/sqlite-private-slack-approval-terminal-authority-v1.js";
import type { SqlitePrivateSlackApprovalAssignmentStateV1 } from "../../src/composition/sqlite-private-slack-approval-assignment-state-v1.js";
import type { SqliteCleanLiveOnlySourceStateV1 } from "../../src/processing/clean-v1/sqlite-live-only-source-state.js";

const NOW = "2026-08-28T00:00:00.000Z";
const APPROVAL_ID = "apr_private";
const CANDIDATE_ID = "cnd_private";
const digest = (value: string) => canonicalSha256({ value }) as `sha256:${string}`;

function sourceCandidate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    candidate_id: CANDIDATE_ID,
    candidate_semantic_sha256: digest("candidate"),
    state: "staged",
    frozen_card_sha256: digest("card"),
    approved_snapshot: {},
    approved_snapshot_sha256: canonicalSha256({}),
    admission: {
      source: {
        adapter_id: "granola",
        instance_id: "granola_private",
        version: "1",
        cursor: "granola:v1:live:private",
        cutoff_at: NOW,
      },
      processor: {
        adapter_id: "llm",
        instance_id: "llm_private",
        version: "1",
        configuration_sha256: digest("processor-contract"),
      },
    },
    meeting: {
      schema_version: 1,
      id: "meeting_private",
      title: "Private planning",
      participants: [],
      content: [],
      artifacts: [],
      capture: { state: "complete", components: [] },
      provenance: {
        external_id: "granola-note-private",
        canonical_revision: "revision-private",
        source: {
          kind: "meeting-source",
          adapter_id: "granola",
          instance_id: "granola_private",
          version: "1",
        },
        observed_at: NOW,
        normalizer_version: "1",
      },
      extensions: {},
    },
    decisions: {
      schema_version: 1,
      meeting_id: "meeting_private",
      meeting_revision: "revision-private",
      generated_at: NOW,
      processor: {
        kind: "decision-processor",
        adapter_id: "llm",
        instance_id: "llm_private",
        version: "1",
      },
      signals: [],
    },
    ...overrides,
  };
}

function presentation(
  candidate: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assignment: {
      organization_id: "org_private",
      candidate: {
        approval_id: candidate.approval_id,
        candidate_id: candidate.candidate_id,
        candidate_sha256: candidate.candidate_semantic_sha256,
        frozen_card_sha256: candidate.frozen_card_sha256,
        approved_snapshot_sha256: candidate.approved_snapshot_sha256,
      },
      dm_channel: { workspace_id: "TPRIVATE", enterprise_id: null, channel_id: "DPRIVATE" },
    },
    provider_message_ts: "1.000001",
    source_outbox_state: candidate.state,
    ...overrides,
  };
}

function harness(input = sourceCandidate()) {
  const source = {
    readFrozenCandidateForApproval: vi.fn(() => input),
  };
  const assignments = {
    readForPresentation: vi.fn(() => presentation(input)),
    readTerminal: vi.fn(),
    recordTerminal: vi.fn(),
    markTerminalCardRendered: vi.fn(),
  };
  const adapter = new SqlitePrivateSlackApprovalTerminalAuthorityV1({
    source: source as unknown as SqliteCleanLiveOnlySourceStateV1,
    assignments: assignments as unknown as SqlitePrivateSlackApprovalAssignmentStateV1,
    coordinates: {
      authority_id: "authority_private",
      organization_id: "org_private",
      state_lineage_id: "lineage_private",
    },
  });
  return { adapter, source, assignments };
}

describe("sqlite private approval processing Authority V1", () => {
  it("reproves the frozen staged tuple and produces exact writer provenance", async () => {
    const { adapter, source, assignments } = harness();

    await expect(adapter.readFrozenCandidateForApproval(APPROVAL_ID)).resolves.toMatchObject({
      candidate_id: CANDIDATE_ID,
      authority_id: "authority_private",
      organization_id: "org_private",
      state_lineage_id: "lineage_private",
      approval_id: APPROVAL_ID,
      source_provenance: {
        authority_id: "authority_private",
        organization_id: "org_private",
        state_lineage_id: "lineage_private",
        source_adapter_id: "granola",
        external_id: "granola-note-private",
      },
      processor_provenance: {
        authority_id: "authority_private",
        organization_id: "org_private",
        state_lineage_id: "lineage_private",
        processor_adapter_id: "llm",
      },
    });
    expect(source.readFrozenCandidateForApproval).toHaveBeenCalledWith(APPROVAL_ID);
    expect(assignments.readForPresentation).toHaveBeenCalledWith(APPROVAL_ID);
  });

  it("allows an already-terminal tuple to recover after source supersession", async () => {
    const frozen = sourceCandidate({ state: "superseded" });
    const { adapter } = harness(frozen);

    await expect(adapter.readFrozenCandidateForApproval(APPROVAL_ID)).resolves.toMatchObject({
      approval_id: APPROVAL_ID,
      candidate_id: CANDIDATE_ID,
    });
  });

  it("rejects a missing card or snapshot commitment before it can reach V4", async () => {
    const { adapter } = harness(sourceCandidate({ frozen_card_sha256: null }));

    await expect(adapter.readFrozenCandidateForApproval(APPROVAL_ID)).rejects.toThrow(
      "card or approved snapshot commitment is absent",
    );
  });

  it("rejects a presentation assignment spliced from another frozen tuple", async () => {
    const frozen = sourceCandidate();
    const { adapter, assignments } = harness(frozen);
    const original = presentation(frozen) as {
      readonly assignment: Record<string, unknown> & {
        readonly candidate: Record<string, unknown>;
      };
    };
    assignments.readForPresentation.mockReturnValue(
      presentation(frozen, {
        assignment: {
          ...original.assignment,
          candidate: {
            ...original.assignment.candidate,
            candidate_id: "cnd_other",
          },
        },
      }),
    );

    await expect(adapter.readFrozenCandidateForApproval(APPROVAL_ID)).rejects.toThrow(
      "private assignment does not bind the frozen source tuple",
    );
  });

});
