import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  AdapterError,
  assertCanonicalMeetingDocument,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterHealth,
  type AdapterOperationContext,
  type MeetingBatch,
  type MeetingDocument,
  type MeetingPullRequest,
  type MeetingSourceAdapter,
} from "../../../core/index.js";

export const syntheticDemoMeetingSourceIdentityV1 = Object.freeze({
  kind: "meeting-source" as const,
  adapter_id: "synthetic-demo-source",
  instance_id: "customer-demo",
  version: "1.0.0",
});

const SYNTHETIC_DEMO_CURSOR_PREFIX =
  "synthetic-demo-source:customer-demo:1.0.0:v1:";
export const SYNTHETIC_DEMO_INITIAL_CURSOR_V1 =
  `${SYNTHETIC_DEMO_CURSOR_PREFIX}0`;
const SYNTHETIC_DEMO_MEETING_COUNT = 4;

export interface SyntheticDemoMeetingCorpusV1 {
  readonly meetings: readonly MeetingDocument[];
  /** SHA-256 over filename-ordered, canonical meeting documents. */
  readonly corpus_digest: Sha256Digest;
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(SYNTHETIC_DEMO_CURSOR_PREFIX)) {
    throw new AdapterError("invalid_config", "synthetic-demo cursor is invalid", false);
  }
  const encodedOffset = cursor.slice(SYNTHETIC_DEMO_CURSOR_PREFIX.length);
  if (!/^[0-4]$/.test(encodedOffset)) {
    throw new AdapterError("invalid_config", "synthetic-demo cursor is invalid", false);
  }
  return Number(encodedOffset);
}

/**
 * Loads the declared four-meeting demo corpus. The file name is part of the
 * digest so the source's cursor order and admission commitment stay aligned.
 */
export async function loadSyntheticDemoMeetingCorpusV1(
  meetingsDirectory: string,
): Promise<SyntheticDemoMeetingCorpusV1> {
  const entries = await readdir(meetingsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length !== SYNTHETIC_DEMO_MEETING_COUNT) {
    throw new Error("synthetic-demo corpus must contain four meeting JSON files");
  }

  const meetings = await Promise.all(
    filenames.map(async (filename) => {
      const parsed: unknown = JSON.parse(
        await readFile(join(meetingsDirectory, filename), "utf8"),
      );
      assertCanonicalMeetingDocument(parsed, syntheticDemoMeetingSourceIdentityV1);
      return parsed;
    }),
  );
  return Object.freeze({
    meetings: Object.freeze(meetings),
    corpus_digest: canonicalSha256(
      filenames.map((filename, index) => ({ filename, meeting: meetings[index] })),
    ),
  });
}

/** File-backed source for the fixed synthetic customer-demo corpus. */
export class SyntheticDemoMeetingSourceAdapterV1
  implements MeetingSourceAdapter
{
  readonly identity = syntheticDemoMeetingSourceIdentityV1;

  constructor(private readonly corpus: SyntheticDemoMeetingCorpusV1) {}

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    const matches =
      config.adapter_id === this.identity.adapter_id &&
      config.instance_id === this.identity.instance_id;
    return matches
      ? { ok: true, errors: [] }
      : {
          ok: false,
          errors: ["adapter_id and instance_id must identify the synthetic-demo source"],
        };
  }

  async healthCheck(_context?: AdapterOperationContext): Promise<AdapterHealth> {
    return {
      status: "healthy",
      checked_at: new Date().toISOString(),
      message: "local synthetic-demo meeting corpus",
      details: { corpus_digest: this.corpus.corpus_digest },
    };
  }

  async pull(request: MeetingPullRequest): Promise<MeetingBatch> {
    const offset = decodeOffset(request.cursor);
    if (offset > this.corpus.meetings.length) {
      throw new AdapterError(
        "invalid_config",
        "synthetic-demo cursor is beyond the corpus",
        false,
      );
    }
    const limit = request.limit ?? this.corpus.meetings.length;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AdapterError(
        "invalid_config",
        "synthetic-demo pull limit must be a positive integer",
        false,
      );
    }

    const end = Math.min(this.corpus.meetings.length, offset + limit);
    const meetings = this.corpus.meetings.slice(offset, end);
    if (meetings.length === 0) return { meetings };
    return {
      meetings,
      next_cursor: `${SYNTHETIC_DEMO_CURSOR_PREFIX}${end}`,
    };
  }
}
