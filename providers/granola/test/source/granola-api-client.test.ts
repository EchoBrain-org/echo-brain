import { describe, expect, it } from "vitest";
import {
  GRANOLA_JSON_RESPONSE_MAX_BYTES,
  granolaNoteTimestamp,
  HttpGranolaApiClient,
} from "../../src/source/granola-api-client.js";

const note = {
  id: "note-1",
  object: "note",
  title: "Synthetic meeting",
  owner: { name: "Fixture Owner", email: "owner@example.com" },
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T13:00:00Z",
  summary_text: "A synthetic summary.",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tooLarge(): Response {
  return new Response(null, { status: 413 });
}

function streamed(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
  blockAfterChunks = false,
): { readonly response: Response; readonly wasCancelled: () => boolean } {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        if (blockAfterChunks) return new Promise<void>(() => {});
        controller.close();
        return undefined;
      }
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json", ...headers } }),
    wasCancelled: () => cancelled,
  };
}

function fixtureClient(responses: unknown[]) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const client = new HttpGranolaApiClient("grn_synthetic_fixture", {
    fetchImpl: async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      if (responses.length === 0) throw new Error("Unexpected fixture request");
      const response = responses.shift();
      return response instanceof Response ? response : json(response);
    },
  });
  return { client, requests };
}

function page(text: string, cursor: string | null = null) {
  return { transcript: [{ text }], hasMore: cursor !== null, cursor };
}

describe("Granola complete transcript transport", () => {
  it("uses the inline transcript and refuses redirects", async () => {
    const { client, requests } = fixtureClient([
      { ...note, transcript: [{ text: "A synthetic turn." }] },
    ]);

    await expect(client.getNote(note.id)).resolves.toMatchObject({
      id: note.id,
      transcript: [{ text: "A synthetic turn." }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.searchParams.get("include")).toBe("transcript");
    expect(requests[0]?.init?.redirect).toBe("error");
  });

  it.each([
    { name: "nested code", response: json({ error: { code: "TRANSCRIPT_TOO_LARGE" } }, 413) },
    { name: "top-level code", response: json({ code: "TRANSCRIPT_TOO_LARGE" }, 413) },
    { name: "bodyless response", response: tooLarge() },
    { name: "unstructured response", response: new Response("Synthetic size error", { status: 413 }) },
  ])("walks all pages after the initial inline HTTP 413 ($name)", async ({ response }) => {
    const reorderedMetadata = {
      summary_text: note.summary_text,
      updated_at: note.updated_at,
      created_at: note.created_at,
      owner: { email: "owner@example.com", name: "Fixture Owner" },
      title: note.title,
      object: note.object,
      id: note.id,
    };
    const { client, requests } = fixtureClient([
      response,
      note,
      page("First synthetic turn.", "opaque-next-page"),
      page("Second synthetic turn."),
      reorderedMetadata,
    ]);

    await expect(client.getNote(note.id)).resolves.toMatchObject({
      ...note,
      transcript: [
        { text: "First synthetic turn." },
        { text: "Second synthetic turn." },
      ],
    });
    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/v1/notes/note-1?include=transcript",
      "/v1/notes/note-1",
      "/v1/notes/note-1/transcript?page_size=100",
      "/v1/notes/note-1/transcript?page_size=100&cursor=opaque-next-page",
      "/v1/notes/note-1",
    ]);
    expect(requests.every(({ init }) => init?.redirect === "error")).toBe(true);
  });

  it.each([400, 401, 403, 404, 429, 500])("does not fall back for initial HTTP %s regardless of body", async (status) => {
    const { client, requests } = fixtureClient([json({ code: "TRANSCRIPT_TOO_LARGE" }, status)]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      status,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    { stage: "initial metadata", responses: [tooLarge(), tooLarge()] },
    { stage: "first transcript page", responses: [tooLarge(), note, tooLarge()] },
    { stage: "later transcript page", responses: [tooLarge(), note, page("Synthetic.", "next"), tooLarge()] },
    { stage: "final metadata", responses: [tooLarge(), note, page("Synthetic."), tooLarge()] },
  ])("does not retry a HTTP 413 from $stage or return partial data", async ({ responses }) => {
    const expectedCalls = responses.length;
    const { client, requests } = fixtureClient([...responses]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "api_failed", status: 413,
    });
    expect(requests).toHaveLength(expectedCalls);
  });

  it("does not fall back for HTTP 413 from list retrieval", async () => {
    const { client, requests } = fixtureClient([tooLarge()]);
    await expect(client.listNotes({})).rejects.toMatchObject({
      reason: "api_failed", status: 413,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    { updated_at: "2026-10-01T14:00:00Z" },
    { owner: { email: "someone-else@example.com" } },
    { summary_text: "Changed synthetic summary." },
    { future_context: { permission: "changed" } },
  ])("rejects metadata changes across the transcript walk (%j)", async (change) => {
    const { client, requests } = fixtureClient([
      tooLarge(), note, page("Synthetic turn."), { ...note, ...change },
    ]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "api_failed",
    });
    expect(requests).toHaveLength(4);
  });

  it("requires a provider update timestamp before a paged transcript walk", async () => {
    const { updated_at: _updatedAt, ...withoutUpdate } = note;
    const { client, requests } = fixtureClient([tooLarge(), withoutUpdate]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "api_failed",
    });
    expect(requests).toHaveLength(2);
  });

  it.each([
    { responses: [{ ...note, id: "other-note", transcript: [{ text: "Synthetic." }] }] },
    { responses: [tooLarge(), { ...note, id: "other-note" }] },
    { responses: [tooLarge(), note, page("Synthetic."), { ...note, id: "other-note" }] },
  ])("rejects a returned note identity that differs from the request", async ({ responses }) => {
    const { client } = fixtureClient([...responses]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "api_failed" });
  });

  it.each([
    null,
    { transcript: null, hasMore: false, cursor: null },
    { transcript: {}, hasMore: false, cursor: null },
    { transcript: [null], hasMore: false, cursor: null },
    { transcript: [{}], hasMore: false, cursor: null },
    { transcript: [{ text: 42 }], hasMore: false, cursor: null },
    { transcript: [], hasMore: "false", cursor: null },
    { transcript: [], hasMore: true, cursor: null },
    { transcript: [], hasMore: true, cursor: "" },
    { transcript: [], hasMore: true, cursor: "   " },
    { transcript: [], hasMore: true },
    { transcript: [], hasMore: false },
    { transcript: [], hasMore: false, cursor: 42 },
    { transcript: [], hasMore: false, cursor: "unexpected-terminal-cursor" },
    { transcript: Array.from({ length: 101 }, () => ({ text: "Synthetic." })), hasMore: false, cursor: null },
  ])("rejects a malformed or oversized transcript page (%j)", async (invalidPage) => {
    const { client, requests } = fixtureClient([tooLarge(), note, invalidPage]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: expect.stringMatching(/^(api_failed|pagination_failed)$/),
    });
    expect(requests).toHaveLength(3);
  });

  it.each([
    { pages: [page("One.", "a"), page("Two.", "a")] },
    { pages: [page("One.", "a"), page("Two.", "b"), page("Three.", "a")] },
  ])("rejects repeated cursors and cycles without returning a partial transcript", async ({ pages }) => {
    const { client, requests } = fixtureClient([tooLarge(), note, ...pages]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "pagination_failed",
    });
    expect(requests).toHaveLength(2 + pages.length);
  });

  it("bounds the page walk even when every continuation cursor is new", async () => {
    const pages = Array.from({ length: 100 }, (_, index) =>
      page("Synthetic turn.", `next-${index}`),
    );
    const { client, requests } = fixtureClient([tooLarge(), note, ...pages]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "pagination_failed",
    });
    expect(requests).toHaveLength(102);
  });

  it("accepts a complete transcript exactly at the item and page bound", async () => {
    const pages = Array.from({ length: 100 }, (_, index) => ({
      transcript: Array.from({ length: 100 }, () => ({ text: "Synthetic turn." })),
      hasMore: index < 99,
      cursor: index < 99 ? `next-${index}` : null,
    }));
    const { client, requests } = fixtureClient([tooLarge(), note, ...pages, note]);
    expect((await client.getNote(note.id)).transcript).toHaveLength(10_000);
    expect(requests).toHaveLength(103);
  });

  it("does not return already-fetched pages after a later provider failure", async () => {
    const { client, requests } = fixtureClient([
      tooLarge(), note, page("Synthetic turn.", "next"), json({}, 503),
    ]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "api_failed", status: 503,
    });
    expect(requests).toHaveLength(4);
  });
});

describe("Granola response and assembled-transcript bounds", () => {
  it("rejects a declared response larger than the streaming byte bound and cancels its body", async () => {
    const body = streamed(
      [new TextEncoder().encode("{}")],
      { "content-length": String(GRANOLA_JSON_RESPONSE_MAX_BYTES + 1) },
    );
    const { client, requests } = fixtureClient([body.response, tooLarge()]);

    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "api_failed" });
    expect(requests).toHaveLength(2);
    expect(body.wasCancelled()).toBe(true);
  });

  it("rejects a chunked response that exceeds the bound despite a misleading content length", async () => {
    const body = streamed([
      new Uint8Array(GRANOLA_JSON_RESPONSE_MAX_BYTES),
      new Uint8Array([0]),
    ], { "content-length": "1" }, true);
    const { client, requests } = fixtureClient([body.response, tooLarge()]);

    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "api_failed" });
    expect(requests).toHaveLength(2);
    expect(body.wasCancelled()).toBe(true);
  });

  it("accepts a streamed response without Content-Length when its actual bytes are bounded", async () => {
    const body = streamed([new TextEncoder().encode(JSON.stringify({
      ...note,
      transcript: [{ text: "Synthetic turn." }],
    }))]);
    const { client } = fixtureClient([body.response]);

    await expect(client.getNote(note.id)).resolves.toMatchObject({
      transcript: [{ text: "Synthetic turn." }],
    });
  });

  it("uses paged transcript fallback when the initial inline response exceeds the local byte bound", async () => {
    const inline = streamed([new Uint8Array(GRANOLA_JSON_RESPONSE_MAX_BYTES + 1)], {}, true);
    const { client, requests } = fixtureClient([
      inline.response, note, page("Synthetic turn."), note,
    ]);

    await expect(client.getNote(note.id)).resolves.toMatchObject({
      transcript: [{ text: "Synthetic turn." }],
    });
    expect(requests).toHaveLength(4);
    expect(inline.wasCancelled()).toBe(true);
  });

  it.each([
    { stage: "metadata", responses: [tooLarge(), streamed([new Uint8Array(GRANOLA_JSON_RESPONSE_MAX_BYTES + 1)], {}, true).response] },
    { stage: "transcript page", responses: [tooLarge(), note, streamed([new Uint8Array(GRANOLA_JSON_RESPONSE_MAX_BYTES + 1)], {}, true).response] },
  ])("does not fall back after an oversized $stage response", async ({ responses }) => {
    const { client } = fixtureClient([...responses]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "api_failed" });
  });

  it("stops a blocked response reader when the parent request is cancelled", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        started();
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = fixtureClient([new Response(body, {
      headers: { "content-type": "application/json" },
    })]);
    const pending = client.getNote(note.id, { signal: controller.signal });
    await reading;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ reason: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("refuses a paged transcript whose assembled transport bytes exceed its provider bound", async () => {
    const pageText = "x".repeat(1_900_000);
    const pages = Array.from({ length: 9 }, (_, index) =>
      page(pageText, index < 8 ? `next-${index}` : null),
    );
    const { client, requests } = fixtureClient([
      tooLarge(), note, ...pages,
    ]);

    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "pagination_failed" });
    expect(requests).toHaveLength(11);
  });
});

describe("Granola malformed exports and custody boundary", () => {
  it("rejects whitespace-only note identities before they can prove ownership", async () => {
    const { client } = fixtureClient([{ id: "   " }]);
    await expect(client.getNote("   ")).rejects.toMatchObject({ reason: "api_failed" });
  });

  it.each([
    { object: null }, { object: 42 }, { title: {} },
    { created_at: null }, { created_at: 42 }, { created_at: "not-a-date" },
    { updated_at: "2026-02-30T12:00:00Z" },
    { updated_at: "2026-10-01" },
    { updated_at: "2026-10-01T25:00:00Z" },
    { summary_markdown: [] }, { summary_text: false }, { web_url: 42 },
    { transcript: [{ text: null }] }, { transcript: [{ text: {} }] },
    { transcript: [{}] },
    { transcript: [{ text: "Synthetic.", start_time: "bad-time" }] },
    { transcript: [{ text: "Synthetic.", end_time: {} }] },
    { transcript: [{ text: "Synthetic.", start: -1 }] },
    { transcript: [{ text: "Synthetic.", end: "Infinity" }] },
  ])("rejects malformed known fields instead of silently dropping them (%j)", async (invalid) => {
    const { client } = fixtureClient([{ ...note, ...invalid }]);
    await expect(client.getNote(note.id)).rejects.toMatchObject({ reason: "api_failed" });
  });

  it("preserves absent fields and nullable title, summary, and transcript fixtures", async () => {
    const { client } = fixtureClient([
      { id: "minimal" },
      { id: "nullable", title: null, summary_markdown: null, summary_text: null, transcript: null },
      { id: "offsets", transcript: [{ text: "Synthetic.", start: "1.5", end: 2, start_time: null }] },
    ]);
    await expect(client.getNote("minimal")).resolves.toEqual({ id: "minimal" });
    await expect(client.getNote("nullable")).resolves.toEqual({
      id: "nullable", title: null, summary_markdown: null, summary_text: null, transcript: null,
    });
    await expect(client.getNote("offsets")).resolves.toMatchObject({
      transcript: [{ start: "1.5", end: 2, start_time: null }],
    });
  });

  it.each(["private_notes_text", "private_notes_markdown"])(
    "rejects non-null %s from the organization export lane",
    async (field) => {
      const { client } = fixtureClient([{ ...note, [field]: "Synthetic private notes." }]);
      const error = await client.getNote(note.id).catch((err: unknown) => err);
      expect(error).toMatchObject({ reason: "api_failed" });
      expect(String(error)).not.toContain("Synthetic private notes.");
    },
  );

  it("preserves documented null private-note metadata without changing revision mapping", async () => {
    const { client } = fixtureClient([{
      ...note,
      private_notes_text: null,
      private_notes_markdown: null,
      future_context: { synthetic: true },
    }]);
    const result = await client.getNote(note.id);
    expect(result.provider_fields).toEqual({
      private_notes_text: null,
      private_notes_markdown: null,
      future_context: { synthetic: true },
    });
  });

  it.each([
    { notes: [{ id: note.id, title: 42 }], hasMore: false, cursor: null },
    { notes: [{ id: note.id, updated_at: "not-a-date" }], hasMore: false, cursor: null },
    { notes: [{ id: note.id, private_notes_text: "Synthetic private." }], hasMore: false, cursor: null },
    { notes: [], hasMore: true, cursor: null },
    { notes: [], hasMore: true, cursor: "" },
    { notes: [], hasMore: true, cursor: "   " },
    { notes: [note, note], hasMore: false, cursor: null },
  ])("rejects malformed list exports and oversized requested pages (%j)", async (response) => {
    const { client } = fixtureClient([response]);
    await expect(client.listNotes({ page_size: 1 })).rejects.toMatchObject({
      reason: "pagination_failed",
    });
  });

  it("rejects a list continuation that repeats the requested cursor", async () => {
    const { client } = fixtureClient([{ notes: [], hasMore: true, cursor: "page-a" }]);
    await expect(client.listNotes({ page_size: 1, cursor: "page-a" })).rejects.toMatchObject({
      reason: "pagination_failed",
    });
  });
});

describe("Granola note revision timestamps", () => {
  it.each([
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2026-10-01T12:00:00.123+02:30", "2026-10-01T09:30:00.123Z"],
    ["2000-02-29T12:00:00-08:00", "2000-02-29T20:00:00.000Z"],
  ])("canonicalizes the documented date-time %s", (input, expected) => {
    expect(granolaNoteTimestamp(input)).toBe(expected);
  });

  it.each([
    "1900-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-00-01T12:00:00Z",
    "2026-10-01T12:00:00+24:00", "2026-10-01T12:00:00+01:60",
    "42", "2026-10-01", " 2026-10-01T12:00:00Z", null,
  ])("rejects a revision timestamp that would be guessed or rolled over (%j)", (input) => {
    expect(granolaNoteTimestamp(input)).toBeNull();
  });
});

describe("Granola cancellation and sanitized failures", () => {
  it("cancels before fetching when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("Synthetic cancellation");
    const { client, requests } = fixtureClient([]);
    await expect(client.getNote(note.id, { signal: controller.signal })).rejects.toMatchObject({
      reason: "timeout",
    });
    expect(requests).toHaveLength(0);
  });

  it("stops a page walk when cancellation arrives during a response", async () => {
    const controller = new AbortController();
    const responses = [tooLarge(), json(note), json(page("Synthetic turn.", "next"))];
    let calls = 0;
    const client = new HttpGranolaApiClient("grn_synthetic_fixture", {
      fetchImpl: async () => {
        calls += 1;
        const response = responses.shift()!;
        if (calls === 3) controller.abort();
        return response;
      },
    });
    await expect(client.getNote(note.id, { signal: controller.signal })).rejects.toMatchObject({
      reason: "timeout",
    });
    expect(calls).toBe(3);
  });

  it("sanitizes network and JSON parser errors", async () => {
    const network = new HttpGranolaApiClient("grn_synthetic_fixture", {
      fetchImpl: async () => { throw new Error("Sensitive synthetic network content"); },
    });
    const malformedJson = fixtureClient([new Response("Sensitive synthetic JSON content")]).client;
    for (const client of [network, malformedJson]) {
      const error = await client.getNote(note.id).catch((err: unknown) => err);
      expect(error).toMatchObject({ reason: "api_failed" });
      expect(String(error)).not.toContain("Sensitive");
    }
  });

  it("maps a timed-out request without provider error text", async () => {
    const client = new HttpGranolaApiClient("grn_synthetic_fixture", {
      requestTimeoutMs: 1,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Sensitive timeout text")));
      }),
    });
    await expect(client.getNote(note.id)).rejects.toMatchObject({
      reason: "timeout", message: "Granola API request timed out",
    });
  });
});
