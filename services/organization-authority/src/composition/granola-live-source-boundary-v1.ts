import { granolaCursorPhase } from "../processing/adapters/meeting-sources/granola/index.js";
import type { CleanLiveSourceBoundaryV1 } from "../processing/clean-v1/live-source-boundary.js";

/** Granola's V1 cursor and source-metadata compatibility boundary. */
export const granolaLiveSourceBoundaryV1: CleanLiveSourceBoundaryV1 =
  Object.freeze({
    source_adapter_id: "granola",
    assert_live_cursor(cursor: string): void {
      if (
        !cursor.startsWith("granola:v1:") ||
        granolaCursorPhase(cursor) !== "live"
      ) {
        throw new Error(
          "clean live-only source cursor must be a Granola v1 live cursor",
        );
      }
    },
  });
