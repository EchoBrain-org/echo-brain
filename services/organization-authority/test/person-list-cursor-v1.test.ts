import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { PersonAnswerScopeV3, PersonOpenRefV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { describe, expect, it } from "vitest";
import { encodeProjectCursorV1, frameCursorV1 } from "../src/adapters/persistence/sqlite/project-context-cursor-v1.js";
import {
  decodePersonListCursorV1,
  decodePersonOpenCursorV1,
  encodePersonListCursorV1,
  encodePersonOpenCursorV1,
  type PersonListCursorBindingV1,
  type PersonListPositionsV1,
  type PersonOpenCursorBindingV1,
  type PersonOpenPositionV1,
} from "../src/composition/person-list-cursor-v1.js";

const ORGANIZATION = "org_person_list";
const MEMBERSHIP = "mem_11111111-1111-4111-8111-111111111111";
const OTHER_MEMBERSHIP = "mem_22222222-2222-4222-8222-222222222222";
const PROJECT_A = "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "prj_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIME = "2026-09-21T21:30:00.000Z";
const NOTE = `ctx_${"a".repeat(64)}`;
const DOCUMENT = `doc_${"b".repeat(64)}`;
const MEETING = `sha256:${"c".repeat(64)}`;
const SCOPES: readonly PersonAnswerScopeV3[] = [
  { kind: "global" }, { kind: "mine" }, { kind: "project", project_id: PROJECT_A }, { kind: "project", project_id: PROJECT_B },
];
const list = (scope: PersonAnswerScopeV3 = { kind: "global" }, changes: Partial<PersonListCursorBindingV1> = {}): PersonListCursorBindingV1 =>
  ({ scope, organization_id: ORGANIZATION, membership_id: MEMBERSHIP, ...changes });
const open = (ref: string, changes: Partial<PersonOpenCursorBindingV1> = {}): PersonOpenCursorBindingV1 =>
  ({ ref: ref as PersonOpenRefV1, organization_id: ORGANIZATION, membership_id: MEMBERSHIP, ...changes });
const after = (added_at: string, id: string) => ({ state: "after", added_at, id }) as const;
const WORST: PersonListPositionsV1 = {
  note: after(TIME, NOTE), document: after(TIME, DOCUMENT), meeting: after(TIME, MEETING),
};

/** The binding digests, restated so a change to what a cursor binds fails here. */
function listDigest(binding: PersonListCursorBindingV1): Buffer {
  return Buffer.from(canonicalSha256({
    schema_version: 1, kind: "echo-person-list-cursor-v1", operation: "person_list", scope: binding.scope, page_size: 25,
    organization_id: binding.organization_id, membership_id: binding.membership_id,
  }).slice(7), "hex");
}
function openDigest(binding: PersonOpenCursorBindingV1): Buffer {
  return Buffer.from(canonicalSha256({
    schema_version: 1, kind: "echo-person-open-cursor-v1", operation: "person_open", ref: binding.ref,
    organization_id: binding.organization_id, membership_id: binding.membership_id,
  }).slice(7), "hex");
}

function refused(operation: () => unknown): void {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AuthorityOperationError);
  expect(caught).toMatchObject({ code: "invalid_request", message: "request failed" });
}

describe("person list and open cursors", () => {
  it("round-trips every list state within the 512-character bound", () => {
    const states = [{ state: "start" }, { state: "done" }] as const;
    for (const note of [...states, after(TIME, NOTE)]) {
      for (const document of [...states, after(TIME, DOCUMENT)]) {
        for (const meeting of [...states, after(TIME, MEETING)]) {
          const positions = { note, document, meeting } as PersonListPositionsV1;
          if (note.state === "done" && document.state === "done" && meeting.state === "done") continue;
          for (const scope of SCOPES) {
            const cursor = encodePersonListCursorV1(list(scope), positions);
            expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
            expect(decodePersonListCursorV1(cursor, list(scope))).toEqual(positions);
          }
        }
      }
    }
    const worst = encodePersonListCursorV1(list({ kind: "project", project_id: PROJECT_A }), WORST);
    expect(worst.length).toBe(423);
  });

  it("round-trips every open position on its own ref", () => {
    const cases: readonly [string, PersonOpenPositionV1][] = [
      [`document:${DOCUMENT}`, { kind: "document", from_ordinal: 1 }],
      [`document:${DOCUMENT}`, { kind: "document", from_ordinal: 65_535 }],
      [`meeting:${MEETING}`, { kind: "meeting", atom_order: 0, part: 1 }],
      [`meeting:${MEETING}`, { kind: "meeting", atom_order: 65_535, part: 65_535 }],
      [`transcript:${MEETING}`, { kind: "transcript", offset: 1 }],
      [`transcript:${MEETING}`, { kind: "transcript", offset: 10_000_000 }],
    ];
    for (const [ref, position] of cases) {
      const cursor = encodePersonOpenCursorV1(open(ref), position);
      expect(decodePersonOpenCursorV1(cursor, open(ref))).toEqual(position);
    }
  });

  it("refuses a list cursor replayed under another scope, membership or organization", () => {
    for (const scope of SCOPES) {
      const cursor = encodePersonListCursorV1(list(scope), WORST);
      for (const other of SCOPES.filter((candidate) => candidate !== scope)) refused(() => decodePersonListCursorV1(cursor, list(other)));
      refused(() => decodePersonListCursorV1(cursor, list(scope, { membership_id: OTHER_MEMBERSHIP })));
      refused(() => decodePersonListCursorV1(cursor, list(scope, { organization_id: "org_other" })));
    }
  });

  it("refuses a cursor from another operation, version or ref", () => {
    const projectCursor = encodeProjectCursorV1({ operation: "feed_v2", project_id: PROJECT_A, limit: 25, organization_id: ORGANIZATION, membership_id: MEMBERSHIP }, [TIME, NOTE]);
    refused(() => decodePersonListCursorV1(projectCursor, list({ kind: "project", project_id: PROJECT_A })));
    // The same fields framed as version 1 under the list binding.
    refused(() => decodePersonListCursorV1(frameCursorV1(1, listDigest(list()), ["", "", "", "", "", ""]), list()));
    const listCursor = encodePersonListCursorV1(list(), WORST);
    refused(() => decodePersonOpenCursorV1(listCursor, open(`document:${DOCUMENT}`)));
    const openCursor = encodePersonOpenCursorV1(open(`document:${DOCUMENT}`), { kind: "document", from_ordinal: 2 });
    refused(() => decodePersonListCursorV1(openCursor, list()));
    refused(() => decodePersonOpenCursorV1(openCursor, open(`document:doc_${"d".repeat(64)}`)));
    refused(() => decodePersonOpenCursorV1(openCursor, open(`document:${DOCUMENT}`, { membership_id: OTHER_MEMBERSHIP })));
    refused(() => decodePersonOpenCursorV1(openCursor, open(`document:${DOCUMENT}`, { organization_id: "org_other" })));
    // A meeting's transcript is another ref than the meeting.
    const meetingCursor = encodePersonOpenCursorV1(open(`meeting:${MEETING}`), { kind: "meeting", atom_order: 1, part: 1 });
    refused(() => decodePersonOpenCursorV1(meetingCursor, open(`transcript:${MEETING}`)));
    refused(() => encodePersonOpenCursorV1(open(`meeting:${MEETING}`), { kind: "transcript", offset: 1 }));
  });

  it("refuses malformed list fields, a finished walk and a non-canonical time", () => {
    const frame = (fields: readonly string[]) => frameCursorV1(2, listDigest(list()), fields);
    const valid = [TIME, NOTE, TIME, DOCUMENT, TIME, MEETING];
    expect(decodePersonListCursorV1(frame(valid), list())).toEqual(WORST);
    refused(() => decodePersonListCursorV1(frame(valid.slice(0, 5)), list()));
    refused(() => decodePersonListCursorV1(frame([...valid, ""]), list()));
    refused(() => decodePersonListCursorV1(frame(["~", "", "~", "", "~", ""]), list()));
    refused(() => encodePersonListCursorV1(list(), { note: { state: "done" }, document: { state: "done" }, meeting: { state: "done" } }));
    // Each source's id grammar, in every other source's slot.
    refused(() => decodePersonListCursorV1(frame([TIME, DOCUMENT, TIME, DOCUMENT, TIME, MEETING]), list()));
    refused(() => decodePersonListCursorV1(frame([TIME, NOTE, TIME, MEETING, TIME, MEETING]), list()));
    refused(() => decodePersonListCursorV1(frame([TIME, NOTE, TIME, DOCUMENT, TIME, NOTE]), list()));
    refused(() => decodePersonListCursorV1(frame([TIME, NOTE.toUpperCase(), TIME, DOCUMENT, TIME, MEETING]), list()));
    for (const time of ["2026-09-21T21:30:00Z", "2026-09-21T21:30:00.000+00:00", "2026-02-30T00:00:00.000Z", "~x"]) {
      refused(() => decodePersonListCursorV1(frame([time, NOTE, TIME, DOCUMENT, TIME, MEETING]), list()));
    }
    refused(() => decodePersonListCursorV1(frame(["", NOTE, TIME, DOCUMENT, TIME, MEETING]), list()));
    refused(() => decodePersonListCursorV1(frame(["~", NOTE, TIME, DOCUMENT, TIME, MEETING]), list()));
    refused(() => decodePersonListCursorV1(`${encodePersonListCursorV1(list(), WORST)}=`, list()));
  });

  it("refuses a note cursor and out-of-range open positions", () => {
    const note = open(`note:${NOTE}`);
    refused(() => decodePersonOpenCursorV1(frameCursorV1(3, openDigest(note), ["1"]), note));
    refused(() => encodePersonOpenCursorV1(note, { kind: "document", from_ordinal: 1 }));
    const document = open(`document:${DOCUMENT}`);
    const meeting = open(`meeting:${MEETING}`);
    const transcript = open(`transcript:${MEETING}`);
    for (const [binding, fields] of [
      [document, ["0"]], [document, ["65536"]], [document, ["01"]], [document, ["1", "1"]], [document, [""]],
      [meeting, ["0", "0"]], [meeting, ["65536", "1"]], [meeting, ["0"]], [meeting, ["-1", "1"]],
      [transcript, ["0"]], [transcript, ["10000001"]], [transcript, ["1e3"]],
    ] as const) {
      refused(() => decodePersonOpenCursorV1(frameCursorV1(3, openDigest(binding), fields), binding));
    }
    expect(decodePersonOpenCursorV1(frameCursorV1(3, openDigest(meeting), ["3", "2"]), meeting)).toEqual({ kind: "meeting", atom_order: 3, part: 2 });
  });

  it("decodes only positions: a time and an id the walk already emitted, never counts or other state", () => {
    const positions = decodePersonListCursorV1(encodePersonListCursorV1(list({ kind: "mine" }), {
      note: after(TIME, NOTE), document: { state: "done" }, meeting: { state: "start" },
    }), list({ kind: "mine" }));
    expect(positions).toEqual({ note: { state: "after", added_at: TIME, id: NOTE }, document: { state: "done" }, meeting: { state: "start" } });
    for (const position of Object.values(positions)) expect(Object.keys(position).every((key) => ["state", "added_at", "id"].includes(key))).toBe(true);
    const framed = Buffer.from(encodePersonListCursorV1(list(), WORST), "base64url");
    expect(framed.subarray(33).toString("utf8").split("\0")).toEqual([TIME, NOTE, TIME, DOCUMENT, TIME, MEETING]);
  });
});
