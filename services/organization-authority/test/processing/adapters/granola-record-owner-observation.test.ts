import { describe, expect, it } from "vitest";
import {
  observeGranolaRecordOwner,
  type GranolaApiClient,
  type GranolaListParams,
} from "../../../src/processing/adapters/meeting-sources/granola/index.js";

function client(options: {
  notes: Array<{ id: string; title?: string; owner?: unknown }>;
}): { api: GranolaApiClient; listCalls: GranolaListParams[] } {
  const listCalls: GranolaListParams[] = [];
  return {
    api: {
      async listNotes(params) {
        listCalls.push(params);
        return { notes: options.notes, hasMore: true, cursor: "next-page" };
      },
      async getNote() {
        throw new Error("record-owner observation must not fetch note detail");
      },
    },
    listCalls,
  };
}

describe("Granola record-owner observation", () => {
  it("matches provider owner metadata in one bounded page without fetching content", async () => {
    const fixture = client({
      notes: [
        {
          id: "note-zhen-private-id",
          title: "Zhen confidential meeting",
          owner: { name: "Zhen", email: "zhen@echobrain.org" },
        },
        {
          id: "note-audrey-private-id",
          title: "Audrey confidential meeting",
          owner: { name: "Audrey Ng", email: " Audrey@ECHOBrain.org " },
        },
      ],
    });

    const observation = await observeGranolaRecordOwner(
      fixture.api,
      "audrey@echobrain.org",
    );

    expect(fixture.listCalls).toEqual([{ page_size: 30 }]);
    expect(observation).toEqual({
      provider: "granola",
      relationship: "record_owner",
      subject: { kind: "email", value: "audrey@echobrain.org" },
      assurance: "provider_record_owner_observed",
      notes_examined: 2,
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("confidential meeting");
    expect(serialized).not.toContain("note-zhen-private-id");
    expect(serialized).not.toContain("note-audrey-private-id");
    expect(serialized).not.toContain("zhen@echobrain.org");
  });

  it("fails closed when the owner is absent from the bounded first page", async () => {
    const notes = Array.from({ length: 30 }, (_, index) => ({
      id: `note-other-${index}`,
      owner: index === 0 ? undefined : { email: "zhen@echobrain.org" },
    }));
    notes.push({
      id: "note-audrey-outside-bound",
      owner: { email: "audrey@echobrain.org" },
    });
    const fixture = client({ notes });

    await expect(
      observeGranolaRecordOwner(fixture.api, "audrey@echobrain.org"),
    ).rejects.toThrow(
      "Granola did not report an accessible note owned by the configured owner",
    );
    expect(fixture.listCalls).toEqual([{ page_size: 30 }]);
  });
});
