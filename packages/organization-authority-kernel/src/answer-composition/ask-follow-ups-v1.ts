import { canonicalSha256 } from "@echo-brain/federation-protocol";

/**
 * Follow-ups an Ask answer drafts (ADR-0053). The Ask writer may return
 * follow-ups beside its answer; code checks each one and, once the answer is
 * released, saves it unsent in the asker's own list. Research stays read
 * only: nothing here is a research tool, and nothing is saved for an answer
 * that was not released.
 */

/**
 * The kinds of item a drafted follow-up may be about: those an open item's live read can open. The one list for the
 * renderer that checks a draft and the sink that saves it; the Authority baseline's insert trigger names the same kinds
 * as the database's own guard.
 */
export const ASK_FOLLOW_UP_ABOUT_KINDS_V1: readonly string[] = Object.freeze(["ticket", "page", "approved_record", "source_revision"]);

/** One follow-up the writer drafted, as code keeps it after its checks. */
export interface AskFollowUpDraftV1 {
  /** Its open-item id (`askFollowUpItemIdV1`): fixed by the request and the draft's place, so saving it twice writes it once. */
  readonly item_id: string;
  /** What needs doing: one line of at most 120 characters, with no title of an item read from outside ECHO. */
  readonly task: string;
  /** The owner's name as the writer gave it. The sink gives the follow-up to the one active member with that name, else leaves it unowned with the asker. */
  readonly owner_name?: string;
  /** A calendar day, YYYY-MM-DD. */
  readonly due_on?: string;
  /**
   * The stored pointer of the one item it is about: a ticket, a page, an ECHO record or an ECHO document the writer was
   * shown. Without one the follow-up stands alone, on a `chat_action` pointer of its own.
   */
  readonly about?: Readonly<Record<string, unknown>>;
}

/** Where a released answer's follow-ups are saved, bound to the asker for one request. */
export interface AskFollowUpSinkV1 {
  /** Saves each draft as the asker's own unsent follow-up, in one transaction. A draft whose id already exists is left as it is. */
  save(drafts: readonly AskFollowUpDraftV1[]): void;
}

/** The open-item id of an answer's `ordinal`th follow-up (from 0): `itm_` and 32 hex characters, the same for a repeated save of one request. */
export function askFollowUpItemIdV1(requestId: string, ordinal: number): string {
  if (requestId.length === 0 || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("An Ask follow-up id needs its request and its place");
  return `itm_${canonicalSha256(["ask_follow_up", requestId, ordinal]).slice("sha256:".length, "sha256:".length + 32)}`;
}

/** A follow-up that stands alone points at itself: its own open-item id. */
export function askFollowUpPointerV1(itemId: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ kind: "chat_action", id: itemId });
}
