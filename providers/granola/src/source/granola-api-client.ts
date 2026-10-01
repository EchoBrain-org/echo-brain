export const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";
export const DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS = 15_000;
// Granola caps page_size at 30; values above 30 return HTTP 400.
export const DEFAULT_GRANOLA_PAGE_SIZE = 30;
export const GRANOLA_API_KEY_RE = /^grn_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const GRANOLA_TRANSCRIPT_PAGE_SIZE = 100;
// These are admission bounds, not truncation limits. An incomplete export fails.
const MAX_GRANOLA_TRANSCRIPT_PAGES = 100;
const MAX_GRANOLA_TRANSCRIPT_ITEMS = 10_000;

export interface GranolaListNote {
  id: string;
  object?: string;
  title?: string | null;
  owner?: unknown;
  created_at?: string;
  updated_at?: string;
  /** Provider fields not yet promoted into the typed Granola contract. */
  provider_fields?: Record<string, unknown>;
}

export interface GranolaTranscriptSpeaker {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  email?: unknown;
  source?: unknown;
  diarization_label?: unknown;
  [key: string]: unknown;
}

export interface GranolaTranscriptItem {
  text?: string;
  start_time?: number | string | null;
  end_time?: number | string | null;
  start?: number | string | null;
  end?: number | string | null;
  speaker?: string | GranolaTranscriptSpeaker | null;
  [key: string]: unknown;
}

export interface GranolaNoteDetail extends GranolaListNote {
  summary_markdown?: string | null;
  summary_text?: string | null;
  transcript?: GranolaTranscriptItem[] | null;
  attendees?: unknown;
  calendar_event?: unknown;
  folder_membership?: unknown;
  web_url?: string | null;
}

export interface GranolaListParams {
  updated_after?: string;
  cursor?: string;
  page_size?: number;
}

export interface GranolaListResponse {
  notes: GranolaListNote[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaApiClient {
  listNotes(
    params: GranolaListParams,
    options?: { signal?: AbortSignal },
  ): Promise<GranolaListResponse>;
  getNote(
    noteId: string,
    options?: { signal?: AbortSignal },
  ): Promise<GranolaNoteDetail>;
}

export type GranolaApiErrorReason =
  | "auth_failed"
  | "rate_limited"
  | "timeout"
  | "pagination_failed"
  | "api_failed";

export class GranolaApiError extends Error {
  constructor(
    message: string,
    public readonly reason: GranolaApiErrorReason,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GranolaApiError";
  }
}

export class HttpGranolaApiClient implements GranolaApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      baseUrl?: string;
      requestTimeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async listNotes(
    params: GranolaListParams,
    options: { signal?: AbortSignal } = {},
  ): Promise<GranolaListResponse> {
    const pageSize = params.page_size ?? DEFAULT_GRANOLA_PAGE_SIZE;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > DEFAULT_GRANOLA_PAGE_SIZE
    ) {
      throw new GranolaApiError(
        "Granola list page size was invalid",
        "pagination_failed",
      );
    }
    const url = this.url("/notes");
    if (params.updated_after !== undefined) {
      url.searchParams.set("updated_after", params.updated_after);
    }
    if (params.cursor !== undefined) {
      url.searchParams.set("cursor", params.cursor);
    }
    if (params.page_size !== undefined) {
      url.searchParams.set("page_size", String(params.page_size));
    }
    return parseListResponse(
      await this.fetchJson(url, options.signal),
      pageSize,
      params.cursor,
    );
  }

  async getNote(
    noteId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GranolaNoteDetail> {
    const url = this.url(`/notes/${encodeURIComponent(noteId)}`);
    url.searchParams.set("include", "transcript");
    try {
      return parseNoteDetail(await this.fetchJson(url, options.signal), noteId);
    } catch (err) {
      if (!(err instanceof GranolaApiError && err.status === 413)) throw err;
    }

    // Granola documents HTTP 413 for this exact inline-transcript request but
    // does not specify an error-body schema. Metadata and page failures below
    // remain ordinary failures and cannot start another fallback.
    // Read metadata both before and after pagination to reject mixed revisions.
    const metadataUrl = this.url(`/notes/${encodeURIComponent(noteId)}`);
    const detail = parseNoteDetail(
      await this.fetchJson(metadataUrl, options.signal),
      noteId,
    );
    if (detail.updated_at === undefined) {
      throw new GranolaApiError(
        "Granola paged transcript had no update timestamp",
        "api_failed",
      );
    }
    const metadata = metadataIdentity(detail);
    const transcript: GranolaTranscriptItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageIndex = 0;
      pageIndex < MAX_GRANOLA_TRANSCRIPT_PAGES;
      pageIndex += 1
    ) {
      const transcriptUrl = this.url(
        `/notes/${encodeURIComponent(noteId)}/transcript`,
      );
      transcriptUrl.searchParams.set(
        "page_size",
        String(GRANOLA_TRANSCRIPT_PAGE_SIZE),
      );
      if (cursor !== undefined) transcriptUrl.searchParams.set("cursor", cursor);
      const page = parseTranscriptPage(
        await this.fetchJson(transcriptUrl, options.signal),
      );
      if (transcript.length + page.transcript.length > MAX_GRANOLA_TRANSCRIPT_ITEMS) {
        throw new GranolaApiError(
          "Granola transcript exceeded the item bound",
          "pagination_failed",
        );
      }
      transcript.push(...page.transcript);
      if (!page.hasMore) {
        const latest = parseNoteDetail(
          await this.fetchJson(metadataUrl, options.signal),
          noteId,
        );
        if (metadataIdentity(latest) !== metadata) {
          throw new GranolaApiError(
            "Granola note changed during transcript pagination",
            "api_failed",
          );
        }
        return { ...detail, transcript };
      }
      // parseTranscriptPage already proves the continuation token is a string.
      const nextCursor = page.cursor!;
      if (seenCursors.has(nextCursor)) {
        throw new GranolaApiError(
          "Granola transcript cursor repeated",
          "pagination_failed",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new GranolaApiError(
      "Granola transcript exceeded the page bound",
      "pagination_failed",
    );
  }

  private url(path: string): URL {
    return new URL(
      path.replace(/^\//, ""),
      `${this.opts.baseUrl ?? GRANOLA_API_BASE_URL}/`,
    );
  }

  private async fetchJson(
    url: URL,
    parentSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (parentSignal?.aborted === true) {
      throw new GranolaApiError("Granola API request was cancelled", "timeout");
    }
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.requestTimeoutMs ?? DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error("Request aborted");
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        if (response.status === 401 || response.status === 403) {
          throw new GranolaApiError(
            "Granola API authentication failed",
            "auth_failed",
            response.status,
          );
        }
        if (response.status === 429) {
          throw new GranolaApiError(
            "Granola API rate limit exceeded",
            "rate_limited",
            response.status,
            retryAfterMs,
          );
        }
        throw new GranolaApiError(
          `Granola API request failed with HTTP ${response.status}`,
          "api_failed",
          response.status,
        );
      }
      const value: unknown = await response.json();
      if (controller.signal.aborted) throw new Error("Request aborted");
      return value;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new GranolaApiError(
          timedOut
            ? "Granola API request timed out"
            : "Granola API request was cancelled",
          "timeout",
        );
      }
      if (err instanceof GranolaApiError) throw err;
      throw new GranolaApiError("Granola API request failed", "api_failed");
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = new Date(value).getTime();
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/** Validate the provider's RFC3339 date-time before normalizing it for ECHO. */
export function granolaNoteTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!) {
    return null;
  }
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    return null;
  }
  const offset = match[7]!;
  if (
    offset !== "Z" &&
    (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)
  ) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function metadataIdentity(note: GranolaNoteDetail): string {
  const metadata = { ...note };
  delete metadata.transcript;
  return JSON.stringify(metadata, (_key, value: unknown) =>
    isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
        )
      : value,
  );
}

function parseListResponse(
  value: unknown,
  pageSize: number,
  requestedCursor: string | undefined,
): GranolaListResponse {
  if (!isPlainObject(value)) {
    throw new GranolaApiError(
      "Granola list response was not an object",
      "pagination_failed",
    );
  }
  const notes = value["notes"];
  const hasMore = value["hasMore"];
  const cursor = value["cursor"];
  if (
    !Array.isArray(notes) ||
    notes.length > pageSize ||
    typeof hasMore !== "boolean"
  ) {
    throw new GranolaApiError(
      "Granola list response had invalid pagination fields",
      "pagination_failed",
    );
  }
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    throw new GranolaApiError(
      "Granola list cursor was invalid",
      "pagination_failed",
    );
  }
  if (hasMore && (!isNonEmptyString(cursor) || cursor === requestedCursor)) {
    throw new GranolaApiError(
      "Granola list continuation cursor was invalid",
      "pagination_failed",
    );
  }
  if (!hasMore && cursor !== null && cursor !== undefined) {
    throw new GranolaApiError(
      "Granola list terminal cursor was invalid",
      "pagination_failed",
    );
  }
  return {
    notes: notes.map((note: unknown) => parseListNote(note)),
    hasMore,
    cursor: cursor ?? null,
  };
}

function parseListNote(
  value: unknown,
  reason: GranolaApiErrorReason = "pagination_failed",
): GranolaListNote {
  if (!isPlainObject(value) || !isNonEmptyString(value["id"])) {
    throw new GranolaApiError(
      "Granola list note was missing id",
      reason,
    );
  }
  // Workspace keys return null for these fields. A non-null value means this
  // response cannot enter the organization-operated export-and-approval lane.
  for (const field of ["private_notes_text", "private_notes_markdown"]) {
    if (field in value && value[field] !== null) {
      throw new GranolaApiError(
        "Granola organization export contained private notes",
        reason,
      );
    }
  }
  const note: GranolaListNote = { id: value["id"] };
  const fields = note as unknown as Record<string, unknown>;
  copyStringFields(value, fields, ["object"], reason, false);
  copyStringFields(value, fields, ["title"], reason);
  for (const field of ["created_at", "updated_at"]) {
    if (!(field in value)) continue;
    if (granolaNoteTimestamp(value[field]) === null) {
      throw new GranolaApiError("Granola note timestamp was invalid", reason);
    }
    fields[field] = value[field];
  }
  if ("owner" in value) note.owner = value["owner"];
  const providerFields = unknownFields(value, [
    "id",
    "object",
    "title",
    "owner",
    "created_at",
    "updated_at",
  ]);
  if (providerFields !== undefined) note.provider_fields = providerFields;
  return note;
}

function parseNoteDetail(value: unknown, requestedId: string): GranolaNoteDetail {
  const base = parseListNote(value, "api_failed");
  if (!isPlainObject(value)) {
    throw new GranolaApiError(
      "Granola note detail was not an object",
      "api_failed",
    );
  }
  if (base.id !== requestedId) {
    throw new GranolaApiError(
      "Granola note id did not match the request",
      "api_failed",
    );
  }
  const detail: GranolaNoteDetail = { ...base };
  copyStringFields(
    value,
    detail as unknown as Record<string, unknown>,
    ["summary_markdown", "summary_text", "web_url"],
    "api_failed",
  );
  const transcript = value["transcript"];
  if (Array.isArray(transcript)) {
    detail.transcript = parseTranscriptItems(
      transcript,
      MAX_GRANOLA_TRANSCRIPT_ITEMS,
    );
  } else if (transcript === null) {
    detail.transcript = null;
  } else if (transcript !== undefined) {
    throw new GranolaApiError(
      "Granola note transcript was invalid",
      "api_failed",
    );
  }
  for (const key of [
    "attendees",
    "calendar_event",
    "folder_membership",
  ] as const) {
    if (key in value) detail[key] = value[key];
  }
  const providerFields = unknownFields(value, [
    "id",
    "object",
    "title",
    "owner",
    "created_at",
    "updated_at",
    "summary_markdown",
    "summary_text",
    "web_url",
    "transcript",
    "attendees",
    "calendar_event",
    "folder_membership",
  ]);
  if (providerFields === undefined) delete detail.provider_fields;
  else detail.provider_fields = providerFields;
  return detail;
}

function parseTranscriptItems(
  value: unknown,
  itemBound: number,
): GranolaTranscriptItem[] {
  if (!Array.isArray(value) || value.length > itemBound) {
    throw new GranolaApiError(
      "Granola transcript items were invalid or exceeded the item bound",
      "api_failed",
    );
  }
  return value.map((item: unknown) => {
    if (!isPlainObject(item)) {
      throw new GranolaApiError(
        "Granola transcript contained an invalid item",
        "api_failed",
      );
    }
    if (typeof item["text"] !== "string") {
      throw new GranolaApiError("Granola transcript text was invalid", "api_failed");
    }
    for (const field of ["start_time", "end_time", "start", "end"]) {
      if (!(field in item) || item[field] === null) continue;
      const timestamp = item[field];
      const seconds =
        typeof timestamp === "number"
          ? timestamp
          : typeof timestamp === "string" && /^\d+(?:\.\d+)?$/.test(timestamp)
            ? Number(timestamp)
            : undefined;
      const validOffset =
        seconds !== undefined &&
        seconds >= 0 &&
        Number.isSafeInteger(Math.round(seconds * 1_000));
      if (!validOffset && granolaNoteTimestamp(timestamp) === null) {
        throw new GranolaApiError(
          "Granola transcript timestamp was invalid",
          "api_failed",
        );
      }
    }
    return { ...item } as GranolaTranscriptItem;
  });
}

function parseTranscriptPage(value: unknown): {
  transcript: GranolaTranscriptItem[];
  hasMore: boolean;
  cursor: string | null;
} {
  if (!isPlainObject(value) || typeof value["hasMore"] !== "boolean") {
    throw new GranolaApiError("Granola transcript page was invalid", "pagination_failed");
  }
  const cursor = value["cursor"];
  const hasMore = value["hasMore"];
  if ((hasMore && !isNonEmptyString(cursor)) || (!hasMore && cursor !== null)) {
    throw new GranolaApiError(
      "Granola transcript pagination fields were invalid",
      "pagination_failed",
    );
  }
  return {
    transcript: parseTranscriptItems(value["transcript"], GRANOLA_TRANSCRIPT_PAGE_SIZE),
    hasMore,
    cursor: cursor as string | null,
  };
}

function unknownFields(
  value: Record<string, unknown>,
  knownFields: readonly string[],
): Record<string, unknown> | undefined {
  const known = new Set(knownFields);
  const fields = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  return Object.keys(fields).length === 0 ? undefined : fields;
}

function copyStringFields(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fields: readonly string[],
  reason: GranolaApiErrorReason,
  allowNull = true,
): void {
  for (const field of fields) {
    const value = from[field];
    if (typeof value === "string") {
      to[field] = value;
    } else if (value === null && allowNull) {
      to[field] = null;
    } else if (value !== undefined) {
      throw new GranolaApiError("Granola note string field was invalid", reason);
    }
  }
}
