import { Buffer } from "node:buffer";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  buildPersonCallerBindingV2,
  buildPersonRequestCommitmentV2,
} from "../src/application/person-read-contracts-v2.js";
import {
  PERSON_RELEASE_BINDING_KIND,
  buildPersonReleaseBindingV2,
  personReleaseBindingSha256V2,
  validatePersonReleaseBindingV2,
} from "../src/application/person-read-release-contracts-v2.js";
import type {
  BuildPersonReleaseBindingV2Input,
  PersonRetrievalReleaseItemV2,
} from "../src/application/person-read-release-contracts-v2.js";
import { buildPersonScopeBindingV2 } from "../src/application/person-read-scope-contracts-v2.js";

const IDS = {
  authority: "oau_00000000-0000-4000-8000-000000000001",
  organization: "org_00000000-0000-4000-8000-000000000002",
  principal: "prn_00000000-0000-4000-8000-000000000003",
  membership: "mem_00000000-0000-4000-8000-000000000004",
  identityBinding: "oib_00000000-0000-4000-8000-000000000005",
  sessionFamily: "psf_00000000-0000-4000-8000-000000000006",
} as const;

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function caller(personState = digest("b")) {
  return buildPersonCallerBindingV2({
    boundary: {
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      state_lineage_id: "state-lineage-1",
    },
    current_caller: {
      organization_id: IDS.organization,
      principal_id: IDS.principal,
      membership_id: IDS.membership,
      membership_type: "employee",
      identity_binding_id: IDS.identityBinding,
      session_family_id: IDS.sessionFamily,
      access_credential_sha256: digest("a"),
      person_state_sha256: personState,
      session_state_sha256: digest("c"),
    },
  });
}

function reviewerRequest() {
  return buildPersonRequestCommitmentV2({
    operation: "reviewer_recent_decisions",
    input: {},
  });
}

function readableRequest(query = "Launch pricing") {
  return buildPersonRequestCommitmentV2({
    operation: "readable_search",
    input: { query },
  });
}

function listRequest() {
  return buildPersonRequestCommitmentV2({
    operation: "list_member_exclusions",
    input: {
      source_adapter_id: "granola",
      source_instance_id: "workspace-1",
    },
  });
}

function changeRequest() {
  return buildPersonRequestCommitmentV2({
    operation: "change_member_exclusion",
    input: {
      excluded: true,
      selector: {
        scope: "meeting",
        source_adapter_id: "granola",
        source_instance_id: "workspace-1",
        external_id: "meeting/01",
      },
    },
  });
}

const MEMBER_SEGMENT = {
  policy_id: "organization-member-readable-person-v2",
  segment_id: digest("6"),
  segment_manifest_sha256: digest("7"),
} as const;
const REVIEWER_SEGMENT = {
  policy_id: "restricted-reviewer-person-v2",
  segment_id: digest("8"),
  segment_manifest_sha256: digest("9"),
} as const;

function reviewerItem(seed = "1"): PersonRetrievalReleaseItemV2 {
  return {
    atom_id: digest(seed),
    record_hash: digest("2"),
    policy_id: "restricted-reviewer-person-v2",
    content_binding_sha256: digest("3"),
    provenance_binding_sha256: digest("4"),
  };
}

function memberItem(seed = "5"): PersonRetrievalReleaseItemV2 {
  return {
    atom_id: digest(seed),
    record_hash: digest("6"),
    policy_id: "organization-member-readable-person-v2",
    content_binding_sha256: digest("7"),
    provenance_binding_sha256: digest("8"),
  };
}

function reviewerContext(
  returnedItems: readonly PersonRetrievalReleaseItemV2[] = [reviewerItem()],
  response: Uint8Array = Buffer.from('{"items":[{"decision":"ship"}]}'),
): BuildPersonReleaseBindingV2Input {
  const request = reviewerRequest();
  const currentCaller = caller();
  const scope = buildPersonScopeBindingV2({
    request,
    caller: currentCaller,
    scope: {
      scope_kind: "reviewer_log",
      record_head: { position: 7, record_hash: digest("9") },
    },
  }).body;
  return {
    request,
    caller: currentCaller,
    scope,
    serialized_response_bytes: response,
    result: { result_kind: "retrieval", returned_items: returnedItems },
  };
}

function readableContext(
  returnedItems: readonly PersonRetrievalReleaseItemV2[] = [
    memberItem(),
    reviewerItem("a"),
  ],
  admittedSegments: readonly (
    typeof MEMBER_SEGMENT | typeof REVIEWER_SEGMENT
  )[] = [MEMBER_SEGMENT, REVIEWER_SEGMENT],
): BuildPersonReleaseBindingV2Input {
  const request = readableRequest();
  const currentCaller = caller();
  const scope = buildPersonScopeBindingV2({
    request,
    caller: currentCaller,
    scope: {
      scope_kind: "readable_search",
      retrieval_contract_sha256: digest("2"),
      generation: {
        generation_id: digest("3"),
        manifest_sha256: digest("4"),
      },
      record_head: { position: 5, record_hash: digest("5") },
      admitted_segments: admittedSegments,
    },
  }).body;
  return {
    request,
    caller: currentCaller,
    scope,
    serialized_response_bytes: Buffer.from(
      '{"items":[{"text":"member"},{"text":"reviewer"}]}',
    ),
    result: { result_kind: "retrieval", returned_items: returnedItems },
  };
}

function authorityContext(
  operation: "list" | "change" = "list",
): BuildPersonReleaseBindingV2Input {
  const request = operation === "list" ? listRequest() : changeRequest();
  const currentCaller = caller();
  const scope = buildPersonScopeBindingV2({
    request,
    caller: currentCaller,
    scope: {
      scope_kind: "authority_state",
      source_activation_binding_sha256: digest("d"),
      owned_resource_sha256: digest("e"),
      exclusion_state_sha256: digest("f"),
    },
  }).body;
  return {
    request,
    caller: currentCaller,
    scope,
    serialized_response_bytes: Buffer.from('{"items":[]}'),
    result: { result_kind: "authority_state" },
  };
}

describe("private D6-2B Person release commitments", () => {
  it("freezes the exact reviewer retrieval body and golden digest", () => {
    const context = reviewerContext();
    const built = buildPersonReleaseBindingV2(context);

    expect(Object.keys(built.body)).toEqual([
      "schema_version",
      "kind",
      "caller_binding_sha256",
      "scope_binding_sha256",
      "serialized_response_sha256",
      "result_kind",
      "returned_items",
    ]);
    expect(built.body).toMatchObject({
      schema_version: 2,
      kind: PERSON_RELEASE_BINDING_KIND,
      serialized_response_sha256: sha256Digest(
        Buffer.from('{"items":[{"decision":"ship"}]}'),
      ),
      result_kind: "retrieval",
      returned_items: [reviewerItem()],
    });
    if (built.body.result_kind !== "retrieval") throw new Error("unreachable");
    expect(Object.keys(built.body.returned_items[0]!)).toEqual([
      "atom_id",
      "record_hash",
      "policy_id",
      "content_binding_sha256",
      "provenance_binding_sha256",
    ]);
    expect(built.release_binding_sha256).toBe(
      "sha256:44c16c39a2205bc72d877d8aa302a4d13cf5c9471f778d6361b527946ea2f7e6",
    );
    expect(personReleaseBindingSha256V2(built.body, context)).toBe(
      built.release_binding_sha256,
    );
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.keys(built)).toEqual([
      "body",
      "release_binding_sha256",
      "response_snapshot",
    ]);
    expect(Object.isFrozen(built.body)).toBe(true);
    expect(Object.isFrozen(built.body.returned_items)).toBe(true);
    expect(Object.isFrozen(built.body.returned_items[0])).toBe(true);
    expect(Object.isFrozen(built.response_snapshot)).toBe(true);
    expect(canonicalJson(built.body)).not.toContain("decision");
    expect(canonicalJson(built.body)).not.toContain("record_head");
  });

  it("freezes readable-search ordering and all five opaque tuple fields", () => {
    const context = readableContext();
    const built = buildPersonReleaseBindingV2(context);
    expect(built.body.result_kind).toBe("retrieval");
    if (built.body.result_kind !== "retrieval") throw new Error("unreachable");
    const returnedItems = built.body.returned_items;
    expect(returnedItems.map((item) => item.policy_id)).toEqual([
      "organization-member-readable-person-v2",
      "restricted-reviewer-person-v2",
    ]);
    expect(built.release_binding_sha256).toBe(
      "sha256:acf2f600985343cdad1a473dff2fc6fd1556860b8adcedb53afb6bb7a4525d6d",
    );

    const reversed = buildPersonReleaseBindingV2(
      readableContext([reviewerItem("a"), memberItem()]),
    );
    expect(reversed.release_binding_sha256).not.toBe(
      built.release_binding_sha256,
    );

    const base = memberItem();
    const mutations: readonly PersonRetrievalReleaseItemV2[] = [
      { ...base, atom_id: digest("a") },
      { ...base, record_hash: digest("a") },
      { ...base, policy_id: "restricted-reviewer-person-v2" },
      { ...base, content_binding_sha256: digest("a") },
      { ...base, provenance_binding_sha256: digest("a") },
    ];
    for (const mutation of mutations) {
      const changed = buildPersonReleaseBindingV2(readableContext([mutation]));
      expect(changed.release_binding_sha256).not.toBe(
        buildPersonReleaseBindingV2(readableContext([base]))
          .release_binding_sha256,
      );
      expect(() =>
        validatePersonReleaseBindingV2(
          {
            ...built.body,
            returned_items: [mutation, returnedItems[1]!],
          },
          context,
        ),
      ).toThrow("do not match the re-proved witness");
    }
    expect(() =>
      validatePersonReleaseBindingV2(
        {
          ...built.body,
          returned_items: [...returnedItems].reverse(),
        },
        context,
      ),
    ).toThrow("do not match the re-proved witness");
  });

  it("retains an empty retrieval result and bounds the ordered result at ten", () => {
    const empty = buildPersonReleaseBindingV2(reviewerContext([]));
    expect(empty.body).toHaveProperty("returned_items", []);
    expect(empty.release_binding_sha256).toBe(
      "sha256:ede534b4f70fd2ede78b25d92c07e868d019797708ca6f5d9b0feae7c2ddf341",
    );

    const ten = Array.from({ length: 10 }, (_, index) =>
      reviewerItem(index.toString(16)),
    );
    expect(
      buildPersonReleaseBindingV2(reviewerContext(ten)).body,
    ).toHaveProperty("returned_items");
    expect(() =>
      buildPersonReleaseBindingV2(reviewerContext([...ten, reviewerItem("a")])),
    ).toThrow("must contain at most ten items");
  });

  it("joins reviewer and search results to only policies admitted by their scope", () => {
    expect(() =>
      buildPersonReleaseBindingV2(reviewerContext([memberItem()])),
    ).toThrow("was not admitted by the scope");
    expect(() =>
      buildPersonReleaseBindingV2(
        readableContext([reviewerItem()], [MEMBER_SEGMENT]),
      ),
    ).toThrow("was not admitted by the scope");

    const both = buildPersonReleaseBindingV2(
      readableContext([memberItem(), reviewerItem()]),
    );
    expect(both.body).toHaveProperty("returned_items");
  });

  it("keeps authority-state release keyless and forbids mutation release", () => {
    const context = authorityContext();
    const built = buildPersonReleaseBindingV2(context);
    expect(Object.keys(built.body)).toEqual([
      "schema_version",
      "kind",
      "caller_binding_sha256",
      "scope_binding_sha256",
      "serialized_response_sha256",
      "result_kind",
    ]);
    expect(built.body.result_kind).toBe("authority_state");
    expect(built.body).not.toHaveProperty("returned_items");
    expect(built.body).not.toHaveProperty("owned_resource_sha256");
    expect(built.release_binding_sha256).toBe(
      "sha256:81c9c4ae3edfc15bf419b0fc919e92e5c2c1fdbe00b18f79c9ebe7c111c66fe1",
    );

    expect(() =>
      buildPersonReleaseBindingV2(authorityContext("change")),
    ).toThrow("change_member_exclusion has no release binding");
    expect(() =>
      validatePersonReleaseBindingV2(
        { ...built.body, returned_items: [] },
        context,
      ),
    ).toThrow("unexpected shape");
  });

  it("rejects result kinds substituted across retrieval and Authority scopes", () => {
    const reviewer = reviewerContext();
    expect(() =>
      buildPersonReleaseBindingV2({
        ...reviewer,
        result: { result_kind: "authority_state" },
      }),
    ).toThrow("authority_state result requires list_member_exclusions");

    const authority = authorityContext();
    expect(() =>
      buildPersonReleaseBindingV2({
        ...authority,
        result: { result_kind: "retrieval", returned_items: [] },
      }),
    ).toThrow("retrieval result requires a retrieval scope");
  });

  it("recomputes caller, request-to-scope, and scope-to-release joins", () => {
    const context = reviewerContext();
    const built = buildPersonReleaseBindingV2(context);

    expect(() =>
      validatePersonReleaseBindingV2(built.body, {
        ...context,
        caller: caller(digest("d")),
      }),
    ).toThrow("caller_binding_sha256");

    expect(() =>
      validatePersonReleaseBindingV2(built.body, {
        ...context,
        request: readableRequest("Different query"),
      }),
    ).toThrow();

    const changedScope = buildPersonScopeBindingV2({
      request: context.request,
      caller: context.caller,
      scope: {
        scope_kind: "reviewer_log",
        record_head: { position: 8, record_hash: digest("a") },
      },
    }).body;
    expect(() =>
      validatePersonReleaseBindingV2(built.body, {
        ...context,
        scope: changedScope,
      }),
    ).toThrow("scope_binding_sha256");
  });

  it("hashes a defensive response-byte snapshot and never trusts a supplied digest", () => {
    const response = Uint8Array.from(Buffer.from('{"items":[]}'));
    const original = Uint8Array.from(response);
    const context = reviewerContext([], response);
    const built = buildPersonReleaseBindingV2(context);

    response.fill(0x78);
    expect(built.body.serialized_response_sha256).toBe(
      sha256Digest(Buffer.from(original)),
    );
    const firstCopy = built.response_snapshot.copyBytes();
    expect(firstCopy).toEqual(original);
    firstCopy.fill(0x79);
    const secondCopy = built.response_snapshot.copyBytes();
    expect(secondCopy).toEqual(original);
    expect(sha256Digest(Buffer.from(secondCopy))).toBe(
      built.body.serialized_response_sha256,
    );
    expect(() => validatePersonReleaseBindingV2(built.body, context)).toThrow(
      "serialized_response_sha256",
    );
    expect(
      validatePersonReleaseBindingV2(built.body, {
        ...context,
        serialized_response_bytes: built.response_snapshot.copyBytes(),
      }),
    ).toEqual(built.body);
    const changed = buildPersonReleaseBindingV2(
      reviewerContext([], Buffer.from('{"items":[1]}')),
    );
    expect(changed.release_binding_sha256).not.toBe(
      built.release_binding_sha256,
    );
    expect(() =>
      buildPersonReleaseBindingV2({
        ...reviewerContext([]),
        serialized_response_bytes: digest("f") as unknown as Uint8Array,
      }),
    ).toThrow("must be exact serialized bytes");

    let byteGetterCalls = 0;
    const hostileBytes = Uint8Array.from(original);
    Object.defineProperty(hostileBytes, "length", {
      get() {
        byteGetterCalls += 1;
        return original.length;
      },
    });
    expect(() =>
      buildPersonReleaseBindingV2(reviewerContext([], hostileBytes)),
    ).toThrow("additional byte-view properties");
    expect(byteGetterCalls).toBe(0);
  });

  it("treats the injected result as structural already-reproved evidence only", () => {
    const arbitrary = {
      atom_id: digest("a"),
      record_hash: digest("b"),
      policy_id: "restricted-reviewer-person-v2",
      content_binding_sha256: digest("c"),
      provenance_binding_sha256: digest("d"),
    } as const;
    expect(
      buildPersonReleaseBindingV2(reviewerContext([arbitrary])).body,
    ).toHaveProperty("returned_items", [arbitrary]);

    expect(() =>
      buildPersonReleaseBindingV2(
        reviewerContext([
          {
            ...arbitrary,
            content: "must not enter evidence",
          } as unknown as PersonRetrievalReleaseItemV2,
        ]),
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      buildPersonReleaseBindingV2({
        ...reviewerContext([arbitrary]),
        result: {
          result_kind: "retrieval",
          returned_items: [arbitrary],
          proof: digest("e"),
        } as unknown as BuildPersonReleaseBindingV2Input["result"],
      }),
    ).toThrow("unexpected shape");
  });

  it("rejects hostile objects and arrays without invoking accessors", () => {
    let getterCalls = 0;
    const result = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(result, "result_kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "retrieval";
      },
    });
    Object.defineProperty(result, "returned_items", {
      enumerable: true,
      value: [],
    });
    expect(() =>
      buildPersonReleaseBindingV2({
        ...reviewerContext([]),
        result: result as unknown as BuildPersonReleaseBindingV2Input["result"],
      }),
    ).toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const sparse = new Array(1) as PersonRetrievalReleaseItemV2[];
    expect(() => buildPersonReleaseBindingV2(reviewerContext(sparse))).toThrow(
      "dense plain array",
    );

    const symbolItem = { ...reviewerItem() } as Record<PropertyKey, unknown>;
    symbolItem[Symbol("hidden")] = digest("f");
    expect(() =>
      buildPersonReleaseBindingV2(
        reviewerContext([
          symbolItem as unknown as PersonRetrievalReleaseItemV2,
        ]),
      ),
    ).toThrow("symbol keys");
  });

  it("rejects body substitution, raw response fields, and witness mismatch", () => {
    const context = reviewerContext();
    const built = buildPersonReleaseBindingV2(context);

    expect(() =>
      validatePersonReleaseBindingV2(
        { ...built.body, response_bytes: [] },
        context,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      validatePersonReleaseBindingV2(
        { ...built.body, serialized_response_sha256: digest("f") },
        context,
      ),
    ).toThrow("serialized_response_sha256");
    expect(() =>
      validatePersonReleaseBindingV2(built.body, {
        ...context,
        result: {
          result_kind: "retrieval",
          returned_items: [reviewerItem("f")],
        },
      }),
    ).toThrow("do not match the re-proved witness");
  });
});
