import type { Sha256Digest } from "@echo-brain/federation-protocol";

/**
 * Live Slack reads for one Ask request (RFC-0003). An implementation is bound
 * to the asking Person's own Slack user token before the desk is created; no
 * method takes, returns or logs a token. Nothing read here is persisted:
 * callers keep messages in request memory only.
 */
export type PersonSlackChannelKindV1 = "public_channel" | "private_channel" | "im" | "mpim";

export interface PersonSlackMessageV1 {
  readonly team_id: string;
  readonly channel_id: string;
  /** Display name without "#", e.g. "hw-dvt"; for a DM, the other person's name. */
  readonly channel_name: string;
  readonly channel_kind: PersonSlackChannelKindV1;
  readonly message_ts: string;
  /** Present when the message is in a thread (equal to message_ts for the parent). */
  readonly thread_ts?: string;
  readonly author: string;
  readonly text: string;
  readonly permalink: string;
  readonly reply_count?: number;
}

export interface PersonSlackReaderV1 {
  /** Keyword search over everything the asker can see (Real-time Search API). */
  search(input: { readonly query: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<readonly PersonSlackMessageV1[]>;
  /** A thread, parent first, then replies in order. */
  thread(input: { readonly channel_id: string; readonly thread_ts: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<{ readonly messages: readonly PersonSlackMessageV1[]; readonly truncated: boolean }>;
  /** Channel history by channel name, newest first. `found` is false when the asker cannot see a channel by that name. */
  history(input: { readonly channel: string; readonly oldest?: string; readonly latest?: string; readonly limit: number; readonly cursor?: string; readonly signal?: AbortSignal }): Promise<{ readonly found: boolean; readonly messages: readonly PersonSlackMessageV1[]; readonly next_cursor?: string }>;
  /** Throws when the asker's Slack connection is no longer usable (revoked, disconnected). */
  check(input: { readonly signal?: AbortSignal }): Promise<void>;
}

/** One audited Slack release. The audit keeps coordinates and digests, never text. */
export interface PersonSlackReleaseV1 {
  readonly operation: "search" | "thread" | "history";
  readonly messages: readonly {
    readonly team_id: string;
    readonly channel_id: string;
    readonly message_ts: string;
    readonly permalink: string;
    readonly text_sha256: Sha256Digest;
  }[];
}

/** Commits a release audit before any Slack bytes leave the desk; returns its receipt digest. */
export interface PersonSlackReleaseAuditV1 {
  record(release: PersonSlackReleaseV1): Sha256Digest;
}
