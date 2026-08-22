import { Buffer } from "node:buffer";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  AUDIT_EXPIRY_CONTROL_KIND,
  AUDIT_EXPORT_CAPABILITY_KIND,
  PERSON_READ_DECISION_AUDIT_KIND,
  auditExportCapabilitySha256V1,
  auditExportCapabilityV1,
  buildAuditExpiryControlRowV1,
  buildPersonReadDecisionAuditRowV2,
  personReadDecisionAuditBodySha256V2,
  validateAuditExportCapabilityV1,
  validateAuditExpiryControlBodyV1,
  validateAuditExpiryControlRowV1,
  validatePersonReadDecisionAuditBodyV2,
  validatePersonReadDecisionAuditRowV2,
} from "../src/application/person-read-audit-contracts-v2.js";
import type {
  BuildAuditExpiryControlRowV1Input,
  PersonReadAuditReasonCodeV2,
  PersonReadDecisionAuditContextV2,
  ScopedPersonReadAuditContextV2,
} from "../src/application/person-read-audit-contracts-v2.js";
import {
  buildPersonCallerBindingV2,
  buildPersonRequestCommitmentV2,
} from "../src/application/person-read-contracts-v2.js";
import type {
  PersonCallerBindingV2,
  PersonRequestCommitmentV2,
  PersonRequestOperationV2,
} from "../src/application/person-read-contracts-v2.js";
import { buildPersonReleaseBindingV2 } from "../src/application/person-read-release-contracts-v2.js";
import type { BuildPersonReleaseBindingV2Input } from "../src/application/person-read-release-contracts-v2.js";
import { buildPersonScopeBindingV2 } from "../src/application/person-read-scope-contracts-v2.js";
import type { PersonScopeBindingV2 } from "../src/application/person-read-scope-contracts-v2.js";

const IDS = {
  authority: "oau_00000000-0000-4000-8000-000000000001",
  organization: "org_00000000-0000-4000-8000-000000000002",
  principal: "prn_00000000-0000-4000-8000-000000000003",
  membership: "mem_00000000-0000-4000-8000-000000000004",
  identityBinding: "oib_00000000-0000-4000-8000-000000000005",
  sessionFamily: "psf_00000000-0000-4000-8000-000000000006",
  audit: "pra_00000000-0000-4000-8000-000000000007",
  control: "aec_00000000-0000-4000-8000-000000000008",
} as const;

const BOUNDARY = {
  authority_id: IDS.authority,
  organization_id: IDS.organization,
  state_lineage_id: "state-lineage-1",
} as const;

const EVALUATED_AT = "2026-08-20T12:00:00.000Z";
const RETAIN_UNTIL = "2026-09-19T12:00:00.000Z";
const DENIAL_TEXT = '{"error":"request_not_authorized"}';
const RESPONSE_TEXT = {
  reviewer_recent_decisions: '{"items":[{"decision":"ship"}]}',
  readable_search: '{"items":[{"text":"member"},{"text":"reviewer"}]}',
  list_member_exclusions: '{"items":[]}',
} as const;

const AUDIT_BODY_KEYS = [
  "schema_version",
  "kind",
  "audit_id",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "operation",
  "request_sha256",
  "context",
  "decision",
  "reason_code",
  "outcome",
  "evaluated_at",
  "retain_until",
];

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

function indexedDigest(index: number): Sha256Digest {
  return `sha256:${index.toString(16).padStart(64, "0")}` as Sha256Digest;
}

function denialBytes(): Buffer {
  return Buffer.from(DENIAL_TEXT);
}

function caller(personState = digest("b")): PersonCallerBindingV2 {
  return buildPersonCallerBindingV2({
    boundary: BOUNDARY,
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

function requestFor(
  operation: PersonRequestOperationV2,
  query = "Launch pricing",
): PersonRequestCommitmentV2 {
  if (operation === "reviewer_recent_decisions") {
    return buildPersonRequestCommitmentV2({ operation, input: {} });
  }
  if (operation === "readable_search") {
    return buildPersonRequestCommitmentV2({ operation, input: { query } });
  }
  if (operation === "list_member_exclusions") {
    return buildPersonRequestCommitmentV2({
      operation,
      input: {
        source_adapter_id: "granola",
        source_instance_id: "workspace-1",
      },
    });
  }
  return buildPersonRequestCommitmentV2({
    operation,
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
const REVIEWER_ITEM = {
  atom_id: digest("1"),
  record_hash: digest("2"),
  policy_id: "restricted-reviewer-person-v2",
  content_binding_sha256: digest("3"),
  provenance_binding_sha256: digest("4"),
} as const;
const MEMBER_ITEM = {
  atom_id: digest("5"),
  record_hash: digest("6"),
  policy_id: "organization-member-readable-person-v2",
  content_binding_sha256: digest("7"),
  provenance_binding_sha256: digest("8"),
} as const;

function scopeFor(
  operation: PersonRequestOperationV2,
  request: PersonRequestCommitmentV2,
  currentCaller: PersonCallerBindingV2,
  headPosition = 7,
): PersonScopeBindingV2 {
  if (operation === "reviewer_recent_decisions") {
    return buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: {
        scope_kind: "reviewer_log",
        record_head: { position: headPosition, record_hash: digest("9") },
      },
    }).body;
  }
  if (operation === "readable_search") {
    return buildPersonScopeBindingV2({
      request,
      caller: currentCaller,
      scope: {
        scope_kind: "readable_search",
        retrieval_contract_sha256: digest("2"),
        generation: {
          generation_id: digest("3"),
          manifest_sha256: digest("4"),
        },
        record_head: { position: headPosition, record_hash: digest("5") },
        admitted_segments: [MEMBER_SEGMENT, REVIEWER_SEGMENT],
      },
    }).body;
  }
  return buildPersonScopeBindingV2({
    request,
    caller: currentCaller,
    scope: {
      scope_kind: "authority_state",
      source_activation_binding_sha256: digest("d"),
      owned_resource_sha256: digest("e"),
      exclusion_state_sha256: digest("f"),
    },
  }).body;
}

type ReleaseOperationV2 =
  | "reviewer_recent_decisions"
  | "readable_search"
  | "list_member_exclusions";

function releaseContextFor(
  operation: ReleaseOperationV2,
  overrides: {
    readonly request?: PersonRequestCommitmentV2;
    readonly caller?: PersonCallerBindingV2;
    readonly scope?: PersonScopeBindingV2;
    readonly returnedItems?: readonly (typeof REVIEWER_ITEM | typeof MEMBER_ITEM)[];
  } = {},
): BuildPersonReleaseBindingV2Input {
  const request = overrides.request ?? requestFor(operation);
  const currentCaller = overrides.caller ?? caller();
  const scope = overrides.scope ?? scopeFor(operation, request, currentCaller);
  const returnedItems =
    overrides.returnedItems ??
    (operation === "readable_search" ? [MEMBER_ITEM, REVIEWER_ITEM] : [REVIEWER_ITEM]);
  return {
    request,
    caller: currentCaller,
    scope,
    serialized_response_bytes: Buffer.from(RESPONSE_TEXT[operation]),
    result:
      operation === "list_member_exclusions"
        ? { result_kind: "authority_state" }
        : { result_kind: "retrieval", returned_items: returnedItems },
  };
}

function allowContext(
  operation: PersonRequestOperationV2,
): ScopedPersonReadAuditContextV2 {
  if (operation === "change_member_exclusion") {
    const request = requestFor(operation);
    const currentCaller = caller();
    return {
      stage: "scoped",
      boundary: BOUNDARY,
      request,
      caller: currentCaller,
      scope: scopeFor(operation, request, currentCaller),
      outcome: { kind: "authority_state_mutation" },
    };
  }
  const release = releaseContextFor(operation);
  return {
    stage: "scoped",
    boundary: BOUNDARY,
    request: release.request,
    caller: release.caller,
    scope: release.scope,
    outcome: { kind: "release", release },
  };
}

function denyContext(
  stage: "no_current_caller" | "caller_only" | "scoped",
  operation: PersonRequestOperationV2 = "readable_search",
  bytes: Uint8Array = denialBytes(),
): PersonReadDecisionAuditContextV2 {
  const request = requestFor(operation);
  const currentCaller = caller();
  if (stage === "no_current_caller") {
    return {
      stage,
      boundary: BOUNDARY,
      request,
      denial_response_bytes: bytes,
    };
  }
  if (stage === "caller_only") {
    return {
      stage,
      boundary: BOUNDARY,
      request,
      caller: currentCaller,
      denial_response_bytes: bytes,
    };
  }
  return {
    stage: "scoped",
    boundary: BOUNDARY,
    request,
    caller: currentCaller,
    scope: scopeFor(operation, request, currentCaller),
    outcome: { kind: "deny", denial_response_bytes: bytes },
  };
}

function auditRow(
  decision: "allow" | "deny",
  reasonCode: PersonReadAuditReasonCodeV2,
  context: PersonReadDecisionAuditContextV2,
  evaluatedAt: string = EVALUATED_AT,
) {
  return buildPersonReadDecisionAuditRowV2({
    audit_id: IDS.audit,
    decision,
    reason_code: reasonCode,
    evaluated_at: evaluatedAt,
    context,
  });
}

function expiryInput(
  overrides: Partial<BuildAuditExpiryControlRowV1Input> = {},
): BuildAuditExpiryControlRowV1Input {
  return {
    control_id: IDS.control,
    boundary: BOUNDARY,
    expired_row_sha256s: [digest("a"), digest("b"), digest("c")],
    occurred_at: EVALUATED_AT,
    ...overrides,
  };
}

describe("private D6-3 Person read audit and retention commitments", () => {
  it("freezes the exact reviewer allow row and golden digest", () => {
    const context = allowContext("reviewer_recent_decisions");
    const built = auditRow("allow", "authorized", context);

    expect(Object.keys(built)).toEqual(["row", "response_snapshot"]);
    expect(Object.keys(built.row)).toEqual(["body", "row_sha256"]);
    expect(Object.keys(built.row.body)).toEqual(AUDIT_BODY_KEYS);
    expect(built.row.body).toMatchObject({
      schema_version: 2,
      kind: PERSON_READ_DECISION_AUDIT_KIND,
      audit_id: IDS.audit,
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      state_lineage_id: BOUNDARY.state_lineage_id,
      operation: "reviewer_recent_decisions",
      decision: "allow",
      reason_code: "authorized",
      evaluated_at: EVALUATED_AT,
      retain_until: RETAIN_UNTIL,
    });
    expect(Object.keys(built.row.body.context)).toEqual([
      "kind",
      "caller_binding_sha256",
      "scope_binding_sha256",
    ]);
    expect(Object.keys(built.row.body.outcome)).toEqual([
      "kind",
      "release_binding_sha256",
      "response_sha256",
    ]);
    expect(built.row.body.outcome).toMatchObject({
      kind: "retrieval_release",
      release_binding_sha256:
        "sha256:44c16c39a2205bc72d877d8aa302a4d13cf5c9471f778d6361b527946ea2f7e6",
      response_sha256: sha256Digest(
        Buffer.from(RESPONSE_TEXT.reviewer_recent_decisions),
      ),
    });
    expect(built.row.row_sha256).toBe(
      "sha256:a4c97539d1e6a54784ab630e4c2a4804bc62aef25701d6a027bc2df58c54d833",
    );
    expect(personReadDecisionAuditBodySha256V2(built.row.body, context)).toBe(
      built.row.row_sha256,
    );
    expect(validatePersonReadDecisionAuditRowV2(built.row, context)).toEqual(
      built.row,
    );

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.row)).toBe(true);
    expect(Object.isFrozen(built.row.body)).toBe(true);
    expect(Object.isFrozen(built.row.body.context)).toBe(true);
    expect(Object.isFrozen(built.row.body.outcome)).toBe(true);
    expect(built.response_snapshot).not.toBeNull();

    const canonical = canonicalJson(built.row.body);
    for (const forbidden of [
      "record_head",
      "admitted_segments",
      "policy_contracts",
      "returned_items",
      "atom_id",
      "owned_resource",
      "generation",
      "granola",
      "ship",
      IDS.principal,
      IDS.membership,
      IDS.sessionFamily,
    ]) {
      expect(canonical).not.toContain(forbidden);
    }
  });

  it("binds each allow outcome kind to its own operation", () => {
    const goldens = [
      [
        "reviewer_recent_decisions",
        "retrieval_release",
        "sha256:a4c97539d1e6a54784ab630e4c2a4804bc62aef25701d6a027bc2df58c54d833",
      ],
      [
        "readable_search",
        "retrieval_release",
        "sha256:4c228d3cde62a8879f48f839ed41d426293f862010d24dc72367ff20ef7977dc",
      ],
      [
        "list_member_exclusions",
        "authority_state_release",
        "sha256:24d614edea93d309d757793599e160b112e5329c6938846c5128a17635a4d4d5",
      ],
      [
        "change_member_exclusion",
        "authority_state_mutation",
        "sha256:696fa6cb12102f491ca4ee9c8b57031f405ea53a7d6d2b0e954eb7d5bee096f6",
      ],
    ] as const;

    for (const [operation, outcomeKind, golden] of goldens) {
      const built = auditRow("allow", "authorized", allowContext(operation));
      expect(built.row.body.operation).toBe(operation);
      expect(built.row.body.context.kind).toBe("scoped");
      expect(built.row.body.outcome.kind).toBe(outcomeKind);
      expect(built.row.row_sha256).toBe(golden);
    }

    for (const operation of [
      "reviewer_recent_decisions",
      "readable_search",
      "list_member_exclusions",
    ] as const) {
      const release = releaseContextFor(operation);
      const releaseBinding = buildPersonReleaseBindingV2(release);
      const built = auditRow("allow", "authorized", allowContext(operation));
      expect(built.row.body.outcome).toMatchObject({
        release_binding_sha256: releaseBinding.release_binding_sha256,
        response_sha256: releaseBinding.body.serialized_response_sha256,
      });
      expect(built.response_snapshot?.copyBytes()).toEqual(
        Uint8Array.from(Buffer.from(RESPONSE_TEXT[operation])),
      );
    }
  });

  it("keeps the mutation acknowledgement free of every digest", () => {
    const built = auditRow(
      "allow",
      "authorized",
      allowContext("change_member_exclusion"),
    );
    expect(built.row.body.outcome).toEqual({ kind: "authority_state_mutation" });
    expect(built.response_snapshot).toBeNull();
    const canonical = canonicalJson(built.row.body);
    expect(canonical).not.toContain("response_sha256");
    expect(canonical).not.toContain("release_binding_sha256");

    const context = allowContext("change_member_exclusion");
    expect(() =>
      auditRow("allow", "authorized", {
        ...context,
        outcome: {
          kind: "authority_state_mutation",
          denial_response_bytes: denialBytes(),
        } as unknown as ScopedPersonReadAuditContextV2["outcome"],
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      auditRow("allow", "authorized", {
        ...context,
        outcome: {
          kind: "release",
          release: {
            request: context.request,
            caller: context.caller,
            scope: context.scope,
            serialized_response_bytes: Buffer.from('{"ok":true}'),
            result: { result_kind: "authority_state" },
          },
        },
      }),
    ).toThrow("change_member_exclusion has no release binding");
    expect(() =>
      auditRow("allow", "authorized", {
        ...allowContext("list_member_exclusions"),
        outcome: { kind: "authority_state_mutation" },
      }),
    ).toThrow("authority_state_mutation requires change_member_exclusion");
  });

  it("freezes every deny reason at its required context stage", () => {
    const denials = [
      [
        "unauthenticated",
        "no_current_caller",
        "sha256:f30c980ff1f2d6ea3e763a90cde6ccf8c8ef3ec01abb9de8a129c822b136eedf",
      ],
      [
        "caller_context_invalid",
        "no_current_caller",
        "sha256:ce2d09f0f93e3bd4e3f8012429aa04873fdd5d193c0cced92cc21257212b9ecc",
      ],
      [
        "operation_forbidden",
        "caller_only",
        "sha256:8a66b682549768b518e0b59abc323d415a3843d85688c14cb9d7a70e745b6635",
      ],
      [
        "scope_not_admitted",
        "caller_only",
        "sha256:f141dc998df2253c6be69670ec3198e5a615aec131023d56df60ef05a062a77a",
      ],
      [
        "current_state_changed",
        "scoped",
        "sha256:7ce313b0b2143b493501a11e8a9606c6d49c043c6435c6071ff4a5f90e0b66a7",
      ],
      [
        "protected_data_unavailable",
        "scoped",
        "sha256:308b0aad88b74b25f705e9a7885b43135ccd5aea9cf2ad24d8861180c585c8e8",
      ],
    ] as const;

    for (const [reasonCode, stage, golden] of denials) {
      const built = auditRow("deny", reasonCode, denyContext(stage));
      expect(built.row.body.decision).toBe("deny");
      expect(built.row.body.reason_code).toBe(reasonCode);
      expect(built.row.body.context.kind).toBe(stage);
      expect(built.row.body.outcome).toEqual({
        kind: "deny",
        response_sha256: sha256Digest(denialBytes()),
      });
      expect(built.row.row_sha256).toBe(golden);
      expect(built.response_snapshot?.copyBytes()).toEqual(
        Uint8Array.from(denialBytes()),
      );
    }

    const unauthenticated = auditRow(
      "deny",
      "unauthenticated",
      denyContext("no_current_caller"),
    );
    expect(Object.keys(unauthenticated.row.body.context)).toEqual(["kind"]);
    const forbidden = auditRow(
      "deny",
      "operation_forbidden",
      denyContext("caller_only"),
    );
    expect(Object.keys(forbidden.row.body.context)).toEqual([
      "kind",
      "caller_binding_sha256",
    ]);
    const canonical = canonicalJson(unauthenticated.row.body);
    expect(canonical).not.toContain("caller_binding_sha256");
    expect(canonical).not.toContain(IDS.principal);
    expect(canonical).not.toContain("release_binding_sha256");
  });

  it("rejects reasons at the wrong stage and decisions at the wrong reason", () => {
    expect(() =>
      auditRow("deny", "unauthenticated", denyContext("caller_only")),
    ).toThrow("requires the no_current_caller context stage");
    expect(() =>
      auditRow("deny", "operation_forbidden", denyContext("no_current_caller")),
    ).toThrow("requires the caller_only context stage");
    expect(() =>
      auditRow("deny", "current_state_changed", denyContext("caller_only")),
    ).toThrow("requires the scoped context stage");
    expect(() =>
      auditRow("deny", "scope_not_admitted", denyContext("scoped")),
    ).toThrow("requires the caller_only context stage");
    expect(() =>
      auditRow(
        "allow",
        "authorized",
        denyContext("no_current_caller"),
      ),
    ).toThrow("requires the scoped context stage");
    expect(() =>
      auditRow("allow", "authorized", denyContext("scoped")),
    ).toThrow("deny outcome requires a deny decision");
    expect(() =>
      auditRow(
        "deny",
        "authorized",
        allowContext("reviewer_recent_decisions"),
      ),
    ).toThrow("does not match its decision");
    expect(() =>
      auditRow("allow", "unauthenticated", denyContext("no_current_caller")),
    ).toThrow("does not match its decision");
    expect(() =>
      auditRow(
        "deny",
        "audit_unavailable" as unknown as PersonReadAuditReasonCodeV2,
        denyContext("no_current_caller"),
      ),
    ).toThrow("reason_code is unsupported");
    expect(() =>
      auditRow(
        "denied" as unknown as "deny",
        "unauthenticated",
        denyContext("no_current_caller"),
      ),
    ).toThrow("decision must be allow or deny");
  });

  it("recomputes the request, caller, scope, and identity joins", () => {
    const context = allowContext("readable_search");
    const built = auditRow("allow", "authorized", context);

    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, request_sha256: digest("f") },
        context,
      ),
    ).toThrow("request_sha256");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          context: { ...built.row.body.context, caller_binding_sha256: digest("f") },
        },
        context,
      ),
    ).toThrow("caller_binding_sha256");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          context: { ...built.row.body.context, scope_binding_sha256: digest("f") },
        },
        context,
      ),
    ).toThrow("scope_binding_sha256");
    for (const field of [
      "authority_id",
      "organization_id",
      "state_lineage_id",
      "operation",
    ] as const) {
      expect(() =>
        validatePersonReadDecisionAuditBodyV2(
          { ...built.row.body, [field]: "other-value" },
          context,
        ),
      ).toThrow(field);
    }
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, audit_id: IDS.principal },
        context,
      ),
    ).toThrow("must be a canonical pra identifier");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, subject_principal_id: IDS.principal },
        context,
      ),
    ).toThrow("unexpected shape");

    expect(() =>
      validatePersonReadDecisionAuditBodyV2(built.row.body, {
        ...context,
        caller: caller(digest("d")),
      }),
    ).toThrow("caller_binding_sha256");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(built.row.body, {
        ...context,
        request: requestFor("readable_search", "Different query"),
      }),
    ).toThrow();
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        built.row.body,
        denyContext("caller_only"),
      ),
    ).toThrow("does not match the supplied evidence stage");

    expect(() =>
      auditRow("deny", "operation_forbidden", {
        ...denyContext("caller_only"),
        boundary: { ...BOUNDARY, state_lineage_id: "state-lineage-2" },
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("does not match the current caller binding identity");
  });

  it("joins the release outcome to the audited caller, scope, and bytes", () => {
    const context = allowContext("reviewer_recent_decisions");
    const built = auditRow("allow", "authorized", context);

    const otherCaller = caller(digest("d"));
    const otherRequest = requestFor("readable_search", "Different query");
    expect(() =>
      auditRow("allow", "authorized", {
        ...context,
        outcome: {
          kind: "release",
          release: releaseContextFor("reviewer_recent_decisions", {
            caller: otherCaller,
            scope: scopeFor(
              "reviewer_recent_decisions",
              context.request,
              otherCaller,
            ),
          }),
        },
      }),
    ).toThrow("does not match the audited caller binding");
    expect(() =>
      auditRow("allow", "authorized", {
        ...context,
        outcome: {
          kind: "release",
          release: releaseContextFor("reviewer_recent_decisions", {
            scope: scopeFor(
              "reviewer_recent_decisions",
              context.request,
              context.caller,
              8,
            ),
          }),
        },
      }),
    ).toThrow("does not match the audited scope binding");
    expect(() =>
      auditRow("allow", "authorized", {
        ...allowContext("readable_search"),
        outcome: {
          kind: "release",
          release: releaseContextFor("readable_search", {
            request: otherRequest,
            scope: scopeFor("readable_search", otherRequest, caller()),
          }),
        },
      }),
    ).toThrow("does not match the audited request commitment");
    expect(() =>
      auditRow("allow", "authorized", {
        ...context,
        outcome: {
          kind: "release",
          release: releaseContextFor("reviewer_recent_decisions", {
            returnedItems: [MEMBER_ITEM],
          }),
        },
      }),
    ).toThrow("was not admitted by the scope");

    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          outcome: {
            ...built.row.body.outcome,
            release_binding_sha256: digest("f"),
          },
        },
        context,
      ),
    ).toThrow("release_binding_sha256");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          outcome: { ...built.row.body.outcome, response_sha256: digest("f") },
        },
        context,
      ),
    ).toThrow("response_sha256");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          outcome: {
            kind: "authority_state_release",
            release_binding_sha256:
              "sha256:44c16c39a2205bc72d877d8aa302a4d13cf5c9471f778d6361b527946ea2f7e6",
            response_sha256: sha256Digest(
              Buffer.from(RESPONSE_TEXT.reviewer_recent_decisions),
            ),
          },
        },
        context,
      ),
    ).toThrow("does not match the supplied outcome evidence");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        {
          ...built.row.body,
          outcome: { ...built.row.body.outcome, returned_items: [] },
        },
        context,
      ),
    ).toThrow("unexpected shape");
  });

  it("rejects deny contexts carrying release or witness evidence", () => {
    const scoped = denyContext("scoped") as ScopedPersonReadAuditContextV2;
    expect(() =>
      auditRow("deny", "current_state_changed", {
        ...scoped,
        outcome: {
          kind: "deny",
          denial_response_bytes: denialBytes(),
          release: releaseContextFor("readable_search"),
        } as unknown as ScopedPersonReadAuditContextV2["outcome"],
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      auditRow("deny", "current_state_changed", {
        ...scoped,
        outcome: {
          kind: "deny",
          denial_response_bytes: denialBytes(),
          result: { result_kind: "retrieval", returned_items: [] },
        } as unknown as ScopedPersonReadAuditContextV2["outcome"],
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      auditRow("deny", "unauthenticated", {
        ...denyContext("no_current_caller"),
        caller: caller(),
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("unexpected shape");
    expect(() =>
      auditRow("deny", "current_state_changed", {
        ...scoped,
        outcome: {
          kind: "unsupported_export",
        } as unknown as ScopedPersonReadAuditContextV2["outcome"],
      }),
    ).toThrow("outcome kind is unsupported");
    expect(() =>
      auditRow(
        "deny",
        "unauthenticated",
        {
          ...denyContext("no_current_caller"),
          stage: "unsupported",
        } as unknown as PersonReadDecisionAuditContextV2,
      ),
    ).toThrow("stage is unsupported");
  });

  it("hashes a defensive denial snapshot that never aliases caller bytes", () => {
    const bytes = Uint8Array.from(denialBytes());
    const original = Uint8Array.from(bytes);
    const context = denyContext("no_current_caller", "readable_search", bytes);
    const built = auditRow("deny", "unauthenticated", context);

    bytes.fill(0x78);
    expect(built.row.body.outcome).toEqual({
      kind: "deny",
      response_sha256: sha256Digest(Buffer.from(original)),
    });
    expect(built.row.row_sha256).toBe(
      "sha256:f30c980ff1f2d6ea3e763a90cde6ccf8c8ef3ec01abb9de8a129c822b136eedf",
    );
    const firstCopy = built.response_snapshot!.copyBytes();
    expect(firstCopy).toEqual(original);
    firstCopy.fill(0x79);
    const secondCopy = built.response_snapshot!.copyBytes();
    expect(secondCopy).toEqual(original);
    expect(sha256Digest(Buffer.from(secondCopy))).toBe(
      sha256Digest(Buffer.from(original)),
    );
    expect(Object.isFrozen(built.response_snapshot)).toBe(true);

    expect(() =>
      validatePersonReadDecisionAuditRowV2(built.row, context),
    ).toThrow("response_sha256");
    expect(
      validatePersonReadDecisionAuditRowV2(built.row, {
        ...context,
        denial_response_bytes: built.response_snapshot!.copyBytes(),
      } as PersonReadDecisionAuditContextV2),
    ).toEqual(built.row);

    const changed = auditRow(
      "deny",
      "unauthenticated",
      denyContext(
        "no_current_caller",
        "readable_search",
        Buffer.from('{"error":"other"}'),
      ),
    );
    expect(changed.row.row_sha256).not.toBe(built.row.row_sha256);

    expect(() =>
      auditRow(
        "deny",
        "unauthenticated",
        denyContext(
          "no_current_caller",
          "readable_search",
          digest("f") as unknown as Uint8Array,
        ),
      ),
    ).toThrow("must be exact serialized bytes");

    // Every stage snapshots denial bytes before inspecting other evidence, so
    // an invalid byte view outranks an invalid boundary in all three.
    const brokenBoundary = { ...BOUNDARY, authority_id: "not-an-authority" };
    const brokenBytes = digest("f") as unknown as Uint8Array;
    expect(() =>
      auditRow("deny", "unauthenticated", {
        ...denyContext("no_current_caller", "readable_search", brokenBytes),
        boundary: brokenBoundary,
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("must be exact serialized bytes");
    expect(() =>
      auditRow("deny", "operation_forbidden", {
        ...denyContext("caller_only", "readable_search", brokenBytes),
        boundary: brokenBoundary,
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("must be exact serialized bytes");
    expect(() =>
      auditRow("deny", "current_state_changed", {
        ...(denyContext(
          "scoped",
          "readable_search",
          brokenBytes,
        ) as ScopedPersonReadAuditContextV2),
        boundary: brokenBoundary,
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
      auditRow(
        "deny",
        "unauthenticated",
        denyContext("no_current_caller", "readable_search", hostileBytes),
      ),
    ).toThrow("additional byte-view properties");
    expect(byteGetterCalls).toBe(0);
  });

  it("rejects hostile objects and arrays without invoking accessors", () => {
    let getterCalls = 0;
    const hostileContext = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileContext, "stage", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "no_current_caller";
      },
    });
    expect(() =>
      auditRow(
        "deny",
        "unauthenticated",
        hostileContext as unknown as PersonReadDecisionAuditContextV2,
      ),
    ).toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const hostileOutcome = {} as Record<string, unknown>;
    Object.defineProperty(hostileOutcome, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "deny";
      },
    });
    expect(() =>
      auditRow("deny", "current_state_changed", {
        ...(denyContext("scoped") as ScopedPersonReadAuditContextV2),
        outcome:
          hostileOutcome as unknown as ScopedPersonReadAuditContextV2["outcome"],
      }),
    ).toThrow("must be an enumerable data property");
    expect(getterCalls).toBe(0);

    const symbolBoundary = { ...BOUNDARY } as Record<PropertyKey, unknown>;
    symbolBoundary[Symbol("hidden")] = digest("f");
    expect(() =>
      auditRow("deny", "unauthenticated", {
        ...denyContext("no_current_caller"),
        boundary:
          symbolBoundary as unknown as PersonReadDecisionAuditContextV2["boundary"],
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("symbol keys");

    const prototyped = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      BOUNDARY,
    );
    expect(() =>
      auditRow("deny", "unauthenticated", {
        ...denyContext("no_current_caller"),
        boundary:
          prototyped as unknown as PersonReadDecisionAuditContextV2["boundary"],
      } as PersonReadDecisionAuditContextV2),
    ).toThrow("must be a plain object");

    const context = denyContext("no_current_caller");
    const built = auditRow("deny", "unauthenticated", context);
    let bodyGetterCalls = 0;
    const hostileBody = { ...built.row.body } as Record<string, unknown>;
    Object.defineProperty(hostileBody, "operation", {
      enumerable: true,
      get() {
        bodyGetterCalls += 1;
        return "readable_search";
      },
    });
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(hostileBody, context),
    ).toThrow("must be an enumerable data property");
    expect(bodyGetterCalls).toBe(0);
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, context: { kind: "no_current_caller", extra: 1 } },
        context,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, outcome: { kind: "deny" } },
        context,
      ),
    ).toThrow("unexpected shape");
  });

  it("rejects row wrappers whose digest does not bind the exact body", () => {
    const context = denyContext("scoped");
    const built = auditRow("deny", "protected_data_unavailable", context);

    expect(() =>
      validatePersonReadDecisionAuditRowV2(
        { body: built.row.body, row_sha256: digest("f") },
        context,
      ),
    ).toThrow("does not match its body");
    expect(() =>
      validatePersonReadDecisionAuditRowV2(
        { body: built.row.body, row_sha256: "not-a-digest" },
        context,
      ),
    ).toThrow("must be a lowercase SHA-256 digest");
    expect(() =>
      validatePersonReadDecisionAuditRowV2(
        { ...built.row, row_position: 1 },
        context,
      ),
    ).toThrow("unexpected shape");
    expect(() =>
      validatePersonReadDecisionAuditRowV2({ body: built.row.body }, context),
    ).toThrow("unexpected shape");
    expect(canonicalJson(built.row.body)).not.toContain("row_sha256");
  });

  it("enforces the exact thirty-day retention arithmetic", () => {
    const arithmetic = [
      ["2026-08-20T12:00:00.000Z", "2026-09-19T12:00:00.000Z"],
      ["2024-02-15T00:00:00.000Z", "2024-03-16T00:00:00.000Z"],
      ["2023-02-15T00:00:00.000Z", "2023-03-17T00:00:00.000Z"],
      ["2025-12-15T23:59:59.999Z", "2026-01-14T23:59:59.999Z"],
      ["2026-01-31T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
    ] as const;

    for (const [evaluatedAt, retainUntil] of arithmetic) {
      const built = auditRow(
        "deny",
        "unauthenticated",
        denyContext("no_current_caller"),
        evaluatedAt,
      );
      expect(built.row.body.evaluated_at).toBe(evaluatedAt);
      expect(built.row.body.retain_until).toBe(retainUntil);
    }

    const context = denyContext("no_current_caller");
    const built = auditRow("deny", "unauthenticated", context);
    for (const retainUntil of [
      "2026-09-19T12:00:00.001Z",
      "2026-09-19T11:59:59.999Z",
      "2026-09-18T12:00:00.000Z",
      "2026-08-20T12:00:00.000Z",
      "2027-09-19T12:00:00.000Z",
    ]) {
      expect(() =>
        validatePersonReadDecisionAuditBodyV2(
          { ...built.row.body, retain_until: retainUntil },
          context,
        ),
      ).toThrow("retain_until must be " + RETAIN_UNTIL);
    }
    for (const timestamp of [
      "2026-08-20T12:00:00Z",
      "2026-08-20T12:00:00.000+00:00",
      "2026-08-20 12:00:00.000Z",
      "2026-08-20T12:00:00.000000Z",
      "2026-02-30T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      expect(() =>
        auditRow(
          "deny",
          "unauthenticated",
          denyContext("no_current_caller"),
          timestamp,
        ),
      ).toThrow("UTC millisecond timestamp");
    }
    expect(() =>
      validatePersonReadDecisionAuditBodyV2(
        { ...built.row.body, retain_until: "2026-09-19T12:00:00Z" },
        context,
      ),
    ).toThrow("retain_until must be a UTC millisecond timestamp");
  });

  it("freezes the expiry control row and its ordered digest batch", () => {
    const row = buildAuditExpiryControlRowV1(expiryInput());

    expect(Object.keys(row)).toEqual(["body", "row_sha256"]);
    expect(Object.keys(row.body)).toEqual([
      "schema_version",
      "kind",
      "control_id",
      "authority_id",
      "organization_id",
      "state_lineage_id",
      "cutoff",
      "retention_days",
      "expired_row_sha256s",
      "occurred_at",
    ]);
    expect(row.body).toMatchObject({
      schema_version: 1,
      kind: AUDIT_EXPIRY_CONTROL_KIND,
      control_id: IDS.control,
      authority_id: IDS.authority,
      organization_id: IDS.organization,
      state_lineage_id: BOUNDARY.state_lineage_id,
      cutoff: EVALUATED_AT,
      retention_days: 30,
      occurred_at: EVALUATED_AT,
    });
    expect(row.body.expired_row_sha256s).toEqual([
      digest("a"),
      digest("b"),
      digest("c"),
    ]);
    expect(row.row_sha256).toBe(
      "sha256:5ab1ba81ef05799efbd018f6fbc45fca2dd4c3c05179b9298b77ffde1d990ec4",
    );
    expect(validateAuditExpiryControlRowV1(row)).toEqual(row);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.body)).toBe(true);
    expect(Object.isFrozen(row.body.expired_row_sha256s)).toBe(true);

    expect(() =>
      validateAuditExpiryControlRowV1({
        body: row.body,
        row_sha256: digest("f"),
      }),
    ).toThrow("does not match its body");
    expect(() =>
      validateAuditExpiryControlRowV1({ ...row, row_count: 3 }),
    ).toThrow("unexpected shape");
  });

  it("bounds the expiry batch at its documented canonical size", () => {
    const batch = Array.from({ length: 500 }, (_, index) =>
      indexedDigest(index),
    );
    const row = buildAuditExpiryControlRowV1(
      expiryInput({ expired_row_sha256s: batch }),
    );
    expect(row.body.expired_row_sha256s).toHaveLength(500);
    expect(row.row_sha256).toBe(
      "sha256:8d1642d4ab70325f5b9a0b8f36048b16cc42ca4fd54a66267ccba0634e4cce51",
    );

    // The 500-digest body is why this row cannot share the 16 KiB audit bound.
    const canonicalBytes = canonicalJsonBytes(row.body).byteLength;
    expect(canonicalBytes).toBeGreaterThan(16 * 1024);
    expect(canonicalBytes).toBeLessThanOrEqual(48 * 1024);

    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          expired_row_sha256s: [...batch, indexedDigest(500)],
        }),
      ),
    ).toThrow("must contain from one through five hundred row digests");
    expect(() =>
      buildAuditExpiryControlRowV1(expiryInput({ expired_row_sha256s: [] })),
    ).toThrow("must contain from one through five hundred row digests");
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          boundary: { ...BOUNDARY, state_lineage_id: "l".repeat(129) },
        }),
      ),
    ).toThrow("must be bounded canonical text");
  });

  it("rejects unordered, extended, and mistimed expiry control bodies", () => {
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          expired_row_sha256s: [digest("c"), digest("b"), digest("a")],
        }),
      ),
    ).toThrow("must be strictly ascending and unique");
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          expired_row_sha256s: [digest("a"), digest("a"), digest("b")],
        }),
      ),
    ).toThrow("must be strictly ascending and unique");
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          expired_row_sha256s: [
            digest("a"),
            "sha256:not-a-digest" as Sha256Digest,
          ],
        }),
      ),
    ).toThrow("must be a lowercase SHA-256 digest");
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({
          expired_row_sha256s: new Array(2) as Sha256Digest[],
        }),
      ),
    ).toThrow("dense plain array");
    expect(() =>
      buildAuditExpiryControlRowV1(expiryInput({ control_id: IDS.audit })),
    ).toThrow("must be a canonical aec identifier");
    expect(() =>
      buildAuditExpiryControlRowV1(
        expiryInput({ occurred_at: "2026-08-20T12:00:00Z" }),
      ),
    ).toThrow("UTC millisecond timestamp");

    const row = buildAuditExpiryControlRowV1(expiryInput());
    expect(() =>
      validateAuditExpiryControlBodyV1({
        ...row.body,
        cutoff: "2026-08-19T12:00:00.000Z",
      }),
    ).toThrow("cutoff must be " + EVALUATED_AT);
    expect(() =>
      validateAuditExpiryControlBodyV1({ ...row.body, retention_days: 180 }),
    ).toThrow("retention_days must be 30");
    expect(() =>
      validateAuditExpiryControlBodyV1({ ...row.body, schema_version: 2 }),
    ).toThrow("schema_version must be 1");
    for (const extra of [
      "command_id",
      "row_count",
      "actor_principal_id",
      "ordered_rows_sha256",
    ]) {
      expect(() =>
        validateAuditExpiryControlBodyV1({ ...row.body, [extra]: digest("f") }),
      ).toThrow("unexpected shape");
    }
    let getterCalls = 0;
    const hostileBody = { ...row.body } as Record<string, unknown>;
    Object.defineProperty(hostileBody, "expired_row_sha256s", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    expect(() => validateAuditExpiryControlBodyV1(hostileBody)).toThrow(
      "must be an enumerable data property",
    );
    expect(getterCalls).toBe(0);
  });

  it("freezes the exact unsupported export capability and golden digest", () => {
    const capability = auditExportCapabilityV1();

    expect(Object.keys(capability)).toEqual([
      "schema_version",
      "kind",
      "status",
    ]);
    expect(capability).toEqual({
      schema_version: 1,
      kind: AUDIT_EXPORT_CAPABILITY_KIND,
      status: "unsupported",
    });
    expect(AUDIT_EXPORT_CAPABILITY_KIND).toBe("echo-audit-export-capability-v1");
    expect(auditExportCapabilitySha256V1(capability)).toBe(
      "sha256:6174fed96ec14169886445ffb5a221f25c7af225cf7912d7fbb1a8f9cf37e1c2",
    );
    expect(validateAuditExportCapabilityV1(capability)).toEqual(capability);
    expect(Object.isFrozen(capability)).toBe(true);

    // The result states this contract version's own surface, so it names no
    // organization, no row, and no output path.
    const canonical = canonicalJson(capability);
    for (const forbidden of [
      "sha256:",
      "authority",
      "organization",
      "lineage",
      "row_count",
      "ordered_rows_sha256",
      "export_sha256",
      "output_path",
      "from_inclusive",
      "until_exclusive",
      "cutoff",
      "retention_days",
    ]) {
      expect(canonical).not.toContain(forbidden);
    }
    expect(auditExportCapabilitySha256V1(capability)).not.toBe(
      buildAuditExpiryControlRowV1(expiryInput()).row_sha256,
    );
  });

  it("rejects supported, extended, and identity-bearing capability bodies", () => {
    const capability = auditExportCapabilityV1();

    for (const status of ["supported", "unavailable", "", "UNSUPPORTED"]) {
      expect(() =>
        validateAuditExportCapabilityV1({ ...capability, status }),
      ).toThrow("status must be unsupported");
    }
    for (const member of [
      "authority_id",
      "organization_id",
      "state_lineage_id",
      "row_count",
      "ordered_rows_sha256",
      "export_sha256",
      "output_path_sha256",
      "retention_days",
    ]) {
      expect(() =>
        validateAuditExportCapabilityV1({ ...capability, [member]: "value" }),
      ).toThrow("unexpected shape");
    }
    expect(() =>
      validateAuditExportCapabilityV1({ ...capability, schema_version: 2 }),
    ).toThrow("schema_version must be 1");
    expect(() =>
      validateAuditExportCapabilityV1({
        ...capability,
        kind: AUDIT_EXPIRY_CONTROL_KIND,
      }),
    ).toThrow("kind must be " + AUDIT_EXPORT_CAPABILITY_KIND);
    expect(() =>
      validateAuditExportCapabilityV1({ schema_version: 1, status: "unsupported" }),
    ).toThrow("unexpected shape");

    // A returned capability statement is never a stored row.
    expect(() =>
      validateAuditExportCapabilityV1({
        body: capability,
        row_sha256: digest("f"),
      }),
    ).toThrow("unexpected shape");

    let getterCalls = 0;
    const hostile = { schema_version: 1, kind: AUDIT_EXPORT_CAPABILITY_KIND } as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostile, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsupported";
      },
    });
    expect(() => validateAuditExportCapabilityV1(hostile)).toThrow(
      "must be an enumerable data property",
    );
    expect(getterCalls).toBe(0);

    const symbolled = { ...capability } as Record<PropertyKey, unknown>;
    symbolled[Symbol("hidden")] = digest("f");
    expect(() => validateAuditExportCapabilityV1(symbolled)).toThrow(
      "symbol keys",
    );
    expect(() =>
      validateAuditExportCapabilityV1(
        Object.assign(Object.create({ inherited: true }), capability),
      ),
    ).toThrow("must be a plain object");
  });
});
