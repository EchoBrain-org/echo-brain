import { describe, expect, it, vi } from "vitest";
import {
  MAX_RELATED_ATOM_CANDIDATES_V1,
  MAX_RELATED_ATOM_LINKS_PER_ATOM_V1,
  MAX_RELATED_ATOM_LINKS_TOTAL_V1,
  MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1,
  projectRelatedAtomsV1,
  RelatedAtomProjectorError,
  type RelatedAtomStructuredGenerationInputV1,
} from "../../src/composition/related-atom-projector-v1.js";

const atoms = Object.freeze([
  {
    atom_id: "atom-decision",
    record_id: "record-implementation",
    item_kind: "decision",
    text: "The September 16 window is conditional on the readiness review.",
  },
  {
    atom_id: "atom-readiness",
    record_id: "record-data",
    item_kind: "decision",
    text: "Production access requires the signed addendum and verified security contact.",
  },
  {
    atom_id: "atom-adoption",
    record_id: "record-revenue",
    item_kind: "decision",
    text: "Expansion requires four weeks of adoption evidence.",
  },
  {
    atom_id: "atom-same-record",
    record_id: "record-implementation",
    item_kind: "action",
    text: "The implementation team will publish the readiness checklist.",
  },
]);

function model(response: unknown) {
  return {
    generate: vi.fn(async (_input: RelatedAtomStructuredGenerationInputV1) => response),
  };
}

describe("related atom projector V1", () => {
  it("accepts one quoted cross-record relationship, canonicalizes it, and sends only approved atom summaries", async () => {
    const structuredOutput = model({
      relationships: [
        {
          left_atom_id: "atom-readiness",
          right_atom_id: "atom-decision",
          left_supporting_excerpt: "Production access requires the signed addendum",
          right_supporting_excerpt: "window is conditional on the readiness review",
        },
      ],
    });

    const result = await projectRelatedAtomsV1({
      atoms,
      model: "test-model",
      structured_output: structuredOutput,
    });

    expect(result).toEqual([
      { left_atom_id: "atom-decision", right_atom_id: "atom-readiness" },
    ]);
    expect(structuredOutput.generate).toHaveBeenCalledOnce();
    const request = structuredOutput.generate.mock.calls[0]?.[0];
    expect(request.system_prompt).toContain("shared-word-only");
    expect(request.system_prompt).toContain("customer-only");
    expect(request.system_prompt).toContain("date-only");
    expect(request.user_prompt).toContain("atom-decision");
    expect(request.user_prompt).not.toContain("transcript");
    expect(request.schema).toMatchObject({
      type: "object",
      required: ["relationships"],
      properties: {
        relationships: { maxItems: 6 },
      },
    });
    expect(MAX_RELATED_ATOM_CANDIDATES_V1).toBe(6);
    expect(MAX_RELATED_ATOM_LINKS_TOTAL_V1).toBe(6);
  });

  it("skips unknown, self, same-record, unquoted, duplicate, and reversed candidates", async () => {
    const structuredOutput = model({
      relationships: [
        {
          left_atom_id: "atom-decision",
          right_atom_id: "atom-readiness",
          left_supporting_excerpt: "readiness review",
          right_supporting_excerpt: "signed addendum",
        },
        {
          left_atom_id: "atom-readiness",
          right_atom_id: "atom-decision",
          left_supporting_excerpt: "signed addendum",
          right_supporting_excerpt: "readiness review",
        },
        {
          left_atom_id: "atom-decision",
          right_atom_id: "atom-decision",
          left_supporting_excerpt: "readiness review",
          right_supporting_excerpt: "readiness review",
        },
        {
          left_atom_id: "atom-decision",
          right_atom_id: "atom-same-record",
          left_supporting_excerpt: "readiness review",
          right_supporting_excerpt: "readiness checklist",
        },
        {
          left_atom_id: "atom-decision",
          right_atom_id: "missing",
          left_supporting_excerpt: "readiness review",
          right_supporting_excerpt: "anything",
        },
        {
          left_atom_id: "atom-decision",
          right_atom_id: "atom-adoption",
          left_supporting_excerpt: "not in the source",
          right_supporting_excerpt: "adoption evidence",
        },
      ],
    });

    await expect(
      projectRelatedAtomsV1({
        atoms,
        model: "test-model",
        structured_output: structuredOutput,
      }),
    ).resolves.toEqual([
      { left_atom_id: "atom-decision", right_atom_id: "atom-readiness" },
    ]);
  });

  it("rejects token-sized excerpts that do not materially ground either endpoint", async () => {
    await expect(
      projectRelatedAtomsV1({
        atoms,
        model: "test-model",
        structured_output: model({
          relationships: [
            {
              left_atom_id: "atom-decision",
              right_atom_id: "atom-readiness",
              left_supporting_excerpt: "window",
              right_supporting_excerpt: "access",
            },
          ],
        }),
      }),
    ).resolves.toEqual([]);
  });

  it("fails before provider IO when approved text exceeds the aggregate payload bound", async () => {
    const structuredOutput = model({ relationships: [] });
    await expect(
      projectRelatedAtomsV1({
        atoms: [
          {
            atom_id: "atom-large",
            record_id: "record-large",
            item_kind: "decision",
            text: "x".repeat(MAX_RELATED_ATOM_SOURCE_TEXT_UTF8_BYTES_V1 + 1),
          },
        ],
        model: "test-model",
        structured_output: structuredOutput,
      }),
    ).rejects.toThrow("aggregate UTF-8 bound");
    expect(structuredOutput.generate).not.toHaveBeenCalled();
  });

  it("bounds accepted links per atom and across a visibility segment", async () => {
    const boundedAtoms = Array.from({ length: 20 }, (_, index) => ({
      atom_id: `atom-${index}`,
      record_id: `record-${index}`,
      item_kind: "decision",
      text: `Fact ${index} governs the shared launch condition.`,
    }));
    const relationships = boundedAtoms.slice(1, 7).map((atom) => ({
      left_atom_id: "atom-0",
      right_atom_id: atom.atom_id,
      left_supporting_excerpt: "shared launch condition",
      right_supporting_excerpt: "shared launch condition",
    }));
    const structuredOutput = model({ relationships });

    const result = await projectRelatedAtomsV1({
      atoms: boundedAtoms,
      model: "test-model",
      structured_output: structuredOutput,
    });

    expect(result).toHaveLength(MAX_RELATED_ATOM_LINKS_PER_ATOM_V1);
    expect(result).toHaveLength(
      Math.min(
        MAX_RELATED_ATOM_LINKS_PER_ATOM_V1,
        MAX_RELATED_ATOM_LINKS_TOTAL_V1,
      ),
    );
  });

  it("admits the complete six-pair segment budget within the provider output bound", async () => {
    const boundedAtoms = Array.from({ length: 12 }, (_, index) => ({
      atom_id: `atom-${index}`,
      record_id: `record-${index}`,
      item_kind: "decision",
      text: `Fact ${index} sets a material condition.`,
    }));
    const relationships = Array.from(
      { length: MAX_RELATED_ATOM_CANDIDATES_V1 },
      (_, index) => ({
        left_atom_id: `atom-${index * 2}`,
        right_atom_id: `atom-${index * 2 + 1}`,
        left_supporting_excerpt: "material condition",
        right_supporting_excerpt: "material condition",
      }),
    );
    const structuredOutput = model({ relationships });

    const result = await projectRelatedAtomsV1({
      atoms: boundedAtoms,
      model: "test-model",
      structured_output: structuredOutput,
    });

    expect(result).toHaveLength(MAX_RELATED_ATOM_LINKS_TOTAL_V1);
    const request = structuredOutput.generate.mock.calls[0]?.[0];
    expect(request.schema).toMatchObject({
      properties: {
        relationships: { maxItems: 6 },
      },
    });
    expect(request.max_output_tokens).toBe(2_000);
  });

  it("fails closed when a provider response exceeds the six-pair schema", async () => {
    const boundedAtoms = Array.from({ length: 14 }, (_, index) => ({
      atom_id: `atom-${index}`,
      record_id: `record-${index}`,
      item_kind: "decision",
      text: `Fact ${index} sets a material condition.`,
    }));
    const relationships = Array.from({ length: 7 }, (_, index) => ({
      left_atom_id: `atom-${index * 2}`,
      right_atom_id: `atom-${index * 2 + 1}`,
      left_supporting_excerpt: "material condition",
      right_supporting_excerpt: "material condition",
    }));

    await expect(
      projectRelatedAtomsV1({
        atoms: boundedAtoms,
        model: "test-model",
        structured_output: model({ relationships }),
      }),
    ).rejects.toThrow("response is invalid");
  });

  it("fails closed when the model response is not a relationship envelope", async () => {
    await expect(
      projectRelatedAtomsV1({
        atoms,
        model: "test-model",
        structured_output: model({ relationships: "not-an-array" }),
      }),
    ).rejects.toBeInstanceOf(RelatedAtomProjectorError);
  });
});
