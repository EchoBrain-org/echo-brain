import { granolaCursorPhase } from "../processing/adapters/meeting-sources/granola/index.js";
import type { AdmittedMeetingSourceBoundaryV1 } from "../processing/admitted-meeting-processing/admitted-meeting-source-boundary-v1.js";

/** Granola's V1 cursor and source-metadata compatibility boundary. */
export const granolaAdmittedMeetingSourceBoundaryV1: AdmittedMeetingSourceBoundaryV1 =
  Object.freeze({
    source_adapter_id: "granola",
    assert_live_cursor(cursor: string): void {
      if (
        !cursor.startsWith("granola:v1:") ||
        granolaCursorPhase(cursor) !== "live"
      ) {
        throw new Error(
          "admitted meeting-processing cursor must be a Granola v1 live cursor",
        );
      }
    },
  });
