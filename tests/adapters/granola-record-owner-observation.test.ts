import { describe, expect, it } from "vitest";
import {
  GranolaApiError,
  observeGranolaRecordOwner,
  type GranolaApiClient,
  type GranolaListParams,
  type GranolaNoteDetail,
} from "../../src/adapters/meeting-sources/granola/index.js";

function client(options: {
  notes: Array<{
    id: string;
    title?: string;
    owner?: unknown;
  }>;
  hasMore?: boolean;
  cursor?: string | null;
}): {
  api: GranolaApiClient;
  listCalls: GranolaListParams[];
  detailCalls: string[];
} {
  const listCalls: GranolaListParams[] = [];
  const detailCalls: string[] = [];
  return {
    api: {
      async listNotes(params) {
        listCalls.push(params);
        return {
          notes: options.notes,
          hasMore: options.hasMore ?? false,
          cursor: options.cursor ?? null,
        };
      },
      async getNote(noteId) {
        detailCalls.push(noteId);
        throw new Error("record-owner observation must not fetch note detail");
      },
    },
    listCalls,
    detailCalls,
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
      hasMore: true,
      cursor: "private-provider-cursor",
    });

    const observation = await observeGranolaRecordOwner(
      fixture.api,
      "audrey@echobrain.org",
    );

    expect(fixture.listCalls).toEqual([{ page_size: 30 }]);
    expect(fixture.detailCalls).toEqual([]);
    expect(observation).toEqual({
      provider: "granola",
      relationship: "record_owner",
      subject: { kind: "email", value: "audrey@echobrain.org" },
      assurance: "provider_record_owner_observed",
      notes_examined: 2,
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("Zhen confidential meeting");
    expect(serialized).not.toContain("Audrey confidential meeting");
    expect(serialized).not.toContain("note-zhen-private-id");
    expect(serialized).not.toContain("note-audrey-private-id");
    expect(serialized).not.toContain("private-provider-cursor");
    expect(serialized).not.toContain("zhen@echobrain.org");
  });

  it("fails closed when the owner is absent from the bounded first page", async () => {
    const notes = Array.from({ length: 30 }, (_, index) => ({
      id: `note-other-${index}`,
      owner:
        index === 0
          ? undefined
          : index === 1
            ? { email: "not an email" }
            : { email: "zhen@echobrain.org" },
    }));
    notes.push({
      id: "note-audrey-outside-bound",
      owner: { email: "audrey@echobrain.org" },
    });
    const fixture = client({ notes, hasMore: true, cursor: "next-page" });

    await expect(
      observeGranolaRecordOwner(fixture.api, "audrey@echobrain.org"),
    ).rejects.toThrow(
      "Granola did not report an accessible note owned by audrey@echobrain.org",
    );
    expect(fixture.listCalls).toEqual([{ page_size: 30 }]);
    expect(fixture.detailCalls).toEqual([]);
  });

  it("rejects a non-canonical configured owner before provider contact", async () => {
    const fixture = client({ notes: [] });

    await expect(
      observeGranolaRecordOwner(fixture.api, "Audrey@EchoBrain.org"),
    ).rejects.toThrow("canonical lowercase email");
    expect(fixture.listCalls).toEqual([]);
    expect(fixture.detailCalls).toEqual([]);
  });

  it("preserves Granola authentication errors", async () => {
    const authenticationError = new GranolaApiError(
      "Granola API authentication failed",
      "auth_failed",
      401,
    );
    const api: GranolaApiClient = {
      listNotes: async () => {
        throw authenticationError;
      },
      getNote: async (_noteId: string): Promise<GranolaNoteDetail> => {
        throw new Error("not used");
      },
    };

    await expect(
      observeGranolaRecordOwner(api, "audrey@echobrain.org"),
    ).rejects.toBe(authenticationError);
  });
});
