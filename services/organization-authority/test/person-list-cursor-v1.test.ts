import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { PersonItemRefV1, PersonListScopeV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { describe, expect, it } from "vitest";
import { encodeProjectCursorV1, frameCursorV1 } from "../src/adapters/persistence/sqlite/project-context-cursor-v1.js";
import {
  decodePersonListCursorV1,
  decodePersonOpenCursorV1,
  decodePersonReviewsCursorV1,
  encodePersonListCursorV1,
  encodePersonOpenCursorV1,
  encodePersonReviewsCursorV1,
  type PersonListCursorBindingV1,
  type PersonListPositionsV1,
  type PersonOpenCursorBindingV1,
  type PersonOpenPositionV1,
  type PersonReviewsCursorBindingV1,
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
const IMPORTED = `cap_${"d".repeat(64)}`;
const SCOPES: readonly PersonListScopeV1[] = [
  { kind: "only_me" }, { kind: "project", project_id: PROJECT_A }, { kind: "project", project_id: PROJECT_B },
];
const list = (scope: PersonListScopeV1 = { kind: "only_me" }, changes: Partial<PersonListCursorBindingV1> = {}): PersonListCursorBindingV1 =>
  ({ scope, organization_id: ORGANIZATION, membership_id: MEMBERSHIP, ...changes });
const open = (ref: string, changes: Partial<PersonOpenCursorBindingV1> = {}): PersonOpenCursorBindingV1 =>
  ({ ref: ref as PersonItemRefV1, organization_id: ORGANIZATION, membership_id: MEMBERSHIP, ...changes });
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
      [`imported_meeting:${IMPORTED}`, { kind: "imported_meeting", offset: 1 }],
      [`imported_meeting:${IMPORTED}`, { kind: "imported_meeting", offset: 10_000_000 }],
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
    const projectCursor = encodeProjectCursorV1({ operation: "project_list_v2", status: "active", limit: 10, organization_id: ORGANIZATION, membership_id: MEMBERSHIP }, [TIME, PROJECT_A]);
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
    // One kind's position is never another kind's, and the retired transcript (ADR-0046) and meeting (2026-11-11) refs have none.
    refused(() => decodePersonOpenCursorV1(openCursor, open(`transcript:${MEETING}`)));
    refused(() => encodePersonOpenCursorV1(open(`document:${DOCUMENT}`), { kind: "imported_meeting", offset: 1 }));
    const meeting = open(`meeting:${MEETING}`);
    for (const fields of [["1", "1"], ["2"]]) refused(() => decodePersonOpenCursorV1(frameCursorV1(3, openDigest(meeting), fields), meeting));
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

  it("pages a note by offset, and refuses out-of-range open positions", () => {
    const note = open(`note:${NOTE}`);
    expect(decodePersonOpenCursorV1(encodePersonOpenCursorV1(note, { kind: "note", offset: 8192 }), note)).toEqual({ kind: "note", offset: 8192 });
    refused(() => encodePersonOpenCursorV1(note, { kind: "document", from_ordinal: 1 }));
    refused(() => decodePersonOpenCursorV1(frameCursorV1(3, openDigest(note), ["0"]), note));
    const document = open(`document:${DOCUMENT}`);
    const imported = open(`imported_meeting:${IMPORTED}`);
    for (const [binding, fields] of [
      [document, ["0"]], [document, ["65536"]], [document, ["01"]], [document, ["1", "1"]], [document, [""]],
      [imported, ["0"]], [imported, ["10000001"]], [imported, ["1e3"]],
    ] as const) {
      refused(() => decodePersonOpenCursorV1(frameCursorV1(3, openDigest(binding), fields), binding));
    }
  });

  it("decodes only positions: a time and an id the walk already emitted, never counts or other state", () => {
    const positions = decodePersonListCursorV1(encodePersonListCursorV1(list({ kind: "project", project_id: PROJECT_B }), {
      note: after(TIME, NOTE), document: { state: "done" }, meeting: { state: "start" },
    }), list({ kind: "project", project_id: PROJECT_B }));
    expect(positions).toEqual({ note: { state: "after", added_at: TIME, id: NOTE }, document: { state: "done" }, meeting: { state: "start" } });
    for (const position of Object.values(positions)) expect(Object.keys(position).every((key) => ["state", "added_at", "id"].includes(key))).toBe(true);
    const framed = Buffer.from(encodePersonListCursorV1(list(), WORST), "base64url");
    expect(framed.subarray(33).toString("utf8").split("\0")).toEqual([TIME, NOTE, TIME, DOCUMENT, TIME, MEETING]);
  });
});

describe("reviews list cursors", () => {
  const PRINCIPAL = "prn_33333333-3333-4333-8333-333333333333";
  const APPROVAL = `apr_${"e".repeat(64)}`;
  const reviewer = (changes: Partial<PersonReviewsCursorBindingV1> = {}): PersonReviewsCursorBindingV1 =>
    ({ organization_id: ORGANIZATION, principal_id: PRINCIPAL, membership_id: MEMBERSHIP, ...changes });
  /** The binding digest, restated so a change to what a reviews cursor binds fails here. */
  const reviewsDigest = (binding: PersonReviewsCursorBindingV1): Buffer => Buffer.from(canonicalSha256({
    schema_version: 1, kind: "echo-person-reviews-cursor-v1", operation: "reviews",
    organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id,
  }).slice(7), "hex");
  const frame = (fields: readonly string[]) => frameCursorV1(4, reviewsDigest(reviewer()), fields);

  it("round-trips a proposal's place in either part of the list, and carries nothing but that place", () => {
    for (const rank of [0, 1] as const) {
      const place = { rank, created_at: TIME, approval_id: APPROVAL };
      const cursor = encodePersonReviewsCursorV1(reviewer(), place);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
      expect(decodePersonReviewsCursorV1(cursor, reviewer())).toEqual(place);
    }
    const framed = Buffer.from(encodePersonReviewsCursorV1(reviewer(), { rank: 1, created_at: TIME, approval_id: APPROVAL }), "base64url");
    expect(framed.subarray(33).toString("utf8").split("\0")).toEqual(["1", TIME, APPROVAL]);
  });

  it("refuses a cursor replayed for another reviewer or under another list", () => {
    const cursor = encodePersonReviewsCursorV1(reviewer(), { rank: 0, created_at: TIME, approval_id: APPROVAL });
    refused(() => decodePersonReviewsCursorV1(cursor, reviewer({ membership_id: OTHER_MEMBERSHIP })));
    refused(() => decodePersonReviewsCursorV1(cursor, reviewer({ principal_id: "prn_44444444-4444-4444-8444-444444444444" })));
    refused(() => decodePersonReviewsCursorV1(cursor, reviewer({ organization_id: "org_other" })));
    refused(() => decodePersonReviewsCursorV1(encodePersonListCursorV1(list(), WORST), reviewer()));
    refused(() => decodePersonListCursorV1(cursor, list()));
    // The same place framed as the list's version under the reviews binding.
    refused(() => decodePersonReviewsCursorV1(frameCursorV1(2, reviewsDigest(reviewer()), ["0", TIME, APPROVAL]), reviewer()));
  });

  it("refuses a malformed place and anything that is not a cursor", () => {
    expect(decodePersonReviewsCursorV1(frame(["0", TIME, APPROVAL]), reviewer())).toEqual({ rank: 0, created_at: TIME, approval_id: APPROVAL });
    for (const fields of [
      ["2", TIME, APPROVAL], ["", TIME, APPROVAL], ["00", TIME, APPROVAL], ["0", "2026-09-21T21:30:00Z", APPROVAL], ["0", "", APPROVAL],
      ["0", TIME, APPROVAL.toUpperCase()], ["0", TIME, NOTE], ["0", TIME, ""], ["0", TIME], ["0", TIME, APPROVAL, ""],
    ]) refused(() => decodePersonReviewsCursorV1(frame(fields), reviewer()));
    const cursor = frame(["0", TIME, APPROVAL]);
    for (const garbage of ["", "not a cursor", "AAAA", `${cursor}=`, cursor.slice(0, -1)]) refused(() => decodePersonReviewsCursorV1(garbage, reviewer()));
    refused(() => encodePersonReviewsCursorV1(reviewer(), { rank: 0, created_at: "2026-09-21", approval_id: APPROVAL }));
    refused(() => encodePersonReviewsCursorV1(reviewer(), { rank: 0, created_at: TIME, approval_id: NOTE }));
  });
});
