import type { AdmittedMeetingSourceCursorPolicyV1 } from "../../../processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1.js";
import { SYNTHETIC_DEMO_INITIAL_CURSOR_V1 } from "../../../processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";

const CURSOR_PREFIX = SYNTHETIC_DEMO_INITIAL_CURSOR_V1.slice(0, -1);
const CURSOR_OFFSETS = new Set(["0", "1", "2", "3", "4"]);

/** Cursor contract for the fixed, offset-addressed synthetic-demo corpus. */
export const syntheticDemoAdmittedMeetingSourceCursorPolicyV1: AdmittedMeetingSourceCursorPolicyV1 =
  Object.freeze({
    source_adapter_id: "synthetic-demo-source",
    assert_live_cursor(cursor: string): void {
      if (
        !cursor.startsWith(CURSOR_PREFIX) ||
        !CURSOR_OFFSETS.has(cursor.slice(CURSOR_PREFIX.length))
      ) {
        throw new Error(
          "admitted meeting-processing cursor must be a synthetic-demo source cursor",
        );
      }
    },
  });
