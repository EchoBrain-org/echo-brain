export const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";
export const DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS = 15_000;
// Granola caps page_size at 30; values above 30 return HTTP 400.
export const DEFAULT_GRANOLA_PAGE_SIZE = 30;
export const GRANOLA_API_KEY_RE = /^grn_[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
    return parseListResponse(await this.fetchJson(url, options.signal));
  }

  async getNote(
    noteId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GranolaNoteDetail> {
    const url = this.url(`/notes/${encodeURIComponent(noteId)}`);
    url.searchParams.set("include", "transcript");
    return parseNoteDetail(await this.fetchJson(url, options.signal));
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
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted === true) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.requestTimeoutMs ?? DEFAULT_GRANOLA_REQUEST_TIMEOUT_MS);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
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
      return await response.json();
    } catch (err) {
      if (err instanceof GranolaApiError) throw err;
      if (controller.signal.aborted) {
        throw new GranolaApiError(
          timedOut
            ? "Granola API request timed out"
            : "Granola API request was cancelled",
          "timeout",
        );
      }
      throw new GranolaApiError((err as Error).message, "api_failed");
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
  return typeof value === "string" && value.length > 0;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = new Date(value).getTime();
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function parseListResponse(value: unknown): GranolaListResponse {
  if (!isPlainObject(value)) {
    throw new GranolaApiError(
      "Granola list response was not an object",
      "pagination_failed",
    );
  }
  const notes = value["notes"];
  const hasMore = value["hasMore"];
  const cursor = value["cursor"];
  if (!Array.isArray(notes) || typeof hasMore !== "boolean") {
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
  return {
    notes: notes.map(parseListNote),
    hasMore,
    cursor: cursor ?? null,
  };
}

function parseListNote(value: unknown): GranolaListNote {
  if (!isPlainObject(value) || !isNonEmptyString(value["id"])) {
    throw new GranolaApiError(
      "Granola list note was missing id",
      "pagination_failed",
    );
  }
  const note: GranolaListNote = { id: value["id"] };
  copyStringFields(value, note as unknown as Record<string, unknown>, [
    "object",
    "title",
    "created_at",
    "updated_at",
  ]);
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

function parseNoteDetail(value: unknown): GranolaNoteDetail {
  const base = parseListNote(value);
  if (!isPlainObject(value)) {
    throw new GranolaApiError(
      "Granola note detail was not an object",
      "api_failed",
    );
  }
  const detail: GranolaNoteDetail = { ...base };
  copyStringFields(value, detail as unknown as Record<string, unknown>, [
    "summary_markdown",
    "summary_text",
    "web_url",
  ]);
  const transcript = value["transcript"];
  if (Array.isArray(transcript)) {
    if (!transcript.every(isPlainObject)) {
      throw new GranolaApiError(
        "Granola note transcript contained an invalid item",
        "api_failed",
      );
    }
    detail.transcript = transcript.map(
      (item) => ({ ...item }) as GranolaTranscriptItem,
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
): void {
  for (const field of fields) {
    const value = from[field];
    if (typeof value === "string") {
      to[field] = value;
    } else if (value === null) {
      to[field] = null;
    }
  }
}
